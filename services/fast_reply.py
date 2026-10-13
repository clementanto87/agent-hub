"""Fast conversational replies for text and voice chat.

Spawning a full coding-agent CLI (Antigravity/Claude/Codex) takes 10-15 seconds due to MCP discovery,
directory indexing, and heavy models. For conversational queries (greetings, explanations,
brainstorming, coding snippets, general knowledge, follow-ups), a lightweight model answers in ~0.5s.

If the prompt requires system operations (bash commands, reading/editing files, personal records from disk,
email/calendar actions, deployments, or credentials), the fast model outputs HANDOFF_TOKEN, and the server
seamlessly hands off execution to the full root agent CLI.

Auth: Reuses Claude Code OAuth credentials with automatic fallback to Google Gemini Flash.
"""
import asyncio
import json
import os
import re
import subprocess
import time
from typing import AsyncGenerator, List, Optional

import httpx

ENABLED = os.environ.get("AGENTHUB_FAST_REPLY", "1") != "0"
PRIMARY_MODEL = os.environ.get("AGENTHUB_FAST_MODEL", "claude-haiku-4-5-20251001")
FALLBACK_MODEL = "gemini-3.8-flash"
HANDOFF_TOKEN = "[[AGENT]]"
VOICE_MAX_TOKENS = 250
TEXT_MAX_TOKENS = 2048
HISTORY_TURNS = 8
HISTORY_CHARS = 1000

# Anthropic system identity (required for Claude Code OAuth token)
_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

_VOICE_INSTRUCTIONS = f"""You are the voice of the user's personal AI assistant, speaking out loud in a live conversation.
Your words are read aloud by a text-to-speech voice, so:
- Answer in one to three short, natural spoken sentences. Plain text only: no markdown, lists, emoji or code.
- Sound like a warm, quick-witted person, not a manual. Get straight to the answer.
- Make your FIRST sentence short (under about 10 words) so speech can begin immediately; put detail after it.

You can only chat. You cannot run commands, read files, browse, or look anything up. If the request needs
any of that, or touches the user's own computer, projects, files, accounts, email, calendar, memory,
documents or personal details, or needs current/live information, or asks you to build, change, fix,
check, deploy, search, remind or send something, then a more capable agent will do it for you. In that case
reply with exactly {HANDOFF_TOKEN} followed by ONE short, natural sentence (under 14 words) that acknowledges
the task and says you'll get back to them, for example "{HANDOFF_TOKEN} Sure, let me check the disk space and get back to you."
Make the sentence specific to what they asked, vary the wording, and never answer or guess the result yourself.
Also use {HANDOFF_TOKEN} whenever you are unsure. Never claim to have done a task yourself.
CONTEXT RULE: You have no view of the user's workspace, repo, apps or settings. If the question could refer to
THEIR project, app, code, setup, "this"/"our"/"the" system, or an ambiguous term that probably means something
in their environment (e.g. "auto mode", "the router", "the service"), reply with {HANDOFF_TOKEN} so an agent can
inspect it. NEVER ask the user to clarify what a term means and never list generic meanings of it.

For greetings, small talk, general knowledge, explanations, opinions, brainstorming, math and follow-ups
about what was just said, answer directly."""

_TEXT_INSTRUCTIONS = f"""You are the user's personal AI assistant in AgentHub, running on their dedicated Ubuntu Linux VM.
You provide instant, intelligent, helpful answers formatted in clean, visually rich GitHub-flavored markdown.

VISUAL PRESENTATION & FORMATTING DIRECTIVE:
- Never write huge, dense paragraphs or walls of text. Keep text minimal, concise, crisp, and easily readable (1-2 sentences max per point).
- Present information visually using rich UI components:
  * Key Numbers & Facts: Stat tiles `- **Label:** value (optional note)`
  * Tables: Clean Markdown tables with Status and clear headers
  * Callouts: `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, `> [!IMPORTANT]`, or `> ✅ text` / `> ❌ text`
  * Workflows: ````steps ```` JSON blocks or task lists (`- [x] done`, `- [ ] todo`)
  * Diagrams: Mermaid flowcharts / sequence diagrams
  * Profiles/Configs: ````kv ```` JSON blocks
  * Trends & Metrics: ````metrics ```` or ````spark ```` JSON blocks
  * Before vs After: ````compare ```` JSON blocks

You are answering in fast conversational mode.
You can answer greetings, explanations, programming questions, code snippets, architecture design, math, logic, drafting, translations, general knowledge, and conversational follow-ups directly and thoroughly.

You CANNOT directly execute shell commands, edit files on disk, search private emails/calendars, or run system tools in this fast mode.
If the user's prompt explicitly asks you to:
- Run a bash command or terminal utility (e.g. `df -h`, `git status`, `docker ps`, `curl`, `systemctl`, `npm run`, `python script.py`)
- Read, write, create, edit, or delete a specific file on the filesystem
- Look up personal records, tax IDs, passports, or private documents from their files
- Search or query nearby attractions, restaurants, live weather, or local travel distance that require environmental tools
- Search or send Gmail, check Google Calendar, or access Google Drive
- Perform automated site logins or access the credentials vault
- Deploy, restart, or inspect background services

THEN reply with exactly {HANDOFF_TOKEN} followed by ONE short markdown sentence acknowledging the task, for example:
"{HANDOFF_TOKEN} Handing over to agent to check disk space..."
Never fake command outputs or claim you modified files on disk.
Also use {HANDOFF_TOKEN} whenever you are unsure or if the request requires real-world Linux environment execution.
CONTEXT RULE: You have no view of the user's workspace, repo, apps or settings. If the question could refer to
THEIR project, app, code, setup, "this"/"our"/"the" system, or an ambiguous term that probably means something
in their environment (e.g. "auto mode", "the router", "the service"), reply with {HANDOFF_TOKEN} so an agent can
inspect it. NEVER ask the user to clarify what a term means and never list generic meanings of it.


For all greetings, explanations, writing, code examples, brainstorming, and general inquiries, answer directly in clean, visual markdown!"""

