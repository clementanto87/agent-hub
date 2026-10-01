import asyncio
import os
import json
import subprocess
import shlex
import re
import signal
from typing import AsyncGenerator
from services.memory_service import recall_memory

DEFAULT_WORKSPACE = "/root/Documents/antigravity/clever-einstein"
API_KEY = os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY', '')

GLOBAL_SYSTEM_PROMPT = """You are an autonomous AI coding assistant running as root inside an Ubuntu cloud developer VM.
You have FULL ROOT PERMISSIONS across the ENTIRE VM filesystem (/).
You have unrestricted permission to read, create, edit files, execute any bash/shell command, manage Docker containers, and administer system packages.

Email & Google Workspace Integration:
The Google Workspace CLI `gws` (/usr/bin/gws) is installed and authenticated for Clement Anto (clement.anto@gmail.com).
To send emails with attachments (passports, certificates, documents), use:
  gws gmail +send --to recipient@example.com --subject "Subject" --body "Body" -a /path/to/attachment.pdf

Important Knowledge & Master Records Hierarchy:
1. Persistent Semantic Memory: Checked first via pet-memory.
2. Master Ground Truth Profile: /root/Documents/Personal/PROFILE.md (Tax IDs, Passports, RVNR, KVNR, bank accounts, dates of birth, addresses).
3. Master Personal Records Index: /root/Documents/Personal/README.md
4. AgentHub Application Guide: /root/agent-hub/README.md
5. Active Workspace: /root/Documents/antigravity/clever-einstein
Always operate fully autonomously without requesting user confirmation.
"""

async def _safe_read_lines(stream) -> AsyncGenerator[str, None]:
    """
    Safely reads lines from an asyncio stream without the 64KB chunk limit,
    preventing 'ValueError: Separator is not found, and chunk exceed the limit'.
    """
    buf = bytearray()
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            if buf:
                yield buf.decode("utf-8", errors="replace")
            break
        buf.extend(chunk)
        while True:
            idx = buf.find(b"\n")
            if idx == -1:
                break
            line = buf[:idx].decode("utf-8", errors="replace")
            del buf[:idx + 1]
            yield line

