import os
import subprocess
import time

# The single canonical, stable HTTPS address for AgentHub.
# Caddy terminates TLS (Let's Encrypt) on :443 for this host and reverse-proxies
# to the app on 127.0.0.1:8080.  sslip.io resolves the hostname straight back to
# this VM's public IP, so the address never changes when processes restart.
#
# IMPORTANT: every device (phone, laptop, tablet) must open THIS exact URL.
# localStorage / sessionStorage are scoped per origin, so mixing
# https://49-13-196-104.sslip.io with http://49.13.196.104:8080 (or a rotating
# *.trycloudflare.com link) creates two isolated apps that do not share drafts,
# the open conversation, or the selected agent.
PERMANENT_URL = os.environ.get("AGENTHUB_PUBLIC_URL", "https://49-13-196-104.sslip.io")

URL_FILE = "/root/agent-hub/data/tunnel_url.txt"
TUNNEL_SERVICE = "cloudflared-tunnel.service"


def get_tunnel_url() -> str:
    # The permanent fixed HTTPS address is always the canonical answer.
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
    # The permanent address is served by Caddy; only fall back to the
    # ephemeral cloudflared tunnel if the fixed address is unavailable.
    if PERMANENT_URL:
        return PERMANENT_URL
    subprocess.run(["systemctl", "restart", TUNNEL_SERVICE])
    for _ in range(15):
        time.sleep(1)
        url = get_tunnel_url()
        if url:
            return url
    return ""


def stop_tunnel():
    subprocess.run(["systemctl", "stop", TUNNEL_SERVICE])
    if os.path.exists(URL_FILE):
        os.remove(URL_FILE)
