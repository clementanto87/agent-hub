"""A short spoken summary for long replies in voice mode.

Voice mode reads the first few sentences of an answer as they stream in. If the answer is longer
(tables, lists, long explanations), this produces one or two natural sentences covering the rest, so the
user hears the headline instead of a wall of text or a bare "the rest is on screen".
"""
import os

from google import genai
from google.genai import types

API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", "")
MODEL = os.environ.get("AGENTHUB_SUMMARY_MODEL", "gemini-3.1-flash-lite")

_INSTRUCTIONS = """You turn a long written answer into the spoken ending of a voice reply.
The assistant already said the opening sentences aloud. Say the rest as ONE or TWO short, natural spoken sentences:
the headline or conclusion, and where useful that the details are on screen. Plain text only: no markdown, lists,
emoji or greeting. Do not repeat what was already said and do not mention that you are summarising."""

_client = None


async def summarize(text: str, spoken: str = "") -> str:
    global _client
    if not API_KEY:
        return ""
    if _client is None:
        _client = genai.Client(api_key=API_KEY, http_options=types.HttpOptions(timeout=10000))
    resp = await _client.aio.models.generate_content(
        model=MODEL,
        contents=f"Already said aloud:\n{spoken[:600]}\n\nFull answer:\n{text[:6000]}",
        config=types.GenerateContentConfig(system_instruction=_INSTRUCTIONS, max_output_tokens=140, temperature=0.4),
    )
    return (resp.text or "").strip()
