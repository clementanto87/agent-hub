"""Auto mode: pick the agent AND the model for each message.

Fast and deterministic (no LLM call, ~0 ms). Two steps:

  1. classify the message  -> (agent, tier)      tier: light | standard | heavy
  2. map (agent, tier)     -> a model, using ordered preferences checked against the LIVE catalog
                              (services/model_catalog), so retired models are skipped automatically.

An explicit request ("use codex", "claude, ...") always wins. If no preferred model is in the
catalog the model is left unset and the agent uses its own default.
"""
import re
from typing import NamedTuple, Optional

from services import model_catalog


class Route(NamedTuple):
    agent: str
    model: Optional[str]
    tier: str
    reason: str


# ── step 2: model preferences, best first, per agent and tier ─────────────
PREFERRED = {
    "claude": {
        "light":    ["claude-haiku-5-5", "claude-haiku-4-5-20251001"],
        "standard": ["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6"],
        "heavy":    ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"],
    },
    "codex": {
        "light":    ["gpt-6-luna", "gpt-5.6-luna"],
        "standard": ["gpt-6.1-sol", "gpt-6-sol"],
        "heavy":    ["gpt-6-astra", "gpt-6.1-sol"],
    },
    "antigravity": {
        "light":    ["gemini-3.8-flash-low"],
        "standard": ["gemini-3.8-flash-medium"],
        "heavy":    ["gemini-3.8-flash-high"],
    },
}

# ── step 1: signals ───────────────────────────────────────────────────────
SHELL_WORDS = {
    "ls", "cat", "ps", "df", "du", "free", "docker", "systemctl", "journalctl", "git", "cd", "mkdir",
    "rm", "cp", "mv", "apt", "pip", "pip3", "node", "npm", "tail", "head", "grep", "uptime", "whoami",
    "pwd", "curl", "ping", "top", "htop", "kill", "chmod", "chown", "tmux", "which",
}
EXPLICIT = [  # (pattern, agent)
    (r"^\s*(claude)\b\s*[,:\-]", "claude"),
    (r"\b(?:use|ask|with|via|using|switch to|let|have|call)\s+(?:claude)\b", "claude"),
    (r"^\s*(codex)\b\s*[,:\-]", "codex"),
    (r"\b(?:use|ask|with|via|using|switch to|let|have|call)\s+(?:codex|gpt)\b", "codex"),
    (r"^\s*(gemini|antigravity)\b\s*[,:\-]", "antigravity"),
    (r"\b(?:use|ask|with|via|using|switch to|let|have|call)\s+(?:gemini|antigravity)\b", "antigravity"),
]
GREETING = re.compile(r"^\s*(hi|hello|hey|yo|thanks|thank you|ok|okay|cool|good (morning|evening|night)|gm)\b[\s!.?]*$", re.I)

CODE = re.compile(
    r"```|\b(code|coding|function|class|bug|fix|refactor|implement|compile|build|test(s|ing)?|unit test|"
    r"stack ?trace|traceback|exception|error|regex|sql|api|endpoint|script|python|typescript|javascript|"
    r"rust|golang|react|flutter|css|html|repo|commit|pull request|pr|diff|lint|dockerfile)\b", re.I)
HEAVY = re.compile(
    r"\b(architect(ure)?|design (a|the|an)|system design|trade-?offs?|deep(ly)?|thorough(ly)?|root cause|"
    r"security (review|audit)|audit|migrat(e|ion)|rewrite|from scratch|end-to-end|plan (out|for)|strategy|"
    r"analy[sz]e|investigate|compare .* (and|vs)|optimi[sz]e|performance|complex|step[- ]by[- ]step|"
    r"prove|derive|research)\b", re.I)
OPS = re.compile(
    r"\b(server|vm|service|systemd|docker|container|deploy|logs?|disk|memory usage|cron|nginx|ssl|dns|"
    r"install|restart|vault|email|gmail|calendar|drive|icloud|reminder|file|folder|directory|"
    r"passport|tax|profile\.md|documents?)\b", re.I)
LONGCTX = re.compile(
    r"\b(summari[sz]e|tl;?dr|translate|image|photo|screenshot|pdf|video|transcript|whole (repo|codebase)|"
    r"entire (repo|codebase)|large file|long document)\b", re.I)
LIGHT_Q = re.compile(r"^\s*(what|who|when|where|which|how (many|much|old|far|long)|is|are|do|does|can|define|convert)\b", re.I)


def _looks_like_shell(prompt: str) -> bool:
    p = prompt.strip()
    if "\n" in p or p.endswith("?"):
        return False
    words = p.split()
    if not words or words[0].lower() not in SHELL_WORDS:
        return False
    # "git status" is a command; "git is confusing, can you explain" is not
    return len(words) <= 8 or bool(re.search(r"[|&;<>$`]|\s-{1,2}\w", p))


def _pick_model(agent: str, tier: str) -> Optional[str]:
    prefs = PREFERRED.get(agent, {}).get(tier, [])
    try:
        ids = {m["id"] for m in model_catalog.get_catalog(agent).get("models", [])}
    except Exception:
        ids = set()
    for mid in prefs:
        if mid in ids:
            return mid
    return None


def route(prompt: str) -> Route:
    text = prompt or ""
    # Anything pasted ahead of the user's own words (history, memory) must not skew routing.
    if "Current User Request:" in text:
        text = text.split("Current User Request:", 1)[1]
    text = text.strip()
    low = text.lower()
    n = len(text)

    if _looks_like_shell(text):
        return Route("bash", None, "light", "looks like a shell command")

    explicit = next((a for pat, a in EXPLICIT if re.search(pat, low)), None)

    is_code = bool(CODE.search(text))
    is_heavy = bool(HEAVY.search(text)) or n > 900
    is_ops = bool(OPS.search(text))
    is_long = bool(LONGCTX.search(text))

    # tier
    if GREETING.match(text) or (n < 90 and not (is_code or is_heavy or is_ops) and LIGHT_Q.match(text)):
        tier, why = "light", "short question"
    elif is_heavy and (is_code or is_ops or n > 400):
        tier, why = "heavy", "complex / multi-step task"
    elif is_heavy:
        tier, why = "heavy", "deep reasoning"
    else:
        tier, why = "standard", "everyday task"

    # agent
    if explicit:
        agent, why = explicit, f"you asked for {explicit}"
    elif is_long and not is_code and not is_ops:
        agent, why = "antigravity", f"long-context / multimodal ({why})"
    elif is_code and not is_ops:
        agent, why = "codex", f"coding task ({why})"
    elif is_ops:
        agent, why = "claude", f"VM / tools / personal data ({why})"
    elif tier == "light":
        agent, why = "antigravity", f"{why}, fast model"
    else:
        agent, why = "claude", f"general reasoning ({why})"

    return Route(agent, _pick_model(agent, tier), tier, why)
