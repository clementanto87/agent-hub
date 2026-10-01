# ⚡ AgentHub Mobile

A mobile Progressive Web App (PWA) and backend service designed to let you talk directly with all autonomous AI agents and shell environments installed on this VM from your smartphone (iPhone iOS Safari & Android Chrome).

---

## ✨ Features

**Chat**
- Switch between Antigravity, Claude Code, Codex, Linux Shell and an Auto router from the composer.
- **Pick the model per agent** from lists fetched live from each agent (`services/model_catalog.py`, `GET /api/models`): `agy models`, `codex debug models` (hidden models filtered out) and Anthropic's Models API via Claude Code's own sign-in. Cached 6 h in `data/models_cache.json`; *Refresh* in the picker asks again. New models appear and retired ones disappear automatically; a saved choice that's retired falls back to the agent's default. The model used is stored with each message.
- Live streaming with a working timer, a real **Stop** button (kills the agent's whole process tree on the server), Retry and Copy.
- Markdown with syntax-highlighted code blocks (one-tap copy), tables, and sanitized HTML.
- Shell replies keep their column alignment and show an `exit N` badge.
- Voice input (local Whisper, Gemini fallback) with a live recording bar.
- **Voice conversation** (waveform button): talk → auto-stops on silence → agent replies out loud → listens again. **The conversation uses whichever agent you have selected** — Antigravity answers with Gemini, Claude with Claude, Codex with GPT — each with its own Piper voice (`AGENT_VOICES` in `services/tts.py`; `/api/tts` takes the agent). Tap the agent name at the top of voice mode to switch mid-conversation. Replies are synthesised locally with Piper (`services/tts.py`, voice in `data/voices/`, downloaded on first use; override with `AGENTHUB_VOICE`) and played via an `<audio>` element, so it works with the iPhone silent switch on. Falls back to the browser voice if the server voice fails.
- **Background runs**: agents run on the server (`services/run_manager.py`), not inside the HTTP request — locking the phone or leaving the chat doesn't stop them; reopen the conversation to pick up where it is.
- Drafts, agent, workspace and the open conversation survive reloads.

**Terminal** — full xterm.js PTY with a mobile key bar (esc, tab, sticky ctrl, arrows, `| ~ / -`), font size control, auto-resize and reconnect.

**Monitor** — CPU / memory / disk rings with sparklines, uptime, and agent processes with a confirmed Stop.

**History** — search, day grouping, one-tap resume, confirmed delete.

**Settings** — default agent/workspace, Enter-to-send, haptics, text size, secure tunnel start/stop, QR code.

**Layout** — phone: bottom tab bar + bottom sheets. Desktop (≥ 900 px): sidebar with recent chats and centred reading column.

**PWA** — installable, app-shell cached for instant/offline open, "New chat" home-screen shortcut, safe-area aware.

---

**Extra dependency for voice replies:** `/root/venv/bin/pip install piper-tts`

---

## 🌐 How to Connect from Your Phone

### Option 1: Direct Public IP
Open in your phone's browser (Safari / Chrome):
```text
http://49.13.196.104:8080
```

### Option 2: Secure Cloudflare Tunnel (HTTPS)
For full microphone access and PWA installation on iOS Safari, go to the **Settings** tab and tap **"Start Tunnel"**, or run in terminal:
```bash
cloudflared tunnel --url http://127.0.0.1:8080
```
This provides a secure `https://*.trycloudflare.com` URL that you can open or scan via the in-app QR code.

### 📲 How to Install as an App on Your Phone
- **On iPhone (Safari)**: Open the link, tap the **Share button (⎋)** at the bottom, and select **"Add to Home Screen"**.
- **On Android (Chrome)**: Open the link, tap the **Three dots (⋮)** at the top right, and select **"Install app"** or **"Add to Home screen"**.

---

## 🛠️ Service Management

The server runs automatically as a systemd service (`web-agent.service`):

```bash
# Check service status
systemctl status web-agent.service

# Restart service
systemctl restart web-agent.service

# View live service logs
journalctl -u web-agent.service -f
```
