import os
import json
import re
import yaml
from typing import List, Dict, Any, Optional
from google import genai
from google.genai import types

API_KEY = os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY', '')

# Standard Locations
ANTIGRAVITY_CUSTOM_SKILLS = "/root/.gemini/config/skills"
ANTIGRAVITY_BUILTIN_SKILLS = "/root/.gemini/antigravity-cli/builtin/skills"
CLAUDE_SKILLS = "/root/.claude/skills"
CLAUDE_CONFIG = "/root/.claude.json"
CLAUDE_SETTINGS = "/root/.claude/settings.json"
ANTIGRAVITY_MCP_DIR = "/root/.gemini/antigravity-cli/mcp"

os.makedirs(ANTIGRAVITY_CUSTOM_SKILLS, exist_ok=True)
os.makedirs(CLAUDE_SKILLS, exist_ok=True)
os.makedirs(ANTIGRAVITY_MCP_DIR, exist_ok=True)

def parse_skill_md(file_path: str) -> Dict[str, Any]:
    if not os.path.isfile(file_path):
        return {}
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    name = os.path.basename(os.path.dirname(file_path))
    description = ""
    body = content

    # Check for YAML frontmatter
    fm_match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
    if fm_match:
        try:
            fm = yaml.safe_load(fm_match.group(1))
            if isinstance(fm, dict):
                name = fm.get("name", name)
                description = fm.get("description", "")
            body = fm_match.group(2)
        except Exception:
            pass

    return {
        "name": name,
        "description": description or f"Skill: {name}",
        "path": file_path,
        "dir": os.path.dirname(file_path),
        "content": content,
        "body": body.strip()
    }

def list_all_skills() -> List[Dict[str, Any]]:
    skills = []
    seen_names = set()

    # 1. Antigravity Custom Skills (User created)
    if os.path.isdir(ANTIGRAVITY_CUSTOM_SKILLS):
        for entry in os.scandir(ANTIGRAVITY_CUSTOM_SKILLS):
            if entry.is_dir():
                skill_md = os.path.join(entry.path, "SKILL.md")
                if os.path.exists(skill_md):
                    info = parse_skill_md(skill_md)
                    info["agent_scope"] = "global"
                    info["is_builtin"] = False
                    info["category"] = "Custom Skill"
                    skills.append(info)
                    seen_names.add(info["name"])

    # 2. Claude Code Skills
    if os.path.isdir(CLAUDE_SKILLS):
        for entry in os.scandir(CLAUDE_SKILLS):
            if entry.is_dir():
                skill_md = os.path.join(entry.path, "SKILL.md")
                if os.path.exists(skill_md) and entry.name not in seen_names:
                    info = parse_skill_md(skill_md)
                    info["agent_scope"] = "claude"
                    info["is_builtin"] = False
                    info["category"] = "Claude Skill"
                    skills.append(info)
                    seen_names.add(info["name"])

    # 3. Antigravity Built-in Skills
    if os.path.isdir(ANTIGRAVITY_BUILTIN_SKILLS):
        for entry in os.scandir(ANTIGRAVITY_BUILTIN_SKILLS):
            if entry.is_dir():
                skill_md = os.path.join(entry.path, "SKILL.md")
                if os.path.exists(skill_md) and entry.name not in seen_names:
                    info = parse_skill_md(skill_md)
                    info["agent_scope"] = "antigravity"
                    info["is_builtin"] = True
                    info["category"] = "Built-in"
                    skills.append(info)
                    seen_names.add(info["name"])

    return sorted(skills, key=lambda s: (s["is_builtin"], s["name"]))

def get_skill_details(name: str) -> Optional[Dict[str, Any]]:
    skills = list_all_skills()
    for s in skills:
        if s["name"] == name:
            return s
    return None

