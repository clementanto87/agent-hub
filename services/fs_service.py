import os
from pathlib import Path

def list_directory(dir_path: str = "/root") -> dict:
    """
    Lists subdirectories for a given directory path on the VM.
    Returns current path, parent path, and list of child folders.
    """
    target = os.path.abspath(dir_path.strip() if dir_path and dir_path.strip() else "/root")
    
    if not os.path.exists(target):
        # Fallback to parent or root if path does not exist
        target = "/root" if not os.path.exists("/root") else "/"

    if not os.path.isdir(target):
        target = os.path.dirname(target)

    parent = os.path.dirname(target) if target != "/" else None

    folders = []
    try:
        entries = sorted(os.scandir(target), key=lambda e: e.name.lower())
        for entry in entries:
            try:
                # Include only directories (or symlinks pointing to directories)
                # Filter out hidden system internal folders if desired or include them
                if entry.is_dir(follow_symlinks=True):
                    is_git = os.path.exists(os.path.join(entry.path, ".git"))
                    folders.append({
                        "name": entry.name,
                        "path": entry.path,
                        "is_git": is_git,
                        "is_hidden": entry.name.startswith(".")
                    })
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError) as e:
        return {
            "current": target,
            "parent": parent,
            "error": str(e),
            "folders": []
        }

    return {
        "current": target,
        "parent": parent,
        "folders": folders
    }
