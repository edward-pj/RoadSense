"""Pre-bake the driver-app UI strings into every supported language.

Reads the English source catalog (``mobile/i18n/app.en.json``) and, for each
target language, calls **Sarvam Translate** to produce
``mobile/i18n/app.<lang>.json``. These files are committed and loaded at
runtime by ``mobile/rs-i18n.js`` — so the running app needs no network and no
per-use cost for text (edge-first rule). Only the live voice alert calls
Sarvam at runtime.

Placeholders like ``{n}`` / ``{cls}`` / ``{coins}`` are protected before
translation (swapped to ``#0``, ``#1`` sentinels that Sarvam preserves) and
restored after. If any placeholder is lost in translation, that single string
falls back to English so a screen never renders a broken template.

Usage:
    SARVAM_API_KEY=... python tools/translate_ui.py            # all langs
    python tools/translate_ui.py --langs hi ta                 # a subset

The key is read from the environment / repo-root .env (never committed).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Import the shared Sarvam client so there is one source of truth.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cloud import sarvam  # noqa: E402

log = logging.getLogger("roadsense.translate_ui")

I18N_DIR = Path(__file__).resolve().parents[1] / "mobile" / "i18n"
SOURCE = I18N_DIR / "app.en.json"
TARGET_LANGS = ["hi", "bn", "ta", "te", "mr"]

_PLACEHOLDER = re.compile(r"\{[a-zA-Z0-9_]+\}")


def _protect(text: str) -> tuple[str, list[str]]:
    """Swap ``{name}`` tokens for ``#i`` sentinels Sarvam keeps verbatim."""
    tokens: list[str] = []

    def sub(m: re.Match[str]) -> str:
        tokens.append(m.group(0))
        return f"#{len(tokens) - 1}"

    return _PLACEHOLDER.sub(sub, text), tokens


def _restore(text: str, tokens: list[str]) -> str | None:
    """Put ``{name}`` tokens back. Return None if any sentinel was lost."""
    out = text
    for i, tok in enumerate(tokens):
        # Tolerate Sarvam adding spaces or dropping the '#' next to the index.
        pat = re.compile(rf"#\s*{i}\b|(?<!\d){i}(?=\D|$)")
        if not pat.search(out):
            return None
        out = pat.sub(tok, out, count=1)
    return out


async def _translate_retry(text: str, lang: str, tries: int = 6) -> str:
    """Sarvam translate with backoff — tolerate timeouts and 429 rate limits."""
    for attempt in range(tries):
        try:
            return await sarvam.translate(text, "en", lang)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            if attempt == tries - 1:
                raise sarvam.SarvamError(f"translate failed after {tries} tries: {exc}")
            await asyncio.sleep(1.5 * (attempt + 1))
        except sarvam.SarvamError as exc:
            # Back off harder on rate limits; re-raise anything else immediately.
            if "429" not in str(exc) or attempt == tries - 1:
                raise
            await asyncio.sleep(4.0 * (attempt + 1))
    return ""  # unreachable


async def _translate_key(key: str, en_text: str, lang: str) -> str:
    """Translate one string, preserving placeholders or falling back to EN."""
    protected, tokens = _protect(en_text)
    translated = await _translate_retry(protected, lang)
    if not tokens:
        return translated or en_text
    restored = _restore(translated, tokens)
    if restored is None:
        log.warning("placeholder lost for %s/%s — keeping English", lang, key)
        return en_text
    return restored


async def bake(langs: list[str]) -> None:
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    # Keys starting with "_" are notes, not UI strings.
    keys = [k for k in source if not k.startswith("_")]
    for lang in langs:
        log.info("translating %d strings -> %s", len(keys), lang)
        out: dict[str, str] = {}
        for key in keys:
            out[key] = await _translate_key(key, source[key], lang)
            await asyncio.sleep(0.35)  # stay under Sarvam's rate limit
        dest = I18N_DIR / f"app.{lang}.json"
        dest.write_text(
            json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        log.info("wrote %s", dest.relative_to(I18N_DIR.parents[1]))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--langs", nargs="*", default=TARGET_LANGS,
                    help=f"language codes to bake (default: {TARGET_LANGS})")
    args = ap.parse_args()
    try:
        asyncio.run(bake(args.langs))
    except sarvam.SarvamError as exc:
        log.error("Sarvam error: %s", exc)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
