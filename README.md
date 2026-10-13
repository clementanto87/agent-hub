# ⚡ AgentHub Mobile

A mobile Progressive Web App (PWA) and backend service designed to let you talk directly with all autonomous AI agents and shell environments installed on this VM from your smartphone (iPhone iOS Safari & Android Chrome).

---

## ✨ Features

**Chat**
- Switch between Regina, Antigravity, Claude Code, Codex, Linux Shell and an Auto router from the composer.
- **Pick the model per agent** from lists fetched live from each agent (`services/model_catalog.py`, `GET /api/models`): `agy models`, `codex debug models` (hidden models filtered out) and Anthropic's Models API via Claude Code's own sign-in. Cached 6 h in `data/models_cache.json`; *Refresh* in the picker asks again. New models appear and retired ones disappear automatically; a saved choice that's retired falls back to the agent's default. The model used is stored with each message.
- **Regina** uses the Microsoft Foundry `gpt-5.4-mini` deployment (EU Data Zone Standard) through Codex's tool runner. The model picker also offers GPT-6.1 Sol (EU Data Zone) and GPT-6 Astra (global processing); GPT-5.4 mini remains the default. Her API key is loaded at runtime from encrypted vault service `tentamus-foundry-playground`, never sent to the browser. Select Regina in the agent picker to chat, use VM tools, and continue saved conversations. Regina always uses Foundry, including conversational and voice replies; she bypasses the app's separate fast-reply model.
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

**Rich components** — the chat turns plain markdown into a polished, best-in-class UI. Every agent gets all of these for free (the format guide in `services/agent_runner.py` teaches them); anything unrecognised or mid-stream simply stays a plain code block, so nothing ever breaks:

- **Tables** — sticky first column, per-column typing (status pills, dates + relative time, right-aligned numbers, inline data bars), tap-to-sort headers, filter, table ⇄ card views, and "Copy as CSV".
- **Stat tiles** — a `- **Label:** value (note)` list becomes a responsive grid of tiles.
- **Callouts** — `> [!NOTE]` / `[!TIP]` / `[!WARNING]` / `[!IMPORTANT]` / `[!CAUTION]`, or a leading emoji.
- **Task progress** — GFM `- [x]` lists gain a progress bar.
- **Charts** — ` ```chart ` JSON: `bar`, `line`, `donut`.
- **Timeline** — ` ```timeline ` line format with `ok`/`warn`/`bad`/`info` dots.
- **Key–Value panel** — ` ```kv ` JSON: labelled fields, auto status pills, tap-to-copy mono values, links.
- **Gauges** — ` ```gauge ` JSON: radial rings with value/max, unit, auto or explicit `tone`.
- **Sparkline** — ` ```spark ` JSON: a trend line with latest value and delta.
- **Metrics dashboard** — ` ```metrics ` JSON: headline tiles, each with an optional inline sparkline and tone.
- **Heatmap** — ` ```heatmap ` JSON: a contribution-style calendar.
- **Pass/fail matrix** — ` ```matrix ` JSON: a compact ✓/✗/⚠/· grid for test or availability matrices.
- **Comparison** — ` ```compare ` JSON: two option / before-vs-after cards with a "Recommended" badge.
- **Stepper** — ` ```steps ` JSON: an ordered pipeline with `done` / `current` / `failed` states.
- **Rings** — ` ```rings ` JSON: a set of progress rings.
- **Badges** — ` ```badges ` JSON: a wall of status badges with values.
- **Tree** — ` ```tree ` plain text: a file/structure tree with icons.
- **Math** — ` ```math ` blocks or inline `$…$` / `$$…$$`, rendered with KaTeX (lazy-loaded from CDN, cached by the service worker).
- **Diffs** — ` ```diff ` / patch blocks with `+N −M` stats and per-line highlighting; shell replies keep column alignment and an `exit N` badge.

---

**Extra dependency for voice replies:** `/root/venv/bin/pip install piper-tts`

---

## 🌐 How to Connect from Your Phone

### Option 1: Direct Public IP
Open in your phone's browser (Safari / Chrome):
```text
http://49.13.196.104:8080
```

### Option 2: The one canonical HTTPS address (recommended)

Use this single address on **every** device (phone, laptop, tablet):

```text
https://49-13-196-104.sslip.io
```

Caddy terminates TLS (Let's Encrypt) on `:443` for this host and reverse-proxies
to the app on `127.0.0.1:8080`. `sslip.io` resolves the hostname straight back to
this VM's public IP, so the address is **stable and never rotates**.

> [!IMPORTANT]
> **Always use the same origin on every device.** `localStorage` and
> `sessionStorage` are scoped *per origin*, so the app treats each different
> address as a separate install. Opening `https://49-13-196-104.sslip.io` on your
> laptop and `http://49.13.196.104:8080` (or a rotating `*.trycloudflare.com`
> link) on your phone gives you **two isolated apps** that do not share the open
> conversation, drafts, or the selected agent — the classic "my message shows on
> one screen but not the other" symptom. Open the exact same URL everywhere.

The Settings tab shows **This address** and warns you when the current device is
not on the canonical origin. Tap **Open secure link** in the banner to switch.

### Option 3: Ephemeral Cloudflare Tunnel (fallback only)
Only if the fixed address is unavailable:
```bash
cloudflared tunnel --url http://127.0.0.1:8080
```
This gives a temporary `https://*.trycloudflare.com` URL. Because it rotates on
each restart, do **not** mix it with the canonical address across devices.

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