def save_skill(name: str, description: str, content: str, agent_scope: str = "global") -> Dict[str, Any]:
    clean_name = re.sub(r'[^a-zA-Z0-9_-]', '-', name.strip().lower()).strip('-')
    if not clean_name:
        raise ValueError("Invalid skill name")

    if agent_scope == "claude":
        target_dir = os.path.join(CLAUDE_SKILLS, clean_name)
    else:
        target_dir = os.path.join(ANTIGRAVITY_CUSTOM_SKILLS, clean_name)

    os.makedirs(target_dir, exist_ok=True)
    skill_file = os.path.join(target_dir, "SKILL.md")

    # Format frontmatter if not present
    if not content.strip().startswith("---"):
        full_content = f"---\nname: {clean_name}\ndescription: {description.strip()}\n---\n\n{content.strip()}\n"
    else:
        full_content = content.strip() + "\n"

    with open(skill_file, "w", encoding="utf-8") as f:
        f.write(full_content)

    return parse_skill_md(skill_file)

def delete_skill(name: str) -> bool:
    import shutil
    skills = list_all_skills()
    for s in skills:
        if s["name"] == name and not s["is_builtin"]:
            if os.path.isdir(s["dir"]):
                shutil.rmtree(s["dir"], ignore_errors=True)
                return True
    return False

def generate_skill_ai(prompt: str, agent: str = "antigravity") -> Dict[str, str]:
    client = genai.Client(api_key=API_KEY)
    sys_instruction = (
        "You are an expert AI agent customizer creating an autonomous Skill definition. "
        "Output ONLY a valid SKILL.md file with YAML frontmatter at the top: \n"
        "---\nname: <kebab-case-name>\ndescription: <Clear one-line trigger summary for when agents should activate this skill>\n---\n\n"
        "Follow with clear, step-by-step markdown instructions, tools/CLIs to use, rules, and example workflows."
    )
    res = client.models.generate_content(
        model='gemini-3.1-flash-lite',
        contents=f"Create a production-ready agent skill based on this requirement: {prompt}",
        config=types.GenerateContentConfig(
            system_instruction=sys_instruction,
            temperature=0.3
        )
    )
    raw = res.text or ""
    # Extract name and description
    name_match = re.search(r"name:\s*([a-zA-Z0-9_-]+)", raw)
    name = name_match.group(1) if name_match else "custom-skill"
    desc_match = re.search(r"description:\s*(.+)", raw)
    desc = desc_match.group(1).strip() if desc_match else f"Skill for {prompt[:30]}"

    return {
        "name": name,
        "description": desc,
        "content": raw
    }

# ════════════════════════════════════════════════════════════
# MCP Server Management
# ════════════════════════════════════════════════════════════

def list_all_mcp_servers() -> List[Dict[str, Any]]:
    servers = []
    seen = set()

    # 1. Claude config MCPs
    if os.path.isfile(CLAUDE_CONFIG):
        try:
            with open(CLAUDE_CONFIG, "r", encoding="utf-8") as f:
                data = json.load(f)
                mcp_dict = data.get("mcpServers", {})
                for name, cfg in mcp_dict.items():
                    servers.append({
                        "name": name,
                        "type": cfg.get("type", "stdio"),
                        "command": cfg.get("command", ""),
                        "args": cfg.get("args", []),
                        "env": cfg.get("env", {}),
                        "url": cfg.get("url", ""),
                        "agents": ["claude", "antigravity"],
                        "status": "active",
                        "source": "claude.json"
                    })
                    seen.add(name)
        except Exception:
            pass

    # 2. Antigravity MCP directory
    if os.path.isdir(ANTIGRAVITY_MCP_DIR):
        for entry in os.scandir(ANTIGRAVITY_MCP_DIR):
            if entry.is_dir() and entry.name not in seen:
                tools = [f[:-5] for f in os.listdir(entry.path) if f.endswith(".json")]
                servers.append({
                    "name": entry.name,
                    "type": "stdio",
                    "command": f"{entry.path}",
                    "args": [],
                    "env": {},
                    "agents": ["antigravity"],
                    "status": "active",
                    "tools": tools,
                    "source": "antigravity-mcp"
                })
                seen.add(entry.name)

    return servers

