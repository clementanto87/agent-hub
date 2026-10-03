import os
import sys
import json
import time
import base64
import sqlite3
import hashlib
import asyncio
from typing import Dict, Any, List, Optional
from datetime import datetime

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import pyotp

VAULT_DIR = os.path.expanduser("/root/.vault")
DB_PATH = os.path.join(VAULT_DIR, "vault.db")
KEY_PATH = os.path.join(VAULT_DIR, "master.key")
SESSIONS_DIR = os.path.join(VAULT_DIR, "sessions")

os.makedirs(VAULT_DIR, mode=0o700, exist_ok=True)
os.makedirs(SESSIONS_DIR, mode=0o700, exist_ok=True)

def _get_or_create_master_key() -> bytes:
    """Retrieve or securely generate the 256-bit master encryption key."""
    if os.path.isfile(KEY_PATH):
        try:
            with open(KEY_PATH, "rb") as f:
                key = f.read()
                if len(key) == 32:
                    return key
        except Exception:
            pass

    # Generate 32 bytes (256 bits) of cryptographically secure random bytes
    key = AESGCM.generate_key(bit_length=256)
    with open(KEY_PATH, "wb") as f:
        f.write(key)
    os.chmod(KEY_PATH, 0o600)
    return key

def _encrypt_payload(data: Dict[str, Any]) -> str:
    """Encrypt JSON dict payload using AES-256-GCM with a random 96-bit nonce."""
    key = _get_or_create_master_key()
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    plaintext = json.dumps(data).encode("utf-8")
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)
    # Store nonce + ciphertext encoded in base64
    combined = nonce + ciphertext
    return base64.b64encode(combined).decode("ascii")

def _decrypt_payload(encrypted_b64: str) -> Dict[str, Any]:
    """Decrypt base64-encoded nonce + ciphertext using AES-256-GCM."""
    if not encrypted_b64:
        return {}
    key = _get_or_create_master_key()
    aesgcm = AESGCM(key)
    raw = base64.b64decode(encrypted_b64.encode("ascii"))
    if len(raw) < 12:
        return {}
    nonce = raw[:12]
    ciphertext = raw[12:]
    plaintext = aesgcm.decrypt(nonce, ciphertext, None)
    return json.loads(plaintext.decode("utf-8"))

def _get_db() -> sqlite3.Connection:
    """Initialize and return SQLite connection with proper permissions."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    if os.path.exists(DB_PATH):
        os.chmod(DB_PATH, 0o600)
    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS credentials (
                service TEXT PRIMARY KEY,
                name TEXT,
                url TEXT,
                username TEXT,
                has_password INTEGER DEFAULT 0,
                has_totp INTEGER DEFAULT 0,
                has_token INTEGER DEFAULT 0,
                encrypted_payload TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
    return conn

def set_credential(
    service: str,
    username: str = "",
    password: str = "",
    totp_secret: str = "",
    url: str = "",
    api_token: str = "",
    name: str = "",
    notes: str = "",
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Securely store or update a service credential."""
    clean_service = service.strip().lower()
    if not clean_service:
        raise ValueError("Service identifier is required")

    # Clean TOTP secret if provided (remove spaces/dashes, uppercase)
    clean_totp = totp_secret.replace(" ", "").replace("-", "").upper().strip() if totp_secret else ""
    if clean_totp:
        try:
            # Test validity with pyotp
            pyotp.TOTP(clean_totp).now()
        except Exception as e:
            raise ValueError(f"Invalid TOTP base32 secret: {e}")

    now = time.time()
    payload = {
        "service": clean_service,
        "name": name or clean_service.replace("-", " ").title(),
        "url": url.strip(),
        "username": username.strip(),
        "password": password,
        "totp_secret": clean_totp,
        "api_token": api_token.strip(),
        "notes": notes.strip(),
        "metadata": metadata or {}
    }

    encrypted = _encrypt_payload(payload)
    has_password = 1 if password else 0
    has_totp = 1 if clean_totp else 0
    has_token = 1 if api_token else 0
    display_name = payload["name"]

    conn = _get_db()
    with conn:
        conn.execute("""
            INSERT INTO credentials (
                service, name, url, username, has_password, has_totp, has_token, encrypted_payload, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(service) DO UPDATE SET
                name=excluded.name,
                url=excluded.url,
                username=excluded.username,
                has_password=excluded.has_password,
                has_totp=excluded.has_totp,
                has_token=excluded.has_token,
                encrypted_payload=excluded.encrypted_payload,
                updated_at=excluded.updated_at
        """, (clean_service, display_name, url.strip(), username.strip(), has_password, has_totp, has_token, encrypted, now, now))

    return {
        "service": clean_service,
        "name": display_name,
        "url": url.strip(),
        "username": username.strip(),
        "has_password": bool(has_password),
        "has_totp": bool(has_totp),
        "has_token": bool(has_token),
        "updated_at": now
    }

