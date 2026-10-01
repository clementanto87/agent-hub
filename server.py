import asyncio
import os
import io
import json
import uuid
import qrcode
import subprocess
from fastapi import FastAPI, WebSocket, Request, BackgroundTasks, UploadFile, File
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from services.agent_runner import stream_agent
from services.session_store import (
    init_db, list_sessions, get_session, create_session,
    add_message, update_session_title, delete_session, get_usage_metrics
)
from services.system_monitor import get_system_stats, kill_process
from services.terminal_session import TerminalManager
from services.tunnel_manager import start_tunnel, get_tunnel_url, stop_tunnel
from services.run_manager import run_manager, RunActive
from services.transcriber import transcribe_audio, warm_up
from services import tts, model_catalog
from services.memory_service import recall_memory, save_memory, get_memory_status

app = FastAPI(title="AgentHub Mobile Cloud Hub")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import re
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(UPLOADS_DIR, exist_ok=True)

terminal_mgr = TerminalManager()

@app.on_event("startup")
async def startup_event():
    init_db()
    asyncio.get_running_loop().run_in_executor(None, warm_up)
    asyncio.get_running_loop().run_in_executor(None, tts.warm_up)
    asyncio.get_running_loop().run_in_executor(None, model_catalog.all_catalogs)

# Serve static files and uploaded media
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")

def build_id() -> str:
    """Changes whenever any static file changes, so clients can detect and load new versions."""
    newest = 0
    for name in os.listdir(STATIC_DIR):
        path = os.path.join(STATIC_DIR, name)
        if os.path.isfile(path):
            newest = max(newest, int(os.path.getmtime(path)))
    return str(newest)

def render_with_build(filename: str, media_type: str) -> Response:
    with open(os.path.join(STATIC_DIR, filename), "r", encoding="utf-8") as f:
        body = f.read().replace("__BUILD__", build_id())
    return Response(content=body, media_type=media_type, headers={"Cache-Control": "no-cache"})

@app.api_route("/", methods=["GET", "HEAD"])
async def root():
    return render_with_build("index.html", "text/html")

@app.api_route("/manifest.json", methods=["GET", "HEAD"])
async def manifest():
    manifest_path = os.path.join(STATIC_DIR, "manifest.json")
    return FileResponse(manifest_path, media_type="application/manifest+json")

@app.api_route("/sw.js", methods=["GET", "HEAD"])
async def service_worker():
    return render_with_build("sw.js", "application/javascript")

@app.get("/api/version")
async def version():
    return {"build": build_id()}

@app.post("/api/chat")
async def chat_endpoint(request: Request):
    data = await request.json()
    prompt = data.get("prompt", "").strip()
    agent_name = data.get("agent", "antigravity")
    workspace = data.get("workspace", "/root/Documents/antigravity/clever-einstein")
    session_id = data.get("session_id")
    voice = bool(data.get("voice"))
    model = (data.get("model") or "").strip() or None

    if not prompt:
        return JSONResponse({"error": "Prompt is required"}, status_code=400)

    if model and not await asyncio.to_thread(model_catalog.is_valid, agent_name, model):
        return JSONResponse({"error": f"Model '{model}' is not available for {agent_name}"}, status_code=400)

    if session_id and run_manager.is_running(session_id):
        return JSONResponse({"error": "A reply is already running in this conversation"}, status_code=409)

    if not session_id:
        session_id = str(uuid.uuid4())
        title = prompt[:40] + ("..." if len(prompt) > 40 else "")
        create_session(session_id, title, agent_name, workspace)

    user_tokens = max(1, int(len(prompt) / 3.8))
    add_message(session_id, "user", prompt, agent_name, model, tokens=user_tokens)

    # The run belongs to the server: it keeps going if this connection drops.
    try:
        run = run_manager.start(session_id, agent_name, prompt, workspace, voice=voice, model=model)
    except RunActive:
        return JSONResponse({"error": "A reply is already running in this conversation"}, status_code=409)

    return StreamingResponse(run.follow(), media_type="text/plain", headers={"X-Session-ID": session_id})

@app.get("/api/models")
async def list_models(refresh: bool = False):
    """Live model lists for every agent (cached; ?refresh=1 asks the agents again)."""
    results = await asyncio.gather(*(asyncio.to_thread(model_catalog.get_catalog, a, refresh) for a in model_catalog.AGENTS))
    return {r["agent"]: r for r in results}

