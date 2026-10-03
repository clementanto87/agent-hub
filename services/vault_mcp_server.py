#!/root/venv/bin/python3
"""
Vault Credentials MCP Server.
Provides tools for listing, retrieving, storing, generating TOTP 2FA codes,
and performing automated browser logins for stored services.
"""
from __future__ import annotations
import sys
import os
import json
import asyncio
from typing import Optional, Dict, Any, List

sys.path.insert(0, "/root/agent-hub")
from services import vault_service
from mcp.server.mcpserver import MCPServer

mcp = MCPServer("vault-credentials")

@mcp.tool()
def vault_list() -> List[Dict[str, Any]]:
    """List all stored services and usernames safely in the credentials vault (without exposing secrets)."""
    return vault_service.list_credentials()

@mcp.tool()
def vault_get(service: str, field: Optional[str] = None) -> Dict[str, Any]:
    """
    Retrieve decrypted credentials for a service.
    Args:
        service: Identifier of the service (e.g. 'github', 'azure', 'tentamus', 'jira').
        field: Optional specific field ('username', 'password', 'totp', 'api_token', 'url', 'notes').
    """
    if field:
        val = vault_service.get_field(service, field)
        if val is None:
            return {"error": f"Field '{field}' not found for '{service}'"}
        return {"service": service, field: val}

    cred = vault_service.get_credential(service)
    if not cred:
        return {"error": f"Service '{service}' not found in vault"}
    return cred

@mcp.tool()
def vault_set(
    service: str,
    username: str = "",
    password: str = "",
    totp_secret: str = "",
    url: str = "",
    api_token: str = "",
    name: str = "",
    notes: str = ""
) -> Dict[str, Any]:
    """
    Store or update credentials for a service in the AES-256-GCM encrypted vault.
    Args:
        service: Unique identifier (e.g. 'github', 'digitalocean', 'portal').
        username: Login email or username.
        password: Plaintext password to encrypt.
        totp_secret: Optional 2FA base32 seed for automated 6-digit TOTP code generation.
        url: Login page or web portal URL.
        api_token: Optional API token / secret key.
        name: Human-readable name.
        notes: Context or notes.
    """
    try:
        return vault_service.set_credential(
            service=service,
            username=username,
            password=password,
            totp_secret=totp_secret,
            url=url,
            api_token=api_token,
            name=name,
            notes=notes
        )
    except Exception as e:
        return {"error": str(e)}

@mcp.tool()
def vault_totp(service: str) -> Dict[str, Any]:
    """
    Generate the current real-time 6-digit TOTP (2FA) verification code for a service.
    Args:
        service: Service identifier with a configured TOTP secret.
    """
    try:
        return vault_service.generate_totp(service)
    except Exception as e:
        return {"error": str(e)}

@mcp.tool()
async def vault_login(service: str, url: Optional[str] = None, timeout: int = 40) -> Dict[str, Any]:
    """
    Automate logging into a service's website via headless Google Chrome.
    Fills username, password, and 2FA code, and saves session cookies for subsequent automated actions.
    Args:
        service: Service identifier configured in vault.
        url: Optional override login URL.
        timeout: Maximum seconds to wait.
    """
    return await vault_service.login_to_site(service, headless=True, custom_url=url, timeout=timeout)

@mcp.tool()
def vault_delete(service: str) -> Dict[str, Any]:
    """
    Delete a credential record from the vault.
    Args:
        service: Identifier of the service to delete.
    """
    ok = vault_service.delete_credential(service)
    return {"service": service, "deleted": ok}

if __name__ == "__main__":
    mcp.run()
