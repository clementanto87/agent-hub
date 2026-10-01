/* AgentHub — frontend
   Vanilla JS, no build step. Talks to the FastAPI backend in ../server.py. */
'use strict';

/* ════════════════════════════════════════════════════════════
   Constants
   ════════════════════════════════════════════════════════════ */

const AGENTS = {
  antigravity: { name: 'Antigravity', full: 'Google Antigravity', desc: 'Autonomous agent with tools and filesystem access', color: 'var(--c-antigravity)', icon: 'a-antigravity' },
  claude:      { name: 'Claude Code', full: 'Anthropic Claude Code', desc: 'Claude Code CLI with full tool execution', color: 'var(--c-claude)', icon: 'a-claude' },
  codex:       { name: 'Codex', full: 'OpenAI Codex', desc: 'OpenAI coding agent', color: 'var(--c-codex)', icon: 'a-codex' },
  muse:        { name: 'Meta Muse', full: 'Meta Muse (Muse Code)', desc: 'Meta autonomous AI coding agent with full VM access', color: 'var(--c-muse)', icon: 'a-muse' },
  bash:        { name: 'Shell', full: 'Linux Shell', desc: 'Run a command directly in bash', color: 'var(--c-bash)', icon: 'a-bash' },
  auto:        { name: 'Auto', full: 'Smart Router', desc: 'Picks the best agent for each message', color: 'var(--c-auto)', icon: 'a-auto' },
};

// The backend prefixes each reply with a tag line naming the agent that ran.
const AGENT_TAGS = { '🚀': 'antigravity', '🟣': 'claude', '🟢': 'codex', '🔷': 'muse', '⚙️': 'bash' };
const TAG_RE = /^\s*(🚀|🟣|🟢|🔷|⚙️)\s*\*\[[^\]\n]*\]\*[ \t]*\n*/u;

const SUGGESTIONS = [
  { icon: 'i-sparkle', title: 'Shared memory',   sub: 'Search pet-memory facts',        prompt: 'Search shared memory for recent facts and family records', cmd: 'python3 -c "import sys; sys.path.insert(0, \'/root/workspace/pet/infra/memory\'); import server; print(server.memory_recall(\'\', 5))"' },
  { icon: 'i-file-code', title: 'Personal profile', sub: 'Master dossier & verified facts', prompt: 'Read /root/Documents/Personal/PROFILE.md and summarize current profile', cmd: 'head -n 40 /root/Documents/Personal/PROFILE.md' },
  { icon: 'i-pulse',  title: 'System health',   sub: 'CPU, memory, disk and uptime',   prompt: 'Check VM resource usage and uptime', cmd: 'uptime && free -h && df -h /' },
  { icon: 'i-git',    title: 'Git status',      sub: 'Uncommitted changes in workspace', prompt: 'Show git status for this workspace and summarize what changed', cmd: 'git status -s' },
  { icon: 'i-box',    title: 'Docker',          sub: 'Containers and their state',     prompt: 'List docker containers and flag anything unhealthy', cmd: 'docker ps -a' },
  { icon: 'i-folder', title: 'Explore workspace', sub: 'What is in this folder?',      prompt: 'Give me a quick tour of the files in this workspace', cmd: 'ls -la' },
];

const DEFAULT_WORKSPACE = '/root/Documents/antigravity/clever-einstein';
const store = {
  get(k, d) { try { const v = localStorage.getItem('ah.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ah.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

/* ════════════════════════════════════════════════════════════
   State
   ════════════════════════════════════════════════════════════ */

const state = {
  tab: 'chat',
  agent: store.get('agent', 'antigravity'),
  workspace: store.get('workspace', DEFAULT_WORKSPACE),
  workspaces: [],
  sessionId: null,
  title: '',
  messages: [],            // {role, content, agent, ts}
  streaming: false,
  abort: null,
  epoch: 0,                // bumps when the user leaves the conversation being streamed
  running: new Set(),      // conversation ids with an agent still working server-side
  models: {},              // live catalogs from /api/models, keyed by agent
  modelSel: store.get('models', {}),   // chosen model per agent (absent = the agent's own default)
  modelsLoadedAt: 0,
  stick: true,             // auto-scroll while the user is at the bottom
  sessions: [],
  sessionsLoaded: false,
  attachments: [],
  tunnel: { active: false, url: '' },
  prefs: {
    enter: store.get('pref.enter', window.matchMedia('(pointer: fine)').matches),
    haptics: store.get('pref.haptics', true),
    notifications: store.get('pref.notifications', true),
    sound: store.get('pref.sound', true),
    size: store.get('pref.size', 'md'),
    fiveHourBudget: store.get('pref.fiveHourBudget', 200000),
    weeklyBudget: store.get('pref.weeklyBudget', 1500000),
  },
};
if (!AGENTS[state.agent]) state.agent = 'antigravity';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ════════════════════════════════════════════════════════════
   Utilities
   ════════════════════════════════════════════════════════════ */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const basename = (p) => (p || '').replace(/\/+$/, '').split('/').pop() || '/';
const toMs = (t) => (t > 1e12 ? t : t * 1000);

function clock(ts) {
  return new Date(toMs(ts)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function relTime(ts) {
  const diff = (Date.now() - toMs(ts)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return 'yesterday';
  return new Date(toMs(ts)).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function dayBucket(ts) {
  const d = new Date(toMs(ts));
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startToday - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return 'Older';
}

function haptic(ms = 8) {
  if (state.prefs.haptics && navigator.vibrate) navigator.vibrate(ms);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  // Plain-HTTP fallback (the clipboard API needs a secure context).
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${kind === 'err' ? icon('i-alert') : kind === 'ok' ? icon('i-check') : ''}<span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 2600);
}

function playCompletionChime() {
  if (state.prefs.sound === false) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    // First tone: E5 (659.25 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.06, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.28);

    // Second tone: A5 (880.00 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880.0, now + 0.1);
    gain2.gain.setValueAtTime(0.08, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.48);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.48);
  } catch (e) {
    /* AudioContext not allowed before user gesture */
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission !== 'denied') {
    try {
      const perm = await Notification.requestPermission();
      return perm === 'granted';
    } catch {
      return false;
    }
  }
  return false;
}

let titleFlashTimer = null;
function flashPageTitle(msg) {
  if (titleFlashTimer) clearInterval(titleFlashTimer);
  const origTitle = document.title;
  let toggle = false;
  titleFlashTimer = setInterval(() => {
    if (!document.hidden) {
      clearInterval(titleFlashTimer);
      titleFlashTimer = null;
      document.title = origTitle;
      return;
    }
    toggle = !toggle;
    document.title = toggle ? `● ${msg}` : origTitle;
  }, 1000);
}

async function notifyTaskComplete({ agent = 'Agent', content = '', sessionId = null } = {}) {
  const isBackground = document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());

  // 1. Soft audio chime (if sound preference enabled)
  playCompletionChime();

  // 2. Mobile haptic feedback
  haptic([35, 50, 35]);

  // 3. Tab title flash if page is backgrounded / away
  if (isBackground) {
    flashPageTitle(`${AGENTS[agent]?.name || 'Agent'} finished!`);
  }

  // 4. In-App Toast if user is inside the app but on another view (e.g. settings, files, history)
  if (!isBackground && state.tab !== 'chat') {
    const aName = AGENTS[agent]?.name || 'Agent';
    toast(`${aName}: Task completed!`, 'ok');
  }

  // 5. System / Browser / PWA Notification: ONLY when user has moved out of the app
  if (!isBackground) {
    return; // User is actively viewing the app, suppress OS popup notification
  }

  if (state.prefs.notifications === false || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const aName = AGENTS[agent]?.full || AGENTS[agent]?.name || 'AI Assistant';
  const cleanSnippet = (content || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, '...')
    .replace(/[#*_\n\r]+/g, ' ')
    .trim();
  const preview = cleanSnippet.length > 130 ? cleanSnippet.slice(0, 127) + '…' : (cleanSnippet || 'Task completed successfully.');

  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(`${aName} · Task Complete`, {
        body: preview,
        icon: '/static/icons/icon-192.png',
        badge: '/static/icons/icon-192.png',
        tag: `session-${sessionId || state.sessionId || 'agent'}`,
        renotify: true,
        data: { sessionId: sessionId || state.sessionId },
      });
    } else {
      new Notification(`${aName} · Task Complete`, {
        body: preview,
        icon: '/static/icons/icon-192.png',
        tag: `session-${sessionId || state.sessionId || 'agent'}`,
      });
    }
  } catch (e) {
    /* Notification failed or blocked */
  }
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/* ════════════════════════════════════════════════════════════
   Sheets (bottom sheet on phones, dialog on desktop)
   ════════════════════════════════════════════════════════════ */

let sheetResolve = null;

function openSheet(html, onMount) {
  closeSheet();
  const s = $('#sheet');
  if (s) { s.style.transform = ''; s.style.transition = ''; }
  const sc = $('#scrim');
  if (sc) { sc.style.opacity = ''; sc.style.transition = ''; }
  $('#sheetBody').innerHTML = html;
  $('#scrim').hidden = false;
  $('#sheet').hidden = false;
  if (onMount) onMount($('#sheetBody'));
  const first = $('#sheetBody [autofocus], #sheetBody .opt.selected, #sheetBody button');
  if (first) first.focus({ preventScroll: true });
}

function closeSheet(result = null) {
  $('#scrim').hidden = true;
  $('#sheet').hidden = true;
  const s = $('#sheet');
  if (s) { s.style.transform = ''; s.style.transition = ''; }
  const sc = $('#scrim');
  if (sc) { sc.style.opacity = ''; sc.style.transition = ''; }
  if (sheetResolve) { const r = sheetResolve; sheetResolve = null; r(result); }
}

function confirmSheet({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openSheet(`
      <h3>${esc(title)}</h3>
      ${message ? `<p class="lead">${esc(message)}</p>` : ''}
      <div class="sheet-actions">
        <button class="btn" data-sheet="cancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-sheet="ok" autofocus>${esc(confirm)}</button>
      </div>`);
    sheetResolve = resolve;
  });
}

$('#scrim').addEventListener('click', () => closeSheet(false));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#rail')?.classList.contains('open')) closeNav();
  else if (!$('#sheet').hidden) closeSheet(false);
  else if (vc.open) voiceClose();
});

// ── Sheet pull-to-dismiss touch gesture ────────────────────────
(function initSheetPullToDismiss() {
  const sheet = $('#sheet');
  const scrim = $('#scrim');
  const body = $('#sheetBody');
  if (!sheet || !body) return;

  let startY = 0;
  let isDragging = false;
  let startTime = 0;

  sheet.addEventListener('touchstart', (e) => {
    if (sheet.hidden || e.touches.length !== 1 || window.innerWidth >= 900) return;
    const touch = e.touches[0];
    const isGrab = !!e.target.closest('.sheet-grab');
    const atTop = body.scrollTop <= 0;

    if (isGrab || atTop) {
      startY = touch.clientY;
      startTime = Date.now();
      isDragging = isGrab;
    } else {
      startY = 0;
      isDragging = false;
    }
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!startY || e.touches.length !== 1 || window.innerWidth >= 900) return;
    const touch = e.touches[0];
    const deltaY = touch.clientY - startY;

    if (deltaY > 6) {
      if (!isDragging && body.scrollTop <= 0) {
        isDragging = true;
      }
      if (isDragging) {
        if (e.cancelable) e.preventDefault();
        sheet.style.transition = 'none';
        sheet.style.transform = `translateY(${deltaY}px)`;
        if (scrim) scrim.style.opacity = `${Math.max(0.1, 1 - deltaY / 350)}`;
      }
    } else if (deltaY <= 0 && isDragging) {
      sheet.style.transition = 'none';
      sheet.style.transform = 'translateY(0)';
      if (scrim) scrim.style.opacity = '';
    }
  }, { passive: false });

  const endDrag = (e) => {
    if (!startY || window.innerWidth >= 900) return;
    const touch = e.changedTouches ? e.changedTouches[0] : null;
    const deltaY = touch ? touch.clientY - startY : 0;
    const elapsed = Date.now() - startTime;
    const velocity = elapsed > 0 ? deltaY / elapsed : 0;

    startY = 0;
    if (isDragging) {
      isDragging = false;
      sheet.style.transition = 'transform .24s cubic-bezier(.2, .8, .2, 1)';
      if (scrim) scrim.style.transition = 'opacity .24s ease';

      if (deltaY > 90 || (velocity > 0.4 && deltaY > 25)) {
        sheet.style.transform = 'translateY(100%)';
        if (scrim) scrim.style.opacity = '0';
        setTimeout(() => {
          closeSheet(false);
        }, 220);
      } else {
        sheet.style.transform = 'translateY(0)';
        if (scrim) scrim.style.opacity = '';
        setTimeout(() => {
          sheet.style.transform = '';
          sheet.style.transition = '';
          if (scrim) scrim.style.transition = '';
        }, 240);
      }
    }
  };

  sheet.addEventListener('touchend', endDrag, { passive: true });
  sheet.addEventListener('touchcancel', endDrag, { passive: true });
})();

const MODEL_AGENTS = ['antigravity', 'claude', 'codex', 'muse'];
const MODEL_SOURCE = { antigravity: 'Antigravity', claude: 'Anthropic', codex: 'Codex', muse: 'Meta' };

function currentModel(agent = state.agent) {
  return state.modelSel[agent] || null;
}

function modelName(agent, id) {
  if (!id) return '';
  const m = ((state.models[agent] || {}).models || []).find((x) => x.id === id);
  const name = m ? m.name : id;
  return agent === 'claude' ? name.replace(/^Claude\s+/, '') : name;
}

function agentLabel(agent, model) {
  const a = AGENTS[agent] || AGENTS.antigravity;
  return model ? `${a.name} · ${modelName(agent, model)}` : a.name;
}

// Pull the live catalogs. Drops selections for models an agent no longer offers.
async function loadModels(refresh = false) {
  try {
    state.models = await api(`/api/models${refresh ? '?refresh=1' : ''}`);
    state.modelsLoadedAt = Date.now();
  } catch { return false; }
  let changed = false;
  for (const [agent, id] of Object.entries(state.modelSel)) {
    const list = (state.models[agent] || {}).models || [];
    if (id && list.length && !list.some((m) => m.id === id)) {
      delete state.modelSel[agent];
      changed = true;
      toast(`${id} is no longer offered by ${AGENTS[agent].name} — using its default`);
    }
  }
  if (changed) store.set('models', state.modelSel);
  applyAgent();
  return true;
}

function setModel(id) {
  if (id) state.modelSel[state.agent] = id; else delete state.modelSel[state.agent];
  store.set('models', state.modelSel);
  applyAgent();
}

function modelMeta(agent, cat) {
  if (!cat) return 'Loading models…';
  if (cat.source === 'none') return `Couldn't get the model list${cat.error ? ` — ${cat.error}` : ''}`;
  const when = cat.fetched_at ? `updated ${relTime(cat.fetched_at)}` : '';
  return [`${cat.models.length} models from ${MODEL_SOURCE[agent]}`, when, cat.error ? 'showing last known list' : ''].filter(Boolean).join(' · ');
}

function defaultModelSub(agent, cat) {
  if (agent === 'codex' && cat && cat.default) return `Codex config: ${cat.default}`;
  if (agent === 'claude') return cat && cat.default ? `Claude Code setting: ${cat.default}` : "Claude Code's default";
  return "Antigravity's default";
}

function openAgentSheet() {
  const agent = state.agent;
  const cat = state.models[agent];
  const sel = currentModel(agent);
  const models = (cat && cat.models) || [];
  const modelSection = MODEL_AGENTS.includes(agent) ? `
    <div class="sheet-row">
      <h4>Model</h4>
      <button class="btn btn-ghost btn-sm" data-refresh-models>${icon('i-refresh', 'xs')}Refresh</button>
    </div>
    <div class="sheet-meta">${esc(modelMeta(agent, cat))}</div>
    <div class="model-list" style="--opt-c:${AGENTS[agent].color}">
      <button class="opt sm ${!sel ? 'selected' : ''}" data-pick-model="">
        <span class="opt-main"><span class="opt-title">Default</span><br><span class="opt-sub">${esc(defaultModelSub(agent, cat))}</span></span>
        <span class="tick">${icon('i-check')}</span>
      </button>
      ${models.map((m) => `
      <button class="opt sm ${m.id === sel ? 'selected' : ''}" data-pick-model="${esc(m.id)}">
        <span class="opt-main"><span class="opt-title">${esc(m.name)}</span><br><span class="opt-sub mono">${esc(m.id)}</span>${m.description ? `<br><span class="opt-sub">${esc(m.description)}</span>` : ''}</span>
        <span class="tick">${icon('i-check')}</span>
      </button>`).join('')}
    </div>` : '';

  openSheet(`
    <h3>Agent &amp; model</h3>
    <div class="agent-tiles">${Object.entries(AGENTS).map(([k, a]) => `
      <button class="agent-tile ${k === agent ? 'selected' : ''}" style="--opt-c:${a.color}" data-pick-agent="${k}" aria-pressed="${k === agent}">
        <span class="opt-ico">${icon(a.icon)}</span><span>${esc(a.name)}</span>
      </button>`).join('')}
    </div>
    <p class="lead">${esc(AGENTS[agent].desc)}</p>
    ${modelSection}`);

  // Keep the list current without making the user wait: refresh quietly if it's been a while.
  if (MODEL_AGENTS.includes(agent) && Date.now() - state.modelsLoadedAt > 10 * 60 * 1000) {
    loadModels().then((ok) => { if (ok && !$('#sheet').hidden && $('.agent-tiles')) openAgentSheet(); });
  }
}

let browseShowHidden = false;
let currentBrowsingPath = null;

function fileIcon(ext) {
  ext = (ext || '').toLowerCase();
  if (['md', 'txt', 'rtf', 'log'].includes(ext)) return '📝';
  if (['py', 'ipynb'].includes(ext)) return '🐍';
  if (['js', 'ts', 'jsx', 'tsx', 'html', 'css', 'vue', 'json'].includes(ext)) return '🌐';
  if (['yaml', 'yml', 'toml', 'ini', 'conf', 'env'].includes(ext)) return '⚙️';
  if (['sh', 'bash', 'zsh'].includes(ext)) return '🐚';
  if (['pdf'].includes(ext)) return '📑';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return '🖼️';
  if (['zip', 'tar', 'gz', '7z', 'rar', 'bz2'].includes(ext)) return '📦';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return '🎵';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return '🎬';
  if (['sql', 'db', 'sqlite'].includes(ext)) return '🗄️';
  if (['doc', 'docx', 'odt'].includes(ext)) return '📄';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  return '📄';
}

function renderAttachmentTray() {
  const tray = $('#attachmentTray');
  if (!tray) return;
  if (!state.attachments || !state.attachments.length) {
    tray.innerHTML = '';
    tray.hidden = true;
    updateSendEnabled();
    return;
  }
  tray.hidden = false;
  tray.innerHTML = state.attachments.map((att, idx) => `
    <div class="attach-chip" title="${esc(att.path || att.url)}">
      ${att.is_image ? `<img src="${esc(att.url)}" class="attach-thumb" alt="${esc(att.name)}">` : `<span>${fileIcon(att.ext)}</span>`}
      <span class="attach-name">${esc(att.name)}</span>
      <button class="attach-del" data-del-attach="${idx}" aria-label="Remove attachment">×</button>
    </div>
  `).join('');
  updateSendEnabled();
}

function addAttachment(att) {
  if (!state.attachments) state.attachments = [];
  state.attachments.push(att);
  renderAttachmentTray();
  toast(`Attached: ${att.name}`, 'ok');
}

function removeAttachment(idx) {
  if (!state.attachments) return;
  state.attachments.splice(idx, 1);
  renderAttachmentTray();
}

async function handleFileUploads(fileList) {
  if (!fileList || !fileList.length) return;
  const form = new FormData();
  for (let i = 0; i < fileList.length; i++) {
    form.append('files', fileList[i]);
  }
  toast(`Uploading ${fileList.length} file(s)…`);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    (data.files || []).forEach(addAttachment);
  } catch (err) {
    toast(err.message || 'Upload failed', 'err');
  }
}

async function attachExternalUrl(url) {
  if (!url || !url.trim()) return;
  url = url.trim();
  toast('Fetching media from URL…');
  try {
    const data = await api('/api/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (data.file) {
      addAttachment(data.file);
      closeSheet();
    }
  } catch (err) {
    toast(err.message || 'Could not fetch URL', 'err');
  }
}

function openAttachSheet() {
  openSheet(`
    <div class="browser-header">
      <h3 style="margin:0;">Attach Media & Files</h3>
      <p class="lead" style="margin:0;">Take a photo, paste an image from clipboard, or pick files.</p>
    </div>

    <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
      <!-- Option 1: Direct Camera -->
      <button class="opt" data-action="pick-camera" style="cursor:pointer;">
        <div class="opt-ico" style="background:rgba(236, 72, 153, 0.16); color:#f472b6; font-size:20px;">📸</div>
        <div class="opt-main">
          <div class="opt-title">Take Photo (Camera)</div>
          <div class="opt-sub">Snap a photo directly with your camera to attach</div>
        </div>
      </button>

      <!-- Option 2: Device / Photos / Files -->
      <button class="opt" data-action="pick-device-file" style="cursor:pointer;">
        <div class="opt-ico" style="background:rgba(99, 102, 241, 0.16); color:#818cf8; font-size:20px;">📱</div>
        <div class="opt-main">
          <div class="opt-title">Photo Library & Files</div>
          <div class="opt-sub">Photos, screenshots, documents, PDFs, or files from device</div>
        </div>
      </button>

      <!-- Option 3: From Web / URL -->
      <div class="opt" style="flex-direction:column; align-items:stretch; gap:8px;">
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="opt-ico" style="background:rgba(16, 185, 129, 0.16); color:#34d399; font-size:20px;">🌐</div>
          <div class="opt-main">
            <div class="opt-title">From Web / External URL</div>
            <div class="opt-sub">Paste public image, media, PDF, or file link</div>
          </div>
        </div>
        <div style="display:flex; gap:6px; margin-top:4px;">
          <input id="attachUrlInput" type="url" placeholder="https://example.com/image.png" style="flex:1; background:var(--surface-2); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:13px; color:var(--text-1); outline:none;">
          <button class="btn btn-sm btn-primary" data-action="fetch-attach-url" style="padding:0 14px; font-weight:600;">Fetch</button>
        </div>
      </div>

      <!-- Option 4: From VM Storage -->
      <button class="opt" data-action="pick-vm-file" style="cursor:pointer;">
        <div class="opt-ico" style="background:rgba(245, 158, 11, 0.16); color:#fbbf24; font-size:20px;">📁</div>
        <div class="opt-main">
          <div class="opt-title">Choose from VM Storage</div>
          <div class="opt-sub">Select existing file from Personal, workspace, or root files</div>
        </div>
      </button>
    </div>

    <div class="sheet-actions" style="margin-top:8px;">
      <button class="btn btn-ghost btn-block" data-sheet="cancel">Cancel</button>
    </div>
  `);

  const inp = $('#attachUrlInput');
  if (inp) {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        attachExternalUrl(inp.value);
      }
    });
  }
}

