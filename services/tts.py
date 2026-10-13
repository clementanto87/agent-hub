"""Neural text-to-speech engine with ultra-lifelike human voices (Edge-TTS) + local Piper fallback.

Provides studio-grade natural human speech for Antigravity, Claude, and Codex agents,
with natural inflections, pauses, and expressive intonation.
"""
import io
import os
import re
import asyncio
import threading
import wave
import urllib.request

VOICE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "voices")
_PIPER_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/"
MAX_CHARS = 1200

# High-fidelity Human-like Neural Voice Catalog
VOICE_CATALOG = [
    {
        "id": "en-US-ChristopherNeural",
        "name": "Christopher",
        "gender": "Male",
        "accent": "US",
        "style": "Authoritative, warm & intelligent",
        "default_for": "antigravity"
    },
    {
        "id": "en-US-AriaNeural",
        "name": "Aria",
        "gender": "Female",
        "accent": "US",
        "style": "Articulate, expressive & polished",
        "default_for": "claude"
    },
    {
        "id": "en-US-EricNeural",
        "name": "Eric",
        "gender": "Male",
        "accent": "US",
        "style": "Friendly, crisp & energetic",
        "default_for": "codex"
    },
    {
        "id": "en-US-JennyNeural",
        "name": "Jenny",
        "gender": "Female",
        "accent": "US",
        "style": "Warm, natural & conversational",
        "default_for": "default"
    },
    {
        "id": "en-US-GuyNeural",
        "name": "Guy",
        "gender": "Male",
        "accent": "US",
        "style": "Casual, natural & confident",
        "default_for": None
    },
    {
        "id": "en-GB-RyanNeural",
        "name": "Ryan",
        "gender": "Male",
        "accent": "UK",
        "style": "Sophisticated, crisp British",
        "default_for": None
    },
    {
        "id": "en-GB-SoniaNeural",
        "name": "Sonia",
        "gender": "Female",
        "accent": "UK",
        "style": "Refined & articulate British",
        "default_for": None
    },
    {
        "id": "en-IN-NeerjaExpressiveNeural",
        "name": "Neerja",
        "gender": "Female",
        "accent": "IN",
        "style": "Expressive & clear Indian English",
        "default_for": None
    },
    {
        "id": "en-IN-PrabhatNeural",
        "name": "Prabhat",
        "gender": "Male",
        "accent": "IN",
        "style": "Friendly Indian English",
        "default_for": None
    }
]

DEFAULT_VOICE = os.environ.get("AGENTHUB_VOICE_DEFAULT", "en-US-JennyNeural")
AGENT_VOICES = {
    "antigravity": os.environ.get("AGENTHUB_VOICE_ANTIGRAVITY", "en-US-ChristopherNeural"),
    "claude": os.environ.get("AGENTHUB_VOICE_CLAUDE", "en-US-AriaNeural"),
    "regina": os.environ.get("AGENTHUB_VOICE_REGINA", "en-US-AriaNeural"),
    "codex": os.environ.get("AGENTHUB_VOICE_CODEX", "en-US-EricNeural"),
}

_piper_voices = {}
_lock = threading.Lock()


def get_voice_catalog():
    return VOICE_CATALOG


def voice_for(agent: str = None) -> str:
    return AGENT_VOICES.get((agent or "").lower(), DEFAULT_VOICE)


def clean_text_for_speech(text: str) -> str:
    """Strip markdown symbols, formatting, code blocks, and URLs so speech sounds 100% human."""
    if not text:
        return ""

    # Remove code blocks
    text = re.sub(r'```[\s\S]*?```', ' Code block omitted. ', text)
    # Remove inline code
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # Remove markdown links [label](url) -> label
    text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', text)
    # Remove raw URLs
    text = re.sub(r'https?://\S+', '', text)
    # Remove headers, bullets, blockquotes
    text = re.sub(r'^[#*>\-+]+\s*', '', text, flags=re.MULTILINE)
    # Remove formatting marks like bold/italic **text** or *text* or __text__
    text = re.sub(r'[*_~]{1,3}', '', text)
    # Replace math blocks or special symbols
    text = text.replace('$', '').replace('•', '').replace('—', ' - ')
    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text).strip()

    # Cap maximum characters
    if len(text) > MAX_CHARS:
        cut = text[:MAX_CHARS]
        # try to cut at last sentence boundary
        last_punct = max(cut.rfind('.'), cut.rfind('!'), cut.rfind('?'))
        if last_punct > MAX_CHARS // 2:
            text = cut[:last_punct + 1]
        else:
            text = cut + "..."

    return text


async def _synthesize_edge(text: str, voice_name: str) -> bytes:
    import edge_tts
    comm = edge_tts.Communicate(text, voice_name, rate="+0%", pitch="+0Hz")
    buf = io.BytesIO()
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    return buf.getvalue()


def _ensure_piper_files(name: str) -> str:
    os.makedirs(VOICE_DIR, exist_ok=True)
    model = os.path.join(VOICE_DIR, f"{name}.onnx")
    if not os.path.exists(model):
        try:
            locale, speaker, quality = name.split("-", 2)
            family = locale.split("_")[0]
            url = f"{_PIPER_BASE}{family}/{locale}/{speaker}/{quality}/{name}"
            for suffix in (".onnx", ".onnx.json"):
                path = os.path.join(VOICE_DIR, name + suffix)
                if not os.path.exists(path):
                    urllib.request.urlretrieve(url + suffix, path + ".part")
                    os.replace(path + ".part", path)
        except Exception:
            pass
    return model


def _synthesize_piper_fallback(text: str) -> bytes:
    fallback_name = "en_US-lessac-medium"
    with _lock:
        voice = _piper_voices.get(fallback_name)
        if voice is None:
            from piper import PiperVoice
            model_path = _ensure_piper_files(fallback_name)
            voice = PiperVoice.load(model_path)
            _piper_voices[fallback_name] = voice
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            voice.synthesize_wav(text, wav)
        return buf.getvalue()


def warm_up() -> None:
    """Preload background components."""
    pass


def synthesize(text: str, voice: str = None) -> bytes:
    """Synthesizes text into natural human speech bytes."""
    cleaned = clean_text_for_speech(text)
    if not cleaned:
        return b""

    voice_name = voice or DEFAULT_VOICE

    # Try Edge Neural TTS first
    try:
        loop = asyncio.new_event_loop()
        try:
            audio_bytes = loop.run_until_complete(_synthesize_edge(cleaned, voice_name))
            if audio_bytes:
                return audio_bytes
        finally:
            loop.close()
    except Exception as e:
        print(f"Edge-TTS failed for voice {voice_name}: {e}. Falling back to local Piper.")

    # Fallback to local Piper
    try:
        return _synthesize_piper_fallback(cleaned)
    except Exception as e:
        print(f"Piper TTS fallback failed: {e}")
        return b""