@app.get("/api/models/{agent}")
async def list_agent_models(agent: str, refresh: bool = False):
    return await asyncio.to_thread(model_catalog.get_catalog, agent, refresh)

@app.get("/api/runs")
async def list_runs():
    return run_manager.active()

@app.get("/api/runs/{session_id}")
async def run_status(session_id: str):
    run = run_manager.get(session_id)
    return run.info() if run else {"session_id": session_id, "status": "none", "running": False}

@app.get("/api/runs/{session_id}/stream")
async def run_stream(session_id: str):
    run = run_manager.get(session_id)
    if not run:
        return JSONResponse({"error": "No run for this conversation"}, status_code=404)
    return StreamingResponse(run.follow(), media_type="text/plain", headers={"X-Session-ID": session_id})

@app.post("/api/runs/{session_id}/stop")
async def run_stop(session_id: str):
    return {"stopped": run_manager.stop(session_id)}

@app.get("/api/sessions")
async def get_all_sessions():
    return list_sessions()

@app.post("/api/sessions")
async def create_new_session(request: Request):
    data = await request.json()
    session_id = str(uuid.uuid4())
    title = data.get("title", "New Conversation")
    agent = data.get("agent", "antigravity")
    workspace = data.get("workspace", "/root/Documents/antigravity/clever-einstein")
    create_session(session_id, title, agent, workspace)
    return {"id": session_id, "title": title, "agent": agent, "workspace": workspace}

@app.get("/api/sessions/{session_id}")
async def get_session_details(session_id: str):
    sess = get_session(session_id)
    if not sess:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    return sess

@app.delete("/api/sessions/{session_id}")
async def remove_session(session_id: str):
    delete_session(session_id)
    return {"success": True}

@app.get("/api/system")
async def system_stats():
    return get_system_stats()

@app.get("/api/usage")
async def usage_stats(five_hour_budget: int = 200000, weekly_budget: int = 1500000, agent: str = None):
    return get_usage_metrics(five_hour_budget=five_hour_budget, weekly_budget=weekly_budget, agent=agent)

@app.post("/api/process/kill")
async def kill_proc(request: Request):
    data = await request.json()
    pid = data.get("pid")
    if not pid:
        return JSONResponse({"error": "PID is required"}, status_code=400)
    res = kill_process(int(pid))
    return res

@app.get("/api/workspaces")
async def get_workspaces():
    candidates = [
        {"path": "/root/Documents/antigravity/clever-einstein", "name": "clever-einstein (Active Project)", "icon": "🚀"},
        {"path": "/root/workspace", "name": "Workspace", "icon": "🗂️"},
        {"path": "/root/Documents/Personal", "name": "Personal Records & Documents", "icon": "📑"},
        {"path": "/root", "name": "Root Home (/root)", "icon": "🏠"},
        {"path": "/root/.gemini", "name": "Gemini / Antigravity Config", "icon": "⚙️"},
    ]
    valid = [w for w in candidates if os.path.isdir(w["path"])]
    return valid

@app.get("/api/git/changes")
async def git_changes(workspace: str = None):
    """Returns uncommitted git status and changed files with line additions/deletions."""
    ws = workspace if workspace and os.path.isdir(workspace) else "/root/Documents/antigravity/clever-einstein"
    try:
        chk = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=ws, capture_output=True, text=True)
        if chk.returncode != 0:
            return {"is_git": False, "files": [], "total_adds": 0, "total_dels": 0, "summary": "Not a git repository"}

        st = subprocess.run(["git", "status", "--porcelain"], cwd=ws, capture_output=True, text=True, timeout=5)
        diff_st = subprocess.run(["git", "diff", "--numstat", "HEAD"], cwd=ws, capture_output=True, text=True, timeout=5)
        
        numstats = {}
        if diff_st.returncode == 0:
            for line in diff_st.stdout.strip().splitlines():
                parts = line.split("\t")
                if len(parts) >= 3:
                    adds = int(parts[0]) if parts[0].isdigit() else 0
                    dels = int(parts[1]) if parts[1].isdigit() else 0
                    numstats[parts[2]] = (adds, dels)

        files = []
        total_adds = 0
        total_dels = 0

        for line in st.stdout.strip().splitlines():
            if not line:
                continue
            code = line[:2].strip()
            file_path = line[3:].strip()
            adds, dels = numstats.get(file_path, (0, 0))
            total_adds += adds
            total_dels += dels
            files.append({
                "path": file_path,
                "status": code,
                "adds": adds,
                "dels": dels,
                "name": os.path.basename(file_path)
            })

        return {
            "is_git": True,
            "workspace": ws,
            "files": files,
            "total_adds": total_adds,
            "total_dels": total_dels,
            "summary": f"{len(files)} files changed (+{total_adds} -{total_dels})" if files else "Working tree clean"
        }
    except Exception as e:
        return {"is_git": False, "error": str(e), "files": []}