async function openFileSheet(filePath) {
  openSheet(`
    <div style="color:var(--text-3); font-size:13px; text-align:center; padding:24px 0;">Loading file details…</div>
  `);
  try {
    const data = await api(`/api/file/view?path=${encodeURIComponent(filePath)}`);
    const parent = data.path.substring(0, data.path.lastIndexOf('/')) || '/';
    const iconStr = fileIcon(data.ext);

    openSheet(`
      <div class="browser-header">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:22px;">${iconStr}</span>
          <div style="min-width:0; flex:1;">
            <h3 style="margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(data.name)}</h3>
            <div style="font-size:12px; color:var(--text-3); font-family:var(--mono);">${esc(data.size_fmt)} · ${esc(data.ext ? '.' + data.ext : 'file')}</div>
          </div>
        </div>
        <div style="font-size:11px; color:var(--text-3); font-family:var(--mono); word-break:break-all; background:var(--surface-2); padding:6px 8px; border-radius:6px; border:1px solid var(--line);">
          ${esc(data.path)}
        </div>
      </div>

      <div class="sheet-actions" style="margin-top:2px;">
        <button class="btn btn-primary" data-attach-vm-file="${esc(data.path)}" data-name="${esc(data.name)}" data-ext="${esc(data.ext)}" data-size="${esc(data.size_fmt)}" style="height:42px;">
          📎 Attach to Chat
        </button>
        <button class="btn" data-ask-file="${esc(data.path)}" style="height:42px;">
          💬 Ask Agent
        </button>
        <button class="btn" data-copy="${esc(data.path)}" style="height:42px;">
          📋 Copy
        </button>
        <button class="btn btn-ghost" data-browse-to="${esc(parent)}" style="height:42px;">
          🔙 Back
        </button>
      </div>

      ${data.is_text && data.content !== null ? `
        <div style="margin-top:6px;">
          <div style="font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--text-3); margin-bottom:4px;">File Preview</div>
          <pre class="file-preview-box">${esc(data.content)}</pre>
        </div>
      ` : `
        <div style="color:var(--text-3); font-size:12.5px; text-align:center; padding:18px; background:var(--surface-1); border-radius:8px; border:1px solid var(--line);">
          Binary or large document (${esc(data.size_fmt)}). Available to all agents via VM path.
        </div>
      `}
    `);
  } catch (err) {
    toast(err.message || 'Could not load file', 'err');
    openWorkspaceSheet(currentBrowsingPath || '/root');
  }
}

async function openWorkspaceSheet(browsePath) {
  if (typeof browsePath === 'string' && browsePath.trim()) {
    currentBrowsingPath = browsePath.trim();
  } else {
    currentBrowsingPath = state.workspace || '/root';
  }
  const cur = currentBrowsingPath || '/root';

  openSheet(`
    <div class="browser-header">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0;">Select Folder / Workspace</h3>
        <button class="btn btn-ghost btn-sm" data-action="toggle-hidden-folders" style="font-size:11px; padding:2px 8px;">
          ${browseShowHidden ? 'Hide dotfiles' : 'Show dotfiles'}
        </button>
      </div>
      <p class="lead" style="margin:0;">Navigate any directory on the VM or type a path.</p>
    </div>
    <div style="color:var(--text-3); font-size:13px; text-align:center; padding:24px 0;">Loading folder contents…</div>
  `);

  try {
    const data = await api(`/api/browse?path=${encodeURIComponent(cur)}&show_hidden=${browseShowHidden ? 'true' : 'false'}`);
    currentBrowsingPath = data.path;

    const parts = data.path.split('/').filter(Boolean);
    let accumulated = '';
    const breadcrumbHtml = [
      `<button class="crumb-btn" data-browse-to="/">/</button>`,
      ...parts.map((part) => {
        accumulated += '/' + part;
        const target = accumulated;
        return `<button class="crumb-btn ${target === data.path ? 'active' : ''}" data-browse-to="${esc(target)}">${esc(part)}</button>`;
      })
    ].join('<span style="color:var(--text-3);">/</span>');

    const isCurrentActive = data.path === state.workspace;
    const dirs = data.dirs || [];
    const files = data.files || [];

    openSheet(`
      <div class="browser-header">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3 style="margin:0;">Select Folder / Workspace</h3>
          <button class="btn btn-ghost btn-sm" data-action="toggle-hidden-folders" style="font-size:11px; padding:2px 8px;">
            ${browseShowHidden ? 'Hide dotfiles' : 'Show dotfiles'}
          </button>
        </div>
        <p class="lead" style="margin:0;">Navigate any directory on the VM or type a path.</p>
      </div>

      <!-- Pinned Shortcuts -->
      <div class="pinned-workspaces">
        <button class="pinned-chip ${data.path === '/root/Documents/antigravity/clever-einstein' ? 'active' : ''}" data-browse-to="/root/Documents/antigravity/clever-einstein">🚀 clever-einstein</button>
        <button class="pinned-chip ${data.path === '/root/workspace/tentamus' ? 'active' : ''}" data-browse-to="/root/workspace/tentamus">🏢 tentamus</button>
        <button class="pinned-chip ${data.path === '/root/Documents/Personal' ? 'active' : ''}" data-browse-to="/root/Documents/Personal">📑 Personal</button>
        <button class="pinned-chip ${data.path === '/root/workspace' ? 'active' : ''}" data-browse-to="/root/workspace">🗂️ workspace</button>
        <button class="pinned-chip ${data.path === '/root' ? 'active' : ''}" data-browse-to="/root">🏠 /root</button>
        <button class="pinned-chip ${data.path === '/' ? 'active' : ''}" data-browse-to="/">📂 /</button>
      </div>

      <!-- Breadcrumbs & Path Input -->
      <div class="browser-crumbs">${breadcrumbHtml}</div>
      <div class="browser-path-bar">
        <span style="color:var(--text-3); font-size:14px;">📁</span>
        <input id="browserPathInput" class="browser-input" type="text" value="${esc(data.path)}" placeholder="Type or paste any path (/...)" autocomplete="off" spellcheck="false">
        <button class="btn btn-sm btn-ghost" data-action="browse-input-go" style="padding:4px 10px; font-weight:600;">Open</button>
      </div>

      ${isCurrentActive ? `<div class="current-selected-badge">${icon('i-check')} <span>Currently active workspace</span></div>` : ''}

      <!-- Directory & File List -->
      <div class="browse-list">
        ${data.parent ? `
          <button class="browse-row" data-browse-to="${esc(data.parent)}" style="color:var(--text-2);">
            <div class="browse-left">
              <span style="font-size:15px;">⬆️</span>
              <span class="browse-name">.. (Parent directory)</span>
            </div>
          </button>` : ''}
        
        ${dirs.length ? `
          <div class="browse-section-title">
            <span>📁 Folders (${dirs.length})</span>
          </div>
          ${dirs.map((d) => `
            <button class="browse-row" data-browse-to="${esc(d.path)}">
              <div class="browse-left">
                <span style="color:#60a5fa; font-size:16px;">📁</span>
                <span class="browse-name">${esc(d.name)}</span>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="color:var(--text-3);">${icon('i-chevron', 'xs')}</span>
              </div>
            </button>`).join('')}
        ` : ''}

        ${files.length ? `
          <div class="browse-section-title" style="${dirs.length ? 'margin-top:6px; border-top:1px solid var(--line); padding-top:8px;' : ''}">
            <span>📄 Files (${files.length})</span>
          </div>
          ${files.map((f) => `
            <button class="browse-row" data-view-file="${esc(f.path)}">
              <div class="browse-left">
                <span style="font-size:16px;">${fileIcon(f.ext)}</span>
                <span class="browse-name">${esc(f.name)}</span>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <span class="browse-size">${esc(f.size_fmt)}</span>
                <span style="color:var(--text-3); font-size:12px;">👁️</span>
              </div>
            </button>`).join('')}
        ` : ''}

        ${!dirs.length && !files.length ? '<div style="color:var(--text-3); font-size:13px; padding:16px; text-align:center;">(Empty directory)</div>' : ''}
      </div>

      <!-- Select Button -->
      <div class="sheet-actions" style="margin-top:4px;">
        <button class="btn btn-primary btn-block" data-select-browse-ws="${esc(data.path)}" style="height:46px; font-weight:650;">
          ${icon('i-check')} Select "${esc(data.name || data.path)}" as Workspace
        </button>
      </div>
    `);

    const inp = $('#browserPathInput');
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const target = inp.value.trim();
          if (target) openWorkspaceSheet(target);
        }
      });
    }

  } catch (err) {
    console.error('Browse error for path:', cur, err);
    if (cur !== '/root' && cur !== '/') {
      return openWorkspaceSheet('/root');
    }
    openSheet(`
      <h3>Error opening folder</h3>
      <p class="lead" style="color:var(--danger);">${esc(err.message || 'Could not open folder')}</p>
      <div class="sheet-actions">
        <button class="btn" data-browse-to="/root">Go to /root</button>
        <button class="btn" data-browse-to="/">Go to /</button>
        <button class="btn btn-primary" data-sheet="cancel">Cancel</button>
      </div>
    `);
  }
}

