import os
import json
import time
import re
import urllib.parse
import requests
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional

CLIENT_SECRET_PATH = "/root/.config/gws/client_secret.json"
CREDENTIALS_JSON_PATH = "/root/.config/gws/credentials.json"
TOKEN_CACHE_PATH = "/root/.config/gws/token_cache.json"

SCOPES = [
    # Gmail
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
    # Google Drive & Docs / Sheets
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
    # Google Calendar & Tasks
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/tasks",
    # Contacts & Profile
    "https://www.googleapis.com/auth/contacts.readonly",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile"
]

def load_client_secrets() -> Dict[str, str]:
    if not os.path.exists(CLIENT_SECRET_PATH):
        return {}
    try:
        with open(CLIENT_SECRET_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            client_info = data.get("installed") or data.get("web") or {}
            return {
                "client_id": client_info.get("client_id", ""),
                "client_secret": client_info.get("client_secret", ""),
                "auth_uri": client_info.get("auth_uri", "https://accounts.google.com/o/oauth2/auth"),
                "token_uri": client_info.get("token_uri", "https://oauth2.googleapis.com/token"),
            }
    except Exception:
        return {}

def get_auth_url(redirect_uri: str = "http://localhost") -> str:
    secrets = load_client_secrets()
    if not secrets.get("client_id"):
        return ""
    params = {
        "client_id": secrets["client_id"],
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "select_account consent"
    }
    return f"{secrets['auth_uri']}?{urllib.parse.urlencode(params)}"

def exchange_code_for_tokens(raw_input: str, redirect_uri: str = "http://localhost") -> Dict[str, Any]:
    secrets = load_client_secrets()
    if not secrets.get("client_id") or not secrets.get("client_secret"):
        return {"success": False, "error": "Missing client credentials"}

    code = raw_input.strip()
    if "code=" in code:
        m = re.search(r"code=([^&]+)", code)
        if m:
            code = urllib.parse.unquote(m.group(1))

    uris_to_try = ["http://localhost", "http://localhost/", redirect_uri, "http://localhost:8080/auth/google/callback", "http://127.0.0.1:8080/auth/google/callback"]
    last_error = ""

    for r_uri in uris_to_try:
        data = {
            "code": code,
            "client_id": secrets["client_id"],
            "client_secret": secrets["client_secret"],
            "redirect_uri": r_uri,
            "grant_type": "authorization_code"
        }
        try:
            resp = requests.post(secrets["token_uri"], data=data, timeout=10)
            if resp.status_code == 200:
                tokens = resp.json()
                save_tokens(tokens)
                return {"success": True, "tokens": tokens}
            else:
                last_error = resp.text
        except Exception as e:
            last_error = str(e)

    return {"success": False, "error": last_error or "Token exchange failed"}

def save_tokens(tokens: Dict[str, Any]):
    secrets = load_client_secrets()
    os.makedirs(os.path.dirname(CREDENTIALS_JSON_PATH), exist_ok=True)
    tokens_data = {
        "client_id": secrets.get("client_id"),
        "client_secret": secrets.get("client_secret"),
        "access_token": tokens.get("access_token"),
        "refresh_token": tokens.get("refresh_token"),
        "token_uri": secrets.get("token_uri", "https://oauth2.googleapis.com/token"),
        "type": "authorized_user",
        "saved_at": time.time(),
        "expires_in": tokens.get("expires_in", 3600)
    }
    with open(CREDENTIALS_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(tokens_data, f, indent=2)

def load_access_token() -> Optional[str]:
    if not os.path.exists(CREDENTIALS_JSON_PATH):
        return None
    try:
        with open(CREDENTIALS_JSON_PATH, "r", encoding="utf-8") as f:
            tokens = json.load(f)
        access_token = tokens.get("access_token")
        refresh_token = tokens.get("refresh_token")
        saved_at = tokens.get("saved_at", 0)
        expires_in = tokens.get("expires_in", 3600)

        # Refresh token if expiring within 5 minutes
        if time.time() - saved_at > (expires_in - 300) and refresh_token:
            secrets = load_client_secrets()
            data = {
                "client_id": secrets["client_id"],
                "client_secret": secrets["client_secret"],
                "refresh_token": refresh_token,
                "grant_type": "refresh_token"
            }
            resp = requests.post(secrets["token_uri"], data=data, timeout=10)
            if resp.status_code == 200:
                new_data = resp.json()
                tokens["access_token"] = new_data.get("access_token")
                tokens["saved_at"] = time.time()
                with open(CREDENTIALS_JSON_PATH, "w", encoding="utf-8") as f:
                    json.dump(tokens, f, indent=2)
                return tokens.get("access_token")
        return access_token
    except Exception:
        return None

def _get_headers() -> Optional[Dict[str, str]]:
    token = load_access_token()
    if not token:
        return None
    return {"Authorization": f"Bearer {token}"}

# ════════════════════════════════════════════════════════════
# 1. GMAIL OPERATIONS
# ════════════════════════════════════════════════════════════

def search_gmail_messages(query: str = "is:unread", max_results: int = 10) -> List[Dict[str, Any]]:
    headers = _get_headers()
    if not headers:
        return []
    params = {"q": query, "maxResults": max_results}
    try:
        resp = requests.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", headers=headers, params=params, timeout=10)
        if resp.status_code != 200:
            return []
        data = resp.json()
        messages = []
        for m in data.get("messages", []):
            m_id = m["id"]
            m_resp = requests.get(f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{m_id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date", headers=headers, timeout=8)
            if m_resp.status_code == 200:
                m_data = m_resp.json()
                headers_list = m_data.get("payload", {}).get("headers", [])
                headers_dict = {h["name"]: h["value"] for h in headers_list}
                messages.append({
                    "id": m_id,
                    "snippet": m_data.get("snippet", ""),
                    "subject": headers_dict.get("Subject", "(No Subject)"),
                    "from": headers_dict.get("From", "Unknown"),
                    "date": headers_dict.get("Date", "")
                })
        return messages
    except Exception:
        return []

# ════════════════════════════════════════════════════════════
# 2. GOOGLE DRIVE & DOCS OPERATIONS
# ════════════════════════════════════════════════════════════

def list_drive_files(query: Optional[str] = None, page_size: int = 15) -> List[Dict[str, Any]]:
    headers = _get_headers()
    if not headers:
        return []
    params = {"pageSize": page_size, "fields": "files(id, name, mimeType, modifiedTime, size, webViewLink)"}
    if query:
        params["q"] = query
    try:
        resp = requests.get("https://www.googleapis.com/drive/v3/files", headers=headers, params=params, timeout=10)
        if resp.status_code == 200:
            return resp.json().get("files", [])
        return []
    except Exception:
        return []

# ════════════════════════════════════════════════════════════
# 3. GOOGLE CALENDAR OPERATIONS
# ════════════════════════════════════════════════════════════

def list_calendar_events(time_min: Optional[str] = None, max_results: int = 10) -> List[Dict[str, Any]]:
    headers = _get_headers()
    if not headers:
        return []
    if not time_min:
        time_min = datetime.now(timezone.utc).isoformat()
    params = {
        "timeMin": time_min,
        "maxResults": max_results,
        "singleEvents": "true",
        "orderBy": "startTime"
    }
    try:
        resp = requests.get("https://www.googleapis.com/calendar/v3/calendars/primary/events", headers=headers, params=params, timeout=10)
        if resp.status_code == 200:
            events = []
            for item in resp.json().get("items", []):
                start = item.get("start", {}).get("dateTime") or item.get("start", {}).get("date")
                end = item.get("end", {}).get("dateTime") or item.get("end", {}).get("date")
                events.append({
                    "id": item.get("id"),
                    "summary": item.get("summary", "(No Title)"),
                    "start": start,
                    "end": end,
                    "location": item.get("location", ""),
                    "description": item.get("description", "")
                })
            return events
        return []
    except Exception:
        return []

# ════════════════════════════════════════════════════════════
# 4. GOOGLE TASKS OPERATIONS
# ════════════════════════════════════════════════════════════

def list_tasks(max_results: int = 20) -> List[Dict[str, Any]]:
    headers = _get_headers()
    if not headers:
        return []
    try:
        resp = requests.get("https://tasks.googleapis.com/tasks/v1/lists/@default/tasks", headers=headers, params={"maxResults": max_results}, timeout=10)
        if resp.status_code == 200:
            items = []
            for t in resp.json().get("items", []):
                items.append({
                    "id": t.get("id"),
                    "title": t.get("title", ""),
                    "status": t.get("status", ""),
                    "due": t.get("due", ""),
                    "notes": t.get("notes", "")
                })
            return items
        return []
    except Exception:
        return []