@app.get("/api/git/diff")
async def git_diff(workspace: str = None, file: str = None):
    """Returns unified git diff with additions and deletions."""
    ws = workspace if workspace and os.path.isdir(workspace) else "/root/Documents/antigravity/clever-einstein"
    try:
        cmd = ["git", "diff", "HEAD"]
        if file:
            cmd += ["--", file]
        res = subprocess.run(cmd, cwd=ws, capture_output=True, text=True, timeout=5)
        return {
            "diff": res.stdout,
            "file": file,
            "workspace": ws,
            "empty": not bool(res.stdout.strip())
        }
    except Exception as e:
        return {"error": str(e), "diff": ""}

def format_file_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.1f} GB"

@app.get("/api/browse")
async def browse_dir(path: str = "/root", show_hidden: bool = False):
    """List sub-folders and files of `path` so the app can browse anywhere on the VM."""
    raw_path = (path or "/root").strip().strip('"').strip("'")
    target = os.path.realpath(os.path.expanduser(raw_path or "/"))
    
    # If the target path doesn't exist or isn't a directory, walk up until we find an existing directory
    while target and target != "/" and not os.path.isdir(target):
        target = os.path.dirname(target)
    if not os.path.isdir(target):
        target = "/root" if os.path.isdir("/root") else "/"

    try:
        def _list():
            dirs = []
            files = []
            try:
                with os.scandir(target) as it:
                    for entry in it:
                        if not show_hidden and entry.name.startswith("."):
                            continue
                        try:
                            if entry.is_dir(follow_symlinks=True):
                                dirs.append({
                                    "name": entry.name,
                                    "path": os.path.join(target, entry.name),
                                    "is_dir": True
                                })
                            elif entry.is_file(follow_symlinks=True):
                                stat = entry.stat(follow_symlinks=True)
                                ext = os.path.splitext(entry.name)[1].lstrip(".").lower()
                                files.append({
                                    "name": entry.name,
                                    "path": os.path.join(target, entry.name),
                                    "size": stat.st_size,
                                    "size_fmt": format_file_size(stat.st_size),
                                    "ext": ext,
                                    "modified": int(stat.st_mtime),
                                    "is_dir": False
                                })
                        except OSError:
                            continue
            except (PermissionError, OSError):
                pass
            dirs.sort(key=lambda d: d["name"].lower())
            files.sort(key=lambda f: f["name"].lower())
            return dirs, files

        dirs, files = await asyncio.to_thread(_list)
        parent = os.path.dirname(target) if target != "/" else None
        return {
            "path": target,
            "parent": parent,
            "name": os.path.basename(target) or "/",
            "writable": os.access(target, os.W_OK),
            "dirs": dirs,
            "files": files,
        }
    except Exception as e:
        return {
            "path": target,
            "parent": os.path.dirname(target) if target != "/" else None,
            "name": os.path.basename(target) or "/",
            "writable": False,
            "dirs": [],
            "files": [],
            "error": str(e)
        }

