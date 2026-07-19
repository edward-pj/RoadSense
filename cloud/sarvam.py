"""RoadSense — Sarvam AI integration (Text-to-Speech + Translate).

Business-logic module (route handlers in app.py orchestrate only). The
Sarvam API key is read from the environment and never leaves the server;
the static mobile page reaches Sarvam only through the app.py proxy.

Callers pass a short language code ("hi", "ta", ...); we map it to Sarvam's
codes ("hi-IN"). Sarvam is a paid, closed API, so every caller must keep a
working fallback (pre-baked translation JSON for UI text, browser
speechSynthesis for voice) — the edge-first rule means the app must still
function with no Sarvam access.
"""
from __future__ import annotations

import base64
import logging
import os

import httpx

log = logging.getLogger("roadsense.sarvam")

_BASE = "https://api.sarvam.ai"
_TIMEOUT = httpx.Timeout(30.0)

# Short code -> Sarvam language code. Covers the app's six languages plus a
# few extras so the translate tool can be pointed at more targets later.
LANG_CODES = {
    "en": "en-IN", "hi": "hi-IN", "bn": "bn-IN", "ta": "ta-IN",
    "te": "te-IN", "mr": "mr-IN", "kn": "kn-IN", "gu": "gu-IN",
    "ml": "ml-IN", "pa": "pa-IN", "od": "od-IN",
}

# Default Sarvam bulbul:v2 speaker for the voice alert.
_SPEAKER = "anushka"


class SarvamError(RuntimeError):
    """Sarvam is unreachable, misconfigured, or returned an error."""


def _key() -> str:
    """Return the Sarvam subscription key, or raise if it is not configured."""
    key = os.environ.get("SARVAM_API_KEY", "").strip()
    if not key:
        raise SarvamError("SARVAM_API_KEY is not set")
    return key


def code(lang: str) -> str:
    """Map a short code ("hi") to a Sarvam code ("hi-IN"); default en-IN."""
    return LANG_CODES.get((lang or "en").lower(), "en-IN")


async def tts(text: str, lang: str = "en") -> bytes:
    """Synthesize ``text`` in ``lang`` via Sarvam TTS; return WAV audio bytes.

    Raises :class:`SarvamError` on any misconfiguration or upstream failure so
    the caller can fall back to on-device speech.
    """
    text = (text or "").strip()
    if not text:
        raise SarvamError("empty text")
    payload = {
        "text": text[:500],  # bulbul:v2 per-call character budget
        "target_language_code": code(lang),
        "speaker": _SPEAKER,
        "model": "bulbul:v2",
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(
            f"{_BASE}/text-to-speech",
            headers={"api-subscription-key": _key()},
            json=payload,
        )
    if resp.status_code != 200:
        raise SarvamError(f"tts upstream {resp.status_code}: {resp.text[:200]}")
    audios = resp.json().get("audios") or []
    if not audios:
        raise SarvamError("tts returned no audio")
    return base64.b64decode(audios[0])


async def translate(text: str, source: str = "en", target: str = "hi") -> str:
    """Translate ``text`` from ``source`` to ``target`` via Sarvam Translate."""
    text = (text or "").strip()
    if not text:
        return ""
    payload = {
        "input": text,
        "source_language_code": code(source),
        "target_language_code": code(target),
        "model": "mayura:v1",
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(
            f"{_BASE}/translate",
            headers={"api-subscription-key": _key()},
            json=payload,
        )
    if resp.status_code != 200:
        raise SarvamError(f"translate upstream {resp.status_code}: {resp.text[:200]}")
    return resp.json().get("translated_text", "")
