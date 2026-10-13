"""Native realtime voice (Gemini Live) with the AgentHub agents as a tool.

The browser streams microphone audio (16 kHz PCM16) over a WebSocket; this module relays it to a
Gemini Live session and relays the model's spoken reply (24 kHz PCM16) back. The model hears speech
directly (no separate transcription step) and starts answering ~0.3 s after you stop talking.

Anything that needs the machine goes through the `ask_agent` tool: the model says a short
acknowledgement ("let me check that"), the real agent (Claude / Codex / Antigravity) does the work in
the background, and when it finishes the model tells you the outcome. The conversation is stored in
the normal session history, so it shows up in the chat like any other.

WebSocket protocol
  browser -> server   binary: PCM16 mono 16 kHz          text: {"type":"start",...} | {"type":"stop"} | {"type":"text","text":...}
  server  -> browser  binary: PCM16 mono 24 kHz          text: JSON events (see _emit calls)
"""
import asyncio
import json
import os
import re
import time
import uuid
from typing import Optional

from google import genai
from google.genai import types

from services.run_manager import run_manager, RunActive
from services.session_store import add_message, create_session, get_session

API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", "")
MODEL = os.environ.get("AGENTHUB_LIVE_MODEL", "gemini-2.5-flash-native-audio-latest")
ENABLED = bool(API_KEY) and os.environ.get("AGENTHUB_LIVE_VOICE", "1") != "0"

AGENT_VOICES = {"antigravity": "Puck", "claude": "Aoede", "codex": "Charon"}
DEFAULT_VOICE = "Puck"
AGENT_NAMES = {"antigravity": "Antigravity", "claude": "Claude Code", "codex": "Codex"}

HISTORY_TURNS = 8
HISTORY_CHARS = 500
RESULT_CHARS = 3500
STILL_WORKING_AFTER = 15      # seconds of silence from a running task before the model reassures the user
STILL_WORKING_EVERY = 25

# A spoken promise to go and do something. If the model says this without calling ask_agent, we run the task anyway.
_PROMISE_RE = re.compile(r"\b(let you know|get back to you|let me (check|look|find|see|pull|dig|run|take)|i'?ll (check|look|find|run|pull|dig|take a look|see)|i will (check|look|find)|checking (that|on|the)|looking (into|at) (that|it|the))\b", re.I)
_TAG_RE = re.compile(r"^\s*(?:🚀|🟣|🟢|⚙️)\s*\*\[[^\]\n]*\]\*[ \t]*\n*")
_COMMENT_RE = re.compile(r"<!--[\s\S]*?-->")


def _plain(text: str) -> str:
    text = _COMMENT_RE.sub("", text or "")
    text = _TAG_RE.sub("", text)
    return text.strip()


def _history_block(session_id: Optional[str]) -> str:
    if not session_id:
        return ""
    try:
        sess = get_session(session_id)
    except Exception:
        return ""
    lines = []
    for m in (sess or {}).get("messages", [])[-HISTORY_TURNS:]:
        content = re.sub(r"\s+", " ", _plain(m.get("content", "")))[:HISTORY_CHARS]
        if content:
            lines.append(f"{'User' if m.get('role') == 'user' else 'Assistant'}: {content}")
    return "\n".join(lines)


def system_instruction(agent: str, session_id: Optional[str]) -> str:
    name = AGENT_NAMES.get(agent, "the coding agent")
    text = f"""You are the voice of the user's personal AI assistant, in a live spoken conversation. The user is the owner of a Linux server and talks to you hands-free.

How to talk
- Speak naturally and briefly: one to three short sentences. Warm, quick, direct. No markdown, lists or emoji. Spell out numbers and units the way people say them.
- Reply in the language the user speaks.
- You are chatting; you cannot touch the computer yourself.

Doing things
- Anything that needs the computer (running commands, files, code, projects, email, calendar, memory, documents, accounts, current or live information, searching, building, fixing, checking, deploying, reminding, sending) is done by {name}, a capable agent with full access to the machine. Hand it over with the ask_agent tool.
- Call ask_agent IMMEDIATELY, and while it starts say one short, natural sentence that says what you are checking or doing and that you will get back to them (vary the wording, for example "Sure, let me look at the disk space and get back to you."). Make it specific to what they asked. NEVER say you will check, look into or do something unless you call ask_agent in that same turn. Never guess or invent the result.
- Pass the full request, with every detail the user gave, as the task.
- You can keep chatting while the agent works. When its result arrives, tell the user the outcome in one or two sentences; if it is long, give the headline and say the details are on their screen. If the agent reports an error, say so plainly.
- For greetings, small talk, general knowledge, explanations, opinions and follow-ups, just answer.

Today is {time.strftime('%A %d %B %Y')}."""
    hist = _history_block(session_id)
    if hist:
        text += f"\n\nThe conversation so far (for context):\n{hist}"
    return text