@app.get("/api/file/view")
async def view_file_content(path: str):
    """Read and return content / info of a specific file."""
    raw_path = (path or "").strip().strip('"').strip("'")
    target = os.path.realpath(os.path.expanduser(raw_path))
    if not os.path.exists(target) or not os.path.isfile(target):
        return JSONResponse({"error": "File not found"}, status_code=404)

    try:
        stat = os.stat(target)
        ext = os.path.splitext(target)[1].lstrip(".").lower()
        size_fmt = format_file_size(stat.st_size)
        text_exts = {
            "txt", "md", "py", "json", "yaml", "yml", "sh", "bash", "js", "ts",
            "html", "css", "toml", "ini", "conf", "env", "log", "sql", "csv",
            "xml", "svg", "jsx", "tsx", "c", "cpp", "h", "rs", "go", "java"
        }
        
        is_text = ext in text_exts or stat.st_size < 1024 * 512
        content = None
        if is_text:
            try:
                with open(target, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read(500000)  # up to 500 KB preview
            except Exception:
                is_text = False

        return {
            "path": target,
            "name": os.path.basename(target),
            "size": stat.st_size,
            "size_fmt": size_fmt,
            "ext": ext,
            "is_text": is_text,
            "content": content,
            "writable": os.access(target, os.W_OK)
        }
    except PermissionError:
        return JSONResponse({"error": "Permission denied"}, status_code=403)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.api_route("/api/qrcode", methods=["GET", "HEAD"])
async def get_qr_code(url: str = None):
    target_url = url if url else get_tunnel_url() or "http://49.13.196.104:8080"
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=10,
        border=3,
    )
    qr.add_data(target_url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#0f172a", back_color="#ffffff")
    
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Response(content=buf.getvalue(), media_type="image/png")

@app.post("/api/upload")
async def upload_files_endpoint(files: list[UploadFile] = File(...)):
    """Accept media and file uploads from phone or external devices, saving to /uploads."""
    uploaded = []
    for file in files:
        if not file.filename:
            continue
        clean_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', os.path.basename(file.filename))
        unique_prefix = datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
        saved_name = f"{unique_prefix}_{clean_name}"
        saved_path = os.path.join(UPLOADS_DIR, saved_name)
        
        content = await file.read()
        with open(saved_path, "wb") as f:
            f.write(content)
        
        size = len(content)
        ext = os.path.splitext(clean_name)[1].lstrip(".").lower()
        is_image = ext in {"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"}
        is_audio = ext in {"mp3", "wav", "ogg", "m4a", "aac", "webm"}
        is_video = ext in {"mp4", "mov", "avi", "mkv", "webm"}
        
        uploaded.append({
            "name": file.filename,
            "saved_name": saved_name,
            "path": saved_path,
            "size": size,
            "size_fmt": format_file_size(size),
            "ext": ext,
            "is_image": is_image,
            "is_audio": is_audio,
            "is_video": is_video,
            "url": f"/uploads/{saved_name}"
        })
    return {"files": uploaded}

@app.post("/api/upload-url")
async def upload_from_url_endpoint(request: Request):
    """Download media/files from an external URL into VM uploads."""
    data = await request.json()
    url = (data.get("url") or "").strip()
    if not url or not (url.startswith("http://") or url.startswith("https://")):
        return JSONResponse({"error": "Invalid URL provided"}, status_code=400)
    
    try:
        import urllib.parse
        import urllib.request
        
        parsed = urllib.parse.urlparse(url)
        url_filename = os.path.basename(parsed.path) or "downloaded_media"
        clean_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', url_filename)
        if "." not in clean_name:
            clean_name += ".bin"
            
        unique_prefix = datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
        saved_name = f"{unique_prefix}_{clean_name}"
        saved_path = os.path.join(UPLOADS_DIR, saved_name)
        
        def _fetch():
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AgentHub/2.0'})
            with urllib.request.urlopen(req, timeout=20) as resp, open(saved_path, 'wb') as out_f:
                out_f.write(resp.read(50 * 1024 * 1024)) # up to 50 MB
        
        await asyncio.to_thread(_fetch)
        
        stat = os.stat(saved_path)
        size = stat.st_size
        ext = os.path.splitext(clean_name)[1].lstrip(".").lower()
        is_image = ext in {"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"}
        
        return {
            "file": {
                "name": clean_name,
                "saved_name": saved_name,
                "path": saved_path,
                "size": size,
                "size_fmt": format_file_size(size),
                "ext": ext,
                "is_image": is_image,
                "url": f"/uploads/{saved_name}",
                "source_url": url
            }
        }
    except Exception as e:
        return JSONResponse({"error": f"Could not download from URL: {str(e)}"}, status_code=400)

@app.post("/api/transcribe")
async def transcribe_audio_endpoint(request: Request, file: UploadFile = File(None), agent: str = None):
    try:
        if file:
            content = await file.read()
            mime_type = file.content_type or "audio/webm"
        else:
            content = await request.body()
            mime_type = request.headers.get("content-type", "audio/webm")
        
        if not content:
            return JSONResponse({"error": "No audio content received"}, status_code=400)

        chosen_agent = agent or request.query_params.get("agent") or "antigravity"
        text = await asyncio.to_thread(transcribe_audio, content, mime_type, chosen_agent)
        return {"transcript": text, "agent": chosen_agent}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/api/tts")
async def tts_endpoint(request: Request):
    data = await request.json()
    text = (data.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "Text is required"}, status_code=400)
    # Pick the voice from the agent (so each provider sounds distinct), or an explicit voice name.
    voice = (data.get("voice") or "").strip() or tts.voice_for(data.get("agent"))
    try:
        audio = await asyncio.to_thread(tts.synthesize, text, voice)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return Response(content=audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})

