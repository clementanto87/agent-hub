#!/root/venv/bin/python3
"""Outlook (personal Outlook.com) MCP server — mail + calendar via Microsoft Graph."""
from __future__ import annotations
import sys
from typing import Any, Dict, List, Optional, Union

sys.path.insert(0, "/root/agent-hub")
from mcp.server.mcpserver import MCPServer
from services import outlook_service as o

mcp = MCPServer("outlook")


@mcp.tool()
def outlook_status() -> Dict[str, Any]:
    """Check Outlook sign-in state and account."""
    return o.status()


@mcp.tool()
def outlook_list(folder: str = "inbox", limit: int = 10, unread_only: bool = False) -> List[Dict[str, Any]]:
    """List messages. folder: inbox, sentitems, drafts, deleteditems, junkemail, archive."""
    return o.list_messages(folder, limit, unread_only)


@mcp.tool()
def outlook_search(query: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Free-text search across all mail."""
    return o.search_messages(query, limit)


@mcp.tool()
def outlook_read(message_id: str) -> Dict[str, Any]:
    """Read a full message by id."""
    return o.read_message(message_id)


@mcp.tool()
def outlook_send(to: Union[str, List[str]], subject: str, body: str, html: bool = False, cc: Optional[List[str]] = None) -> Dict[str, Any]:
    """Send an email from the Outlook account."""
    return o.send_message(to, subject, body, html, cc)


@mcp.tool()
def outlook_reply(message_id: str, body: str, reply_all: bool = False) -> Dict[str, Any]:
    """Reply (or reply-all) to a message."""
    return o.reply(message_id, body, reply_all)


@mcp.tool()
def outlook_calendar(days: int = 7, limit: int = 20) -> List[Dict[str, Any]]:
    """Upcoming calendar events for the next N days."""
    return o.calendar_events(days, limit)


if __name__ == "__main__":
    mcp.run()