function openQrSheet() {
  const url = state.tunnel.active ? state.tunnel.url : location.origin;
  openSheet(`
    <h3>Open on your phone</h3>
    <p class="lead">Scan with your camera. ${state.tunnel.active ? '' : 'Start the secure tunnel in Settings for HTTPS (needed for voice and install).'}</p>
    <div class="qr-box"><img src="/api/qrcode?url=${encodeURIComponent(url)}" alt="QR code for ${esc(url)}"></div>
    <div class="qr-url">${esc(url)}</div>
    <div class="sheet-actions">
      <button class="btn" data-copy="${esc(url)}">Copy link</button>
      <button class="btn btn-primary" data-sheet="cancel">Done</button>
    </div>`);
}

/* ════════════════════════════════════════════════════════════
   Navigation & Side Drawer
   ════════════════════════════════════════════════════════════ */

const TAB_TITLES = { skills: 'Skills & MCP', terminal: 'Terminal', monitor: 'Monitor', history: 'History', settings: 'Settings' };

function openNav() {
  $('#rail')?.classList.add('open');
  const backdrop = $('#railBackdrop');
  if (backdrop) backdrop.hidden = false;
}

function closeNav() {
  $('#rail')?.classList.remove('open');
  const backdrop = $('#railBackdrop');
  if (backdrop) backdrop.hidden = true;
}

function toggleNav() {
  const rail = $('#rail');
  if (rail?.classList.contains('open')) closeNav();
  else openNav();
}

function switchTab(tab) {
  closeNav();
  state.tab = tab;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  $$('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  updateTitle();

  if (tab === 'skills') loadSkillsAndMcp();
  if (tab === 'terminal') setTimeout(openTerminal, 60);
  if (tab === 'history') loadSessions();
  if (tab === 'settings') { refreshSettings(); checkTunnel(); }
  if (tab === 'chat') { state.stick && scrollToBottom(); }
  syncMonitorPolling();
}

function updateTitle() {
  $('#viewTitle').textContent = state.tab === 'chat' ? (state.title || 'New chat') : (TAB_TITLES[state.tab] || 'AgentHub');
}

/* ════════════════════════════════════════════════════════════
   Agent / workspace selection
   ════════════════════════════════════════════════════════════ */

function applyAgent() {
  const a = AGENTS[state.agent];
  document.documentElement.style.setProperty('--agent', a.color);
  const model = currentModel();
  $('#agentChipLabel').textContent = agentLabel(state.agent, model);
  $('#agentChip').title = model ? `${a.full} · ${model}` : a.full;
  $('#voiceAgent').textContent = model ? agentLabel(state.agent, model) : a.full;
  $('#setAgentSub').textContent = model ? `${a.full} · ${modelName(state.agent, model)}` : `${a.full} · default model`;
  $('#promptInput').placeholder = state.agent === 'bash' ? 'Run a shell command…' : `Message ${a.name}…`;
  store.set('agent', state.agent);
  if (!state.messages.length) renderEmpty();
}

function setAgent(key) {
  if (!AGENTS[key]) return;
  state.agent = key;
  applyAgent();
}

function applyWorkspace() {
  $('#wsChipLabel').textContent = basename(state.workspace);
  $('#setWsSub').textContent = state.workspace;
  store.set('workspace', state.workspace);
}

function setWorkspace(path) {
  if (path === state.workspace) return;
  state.workspace = path;
  applyWorkspace();
  termStale = true;
  toast(`Workspace: ${basename(path)}`, 'ok');
}

async function loadWorkspaces() {
  try {
    state.workspaces = await api('/api/workspaces');
    if (state.workspaces.length && !state.workspaces.some((w) => w.path === state.workspace)) {
      state.workspace = state.workspaces[0].path;
      applyWorkspace();
    }
  } catch { /* offline: keep stored value */ }
}

/* ════════════════════════════════════════════════════════════
   Chat — rendering
   ════════════════════════════════════════════════════════════ */

const threadEl = () => $('#thread');

function innerThread() {
  let inner = $('.thread-inner', threadEl());
  if (!inner) {
    threadEl().innerHTML = '<div class="thread-inner"></div>';
    inner = $('.thread-inner', threadEl());
  }
  return inner;
}

function renderEmpty() {
  if (state.messages.length) return;
  threadEl().innerHTML = '';
}

const TAG_PARTIAL_RE = /^\s*(?:🚀|🟣|🟢|🔷|⚙️)(?:\s*\*(?:\[[^\n\]]*)?)?\s*$/u;

function stripTag(text) {
  const m = TAG_RE.exec(text);
  if (!m) return { text: TAG_PARTIAL_RE.test(text) ? '' : text, agent: null };
  return { text: text.slice(m[0].length), agent: AGENT_TAGS[m[1]] || null };
}

function mdToHtml(text) {
  if (!window.marked || !window.DOMPurify) return `<p style="white-space:pre-wrap">${esc(text)}</p>`;
  return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }));
}

function enhanceMarkdown(root, final) {
  $$('a', root).forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  $$('table', root).forEach((t) => {
    const w = document.createElement('div'); w.className = 'table-wrap';
    t.replaceWith(w); w.appendChild(t);
  });
  $$('pre', root).forEach((pre) => {
    const code = $('code', pre);
    const lang = (((code && code.className.match(/language-([\w+-]+)/)) || [])[1]) || '';
    if (final && window.hljs && code) {
      try {
        if (lang && hljs.getLanguage(lang)) { code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value; code.classList.add('hljs'); }
      } catch { /* leave plain */ }
    }
    const wrap = document.createElement('div');
    wrap.className = 'codeblock';
    wrap.innerHTML = `<div class="codeblock-head"><span>${esc(lang || 'text')}</span><button class="act" data-copy-code aria-label="Copy code">${icon('i-copy')}Copy</button></div>`;
    pre.replaceWith(wrap); wrap.appendChild(pre);
  });
}

// Shell replies are "```bash\n$ cmd\n```" + raw output + "*(Process exited with code N)*".
// Keep the output monospaced (columns intact) and turn the exit line into a badge.
function formatShell(text) {
  const m = /^(```bash\n\$ [^\n]*\n```\n+)([\s\S]*)$/.exec(text);
  if (!m) return text;
  let out = m[2], exit = '';
  const e = /\n*\*\(Process exited with code (-?\d+)\)\*\s*$/.exec(out);
  if (e) { out = out.slice(0, e.index); exit = e[1]; }
  out = out.replace(/\s+$/, '');
  return m[1] + (out ? `~~~~output\n${out}\n~~~~\n\n` : '')
    + (exit ? `<span class="exit ${exit === '0' ? 'ok' : 'bad'}">exit ${exit}</span>` : '');
}

function extractActivity(raw) {
  if (!raw) return null;
  const matches = [...raw.matchAll(/<!--\s*ACTIVITY:\s*({[\s\S]*?})\s*-->/g)];
  if (!matches.length) return null;
  try {
    return JSON.parse(matches[matches.length - 1][1]);
  } catch {
    return null;
  }
}

function extractAllActivities(raw) {
  if (!raw) return [];
  const matches = [...raw.matchAll(/<!--\s*ACTIVITY:\s*({[\s\S]*?})\s*-->/g)];
  const acts = [];
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed && (parsed.label || parsed.detail)) acts.push(parsed);
    } catch {}
  }
  return acts;
}

function renderBody(msgEl, final = false) {
  const { text: stripped, agent } = stripTag(msgEl._raw || '');
  const isShell = msgEl._agentKey === 'bash' || agent === 'bash';
  const cleanText = (stripped || '').replace(/<!--\s*ACTIVITY:[\s\S]*?-->/g, '').trim();
  const text = isShell ? formatShell(cleanText) : cleanText;
  const body = $('.msg-body', msgEl);
  if (!body) return;

  const currentActivity = !final ? extractActivity(msgEl._raw) : null;
  let activityHtml = '';
  if (!final && currentActivity && (currentActivity.label || currentActivity.detail)) {
    activityHtml = `
      <div class="live-activity-bar">
        <span class="live-pulse"></span>
        <span class="live-icon">${esc(currentActivity.icon || '⚡')}</span>
        <span class="live-text">
          <b>${esc(currentActivity.label)}${currentActivity.detail ? ':' : ''}</b>
          ${currentActivity.detail ? `<code>${esc(currentActivity.detail)}</code>` : ''}
        </span>
      </div>
    `;
  }

  body.innerHTML = (text ? mdToHtml(text) : '') + activityHtml;
  enhanceMarkdown(body, final);
  if (agent && msgEl._agentKey === 'auto') setMsgAgent(msgEl, agent, true);
}

function setMsgAgent(msgEl, key, routed = false) {
  const a = AGENTS[key] || AGENTS.antigravity;
  msgEl.style.setProperty('--agent', a.color);
  $('.avatar', msgEl).innerHTML = icon(a.icon);
  $('.msg-name', msgEl).textContent = routed ? `${a.name} · via Auto` : agentLabel(key, msgEl._model);
}

function addUserMessage(text, ts, attachments = []) {
  const el = document.createElement('div');
  el.className = 'msg user';
  
  let attachHtml = '';
  if (attachments && attachments.length) {
    attachHtml = `<div class="msg-attachments">${attachments.map((att) => `
      <div class="msg-attach-card">
        ${att.is_image ? `<img src="${esc(att.url)}" alt="${esc(att.name)}">` : `<span style="font-size:20px;">${fileIcon(att.ext)}</span>`}
        <div class="msg-attach-info">
          <span class="msg-attach-title">${esc(att.name)}</span>
          <span class="msg-attach-meta">${esc(att.size_fmt || 'File')}</span>
        </div>
      </div>
    `).join('')}</div>`;
  }

  el.innerHTML = `<div class="bubble">${attachHtml}${esc(text)}</div><div class="msg-time">${clock(ts)}</div>`;
  innerThread().appendChild(el);
}

