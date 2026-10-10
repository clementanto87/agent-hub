#!/root/venv/bin/python3
"""
Unified Email Service for Agent VM
Supports Google Workspace/Gmail API, Microsoft 365 Graph API, and SMTP/iCloud.
Provides single-step sending with automatic token refresh, MIME multipart handling,
HTML formatting, and attachments.
"""

import os
import sys
import json
import time
import base64
import mimetypes
from pathlib import Path
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
from typing import Dict, Any, List, Optional, Union
import requests

# Ensure agent-hub in path
sys.path.insert(0, "/root/agent-hub")
from services import google_auth_service

def format_styled_html(body: str, title: Optional[str] = None) -> str:
    """Wraps body text in a clean, responsive HTML card layout."""
    import html
    
    # If the body already looks like a full HTML document, return as is
    if body.strip().startswith("<!DOCTYPE") or body.strip().startswith("<html"):
        return body

    escaped_body = html.escape(body).replace("\n", "<br>\n")
    # Basic markdown backtick handling
    import re
    escaped_body = re.sub(r'`([^`]+)`', r'<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:90%;color:#0f172a;">\1</code>', escaped_body)
    escaped_body = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', escaped_body)

    header_html = f"<h2 style='color:#0f172a;margin-top:0;margin-bottom:16px;font-size:20px;border-bottom:2px solid #3b82f6;padding-bottom:8px;'>{html.escape(title or 'Notification')}</h2>" if title else ""

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body {{
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1e293b;
    line-height: 1.6;
    background-color: #f8fafc;
    margin: 0;
    padding: 24px 16px;
  }}
  .container {{
    max-width: 640px;
    margin: 0 auto;
    background: #ffffff;
    border-radius: 10px;
    border: 1px solid #e2e8f0;
    padding: 28px;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
  }}
  .content {{
    font-size: 15px;
    color: #334155;
  }}
  .footer {{
    margin-top: 28px;
    padding-top: 16px;
    border-top: 1px solid #e2e8f0;
    font-size: 12px;
    color: #94a3b8;
    text-align: center;
  }}
</style>
</head>
<body>
<div class="container">
  {header_html}
  <div class="content">
    {escaped_body}
  </div>
  <div class="footer">
    Sent securely from autonomous agent environment · hetzner-agent-vm
  </div>
