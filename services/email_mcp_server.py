#!/root/venv/bin/python3
"""
Email MCP Server for Antigravity, Claude Code & Codex Agents.
Provides one-call email dispatch, search, and status checking.
"""
from __future__ import annotations
import sys
import os
import json
from typing import Optional, Dict, Any, List, Union

# Ensure agent-hub is in path
sys.path.insert(0, "/root/agent-hub")

from mcp.server.mcpserver import MCPServer
from services import email_service, google_auth_service, mail_connector

mcp = MCPServer("email")

@mcp.tool()
def send_email(
    to: Union[str, List[str]],
    subject: str,
    body: str,
    body_html: Optional[str] = None,
    attachments: Optional[List[str]] = None,
    cc: Optional[List[str]] = None,
    bcc: Optional[List[str]] = None,
    provider: str = "auto"
) -> Dict[str, Any]:
    """
    Send an email with optional attachments, styling, and multi-recipient support.
    
    Parameters:
    - to: Recipient email address (or comma-separated list / array of addresses)
    - subject: Subject line of the email
    - body: Plain text or Markdown content of the email
    - body_html: Optional custom HTML body (if omitted, formatted HTML is automatically generated)
    - attachments: Optional list of local file paths to attach (e.g. ['/root/Documents/Personal/01_Identity_and_Passports/17. passport_regina.pdf'])
    - cc: Optional list of CC email addresses
    - bcc: Optional list of BCC email addresses
    - provider: 'auto' (default: Google Workspace/Gmail), 'gmail', or 'm365'
    """
    return email_service.send_email(
        to=to,
        subject=subject,
        body=body,
        body_html=body_html,
        attachments=attachments,
        cc=cc,
        bcc=bcc,
        provider=provider
    )

@mcp.tool()
def search_emails(query: str = "is:unread", limit: int = 10, provider: str = "all") -> List[Dict[str, Any]]:
    """
    Search mail. provider: 'all' (default), 'gmail', or 'm365' (Outlook).
    Gmail query syntax (from:, subject:, is:unread) works on Gmail; M365 uses free-text search.
    """
    return mail_connector.search(query=query, limit=limit, provider=provider)

@mcp.tool()
def read_email(message_id: str, provider: str) -> Dict[str, Any]:
    """Read the full body of a message by id (from search_emails). provider: 'gmail' or 'm365'."""
    return mail_connector.read(message_id, provider)

@mcp.tool()
def email_status() -> Dict[str, Any]:
    """
    Check the authentication and readiness status of available email providers (Gmail, Microsoft 365).
    """
    return email_service.get_email_status()

if __name__ == "__main__":
    mcp.run()