def _get_location_context() -> str:
    try:
        loc_path = "/root/workspace/scripts/CURRENT_LOCATION.json"
        if os.path.exists(loc_path):
            with open(loc_path) as f:
                d = json.load(f)
            return (
                f"\n\nUser's live location context: {d.get('label', '')} - {d.get('address', '')} "
                f"(Coordinates: {d.get('latitude')}, {d.get('longitude')}, Timezone: {d.get('timezone')}). "
                f"Note: {d.get('note', '')}\n"
                f"If the user asks for live weather, nearby POIs (restaurants, attractions, cafes), local distance or navigation that requires fresh tool execution, hand off immediately with {HANDOFF_TOKEN}."
            )
    except Exception:
        pass
    return ""


_client: Optional[httpx.AsyncClient] = None
_gemini_key: Optional[str] = None


def _token() -> str:
    with open(os.path.expanduser("~/.claude/.credentials.json")) as f:
        oauth = json.load(f)["claudeAiOauth"]
    if oauth.get("expiresAt") and oauth["expiresAt"] / 1000 < time.time() + 30:
        raise RuntimeError("Claude token expired")
    return oauth["accessToken"]


def _get_gemini_key() -> str:
    global _gemini_key
    if _gemini_key:
        return _gemini_key
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        try:
            res = subprocess.run(["vault", "get", "gemini-api", "--field", "password"], capture_output=True, text=True, timeout=5)
            if res.returncode == 0 and res.stdout.strip():
                key = res.stdout.strip()
        except Exception:
            pass
    _gemini_key = key or ""
    return _gemini_key


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(25, connect=5), http2=False)
    return _client


def _clean(text: str) -> str:
    text = re.sub(r"<!--[\s\S]*?-->", "", text or "")
    text = re.sub(r"^\s*(?:🚀|🟣|🟢|🔷|⚙️)\S*\s*", "", text)
    return re.sub(r"\s+", " ", text).strip()[:HISTORY_CHARS]


def build_messages(history: List[dict], prompt: str) -> List[dict]:
    """Recent turns as strictly alternating user/assistant messages, ending with the new prompt."""
    msgs: List[dict] = []
    for m in (history or [])[-HISTORY_TURNS:]:
        role = "assistant" if m.get("role") == "assistant" else "user"
        content = _clean(m.get("content", ""))
        if not content:
            continue
        if msgs and msgs[-1]["role"] == role:
            msgs[-1]["content"] += "\n" + content
        else:
            msgs.append({"role": role, "content": content})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    if msgs and msgs[-1]["role"] == "user":
        msgs.pop()
    msgs.append({"role": "user", "content": prompt})
    return msgs


async def warm_up() -> None:
    """Keep connection warm."""
    if not ENABLED:
        return
    try:
        await _http().head("https://api.anthropic.com/", timeout=5)
    except Exception:
        pass


