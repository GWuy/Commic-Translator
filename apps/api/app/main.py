from __future__ import annotations

import io
import hmac
import json
import logging
import math
import os
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from google import genai
from google.genai import errors as genai_errors, types
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
logger = logging.getLogger(__name__)
app = FastAPI(title="Comic Translator API", version="0.1.0")
MAX_BYTES = int(os.getenv("MAX_IMAGE_BYTES", "15728640"))
TIMEOUT = int(os.getenv("GEMINI_TIMEOUT_SECONDS", "45"))
MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
CALLS: dict[str, deque[float]] = defaultdict(deque)


class Box(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def inside_image(self):
        if self.x + self.width > 1.001 or self.y + self.height > 1.001:
            raise ValueError("Bounding box extends beyond image")
        return self


class Region(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    type: Literal["speech", "thought", "caption", "sound", "other"]
    bbox: Box
    textBBox: Box | None = None
    bubbleBBox: Box | None = None
    originalText: str
    translatedText: str
    confidence: float = Field(ge=0, le=1)
    readingOrder: int = Field(ge=0)
    uncertain: bool = False


class Translation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    imageId: str
    sourceLanguage: str
    targetLanguage: str
    regions: list[Region] = Field(max_length=100)


class GeminiBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class GeminiRegion(BaseModel):
    id: str
    type: Literal["speech", "thought", "caption", "sound", "other"]
    bbox: GeminiBox
    textBBox: GeminiBox | None = None
    bubbleBBox: GeminiBox | None = None
    originalText: str
    translatedText: str
    confidence: float
    readingOrder: int
    uncertain: bool


class GeminiOutput(BaseModel):
    sourceLanguage: str
    regions: list[GeminiRegion]


def normalize_box(raw: object) -> Box:
    if not isinstance(raw, dict):
        raise ValueError("bbox must be an object")
    names = ("x", "y", "width", "height")
    values = {name: raw.get(name) for name in names}
    if any(not isinstance(value, (int, float)) or isinstance(value, bool) for value in values.values()):
        raise ValueError("bbox coordinates must be numbers")
    coordinates = {name: float(value) for name, value in values.items()}
    if not all(math.isfinite(value) for value in coordinates.values()):
        raise ValueError("bbox coordinates must be finite")
    if any(value > 2 for value in coordinates.values()):
        if not all(0 <= value <= 1000 for value in coordinates.values()):
            raise ValueError("bbox coordinates outside supported range")
        coordinates = {name: value / 1000 for name, value in coordinates.items()}
    for name in ("x", "y"):
        if -0.02 <= coordinates[name] < 0:
            coordinates[name] = 0.0
    for start, size in (("x", "width"), ("y", "height")):
        overflow = coordinates[start] + coordinates[size] - 1
        if 0 < overflow <= 0.03:
            coordinates[size] = 1 - coordinates[start]
        elif overflow > 0.03 and coordinates[start] < coordinates[size] <= 1:
            # Some vision responses place the far edge in the width/height field.
            coordinates[size] -= coordinates[start]
    return Box.model_validate(coordinates)


def validated_regions(raw_regions: object) -> list[Region]:
    if not isinstance(raw_regions, list):
        raise ApiError("invalid_ai_output", "AI returned an invalid region list", 502)
    accepted: list[Region] = []
    for index, raw in enumerate(raw_regions[:100]):
        try:
            if not isinstance(raw, dict):
                raise ValueError("region must be an object")
            box = normalize_box(raw.get("bbox"))
            text_box = normalize_box(raw.get("textBBox")) if raw.get("textBBox") else box
            try:
                bubble_box = normalize_box(raw.get("bubbleBBox")) if raw.get("bubbleBBox") else None
            except (ValidationError, ValueError, TypeError):
                bubble_box = None
            confidence = raw.get("confidence")
            if isinstance(confidence, (int, float)) and 1 < confidence <= 100:
                confidence /= 100
            region = Region.model_validate({**raw, "bbox": box, "textBBox": text_box, "bubbleBBox": bubble_box, "confidence": confidence})
            if not region.translatedText.strip():
                raise ValueError("translation is empty")
            accepted.append(region)
        except (ValidationError, ValueError, TypeError) as exc:
            logger.warning("Skipped invalid Gemini region %d: bbox=%s; reason=%s", index, raw.get("bbox") if isinstance(raw, dict) else None, str(exc).splitlines()[0])
    if raw_regions and not accepted:
        raise ApiError("invalid_ai_output", "AI returned no usable text coordinates", 502)
    return accepted


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int):
        self.code, self.message, self.status = code, message, status


@app.exception_handler(ApiError)
async def api_error(_request: Request, error: ApiError):
    return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, _error: RequestValidationError):
    return JSONResponse({"error": {"code": "invalid_request", "message": "Invalid request fields"}}, status_code=422)


@app.exception_handler(Exception)
async def internal_error(_request: Request, error: Exception):
    logger.exception("Unhandled API error", exc_info=error)
    return JSONResponse({"error": {"code": "internal_error", "message": "Internal server error"}}, status_code=500)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if request.url.path.startswith("/api/v1/translate"):
        expected_token = os.getenv("API_ACCESS_TOKEN", "")
        if os.getenv("K_SERVICE") and not expected_token:
            return JSONResponse({"error": {"code": "missing_api_token", "message": "API access token is not configured"}}, status_code=503)
        supplied_token = request.headers.get("x-api-key", "")
        if expected_token and not hmac.compare_digest(supplied_token, expected_token):
            return JSONResponse({"error": {"code": "unauthorized", "message": "Invalid API access token"}}, status_code=401)
        client = request.client.host if request.client else "unknown"
        now = time.monotonic()
        calls = CALLS[client]
        while calls and now - calls[0] > 60:
            calls.popleft()
        if len(calls) >= 30:
            return JSONResponse({"error": {"code": "rate_limited", "message": "Too many requests; try again shortly"}}, status_code=429)
        calls.append(now)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL}


