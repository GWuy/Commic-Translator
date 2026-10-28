import io
from types import SimpleNamespace

import pytest
from google.genai import errors as genai_errors

from fastapi.testclient import TestClient
from PIL import Image

from app.main import ApiError, app, ask_gemini, validated_regions

client = TestClient(app)


def test_health():
    assert client.get("/health").json()["status"] == "ok"


def test_invalid_image():
    response = client.post("/api/v1/translate/image", files={"image": ("bad.png", b"broken", "image/png")})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_image"


def test_cloud_api_token_required(monkeypatch):
    monkeypatch.setenv("API_ACCESS_TOKEN", "server-secret")
    missing = client.post("/api/v1/translate/image")
    wrong = client.post("/api/v1/translate/image", headers={"x-api-key": "wrong"})
    accepted = client.post("/api/v1/translate/image", headers={"x-api-key": "server-secret"})
    assert missing.status_code == wrong.status_code == 401
    assert accepted.status_code == 422


def test_cloud_api_fails_closed_without_token(monkeypatch):
    monkeypatch.setenv("K_SERVICE", "comic-translator-api")
    monkeypatch.delenv("API_ACCESS_TOKEN", raising=False)
    response = client.post("/api/v1/translate/image")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "missing_api_token"


def test_translation(monkeypatch):
    monkeypatch.setattr("app.main.ask_gemini", lambda *_: {"sourceLanguage": "ja", "regions": [{"id": "1", "type": "speech", "bbox": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.2}, "originalText": "こんにちは", "translatedText": "Xin chào", "confidence": 0.9, "readingOrder": 1}]})
    output = io.BytesIO()
    Image.new("RGB", (400, 400), "white").save(output, format="PNG")
    response = client.post("/api/v1/translate/image", data={"image_identifier": "test", "target_language": "vi"}, files={"image": ("comic.png", output.getvalue(), "image/png")})
    assert response.status_code == 200
    assert response.json()["regions"][0]["translatedText"] == "Xin chào"
    assert response.json()["regions"][0]["textBBox"] == response.json()["regions"][0]["bbox"]


def test_rejects_out_of_bounds_ai_result(monkeypatch):
    monkeypatch.setattr("app.main.ask_gemini", lambda *_: {"sourceLanguage": "ja", "regions": [{"id": "1", "type": "speech", "bbox": {"x": 0.9, "y": 0.2, "width": 0.3, "height": 0.2}, "originalText": "abc", "translatedText": "xyz", "confidence": 0.9, "readingOrder": 1}]})
    output = io.BytesIO()
    Image.new("RGB", (400, 400), "white").save(output, format="PNG")
    response = client.post("/api/v1/translate/image", files={"image": ("comic.png", output.getvalue(), "image/png")})
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "invalid_ai_output"


def test_keeps_valid_regions_when_one_box_is_invalid(monkeypatch):
    valid = {"id": "good", "type": "speech", "bbox": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.2}, "originalText": "Hello", "translatedText": "Xin chào", "confidence": 0.9, "readingOrder": 1}
    invalid = {**valid, "id": "bad", "bbox": {"x": 0.9, "y": 0.2, "width": 0.3, "height": 0.2}}
    monkeypatch.setattr("app.main.ask_gemini", lambda *_: {"sourceLanguage": "en", "regions": [valid, invalid]})
    output = io.BytesIO()
    Image.new("RGB", (400, 400), "white").save(output, format="PNG")
    response = client.post("/api/v1/translate/image", files={"image": ("comic.png", output.getvalue(), "image/png")})
    assert response.status_code == 200
    assert [region["id"] for region in response.json()["regions"]] == ["good"]


def test_normalizes_provider_coordinate_scale_and_small_overflow():
    base = {"id": "1", "type": "speech", "originalText": "Hello", "translatedText": "Xin chào", "confidence": 0.9, "readingOrder": 1}
    regions = validated_regions([
        {**base, "bbox": {"x": 150, "y": 220, "width": 320, "height": 180}},
        {**base, "id": "2", "bbox": {"x": 0.8, "y": 0.2, "width": 0.21, "height": 0.2}},
        {**base, "id": "3", "confidence": 95, "bbox": {"x": 0.6, "y": 0.3, "width": 0.8, "height": 0.4}},
    ])
    assert regions[0].bbox.x == 0.15
    assert regions[1].bbox.width == pytest.approx(0.2)
    assert regions[2].bbox.width == pytest.approx(0.2)
    assert regions[2].confidence == pytest.approx(0.95)


def test_unavailable_model_has_actionable_error(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")

    def reject(**_kwargs):
        raise genai_errors.ClientError(404, {"error": {"message": "model unavailable"}})

    monkeypatch.setattr("app.main.genai.Client", lambda **_kwargs: SimpleNamespace(models=SimpleNamespace(generate_content=reject)))
    with pytest.raises(ApiError) as captured:
        ask_gemini(b"image", "en", "vi", "")
    assert captured.value.code == "model_unavailable"


def test_temporary_provider_failure_is_retried(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr("app.main.time.sleep", lambda _seconds: None)
    attempts = 0

    def respond(**_kwargs):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise genai_errors.ServerError(503, {"error": {"message": "busy"}})
        return SimpleNamespace(text='{"sourceLanguage":"en","regions":[]}')

    monkeypatch.setattr("app.main.genai.Client", lambda **_kwargs: SimpleNamespace(models=SimpleNamespace(generate_content=respond)))
    result = ask_gemini(b"image", "en", "vi", "")
    assert result["regions"] == []
    assert attempts == 3
