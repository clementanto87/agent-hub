"""
iCloud Service & Integration Module for Linux VM Agents
Connects Apple iCloud Drive, Photos, Reminders, Calendar, Contacts, and Find My.
"""

import os
import sys
import json
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta

from pyicloud import PyiCloudService
from services.vault_service import get_credential

COOKIE_DIR = "/root/.vault/sessions/icloud_cookies"
os.makedirs(COOKIE_DIR, exist_ok=True)

logger = logging.getLogger("icloud_service")

_api_client: Optional[PyiCloudService] = None

def get_icloud_client(auto_auth: bool = True) -> Optional[PyiCloudService]:
    global _api_client
    if _api_client is not None:
        return _api_client

    cred = get_credential("icloud")
    if not cred:
        logger.error("iCloud credentials not found in vault")
        return None

    username = cred.get("username", "")
    password = cred.get("password", "")

    try:
        api = PyiCloudService(username, password, cookie_directory=COOKIE_DIR)
        _api_client = api
        return api
    except Exception as e:
        logger.error(f"Failed to initialize PyiCloudService: {e}")
        return None

def check_status() -> Dict[str, Any]:
    api = get_icloud_client()
    if not api:
        return {"authenticated": False, "requires_2fa": False, "error": "No credentials"}

    if api.requires_2fa:
        return {
            "authenticated": False,
            "requires_2fa": True,
            "message": "Apple 2FA required. A verification code was sent to your Apple devices."
        }
    if api.requires_2sa:
        return {
            "authenticated": False,
            "requires_2fa": True,
            "message": "Apple 2-step verification required."
        }

    return {
        "authenticated": True,
        "requires_2fa": False,
        "username": api.user.get("account_name") if hasattr(api, "user") else "Connected",
        "services": ["drive", "photos", "reminders", "calendar", "contacts", "devices"]
    }

def verify_2fa_code(code: str) -> Dict[str, Any]:
    import urllib.request
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:8086/verify",
            data=json.dumps({"code": code.strip()}).encode('utf-8'),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            return data
    except Exception:
        pass

    api = get_icloud_client()
    if not api:
        return {"success": False, "error": "Client not initialized"}

    if not (api.requires_2fa or api.requires_2sa):
        return {"success": True, "message": "Already authenticated"}

    try:
        result = api.validate_2fa_code(code.strip())
        if result:
            try:
                if not api.is_trusted_session:
                    api.trust_session()
            except Exception:
                pass
            return {"success": True, "message": "Successfully authenticated and trusted session with iCloud!"}
        else:
            return {"success": False, "error": "Invalid 2FA verification code. Please try again."}
    except Exception as e:
        return {"success": False, "error": str(e)}

def request_new_2fa_code() -> Dict[str, Any]:
    api = get_icloud_client()
    if not api:
        return {"success": False, "error": "Client not initialized"}
    try:
        api.request_2fa_code()
        return {"success": True, "message": "Sent a new 2FA code to your trusted Apple devices."}
    except Exception as e:
        return {"success": False, "error": str(e)}

def list_devices() -> List[Dict[str, Any]]:
    api = get_icloud_client()
    if not api or api.requires_2fa:
        return []
    devices = []
    try:
        for d in api.devices:
            data = getattr(d, 'data', {}) or {}
            bat_lvl = data.get("batteryLevel")
            devices.append({
                "name": data.get("name") or getattr(d, "name", "Apple Device"),
                "device_class": data.get("deviceClass") or getattr(d, "device_type", ""),
                "display_name": data.get("deviceDisplayName") or data.get("modelDisplayName") or "",
                "model": data.get("rawDeviceModel") or data.get("deviceModel") or "",
                "battery_level": round(bat_lvl * 100) if bat_lvl is not None and bat_lvl > 0 else (0 if bat_lvl == 0 else None),
                "battery_status": data.get("batteryStatus", "Unknown"),
                "location": data.get("location", {}),
                "is_locating": data.get("isLocating", False)
            })
    except Exception as e:
        logger.error(f"Error fetching devices: {e}")
    return devices

def list_drive_files(folder_path: str = "") -> List[Dict[str, Any]]:
    api = get_icloud_client()
    if not api or api.requires_2fa:
        return []
    try:
        node = api.drive
        if folder_path.strip("/"):
            for part in folder_path.strip("/").split("/"):
                node = node[part]
        items = []
        for item_name in node.dir():
            child = node[item_name]
            items.append({
                "name": item_name,
                "type": getattr(child, "type", "file"),
                "size": getattr(child, "size", None),
                "modified": str(getattr(child, "date_modified", ""))
            })
        return items
    except Exception as e:
        logger.error(f"Error listing drive files: {e}")
        return []

def download_drive_file(file_path: str, dest_dir: str = "/root/Downloads") -> Optional[str]:
    api = get_icloud_client()
    if not api or api.requires_2fa:
        return None
    try:
        parts = file_path.strip("/").split("/")
        node = api.drive
        for p in parts[:-1]:
            node = node[p]
        target_file = node[parts[-1]]
        os.makedirs(dest_dir, exist_ok=True)
        local_path = os.path.join(dest_dir, parts[-1])
        with open(local_path, "wb") as f:
            f.write(target_file.open().content)
        return local_path
    except Exception as e:
        logger.error(f"Error downloading drive file: {e}")
        return None

