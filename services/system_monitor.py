import psutil
import time
import os
import subprocess

def get_system_stats():
    cpu_percent = psutil.cpu_percent(interval=0.2)
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    boot_time = psutil.boot_time()
    uptime_sec = time.time() - boot_time

    # Find running agent processes
    agent_procs = []
    for proc in psutil.process_iter(['pid', 'name', 'cmdline', 'create_time', 'cpu_percent', 'memory_percent']):
        try:
            cmdline = proc.info.get('cmdline') or []
            cmd_str = " ".join(cmdline)
            name = proc.info.get('name') or ""
            
            is_agent = False
            agent_type = ""
            if "agy" in name or "/usr/local/bin/agy" in cmd_str:
                is_agent = True
                agent_type = "Antigravity (agy)"
            elif "claude" in name or "/usr/bin/claude" in cmd_str:
                is_agent = True
                agent_type = "Claude Code"
            elif "codex" in name or "/usr/local/bin/codex" in cmd_str:
                is_agent = True
                agent_type = "OpenAI Codex"
            elif "muse" in name or "/usr/local/bin/muse" in cmd_str:
                is_agent = True
                agent_type = "Meta Muse"
            elif "web_agent.py" in cmd_str or "server.py" in cmd_str:
                is_agent = True
                agent_type = "AgentHub Server"

            if is_agent:
                agent_procs.append({
                    "pid": proc.info['pid'],
                    "name": name,
                    "agent_type": agent_type,
                    "cmd": cmd_str[:120],
                    "cpu": round(proc.info.get('cpu_percent') or 0.0, 1),
                    "memory": round(proc.info.get('memory_percent') or 0.0, 1),
                    "running_sec": int(time.time() - proc.info.get('create_time', time.time()))
                })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

    return {
        "cpu_percent": cpu_percent,
        "memory_total_gb": round(memory.total / (1024**3), 2),
        "memory_used_gb": round(memory.used / (1024**3), 2),
        "memory_percent": memory.percent,
        "disk_total_gb": round(disk.total / (1024**3), 2),
        "disk_free_gb": round(disk.free / (1024**3), 2),
        "disk_percent": disk.percent,
        "uptime_formatted": format_uptime(uptime_sec),
        "agent_processes": agent_procs
    }

def format_uptime(seconds: float) -> str:
    days = int(seconds // 86400)
    hours = int((seconds % 86400) // 3600)
    minutes = int((seconds % 3600) // 60)
    if days > 0:
        return f"{days}d {hours}h {minutes}m"
    elif hours > 0:
        return f"{hours}h {minutes}m"
    else:
        return f"{minutes}m"

def kill_process(pid: int) -> dict:
    try:
        proc = psutil.Process(pid)
        proc.terminate()
        return {"success": True, "message": f"Process {pid} terminated"}
    except Exception as e:
        return {"success": False, "error": str(e)}
