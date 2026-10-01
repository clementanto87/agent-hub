"""Local neural text-to-speech (Piper). Returns WAV bytes.

Used by voice mode so replies play through a normal <audio> element — unlike the browser's
speechSynthesis, that works on iOS with the silent switch on and sounds much better.

Each agent gets its own voice so a spoken conversation feels native to that provider
(Antigravity/Gemini, Claude, Codex/GPT). Voices download on first use.
"""
import io
import os
import threading
import urllib.request
import wave

VOICE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "voices")
_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/"
MAX_CHARS = 700

# One Piper voice per agent, plus a neutral default. Override any with env, e.g. AGENTHUB_VOICE_CLAUDE.
DEFAULT_VOICE = "en_US-lessac-medium"
AGENT_VOICES = {
    "antigravity": os.environ.get("AGENTHUB_VOICE_ANTIGRAVITY", "en_GB-alan-medium"),
    "claude": os.environ.get("AGENTHUB_VOICE_CLAUDE", "en_US-lessac-medium"),
    "codex": os.environ.get("AGENTHUB_VOICE_CODEX", "en_US-amy-medium"),
    "muse": os.environ.get("AGENTHUB_VOICE_MUSE", "en_US-bryce-medium"),
}
_ALLOWED = set(AGENT_VOICES.values()) | {DEFAULT_VOICE}

_voices = {}                 # name -> loaded PiperVoice
_lock = threading.Lock()     # one synthesis at a time on this small VM


def voice_for(agent: str = None) -> str:
    return AGENT_VOICES.get((agent or "").lower(), DEFAULT_VOICE)


def _voice_url(name: str) -> str:
    # e.g. "en_US-ryan-high" -> ".../en/en_US/ryan/high/en_US-ryan-high"
    locale, speaker, quality = name.split("-", 2)
    family = locale.split("_")[0]
    return f"{_BASE}{family}/{locale}/{speaker}/{quality}/{name}"


def _ensure_files(name: str) -> str:
    os.makedirs(VOICE_DIR, exist_ok=True)
    model = os.path.join(VOICE_DIR, f"{name}.onnx")
    for suffix in (".onnx", ".onnx.json"):
        path = os.path.join(VOICE_DIR, name + suffix)
        if not os.path.exists(path):
            urllib.request.urlretrieve(_voice_url(name) + suffix, path + ".part")
            os.replace(path + ".part", path)
    return model


def _load(name: str):
    voice = _voices.get(name)
    if voice is None:
        from piper import PiperVoice
        voice = PiperVoice.load(_ensure_files(name))
        _voices[name] = voice
    return voice


def warm_up() -> None:
    """Preload the default voice; the others load the first time they're used."""
    try:
        _load(DEFAULT_VOICE)
    except Exception as e:
        print(f"TTS warm-up failed: {e}")


def synthesize(text: str, voice: str = None) -> bytes:
    text = (text or "").strip()[:MAX_CHARS]
    if not text:
        return b""
    name = voice if voice in _ALLOWED else DEFAULT_VOICE
    buf = io.BytesIO()
    with _lock:
        try:
            v = _load(name)
        except Exception as e:
            print(f"TTS voice '{name}' unavailable ({e}); using default")
            v = _load(DEFAULT_VOICE)
        with wave.open(buf, "wb") as wav:
            v.synthesize_wav(text, wav)
    return buf.getvalue()
