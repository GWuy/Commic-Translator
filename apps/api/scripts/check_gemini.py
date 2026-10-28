"""Check the configured Gemini key and model without printing credentials."""

import os
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import errors, types


load_dotenv(Path(__file__).resolve().parents[1] / ".env")
key = os.getenv("GEMINI_API_KEY", "")
model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
if not key:
    raise SystemExit("GEMINI_API_KEY is missing from apps/api/.env")

try:
    client = genai.Client(api_key=key, http_options=types.HttpOptions(timeout=45_000))
    response = client.models.generate_content(
        model=model,
        contents="Reply with OK.",
        config=types.GenerateContentConfig(max_output_tokens=128),
    )
    print(f"Gemini request OK; model={model}; response_present={bool(response.text)}")
except errors.APIError as error:
    message = str(error).replace(key, "[REDACTED]")
    print(f"Gemini request failed; model={model}; HTTP={error.code}; detail={message[:500]}")
    raise SystemExit(1) from None
except Exception as error:
    print(f"Gemini connection failed; type={type(error).__name__}")
    raise SystemExit(1) from None
