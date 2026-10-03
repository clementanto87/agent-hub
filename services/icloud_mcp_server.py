#!/root/venv/bin/python3
"""
iCloud MCP Server for Antigravity, Claude Code & Codex Agents
Exposes Apple iCloud Drive, Storage, Photos, Devices, Reminders, Calendar, Contacts, and Family as MCP tools.
"""
from __future__ import annotations
import sys
import os
import json
from typing import Optional, Dict, Any, List

# Ensure paths
sys.path.insert(0, "/root/agent-hub")

from mcp.server.mcpserver import MCPServer
from services import icloud_service

mcp = MCPServer("icloud")

@mcp.tool()
def icloud_storage_info() -> Dict[str, Any]:
    """Get Apple iCloud total storage capacity, used space, free space, and breakdown by media (Photos, Backups, Drive, Messages)."""
    return icloud_service.get_storage_info()

@mcp.tool()
def icloud_devices() -> List[Dict[str, Any]]:
    """List connected Apple devices (iPhone, iPad, Mac, Watch, AirPods) with battery levels, status, and locations."""
    return icloud_service.list_devices()

@mcp.tool()
def icloud_drive_list(folder_path: str = "") -> List[Dict[str, Any]]:
    """List files and folders in Apple iCloud Drive."""
    return icloud_service.list_drive_files(folder_path)

@mcp.tool()
def icloud_drive_download(file_path: str, destination_dir: str = "/root/Downloads") -> Dict[str, Any]:
    """Download a file from Apple iCloud Drive to a local Linux directory."""
    local_path = icloud_service.download_drive_file(file_path, destination_dir)
    if local_path:
        return {"success": True, "local_path": local_path}
    return {"success": False, "error": f"Failed to download '{file_path}'"}

@mcp.tool()
def icloud_reminders_list() -> List[Dict[str, Any]]:
    """List tasks and to-do items from Apple Reminders."""
    return icloud_service.list_reminders()

@mcp.tool()
def icloud_reminder_add(title: str, description: str = "") -> Dict[str, Any]:
    """Create a new task in Apple Reminders."""
    ok = icloud_service.create_reminder(title, description)
    return {"success": ok, "title": title}

@mcp.tool()
def icloud_calendar_events() -> List[Dict[str, Any]]:
    """List upcoming appointments and calendar events from Apple Calendar."""
    return icloud_service.list_calendar_events()

@mcp.tool()
def icloud_contacts_list() -> List[Dict[str, Any]]:
    """Search and list Apple iCloud contacts with phone numbers and email addresses."""
    return icloud_service.list_contacts()

@mcp.tool()
def icloud_photos_list(limit: int = 10) -> List[Dict[str, Any]]:
    """List recent photos, screenshots, and videos stored in Apple iCloud Photos."""
    return icloud_service.list_recent_photos(limit)

if __name__ == "__main__":
    mcp.run()