def get_credential(service: str) -> Optional[Dict[str, Any]]:
    """Retrieve and decrypt the credential record for a service."""
    clean_service = service.strip().lower()
    conn = _get_db()
    cur = conn.execute("SELECT encrypted_payload FROM credentials WHERE service = ?", (clean_service,))
    row = cur.fetchone()
    if not row:
        return None
    data = _decrypt_payload(row["encrypted_payload"])
    return data

def get_field(service: str, field: str) -> Optional[str]:
    """Retrieve a specific field (e.g. password, totp, api_token, username) for a service."""
    cred = get_credential(service)
    if not cred:
        return None
    field_lower = field.strip().lower()
    if field_lower in ["totp", "otp", "2fa", "code"]:
        return generate_totp(service).get("code")
    return cred.get(field_lower)

def list_credentials() -> List[Dict[str, Any]]:
    """List all stored services safely without revealing secret values."""
    conn = _get_db()
    cur = conn.execute("""
        SELECT service, name, url, username, has_password, has_totp, has_token, updated_at
        FROM credentials ORDER BY service ASC
    """)
    items = []
    for r in cur.fetchall():
        items.append({
            "service": r["service"],
            "name": r["name"],
            "url": r["url"],
            "username": r["username"],
            "has_password": bool(r["has_password"]),
            "has_totp": bool(r["has_totp"]),
            "has_token": bool(r["has_token"]),
            "updated_at": r["updated_at"]
        })
    return items

def delete_credential(service: str) -> bool:
    """Remove a credential from the vault."""
    clean_service = service.strip().lower()
    conn = _get_db()
    with conn:
        res = conn.execute("DELETE FROM credentials WHERE service = ?", (clean_service,))
        deleted = res.rowcount > 0
    # Also clean up session file if any
    sess_file = os.path.join(SESSIONS_DIR, f"{clean_service}.json")
    if os.path.isfile(sess_file):
        try:
            os.remove(sess_file)
        except Exception:
            pass
    return deleted

def generate_totp(service: str) -> Dict[str, Any]:
    """Generate real-time 6-digit TOTP code and return remaining validity seconds."""
    cred = get_credential(service)
    if not cred:
        raise ValueError(f"Service '{service}' not found in vault")
    totp_secret = cred.get("totp_secret")
    if not totp_secret:
        raise ValueError(f"Service '{service}' does not have a 2FA/TOTP secret configured")
    
    totp = pyotp.TOTP(totp_secret)
    now = time.time()
    code = totp.now()
    time_step = 30
    remaining = int(time_step - (now % time_step))
    return {
        "service": service,
        "code": code,
        "remaining_seconds": remaining,
        "expires_at": now + remaining
    }