@app.post("/api/tunnel/start")
async def start_tunnel_endpoint(background_tasks: BackgroundTasks):
    url = await asyncio.to_thread(start_tunnel, 8080)
    return {"url": url}

@app.get("/api/tunnel/status")
async def get_tunnel_status_endpoint():
    url = get_tunnel_url()
    return {"url": url, "active": bool(url)}

@app.post("/api/tunnel/stop")
async def stop_tunnel_endpoint():
    stop_tunnel()
    return {"success": True}

@app.get("/api/memory/status")
async def memory_status_endpoint():
    status = await asyncio.to_thread(get_memory_status)
    return status

@app.get("/api/memory/recall")
async def memory_recall_endpoint(q: str, limit: int = 5):
    memories = await asyncio.to_thread(recall_memory, q, limit)
    return {"query": q, "memories": memories}

@app.post("/api/memory/save")
async def memory_save_endpoint(request: Request):
    data = await request.json()
    content = data.get("content", "").strip()
    metadata = data.get("metadata", {})
    if not content:
        return JSONResponse({"error": "Content required"}, status_code=400)
    res = await asyncio.to_thread(save_memory, content, metadata)
    return res

from services import skills_mcp_service

@app.get("/api/skills")
async def list_skills_endpoint():
    skills = await asyncio.to_thread(skills_mcp_service.list_all_skills)
    return {"skills": skills}

@app.get("/api/skills/{name}")
async def get_skill_endpoint(name: str):
    skill = await asyncio.to_thread(skills_mcp_service.get_skill_details, name)
    if not skill:
        return JSONResponse({"error": "Skill not found"}, status_code=404)
    return skill

@app.post("/api/skills")
async def save_skill_endpoint(request: Request):
    data = await request.json()
    name = (data.get("name") or "").strip()
    desc = (data.get("description") or "").strip()
    content = data.get("content", "").strip()
    agent_scope = data.get("agent_scope", "global")
    if not name or not content:
        return JSONResponse({"error": "Name and content are required"}, status_code=400)
    res = await asyncio.to_thread(skills_mcp_service.save_skill, name, desc, content, agent_scope)
    return res

@app.delete("/api/skills/{name}")
async def delete_skill_endpoint(name: str):
    ok = await asyncio.to_thread(skills_mcp_service.delete_skill, name)
    return {"success": ok}

@app.post("/api/skills/generate")
async def generate_skill_endpoint(request: Request):
    data = await request.json()
    prompt = (data.get("prompt") or "").strip()
    agent = data.get("agent", "antigravity")
    if not prompt:
        return JSONResponse({"error": "Prompt is required"}, status_code=400)
    res = await asyncio.to_thread(skills_mcp_service.generate_skill_ai, prompt, agent)
    return res

@app.get("/api/mcp")
async def list_mcp_endpoint():
    servers = await asyncio.to_thread(skills_mcp_service.list_all_mcp_servers)
    return {"servers": servers}

@app.post("/api/mcp")
async def save_mcp_endpoint(request: Request):
    data = await request.json()
    name = (data.get("name") or "").strip()
    stype = data.get("type", "stdio")
    command = (data.get("command") or "").strip()
    args = data.get("args", [])
    env = data.get("env", {})
    url = data.get("url")
    agents = data.get("agents", ["claude", "antigravity"])
    if not name or not (command or url):
        return JSONResponse({"error": "Name and command/url are required"}, status_code=400)
    res = await asyncio.to_thread(skills_mcp_service.save_mcp_server, name, stype, command, args, env, url, agents)
    return res

@app.delete("/api/mcp/{name}")
async def delete_mcp_endpoint(name: str):
    ok = await asyncio.to_thread(skills_mcp_service.delete_mcp_server, name)
    return {"success": ok}

@app.post("/api/mcp/generate")
async def generate_mcp_endpoint(request: Request):
    data = await request.json()
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return JSONResponse({"error": "Prompt is required"}, status_code=400)
    res = await asyncio.to_thread(skills_mcp_service.generate_mcp_ai, prompt)
    return res

@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket, cwd: str = "/root"):
    await terminal_mgr.handle_websocket(websocket, cwd)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
