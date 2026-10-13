"""
iCloud Authentication & Session Manager Daemon
Keeps PyiCloud instance open during 2FA exchange to avoid session invalidation.
"""
import os
import sys
import time
import json

sys.path.insert(0, "/root/agent-hub")

from http.server import HTTPServer, BaseHTTPRequestHandler
from pyicloud import PyiCloudService
from services.vault_service import get_credential

COOKIE_DIR = "/root/.vault/sessions/icloud_cookies"
os.makedirs(COOKIE_DIR, exist_ok=True)

_api = None

def init_api():
    global _api
    cred = get_credential("icloud")
    if not cred:
        return None
    print("Connecting to Apple iCloud...")
    _api = PyiCloudService(cred["username"], cred["password"], cookie_directory=COOKIE_DIR)
    return _api

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        global _api
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()

        if self.path == "/status":
            if _api is None:
                init_api()
            req_2fa = _api.requires_2fa if _api else False
            self.wfile.write(json.dumps({
                "initialized": _api is not None,
                "requires_2fa": req_2fa,
                "authenticated": _api is not None and not req_2fa
            }).encode())
        elif self.path == "/request-code":
            if _api is None:
                init_api()
            try:
                _api.request_2fa_code()
                self.wfile.write(json.dumps({"success": True, "message": "Code sent"}).encode())
            except Exception as e:
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode())

    def do_POST(self):
        global _api
        content_len = int(self.headers.get('Content-Length', 0))
        post_body = self.rfile.read(content_len).decode('utf-8')
        data = json.loads(post_body) if post_body else {}

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()

        if self.path == "/verify":
            code = data.get("code", "").strip()
            if not _api:
                init_api()
            try:
                ok = _api.validate_2fa_code(code)
                if ok:
                    try:
                        _api.trust_session()
                    except Exception:
                        pass
                    self.wfile.write(json.dumps({"success": True, "message": "Authenticated & Trusted"}).encode())
                else:
                    self.wfile.write(json.dumps({"success": False, "error": "Invalid verification code"}).encode())
            except Exception as e:
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode())

if __name__ == "__main__":
    init_api()
    server = HTTPServer(("127.0.0.1", 8086), Handler)
    print("iCloud Auth Daemon running on http://127.0.0.1:8086")
    server.serve_forever()