async def login_to_site(
    service: str,
    headless: bool = True,
    custom_url: Optional[str] = None,
    timeout: int = 40
) -> Dict[str, Any]:
    """
    Automated browser login using Playwright & Google Chrome.
    Fetches credentials & TOTP, auto-detects form fields, executes login,
    and persists authenticated cookies/storage to /root/.vault/sessions/<service>.json.
    """
    from playwright.async_api import async_playwright

    cred = get_credential(service)
    if not cred:
        return {"success": False, "error": f"Service '{service}' not found in vault"}

    target_url = custom_url or cred.get("url")
    if not target_url:
        return {"success": False, "error": f"No login URL specified for service '{service}'"}

    username = cred.get("username", "")
    password = cred.get("password", "")
    totp_secret = cred.get("totp_secret", "")

    session_path = os.path.join(SESSIONS_DIR, f"{service}.json")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path="/usr/bin/google-chrome",
            headless=headless,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        )
        context = await browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
        )
        page = await context.new_page()

        try:
            # 1. Navigate to target URL
            await page.goto(target_url, wait_until="domcontentloaded", timeout=timeout * 1000)
            await asyncio.sleep(2)

            # 2. Find and fill username / email
            user_selectors = [
                'input[type="email"]',
                'input[name*="user"]',
                'input[name*="email"]',
                'input[name*="login"]',
                'input[id*="user"]',
                'input[id*="email"]',
                'input[id*="login"]',
                'input[autocomplete="username"]',
                'input[autocomplete="email"]',
                'input[type="text"]'
            ]
            
            user_field = None
            for sel in user_selectors:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    user_field = el
                    break

            if user_field and username:
                await user_field.click()
                await user_field.fill(username)
                await asyncio.sleep(0.5)

            # Check if there is a "Next" / "Continue" step (e.g. Google / Microsoft CIAM multi-step login)
            next_btn = await page.query_selector('button:has-text("Next"), button:has-text("Continue"), input[value="Next"], input[value="Continue"]')
            if next_btn and await next_btn.is_visible():
                pass_field_initial = await page.query_selector('input[type="password"]')
                if not pass_field_initial or not (await pass_field_initial.is_visible()):
                    await next_btn.click()
                    await asyncio.sleep(2)

            # 3. Find and fill password
            pass_field = await page.query_selector('input[type="password"]')
            if pass_field and await pass_field.is_visible() and password:
                await pass_field.click()
                await pass_field.fill(password)
                await asyncio.sleep(0.5)

            # 4. Submit credentials
            submit_selectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Sign in")',
                'button:has-text("Log in")',
                'button:has-text("Login")',
                'button:has-text("Submit")',
                'button:has-text("Anmelden")'
            ]
            for sel in submit_selectors:
                btn = await page.query_selector(sel)
                if btn and await btn.is_visible():
                    await btn.click()
                    break

            await asyncio.sleep(3)

            # 5. Check if 2FA / TOTP input is requested
            if totp_secret:
                totp_code = pyotp.TOTP(totp_secret).now()
                totp_selectors = [
                    'input[name*="totp"]',
                    'input[name*="otp"]',
                    'input[name*="code"]',
                    'input[name*="2fa"]',
                    'input[id*="totp"]',
                    'input[id*="otp"]',
                    'input[id*="code"]',
                    'input[autocomplete="one-time-code"]',
                    'input[type="tel"]',
                    'input[inputmode="numeric"]'
                ]
                for sel in totp_selectors:
                    t_el = await page.query_selector(sel)
                    if t_el and await t_el.is_visible():
                        await t_el.click()
                        await t_el.fill(totp_code)
                        await asyncio.sleep(0.5)
                        # Submit 2FA
                        sub_2fa = await page.query_selector('button[type="submit"], input[type="submit"], button:has-text("Verify"), button:has-text("Continue")')
                        if sub_2fa and await sub_2fa.is_visible():
                            await sub_2fa.click()
                        break

            await asyncio.sleep(3)

            # 6. Save authenticated storage state (cookies + localStorage)
            await context.storage_state(path=session_path)
            os.chmod(session_path, 0o600)

            final_url = page.url
            final_title = await page.title()
            cookies = await context.cookies()

            return {
                "success": True,
                "service": service,
                "final_url": final_url,
                "title": final_title,
                "cookie_count": len(cookies),
                "session_saved": session_path,
                "timestamp": time.time()
            }

        except Exception as e:
            return {
                "success": False,
                "service": service,
                "error": str(e),
                "url": page.url if page else target_url
            }
        finally:
            await browser.close()

def get_saved_session(service: str) -> Optional[Dict[str, Any]]:
    """Retrieve saved cookies and storage state for authenticated sessions."""
    clean_service = service.strip().lower()
    sess_file = os.path.join(SESSIONS_DIR, f"{clean_service}.json")
    if not os.path.isfile(sess_file):
        return None
    try:
        with open(sess_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None
