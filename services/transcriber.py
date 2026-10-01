import os
import io
import tempfile
import av
import numpy as np
from faster_whisper import WhisperModel
from google import genai
from google.genai import types

API_KEY = os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY', '')

_whisper_model = None

def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        try:
            _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
        except Exception as e:
            print(f"Error loading base Whisper, falling back to tiny: {e}")
            _whisper_model = WhisperModel("tiny", device="cpu", compute_type="int8")
    return _whisper_model

def decode_audio(path: str, sample_rate: int = 16000) -> np.ndarray:
    """Decode any container (mp4/aac from iOS, webm/opus from Chrome, wav) to mono float32.

    faster-whisper's own decoder passes an option that PyAV >= 19 rejects, so we decode here
    and hand Whisper the samples directly.
    """
    chunks = []
    with av.open(path) as container:
        resampler = av.AudioResampler(format="flt", layout="mono", rate=sample_rate)
        for frame in container.decode(container.streams.audio[0]):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    return np.concatenate(chunks).astype(np.float32) if chunks else np.zeros(0, dtype=np.float32)


def warm_up() -> None:
    """Load the Whisper model ahead of the first request."""
    try:
        get_whisper()
    except Exception as e:
        print(f"Whisper warm-up failed: {e}")


def transcribe_audio(audio_bytes: bytes, mime_type: str = "audio/webm", agent: str = "antigravity") -> str:
    """
    Transcribes spoken audio using native high-fidelity cloud models:
    - Google Gemini Multimodal Audio for Antigravity, Claude, and general coding/assistant tasks.
    - Specialized Linux CLI shell command transcription for Bash.
    - Automatic fallback to local faster-whisper if offline.
    """
    if not audio_bytes or len(audio_bytes) < 400:
        return ""

    agent_lower = (agent or "antigravity").lower().strip()

    # Specialized transcription instructions per agent
    if agent_lower in ["bash", "shell", "terminal"]:
        prompt_instruction = (
            "Transcribe the spoken audio into the exact Linux bash shell command. "
            "Recognize CLI commands, flags, tools, file paths, and syntax (e.g. docker, systemctl, git, ls, cat, apt). "
            "Return ONLY the plain command string without markdown, backticks, or commentary."
        )
    elif agent_lower in ["codex", "openai"]:
        prompt_instruction = (
            "Transcribe the spoken audio with high precision for an AI software engineering assistant. "
            "Recognize code symbols, variable names, programming languages, and instructions accurately. "
            "Return only the clean transcript."
        )
    elif agent_lower in ["claude"]:
        prompt_instruction = (
            "Transcribe the spoken audio accurately with proper punctuation, casing, and technical terminology. "
            "Return only the transcription text."
        )
    else:
        # Antigravity / Default
        prompt_instruction = (
            "You are the native speech recognition engine for Google Antigravity. "
            "Transcribe the spoken audio with exact precision. "
            "Accurately recognize technical developer terms, code, system commands, filenames, personal names, and natural language. "
            "Return only the clean transcript text without quotes or notes."
        )

    # 1. Native Google Gemini Multimodal Audio-to-Text (State-of-the-Art accuracy & speed)
    try:
        clean_mime = mime_type.split(";")[0].strip().lower()
        valid_mimes = ["audio/wav", "audio/mp3", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg", "audio/m4a"]
        if clean_mime not in valid_mimes:
            clean_mime = "audio/mp4" if "mp4" in mime_type or "m4a" in mime_type else "audio/webm"

        client = genai.Client(api_key=API_KEY)
        response = client.models.generate_content(
            model='gemini-3.1-flash-lite',
            contents=[
                types.Part.from_bytes(data=audio_bytes, mime_type=clean_mime),
                prompt_instruction
            ]
        )
        if response.text:
            text = response.text.strip().strip('"').strip("'")
            if text:
                return text
    except Exception as gemini_err:
        print(f"Native Gemini transcription error: {gemini_err}")

    # 2. Local Whisper Fallback (Offline fallback)
    try:
        suffix = ".mp4" if "mp4" in mime_type or "m4a" in mime_type else ".webm"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            whisper = get_whisper()
            audio = decode_audio(tmp_path)
            if audio.size < 1600:
                return ""
            segments, info = whisper.transcribe(audio, beam_size=3, vad_filter=True)
            transcript = " ".join([seg.text.strip() for seg in segments]).strip()
            if transcript:
                return transcript
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as whisper_err:
        print(f"Local Whisper fallback error: {whisper_err}")

    return ""
