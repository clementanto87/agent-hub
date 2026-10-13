"""Device folder imports with bounded writes and validated relative paths."""
import os
import shutil
import tempfile
from pathlib import PurePosixPath

IMPORT_ROOT = '/root/workspace/device-imports'
MAX_BYTES = 512 * 1024 * 1024
MAX_FILES = 10000

async def import_folder(files):
    destination = None
    try:
        if not files or len(files) > MAX_FILES:
            raise ValueError('Choose a folder containing 1 to 10,000 files.')
        paths = []
        for file in files:
            name = file.filename or ''
            parts = name.split('/')
            if '\\' in name or '\x00' in name or len(parts) < 2 or any(p in ('', '.', '..') for p in parts):
                raise ValueError('Invalid folder path in upload.')
            paths.append(PurePosixPath(name))
        roots = {p.parts[0] for p in paths}
        if len(roots) != 1 or len(set(paths)) != len(paths):
            raise ValueError('Select one folder with unique file paths.')
        os.makedirs(IMPORT_ROOT, exist_ok=True)
        destination = tempfile.mkdtemp(prefix='import-', dir=IMPORT_ROOT)
        total = 0
        for file, relative in zip(files, paths):
            target = os.path.join(destination, *relative.parts)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'xb') as output:
                while chunk := await file.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_BYTES:
                        raise ValueError('Folder exceeds the 512 MB upload limit.')
                    output.write(chunk)
        root = roots.pop()
        return {'path': os.path.join(destination, root), 'name': root, 'count': len(files), 'size': total}
    except BaseException:
        if destination:
            shutil.rmtree(destination, ignore_errors=True)
        raise
    finally:
        for file in files:
            await file.close()