function formatTokens(n) {
  if (n === 0) return '0';
  if (!n || n < 0) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function addAssistantMessage({ content = '', agent, ts, streaming = false, model = null, tokens = null }) {
  const el = document.createElement('div');
  el.className = `msg assistant${streaming ? ' streaming' : ''}`;
  const tokCount = tokens != null ? tokens : (content ? Math.max(1, Math.round(content.length / 3.8)) : null);
  const tokFmt = tokCount ? `~${formatTokens(tokCount)} tok` : '';
  const tokTitle = tokCount ? `~${tokCount.toLocaleString()} tokens consumed` : 'Tokens consumed';
  el.innerHTML = `
    <div class="msg-head">
      <span class="avatar"></span><span class="msg-name"></span>
      ${streaming ? '<span class="status-pill"><span class="live-time">Working</span></span>' : ''}
      <div class="msg-meta-right">
        <span class="msg-tokens" ${tokCount ? '' : 'hidden'} title="${esc(tokTitle)}">${icon('i-zap', 'xs')}<span class="tok-num">${esc(tokFmt)}</span></span>
        <span class="msg-time">${streaming ? '' : clock(ts)}</span>
      </div>
    </div>
    <div class="msg-body prose"></div>
    <div class="msg-actions"></div>`;
  el._raw = content;
  el._agentKey = agent;
  el._model = model;
  el._tokens = tokCount;
  innerThread().appendChild(el);
  setMsgAgent(el, agent);
  if (content) renderBody(el, true);
  if (!streaming) finishActions(el);
  return el;
}

function finishActions(el, note = '') {
  $('.msg-actions', el).innerHTML = `
    <button class="act" data-copy-msg aria-label="Copy reply">${icon('i-copy')}Copy</button>
    <button class="act" data-retry aria-label="Retry">${icon('i-refresh')}Retry</button>`;
  if (note) {
    const n = document.createElement('div');
    n.className = 'msg-note';
    n.innerHTML = `${icon('i-stop', 'xs')}${esc(note)}`;
    el.insertBefore(n, $('.msg-actions', el));
  }
  refreshRetry();
}

// Only the latest reply offers "Retry".
function refreshRetry() {
  const all = $$('.msg.assistant [data-retry]');
  all.forEach((b, i) => { b.hidden = i !== all.length - 1; });
}

/* ── scrolling ─────────────────────────────────────────── */

function scrollToBottom(force = false) {
  const t = threadEl();
  if (force || state.stick) t.scrollTop = t.scrollHeight;
}

function onThreadScroll() {
  const t = threadEl();
  const gap = t.scrollHeight - t.scrollTop - t.clientHeight;
  state.stick = gap < 80;
  $('#jumpBtn').hidden = state.stick || !state.messages.length;
}

/* ════════════════════════════════════════════════════════════
   Chat — sending & streaming
   ════════════════════════════════════════════════════════════ */

function setStreaming(on) {
  state.streaming = on;
  const b = $('#sendBtn');
  b.classList.toggle('stop', on);
  b.innerHTML = icon(on ? 'i-stop' : 'i-send');
  b.setAttribute('aria-label', on ? 'Stop' : 'Send');
  b.disabled = false;
  updateSendEnabled();
}

function updateSendEnabled() {
  if (state.streaming) return;
  const hasPrompt = !!$('#promptInput')?.value.trim();
  const hasAttachments = !!(state.attachments && state.attachments.length);
  const btn = $('#sendBtn');
  if (btn) btn.disabled = !hasPrompt && !hasAttachments;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read a run's output into `el`. The agent runs on the server, so if the connection drops
// (phone locked, tunnel hiccup) we reattach and replay instead of failing.
async function followRun(el, ctrl, schedule, open) {
  let attached = false;
  for (let tries = 0; ;) {
    try {
      const res = await open();
      if (!res.ok) { const e = new Error(`Server returned ${res.status}`); e.status = res.status; throw e; }
      attached = true;
      el._reconnecting = false;
      const sid = res.headers.get('X-Session-ID');
      if (sid && sid !== state.sessionId) { state.sessionId = sid; store.set('session', sid); }
      el._raw = '';                               // reattach replays the run from the start
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        el._raw += dec.decode(value, { stream: true });
        schedule();
      }
      el._raw += dec.decode();
      return { stopped: false, failed: '' };
    } catch (err) {
      if (ctrl.signal.aborted) return { stopped: true, failed: '' };
      const sid = state.sessionId;
      if (!attached || !sid || err.status || ++tries > 30) return { stopped: false, failed: err.message || 'Connection lost' };

      el._reconnecting = true;
      await sleep(Math.min(800 * tries, 4000));
      if (ctrl.signal.aborted) return { stopped: true, failed: '' };
      let info;
      try { info = await api(`/api/runs/${encodeURIComponent(sid)}`); } catch { continue; }   // still offline
      if (info.status === 'none') {                 // server forgot the run — fall back to what was saved
        try {
          const data = await api(`/api/sessions/${encodeURIComponent(sid)}`);
          const last = (data.messages || []).filter((m) => m.role === 'assistant').pop();
          if (last) { el._raw = last.content; return { stopped: false, failed: '' }; }
        } catch { /* fall through */ }
        return { stopped: false, failed: 'Connection lost' };
      }
      open = () => fetch(`/api/runs/${encodeURIComponent(sid)}/stream`, { signal: ctrl.signal });
    }
  }
}

// Show a run in the thread: streaming UI, then finalise the message.
async function drive(el, agentKey, open, { newTitle = '' } = {}) {
  const epoch = state.epoch;
  const ctrl = new AbortController();
  state.abort = ctrl;
  setStreaming(true);

  const started = Date.now();
  const pill = $('.status-pill', el);
  const updatePill = () => {
    if (!pill) return;
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const timeStr = el._reconnecting ? 'Reconnecting…' : `Working · ${elapsed}s`;
    const curAct = extractActivity(el._raw);

    if (curAct && (curAct.label || curAct.detail)) {
      const iconStr = curAct.icon ? `<span class="live-op-icon">${esc(curAct.icon)}</span>` : '';
      const labelStr = curAct.label ? `<span class="live-op-label">${esc(curAct.label)}${curAct.detail ? ':' : ''}</span>` : '';
      const detailStr = curAct.detail ? `<span class="live-op-detail">${esc(curAct.detail)}</span>` : '';
      pill.innerHTML = `<span class="live-time">${timeStr}</span><span class="live-sep">·</span><span class="live-op" title="${esc(curAct.label + (curAct.detail ? ': ' + curAct.detail : ''))}">${iconStr}${labelStr}${detailStr}</span>`;
    } else {
      pill.innerHTML = `<span class="live-time">${timeStr}</span>`;
    }
  };
  const tick = setInterval(updatePill, 800);

  let frame = 0, lastRender = 0;
  const updateStreamingTokens = () => {
    const rawLen = el._raw ? el._raw.length : 0;
    if (!rawLen) return;
    const pLen = state.lastPromptLength || 0;
    const est = Math.max(1, Math.round((rawLen + pLen) / 3.8));
    const tokEl = $('.msg-tokens', el);
    if (tokEl) {
      tokEl.hidden = false;
      const numEl = $('.tok-num', tokEl);
      if (numEl) numEl.textContent = `~${formatTokens(est)} tok`;
      tokEl.title = `~${est.toLocaleString()} tokens consumed`;
    }
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const n = performance.now();
      if (n - lastRender < 70) { schedule(); return; }   // cap re-parse rate on long outputs
      lastRender = n;
      renderBody(el);
      updatePill();
      if (vc.open && el._raw) {
        const spoken = speakable(el._raw);
        const replyEl = $('#voiceReply');
        if (replyEl) replyEl.textContent = spoken.display;
      }
      updateStreamingTokens();
      scrollToBottom();
    });
  };

  const { stopped, failed } = await followRun(el, ctrl, schedule, (open && (() => open(ctrl.signal))));
  clearInterval(tick);
  cancelAnimationFrame(frame);
  state.abort = null;

  if (epoch !== state.epoch) {            // the user moved to another conversation; the run continues server-side
    setStreaming(false);
    loadSessions(true);
    return null;
  }

  el.classList.remove('streaming');
  pill?.remove();
  $('.msg-time', el).textContent = clock(Date.now() / 1000);
  renderBody(el, true);

  const pLen = state.lastPromptLength || 0;
  const finalTokens = Math.max(1, Math.round(((el._raw ? el._raw.length : 0) + pLen) / 3.8));
  const tokEl = $('.msg-tokens', el);
  if (tokEl && el._raw && el._raw.length > 0) {
    tokEl.hidden = false;
    const numEl = $('.tok-num', tokEl);
    if (numEl) numEl.textContent = `~${formatTokens(finalTokens)} tok`;
    tokEl.title = `~${finalTokens.toLocaleString()} tokens consumed`;
  }

  if (failed) {
    const n = document.createElement('div');
    n.className = 'msg-note';
    n.innerHTML = `${icon('i-alert', 'xs')}${esc(failed)}`;
    $('.msg-body', el).after(n);
  }
  state.messages.push({ role: 'assistant', content: el._raw, agent: agentKey, ts: Date.now() / 1000, model: el._model, tokens: finalTokens });
  finishActions(el, stopped ? 'Stopped' : '');
  setStreaming(false);
  scrollToBottom();
  haptic(14);
  if (!stopped && !failed) {
    notifyTaskComplete({ agent: agentKey, content: el._raw, sessionId: state.sessionId });
  }

  if (newTitle && state.sessionId) { state.title = newTitle; updateTitle(); }
  loadSessions(true);
  return { text: el._raw, stopped: !!stopped, failed };
}

async function send(textArg, opts = {}) {
  if (state.streaming) return null;
  const input = $('#promptInput');
  const prompt = (textArg ?? input.value).trim();
  const attachments = [...(state.attachments || [])];
  
  if (!prompt && !attachments.length) return null;

  // One reply at a time per conversation: don't pile a message onto a run that's still working.
  if (state.sessionId) {
    const r = await api(`/api/runs/${encodeURIComponent(state.sessionId)}`).catch(() => ({ running: false }));
    if (r.running) { toast('Still working on your last message — it will appear here when done'); return null; }
  }

  state.attachments = [];
  renderAttachmentTray();

  if (textArg === undefined) { input.value = ''; autosize(); store.set('draft', ''); }
  haptic();

  if (!state.messages.length) threadEl().innerHTML = '';
  const now = Date.now() / 1000;
  const agentKey = state.agent;
  
  let enrichedPrompt = prompt;
  if (attachments.length) {
    const attachLines = attachments.map((a) => `- ${a.name} (${a.size_fmt || 'Media'}): ${a.path || a.url}`).join('\n');
    enrichedPrompt = `[Attached Media & Files from External Source]:\n${attachLines}\n\n${prompt || 'Please analyze the attached media/files.'}`;
  }

  state.lastPromptLength = enrichedPrompt.length;
  const userText = prompt || (attachments.length ? `Attached ${attachments.length} file(s)` : '');
  const userTokens = Math.max(1, Math.round(enrichedPrompt.length / 3.8));
  state.messages.push({ role: 'user', content: userText, agent: agentKey, ts: now, attachments, tokens: userTokens });
  addUserMessage(userText, now, attachments);

  const model = agentKey === 'bash' || agentKey === 'auto' ? null : currentModel(agentKey);
  const el = addAssistantMessage({ agent: agentKey, streaming: true, model });
  state.stick = true;
  scrollToBottom(true);
  $('#jumpBtn').hidden = true;

  const body = JSON.stringify({ prompt: enrichedPrompt, agent: agentKey, model, workspace: state.workspace, session_id: state.sessionId, voice: !!opts.voice });
  const displayTitle = prompt || attachments[0]?.name || 'Media chat';
  const newTitle = state.sessionId ? '' : (displayTitle.length > 40 ? displayTitle.slice(0, 40) + '…' : displayTitle);
  return drive(el, agentKey, (signal) => fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }), { newTitle });
}

// Stop = cancel the run on the server (kills the agent), then detach.
function stopStreaming() {
  if (state.sessionId) fetch(`/api/runs/${encodeURIComponent(state.sessionId)}/stop`, { method: 'POST' }).catch(() => {});
  if (state.abort) state.abort.abort();
}

// Detach = stop watching, but let the agent keep running in the background.
function detachStreaming() {
  state.epoch++;
  if (state.abort) state.abort.abort();
}

function retryLast() {
  if (state.streaming) return;
  const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
  if (lastUser) send(lastUser.content);
}

function newChat() {
  if (state.streaming) detachStreaming();
  state.epoch++;
  state.sessionId = null;
  state.title = '';
  state.messages = [];
  store.set('session', null);
  state.stick = true;
  $('#jumpBtn').hidden = true;
  renderEmpty();
  updateTitle();
  switchTab('chat');
  $('#promptInput').focus();
  renderRail();
}

async function openSession(id) {
  if (state.streaming && id === state.sessionId) { switchTab('chat'); return; }
  try {
    const [data, run] = await Promise.all([
      api(`/api/sessions/${encodeURIComponent(id)}`),
      api(`/api/runs/${encodeURIComponent(id)}`).catch(() => ({ running: false })),
    ]);
    if (state.streaming) detachStreaming();
    state.epoch++;
    state.sessionId = data.id;
    state.title = data.title || '';
    state.messages = (data.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
      agent: m.agent || data.agent,
      model: m.model || null,
      tokens: m.tokens != null ? m.tokens : null,
      ts: m.timestamp
    }));
    store.set('session', data.id);
    if (AGENTS[data.agent]) setAgent(data.agent);
    if (data.workspace) { state.workspace = data.workspace; applyWorkspace(); }

    threadEl().innerHTML = '';
    if (!state.messages.length) renderEmpty();
    state.messages.forEach((m) => {
      if (m.role === 'user') addUserMessage(m.content, m.ts);
      else addAssistantMessage({ content: m.content, agent: AGENTS[m.agent] ? m.agent : 'antigravity', ts: m.ts, model: m.model, tokens: m.tokens });
    });
    state.stick = true;
    switchTab('chat');
    scrollToBottom(true);
    renderRail();

    if (run.running) {           // the agent is still working in the background — pick up where it is
      const agentKey = AGENTS[run.agent] ? run.agent : state.agent;
      const el = addAssistantMessage({ agent: agentKey, streaming: true, model: run.model || null });
      scrollToBottom(true);
      drive(el, agentKey, (signal) => fetch(`/api/runs/${encodeURIComponent(id)}/stream`, { signal }));
    }
  } catch {
    toast('Could not load that conversation', 'err');
    if (store.get('session') === id) store.set('session', null);
  }
}

/* ════════════════════════════════════════════════════════════
   Composer
   ════════════════════════════════════════════════════════════ */

function autosize() {
  const t = $('#promptInput');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 168) + 'px';
  updateSendEnabled();
}

function updateHint() {
  const hint = $('#composerHint');
  hint.textContent = window.matchMedia('(pointer: fine)').matches
    ? (state.prefs.enter ? 'Enter to send · Shift+Enter for a new line' : 'Enter for a new line · use the button to send')
    : '';
}

/* ════════════════════════════════════════════════════════════
   Voice input
   ════════════════════════════════════════════════════════════ */

const voice = { recorder: null, stream: null, chunks: [], timer: null, t0: 0, cancelled: false, speech: null, active: false };

function recUI(show, label = 'Listening…', busy = false) {
  $('#recBar').hidden = !show;
  $('#recBar').classList.toggle('busy', busy);
  $('#recLabel').textContent = label;
}

function secureSheet(what) {
  const secure = state.tunnel.active && state.tunnel.url;
  openSheet(`
    <h3>${what} needs HTTPS</h3>
    <p class="lead">Browsers only allow the microphone on secure pages. ${secure ? 'Open the secure tunnel link to continue.' : 'Start the secure tunnel in Settings, then open that link.'}</p>
    <div class="sheet-actions">
      <button class="btn" data-sheet="cancel">Not now</button>
      ${secure ? `<a class="btn btn-primary" href="${esc(state.tunnel.url)}">Open secure link</a>` : '<button class="btn btn-primary" data-goto="settings">Go to Settings</button>'}
    </div>`);
}

async function toggleMic() {
  if (voice.active) return stopMic();
  startMic();
}

async function startMic() {
  const hasRecorder = navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && window.isSecureContext;
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!hasRecorder && !(Speech && window.isSecureContext)) { secureSheet('Voice'); return; }

  voice.cancelled = false;
  voice.active = true;
  $('#micBtn').classList.add('listening');
  haptic();

  try {
    if (!hasRecorder) throw new Error('no-recorder');
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voice.chunks = [];
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
    voice.recorder = type ? new MediaRecorder(voice.stream, { mimeType: type }) : new MediaRecorder(voice.stream);
    voice.recorder.ondataavailable = (e) => { if (e.data && e.data.size) voice.chunks.push(e.data); };
    voice.recorder.onstop = onRecorderStop;
    voice.recorder.start();
    startRecTimer();
    recUI(true, 'Listening…');
  } catch (err) {
    releaseStream();
    if (Speech && window.isSecureContext) return startSpeechFallback(Speech);
    endMic();
    toast(err && err.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Could not access the microphone', 'err');
  }
}

function startSpeechFallback(Speech) {
  try {
    const r = new Speech();
    r.interimResults = true; r.continuous = false; r.lang = navigator.language || 'en-US';
    const input = $('#promptInput');
    const base = input.value ? input.value.trim() + ' ' : '';
    r.onresult = (e) => {
      let t = '';
      for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
      input.value = base + t.trim(); autosize();
    };
    r.onerror = r.onend = () => endMic();
    voice.speech = r;
    r.start();
    startRecTimer();
    recUI(true, 'Listening…');
  } catch { endMic(); toast('Voice input unavailable', 'err'); }
}

