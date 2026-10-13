"""Streaming speech-to-text for voice mode (Gemini Live transcription).

The browser sends 16 kHz PCM16 frames over a WebSocket *while the user is still speaking*; Gemini
transcribes as it goes, so when the voice-activity detector says "done" the text is ready ~0.5 s later
instead of after an upload + a full transcription call (~1.3 s).

  browser -> server  binary: PCM16 mono 16 kHz     text: {"type":"end"} (user stopped) | {"type":"cancel"}
  server  -> browser text: {"type":"ready"} | {"type":"final","text":"..."} | {"type":"error"}

Any failure just means the browser falls back to the normal upload-and-transcribe request.
"""
import asyncio
import json
import os
import time

from google import genai
from google.genai import types

API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", "")
MODEL = os.environ.get("AGENTHUB_STT_LIVE_MODEL", "gemini-3.5-transcribe-live")
ENABLED = bool(API_KEY) and os.environ.get("AGENTHUB_STT_STREAM", "1") != "0"
QUIET_AFTER_END = 0.25        # seconds without new text after the user stopped => the transcript is complete
MAX_WAIT_AFTER_END = 2.5


async def handle(ws) -> None:
    text = ""
    last_piece = 0.0
    ended_at = 0.0
    sent = False
    closed = False

    async def send(obj):
        nonlocal closed
        if closed:
            return
        try:
            await ws.send_text(json.dumps(obj))
        except Exception:
            closed = True

    try:
        client = genai.Client(api_key=API_KEY)
        cfg = types.LiveConnectConfig(response_modalities=["TEXT"], input_audio_transcription=types.AudioTranscriptionConfig())
        async with client.aio.live.connect(model=MODEL, config=cfg) as live:
            await send({"type": "ready"})

            async def from_gemini():
                nonlocal text, last_piece
                while not closed:
                    async for msg in live.receive():
                        sc = msg.server_content
                        if sc and sc.input_transcription and sc.input_transcription.text:
                            text += sc.input_transcription.text
                            last_piece = time.time()

            async def from_browser():
                nonlocal ended_at
                while True:
                    msg = await ws.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return "gone"
                    if msg.get("bytes"):
                        await live.send_realtime_input(audio=types.Blob(data=msg["bytes"], mime_type="audio/pcm;rate=16000"))
                    elif msg.get("text"):
                        try:
                            data = json.loads(msg["text"])
                        except ValueError:
                            continue
                        if data.get("type") == "cancel":
                            return "cancel"
                        if data.get("type") == "end":
                            ended_at = time.time()
                            await live.send_realtime_input(audio_stream_end=True)
                            return "end"

            gem = asyncio.create_task(from_gemini())
            try:
                why = await from_browser()
                if why == "end":
                    while time.time() - ended_at < MAX_WAIT_AFTER_END:
                        if text.strip() and time.time() - last_piece >= QUIET_AFTER_END:
                            break
                        await asyncio.sleep(0.04)
                    await send({"type": "final", "text": text.strip()})
            finally:
                gem.cancel()
                await asyncio.gather(gem, return_exceptions=True)
    except Exception as e:
        print(f"stt stream error: {type(e).__name__}: {e}")
        await send({"type": "error"})
    finally:
        try:
            await ws.close()
        except Exception:
            pass
