"""Tests for the Sarvam integration (cloud/sarvam.py + the app.py proxies).

No real network: httpx is monkeypatched and the app-level Sarvam calls are
stubbed, so the suite runs offline and in CI. Async module functions are driven
with asyncio.run (the project does not depend on pytest-asyncio); the HTTP
endpoints use FastAPI's sync TestClient like the rest of the suite.
"""
from __future__ import annotations

import asyncio
import base64

import pytest
from fastapi.testclient import TestClient

from cloud import sarvam
from cloud.app import app


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    """Stands in for httpx.AsyncClient; records the last POST and replies."""

    last_url: str | None = None
    last_json: dict | None = None

    def __init__(self, response: _FakeResponse):
        self._response = response

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def post(self, url, headers=None, json=None):  # noqa: A002
        _FakeClient.last_url = url
        _FakeClient.last_json = json
        return self._response


def _patch_http(monkeypatch, response: _FakeResponse):
    monkeypatch.setattr(sarvam.httpx, "AsyncClient", lambda *a, **k: _FakeClient(response))


# ---- pure helper ----------------------------------------------------------
def test_code_maps_short_to_sarvam():
    assert sarvam.code("hi") == "hi-IN"
    assert sarvam.code("HI") == "hi-IN"
    assert sarvam.code("") == "en-IN"
    assert sarvam.code("zz") == "en-IN"  # unknown -> default


# ---- module functions (driven with asyncio.run) ---------------------------
def test_tts_missing_key(monkeypatch):
    monkeypatch.delenv("SARVAM_API_KEY", raising=False)
    with pytest.raises(sarvam.SarvamError):
        asyncio.run(sarvam.tts("hello", "hi"))


def test_tts_decodes_audio(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "sk_test_123")
    raw = b"RIFFfakewavdata"
    _patch_http(monkeypatch, _FakeResponse(200, {"audios": [base64.b64encode(raw).decode()]}))
    out = asyncio.run(sarvam.tts("Aage gaddha hai", "hi"))
    assert out == raw
    assert _FakeClient.last_url.endswith("/text-to-speech")
    assert _FakeClient.last_json["target_language_code"] == "hi-IN"


def test_tts_upstream_error(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "sk_test_123")
    _patch_http(monkeypatch, _FakeResponse(429, text="rate limited"))
    with pytest.raises(sarvam.SarvamError):
        asyncio.run(sarvam.tts("hello", "hi"))


def test_translate_happy_path(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "sk_test_123")
    _patch_http(monkeypatch, _FakeResponse(200, {"translated_text": "आगे गड्ढा है"}))
    out = asyncio.run(sarvam.translate("Pothole ahead", "en", "hi"))
    assert out == "आगे गड्ढा है"
    assert _FakeClient.last_json["source_language_code"] == "en-IN"
    assert _FakeClient.last_json["target_language_code"] == "hi-IN"


def test_translate_empty_input_short_circuits(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "sk_test_123")
    _patch_http(monkeypatch, _FakeResponse(500, text="should not be called"))
    assert asyncio.run(sarvam.translate("  ", "en", "hi")) == ""


# ---- HTTP proxy endpoints (sync TestClient; Sarvam calls stubbed) ---------
@pytest.fixture()
def client() -> TestClient:
    with TestClient(app) as c:
        yield c


def test_tts_endpoint_returns_wav(monkeypatch, client):
    async def fake_tts(text, lang):
        assert (text, lang) == ("Aage gaddha hai", "hi")
        return b"RIFFwav"
    monkeypatch.setattr("cloud.app.sarvam.tts", fake_tts)
    r = client.post("/api/v1/tts", json={"text": "Aage gaddha hai", "lang": "hi"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.content == b"RIFFwav"


def test_tts_endpoint_error_envelope(monkeypatch, client):
    async def fake_tts(text, lang):
        raise sarvam.SarvamError("SARVAM_API_KEY is not set")
    monkeypatch.setattr("cloud.app.sarvam.tts", fake_tts)
    r = client.post("/api/v1/tts", json={"text": "hi", "lang": "hi"})
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "sarvam_unavailable"


def test_translate_endpoint(monkeypatch, client):
    async def fake_translate(text, source, target):
        return "अनुवाद"
    monkeypatch.setattr("cloud.app.sarvam.translate", fake_translate)
    r = client.post("/api/v1/translate", json={"text": "translate", "target": "hi"})
    assert r.status_code == 200
    assert r.json() == {"translated_text": "अनुवाद"}