def _tool() -> types.Tool:
    return types.Tool(function_declarations=[types.FunctionDeclaration(
        name="ask_agent",
        description="Hand a task that needs the computer to the coding agent and get its result. Use for commands, files, code, email, calendar, memory, live data, searching, building or fixing anything.",
        behavior=types.Behavior.NON_BLOCKING,
        parameters=types.Schema(type="OBJECT", properties={
            "task": types.Schema(type="STRING", description="The complete request, in the user's words plus any detail they gave."),
        }, required=["task"]),
    )])


def _config(agent: str, session_id: Optional[str], voice: Optional[str]) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=system_instruction(agent, session_id),
        tools=[_tool()],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        context_window_compression=types.ContextWindowCompressionConfig(sliding_window=types.SlidingWindow()),
        speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice or AGENT_VOICES.get(agent, DEFAULT_VOICE)))),
    )


_ACTIVE = {}      # client id -> LiveSession: a page never has two live conversations at once


class LiveSession:
    def __init__(self, ws):
        self.ws = ws
        self.agent = "claude"
        self.workspace = "/root"
        self.session_id: Optional[str] = None
        self.model = MODEL
        self.live = None
        self.user_text = ""          # what the user said this turn (input transcription)
        self.user_flushed = False
        self.model_text = ""         # what the model said this turn (output transcription)
        self.tool_turn = False       # this turn called ask_agent: the agent's own message is the record
        self.last_task = ""          # what the user asked in the latest turn (for the promise safety net)
        self.pending_results = 0     # agent results sent whose spoken readout hasn't finished (not stored twice)
        self.jobs = set()
        self.closed = False
        self.client = ""
        self.t0 = time.time()
        self.stats = {"mic_kb": 0.0, "audio_kb": 0.0, "turns": 0, "interrupted": 0, "tools": 0}
        self.end_reason = ""

    async def kick(self) -> None:
        """Another session started from the same page: end this one so only one voice answers."""
        self.closed = True
        try:
            await self.ws.close()
        except Exception:
            pass

    # ── helpers ──────────────────────────────────────────────
    async def _emit(self, **evt) -> None:
        if self.closed:
            return
        try:
            await self.ws.send_text(json.dumps(evt))
        except Exception:
            self.closed = True

    def _ensure_session(self, first_text: str = "") -> str:
        if not self.session_id:
            self.session_id = str(uuid.uuid4())
            title = (first_text or "Voice conversation")[:40]
            create_session(self.session_id, title, self.agent, self.workspace)
        return self.session_id

    async def _flush_user(self) -> None:
        text = self.user_text.strip()
        if self.user_flushed or not text:
            return
        self.user_flushed = True
        fresh = self.session_id is None
        sid = self._ensure_session(text)
        add_message(sid, "user", text, self.agent, None, tokens=max(1, int(len(text) / 3.8)))
        await self._emit(type="user", text=text, session_id=sid, new=fresh)

    async def _end_turn(self, interrupted: bool = False, completed: bool = False) -> None:
        await self._flush_user()
        spoken = self.model_text.strip()
        skip = self.tool_turn
        asked = self.user_text.strip()
        if asked:
            self.last_task = asked
        if completed and not skip and spoken and self.last_task and _PROMISE_RE.search(spoken) and self.pending_results == 0:
            # The model promised to go and do it but never called the tool: do it for them.
            skip = True
            job = asyncio.create_task(self.run_tool(None, task=self.last_task))
            self.jobs.add(job)
            job.add_done_callback(self.jobs.discard)
        if not skip and spoken and self.pending_results > 0:
            skip = True                                          # this is the model reading out an agent result
            self.pending_results -= 1
        if spoken and not skip:
            sid = self._ensure_session()
            add_message(sid, "assistant", spoken + (" …" if interrupted else ""), self.agent, self.model, tokens=max(1, int(len(spoken) / 3.8)))
            await self._emit(type="assistant", text=spoken, model=self.model)
        self.user_text = ""
        self.user_flushed = False
        self.model_text = ""
        self.tool_turn = False

    # ── Gemini → browser ─────────────────────────────────────
    async def pump_gemini(self) -> None:
        while not self.closed:
            async for msg in self.live.receive():
                sc = msg.server_content
                if msg.tool_call:
                    await self._flush_user()
                    self.tool_turn = True
                    for fc in msg.tool_call.function_calls:
                        self.stats["tools"] += 1
                        job = asyncio.create_task(self.run_tool(fc))
                        self.jobs.add(job)
                        job.add_done_callback(self.jobs.discard)
                if msg.go_away:
                    await self._emit(type="notice", text="The live session is about to end.")
                if not sc:
                    continue
                if sc.input_transcription and sc.input_transcription.text:
                    if self.user_flushed and (self.model_text or self.tool_turn):    # a new user turn began
                        await self._end_turn()
                    self.user_text += sc.input_transcription.text
                    await self._emit(type="in", text=self.user_text)
                if sc.model_turn:
                    for part in sc.model_turn.parts or []:
                        if part.inline_data and part.inline_data.data:
                            await self._flush_user()
                            if not self.closed:
                                try:
                                    await self.ws.send_bytes(part.inline_data.data)
                                    self.stats["audio_kb"] += len(part.inline_data.data) / 1024
                                except Exception:
                                    self.closed = True
                if sc.output_transcription and sc.output_transcription.text:
                    await self._flush_user()
                    self.model_text += sc.output_transcription.text
                    await self._emit(type="out", text=self.model_text)
                if sc.interrupted:
                    self.stats["interrupted"] += 1
                    await self._emit(type="interrupted")
                    await self._end_turn(interrupted=True)
                if sc.turn_complete:
                    self.stats["turns"] += 1
                    await self._end_turn(completed=True)
                    await self._emit(type="turn_complete")
        # the Gemini session ended
        self.end_reason = self.end_reason or "gemini receive loop finished"
        await self._emit(type="ended", text="The live session ended.")

    # ── agent tool ───────────────────────────────────────────
    async def run_tool(self, fc, task: str = "") -> None:
        if fc is not None:
            task = ((fc.args or {}).get("task") or "").strip()
        await self._emit(type="agent_start", task=task, agent=self.agent)
        started = time.time()
        text, ok = "", True
        try:
            sid = self._ensure_session(task)
            run = run_manager.start(sid, self.agent, task, self.workspace, voice=False)
        except RunActive:
            run, text, ok = None, "The agent is still busy with the previous task in this conversation.", False
        except Exception as e:
            run, text, ok = None, f"Could not start the agent: {e}", False

        if run is not None:
            raw = bytearray()
            last_emit = 0.0
            nudge_at = started + STILL_WORKING_AFTER
            stream = run.follow()
            nxt = None
            try:
                while True:
                    if nxt is None:
                        nxt = asyncio.ensure_future(stream.__anext__())
                    done, _ = await asyncio.wait({nxt}, timeout=1.0)
                    if not done:
                        if time.time() >= nudge_at and not self.closed:
                            nudge_at = time.time() + STILL_WORKING_EVERY
                            await self._nudge(int(time.time() - started))
                        continue
                    try:
                        chunk = nxt.result()
                    except StopAsyncIteration:
                        break
                    finally:
                        nxt = None
                    raw += chunk
                    now = time.time()
                    if now - last_emit > 0.4:
                        last_emit = now
                        await self._emit(type="agent_text", text=raw.decode("utf-8", "replace"))
                    nudge_at = max(nudge_at, now + STILL_WORKING_AFTER)    # output is flowing: no need to reassure yet
            except asyncio.CancelledError:
                if nxt:
                    nxt.cancel()
                raise
            full = raw.decode("utf-8", "replace")
            text = _plain(full)
            ok = run.status == "done"
            await self._emit(type="agent_done", text=full, ok=ok, agent=self.agent)

        result = (text or "The agent finished but returned no text.")[:RESULT_CHARS]
        self.pending_results += 1
        try:
            if fc is not None:
                await self.live.send_tool_response(function_responses=[types.FunctionResponse(
                    id=fc.id, name=fc.name,
                    response={("result" if ok else "error"): result, "scheduling": "INTERRUPT"})])
            else:
                await self.live.send_realtime_input(text=(
                    "[system note, not from the user: the task you promised to check has finished"
                    f"{'' if ok else ' with a problem'}. The agent's result: {result}\n"
                    "Now tell the user the outcome in one or two short spoken sentences; if it is long, give the headline and say the details are on their screen.]"))
        except Exception as e:
            print(f"live result delivery failed: {e}")

    async def _nudge(self, seconds: int) -> None:
        """The agent is quiet for a while: let the model reassure the user out loud."""
        try:
            await self.live.send_realtime_input(text=(
                f"[system note, not from the user: the agent has been working on the task for {seconds} seconds and is still going. "
                "Tell the user in one short natural sentence that it is still in progress. Do not call any tool.]"))
        except Exception as e:
            print(f"live nudge failed: {e}")

    # ── browser → Gemini ─────────────────────────────────────
    async def pump_browser(self) -> None:
        while not self.closed:
            msg = await self.ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes"):
                self.stats["mic_kb"] += len(msg["bytes"]) / 1024
                await self.live.send_realtime_input(audio=types.Blob(data=msg["bytes"], mime_type="audio/pcm;rate=16000"))
            elif msg.get("text"):
                try:
                    data = json.loads(msg["text"])
                except ValueError:
                    continue
                if data.get("type") == "stop":
                    break
                if data.get("type") == "text" and data.get("text"):
                    await self.live.send_realtime_input(text=data["text"])
                if data.get("type") == "audio_end":
                    await self.live.send_realtime_input(audio_stream_end=True)

    # ── lifecycle ────────────────────────────────────────────
    async def run(self) -> None:
        raw = await asyncio.wait_for(self.ws.receive_text(), 10)
        start = json.loads(raw)
        self.agent = (start.get("agent") or "claude").lower()
        if self.agent not in AGENT_NAMES:
            self.agent = "claude"
        self.workspace = start.get("workspace") or "/root"
        self.client = str(start.get("client") or "")[:64]
        if self.client:
            older = _ACTIVE.get(self.client)
            if older is not None and older is not self:
                await older.kick()
            _ACTIVE[self.client] = self
        self.session_id = start.get("session_id") or None
        if self.session_id and not get_session(self.session_id):
            self.session_id = None

        client = genai.Client(api_key=API_KEY)
        cfg = _config(self.agent, self.session_id, start.get("voice"))
        async with client.aio.live.connect(model=self.model, config=cfg) as live:
            self.live = live
            await self._emit(type="ready", model=self.model, voice=start.get("voice") or AGENT_VOICES.get(self.agent, DEFAULT_VOICE))
            tasks = [asyncio.create_task(self.pump_gemini()), asyncio.create_task(self.pump_browser())]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in done:
                    name = "gemini" if t is tasks[0] else "browser"
                    exc = t.exception() if not t.cancelled() else None
                    self.end_reason = f"{name} side ended" + (f": {type(exc).__name__}: {str(exc)[:160]}" if exc else "")
            finally:
                self.closed = True
                for t in tasks:
                    t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        # agent jobs keep running server-side (the run is saved to the conversation either way)
        for j in list(self.jobs):
            j.cancel()


async def handle(ws) -> None:
    s = LiveSession(ws)
    try:
        await s.run()
    except asyncio.TimeoutError:
        pass
    except Exception as e:
        print(f"live voice error: {type(e).__name__}: {e}")
        try:
            await ws.send_text(json.dumps({"type": "error", "text": "Live voice isn't available right now."}))
        except Exception:
            pass
    finally:
        print(f"live session end: {time.time() - s.t0:.0f}s agent={s.agent} reason={s.end_reason or 'closed'} "
              + " ".join(f"{k}={v:.0f}" if isinstance(v, float) else f"{k}={v}" for k, v in s.stats.items()))
        if s.client and _ACTIVE.get(s.client) is s:
            _ACTIVE.pop(s.client, None)
        try:
            await ws.close()
        except Exception:
            pass