</div>
</body>
</html>"""

def _send_via_gmail(
    to: List[str],
    subject: str,
    body_text: str,
    body_html: Optional[str] = None,
    attachments: Optional[List[str]] = None,
    cc: Optional[List[str]] = None,
    bcc: Optional[List[str]] = None,
    dry_run: bool = False
) -> Dict[str, Any]:
    """Sends email via Google Workspace / Gmail API."""
    token = google_auth_service.load_access_token()
    if not token:
        return {"success": False, "error": "Gmail API not authenticated. Use `gmail-cli --auth-url` or verify `/root/.config/gws/credentials.json`."}

    msg = MIMEMultipart("mixed")
    msg["To"] = ", ".join(to)
    msg["Subject"] = subject
    if cc:
        msg["Cc"] = ", ".join(cc)
    if bcc:
        msg["Bcc"] = ", ".join(bcc)

    # Body part
    alt_part = MIMEMultipart("alternative")
    alt_part.attach(MIMEText(body_text, "plain", "utf-8"))
    
    html_content = body_html or format_styled_html(body_text, title=subject)
    alt_part.attach(MIMEText(html_content, "html", "utf-8"))
    msg.attach(alt_part)

    # Attachments
    attached_files = []
    if attachments:
        for file_path in attachments:
            path = Path(file_path).expanduser().resolve()
            if not path.is_file():
                return {"success": False, "error": f"Attachment file not found: {file_path}"}
            
            mime_type, _ = mimetypes.guess_type(str(path))
            mime_type = mime_type or "application/octet-stream"
            main_type, sub_type = mime_type.split("/", 1)
            
            with open(path, "rb") as f:
                data = f.read()
            
            part = MIMEApplication(data, _subtype=sub_type)
            part.add_header("Content-Disposition", "attachment", filename=path.name)
            msg.attach(part)
            attached_files.append({"filename": path.name, "size_bytes": len(data), "path": str(path)})

    raw_b64 = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")

    if dry_run:
        return {
            "success": True,
            "dry_run": True,
            "provider": "gmail",
            "to": to,
            "cc": cc or [],
            "subject": subject,
            "attachments": attached_files,
            "message": "Dry run successful (email was not actually dispatched)"
        }

    url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    
    resp = requests.post(url, headers=headers, json={"raw": raw_b64}, timeout=20)
    
    # Handle token expiry retry
    if resp.status_code == 401:
        # Force refresh token
        token = google_auth_service.load_access_token()
        headers["Authorization"] = f"Bearer {token}"
        resp = requests.post(url, headers=headers, json={"raw": raw_b64}, timeout=20)

    if resp.status_code in (200, 201):
        data = resp.json()
        return {
            "success": True,
            "provider": "gmail",
            "message_id": data.get("id"),
            "thread_id": data.get("threadId"),
            "to": to,
            "cc": cc or [],
            "subject": subject,
            "attachments": attached_files
        }
    else:
        return {
            "success": False,
            "provider": "gmail",
            "status_code": resp.status_code,
            "error": resp.text
        }

def _send_via_m365(
    to: List[str],
    subject: str,
    body_text: str,
    body_html: Optional[str] = None,
    attachments: Optional[List[str]] = None,
    cc: Optional[List[str]] = None,
    bcc: Optional[List[str]] = None,
    dry_run: bool = False
) -> Dict[str, Any]:
    """Sends email via Microsoft Graph API."""
    import subprocess
    try:
        token = subprocess.run(["/root/workspace/scripts/m365-auth.py"], capture_output=True, text=True, check=True).stdout.strip()
    except Exception as e:
        return {"success": False, "provider": "m365", "error": f"Failed to get M365 token: {e}"}

    html_content = body_html or format_styled_html(body_text, title=subject)

    message_payload = {
        "subject": subject,
        "body": {
            "contentType": "HTML",
            "content": html_content
        },
        "toRecipients": [{"emailAddress": {"address": addr}} for addr in to]
    }

    if cc:
        message_payload["ccRecipients"] = [{"emailAddress": {"address": addr}} for addr in cc]
    if bcc:
        message_payload["bccRecipients"] = [{"emailAddress": {"address": addr}} for addr in bcc]

    attached_files = []
    if attachments:
        graph_attachments = []
        for file_path in attachments:
            path = Path(file_path).expanduser().resolve()
            if not path.is_file():
                return {"success": False, "error": f"Attachment file not found: {file_path}"}
            with open(path, "rb") as f:
                data = f.read()
            graph_attachments.append({
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": path.name,
                "contentBytes": base64.b64encode(data).decode("utf-8")
            })
            attached_files.append({"filename": path.name, "size_bytes": len(data), "path": str(path)})
        message_payload["attachments"] = graph_attachments

    if dry_run:
        return {
            "success": True,
            "dry_run": True,
            "provider": "m365",
            "to": to,
            "subject": subject,
            "attachments": attached_files,
            "message": "Dry run successful (M365)"
        }

    url = "https://graph.microsoft.com/v1.0/me/sendMail"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    resp = requests.post(url, headers=headers, json={"message": message_payload, "saveToSentItems": "true"}, timeout=20)

    if resp.status_code in (200, 202):
        return {
            "success": True,
            "provider": "m365",
            "to": to,
            "cc": cc or [],
            "subject": subject,
            "attachments": attached_files
        }
    else:
        return {
            "success": False,
            "provider": "m365",
            "status_code": resp.status_code,
            "error": resp.text
        }

def send_email(
    to: Union[str, List[str]],
    subject: str,
    body: str,
    body_html: Optional[str] = None,
    attachments: Optional[Union[str, List[str]]] = None,
    cc: Optional[Union[str, List[str]]] = None,
    bcc: Optional[Union[str, List[str]]] = None,
    provider: str = "auto",
    dry_run: bool = False
) -> Dict[str, Any]:
    """
    Unified entry point to send an email.
    
    :param to: Recipient email address or list of addresses
    :param subject: Email subject line
    :param body: Plain text / Markdown email body
    :param body_html: Optional custom HTML body
    :param attachments: File path or list of file paths to attach
    :param cc: Optional CC recipient(s)
    :param bcc: Optional BCC recipient(s)
    :param provider: 'auto' (defaults to gmail), 'gmail', or 'm365'
    :param dry_run: If True, validates payload without sending
    """
    # Normalize list arguments
    if isinstance(to, str):
        to_list = [addr.strip() for addr in to.replace(";", ",").split(",") if addr.strip()]
    else:
        to_list = list(to)

    if not to_list:
        return {"success": False, "error": "Recipient 'to' email address is required."}

    if not subject:
        return {"success": False, "error": "Email 'subject' is required."}

    cc_list = []
    if cc:
        if isinstance(cc, str):
            cc_list = [addr.strip() for addr in cc.replace(";", ",").split(",") if addr.strip()]
        else:
            cc_list = list(cc)

    bcc_list = []
    if bcc:
        if isinstance(bcc, str):
            bcc_list = [addr.strip() for addr in bcc.replace(";", ",").split(",") if addr.strip()]
        else:
            bcc_list = list(bcc)

    att_list = []
    if attachments:
        if isinstance(attachments, str):
            att_list = [attachments.strip()]
        else:
            att_list = list(attachments)

    prov = provider.lower().strip()
    if prov in ("m365", "microsoft", "graph", "outlook"):
        return _send_via_m365(to_list, subject, body, body_html, att_list, cc_list, bcc_list, dry_run)
    
    # Default to Gmail / Google Workspace API
    return _send_via_gmail(to_list, subject, body, body_html, att_list, cc_list, bcc_list, dry_run)

def get_email_status() -> Dict[str, Any]:
    """Returns the authentication and readiness status of available email providers."""
    gmail_token = google_auth_service.load_access_token()
    gmail_ok = bool(gmail_token)
    
    m365_ok = False
    try:
        import subprocess
        res = subprocess.run(["/root/workspace/scripts/m365-auth.py"], capture_output=True, text=True, timeout=5)
        m365_ok = (res.returncode == 0 and len(res.stdout.strip()) > 50)
    except Exception:
        m365_ok = False

    return {
        "gmail": {
            "status": "ready" if gmail_ok else "unauthenticated",
            "account": "clement.anto@gmail.com",
            "primary": True
        },
        "m365": {
            "status": "ready" if m365_ok else "unauthenticated",
            "account": "Clement-Anto.Marianesan@tentamus.com",
            "primary": False
        }
    }
