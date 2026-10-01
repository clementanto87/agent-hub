import sys
import os
import subprocess
import json

MEMORY_DIR = "/root/workspace/pet/infra/memory"

def recall_memory(query: str, limit: int = 5) -> list:
    """Recalls relevant memories from pet-memory via the local python environment."""
    try:
        cmd = [
            f"{MEMORY_DIR}/.venv/bin/python",
            "-c",
            f"""
import sys, json
sys.path.insert(0, '{MEMORY_DIR}')
import server
res = server.memory_recall({json.dumps(query)}, limit={limit})
print(json.dumps(res.get('memories', [])))
"""
        ]
        out = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL)
        return json.loads(out)
    except Exception as e:
        print(f"Memory recall error: {e}")
        return []

def save_memory(content: str, metadata: dict = None) -> dict:
    """Saves a durable memory to pet-memory."""
    try:
        cmd = [
            f"{MEMORY_DIR}/.venv/bin/python",
            "-c",
            f"""
import sys, json
sys.path.insert(0, '{MEMORY_DIR}')
import server
res = server.memory_save({json.dumps(content)}, metadata={json.dumps(metadata or {})})
print(json.dumps(res))
"""
        ]
        out = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL)
        return json.loads(out)
    except Exception as e:
        print(f"Memory save error: {e}")
        return {"error": str(e)}

def get_memory_status() -> dict:
    """Gets total memory count and status."""
    try:
        cmd = [
            f"{MEMORY_DIR}/.venv/bin/python",
            "-c",
            f"""
import sys, json
sys.path.insert(0, '{MEMORY_DIR}')
import server
res = server.memory_status()
print(json.dumps(res))
"""
        ]
        out = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL)
        return json.loads(out)
    except Exception as e:
        return {"error": str(e)}