function startRecTimer() {
  voice.t0 = Date.now();
  $('#recTime').textContent = '0:00';
  clearInterval(voice.timer);
  voice.timer = setInterval(() => {
    const s = Math.floor((Date.now() - voice.t0) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
}

function stopMic() {
  if (voice.recorder && voice.recorder.state !== 'inactive') {
    recUI(true, 'Transcribing…', true);
    voice.recorder.stop();          // → onRecorderStop
  } else if (voice.speech) {
    voice.speech.stop();
  } else endMic();
}

function cancelMic() {
  voice.cancelled = true;
  if (voice.recorder && voice.recorder.state !== 'inactive') voice.recorder.stop();
  else if (voice.speech) { voice.speech.onend = null; voice.speech.abort(); endMic(); }
  else endMic();
}

function releaseStream() {
  if (voice.stream) voice.stream.getTracks().forEach((t) => t.stop());
  voice.stream = null;
}

function endMic() {
  clearInterval(voice.timer);
  releaseStream();
  voice.recorder = null; voice.speech = null; voice.active = false;
  $('#micBtn').classList.remove('listening');
  recUI(false);
}

async function onRecorderStop() {
  const mime = (voice.recorder && voice.recorder.mimeType) || 'audio/mp4';
  releaseStream();
  if (voice.cancelled) return endMic();
  try {
    const blob = new Blob(voice.chunks, { type: mime });
    if (blob.size > 200) {
      const fd = new FormData();
      const ext = mime.includes('mp4') ? 'mp4' : mime.includes('webm') ? 'webm' : 'wav';
      fd.append('file', blob, `speech.${ext}`);
      const curAgent = state.agent || 'antigravity';
      const data = await api(`/api/transcribe?agent=${encodeURIComponent(curAgent)}`, { method: 'POST', body: fd });
      const text = (data.transcript || '').trim();
      if (text) {
        const input = $('#promptInput');
        input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text;
        autosize(); input.focus();
        store.set('draft', input.value);
      } else toast("Didn't catch that — try again");
    }
  } catch { toast('Transcription failed', 'err'); }
  endMic();
}

/* ════════════════════════════════════════════════════════════
   Voice conversation — talk, agent replies out loud
   listen (auto-stops on silence) → transcribe → agent → speak → listen…
   ════════════════════════════════════════════════════════════ */

const vc = {
  open: false, phase: 'idle', stream: null, ctx: null, analyser: null, raf: 0, recorder: null, chunks: [],
  heard: false, cancelled: false, t0: 0, lastVoice: 0, floor: 0.008, wake: null, run: 0,
  muted: store.get('voiceMuted', false),
};
const vcFoot = () => 'Pause to send · tap the orb to interrupt';
const VC_LABEL = { idle: 'Tap to talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };
const hasTTS = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;   // fallback voice only

// Replies are played through one reusable <audio> element. iOS only lets an element play once
// it has been started by a tap, so voiceOpen() "unlocks" it; it then ignores the silent switch.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const ttsAudio = new Audio();
ttsAudio.preload = 'auto';
ttsAudio.setAttribute('playsinline', '');

function unlockAudio() {
  try {
    ttsAudio.src = SILENT_WAV;
    const p = ttsAudio.play();
    if (p && p.catch) p.catch(() => {});
    if (hasTTS) speechSynthesis.speak(new SpeechSynthesisUtterance(''));   // unlocks the fallback too
  } catch { /* best effort */ }
}

function vcPhase(phase, label) {
  clearInterval(vc.tt);
  $('#voiceFoot').textContent = vcFoot();
  if (phase === 'thinking' && !label) {
    const t0 = Date.now();
    vc.tt = setInterval(() => {
      const secs = Math.floor((Date.now() - t0) / 1000);
      $('#voiceState').textContent = secs >= 3 ? `Thinking… ${secs}s` : 'Thinking…';
      if (secs >= 20) $('#voiceFoot').textContent = 'Taking a while — the agent keeps working even if you close this';
    }, 1000);
  }
  vc.phase = phase;
  $('#orb').dataset.phase = phase;
  $('#voiceState').textContent = label || VC_LABEL[phase];
  $('#orb').setAttribute('aria-label', { idle: 'Talk', listening: 'Send now', thinking: 'Cancel', speaking: 'Interrupt and talk' }[phase]);
  if (phase !== 'listening') $('#orb').style.setProperty('--lvl', 0);
}

function vcSyncMute() {
  const b = $('#voiceMute');
  b.setAttribute('aria-pressed', String(vc.muted));
  b.innerHTML = icon(vc.muted ? 'i-volume-off' : 'i-volume');
  b.setAttribute('aria-label', vc.muted ? 'Unmute spoken replies' : 'Mute spoken replies');
}

async function voiceOpen() {
  unlockAudio();                                 // must happen synchronously inside the tap
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
  $('#promptInput')?.blur();
  if (state.streaming) { toast('Wait for the current reply or stop it first'); return; }
  const hasMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!hasMedia && !window.isSecureContext) { secureSheet('Voice conversation'); return; }
  // Voice follows your selected agent (Antigravity→Gemini, Claude→Claude, Codex→GPT).
  // Shell isn't conversational, so fall back to your last voice agent or Claude.
  vc.prevAgent = state.agent;
  if (state.agent === 'bash') {
    const va = store.get('voiceAgent', 'claude');
    setAgent(AGENTS[va] && va !== 'bash' ? va : 'claude');
  }
  try {
    vc.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    toast(err && err.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Could not access the microphone', 'err');
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    try {
      vc.ctx = new AC();
      if (vc.ctx.state === 'suspended') vc.ctx.resume();
      vc.analyser = vc.ctx.createAnalyser();
      vc.analyser.fftSize = 1024;
      vc.ctx.createMediaStreamSource(vc.stream).connect(vc.analyser);
    } catch (e) {
      console.warn('AudioContext setup error', e);
    }
  }
  try { if (navigator.wakeLock) vc.wake = await navigator.wakeLock.request('screen'); } catch { /* optional */ }

  vc.open = true; vc.run++;
  document.body.classList.add('voice-mode');
  const a = AGENTS[state.agent] || AGENTS.antigravity;
  $('#voice').style.setProperty('--agent', a.color);
  $('#voiceAgent').textContent = currentModel(state.agent) ? agentLabel(state.agent, currentModel(state.agent)) : a.full;
  $('#voiceYou').textContent = ''; $('#voiceReply').textContent = '';
  vcSyncMute();
  $('#voice').hidden = false;
  vcListen();
}

function voiceClose() {
  if (!vc.open) return;
  vc.open = false; vc.run++;
  document.body.classList.remove('voice-mode');
  cancelAnimationFrame(vc.raf);
  if (vc.recorder && vc.recorder.state !== 'inactive') { vc.cancelled = true; try { vc.recorder.stop(); } catch { /* already stopped */ } }
  stopSpeaking();
  if (state.streaming) detachStreaming();      // the agent keeps working; the reply lands in the chat
  clearInterval(vc.tt);
  if (vc.stream) vc.stream.getTracks().forEach((t) => t.stop());
  if (vc.ctx) vc.ctx.close().catch(() => {});
  if (vc.wake) vc.wake.release().catch(() => {});
  vc.stream = vc.ctx = vc.analyser = vc.recorder = vc.wake = null;
  $('#voice').hidden = true;
  vcPhase('idle');
  if (vc.prevAgent) { setAgent(vc.prevAgent); vc.prevAgent = null; }
  scrollToBottom(true);
}

function vcListen() {
  if (!vc.open) return;
  vc.chunks = []; vc.heard = false; vc.cancelled = false;
  vc.t0 = vc.lastVoice = performance.now();
  vc.floor = 0.006;
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  try {
    vc.recorder = type ? new MediaRecorder(vc.stream, { mimeType: type }) : new MediaRecorder(vc.stream);
  } catch {
    vc.recorder = new MediaRecorder(vc.stream);
  }
  vc.recorder.ondataavailable = (e) => { if (e.data && e.data.size) vc.chunks.push(e.data); };
  const run = vc.run;
  vc.recorder.onstop = () => vcHandleAudio(run);
  vc.recorder.start(250);
  vcPhase('listening');
  haptic(6);
  if (vc.analyser) vcMeter(run);
}

// Level meter + voice-activity detection: stop ~1.3 s after you stop talking.
function vcMeter(run) {
  if (!vc.analyser) return;
  const buf = new Uint8Array(vc.analyser.fftSize);
  const tick = () => {
    if (!vc.open || run !== vc.run || vc.phase !== 'listening') return;
    vc.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();
    if (now - vc.t0 < 500) vc.floor = Math.max(vc.floor, Math.min(rms * 1.2, 0.04));      // calibrate to room noise
    const loud = rms > Math.max(0.012, vc.floor * 1.5);
    if (loud) { vc.heard = true; vc.lastVoice = now; }
    $('#orb').style.setProperty('--lvl', Math.min(1, rms * 10).toFixed(2));

    if (vc.heard && now - vc.lastVoice > 1300) return vcStopListening();
    if (!vc.heard && now - vc.t0 > 12000) { vc.cancelled = true; vcStopListening(); vcPhase('idle', 'Tap to talk'); return; }
    if (now - vc.t0 > 60000) return vcStopListening();
    vc.raf = requestAnimationFrame(tick);
  };
  vc.raf = requestAnimationFrame(tick);
}

function vcStopListening() {
  cancelAnimationFrame(vc.raf);
  if (vc.recorder && vc.recorder.state !== 'inactive') vc.recorder.stop();   // → vcHandleAudio
}

async function vcHandleAudio(run) {
  if (!vc.open || run !== vc.run) return;
  if (vc.cancelled) { if (vc.phase === 'listening') vcPhase('idle'); return; }
  vcPhase('thinking', 'Transcribing…');
  let text = '';
  try {
    const mime = (vc.recorder && vc.recorder.mimeType) || 'audio/mp4';
    const blob = new Blob(vc.chunks, { type: mime });
    if (blob.size < 200) { vcPhase('idle', 'Tap to talk'); return; }
    const fd = new FormData();
    const ext = mime.includes('mp4') ? 'mp4' : mime.includes('webm') ? 'webm' : 'wav';
    fd.append('file', blob, `speech.${ext}`);
    const curAgent = state.agent || 'antigravity';
    text = ((await api(`/api/transcribe?agent=${encodeURIComponent(curAgent)}`, { method: 'POST', body: fd })).transcript || '').trim();
  } catch (e) {
    console.error('Transcription error:', e);
    toast('Transcription failed', 'err');
  }
  if (!vc.open || run !== vc.run) return;
  if (!text) { toast("Didn't catch that"); return vcListen(); }

  $('#voiceYou').textContent = text;
  $('#voiceReply').textContent = '';
  vcPhase('thinking');
  const res = await send(text, { voice: true });
  if (!vc.open || run !== vc.run) return;
  if (!res) return vcPhase('idle', 'Still working on the last one');
  if (res.stopped) return vcPhase('idle');
  if (res.failed) { toast(res.failed, 'err'); return vcPhase('idle'); }

  const spoken = speakable(res.text);
  $('#voiceReply').textContent = spoken.display;
  haptic(12);
  if (vc.muted || !spoken.chunks.length) return vcListen();
  vcSpeak(spoken.chunks, run);
}

// Turn a markdown reply into short speakable chunks (sentences), skipping code.
function speakable(md) {
  let t = stripTag(md).text;
  t = t.replace(/(~{3,}|`{3,})[\s\S]*?\1/g, ' (code omitted) ')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, '')
    .replace(/[*_>#|~]/g, '')
    .replace(/(code omitted\)\s*)+/g, 'code omitted) ');
  const display = t.replace(/\n{3,}/g, '\n\n').trim();
  let flat = t.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => (/[.!?:)]$/.test(l) ? l : l + '.')).join(' ');
  let cut = false;
  if (flat.length > 900) { flat = flat.slice(0, 900).replace(/[^.!?]*$/, '') || flat.slice(0, 900); cut = true; }
  const chunks = (flat.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || []).map((c) => c.trim()).filter(Boolean);
  if (cut) chunks.push('The rest is on screen.');
  return { chunks, display: display || '…' };
}

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const lang = (navigator.language || 'en-US').toLowerCase();
  const same = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)));
  const pool = same.length ? same : voices;
  return pool.find((v) => /premium|enhanced|natural|neural|google|samantha|daniel|karen/i.test(v.name)) || pool.find((v) => v.lang.toLowerCase() === lang) || pool[0] || null;
}

function ttsFetch(text, agent = state.agent) {
  return fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, agent }) })
    .then((r) => { if (!r.ok) throw new Error(`TTS ${r.status}`); return r.blob(); })
    .then((b) => URL.createObjectURL(b));
}

// Play one audio URL; resolves when it ends, errors or is paused (interrupt).
function playUrl(url) {
  return new Promise((resolve, reject) => {
    const done = (err) => { ttsAudio.removeEventListener('ended', onEnd); ttsAudio.removeEventListener('pause', onEnd); ttsAudio.removeEventListener('error', onErr); err ? reject(err) : resolve(); };
    const onEnd = () => done();
    const onErr = () => done(new Error('audio error'));
    ttsAudio.addEventListener('ended', onEnd);
    ttsAudio.addEventListener('pause', onEnd);
    ttsAudio.addEventListener('error', onErr);
    ttsAudio.src = url;
    ttsAudio.play().catch(done);
  });
}

// Settings → "Test spoken reply": plays a sample through exactly the path voice mode uses.
async function testVoice() {
  unlockAudio();
  const btn = $('#testVoiceBtn');
  btn.disabled = true; btn.textContent = 'Playing…';
  try {
    const url = await ttsFetch('Hello! This is your agent speaking. If you can hear this, voice replies are working.');
    await playUrl(url);
    URL.revokeObjectURL(url);
    toast('Played — did you hear it?', 'ok');
  } catch (err) {
    toast(`Audio failed: ${err && (err.name || err.message) || 'unknown'}`, 'err');
  }
  btn.disabled = false; btn.textContent = 'Test';
}

function stopSpeaking() {
  try { ttsAudio.pause(); } catch { /* ignore */ }
  if (hasTTS) speechSynthesis.cancel();
}

async function vcSpeak(chunks, run) {
  vcPhase('speaking');
  const live = () => vc.open && run === vc.run && vc.phase === 'speaking';
  let pending = ttsFetch(chunks[0]);
  try {
    for (let i = 0; i < chunks.length && live(); i++) {
      const url = await pending;
      pending = i + 1 < chunks.length ? ttsFetch(chunks[i + 1]) : null;   // synthesise the next sentence while this one plays
      pending && pending.catch(() => {});
      if (!live()) { URL.revokeObjectURL(url); break; }
      try { await playUrl(url); } finally { URL.revokeObjectURL(url); }
    }
  } catch (err) {
    if (!live()) return;
    if (hasTTS) return vcSpeakFallback(chunks, run);        // server voice unavailable → browser voice
    toast(`Could not play audio (${err && (err.name || err.message) || 'unknown'})`, 'err');
  }
  if (live()) vcListen();
}

function vcSpeakFallback(chunks, run) {
  speechSynthesis.cancel();
  const voice = pickVoice();
  let i = 0;
  const next = () => {
    if (!vc.open || run !== vc.run || vc.phase !== 'speaking') return;
    if (i >= chunks.length) return vcListen();
    const u = new SpeechSynthesisUtterance(chunks[i++]);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.onend = next; u.onerror = next;
    speechSynthesis.speak(u);
  };
  next();
}

function vcOrbTap() {
  unlockAudio();
  haptic(10);
  if (vc.phase === 'idle') {
    vcListen();
  } else if (vc.phase === 'listening') {
    vc.heard = true;
    vc.cancelled = false;
    vcStopListening();
  } else if (vc.phase === 'thinking') {
    vc.run++;
    if (state.streaming) stopStreaming();
    vcPhase('idle');
  } else if (vc.phase === 'speaking') {
    stopSpeaking();
    vcListen();
  }
}

/* ════════════════════════════════════════════════════════════
   Terminal
   ════════════════════════════════════════════════════════════ */

let term = null, fit = null, termSock = null, termStale = false, termFont = store.get('termFont', 13), ctrlOn = false;

function setTermStatus(kind, text) {
  $('#termDot').className = `conn-dot ${kind}`;
  $('#termStatus').textContent = text;
}

function openTerminal() {
  if (!window.Terminal || !window.FitAddon) { setTermStatus('bad', 'Terminal library failed to load'); return; }
  if (!term) {
    term = new Terminal({
      cursorBlink: true, fontSize: termFont, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 5000, allowProposedApi: true,
      theme: { background: '#06060a', foreground: '#ededf1', cursor: '#7c8cff', selectionBackground: 'rgba(124,140,255,.35)',
        black: '#1a1a20', red: '#f87171', green: '#34d399', yellow: '#fbbf24', blue: '#7c8cff', magenta: '#c79bff', cyan: '#5fd4e8', white: '#ededf1' },
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('#terminal-view'));
    term.onData(onTermData);
    term.onResize(({ rows, cols }) => sendTerm(`__RESIZE__:${rows}:${cols}`));
    new ResizeObserver(() => { try { if (state.tab === 'terminal') fit.fit(); } catch { /* hidden */ } }).observe($('#terminal-view'));
  }
  try { fit.fit(); } catch { /* not laid out yet */ }
  if (!termSock || termSock.readyState > 1 || termStale) connectTerm();
  term.focus();
}

function connectTerm() {
  if (termSock) { termSock.onclose = null; termSock.close(); }
  if (termStale) { term.reset(); termStale = false; }
  setTermStatus('wait', 'Connecting…');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal?cwd=${encodeURIComponent(state.workspace)}`);
  termSock = ws;
  ws.onopen = () => { setTermStatus('ok', 'Connected'); try { fit.fit(); } catch {} sendTerm(`__RESIZE__:${term.rows}:${term.cols}`); };
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = () => { if (termSock === ws) { setTermStatus('bad', 'Disconnected · shell ended'); term.write('\r\n\x1b[90m[session closed — tap Reconnect]\x1b[0m\r\n'); } };
  ws.onerror = () => setTermStatus('bad', 'Connection error');
}

function sendTerm(data) {
  if (termSock && termSock.readyState === WebSocket.OPEN) termSock.send(data);
}

function onTermData(data) {
  if (ctrlOn && data.length === 1) {
    const c = data.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64);
    setCtrl(false);
  }
  sendTerm(data);
}

function setCtrl(on) {
  ctrlOn = on;
  $('#ctrlKey').classList.toggle('on', on);
}

const KEYS = { esc: '\x1b', tab: '\t', '^C': '\x03', '^D': '\x04', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', clear: '\x0c' };

function pressKey(k) {
  haptic(5);
  if (k === 'ctrl') return setCtrl(!ctrlOn);
  let data = KEYS[k] ?? k;
  if (ctrlOn && data.length === 1) { onTermData(data); return; }
  sendTerm(data);
  term && term.focus();
}

function termFontDelta(d) {
  termFont = Math.max(9, Math.min(22, termFont + d));
  store.set('termFont', termFont);
  if (term) { term.options.fontSize = termFont; try { fit.fit(); } catch {} }
}

/* ════════════════════════════════════════════════════════════
   Monitor
   ════════════════════════════════════════════════════════════ */

const hist = { cpu: [], mem: [] };
let monTimer = null;

function syncMonitorPolling() {
  const want = state.tab === 'monitor' && !document.hidden;
  if (want && !monTimer) { pollSystem(); monTimer = setInterval(pollSystem, 3000); }
  if (!want && monTimer) { clearInterval(monTimer); monTimer = null; }
}

function setGauge(id, pct, val, sub) {
  const g = $(id);
  const fg = $('.ring-fg', g);
  fg.style.strokeDasharray = `${Math.max(0, Math.min(100, pct))} 100`;
  fg.classList.toggle('warn', pct >= 75 && pct < 90);
  fg.classList.toggle('bad', pct >= 90);
  $('.gauge-val', g).textContent = val;
  const s = $('.gauge-sub', g); if (s && sub !== undefined) s.textContent = sub;
}

function setSpark(id, arr) {
  const pl = $('.spark polyline', $(id));
  if (!pl) return;
  const n = arr.length;
  pl.setAttribute('points', arr.map((v, i) => `${n > 1 ? (i * 100) / (n - 1) : 0},${(23 - (Math.min(100, v) / 100) * 21).toFixed(1)}`).join(' '));
}

async function pollUsage() {
  try {
    const b5h = state.prefs.fiveHourBudget || 200000;
    const bwk = state.prefs.weeklyBudget || 1500000;
    const u = await api(`/api/usage?five_hour_budget=${encodeURIComponent(b5h)}&weekly_budget=${encodeURIComponent(bwk)}`);
    if (!u) return;

    const w5 = u.window_5h;
    const w7 = u.window_7d;
    const w24 = u.window_24h;

    // 1. Render 5-Hour Rolling Card
    const u5hUsedEl = $('#u5hUsed');
    if (u5hUsedEl && w5) {
      u5hUsedEl.textContent = `~${formatTokens(w5.tokens_used)} tok`;
      const pill = $('#u5hStatusPill');
      if (pill) {
        pill.textContent = w5.status;
        pill.className = `usage-status-pill ${w5.status}`;
      }
      const fill = $('#u5hBarFill');
      if (fill) {
        fill.style.width = `${Math.min(100, Math.max(0, w5.percent_used))}%`;
        fill.className = `quota-bar-fill ${w5.percent_used >= 90 ? 'danger' : (w5.percent_used >= 75 ? 'warn' : '')}`;
      }
      if ($('#u5hRemaining')) $('#u5hRemaining').textContent = `~${formatTokens(w5.tokens_remaining)}`;
      if ($('#u5hPct')) $('#u5hPct').textContent = `${w5.percent_used}% of ${formatTokens(w5.tokens_budget)} limit`;
      if ($('#u5hReset')) $('#u5hReset').textContent = w5.next_reset_formatted === 'Idle' ? 'No active queue' : `In ${w5.next_reset_formatted}`;
      if ($('#u5hMsgs')) $('#u5hMsgs').textContent = String(w5.messages_count);
      if ($('#u24hUsed')) $('#u24hUsed').textContent = `~${formatTokens(w24?.tokens_used || 0)} tok`;

      // 5h Agent distribution chips
      const entries5 = Object.entries(w5.by_agent || {});
      const aChips = entries5.map(([k, stat]) => {
        const ag = AGENTS[k];
        const iconHtml = ag ? icon(ag.icon, 'xs') : '🤖';
        const name = ag ? ag.name : k;
        return `<span class="agent-chip-stat">${iconHtml} <span>${esc(name)}</span> <span class="tok-cnt">~${formatTokens(stat.tokens)}</span></span>`;
      }).join('');
      if ($('#u5hAgentChips')) $('#u5hAgentChips').innerHTML = aChips || '<span class="muted sm">No activity in last 5 hours</span>';
    }

    // 2. Render Weekly (7-Day) Card
    const u7dUsedEl = $('#u7dUsed');
    if (u7dUsedEl && w7) {
      u7dUsedEl.textContent = `~${formatTokens(w7.tokens_used)} tok`;
      const pill7 = $('#u7dStatusPill');
      if (pill7) {
        pill7.textContent = w7.status;
        pill7.className = `usage-status-pill ${w7.status}`;
      }
      const fill7 = $('#u7dBarFill');
      if (fill7) {
        fill7.style.width = `${Math.min(100, Math.max(0, w7.percent_used))}%`;
        fill7.className = `quota-bar-fill weekly ${w7.percent_used >= 90 ? 'danger' : (w7.percent_used >= 75 ? 'warn' : '')}`;
      }
      if ($('#u7dRemaining')) $('#u7dRemaining').textContent = `~${formatTokens(w7.tokens_remaining)}`;
      if ($('#u7dPct')) $('#u7dPct').textContent = `${w7.percent_used}% of ${formatTokens(w7.tokens_budget)} limit`;

      // Weekly 7-day sparkbars
      const maxDaily = Math.max(1, ...(w7.daily || []).map(d => (d.tokens > 0 ? d.tokens : d.messages * 50)));
      const isToday = (idx, total) => idx === total - 1;
      const sparkHtml = (w7.daily || []).map((d, i, arr) => {
        const val = d.tokens > 0 ? d.tokens : (d.messages > 0 ? d.messages * 50 : 0);
        const hPct = val > 0 ? Math.max(8, Math.round((val / maxDaily) * 100)) : 4;
        const todayCls = isToday(i, arr.length) ? 'today' : '';
        const title = `${d.date} (${d.day}): ~${formatTokens(d.tokens)} tok · ${d.messages} msgs`;
        return `
        <div class="sparkbar-col ${todayCls}" title="${esc(title)}">
          <div class="sparkbar-fill" style="height: ${hPct}%;"></div>
          <span class="sparkbar-label">${d.day}</span>
        </div>`;
      }).join('');
      if ($('#u7dSparkbars')) $('#u7dSparkbars').innerHTML = sparkHtml;

      // Weekly Agent distribution chips
      const entries7 = Object.entries(w7.by_agent || {});
      const aChips7 = entries7.map(([k, stat]) => {
        const ag = AGENTS[k];
        const iconHtml = ag ? icon(ag.icon, 'xs') : '🤖';
        const name = ag ? ag.name : k;
        return `<span class="agent-chip-stat">${iconHtml} <span>${esc(name)}</span> <span class="tok-cnt">~${formatTokens(stat.tokens)}</span></span>`;
      }).join('');
      if ($('#u7dAgentChips')) $('#u7dAgentChips').innerHTML = aChips7 || '<span class="muted sm">No weekly activity recorded</span>';
    }
  } catch (e) {
    /* ignore usage poll error */
  }
}

async function pollSystem() {
  try {
    const d = await api('/api/system');
    setGauge('#gCpu', d.cpu_percent, `${Math.round(d.cpu_percent)}%`);
    setGauge('#gMem', d.memory_percent, `${Math.round(d.memory_percent)}%`, `${d.memory_used_gb.toFixed(1)} / ${d.memory_total_gb.toFixed(1)} GB`);
    setGauge('#gDisk', d.disk_percent, `${Math.round(d.disk_percent)}%`, `${Math.round(d.disk_free_gb)} GB free of ${Math.round(d.disk_total_gb)} GB`);
    hist.cpu.push(d.cpu_percent); hist.mem.push(d.memory_percent);
    if (hist.cpu.length > 40) { hist.cpu.shift(); hist.mem.shift(); }
    setSpark('#gCpu', hist.cpu); setSpark('#gMem', hist.mem);
    $('#monUptime').textContent = `Up ${d.uptime_formatted}`;
    renderProcesses(d.agent_processes || []);
  } catch {
    $('#monUptime').textContent = 'Offline';
  }
  await pollUsage();
}

function fmtDuration(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function renderProcesses(list) {
  $('#procCount').textContent = list.length ? `${list.length} running` : '';
  $('#processList').innerHTML = list.length ? list.map((p) => {
    const self = p.agent_type === 'AgentHub Server';
    return `
    <div class="proc">
      <div class="proc-main">
        <div class="proc-name">${esc(p.agent_type)} <span class="proc-pid">#${p.pid}</span></div>
        <div class="proc-cmd">${esc(p.cmd)}</div>
        <div class="proc-meta">CPU ${p.cpu}% · RAM ${p.memory}% · up ${fmtDuration(p.running_sec)}</div>
      </div>
      ${self ? '<span class="muted sm">this server</span>' : `<button class="btn btn-danger btn-sm" data-kill="${p.pid}" data-kill-name="${esc(p.agent_type)}">Stop</button>`}
    </div>`;
  }).join('') : '<div class="empty-inline">No agent processes running.</div>';
}

async function killProcess(pid, name) {
  const ok = await confirmSheet({ title: `Stop ${name}?`, message: `This sends a kill signal to process ${pid}. Unsaved agent work will be lost.`, confirm: 'Stop process', danger: true });
  if (!ok) return;
  try {
    const r = await api('/api/process/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }) });
    toast(r.success === false ? (r.error || 'Could not stop process') : 'Process stopped', r.success === false ? 'err' : 'ok');
  } catch { toast('Request failed', 'err'); }
  pollSystem();
}

/* ════════════════════════════════════════════════════════════
   History & sidebar
   ════════════════════════════════════════════════════════════ */

async function loadSessions(quiet = false) {
  if (!quiet && !state.sessionsLoaded) {
    $('#sessionList').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  }
  try {
    const [sessions, runs] = await Promise.all([api('/api/sessions'), api('/api/runs').catch(() => [])]);
    state.sessions = sessions;
    state.running = new Set(runs.map((r) => r.session_id));
    state.sessionsLoaded = true;
  } catch {
    if (!state.sessionsLoaded) $('#sessionList').innerHTML = '<div class="empty-inline">Could not load conversations.</div>';
    return;
  }
  renderHistory();
  renderRail();
}

function renderHistory() {
  const q = $('#historySearch').value.trim().toLowerCase();
  const list = state.sessions.filter((s) => !q || (s.title || '').toLowerCase().includes(q) || (s.agent || '').toLowerCase().includes(q));
  const el = $('#sessionList');
  if (!list.length) {
    el.innerHTML = `<div class="empty-inline">${q ? 'No conversations match your search.' : 'No conversations yet. Start one from the Chat tab.'}</div>`;
    return;
  }
  const groups = new Map();
  list.forEach((s) => { const k = dayBucket(s.updated_at); (groups.get(k) || groups.set(k, []).get(k)).push(s); });
  el.innerHTML = [...groups].map(([label, items]) => `
    <div>
      <div class="day-label">${label}</div>
      ${items.map((s) => `
        <div class="sess ${s.id === state.sessionId ? 'current' : ''}" data-open="${esc(s.id)}" role="button" tabindex="0">
          <span class="dot" style="--agent:${(AGENTS[s.agent] || AGENTS.antigravity).color}"></span>
          <div class="sess-main">
            <div class="sess-title">${esc(s.title || 'Untitled')}</div>
            <div class="sess-meta">${esc((AGENTS[s.agent] || { name: s.agent }).name)} · ${state.running.has(s.id) ? '<span class="sess-run">Running…</span>' : relTime(s.updated_at)}</div>
          </div>
          <button class="sess-del" data-del="${esc(s.id)}" aria-label="Delete conversation">${icon('i-trash')}</button>
        </div>`).join('')}
    </div>`).join('');
}

function renderRail() {
  const el = $('#railRecent');
  if (!el) return;
  const items = state.sessions.slice(0, 14);
  el.innerHTML = items.length ? items.map((s) => `
    <button class="rail-item ${s.id === state.sessionId ? 'current' : ''}" data-open="${esc(s.id)}">
      <span class="dot ${state.running.has(s.id) ? 'live' : ''}" style="--agent:${(AGENTS[s.agent] || AGENTS.antigravity).color}"></span><span>${esc(s.title || 'Untitled')}</span>
    </button>`).join('') : '<div class="rail-empty">No conversations yet</div>';
}

async function deleteSession(id) {
  const ok = await confirmSheet({ title: 'Delete conversation?', message: 'This removes it from history permanently.', confirm: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (id === state.sessionId) newChatSilently();
    toast('Conversation deleted', 'ok');
  } catch { toast('Could not delete', 'err'); }
  loadSessions(true);
}

function newChatSilently() {
  state.sessionId = null; state.title = ''; state.messages = [];
  store.set('session', null);
  renderEmpty(); updateTitle();
}

/* ════════════════════════════════════════════════════════════
   Settings & connectivity
   ════════════════════════════════════════════════════════════ */

function refreshSettings() {
  $('#setOrigin').textContent = location.origin;
  $('#setWsSub').textContent = state.workspace;
  if ($('#pref5hBudget')) $('#pref5hBudget').value = state.prefs.fiveHourBudget || 200000;
  if ($('#prefWeeklyBudget')) $('#prefWeeklyBudget').value = state.prefs.weeklyBudget || 1500000;
  if ($('#prefNotifications')) $('#prefNotifications').checked = state.prefs.notifications !== false;
  if ($('#prefSound')) $('#prefSound').checked = state.prefs.sound !== false;
  if ($('#prefEnter')) $('#prefEnter').checked = state.prefs.enter;
  if ($('#prefHaptics')) $('#prefHaptics').checked = state.prefs.haptics;
  $$('#prefSize button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.size === state.prefs.size)));
}

function applySize() {
  document.documentElement.dataset.size = state.prefs.size;
}

async function checkTunnel() {
  try {
    const d = await api('/api/tunnel/status');
    state.tunnel = { active: !!d.active, url: d.url || '' };
    setConn(true);
  } catch { setConn(false); return; }
  const btn = $('#tunnelBtn');
  $('#tunnelSub').textContent = state.tunnel.active ? state.tunnel.url.replace(/^https?:\/\//, '') : 'Not running';
  $('#tunnelSub').dataset.copy = state.tunnel.active ? state.tunnel.url : '';
  btn.textContent = state.tunnel.active ? 'Stop' : 'Start';
  btn.classList.toggle('btn-danger', state.tunnel.active);
  const insecureRemote = location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname);
  $('#httpsBanner').hidden = !(state.tunnel.active && insecureRemote);
  if (state.tunnel.active) $('#httpsLink').href = state.tunnel.url;
}

async function toggleTunnel() {
  const btn = $('#tunnelBtn');
  btn.disabled = true;
  try {
    if (state.tunnel.active) {
      await api('/api/tunnel/stop', { method: 'POST' });
      toast('Tunnel stopped');
    } else {
      btn.textContent = 'Starting…';
      $('#tunnelSub').textContent = 'Starting — this can take a few seconds';
      const d = await api('/api/tunnel/start', { method: 'POST' });
      if (!d.url) throw new Error('no url');
      toast('Tunnel is live', 'ok');
    }
  } catch { toast('Tunnel action failed', 'err'); }
  btn.disabled = false;
  checkTunnel();
}

function setConn(ok) {
  $('#connDot').className = `conn-dot ${ok ? 'ok' : 'bad'}`;
  $('#connText').textContent = ok ? 'Connected to VM' : 'Offline';
}

/* ════════════════════════════════════════════════════════════
   Skills & MCP Hub
   ════════════════════════════════════════════════════════════ */

let allSkills = [];
let allMcpServers = [];
let skillsPanelActive = 'skills';

async function loadSkillsAndMcp() {
  await Promise.all([loadSkills(), loadMcp()]);
}

async function loadSkills() {
  try {
    const data = await api('/api/skills');
    allSkills = data.skills || [];
    renderSkills();
  } catch (e) {
    const el = $('#skillsList');
    if (el) el.innerHTML = `<div class="empty-state">Could not load skills</div>`;
  }
}

async function loadMcp() {
  try {
    const data = await api('/api/mcp');
    allMcpServers = data.servers || [];
    renderMcp();
  } catch (e) {
    const el = $('#mcpList');
    if (el) el.innerHTML = `<div class="empty-state">Could not load MCP servers</div>`;
  }
}

function renderSkills() {
  const query = ($('#skillsSearch')?.value || '').toLowerCase().trim();
  const listEl = $('#skillsList');
  if (!listEl) return;

  const filtered = allSkills.filter((s) => !query || (s.name || '').toLowerCase().includes(query) || (s.description || '').toLowerCase().includes(query));

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty-state" style="padding:30px; text-align:center; color:var(--text-3);">
      <p style="margin-bottom:10px;">${query ? 'No matching skills found' : 'No custom skills installed yet'}</p>
      <button class="btn btn-sm" data-action="open-skill-gen"><svg class="i xs"><use href="#i-sparkle"/></svg> Generate with AI</button>
    </div>`;
    return;
  }

  listEl.innerHTML = filtered.map((s) => `
    <div class="skill-card" data-skill="${esc(s.name)}">
      <div class="skill-card-head">
        <span class="skill-card-title">
          <span>🧩</span>
          <span>${esc(s.name)}</span>
        </span>
        <span class="skill-badge ${s.is_builtin ? 'builtin' : 'custom'}">${esc(s.category || (s.is_builtin ? 'Built-in' : 'Custom'))}</span>
      </div>
      <div class="skill-desc">${esc(s.description || 'No description provided')}</div>
      <div class="skill-foot">
        <span>Scope: ${esc(s.agent_scope || 'global')}</span>
        <div class="skill-foot-actions">
          <button class="btn btn-ghost btn-sm" data-action="view-skill" data-name="${esc(s.name)}">View / Edit</button>
          ${s.is_builtin ? '' : `<button class="btn btn-ghost btn-sm" style="color:var(--danger);" data-action="delete-skill" data-name="${esc(s.name)}">Delete</button>`}
        </div>
      </div>
    </div>
  `).join('');
}

function renderMcp() {
  const query = ($('#mcpSearch')?.value || '').toLowerCase().trim();
  const listEl = $('#mcpList');
  if (!listEl) return;

  const filtered = allMcpServers.filter((m) => !query || (m.name || '').toLowerCase().includes(query) || (m.command || '').toLowerCase().includes(query));

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty-state" style="padding:30px; text-align:center; color:var(--text-3);">
      <p style="margin-bottom:10px;">${query ? 'No matching MCP servers found' : 'No MCP servers configured'}</p>
      <button class="btn btn-sm" data-action="open-mcp-gen"><svg class="i xs"><use href="#i-sparkle"/></svg> Configure with AI</button>
    </div>`;
    return;
  }

  listEl.innerHTML = filtered.map((m) => `
    <div class="mcp-card">
      <div class="mcp-head">
        <span class="mcp-title">
          <span style="color:var(--ok); font-size:11px;">●</span>
          <span>${esc(m.name)}</span>
        </span>
        <span class="skill-badge custom">${esc(m.type || 'stdio')}</span>
      </div>
      <div class="mcp-cmd">${esc(m.command || m.url || '')} ${(m.args || []).join(' ')}</div>
      ${m.tools && m.tools.length ? `
        <div class="mcp-tools">
          ${m.tools.map((t) => `<span class="mcp-tool-tag">${esc(t)}</span>`).join('')}
        </div>
      ` : ''}
      <div class="skill-foot">
        <span>Agents: ${(m.agents || ['claude', 'antigravity']).join(', ')}</span>
        <div class="skill-foot-actions">
          <button class="btn btn-ghost btn-sm" style="color:var(--danger);" data-action="delete-mcp" data-name="${esc(m.name)}">Remove</button>
        </div>
      </div>
    </div>
  `).join('');
}

function switchSkillsPanel(panel) {
  skillsPanelActive = panel;
  $('#panelSkills').hidden = panel !== 'skills';
  $('#panelMcp').hidden = panel !== 'mcp';
  $$('#skillsTabToggle button').forEach((b) => {
    b.classList.toggle('active', b.dataset.panel === panel);
  });
}

function openSkillCreator({ name = '', description = '', content = '', agent_scope = 'global' } = {}) {
  openSheet(`
    <h3>${name ? 'Edit Skill' : 'Create New Skill'}</h3>
    <div class="stack" style="gap:10px; margin-top:10px;">
      <label>
        <span class="sheet-meta">Skill Name (kebab-case)</span>
        <input class="composer-input" id="skillInputName" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(name)}" placeholder="e.g. docker-deploy" ${name ? 'readonly' : ''}>
      </label>
      <label>
        <span class="sheet-meta">Trigger Description (When should agent activate this?)</span>
        <input class="composer-input" id="skillInputDesc" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(description)}" placeholder="e.g. Automates Docker container deployments and inspects logs">
      </label>
      <label>
        <span class="sheet-meta">Agent Scope</span>
        <select class="composer-input" id="skillInputScope" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px; background:var(--surface-2);">
          <option value="global" ${agent_scope === 'global' ? 'selected' : ''}>Global (All Agents: Antigravity, Claude, Codex, Muse)</option>
          <option value="antigravity" ${agent_scope === 'antigravity' ? 'selected' : ''}>Google Antigravity Only</option>
          <option value="claude" ${agent_scope === 'claude' ? 'selected' : ''}>Claude Code Only</option>
          <option value="codex" ${agent_scope === 'codex' ? 'selected' : ''}>OpenAI Codex Only</option>
          <option value="muse" ${agent_scope === 'muse' ? 'selected' : ''}>Meta Muse Only</option>
        </select>
      </label>
      <label>
        <span class="sheet-meta">Skill Instructions & Rules (Markdown)</span>
        <textarea class="composer-input" id="skillInputContent" rows="7" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px; font-family:var(--mono); font-size:12.5px;" placeholder="# Instructions for the agent...">${esc(content)}</textarea>
      </label>
    </div>
    <div class="sheet-actions" style="margin-top:14px;">
      <button class="btn" data-sheet="cancel">Cancel</button>
      <button class="btn btn-primary" id="saveSkillBtn">Save Skill</button>
    </div>
  `, (body) => {
    $('#saveSkillBtn', body)?.addEventListener('click', async () => {
      const sName = $('#skillInputName', body).value.trim();
      const sDesc = $('#skillInputDesc', body).value.trim();
      const sScope = $('#skillInputScope', body).value;
      const sContent = $('#skillInputContent', body).value.trim();
      if (!sName || !sContent) { toast('Name and instructions are required', 'err'); return; }
      try {
        await api('/api/skills', { method: 'POST', body: JSON.stringify({ name: sName, description: sDesc, agent_scope: sScope, content: sContent }) });
        closeSheet();
        toast(`Skill "${sName}" saved!`, 'ok');
        loadSkills();
      } catch (e) {
        toast(`Save failed: ${e.message}`, 'err');
      }
    });
  });
}

function openSkillAiGenerator() {
  openSheet(`
    <h3>✨ Generate Skill with AI</h3>
    <p class="lead">Describe what you want the skill to do. The AI will draft the instructions, triggers, and best practices.</p>
    <textarea class="composer-input" id="skillGenPrompt" rows="3" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:8px;" placeholder="e.g. Skill for inspecting PostgreSQL databases, running migrations, and checking table schemas"></textarea>
    <div class="sheet-actions" style="margin-top:14px;">
      <button class="btn" data-sheet="cancel">Cancel</button>
      <button class="btn btn-primary" id="btnRunSkillGen">Generate Skill</button>
    </div>
  `, (body) => {
    $('#btnRunSkillGen', body)?.addEventListener('click', async (e) => {
      const p = $('#skillGenPrompt', body).value.trim();
      if (!p) return;
      e.target.disabled = true;
      e.target.textContent = 'Generating…';
      try {
        const res = await api('/api/skills/generate', { method: 'POST', body: JSON.stringify({ prompt: p }) });
        closeSheet();
        openSkillCreator({ name: res.name, description: res.description, content: res.content });
      } catch (err) {
        toast('Generation failed: ' + err.message, 'err');
        e.target.disabled = false;
        e.target.textContent = 'Generate Skill';
      }
    });
  });
}

function openMcpCreator({ name = '', command = '', args = [], env = {} } = {}) {
  openSheet(`
    <h3>${name ? 'Edit MCP Server' : 'Add MCP Server'}</h3>
    <div class="stack" style="gap:10px; margin-top:10px;">
      <label>
        <span class="sheet-meta">Server Name</span>
        <input class="composer-input" id="mcpInputName" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(name)}" placeholder="e.g. postgres-db" ${name ? 'readonly' : ''}>
      </label>
      <label>
        <span class="sheet-meta">Command / Executable</span>
        <input class="composer-input" id="mcpInputCmd" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(command)}" placeholder="e.g. npx or /path/to/server">
      </label>
      <label>
        <span class="sheet-meta">Arguments (space separated or JSON array)</span>
        <input class="composer-input" id="mcpInputArgs" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(Array.isArray(args) ? args.join(' ') : args)}" placeholder="e.g. -y @modelcontextprotocol/server-postgres">
      </label>
      <label>
        <span class="sheet-meta">Environment Variables (JSON format)</span>
        <textarea class="composer-input" id="mcpInputEnv" rows="3" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px; font-family:var(--mono);" placeholder='{"DATABASE_URL": "postgresql://..."}'>${esc(typeof env === 'object' ? JSON.stringify(env, null, 2) : env)}</textarea>
      </label>
    </div>
    <div class="sheet-actions" style="margin-top:14px;">
      <button class="btn" data-sheet="cancel">Cancel</button>
      <button class="btn btn-primary" id="saveMcpBtn">Save Server</button>
    </div>
  `, (body) => {
    $('#saveMcpBtn', body)?.addEventListener('click', async () => {
      const mName = $('#mcpInputName', body).value.trim();
      const mCmd = $('#mcpInputCmd', body).value.trim();
      const mArgsRaw = $('#mcpInputArgs', body).value.trim();
      const mEnvRaw = $('#mcpInputEnv', body).value.trim();
      if (!mName || !mCmd) { toast('Name and command are required', 'err'); return; }
      
      let parsedArgs = [];
      if (mArgsRaw.startsWith('[')) {
        try { parsedArgs = JSON.parse(mArgsRaw); } catch { parsedArgs = mArgsRaw.split(/\s+/); }
      } else {
        parsedArgs = mArgsRaw ? mArgsRaw.split(/\s+/) : [];
      }

      let parsedEnv = {};
      if (mEnvRaw) {
        try { parsedEnv = JSON.parse(mEnvRaw); } catch { toast('Invalid JSON in environment variables', 'err'); return; }
      }

      try {
        await api('/api/mcp', { method: 'POST', body: JSON.stringify({ name: mName, command: mCmd, args: parsedArgs, env: parsedEnv }) });
        closeSheet();
        toast(`MCP Server "${mName}" saved!`, 'ok');
        loadMcp();
      } catch (e) {
        toast(`Save failed: ${e.message}`, 'err');
      }
    });
  });
}

function openMcpAiGenerator() {
  openSheet(`
    <h3>✨ Configure MCP with AI</h3>
    <p class="lead">Describe the database, API, or service you want to connect via MCP.</p>
    <textarea class="composer-input" id="mcpGenPrompt" rows="3" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:8px;" placeholder="e.g. SQLite database at /root/data/app.db"></textarea>
    <div class="sheet-actions" style="margin-top:14px;">
      <button class="btn" data-sheet="cancel">Cancel</button>
      <button class="btn btn-primary" id="btnRunMcpGen">Generate Config</button>
    </div>
  `, (body) => {
    $('#btnRunMcpGen', body)?.addEventListener('click', async (e) => {
      const p = $('#mcpGenPrompt', body).value.trim();
      if (!p) return;
      e.target.disabled = true;
      e.target.textContent = 'Generating…';
      try {
        const res = await api('/api/mcp/generate', { method: 'POST', body: JSON.stringify({ prompt: p }) });
        closeSheet();
        openMcpCreator({ name: res.name, command: res.command, args: res.args, env: res.env });
      } catch (err) {
        toast('Generation failed: ' + err.message, 'err');
        e.target.disabled = false;
        e.target.textContent = 'Generate Config';
      }
    });
  });
}

/* ════════════════════════════════════════════════════════════
   Event wiring
   ════════════════════════════════════════════════════════════ */

const actions = {
  'toggle-nav': toggleNav,
  'open-nav': openNav,
  'close-nav': closeNav,
  'new-chat': newChat,
  'open-agents': openAgentSheet,
  'open-workspaces': () => openWorkspaceSheet(state.workspace || '/root'),
  'open-qr': openQrSheet,
  'open-attach': openAttachSheet,
  'pick-camera': () => { closeSheet(); $('#cameraInput')?.click(); },
  'pick-device-file': () => { closeSheet(); $('#mediaFileInput')?.click(); },
  'pick-vm-file': () => { closeSheet(); openWorkspaceSheet(state.workspace || '/root'); },
  'fetch-attach-url': () => { const val = $('#attachUrlInput')?.value.trim(); if (val) attachExternalUrl(val); },
  send: () => (state.streaming ? stopStreaming() : send()),
  mic: toggleMic,
  'voice-open': voiceOpen,
  'test-voice': testVoice,
  'voice-close': voiceClose,
  'voice-orb': vcOrbTap,
  'voice-mute': () => { vc.muted = !vc.muted; store.set('voiceMuted', vc.muted); vcSyncMute(); if (vc.muted) { stopSpeaking(); if (vc.phase === 'speaking') vcListen(); } },
  'mic-stop': stopMic,
  'mic-cancel': cancelMic,
  'jump-bottom': () => { state.stick = true; scrollToBottom(true); $('#jumpBtn').hidden = true; },
  'term-reconnect': () => { if (term) term.clear(); connectTerm(); },
  'term-font': (el) => termFontDelta(Number(el.dataset.delta)),
  'tunnel-toggle': toggleTunnel,
  'copy-origin': async () => toast((await copyText(location.origin)) ? 'Address copied' : 'Copy failed', 'ok'),
  'toggle-hidden-folders': () => {
    browseShowHidden = !browseShowHidden;
    openWorkspaceSheet(currentBrowsingPath);
  },
  'browse-input-go': () => {
    const val = $('#browserPathInput')?.value.trim();
    if (val) openWorkspaceSheet(val);
  },
  'switch-skills-panel': (el) => switchSkillsPanel(el.dataset.panel),
  'open-skill-create': () => openSkillCreator(),
  'open-skill-gen': () => openSkillAiGenerator(),
  'open-mcp-create': () => openMcpCreator(),
  'open-mcp-gen': () => openMcpAiGenerator(),
  'view-skill': async (el) => {
    const name = el.dataset.name;
    try {
      const sk = await api(`/api/skills/${encodeURIComponent(name)}`);
      openSkillCreator({ name: sk.name, description: sk.description, content: sk.content, agent_scope: sk.agent_scope });
    } catch {
      toast('Could not load skill details', 'err');
    }
  },
  'delete-skill': async (el) => {
    const name = el.dataset.name;
    if (await confirmSheet({ title: `Delete skill "${name}"?`, message: 'This will remove the skill file from disk.', confirm: 'Delete', danger: true })) {
      try {
        await api(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
        toast(`Skill "${name}" deleted`, 'ok');
        loadSkills();
      } catch {
        toast('Delete failed', 'err');
      }
    }
  },
  'delete-mcp': async (el) => {
    const name = el.dataset.name;
    if (await confirmSheet({ title: `Remove MCP server "${name}"?`, message: 'This will remove the server configuration.', confirm: 'Remove', danger: true })) {
      try {
        await api(`/api/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
        toast(`MCP server "${name}" removed`, 'ok');
        loadMcp();
      } catch {
        toast('Remove failed', 'err');
      }
    }
  }
};

document.addEventListener('click', async (e) => {
  const t = e.target;
  const q = (s) => t.closest(s);
  let el;

  if ((el = q('[data-action]'))) { actions[el.dataset.action]?.(el); return; }
  if ((el = q('[data-tab]'))) { switchTab(el.dataset.tab); return; }
  if ((el = q('[data-suggest]'))) { const s = SUGGESTIONS[el.dataset.suggest]; send(state.agent === 'bash' ? s.cmd : s.prompt); return; }
  if ((el = q('[data-browse-to]'))) { openWorkspaceSheet(el.dataset.browseTo); return; }
  if ((el = q('[data-select-browse-ws]'))) { setWorkspace(el.dataset.selectBrowseWs); closeSheet(); return; }
  if ((el = q('[data-attach-vm-file]'))) {
    const isImg = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes((el.dataset.ext || '').toLowerCase());
    addAttachment({
      name: el.dataset.name,
      path: el.dataset.attachVmFile,
      ext: el.dataset.ext,
      size_fmt: el.dataset.size,
      is_image: isImg,
      url: isImg ? `/uploads/${basename(el.dataset.attachVmFile)}` : null
    });
    closeSheet();
    return;
  }
  if ((el = q('[data-del-attach]'))) {
    removeAttachment(Number(el.dataset.delAttach));
    return;
  }
  if ((el = q('[data-pick-agent]'))) {
    setAgent(el.dataset.pickAgent);
    if (vc.open) store.set('voiceAgent', state.agent);
    if (MODEL_AGENTS.includes(state.agent)) openAgentSheet(); else closeSheet();   // stay open to pick a model
    return;
  }
  if ((el = q('[data-pick-model]'))) { setModel(el.dataset.pickModel); closeSheet(); return; }
  if ((el = q('[data-refresh-models]'))) {
    el.disabled = true; el.innerHTML = `${icon('i-refresh', 'xs')}Refreshing…`;
    const ok = await loadModels(true);
    if (!$('#sheet').hidden) openAgentSheet();
    toast(ok ? 'Model list updated' : 'Could not refresh models', ok ? 'ok' : 'err');
    return;
  }
  if ((el = q('[data-view-file]'))) { openFileSheet(el.dataset.viewFile); return; }
  if ((el = q('[data-ask-file]'))) {
    const p = el.dataset.askFile;
    closeSheet();
    switchTab('chat');
    const input = $('#promptInput');
    if (input) {
      input.value = `Please read and analyze the file: ${p}\n\n`;
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  if ((el = q('[data-pick-ws]'))) { setWorkspace(el.dataset.pickWs); closeSheet(); return; }
  if ((el = q('[data-sheet]'))) { closeSheet(el.dataset.sheet === 'ok'); return; }
  if ((el = q('[data-goto]'))) { closeSheet(); switchTab(el.dataset.goto); return; }
  if ((el = q('[data-key]'))) { pressKey(el.dataset.key); return; }
  if ((el = q('[data-copy]'))) { if (el.dataset.copy) toast((await copyText(el.dataset.copy)) ? 'Copied' : 'Copy failed', 'ok'); return; }
  if ((el = q('[data-copy-code]'))) {
    const ok = await copyText($('pre', el.closest('.codeblock')).innerText);
    el.innerHTML = `${icon(ok ? 'i-check' : 'i-alert')}${ok ? 'Copied' : 'Failed'}`;
    setTimeout(() => { el.innerHTML = `${icon('i-copy')}Copy`; }, 1600);
    return;
  }
  if ((el = q('[data-copy-msg]'))) {
    const ok = await copyText(stripTag(el.closest('.msg')._raw).text.trim());
    toast(ok ? 'Reply copied' : 'Copy failed', ok ? 'ok' : 'err');
    return;
  }
  if (q('[data-retry]')) { retryLast(); return; }
  if ((el = q('[data-kill]'))) { killProcess(Number(el.dataset.kill), el.dataset.killName); return; }
  if ((el = q('[data-del]'))) { e.stopPropagation(); deleteSession(el.dataset.del); return; }
  if ((el = q('[data-open]'))) { openSession(el.dataset.open); return; }
  if ((el = q('[data-size]'))) { state.prefs.size = el.dataset.size; store.set('pref.size', state.prefs.size); applySize(); refreshSettings(); return; }
});

// File input change handlers for device and camera uploads
$('#mediaFileInput')?.addEventListener('change', (e) => {
  handleFileUploads(e.target.files);
  e.target.value = '';
});

$('#cameraInput')?.addEventListener('change', (e) => {
  handleFileUploads(e.target.files);
  e.target.value = '';
});

// Direct Clipboard Paste (e.g. Screenshot, Copied Image, Copied File)
document.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'file') {
      const file = items[i].getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) {
    e.preventDefault();
    toast(`Pasting ${files.length} image/file(s)…`, 'ok');
    await handleFileUploads(files);
  }
});

// Drag & Drop onto Chat or Composer
const chatView = $('#view-chat');
if (chatView) {
  chatView.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    $('#composer')?.classList.add('drag-over');
  });
  chatView.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    $('#composer')?.classList.remove('drag-over');
  });
  chatView.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    $('#composer')?.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) {
      await handleFileUploads(e.dataTransfer.files);
    }
  });
}

// Keyboard activation for history rows
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.sess')) { e.preventDefault(); openSession(e.target.dataset.open); }
});

// Keep the terminal's on-screen keyboard from stealing focus on key taps
$('#keybar').addEventListener('mousedown', (e) => e.preventDefault());

const input = $('#promptInput');
input.addEventListener('input', () => { autosize(); store.set('draft', input.value); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && state.prefs.enter) { e.preventDefault(); send(); }
});
// Bring the composer into view when the on-screen keyboard opens
input.addEventListener('focus', () => setTimeout(() => state.stick && scrollToBottom(true), 300));

threadEl().addEventListener('scroll', onThreadScroll, { passive: true });
$('#historySearch')?.addEventListener('input', renderHistory);
$('#skillsSearch')?.addEventListener('input', renderSkills);
$('#mcpSearch')?.addEventListener('input', renderMcp);

$('#pref5hBudget')?.addEventListener('change', (e) => {
  const val = Math.max(1000, parseInt(e.target.value) || 200000);
  state.prefs.fiveHourBudget = val;
  store.set('pref.fiveHourBudget', val);
  pollUsage();
  toast(`5h Quota Target updated to ${formatTokens(val)} tok`, 'ok');
});
$('#prefWeeklyBudget')?.addEventListener('change', (e) => {
  const val = Math.max(5000, parseInt(e.target.value) || 1500000);
  state.prefs.weeklyBudget = val;
  store.set('pref.weeklyBudget', val);
  pollUsage();
  toast(`Weekly Quota Target updated to ${formatTokens(val)} tok`, 'ok');
});

$('#prefNotifications')?.addEventListener('change', async (e) => {
  state.prefs.notifications = e.target.checked;
  store.set('pref.notifications', e.target.checked);
  if (e.target.checked) {
    const granted = await requestNotificationPermission();
    if (granted) {
      toast('Notifications enabled', 'ok');
    } else if (Notification.permission === 'denied') {
      toast('Notifications are blocked by your browser settings', 'err');
    }
  }
});
$('#prefSound')?.addEventListener('change', (e) => {
  state.prefs.sound = e.target.checked;
  store.set('pref.sound', e.target.checked);
  if (e.target.checked) playCompletionChime();
});
$('#prefEnter')?.addEventListener('change', (e) => { state.prefs.enter = e.target.checked; store.set('pref.enter', e.target.checked); updateHint(); });
$('#prefHaptics')?.addEventListener('change', (e) => { state.prefs.haptics = e.target.checked; store.set('pref.haptics', e.target.checked); haptic(12); });

document.addEventListener('visibilitychange', () => { syncMonitorPolling(); if (!document.hidden) checkForUpdate(); if (!document.hidden) { checkTunnel(); if (state.tab === 'history') loadSessions(true); } });
window.addEventListener('online', () => { setConn(true); checkTunnel(); });
window.addEventListener('offline', () => setConn(false));
window.addEventListener('resize', () => { if (state.tab === 'terminal' && fit) { try { fit.fit(); } catch {} } });

/* ════════════════════════════════════════════════════════════
   Auto-update — pick up new versions without a manual refresh
   ════════════════════════════════════════════════════════════ */

let knownBuild = null, updateNoted = false;

async function checkForUpdate() {
  try {
    const { build } = await api('/api/version');
    if (knownBuild === null) { knownBuild = build; return; }
    if (build === knownBuild) return;
    const busy = state.streaming || vc.open || voice.active;
    if (!busy) { location.reload(); return; }         // drafts and the open conversation are restored on load
    if (!updateNoted) { updateNoted = true; toast('Update ready — it will apply when you finish', 'ok'); }
  } catch { /* offline */ }
}

/* ════════════════════════════════════════════════════════════
   Boot
   ════════════════════════════════════════════════════════════ */

async function boot() {
  applySize();
  applyAgent();
  applyWorkspace();
  updateHint();
  renderEmpty();
  switchTab('chat');

  const draft = store.get('draft', '');
  if (draft) { input.value = draft; }
  autosize();
  setStreaming(false);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'OPEN_SESSION' && e.data.sessionId) {
        openSession(e.data.sessionId);
      }
    });
  }

  loadModels();
  await Promise.all([loadWorkspaces(), loadSessions(true), checkTunnel()]);
  setInterval(checkTunnel, 30000);
  checkForUpdate();
  setInterval(checkForUpdate, 45000);
  setInterval(() => { if (!document.hidden && (state.running.size || state.tab === 'history')) loadSessions(true); }, 5000);

  // Resume the last conversation unless the user asked for a fresh one (PWA shortcut).
  const fresh = new URLSearchParams(location.search).has('new');
  const last = store.get('session', null);
  if (!fresh && last && state.sessions.some((s) => s.id === last)) await openSession(last);
  else if (fresh) input.focus();
}

boot();