def save_mcp_server(name: str, server_type: str, command: str, args: List[str] = None, env: Dict[str, str] = None, url: str = None, agents: List[str] = None) -> Dict[str, Any]:
    clean_name = re.sub(r'[^a-zA-Z0-9_-]', '-', name.strip().lower()).strip('-')
    if not clean_name:
        raise ValueError("Invalid MCP server name")

    args = args or []
    env = env or {}
    agents = agents or ["claude", "antigravity"]

    # 1. Update Claude configuration
    claude_data = {}
    if os.path.isfile(CLAUDE_CONFIG):
        try:
            with open(CLAUDE_CONFIG, "r", encoding="utf-8") as f:
                claude_data = json.load(f)
        except Exception:
            claude_data = {}

    if "mcpServers" not in claude_data:
        claude_data["mcpServers"] = {}

    server_entry = {
        "type": server_type,
    }
    if server_type == "stdio":
        server_entry["command"] = command
        server_entry["args"] = args
        server_entry["env"] = env
    else:
        server_entry["url"] = url or command

    claude_data["mcpServers"][clean_name] = server_entry

    with open(CLAUDE_CONFIG, "w", encoding="utf-8") as f:
        json.dump(claude_data, f, indent=2)

    # 2. Allow MCP tools in Claude settings so no manual approval prompts appear
    if os.path.isfile(CLAUDE_SETTINGS):
        try:
            with open(CLAUDE_SETTINGS, "r", encoding="utf-8") as f:
                settings_data = json.load(f)
            perms = settings_data.get("permissions", {}).get("allow", [])
            wildcard = f"mcp__{clean_name}__*"
            if wildcard not in perms:
                perms.append(wildcard)
                settings_data.setdefault("permissions", {})["allow"] = perms
                with open(CLAUDE_SETTINGS, "w", encoding="utf-8") as f:
                    json.dump(settings_data, f, indent=2)
        except Exception:
            pass

    return {
        "name": clean_name,
        "type": server_type,
        "command": command,
        "args": args,
        "env": env,
        "agents": agents,
        "status": "configured"
    }

def delete_mcp_server(name: str) -> bool:
    removed = False
    if os.path.isfile(CLAUDE_CONFIG):
        try:
            with open(CLAUDE_CONFIG, "r", encoding="utf-8") as f:
                data = json.load(f)
            if "mcpServers" in data and name in data["mcpServers"]:
                del data["mcpServers"][name]
                with open(CLAUDE_CONFIG, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)
                removed = True
        except Exception:
            pass
    return removed

def generate_mcp_ai(prompt: str) -> Dict[str, Any]:
    client = genai.Client(api_key=API_KEY)
    sys_instruction = (
        "You are an expert in Model Context Protocol (MCP) server configurations. "
        "Given a user request (e.g. Postgres, SQLite, GitHub, Filesystem, Google Drive, Docker), output ONLY valid JSON matching this schema:\n"
        "{\n"
        '  "name": "server-name",\n'
        '  "type": "stdio",\n'
        '  "command": "npx" or "python3" or path,\n'
        '  "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://..."],\n'
        '  "env": {"KEY": "VALUE"},\n'
        '  "description": "Short summary of what this MCP server provides"\n'
        "}"
    )
    res = client.models.generate_content(
        model='gemini-3.1-flash-lite',
        contents=f"Generate an MCP server configuration for: {prompt}",
        config=types.GenerateContentConfig(
            system_instruction=sys_instruction,
            response_mime_type="application/json",
            temperature=0.2
        )
    )
    try:
        return json.loads(res.text or "{}")
    except Exception:
        return {
            "name": "custom-mcp",
            "type": "stdio",
            "command": "npx",
            "args": ["-y", prompt],
            "env": {},
            "description": f"MCP server for {prompt}"
        }
