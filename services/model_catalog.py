"""Live model catalogs for each agent.

Nothing here is hardcoded: each agent is asked what it supports right now, so models that are
added or retired show up (or disappear) on the next refresh.

  antigravity  `agy models`                 (Antigravity account)
  codex        `codex debug models`         (Codex's own catalog; hidden models filtered out)
  claude       Anthropic Models API          (using Claude Code's own sign-in)

Results are cached in memory and on disk. If a live lookup fails, the last good list is served.
"""
import json
import os
import re
import subprocess
import threading
import time
import tomllib
import urllib.request
from typing import Dict, List, Optional

CACHE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "models_cache.json")
TTL_SEC = 6 * 3600
AGENTS = ("antigravity", "claude", "codex")
MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,120}$")

_lock = threading.Lock()
_cache: Dict[str, dict] = {}


def _load_disk() -> None:
    global _cache
    if not _cache and os.path.exists(CACHE_PATH):
        try:
            with open(CACHE_PATH) as f:
                _cache = json.load(f)
        except Exception:
            _cache = {}


def _save_disk() -> None:
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    tmp = CACHE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(_cache, f)
    os.replace(tmp, CACHE_PATH)


# ── per-agent fetchers ─────────────────────────────────────────────────────

def _fetch_antigravity() -> dict:
    out = subprocess.run(["/usr/local/bin/agy", "models"], capture_output=True, text=True, timeout=45).stdout
    models = []
    for line in out.splitlines():
        if "\t" not in line:
            continue                      # skips "Fetching available models..."
        mid, name = line.split("\t", 1)
        if MODEL_ID_RE.match(mid.strip()):
            models.append({"id": mid.strip(), "name": name.strip()})
    return {"models": models, "default": None}


def _fetch_codex() -> dict:
    out = subprocess.run(["/usr/local/bin/codex", "debug", "models"], capture_output=True, text=True, timeout=45).stdout
    data = json.loads(out)
    items = [m for m in data.get("models", []) if m.get("visibility") == "list"]
    items.sort(key=lambda m: m.get("priority", 999))
    models = [{"id": m["slug"], "name": m.get("display_name") or m["slug"], "description": m.get("description") or ""} for m in items]
    default = None
    try:
        with open(os.path.expanduser("~/.codex/config.toml"), "rb") as f:
            default = tomllib.load(f).get("model")
    except Exception:
        pass
    return {"models": models, "default": default}


def _fetch_claude() -> dict:
    with open(os.path.expanduser("~/.claude/.credentials.json")) as f:
        token = json.load(f)["claudeAiOauth"]["accessToken"]
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/models?limit=100",
        headers={"Authorization": f"Bearer {token}", "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    models = [{"id": m["id"], "name": m.get("display_name") or m["id"]} for m in data.get("data", [])]
    default = None
    try:
        with open(os.path.expanduser("~/.claude/settings.json")) as f:
            default = json.load(f).get("model")
    except Exception:
        pass
    return {"models": models, "default": default}


AGENTS = ("antigravity", "claude", "codex")
_FETCHERS = {"antigravity": _fetch_antigravity, "codex": _fetch_codex, "claude": _fetch_claude}


# ── public API ─────────────────────────────────────────────────────────────

def get_catalog(agent: str, refresh: bool = False) -> dict:
    """Return {agent, models, default, source, fetched_at, error?} for one agent."""
    if agent not in _FETCHERS:
        return {"agent": agent, "models": [], "default": None, "source": "none", "fetched_at": None}
    with _lock:
        _load_disk()
        cached = _cache.get(agent)
    fresh = cached and time.time() - cached.get("fetched_at", 0) < TTL_SEC
    if fresh and not refresh:
        return {**cached, "source": "cache"}

    try:
        result = _FETCHERS[agent]()
        if not result["models"]:
            raise RuntimeError("agent returned no models")
        entry = {"agent": agent, **result, "fetched_at": time.time()}
        with _lock:
            _cache[agent] = entry
            _save_disk()
        return {**entry, "source": "live"}
    except Exception as e:
        if cached:                                   # keep working with the last good list
            return {**cached, "source": "cache", "error": f"Live refresh failed: {e}"}
        return {"agent": agent, "models": [], "default": None, "source": "none", "fetched_at": None, "error": str(e)}


def is_valid(agent: str, model: Optional[str]) -> bool:
    """A model is accepted if it's well-formed and in the agent's current catalog (when one is known)."""
    if not model:
        return True
    if not MODEL_ID_RE.match(model):
        return False
    with _lock:                      # cached list only — never block a chat on a live lookup
        _load_disk()
        ids = {m["id"] for m in _cache.get(agent, {}).get("models", [])}
    return not ids or model in ids


def all_catalogs(refresh: bool = False) -> List[dict]:
    return [get_catalog(a, refresh) for a in AGENTS]