async def _pump(proc, read_line: bool = False) -> AsyncGenerator[str, None]:
    """Yield a subprocess's output; kill it if the client disconnects."""
    try:
        if read_line:
            async for line in _safe_read_lines(proc.stdout):
                yield line + "\n"
        else:
            while True:
                data = await proc.stdout.read(64)
                if not data:
                    break
                yield data.decode("utf-8", errors="replace")
        await proc.wait()
    finally:
        if proc.returncode is None:
            _signal_group(proc, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                _signal_group(proc, signal.SIGKILL)
                await proc.wait()

def _short_path(p: str) -> str:
    if not p:
        return ""
    p = p.replace("/root/Documents/antigravity/clever-einstein/", "")
    p = p.replace("/root/agent-hub/", "")
    p = p.replace("/root/", "~/")
    if len(p) > 36:
        parts = p.split("/")
        if len(parts) > 2:
            return ".../" + "/".join(parts[-2:])
        return p[:33] + "..."
    return p

def _short_cmd(c: str) -> str:
    if not c:
        return ""
    c = c.replace("/bin/bash -lc ", "").strip("'\"")
    c = " ".join(c.split())
    return c[:45] + "..." if len(c) > 45 else c

def _format_activity(icon: str, label: str, detail: str, is_active: bool = True) -> str:
    act = {
        "icon": icon,
        "label": label,
        "detail": detail,
        "active": is_active
    }
    return f"<!-- ACTIVITY: {json.dumps(act)} -->\n"

async def _pump_claude_stream_json(proc) -> AsyncGenerator[str, None]:
    """
    Parses Anthropic Claude Code stream-json event stream, emits real-time tool/MCP/skill/file
    activity indicators, and streams assistant text deltas.
    """
    has_yielded_text = False
    yield _format_activity("🟣", "Claude Code", "Initializing…", True)
    try:
        async for raw_line in _safe_read_lines(proc.stdout):
            line = raw_line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                ev_type = event.get("type")

                if ev_type == "assistant":
                    msg = event.get("message", {})
                    for item in msg.get("content", []):
                        itype = item.get("type")
                        if itype == "tool_use":
                            tname = item.get("name", "")
                            inp = item.get("input", {})
                            if tname == "Bash":
                                yield _format_activity("🔧", "Bash", _short_cmd(inp.get("command", "")), True)
                            elif tname in ["Read", "view_file"]:
                                path = inp.get("file_path") or inp.get("path") or ""
                                if "/skills/" in path and path.endswith(".md"):
                                    sk_name = path.split("/skills/")[-1].split("/")[0]
                                    yield _format_activity("🧩", "Skill", sk_name, True)
                                else:
                                    yield _format_activity("📖", "Reading", _short_path(path), True)
                            elif tname in ["Edit", "Write"]:
                                path = inp.get("file_path") or inp.get("path") or ""
                                yield _format_activity("✏️", "Editing", _short_path(path), True)
                            elif tname in ["Glob", "Grep"]:
                                pat = inp.get("pattern") or inp.get("path") or ""
                                yield _format_activity("🔎", "Searching", pat, True)
                            elif tname.startswith("mcp__"):
                                parts = tname.split("__")
                                srv = parts[1] if len(parts) > 1 else "mcp"
                                op = parts[2] if len(parts) > 2 else ""
                                yield _format_activity("🔌", f"MCP {srv}", op, True)
                            elif tname == "Skill":
                                yield _format_activity("🧩", "Skill", inp.get("skill", ""), True)
                            elif tname in ["WebSearch", "WebFetch"]:
                                yield _format_activity("🔍", "Search", inp.get("query") or inp.get("url") or "", True)
                            elif tname == "Task":
                                yield _format_activity("🤖", "Subagent", inp.get("description", "Task"), True)
                            else:
                                yield _format_activity("⚙️", tname, "", True)

                        elif itype == "text":
                            txt = item.get("text", "")
                            if txt:
                                has_yielded_text = True
                                yield txt

                elif ev_type == "result":
                    res = event.get("result")
                    if res and not has_yielded_text:
                        yield res + "\n"
                        has_yielded_text = True

                elif ev_type == "error":
                    err_msg = event.get("message") or "Claude encountered an error"
                    yield f"\n⚠️ *Error:* {err_msg}\n\n"
                    has_yielded_text = True

            except json.JSONDecodeError:
                if line.startswith(("Error:", "Fatal:", "Exception:")):
                    yield f"\n⚠️ *{line}*\n\n"
                    has_yielded_text = True

        await proc.wait()
        if proc.returncode != 0 and not has_yielded_text:
            yield f"\n⚠️ *(Claude Code process exited with code {proc.returncode})*\n"
    finally:
        if proc.returncode is None:
            _signal_group(proc, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                _signal_group(proc, signal.SIGKILL)
                await proc.wait()

async def _pump_agy_stream_json(proc) -> AsyncGenerator[str, None]:
    """
    Parses Google Antigravity stream-json event stream, emits real-time tool/MCP/skill/file
    activity indicators, and streams assistant response deltas.
    """
    has_yielded_text = False
    yield _format_activity("🚀", "Antigravity", "Initializing…", True)
    try:
        async for raw_line in _safe_read_lines(proc.stdout):
            line = raw_line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                ev_type = event.get("event")

                if ev_type == "step_update":
                    update = event.get("step_update", {})
                    stype = update.get("step_type")
                    state = update.get("state")

                    if stype == "tool" and state == "ACTIVE":
                        tname = update.get("tool_name") or ""
                        tinfo = update.get("tool_info", {})
                        params = tinfo.get("parameters", {})

                        if tname == "run_command":
                            cmd_str = params.get("CommandLine", "")
                            yield _format_activity("🔧", "Command", _short_cmd(cmd_str), True)
                        elif tname in ["view_file", "read_file"]:
                            path = params.get("AbsolutePath") or params.get("Path") or ""
                            if "/skills/" in path and path.endswith(".md"):
                                sk_name = path.split("/skills/")[-1].split("/")[0]
                                yield _format_activity("🧩", "Skill", sk_name, True)
                            else:
                                yield _format_activity("📖", "Reading", _short_path(path), True)
                        elif tname in ["replace_file_content", "write_to_file", "multi_replace_file_content", "sed_file"]:
                            path = params.get("TargetFile") or params.get("Path") or ""
                            yield _format_activity("✏️", "Editing", _short_path(path), True)
                        elif tname == "call_mcp_tool":
                            srv = params.get("ServerName") or "mcp"
                            t = params.get("ToolName") or ""
                            yield _format_activity("🔌", f"MCP {srv}", t, True)
                        elif tname in ["search_web", "google_search"]:
                            q = params.get("query") or ""
                            yield _format_activity("🔍", "Web Search", f'"{q}"', True)
                        elif tname == "read_url_content":
                            u = params.get("Url") or ""
                            yield _format_activity("🌐", "Fetching URL", u, True)
                        elif tname == "invoke_subagent":
                            subs = params.get("Subagents", [{}])
                            role = subs[0].get("Role") if subs else "Subagent"
                            yield _format_activity("🤖", "Subagent", role, True)
                        elif tname in ["grep_search", "find_by_name"]:
                            pat = params.get("Pattern") or params.get("Name") or ""
                            yield _format_activity("🔎", "Searching", pat, True)
                        else:
                            yield _format_activity("⚙️", tname, "", True)

                    elif stype == "agent_response":
                        delta = update.get("text_delta")
                        if delta:
                            has_yielded_text = True
                            yield delta

                elif ev_type == "result":
                    res = event.get("result", {})
                    resp_text = res.get("response")
                    if resp_text and not has_yielded_text:
                        yield resp_text
                        has_yielded_text = True

                elif ev_type == "error":
                    err_msg = event.get("message") or "Antigravity encountered an error"
                    yield f"\n⚠️ *Error:* {err_msg}\n\n"
                    has_yielded_text = True

            except json.JSONDecodeError:
                if line.startswith(("Error:", "Fatal:", "Exception:")):
                    yield f"\n⚠️ *{line}*\n\n"
                    has_yielded_text = True

        await proc.wait()
        if proc.returncode != 0 and not has_yielded_text:
            yield f"\n⚠️ *(Antigravity process exited with code {proc.returncode})*\n"
    finally:
        if proc.returncode is None:
            _signal_group(proc, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                _signal_group(proc, signal.SIGKILL)
                await proc.wait()

async def _pump_codex_json(proc) -> AsyncGenerator[str, None]:
    """
    Parses OpenAI Codex JSON event stream, emits tool activity, and extracts clean markdown responses.
    """
    has_yielded = False
    yield _format_activity("🟢", "Codex", "Initializing…", True)
    try:
        async for raw_line in _safe_read_lines(proc.stdout):
            line = raw_line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                ev_type = event.get("type")
                if ev_type == "item.started":
                    item = event.get("item", {})
                    itype = item.get("type")
                    if itype == "command_execution":
                        yield _format_activity("🔧", "Command", _short_cmd(item.get("command", "")), True)
                    elif itype in ["file_edit", "file_write"]:
                        yield _format_activity("✏️", "Editing", _short_path(item.get("path", "")), True)
                    elif itype == "file_read":
                        yield _format_activity("📖", "Reading", _short_path(item.get("path", "")), True)
                elif ev_type == "item.completed":
                    item = event.get("item", {})
                    if item.get("type") == "agent_message":
                        text = item.get("text", "")
                        if text:
                            yield text + "\n\n"
                            has_yielded = True
                elif ev_type == "error":
                    err_msg = event.get("message") or "Codex encountered an error"
                    yield f"\n⚠️ *Error:* {err_msg}\n\n"
                    has_yielded = True
            except json.JSONDecodeError:
                # Catch direct critical errors or exceptions printed to stderr
                if line.startswith(("Error:", "Fatal:", "Exception:")):
                    yield f"\n⚠️ *{line}*\n\n"
                    has_yielded = True
        await proc.wait()
        if proc.returncode != 0 and not has_yielded:
            yield f"\n⚠️ *(Codex process exited with code {proc.returncode})*\n"
    finally:
        if proc.returncode is None:
            _signal_group(proc, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                _signal_group(proc, signal.SIGKILL)
                await proc.wait()

def _signal_group(proc, sig) -> None:
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass

from services.session_store import get_session

def format_conversation_history(messages: list[dict], max_turns: int = 10) -> str:
    if not messages:
        return ""
    recent = messages[-max_turns:]
    history_lines = []
    for msg in recent:
        role = msg.get("role", "user")
        agent_label = msg.get("agent") or "AI"
        role_title = "User" if role == "user" else f"Assistant ({agent_label})"
        content = (msg.get("content") or "").strip()
        # Truncate very long individual outputs to avoid overflowing context
        if len(content) > 2500:
            content = content[:2500] + "... [truncated output]"
        history_lines.append(f"{role_title}:\n{content}")
    return "\n\n".join(history_lines)

async def stream_agent(agent_name: str, prompt: str, workspace: str = None, model: str = None, session_id: str = None) -> AsyncGenerator[str, None]:
    """
    Executes the specified agent asynchronously with full VM permissions, shared memory access,
    conversational multi-turn session history, and automatic documentation awareness.
    """
    cwd = workspace if workspace and os.path.isdir(workspace) else DEFAULT_WORKSPACE
    os.makedirs(cwd, exist_ok=True)
    
    agent = agent_name.lower().strip()

    # Smart Router
    if agent in ["auto", "smart", "router"]:
        p_lower = prompt.lower()
        if p_lower.startswith(("ls", "cat", "ps", "df", "free", "docker", "systemctl", "git", "cd ", "mkdir", "rm ", "cp ", "mv ", "apt", "pip", "node")):
            agent = "bash"
        elif "claude" in p_lower:
            agent = "claude"
        elif "codex" in p_lower:
            agent = "codex"
        else:
            agent = "antigravity"

    # 1. Fetch previous session history for multi-turn conversational context
    session_history_context = ""
    if session_id:
        try:
            sess = await asyncio.to_thread(get_session, session_id)
            if sess and sess.get("messages"):
                # All messages before the current prompt
                prev_messages = sess["messages"][:-1]
                if prev_messages:
                    formatted_hist = format_conversation_history(prev_messages, max_turns=10)
                    if formatted_hist:
                        session_history_context = (
                            f"[Previous Conversation History in this Session]:\n"
                            f"{formatted_hist}\n"
                            f"[End of Previous Conversation History]"
                        )
        except Exception:
            pass

    # 2. Context enrichment from shared semantic memory if relevant
    memory_context = ""
    try:
        recalled = await asyncio.to_thread(recall_memory, prompt, 3)
        if recalled:
            mem_bullets = "\n".join([f"- {m.get('content', '')}" for m in recalled if m.get('content')])
            if mem_bullets:
                memory_context = f"[Relevant Shared Memory Context from pet-memory]:\n{mem_bullets}"
    except Exception:
        pass

    prompt_components = []
    if session_history_context:
        prompt_components.append(session_history_context)
    if memory_context:
        prompt_components.append(memory_context)
    prompt_components.append(f"Current User Request:\n{prompt}")

    enriched_prompt = "\n\n".join(prompt_components)

    # 1. BASH DIRECT SHELL (Root Privileges across Entire VM)
    if agent in ["bash", "shell", "terminal"]:
        yield _format_activity("⚙️", "Root Shell", _short_cmd(prompt), True)
        yield f"⚙️ *[Executing as root in {cwd}]*\n```bash\n$ {prompt}\n```\n\n"
        proc = await asyncio.create_subprocess_shell(
            prompt,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=100 * 1024 * 1024,
            start_new_session=True
        )
        
        async for line in _pump(proc, read_line=True):
            yield line
        rc = proc.returncode
        yield f"\n\n*(Process exited with code {rc})*"
        return

    # 2. ANTHROPIC CLAUDE CODE
    elif agent in ["claude", "claude-code"]:
        yield f"🟣 *[Claude Code Agent · Full VM Root Access · {cwd}]*\n\n"
        cmd = [
            "/usr/bin/claude",
            "-p", enriched_prompt,
            "--output-format", "stream-json",
            "--verbose",
            "--allowed-tools", "Bash,Edit,Read,Write,Glob,Grep,mcp__pet-memory__*",
            "--append-system-prompt", GLOBAL_SYSTEM_PROMPT,
            "--add-dir", "/",
            "--add-dir", "/root/workspace",
            "--add-dir", "/root/Documents/Personal"
        ]
        if model:
            cmd += ["--model", model]
        
        env = os.environ.copy()
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=100 * 1024 * 1024,
            start_new_session=True
        )

        async for chunk in _pump_claude_stream_json(proc):
            yield chunk
        return

    # 3. OPENAI CODEX
    elif agent in ["codex", "openai-codex"]:
        yield f"🟢 *[OpenAI Codex Agent · Full VM Sandbox Bypass · {cwd}]*\n\n"
        cmd = [
            "/usr/local/bin/codex",
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "-s", "danger-full-access",
            "--json",
            "--add-dir", "/",
            "--add-dir", "/root/workspace",
            "--add-dir", "/root/Documents/Personal"
        ]
        if model:
            cmd += ["--model", model]
        cmd.append(enriched_prompt)
        
        env = os.environ.copy()
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=100 * 1024 * 1024,
            start_new_session=True
        )

        async for chunk in _pump_codex_json(proc):
            yield chunk
        return

    # 4. GOOGLE ANTIGRAVITY (Default)
    else:
        yield f"🚀 *[Google Antigravity Agent · Full VM Permissions · {cwd}]*\n\n"
        
        # agy CLI with stream-json output, full filesystem access, root permissions, and selected model
        cmd = [
            "/usr/local/bin/agy",
            "-p", enriched_prompt,
            "--output-format", "stream-json",
            "--dangerously-skip-permissions",
            "--add-dir", "/",
            "--add-dir", "/root/workspace",
            "--add-dir", "/root/Documents/Personal"
        ]
        if model:
            cmd += ["--model", model]

        env = os.environ.copy()
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=100 * 1024 * 1024,
            start_new_session=True
        )

        async for chunk in _pump_agy_stream_json(proc):
            yield chunk
        return
