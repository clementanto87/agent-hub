"""Background agent runs.

An agent run is owned by the server, not by the HTTP request that started it. If the phone
locks, the tab closes or the connection drops, the run keeps going, its output is kept in
memory and the final reply is saved to the conversation. Clients (re)attach with `follow()`.
"""
import asyncio
import time
from typing import AsyncGenerator, Dict, List, Optional

from services.agent_runner import stream_agent
from services.session_store import add_message

# Appended to the prompt the agent sees (never stored) when the user is talking by voice.
VOICE_HINT = (
    "\n\n[Voice conversation: reply in at most three short, natural spoken sentences. "
    "Plain text only - no markdown, lists or code.]"
)

KEEP_FINISHED_SEC = 3600
MAX_RUNS = 100


class RunActive(Exception):
    """A reply is already running in this conversation."""


class Run:
    def __init__(self, session_id: str, agent: str, prompt: str, workspace: str, model: Optional[str] = None):
        self.session_id = session_id
        self.agent = agent
        self.model = model
        self.prompt = prompt
        self.workspace = workspace
        self.status = "running"          # running | done | stopped | error
        self.started = time.time()
        self.finished: Optional[float] = None
        self.buf = bytearray()
        self.task: Optional[asyncio.Task] = None
        self._cond = asyncio.Condition()

    @property
    def running(self) -> bool:
        return self.status == "running"

    async def _push(self, text: str) -> None:
        self.buf += text.encode("utf-8")
        async with self._cond:
            self._cond.notify_all()

    async def _finish(self, status: str) -> None:
        self.status = status
        self.finished = time.time()
        async with self._cond:
            self._cond.notify_all()

    async def follow(self) -> AsyncGenerator[bytes, None]:
        """Yield everything produced so far, then new output until the run ends."""
        pos = 0
        while True:
            async with self._cond:
                await self._cond.wait_for(lambda: len(self.buf) > pos or not self.running)
            if len(self.buf) > pos:
                data = bytes(self.buf[pos:])
                pos += len(data)
                yield data
            elif not self.running:
                return

    def info(self) -> dict:
        return {
            "session_id": self.session_id,
            "agent": self.agent,
            "model": self.model,
            "status": self.status,
            "running": self.running,
            "started": self.started,
            "chars": len(self.buf),
        }


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    # Standard LLM heuristic: ~3.8 chars per token
    return max(1, int(len(text) / 3.8))


class RunManager:
    def __init__(self) -> None:
        self._runs: Dict[str, Run] = {}

    def get(self, session_id: str) -> Optional[Run]:
        return self._runs.get(session_id)

    def is_running(self, session_id: str) -> bool:
        run = self._runs.get(session_id)
        return bool(run and run.running)

    def active(self) -> List[dict]:
        return [r.info() for r in self._runs.values() if r.running]

    def start(self, session_id: str, agent: str, prompt: str, workspace: str, voice: bool = False, model: Optional[str] = None) -> Run:
        if self.is_running(session_id):
            raise RunActive(session_id)
        self._prune()
        run = Run(session_id, agent, prompt, workspace, model)
        self._runs[session_id] = run
        agent_prompt = prompt + VOICE_HINT if voice and agent.lower() not in ("bash", "shell", "terminal") else prompt
        run.task = asyncio.create_task(self._execute(run, agent_prompt))
        return run

    def stop(self, session_id: str) -> bool:
        run = self._runs.get(session_id)
        if run and run.running and run.task:
            run.task.cancel()
            return True
        return False

    async def _execute(self, run: Run, agent_prompt: str) -> None:
        status = "done"
        try:
            async for chunk in stream_agent(run.agent, agent_prompt, run.workspace, model=run.model, session_id=run.session_id):
                await run._push(chunk)
        except asyncio.CancelledError:
            status = "stopped"           # agent_runner's finally block kills the process tree
        except Exception as e:           # surfaced to the user as part of the reply
            await run._push(f"\n[Error executing {run.agent}: {e}]")
            status = "error"
        finally:
            text = run.buf.decode("utf-8", errors="replace")
            if text.strip():
                prompt_tokens = estimate_tokens(run.prompt)
                reply_tokens = estimate_tokens(text)
                total_tokens = prompt_tokens + reply_tokens
                add_message(run.session_id, "assistant", text, run.agent, run.model, tokens=total_tokens)
            await run._finish(status)

    def _prune(self) -> None:
        now = time.time()
        for sid in [s for s, r in self._runs.items() if r.finished and now - r.finished > KEEP_FINISHED_SEC]:
            del self._runs[sid]
        if len(self._runs) > MAX_RUNS:
            for sid in sorted((s for s, r in self._runs.items() if not r.running), key=lambda s: self._runs[s].finished or 0)[: len(self._runs) - MAX_RUNS]:
                del self._runs[sid]


run_manager = RunManager()
