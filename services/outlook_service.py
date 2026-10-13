"""Personal Outlook.com connector via Microsoft Graph (MSAL device-code, delegated)."""
from __future__ import annotations
import os, subprocess, requests, msal

AUTHORITY = "https://login.microsoftonline.com/consumers"
SCOPES = ["Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite", "User.Read"]
CACHE = "/root/.vault/outlook_token_cache.json"
GRAPH = "https://graph.microsoft.com/v1.0"


def _client_id() -> str:
    cid = os.environ.get("OUTLOOK_CLIENT_ID")
    if cid:
        return cid
    out = subprocess.run(["vault", "get", "outlook", "--field", "username"], capture_output=True, text=True)
    cid = out.stdout.strip()
    if not cid:
        raise RuntimeError("No Client ID: run `vault set outlook --username <client-id>` then `outlook-login`")
    return cid


def _app():
    cache = msal.SerializableTokenCache()
    if os.path.exists(CACHE):
        cache.deserialize(open(CACHE).read())
    return msal.PublicClientApplication(_client_id(), authority=AUTHORITY, token_cache=cache), cache


def _save(cache):
    if cache.has_state_changed:
        fd = os.open(CACHE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(cache.serialize())


def login() -> str:
    app, cache = _app()
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(flow)
    print(flow["message"], flush=True)
    res = app.acquire_token_by_device_flow(flow)
    _save(cache)
    if "access_token" not in res:
        raise RuntimeError(res)
    return res["id_token_claims"].get("preferred_username", "ok")


def _token() -> str:
    app, cache = _app()
    accts = app.get_accounts()
    res = app.acquire_token_silent(SCOPES, account=accts[0]) if accts else None
    _save(cache)
    if not res or "access_token" not in res:
        raise RuntimeError("Not signed in. Run: /root/venv/bin/python3 /root/agent-hub/services/outlook_service.py login")
    return res["access_token"]


def _req(method, path, **kw):
    r = requests.request(method, GRAPH + path, headers={"Authorization": f"Bearer {_token()}"}, timeout=30, **kw)
    if r.status_code >= 400:
        raise RuntimeError(f"Graph {r.status_code}: {r.text[:300]}")
    return r.json() if r.content else {}


def _brief(m):
    return {"id": m["id"], "subject": m.get("subject"), "from": (m.get("from") or {}).get("emailAddress", {}).get("address"),
            "received": m.get("receivedDateTime"), "unread": not m.get("isRead", True), "preview": m.get("bodyPreview", "")[:200]}


def list_messages(folder="inbox", limit=10, unread_only=False):
    p = {"$top": limit, "$orderby": "receivedDateTime desc", "$select": "id,subject,from,receivedDateTime,isRead,bodyPreview"}
    if unread_only:
        p["$filter"] = "isRead eq false"
        p.pop("$orderby")
    return [_brief(m) for m in _req("GET", f"/me/mailFolders/{folder}/messages", params=p)["value"]]


def search_messages(query, limit=10):
    p = {"$search": f'"{query}"', "$top": limit, "$select": "id,subject,from,receivedDateTime,isRead,bodyPreview"}
    return [_brief(m) for m in _req("GET", "/me/messages", params=p)["value"]]


def read_message(message_id):
    m = _req("GET", f"/me/messages/{message_id}", params={"$select": "id,subject,from,toRecipients,receivedDateTime,body,hasAttachments"})
    return {"id": m["id"], "subject": m["subject"], "from": m["from"]["emailAddress"]["address"],
            "to": [t["emailAddress"]["address"] for t in m["toRecipients"]], "received": m["receivedDateTime"],
            "body": m["body"]["content"], "content_type": m["body"]["contentType"], "has_attachments": m["hasAttachments"]}


def send_message(to, subject, body, html=False, cc=None):
    rec = lambda xs: [{"emailAddress": {"address": a}} for a in (xs if isinstance(xs, list) else [xs])]
    msg = {"subject": subject, "body": {"contentType": "HTML" if html else "Text", "content": body}, "toRecipients": rec(to)}
    if cc:
        msg["ccRecipients"] = rec(cc)
    _req("POST", "/me/sendMail", json={"message": msg, "saveToSentItems": True})
    return {"status": "sent"}


def reply(message_id, body, reply_all=False):
    _req("POST", f"/me/messages/{message_id}/{'replyAll' if reply_all else 'reply'}", json={"comment": body})
    return {"status": "sent"}


def calendar_events(days=7, limit=20):
    from datetime import datetime, timedelta, timezone
    s = datetime.now(timezone.utc); e = s + timedelta(days=days)
    v = _req("GET", "/me/calendarView", params={"startDateTime": s.isoformat(), "endDateTime": e.isoformat(), "$top": limit,
             "$orderby": "start/dateTime", "$select": "subject,start,end,location"})["value"]
    return [{"subject": x["subject"], "start": x["start"]["dateTime"], "end": x["end"]["dateTime"], "location": x["location"].get("displayName")} for x in v]


def status():
    me = _req("GET", "/me")
    return {"signed_in": True, "account": me.get("userPrincipalName") or me.get("mail")}


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["login"]:
        print("Signed in as", login())
    else:
        print(status())
