import os
import subprocess
import time

PERMANENT_URL = "https://49-13-196-104.sslip.io"
URL_FILE = "/root/agent-hub/data/tunnel_url.txt"

def get_tunnel_url() -> str:
    # 1. Primary permanent fixed HTTPS address
    if PERMANENT_URL:
        return PERMANENT_URL
    if os.path.exists(URL_FILE):
        try:
            with open(URL_FILE, "r") as f:
                url = f.read().strip()
                if url.startswith("https://"):
                    return url
        except Exception:
            pass
    return ""

def start_tunnel(port: int = 8080) -> str:
    subprocess.run(["systemctl", "restart", "cloudflared-tunnel.service"])
    for _ in range(15):
        time.sleep(1)
        url = get_tunnel_url()
        if url:
            return url
    return ""

def stop_tunnel():
    subprocess.run(["systemctl", "stop", "cloudflared-tunnel.service"])
    if os.path.exists(URL_FILE):
        os.remove(URL_FILE)
