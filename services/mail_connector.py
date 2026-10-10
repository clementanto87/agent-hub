"""
Unified mail connector: one interface over Gmail and Microsoft 365 (Outlook).

Adding a provider = subclass MailProvider, implement search/read/send, add to PROVIDERS.
"""
from __future__ import annotations
import base64
import subprocess
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

import requests

from services import email_service, google_auth_service

M365_TOKEN_SCRIPT = "/root/workspace/scripts/m365-auth.py"
GRAPH = "https://graph.microsoft.com/v1.0"


class MailProvider(ABC):
    name: str
    account: str

    @abstractmethod
    def status(self) -> Dict[str, Any]: ...
    @abstractmethod
    def search(self, query: str, limit: int) -> List[Dict[str, Any]]: ...
    @abstractmethod
    def read(self, message_id: str) -> Dict[str, Any]: ...

    def send(self, **kw) -> Dict[str, Any]:
        return email_service.send_email(provider=self.name, **kw)


class GmailProvider(MailProvider):
    name = "gmail"
    account = "clement.anto@gmail.com"

    def status(self):
        return {"status": "ready" if google_auth_service.load_access_token() else "unauthenticated",
                "account": self.account}

    def search(self, query, limit):
        return [{**m, "provider": self.name}
                for m in google_auth_service.search_gmail_messages(query=query, max_results=limit)]

    def read(self, message_id):
        headers = google_auth_service._get_headers()
        if not headers:
            return {"error": "Gmail unauthenticated"}
        r = requests.get(f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}",
                         headers=headers, params={"format": "full"}, timeout=15)
        if r.status_code != 200:
            return {"error": r.text, "status_code": r.status_code}
        data = r.json()
        hdrs = {h["name"]: h["value"] for h in data.get("payload", {}).get("headers", [])}
        return {"provider": self.name, "id": message_id,
                "subject": hdrs.get("Subject", ""), "from": hdrs.get("From", ""),
                "to": hdrs.get("To", ""), "date": hdrs.get("Date", ""),
                "body": self._body(data.get("payload", {})) or data.get("snippet", "")}

    @classmethod
    def _body(cls, part) -> str:
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            return base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", "replace")
        for sub in part.get("parts", []) or []:
            text = cls._body(sub)
            if text:
                return text
        return ""


class M365Provider(MailProvider):
    name = "m365"
    account = "Clement-Anto.Marianesan@tentamus.com"

    def _headers(self) -> Optional[Dict[str, str]]:
        try:
            tok = subprocess.run([M365_TOKEN_SCRIPT], capture_output=True, text=True,
                                 check=True, timeout=20).stdout.strip()
        except Exception:
            return None
        return {"Authorization": f"Bearer {tok}"} if len(tok) > 50 else None

    def status(self):
        return {"status": "ready" if self._headers() else "unauthenticated", "account": self.account}

    def search(self, query, limit):
        h = self._headers()
        if not h:
            return []
        params = {"$top": limit, "$select": "id,subject,from,receivedDateTime,bodyPreview,isRead"}
        if query in ("", "is:unread"):
            if query:
                params["$filter"] = "isRead eq false"
            params["$orderby"] = "receivedDateTime desc"
        else:
            params["$search"] = f'"{query}"'  # Graph forbids $orderby with $search
        r = requests.get(f"{GRAPH}/me/messages", headers=h, params=params, timeout=15)
        if r.status_code != 200:
            return [{"provider": self.name, "error": f"Graph {r.status_code}: {r.json().get('error', {}).get('message', r.text)}"}]
        return [{"provider": self.name, "id": m["id"], "subject": m.get("subject") or "(No Subject)",
                 "from": (m.get("from") or {}).get("emailAddress", {}).get("address", "Unknown"),
                 "date": m.get("receivedDateTime", ""), "snippet": m.get("bodyPreview", "")}
                for m in r.json().get("value", [])]

    def read(self, message_id):
        h = self._headers()
        if not h:
            return {"error": "M365 unauthenticated"}
        r = requests.get(f"{GRAPH}/me/messages/{message_id}", headers={**h, "Prefer": 'outlook.body-content-type="text"'}, timeout=15)
        if r.status_code != 200:
            return {"error": r.text, "status_code": r.status_code}
        m = r.json()
        return {"provider": self.name, "id": message_id, "subject": m.get("subject", ""),
                "from": (m.get("from") or {}).get("emailAddress", {}).get("address", ""),
                "to": ", ".join(x["emailAddress"]["address"] for x in m.get("toRecipients", [])),
                "date": m.get("receivedDateTime", ""), "body": (m.get("body") or {}).get("content", "")}


PROVIDERS: Dict[str, MailProvider] = {p.name: p for p in (GmailProvider(), M365Provider())}
ALIASES = {"outlook": "m365", "microsoft": "m365", "graph": "m365", "google": "gmail"}


def _get(name: str) -> MailProvider:
    key = ALIASES.get(name.lower(), name.lower())
    if key not in PROVIDERS:
        raise ValueError(f"Unknown provider '{name}'. Available: {', '.join(PROVIDERS)}")
    return PROVIDERS[key]


def status() -> Dict[str, Any]:
    return {n: p.status() for n, p in PROVIDERS.items()}


def search(query: str = "is:unread", limit: int = 10, provider: str = "all") -> List[Dict[str, Any]]:
    """Search one provider, or all and merge by date (newest first)."""
    if provider != "all":
        return _get(provider).search(query, limit)
    out: List[Dict[str, Any]] = []
    for p in PROVIDERS.values():
        out.extend(p.search(query, limit))
    return out[: limit * len(PROVIDERS)]


def read(message_id: str, provider: str) -> Dict[str, Any]:
    return _get(provider).read(message_id)