def normalize_image(data: bytes) -> bytes:
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format not in {"JPEG", "PNG", "WEBP", "GIF"}:
                raise ApiError("unsupported_format", "Use JPEG, PNG, WebP, or GIF", 415)
            if source.width * source.height > 50_000_000:
                raise ApiError("image_too_large", "Image dimensions are too large", 413)
            image = ImageOps.exif_transpose(source)
            image.thumbnail((3000, 6000))
            image = image.convert("RGB")
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=88, optimize=True)
            return output.getvalue()
    except (UnidentifiedImageError, OSError) as exc:
        raise ApiError("invalid_image", "The uploaded file is not a valid image", 400) from exc


def ask_gemini(image: bytes, source: str, target: str, context: str) -> dict:
    if not os.getenv("GEMINI_API_KEY"):
        raise ApiError("missing_credentials", "GEMINI_API_KEY is not configured", 503)
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"], http_options=types.HttpOptions(timeout=TIMEOUT * 1000))
    prompt = (
        "Read all visible comic dialogue, captions, thoughts and sound effects. "
        "Return one region per complete speech bubble, not one region per OCR line or word. "
        "For each region, bbox and textBBox cover only the printed text. "
        "bubbleBBox covers the interior of the whole speech bubble if its boundary is clear; otherwise null. "
        "Return every text region using the supplied JSON schema. Type must be speech, thought, "
        "caption, sound, or other. bbox must be an object with x, y, width, and height as "
        "decimal fractions between 0 and 1; x and y are the top-left corner. "
        "Width and height are box sizes, not right/bottom edges; x+width and y+height must be at most 1. "
        "Translate into natural Vietnamese sentence case when target is vi, not all uppercase. "
        "Preserve names, pronouns, tone, punctuation and reading order. "
        "Do not invent unreadable dialogue: set uncertain=true and leave unclear text empty. "
        f"Source language: {source}; target language: {target}. Context: {context[:1000]}"
    )
    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model=MODEL,
                contents=[prompt, types.Part.from_bytes(data=image, mime_type="image/jpeg")],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=GeminiOutput,
                ),
            )
            if not response.text:
                raise ApiError("invalid_ai_output", "AI returned no readable result", 502)
            return json.loads(response.text)
        except ApiError:
            raise
        except json.JSONDecodeError as exc:
            raise ApiError("invalid_ai_output", "AI returned invalid JSON", 502) from exc
        except genai_errors.APIError as exc:
            code = exc.code
            logger.warning("Gemini request failed: HTTP %s, model %s", code, MODEL)
            if code in {429, 500, 502, 503, 504} and attempt < 2:
                time.sleep(2**attempt)
                continue
            if code in {401, 403}:
                raise ApiError("provider_auth", "Gemini API key is invalid or this project lacks access; check Google AI Studio", 502) from exc
            if code == 404:
                raise ApiError("model_unavailable", f"Gemini model {MODEL} is unavailable to this project; change GEMINI_MODEL in apps/api/.env", 502) from exc
            if code == 429:
                raise ApiError("provider_rate_limit", "Gemini rate limit reached; try again shortly", 429) from exc
            if code in {503, 500, 502}:
                raise ApiError("provider_unavailable", "Gemini is temporarily unavailable; try again shortly", 503) from exc
            if code == 504:
                raise ApiError("provider_timeout", "Gemini request timed out; try again", 504) from exc
            raise ApiError("provider_error", f"Gemini rejected the request (HTTP {code})", 502) from exc
        except httpx.TimeoutException as exc:
            if attempt < 2:
                time.sleep(2**attempt)
                continue
            raise ApiError("provider_timeout", "Gemini request timed out; try again", 504) from exc
        except Exception as exc:
            logger.exception("Unexpected Gemini client failure")
            raise ApiError("provider_error", "Gemini client failed unexpectedly", 502) from exc
    raise ApiError("provider_error", "AI provider request failed", 502)


@app.post("/api/v1/translate/image", response_model=Translation)
async def translate_image(
    image: UploadFile = File(...),
    source_language: str = Form("auto"),
    target_language: str = Form("vi"),
    context: str = Form(""),
    image_identifier: str = Form(""),
):
    if not source_language or not target_language or len(source_language) > 30 or len(target_language) > 30:
        raise ApiError("invalid_language", "Invalid language selection", 400)
    data = await image.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ApiError("image_too_large", "Image exceeds the upload limit", 413)
    if not data:
        raise ApiError("invalid_image", "Image is empty", 400)
    normalized = normalize_image(data)
    result = await run_in_threadpool(ask_gemini, normalized, source_language, target_language, context)
    if not isinstance(result, dict):
        raise ApiError("invalid_ai_output", "AI returned an invalid result", 502)
    result["imageId"] = image_identifier[:500]
    result["sourceLanguage"] = result.get("sourceLanguage") or source_language
    result["targetLanguage"] = target_language
    result["regions"] = validated_regions(result.get("regions"))
    try:
        return Translation.model_validate(result)
    except ValidationError as exc:
        logger.warning("Invalid Gemini structure: %s", exc)
        raise ApiError("invalid_ai_output", "AI returned invalid text coordinates", 502) from exc