async def _stream_claude(prompt: str, history: List[dict], is_voice: bool) -> AsyncGenerator[str, None]:
    instructions = (_VOICE_INSTRUCTIONS if is_voice else _TEXT_INSTRUCTIONS) + _get_location_context()
    max_tokens = VOICE_MAX_TOKENS if is_voice else TEXT_MAX_TOKENS
    body = {
        "model": PRIMARY_MODEL,
        "max_tokens": max_tokens,
        "stream": True,
        "system": [{"type": "text", "text": _IDENTITY}, {"type": "text", "text": instructions}],
        "messages": build_messages(history, prompt),
    }
    headers = {
        "Authorization": f"Bearer {_token()}",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
    }
    head = ""
    decided = False
    async with _http().stream("POST", "https://api.anthropic.com/v1/messages", json=body, headers=headers) as r:
        if r.status_code != 200:
            raise RuntimeError(f"Claude fast model HTTP {r.status_code}")
        async for line in r.aiter_lines():
            if not line.startswith("data:"):
                continue
            try:
                evt = json.loads(line[5:])
            except ValueError:
                continue
            if evt.get("type") != "content_block_delta":
                continue
            piece = evt.get("delta", {}).get("text", "")
            if not piece:
                continue
            if decided:
                yield piece
                continue
            head += piece
            stripped = head.lstrip()
            if stripped.startswith("[["):
                if HANDOFF_TOKEN.startswith(stripped) and len(stripped) < len(HANDOFF_TOKEN):
                    continue
                yield HANDOFF_TOKEN
                if not stripped.startswith(HANDOFF_TOKEN):
                    return
                decided = True
                rest = stripped[len(HANDOFF_TOKEN):].lstrip()
                if rest:
                    yield rest
                head = ""
                continue
            if len(stripped) >= 2 or (stripped and not stripped.startswith("[")):
                decided = True
                yield head
                head = ""
    if head.strip() and not decided:
        yield head


async def _stream_gemini(prompt: str, history: List[dict], is_voice: bool) -> AsyncGenerator[str, None]:
    key = _get_gemini_key()
    if not key:
        raise RuntimeError("No Gemini API key available for fallback")
    instructions = (_VOICE_INSTRUCTIONS if is_voice else _TEXT_INSTRUCTIONS) + _get_location_context()
    max_tokens = VOICE_MAX_TOKENS if is_voice else TEXT_MAX_TOKENS

    contents = []
    for m in (history or [])[-HISTORY_TURNS:]:
        role = "model" if m.get("role") == "assistant" else "user"
        cnt = _clean(m.get("content", ""))
        if cnt:
            contents.append({"role": role, "parts": [{"text": cnt}]})
    if contents and contents[-1]["role"] == "user":
        contents.pop()
    contents.append({"role": "user", "parts": [{"text": prompt}]})

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{FALLBACK_MODEL}:streamGenerateContent?alt=sse&key={key}"
    payload = {
        "systemInstruction": {"parts": [{"text": instructions}]},
        "contents": contents,
        "generationConfig": {"maxOutputTokens": max_tokens},
    }

    head = ""
    decided = False
    async with _http().stream("POST", url, json=payload, timeout=20) as r:
        if r.status_code != 200:
            raise RuntimeError(f"Gemini fast fallback HTTP {r.status_code}")
        async for line in r.aiter_lines():
            if not line.startswith("data:"):
                continue
            try:
                evt = json.loads(line[5:])
            except ValueError:
                continue
            cands = evt.get("candidates", [])
            if not cands:
                continue
            piece = cands[0].get("content", {}).get("parts", [{}])[0].get("text", "")
            if not piece:
                continue
            if decided:
                yield piece
                continue
            head += piece
            stripped = head.lstrip()
            if stripped.startswith("[["):
                if HANDOFF_TOKEN.startswith(stripped) and len(stripped) < len(HANDOFF_TOKEN):
                    continue
                yield HANDOFF_TOKEN
                if not stripped.startswith(HANDOFF_TOKEN):
                    return
                decided = True
                rest = stripped[len(HANDOFF_TOKEN):].lstrip()
                if rest:
                    yield rest
                head = ""
                continue
            if len(stripped) >= 2 or (stripped and not stripped.startswith("[")):
                decided = True
                yield head
                head = ""
    if head.strip() and not decided:
        yield head


async def stream_reply(prompt: str, history: List[dict], is_voice: bool = False) -> AsyncGenerator[str, None]:
    """Yield reply text as it arrives. Yields HANDOFF_TOKEN (once, first) if the agent should answer."""
    try:
        async for chunk in _stream_claude(prompt, history, is_voice):
            yield chunk
    except Exception as e:
        print(f"Claude fast stream error: {e}, attempting Gemini fallback...")
        try:
            async for chunk in _stream_gemini(prompt, history, is_voice):
                yield chunk
        except Exception as e2:
            print(f"Gemini fallback stream error: {e2}")
            # Signal handoff on total fast failure
            yield HANDOFF_TOKEN