def list_reminders() -> List[Dict[str, Any]]:
    api = get_icloud_client()
    if not api or api.requires_2fa:
        return []
    try:
        rems = []
        lists = api.reminders.lists() if callable(api.reminders.lists) else getattr(api.reminders, "lists", [])
        for l in lists:
            lid = getattr(l, "id", l) if not isinstance(l, dict) else l.get("id")
            lname = getattr(l, "name", "Reminders") if not isinstance(l, dict) else l.get("name", "Reminders")
            try:
                items = api.reminders.list_reminders(lid)
                for item in items:
                    title = getattr(item, "title", str(item)) if not isinstance(item, dict) else item.get("title")
                    completed = getattr(item, "completed", False) if not isinstance(item, dict) else item.get("completed", False)
                    due = str(getattr(item, "due_date", "")) if not isinstance(item, dict) else item.get("dueDate", "")
                    rems.append({
                        "title": title,
                        "list": lname,
                        "completed": completed,
                        "due_date": due
                    })
            except Exception:
                pass
        return rems
    except Exception as e:
        logger.error(f"Error fetching reminders: {e}")
        return []

def create_reminder(title: str, description: str = "", due_date: Optional[str] = None) -> bool:
    api = get_icloud_client()
    if not api or api.requires_2fa:
        return False
    try:
        api.reminders.create(title=title, description=description)
        return True
    except Exception as e:
        logger.error(f"Error creating reminder: {e}")
        return False

def list_calendar_events(from_dt: Optional[datetime] = None, to_dt: Optional[datetime] = None) -> List[Dict[str, Any]]:
    api = get_icloud_client()
    if not api or api.requires_2fa:
        return []
    try:
        start = from_dt or datetime.now()
        end = to_dt or (datetime.now() + timedelta(days=30))
        events = api.calendar.get_events(start, end) if hasattr(api.calendar, "get_events") else []
        results = []
        for ev in events:
            results.append({
                "title": ev.get("title") or ev.get("summary"),
                "start": str(ev.get("startDate") or ev.get("start")),
                "end": str(ev.get("endDate") or ev.get("end")),
                "location": ev.get("location"),
                "description": ev.get("description")
            })
        return results
    except Exception as e:
        logger.error(f"Error fetching calendar: {e}")
        return []

def list_contacts() -> List[Dict[str, Any]]:
    api = get_icloud_client()
    if not api or api.requires_2fa:
        return []
    try:
        contacts = []
        raw_contacts = api.contacts.all if isinstance(api.contacts.all, list) else (api.contacts.all() if callable(api.contacts.all) else [])
        for c in raw_contacts:
            first = c.get("firstName", "")
            last = c.get("lastName", "")
            name = f"{first} {last}".strip()
            phones = [p.get("field") for p in c.get("phones", []) if p.get("field")]
            emails = [e.get("field") for e in c.get("emailAddresses", []) if e.get("field")]
            if name or phones or emails:
                contacts.append({
                    "name": name,
                    "phones": phones,
                    "emails": emails,
                    "company": c.get("companyName")
                })
        return contacts
    except Exception as e:
        logger.error(f"Error fetching contacts: {e}")
        return []

def list_recent_photos(limit: int = 10) -> List[Dict[str, Any]]:
    api = get_icloud_client()
    if not api or api.requires_2fa:
        return []
    try:
        photos = []
        for p in list(api.photos.all)[:limit]:
            photos.append({
                "id": p.id,
                "filename": p.filename,
                "created": str(p.created),
                "size": p.size,
                "dimensions": f"{p.dimensions[0]}x{p.dimensions[1]}" if p.dimensions else None
            })
        return photos
    except Exception as e:
        logger.error(f"Error fetching photos: {e}")
        return []

def get_storage_info() -> Dict[str, Any]:
    api = get_icloud_client()
    if not api or api.requires_2fa:
        return {"error": "iCloud not authenticated or 2FA required"}
    try:
        acc = getattr(api, "account", None)
        if not acc:
            return {"error": "Account service unavailable"}
        st = getattr(acc, "storage", None)
        u = getattr(st, "usage", None) if st else None
        
        total_bytes = getattr(u, "total_storage_in_bytes", 214748364800) if u else 214748364800
        used_bytes = getattr(u, "used_storage_in_bytes", 0) if u else 0
        free_bytes = getattr(u, "available_storage_in_bytes", total_bytes - used_bytes) if u else max(0, total_bytes - used_bytes)
        used_pct = getattr(u, "used_storage_in_percent", round((used_bytes / total_bytes) * 100, 2)) if u else round((used_bytes / total_bytes) * 100, 2)

        usages = {}
        usages_by_media = getattr(st, "usages_by_media", {}) or {}
        for k, v in usages_by_media.items():
            b = getattr(v, "usage_in_bytes", 0)
            if b > 1024**3:
                fmt = f"{round(b / (1024**3), 2)} GB"
            else:
                fmt = f"{round(b / (1024**2), 1)} MB"
            usages[k] = {
                "bytes": b,
                "formatted": fmt
            }

        return {
            "plan": "Apple One / 200 GB",
            "total_bytes": total_bytes,
            "total_formatted": f"{round(total_bytes / (1024**3), 1)} GB",
            "used_bytes": used_bytes,
            "used_formatted": f"{round(used_bytes / (1024**3), 2)} GB",
            "free_bytes": free_bytes,
            "free_formatted": f"{round(free_bytes / (1024**3), 2)} GB",
            "usage_percent": f"{used_pct}%",
            "media_breakdown": usages
        }
    except Exception as e:
        logger.error(f"Error fetching storage info: {e}")
        return {"error": str(e)}
