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
  regina:      { name: 'Regina', full: 'Regina', desc: 'Microsoft Foundry assistant with VM tools', color: 'var(--c-regina)', icon: 'a-regina' },
  bash:        { name: 'Shell', full: 'Linux Shell', desc: 'Run a command directly in bash', color: 'var(--c-bash)', icon: 'a-bash' },
  auto:        { name: 'Auto', full: 'Smart Router', desc: 'Picks the best agent for each message', color: 'var(--c-auto)', icon: 'a-auto' },
};

// The backend prefixes each reply with a tag line naming the agent that ran.
const AGENT_TAGS = { '🚀': 'antigravity', '🟣': 'claude', '🟢': 'codex', '⚙️': 'bash', '🌸': 'regina' };
const TAG_RE = /^\s*(🚀|🟣|🟢|⚙️|🌸)\s*\*\[[^\]\n]*\]\*[ \t]*\n*/u;

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
  groupBy: store.get('groupBy', 'folder'),   // chat lists: 'folder' or 'date'
  expandedWs: new Set(),
  collapsedRailWs: new Set(store.get('collapsedRailWs', [])),
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
  online: typeof navigator !== 'undefined' ? (navigator.onLine !== false) : true,
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
  try {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    if (state.online !== true) setConn(true);
    return await res.json();
  } catch (err) {
    if (path !== '/api/events' && typeof navigator !== 'undefined' && navigator.onLine === false) {
      setConn(false);
    }
    throw err;
  }
}

/* ════════════════════════════════════════════════════════════
   Sheets (bottom sheet on phones, dialog on desktop)
   ════════════════════════════════════════════════════════════ */

let sheetResolve = null;

function openSheet(html, onMount, opts = {}) {
  const s = $('#sheet');
  const sc = $('#scrim');
  const wasOpen = !s.hidden;
  const wasFull = wasOpen && s.classList.contains('full');

  // Replacing one sheet with another cancels the first's pending result.
  if (sheetResolve) { const r = sheetResolve; sheetResolve = null; r(null); }

  $('#sheetBody').innerHTML = html;
  sc.hidden = false;
  s.hidden = false;

  const mobile = window.innerWidth < 900;
  // Keep the current height when navigating inside an already-open sheet,
  // so going to another folder while expanded doesn't collapse to half.
  // opts.full forces full height (e.g. media that needs room to render).
  const target = mobile ? (opts.full || wasFull ? 'full' : 'half') : 'full';

  const b = $('#sheetBody');
  if (wasOpen) {
    // Content swap: keep the frame in place, fade the new content in softly.
    s.style.transition = 'none';
    if (sc) sc.style.transition = 'none';
    s.classList.remove('half', 'full');
    s.classList.add(target);
    s.style.transform = '';
    if (sc) sc.style.opacity = '';
    void s.offsetHeight;
    requestAnimationFrame(() => { s.style.transition = ''; if (sc) sc.style.transition = ''; });

    b.style.transition = 'none';
    b.style.transform = 'translateY(8px)';
    b.style.opacity = '0';
    void b.offsetWidth;
    requestAnimationFrame(() => {
      b.style.transition = 'transform .22s cubic-bezier(.32,.72,0,1), opacity .2s ease';
      b.style.transform = 'translateY(0)';
      b.style.opacity = '1';
    });
  } else {
    // Fresh open: slide up from hidden.
    b.style.transition = 'none';
    b.style.transform = '';
    b.style.opacity = '';
    s.classList.remove('half', 'full');
    s.style.transform = '';
    s.style.transition = '';
    if (sc) { sc.style.opacity = ''; sc.style.transition = ''; }
    void s.offsetHeight;
    s.classList.add(target);
  }

  if (onMount) onMount($('#sheetBody'));
  const first = $('#sheetBody [autofocus], #sheetBody .opt.selected, #sheetBody button');
  if (first) first.focus({ preventScroll: true });
}

function closeSheet(result = null) {
  const s = $('#sheet');
  const sc = $('#scrim');
  const b = $('#sheetBody');
  if (b) { b.style.transition = ''; b.style.transform = ''; b.style.opacity = ''; }
  if (s) { s.hidden = true; s.style.transform = ''; s.style.transition = ''; s.classList.remove('half', 'full'); }
  if (sc) { sc.hidden = true; sc.style.opacity = ''; sc.style.transition = ''; }
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

function promptSheet({ title, message, value = '', placeholder = '', confirm = 'OK' }) {
  return new Promise((resolve) => {
    openSheet(`
      <h3>${esc(title)}</h3>
      ${message ? `<p class="lead">${esc(message)}</p>` : ''}
      <input id="promptSheetInput" class="sheet-input" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="sheet-actions">
        <button class="btn" data-sheet="cancel">Cancel</button>
        <button class="btn btn-primary" data-prompt-ok>${esc(confirm)}</button>
      </div>`, (body) => {
      const inp = body.querySelector('#promptSheetInput');
      const submit = () => { const v = inp.value.trim(); sheetResolve = null; closeSheet(); resolve(v || null); };
      body.querySelector('[data-prompt-ok]').addEventListener('click', submit);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      inp.focus();
      inp.setSelectionRange(0, inp.value.lastIndexOf('.') > 0 ? inp.value.lastIndexOf('.') : inp.value.length);
    });
    sheetResolve = () => resolve(null);
  });
}

$('#scrim').addEventListener('click', () => closeSheet(false));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  goBack();
});

// ── Sheet gesture: half ↔ full ↔ dismiss ─────────────────────
// Everything uses translateY for GPU-composited, 60 fps animation.
// Half state = translateY(48%), full = translateY(0), dismiss = translateY(100%).
// During a drag, the finger position drives the transform directly.
(function initSheetGesture() {
  const sheet = $('#sheet');
  const scrim = $('#scrim');
  const body = $('#sheetBody');
  if (!sheet || !body) return;

  const SPRING = 'transform .32s cubic-bezier(.32, .72, 0, 1)';
  const vh = () => window.innerHeight;

  // The Y offset (in px) for the current snap point
  function snapPx() {
    if (sheet.classList.contains('full')) return 0;
    if (sheet.classList.contains('half')) return vh() * 0.48;
    return vh(); // hidden
  }

  let startY = 0, lastY = 0, dragging = false, startTime = 0, baseOffset = 0;
  let touchOnGrab = false, scroller = null, startState = 'half';

  // The nearest scrollable element between the touch target and the sheet.
  // The sheet's body isn't the scroller — file viewers, editors and lists
  // each have their own overflow container, so we must check the real one.
  function scrollableUnder(node) {
    let el = node;
    while (el && el !== sheet) {
      if (el.nodeType === 1 && el.scrollHeight > el.clientHeight + 1) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // Begin a sheet drag from the current finger position (rebases the origin
  // so the sheet doesn't jump when the gesture is recognised mid-scroll).
  function beginDrag(y) {
    dragging = true;
    startY = lastY = y;
    startTime = Date.now();
    baseOffset = snapPx();
    startState = sheet.classList.contains('full') ? 'full' : 'half';
  }

  sheet.addEventListener('touchstart', (e) => {
    if (sheet.hidden || e.touches.length !== 1 || window.innerWidth >= 900) return;
    touchOnGrab = !!e.target.closest('.sheet-grab');
    scroller = touchOnGrab ? null : scrollableUnder(e.target);
    startY = lastY = e.touches[0].clientY;
    startTime = Date.now();
    baseOffset = snapPx();
    startState = sheet.classList.contains('full') ? 'full' : 'half';
    dragging = touchOnGrab;
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!startY || e.touches.length !== 1 || window.innerWidth >= 900) return;
    const y = e.touches[0].clientY;
    const delta = y - startY;
    const isHalf = sheet.classList.contains('half');
    const atTop = !scroller || scroller.scrollTop <= 0;
    lastY = y;

    if (!dragging) {
      // Swipe up while half → expand to full (only when inner content is at its top)
      if (isHalf && atTop && delta < -10) beginDrag(y);
      // Pull down while the inner content is at its top → collapse / dismiss
      else if (atTop && delta > 6) beginDrag(y);
      else return; // let the inner element scroll natively
    }

    if (e.cancelable) e.preventDefault();

    const liveDelta = y - startY;
    const halfPx = vh() * 0.48;
    let offset = baseOffset + liveDelta;
    if (offset < 0) offset = offset * 0.2; // rubber-band past full
    // From full, half is the floor: resist dragging below it so a single
    // pull-down lands on half rather than racing toward dismiss.
    if (startState === 'full' && offset > halfPx) offset = halfPx + (offset - halfPx) * 0.2;
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${offset}px)`;
    if (scrim) {
      const progress = Math.max(0, Math.min(1, 1 - offset / vh()));
      scrim.style.transition = 'none';
      scrim.style.opacity = `${progress * 0.6}`;
    }
  }, { passive: false });

  function endDrag(e) {
    if (!startY || !dragging || window.innerWidth >= 900) { startY = 0; dragging = false; return; }
    const touch = e.changedTouches?.[0];
    const y = touch ? touch.clientY : lastY;
    const delta = y - startY;
    const elapsed = Date.now() - startTime;
    const velocity = elapsed > 0 ? delta / elapsed : 0; // px/ms, negative = up

    startY = 0; dragging = false;

    // Stepped snapping, one detent per drag:
    //   full  →(down)→ half →(down)→ dismiss
    //   dismiss ←(up)← half ←(up)← full
    const STEP = vh() * 0.16;        // distance to commit to the next detent
    const movedDown = delta > 0;
    const far = Math.abs(delta) > STEP;
    const fastDown = velocity > 0.5;
    const fastUp = velocity < -0.4;

    let target;
    if (startState === 'full') {
      target = (movedDown && far) || fastDown ? 'half' : 'full';
    } else { // started from half
      if ((movedDown && far) || fastDown) target = 'dismiss';
      else if ((!movedDown && far) || fastUp) target = 'full';
      else target = 'half';
    }

    sheet.classList.remove('half', 'full');

    if (target === 'dismiss') {
      sheet.style.transition = SPRING;
      sheet.style.transform = `translateY(${vh()}px)`;
      if (scrim) { scrim.style.transition = 'opacity .28s ease'; scrim.style.opacity = '0'; }
      setTimeout(() => closeSheet(false), 320);
    } else {
      sheet.classList.add(target);
      sheet.style.transition = SPRING;
      sheet.style.transform = '';
      if (scrim) { scrim.style.transition = 'opacity .28s ease'; scrim.style.opacity = ''; }
      if (target === 'half') body.scrollTop = 0;
      setTimeout(() => { sheet.style.transition = ''; if (scrim) { scrim.style.transition = ''; scrim.style.opacity = ''; } }, 340);
    }
  }

  sheet.addEventListener('touchend', endDrag, { passive: true });
  sheet.addEventListener('touchcancel', endDrag, { passive: true });
})();

// ── Back navigation (shared by Escape key and left-edge swipe) ──
// The sheet portion: step back one layer inside an open sheet.
// Returns 'nav' when it swapped content, 'close' when it dismissed,
// or null when there was no sheet to act on.
function performSheetBack() {
  const sheet = $('#sheet');
  if (!sheet || sheet.hidden) return null;
  const body = $('#sheetBody');
  const inSheetBack = body?.querySelector('.fv-head [data-browse-to], .fv-head [data-view-file]');
  if (inSheetBack) { inSheetBack.click(); return 'nav'; }
  const upRow = body?.querySelector('.browse-list .browse-row[data-browse-to]');
  if (upRow) { upRow.click(); return 'nav'; }
  closeSheet(false);
  return 'close';
}

// Unwinds the UI one layer at a time, like a system Back button.
function goBack() {
  if (!navDesktop.matches && $('#rail')?.classList.contains('open')) { closeNav(); return true; }
  if (performSheetBack()) return true;
  if (typeof vc !== 'undefined' && vc.open) { voiceClose(); return true; }
  if (chromeMode() === 'thread') { newChat({ focus: false }); return true; }
  if (state.tab !== 'chat') { switchTab('chat'); return true; }
  return false;
}

// ── Left-edge swipe → Back, finger-tracking (phones only) ─────
// While a sheet is open the content follows the finger and either
// completes (slides off, content swaps) or springs back. With no
// sheet open it falls back to a committed Back on release.
(function initEdgeSwipeBack() {
  const EDGE = 28;          // px from the left edge that arms the gesture
  const COMMIT = 0.32;      // fraction of width (or a flick) to complete
  const SPRING = 'transform .26s cubic-bezier(.32,.72,0,1), opacity .2s ease';
  let armed = false, decided = false, onSheet = false;
  let sx = 0, sy = 0, w = 1, startT = 0, lastX = 0;

  const body = () => $('#sheetBody');

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || window.innerWidth >= 900) { armed = false; return; }
    const t = e.touches[0];
    if (t.clientX > EDGE) { armed = false; return; }
    armed = true; decided = false;
    sx = lastX = t.clientX; sy = t.clientY; w = window.innerWidth; startT = Date.now();
    onSheet = !$('#sheet').hidden;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!armed || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    lastX = t.clientX;
    if (!decided) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) { armed = false; return; }
      if (dx > 8 && Math.abs(dx) > Math.abs(dy)) decided = true;
      else return;
    }
    if (!onSheet) return; // view-level back resolves on release
    if (e.cancelable) e.preventDefault();
    const b = body();
    if (!b) return;
    const x = Math.max(0, dx);
    b.style.transition = 'none';
    b.style.transform = `translateX(${x}px)`;
    b.style.opacity = `${1 - Math.min(1, x / w) * 0.35}`;
  }, { passive: false });

  function finish(e) {
    if (!armed || !decided) { armed = false; return; }
    armed = false;
    const t = e.changedTouches?.[0];
    const x = Math.max(0, (t ? t.clientX : lastX) - sx);
    const dt = Date.now() - startT;
    const vx = dt > 0 ? x / dt : 0;
    const commit = x > w * COMMIT || vx > 0.5;

    if (!onSheet) { if (commit) goBack(); return; }

    const b = body();
    if (!b) return;
    if (commit) {
      b.style.transition = 'transform .2s ease, opacity .2s ease';
      b.style.transform = `translateX(${w}px)`;
      b.style.opacity = '0';
      setTimeout(() => {
        b.style.transition = 'none';
        b.style.transform = '';
        b.style.opacity = '';
        performSheetBack(); // new content fades in via openSheet
      }, 190);
    } else {
      b.style.transition = SPRING;
      b.style.transform = '';
      b.style.opacity = '';
      setTimeout(() => { b.style.transition = ''; }, 280);
    }
  }

  document.addEventListener('touchend', finish, { passive: true });
  document.addEventListener('touchcancel', finish, { passive: true });
})();

const MODEL_AGENTS = ['antigravity', 'claude', 'codex', 'regina'];
const MODEL_SOURCE = { antigravity: 'Antigravity', claude: 'Anthropic', codex: 'Codex', regina: 'Microsoft Foundry' };

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

let showAllModels = false;

function agentSub(k) {
  if (!MODEL_AGENTS.includes(k)) return AGENTS[k].desc;
  const m = currentModel(k);
  return m ? modelName(k, m) : 'Default model';
}

// How hard a model hits the token budget (1 light … 5 very heavy) and what it's
// good for. Catalogs are live, so this keys off family names, not exact ids;
// the reasoning-effort suffix (low/high) nudges the weight down/up.
const MODEL_FAMILIES = [
  [/haiku/, 1, 'Quick answers, small edits, high-volume chores'],
  [/sonnet/, 3, 'Everyday coding and analysis — the best balance'],
  [/opus/, 4, 'Deep reasoning, big refactors, long agent runs'],
  [/fable/, 5, 'Frontier reasoning for the hardest, longest work'],
  [/flash-?lite/, 1, 'Fast, cheap lookups and simple steps'],
  [/flash/, 2, 'Fast everyday work with light reasoning'],
  [/gemini.*pro/, 4, 'Complex multi-step tasks and large codebases'],
  [/gpt-oss/, 2, 'Open-weight model for routine tasks'],
  [/luna|\bmini\b|\bnano\b/, 1, 'Fast and affordable — easy, well-defined tasks'],
  [/terra/, 2, 'Balanced — straightforward coding and edits'],
  [/sol/, 3, 'Workhorse for coding and everyday work'],
  [/astra|-pro\b|max/, 5, 'Frontier intelligence for the most demanding work'],
  [/kimi.*k2\.?7|kimi.*code/, 3, 'MoonshotAI coding model — code generation and analysis'],
  [/kimi.*k2\.?6/, 4, 'MoonshotAI advanced reasoning model'],
  [/kimi.*k2\.?5/, 3, 'MoonshotAI reasoning model — balanced performance'],
];
const WEIGHT_LABEL = ['', 'Light', 'Lean', 'Moderate', 'Heavy', 'Very heavy'];

function modelProfile(m) {
  const key = `${m.id} ${m.name}`.toLowerCase();
  const fam = MODEL_FAMILIES.find(([re]) => re.test(key));
  if (!fam) return m.description ? { weight: 0, use: m.description } : null;
  let weight = fam[1];
  if (/\b(high|xhigh)\b|-high\b|thinking/.test(key)) weight++;
  if (/\blow\b|-low\b/.test(key)) weight--;
  weight = Math.max(1, Math.min(5, weight));
  return { weight, use: m.description || fam[2] };
}

function tokenMeter(w) {
  if (!w) return '';
  const bars = [1, 2, 3, 4, 5].map((i) => `<i class="${i <= w ? 'on' : ''}"></i>`).join('');
  return `<span class="tok-meter w${w}" title="Token use: ${WEIGHT_LABEL[w]}" aria-label="Token use: ${WEIGHT_LABEL[w]}"><span class="tok-bars">${bars}</span><span class="tok-label">${WEIGHT_LABEL[w]}</span></span>`;
}

function modelOpt(agent, m, sel) {
  const on = (m ? m.id : null) === (sel || null);
  const p = m && modelProfile(m);
  return `<button class="model-opt ${on ? 'selected' : ''}" role="radio" aria-checked="${on}" data-pick-model="${m ? esc(m.id) : ''}">
    <span class="model-top"><span class="model-name">${esc(m ? (agent === 'claude' ? m.name.replace(/^Claude\s+/, '') : m.name) : 'Default')}</span>${p ? tokenMeter(p.weight) : ''}</span>
    <span class="model-hint">${esc(m ? m.id : showAllModels ? defaultModelSub(agent, state.models[agent]) : 'CLI setting')}</span>
    ${p && p.use ? `<span class="model-use">${esc(p.use)}</span>` : ''}</button>`;
}

function openAgentSheet() {
  const agent = state.agent;
  const cat = state.models[agent];
  const sel = currentModel(agent);
  const models = (cat && cat.models) || [];
  const a = AGENTS[agent];

  let modelSection = '';
  if (MODEL_AGENTS.includes(agent)) {
    // A short pick (default + the first two offered + the current choice); the rest behind "All models".
    const quick = models.slice(0, 2);
    const selModel = models.find((m) => m.id === sel);
    if (selModel && !quick.includes(selModel)) quick.push(selModel);
    const list = showAllModels ? models : quick;
    modelSection = `
      <div class="sheet-row">
        <h4>${esc(a.name)} model</h4>
        <button class="btn btn-ghost btn-sm" data-refresh-models>${icon('i-refresh', 'xs')}Refresh</button>
      </div>
      <div class="sheet-meta">${esc(modelMeta(agent, cat))}</div>
      <div class="model-grid ${showAllModels ? 'all' : ''}" role="radiogroup" aria-label="Model" style="--opt-c:${a.color}">
        ${modelOpt(agent, null, sel)}${list.map((m) => modelOpt(agent, m, sel)).join('')}
      </div>
      ${models.length > quick.length ? `<button class="link-btn" data-toggle-all-models>${showAllModels ? 'Show fewer' : `All ${models.length} models`}</button>` : ''}`;
  }

  openSheet(`
    <h3>Who should handle this?</h3>
    <div class="agent-list" role="radiogroup" aria-label="Agent">${AGENT_ORDER.map((k) => {
      const x = AGENTS[k];
      const on = k === agent;
      return `<button class="agent-opt ${on ? 'selected' : ''}" role="radio" aria-checked="${on}" style="--opt-c:${x.color}" data-pick-agent="${k}">
        <span class="opt-ico">${icon(x.icon)}</span>
        <span class="opt-main"><span class="opt-title">${esc(x.name)}</span><span class="opt-sub">${esc(agentSub(k))}</span></span>
        <span class="tick">${icon('i-check')}</span>
      </button>`;
    }).join('')}</div>
    ${modelSection}`);

  // Keep the list current without making the user wait: refresh quietly if it's been a while.
  if (MODEL_AGENTS.includes(agent) && Date.now() - state.modelsLoadedAt > 10 * 60 * 1000) {
    loadModels().then((ok) => { if (ok && !$('#sheet').hidden && $('.agent-list')) openAgentSheet(); });
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
          <div class="opt-title">Choose files from this device</div>
          <div class="opt-sub">Photo library, documents, or files on your current computer or phone</div>
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
  openSheet(`<div class="file-loading">Loading…</div>`);
  try {
    const data = await api(`/api/file/view?path=${encodeURIComponent(filePath)}`);
    const parent = data.path.substring(0, data.path.lastIndexOf('/')) || '/';
    const lines = data.is_text && data.content ? data.content.split('\n') : [];
    const lineCount = lines.length;
    const numbered = lines.map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join('\n');
    const isImage = ['png','jpg','jpeg','gif','webp','svg','ico','bmp'].includes(data.ext);
    const isPdf = data.is_pdf || data.ext === 'pdf';
    const rawUrl = `/api/file/raw?path=${encodeURIComponent(data.path)}`;

    openSheet(`
      <div class="fv-head">
        <button class="icon-btn" data-browse-to="${esc(parent)}" aria-label="Back" title="Back to files">${icon('i-back')}</button>
        <div class="fv-info">
          <span class="fv-name">${esc(data.name)}</span>
          <span class="fv-meta">${esc(data.size_fmt)}${lineCount ? ` · ${lineCount} lines` : ''} · ${esc(data.ext || 'file')}</span>
        </div>
        ${data.is_text ? `<button class="icon-btn" data-copy-file-content aria-label="Copy contents" title="Copy text">${icon('i-copy')}</button>` : ''}
        <button class="icon-btn" data-sheet="cancel" aria-label="Close" title="Close viewer">${icon('i-x')}</button>
      </div>
      <div class="fv-path">${esc(data.path)}</div>

      ${isPdf ? `
        <div class="fv-pdf">
          <div class="fv-pdf-float-bar">
            <button type="button" data-browse-to="${esc(parent)}">${icon('i-back', 'xs')} Back</button>
            <a href="${rawUrl}" download="${esc(data.name)}">${icon('i-download', 'xs')} Download</a>
            <button type="button" data-sheet="cancel">${icon('i-x', 'xs')} Close</button>
          </div>
          <iframe src="${rawUrl}#toolbar=0" title="${esc(data.name)}" referrerpolicy="no-referrer"></iframe>
        </div>` :
        isImage ? `
        <div class="fv-image">
          <img src="${rawUrl}" alt="${esc(data.name)}">
        </div>` :
        data.is_text && data.content !== null ? `<pre class="fv-code">${numbered}</pre>` :
        `<div class="fv-binary">${icon('i-box')}<span>${esc(data.size_fmt)} · can't preview this type</span></div>`}

      <div class="fv-actions">
        ${data.is_text ? `<button class="btn" data-fx-edit="${esc(data.path)}">${icon('i-edit')}Edit</button>` : ''}
        <a class="btn" href="${rawUrl}" download="${esc(data.name)}">${icon('i-download')}Download</a>
        <button class="btn" data-attach-vm-file="${esc(data.path)}" data-name="${esc(data.name)}" data-ext="${esc(data.ext)}" data-size="${esc(data.size_fmt)}">${icon('i-plus')}Attach</button>
        <button class="btn" data-ask-file="${esc(data.path)}">${icon('i-send')}Ask agent</button>
        <button class="btn" data-copy="${esc(data.path)}">${icon('i-copy')}Copy path</button>
      </div>
    `, (body) => {
      body._fileContent = data.content || '';
    }, { full: isPdf || isImage });
  } catch (err) {
    toast(err.message || 'Could not load file', 'err');
    openWorkspaceSheet(currentBrowsingPath || '/root');
  }
}

async function openGitChangesSheet(fileToDiff = null) {
  openSheet(`
    <div class="browser-header">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0;">Project Code Changes</h3>
        <span class="muted sm mono" style="font-size:11px;">${esc(basename(state.workspace))}</span>
      </div>
      <p class="lead" style="margin:0;">Modified code in green (+) and removed code in red (-).</p>
    </div>
    <div style="color:var(--text-3); font-size:13px; text-align:center; padding:24px 0;">Inspecting repository changes…</div>
  `);

  try {
    const data = await api(`/api/git/changes?workspace=${encodeURIComponent(state.workspace)}`);
    if (!data.is_git) {
      openSheet(`
        <h3>Project Code Changes</h3>
        <p class="lead">${esc(data.summary || 'Not a git repository.')}</p>
        <div class="empty-inline" style="margin-top:12px;">The active folder <code>${esc(state.workspace)}</code> is not a git repository.</div>
      `);
      return;
    }

    if (!data.files || !data.files.length) {
      openSheet(`
        <div class="browser-header">
          <h3 style="margin:0;">Project Code Changes</h3>
          <p class="lead" style="margin:0;">Working tree is clean.</p>
        </div>
        <div class="empty-inline" style="margin-top:14px;">
          ✨ No uncommitted code changes in <code>${esc(basename(state.workspace))}</code>.
        </div>
      `);
      return;
    }

    if (fileToDiff) {
      const diffRes = await api(`/api/git/diff?workspace=${encodeURIComponent(state.workspace)}&file=${encodeURIComponent(fileToDiff)}`);
      const { html, adds, dels } = formatDiffCode(diffRes.diff || 'No diff content available for this file.');
      openSheet(`
        <div class="browser-header">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <button class="btn btn-ghost btn-sm" data-action="open-git-changes" style="padding:2px 8px; font-size:12px;">← Back to files</button>
            <span class="diff-stats"><span class="diff-badge-add">+${adds}</span> <span class="diff-badge-del">-${dels}</span></span>
          </div>
          <h3 style="margin:4px 0 0 0; font-family:var(--mono); font-size:13px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(fileToDiff)}</h3>
        </div>
        <div class="git-diff-view" style="margin-top:10px;">${html}</div>
      `);
      return;
    }

    const fileItems = data.files.map((f) => {
      const stCls = f.status.includes('M') ? 'M' : (f.status.includes('A') || f.status.includes('?') ? 'A' : (f.status.includes('D') ? 'D' : 'M'));
      const stLabel = f.status.includes('?') ? 'NEW' : f.status;
      return `
        <div class="git-change-item" data-action="view-file-diff" data-file="${esc(f.path)}">
          <div class="git-change-info">
            <span class="git-status-tag ${stCls}">${esc(stLabel)}</span>
            <span class="git-change-path" title="${esc(f.path)}">${esc(f.path)}</span>
          </div>
          <div class="diff-stats">
            ${f.adds > 0 ? `<span class="diff-badge-add">+${f.adds}</span>` : ''}
            ${f.dels > 0 ? `<span class="diff-badge-del">-${f.dels}</span>` : ''}
            <svg class="i xs muted"><use href="#i-chevron"/></svg>
          </div>
        </div>
      `;
    }).join('');

    openSheet(`
      <div class="browser-header">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3 style="margin:0;">Project Code Changes</h3>
          <span class="diff-stats"><span class="diff-badge-add">+${data.total_adds}</span> <span class="diff-badge-del">-${data.total_dels}</span></span>
        </div>
        <p class="lead" style="margin:0;">${data.files.length} changed file${data.files.length === 1 ? '' : 's'} in <code>${esc(basename(state.workspace))}</code>. Tap any file to inspect red/green changes.</p>
      </div>
      <div class="git-changes-list" style="margin-top:10px;">
        ${fileItems}
      </div>
    `);
  } catch (e) {
    toast('Could not inspect git changes', 'err');
  }
}

async function checkGitChanges() {
  const ws = state.workspace;
  try {
    const data = await api(`/api/git/changes?workspace=${encodeURIComponent(ws)}`);
    state.git = data.is_git && data.files && data.files.length ? { ws, ...data } : null;
  } catch {
    state.git = null;
  }
  syncGitBar();
  renderInspector();
}

function syncGitBar() {
  const btn = $('#gitChangesBtn');
  if (!btn) return;
  const g = state.git;
  btn.hidden = !g || chromeMode() !== 'thread';
  if (!g) return;
  $('#gitChangesText').textContent = `${g.files.length} file${g.files.length === 1 ? '' : 's'} changed in ${basename(g.ws)}`;
  $('#gitChangesSummary').innerHTML = `<span class="add">+${g.total_adds}</span><span class="del">−${g.total_dels}</span>`;
}

const wideScreen = window.matchMedia('(min-width: 1280px)');

// Desktop right-hand panel: the latest reply's steps, uncommitted changes and the workspace.
function renderInspector() {
  if (!wideScreen.matches) return;
  const last = $$('.msg.assistant', threadEl()).pop();
  const acts = last ? extractAllActivities(last._raw) : [];
  const live = !!(last && last.classList.contains('streaming'));
  $('#inspSteps').innerHTML = acts.length
    ? `<ol class="steps">${acts.slice(-12).map((a, i, arr) => stepLine(a, live && i === arr.length - 1)).join('')}</ol>`
    : `<span class="muted sm">${live ? 'Starting…' : 'Steps appear here while an agent works.'}</span>`;
  const g = state.git;
  $('#inspChangesTitle').innerHTML = g ? `Changes in ${esc(basename(g.ws))} <span class="add">+${g.total_adds}</span> <span class="del">−${g.total_dels}</span>` : 'Changes';
  $('#inspChanges').innerHTML = g
    ? g.files.slice(0, 12).map((f) => `<button class="insp-file" data-action="view-file-diff" data-file="${esc(f.path)}"><span class="tag">${esc(f.status.includes('?') ? 'A' : f.status.trim().charAt(0) || 'M')}</span><span class="path">${esc(f.path)}</span>${f.adds ? `<span class="add">+${f.adds}</span>` : ''}</button>`).join('')
      + (g.files.length > 12 ? `<button class="link-btn" data-action="open-git-changes">All ${g.files.length} files</button>` : '')
    : '<span class="muted sm">No uncommitted changes.</span>';
  $('#inspWs').textContent = state.workspace;
}
wideScreen.addEventListener?.('change', renderInspector);

// Folders worth offering first: recently used (this device + conversation history) and the server's pinned list.
function folderShortcuts() {
  const seen = new Set();
  const take = (path, name, sub) => {
    if (!path || seen.has(path)) return null;
    seen.add(path);
    return { path, name: name || basename(path), sub: (sub || path).replace(/^\/root(?=\/|$)/, '~') };
  };
  const fromHistory = [...state.sessions].sort((a, b) => b.updated_at - a.updated_at).map((x) => x.workspace);
  const recent = [...store.get('recentWs', []), ...fromHistory]
    .map((p) => take(p)).filter(Boolean).slice(0, 6);
  const pinned = (state.workspaces || [])
    .map((w) => take(w.path, (w.name || '').replace(/\s*\(.*\)\s*$/, ''), w.path)).filter(Boolean);
  return { recent, pinned };
}

function folderRow(f) {
  const on = f.path === state.workspace;
  return `<button class="folder-row ${on ? 'selected' : ''}" data-select-browse-ws="${esc(f.path)}" data-q="${esc((f.name + ' ' + f.path).toLowerCase())}">
    <span class="folder-ico">${icon('i-folder')}</span>
    <span class="folder-main"><span class="folder-name">${esc(f.name)}</span><span class="folder-path">${esc(f.sub)}</span></span>
    ${on ? `<span class="tick">${icon('i-check')}</span>` : ''}
  </button>`;
}

// One tap picks a folder; browsing the VM is the fallback.
function openFolderPicker() {
  browseMode = 'workspace';
  const { recent, pinned } = folderShortcuts();
  openSheet(`
    <h3>Choose a folder</h3>
    <div class="search folder-search">
      ${icon('i-search')}
      <input id="folderQuery" type="search" placeholder="Filter, or paste a path like /root/…" autocomplete="off" spellcheck="false" aria-label="Filter folders or enter a path">
    </div>
    <button class="folder-row path-go" id="folderPathGo" hidden></button>
    ${recent.length ? `<div class="folder-group"><h4>Recent</h4>${recent.map(folderRow).join('')}</div>` : ''}
    ${pinned.length ? `<div class="folder-group"><h4>Pinned</h4>${pinned.map(folderRow).join('')}</div>` : ''}
    <button class="folder-row browse" data-browse-to="${esc(state.workspace || '/root')}">
      <span class="folder-ico">${icon('i-search')}</span>
      <span class="folder-main"><span class="folder-name">Browse all folders</span><span class="folder-path">Starting from ${esc(basename(state.workspace || '/root'))}</span></span>
      ${icon('i-chevron', 'xs muted')}
    </button>`, (body) => {
    const q = $('#folderQuery', body);
    const go = $('#folderPathGo', body);
    q.addEventListener('input', () => {
      const v = q.value.trim();
      const lv = v.toLowerCase();
      $$('.folder-group .folder-row', body).forEach((r) => { r.hidden = !!lv && !r.dataset.q.includes(lv); });
      $$('.folder-group', body).forEach((g) => { g.hidden = !$$('.folder-row', g).some((r) => !r.hidden); });
      const isPath = v.startsWith('/') || v.startsWith('~');
      go.hidden = !isPath;
      if (isPath) {
        const path = v.replace(/^~/, '/root');
        go.dataset.browseTo = path;
        go.innerHTML = `<span class="folder-ico">${icon('i-folder')}</span><span class="folder-main"><span class="folder-name">Open ${esc(path)}</span><span class="folder-path">Browse into it, then tap Use</span></span>${icon('i-chevron', 'xs muted')}`;
      }
    });
    q.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!go.hidden) { openWorkspaceSheet(go.dataset.browseTo); return; }
      const first = $$('.folder-group .folder-row', body).find((r) => !r.hidden);
      if (first) first.click();
    });
  });
}

let browseMode = 'workspace';   // 'workspace' picks a folder; 'attach' also lists files to attach

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

    const attach = browseMode === 'attach';
    const explore = browseMode === 'files';
    const title = attach ? 'Attach a file' : explore ? 'Files' : 'Browse';
    openSheet(`
      <div class="browser-top">
        ${attach || explore ? '' : `<button class="btn btn-ghost btn-sm" data-action="open-workspaces">${icon('i-back', 'xs')}Shortcuts</button>`}
        <h3>${title}</h3>
        <button class="btn btn-ghost btn-sm" data-action="toggle-hidden-folders">${browseShowHidden ? 'Hide hidden' : 'Show hidden'}</button>
      </div>

      <div class="browser-crumbs">${breadcrumbHtml}</div>

      ${explore ? `
      <div class="fx-toolbar">
        <button class="btn btn-ghost btn-sm" data-fx-new="file" ${data.writable ? '' : 'disabled'}>${icon('i-plus', 'xs')}New file</button>
        <button class="btn btn-ghost btn-sm" data-fx-new="folder" ${data.writable ? '' : 'disabled'}>${icon('i-folder', 'xs')}New folder</button>
        ${data.writable ? '' : '<span class="fx-readonly">Read-only</span>'}
      </div>` : ''}

      <div class="browse-list">
        ${data.parent ? `
          <button class="browse-row" data-browse-to="${esc(data.parent)}">
            <span class="browse-left">${icon('i-back', 'xs muted')}<span class="browse-name muted">Up to ${esc(basename(data.parent))}</span></span>
          </button>` : ''}
        ${dirs.map((d) => `
          <div class="browse-row folder ${d.path === state.workspace ? 'current' : ''}">
            <button class="browse-left browse-open" data-browse-to="${esc(d.path)}">
              ${icon('i-folder')}<span class="browse-name">${esc(d.name)}</span>${icon('i-chevron', 'xs muted')}
            </button>
            ${explore ? `<button class="icon-btn sm" data-fx-menu data-path="${esc(d.path)}" data-name="${esc(d.name)}" data-is-dir="1" aria-label="More">${icon('i-more')}</button>`
              : attach ? '' : `<button class="use-btn" data-select-browse-ws="${esc(d.path)}">${d.path === state.workspace ? 'In use' : 'Use'}</button>`}
          </div>`).join('')}
        ${files.length ? `
          <div class="browse-section-title">Files (${files.length})</div>
          ${files.map((f) => `
            <div class="browse-row file">
              <button class="browse-left" data-view-file="${esc(f.path)}">
                <span class="file-ico">${fileIcon(f.ext)}</span><span class="browse-name">${esc(f.name)}</span>
              </button>
              ${explore ? `<button class="icon-btn sm" data-fx-menu data-path="${esc(f.path)}" data-name="${esc(f.name)}" data-is-dir="0" aria-label="More">${icon('i-more')}</button>`
                : `<span class="browse-size">${esc(f.size_fmt)}</span>`}
            </div>`).join('')}` : ''}
        ${!dirs.length && !files.length ? `<div class="browse-empty">Empty folder.</div>` : ''}
      </div>

      ${attach || explore ? '' : `
      <button class="btn btn-primary btn-block use-here" data-select-browse-ws="${esc(data.path)}">
        ${icon('i-check')} ${isCurrentActive ? 'Keep' : 'Use'} “${esc(data.name || data.path)}”
      </button>`}
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

/* ── File explorer operations (create / rename / delete / edit) ── */

async function fxCreate(kind) {
  const parent = currentBrowsingPath || '/root';
  const name = await promptSheet({
    title: kind === 'folder' ? 'New folder' : 'New file',
    message: `In ${parent}`,
    placeholder: kind === 'folder' ? 'folder-name' : 'file.txt',
    confirm: 'Create',
  });
  if (!name) { openWorkspaceSheet(parent); return; }
  try {
    await api('/api/file/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, name, is_dir: kind === 'folder' }),
    });
    toast(`${kind === 'folder' ? 'Folder' : 'File'} created`, 'ok');
    openWorkspaceSheet(parent);
  } catch (err) {
    toast(err.message || 'Create failed', 'err');
    openWorkspaceSheet(parent);
  }
}

function fxMenu(path, name, isDir) {
  openSheet(`
    <div class="fx-menu-head">
      <span class="file-ico">${isDir ? icon('i-folder') : fileIcon(name.split('.').pop())}</span>
      <span class="fx-menu-name">${esc(name)}</span>
    </div>
    <div class="fx-menu-list">
      ${isDir
        ? `<button class="opt" data-fx-open="${esc(path)}"><span class="opt-ico">${icon('i-folder')}</span><span class="opt-main"><span class="opt-title">Open</span></span></button>`
        : `<button class="opt" data-view-file="${esc(path)}"><span class="opt-ico">${icon('i-search')}</span><span class="opt-main"><span class="opt-title">View</span></span></button>
           <button class="opt" data-fx-edit="${esc(path)}"><span class="opt-ico">${icon('i-edit')}</span><span class="opt-main"><span class="opt-title">Edit</span></span></button>
           <a class="opt" href="/api/file/raw?path=${encodeURIComponent(path)}" download="${esc(name)}"><span class="opt-ico">${icon('i-download')}</span><span class="opt-main"><span class="opt-title">Download</span></span></a>`}
      <button class="opt" data-fx-rename="${esc(path)}" data-name="${esc(name)}"><span class="opt-ico">${icon('i-sliders')}</span><span class="opt-main"><span class="opt-title">Rename</span></span></button>
      <button class="opt" data-fx-copy-path="${esc(path)}"><span class="opt-ico">${icon('i-copy')}</span><span class="opt-main"><span class="opt-title">Copy path</span></span></button>
      <button class="opt danger" data-fx-delete="${esc(path)}" data-name="${esc(name)}" data-is-dir="${isDir ? 1 : 0}"><span class="opt-ico">${icon('i-trash')}</span><span class="opt-main"><span class="opt-title">Delete</span></span></button>
    </div>
  `);
}

async function fxRename(path, name) {
  const newName = await promptSheet({
    title: 'Rename',
    value: name,
    confirm: 'Rename',
  });
  const parent = path.substring(0, path.lastIndexOf('/')) || '/';
  if (!newName || newName === name) { openWorkspaceSheet(parent); return; }
  try {
    await api('/api/file/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, new_name: newName }),
    });
    toast('Renamed', 'ok');
    openWorkspaceSheet(parent);
  } catch (err) {
    toast(err.message || 'Rename failed', 'err');
    openWorkspaceSheet(parent);
  }
}

async function fxDelete(path, name, isDir) {
  const parent = path.substring(0, path.lastIndexOf('/')) || '/';
  const ok = await confirmSheet({
    title: `Delete "${name}"?`,
    message: isDir ? 'This folder and everything inside it will be permanently removed.' : 'This file will be permanently removed.',
    confirm: 'Delete',
    danger: true,
  });
  if (!ok) { openWorkspaceSheet(parent); return; }
  try {
    await api('/api/file/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    toast('Deleted', 'ok');
    openWorkspaceSheet(parent);
  } catch (err) {
    toast(err.message || 'Delete failed', 'err');
    openWorkspaceSheet(parent);
  }
}

async function openFileEditor(filePath) {
  openSheet(`<div class="file-loading">Loading…</div>`);
  try {
    const data = await api(`/api/file/view?path=${encodeURIComponent(filePath)}`);
    if (!data.is_text) {
      toast('This file is not editable as text', 'err');
      return openFileSheet(filePath);
    }
    const parent = data.path.substring(0, data.path.lastIndexOf('/')) || '/';
    openSheet(`
      <div class="fv-head">
        <button class="icon-btn" data-view-file="${esc(data.path)}" aria-label="Back">${icon('i-back')}</button>
        <div class="fv-info">
          <span class="fv-name">${esc(data.name)}</span>
          <span class="fv-meta">Editing${data.writable ? '' : ' · read-only'}</span>
        </div>
        <button class="icon-btn" data-fx-save aria-label="Save" ${data.writable ? '' : 'disabled'}>${icon('i-check')}</button>
      </div>
      <div class="fv-path">${esc(data.path)}</div>
      <textarea id="fxEditor" class="fx-editor" spellcheck="false" ${data.writable ? '' : 'readonly'}>${esc(data.content || '')}</textarea>
      <div class="fv-actions">
        <button class="btn btn-primary" data-fx-save data-path="${esc(data.path)}" ${data.writable ? '' : 'disabled'}>${icon('i-check')}Save</button>
        <button class="btn" data-view-file="${esc(data.path)}">Cancel</button>
      </div>
    `, (body) => {
      body._editPath = data.path;
      body._editParent = parent;
      const ta = body.querySelector('#fxEditor');
      if (ta) ta.focus();
    });
  } catch (err) {
    toast(err.message || 'Could not load file', 'err');
  }
}

async function fxSave() {
  const body = $('#sheetBody');
  const ta = $('#fxEditor');
  if (!body || !ta) return;
  const path = body._editPath;
  try {
    await api('/api/file/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: ta.value }),
    });
    toast('Saved', 'ok');
    openFileSheet(path);
  } catch (err) {
    toast(err.message || 'Save failed', 'err');
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

const TAB_TITLES = { skills: 'Skills', terminal: 'Terminal', monitor: 'System', history: 'All chats', settings: 'Settings' };

// Desktop preference persists; mobile navigation starts closed.
const navDesktop = window.matchMedia('(min-width: 900px)');
function setNavOpen(open) {
  const rail = $('#rail');
  rail.classList.toggle('open', open);
  rail.inert = !open;
  rail.setAttribute('aria-hidden', String(!open));
  document.body.classList.toggle('nav-collapsed', !open);
  $('#navToggle').setAttribute('aria-expanded', String(open));
  $('#navToggle').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  $('#navBackdrop').hidden = navDesktop.matches || !open;
  if (navDesktop.matches) store.set('navOpen', open);
}
function openNav() { setNavOpen(true); }
function closeNav() {
  const focusInRail = $('#rail').contains(document.activeElement);
  setNavOpen(false);
  if (focusInRail) $('#navToggle').focus({ preventScroll: true });
}
function toggleNav() { setNavOpen(!$('#rail').classList.contains('open')); }
navDesktop.addEventListener('change', () => setNavOpen(navDesktop.matches && store.get('navOpen', true)));
setNavOpen(navDesktop.matches && store.get('navOpen', true));

function switchTab(tab) {
  if (state.tab === 'history' && tab !== 'history' && $('#historySearch')) $('#historySearch').value = '';   // don't keep a folder filter around
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
  if (tab === 'history') { loadSessions(); renderHistory(); if (!$('#historySearch').value) setTimeout(() => $('#historySearch')?.focus({ preventScroll: true }), 80); }
  if (tab === 'settings') { refreshSettings(); checkTunnel(); }
  if (tab === 'chat') {
    // Thread: stick to the latest message. Home: start at the top so the
    // most recent folder (and anything running) is what you land on.
    if (chromeMode() === 'thread') { state.stick && scrollToBottom(); }
    else threadEl().scrollTop = 0;
  }
  syncMonitorPolling();
}

// Home = the Chats tab with no conversation open; thread = a conversation is open.
function chromeMode() {
  if (state.tab !== 'chat') return 'tab';
  return state.messages.length || state.sessionId ? 'thread' : 'home';
}

function updateTitle() {
  const mode = chromeMode();
  document.body.dataset.mode = mode;
  $('#view-chat').classList.toggle('is-home', mode === 'home');
  $('#viewTitle').textContent = mode === 'home' ? 'AgentHub' : mode === 'thread' ? (state.title || 'New chat') : (TAB_TITLES[state.tab] || 'AgentHub');
  $('#backBtn').hidden = mode !== 'thread';
  $('#topbarSub').hidden = mode !== 'thread';
  $('#topbarStatus').hidden = mode !== 'home';
  $('#tbSearch').hidden = mode !== 'home';
  if ($('#tbNewChat')) $('#tbNewChat').hidden = mode !== 'thread';
  $('#tbSettings').hidden = mode === 'thread' || state.tab === 'settings';
  $('#tbMore').hidden = mode !== 'thread';
  $$('#tabbar [data-tab="chat"]').forEach((b) => b.classList.toggle('active', state.tab === 'chat' || state.tab === 'history'));
  updateTopbarSub();
  setPlaceholder();
  syncGitBar();
  renderInspector();
  updateHomeStatus();
}

function setPlaceholder() {
  $('#promptInput').placeholder = state.agent === 'bash' ? 'Run a shell command…'
    : chromeMode() === 'home' ? 'What should an agent do?' : 'Add a follow-up…';
}

function updateTopbarSub() {
  const a = AGENTS[state.agent];
  const model = MODEL_AGENTS.includes(state.agent) ? currentModel() : null;
  $('#topbarSubText').textContent = [a.name, model ? modelName(state.agent, model) : '', basename(state.workspace)].filter(Boolean).join(' · ');
}

/* ════════════════════════════════════════════════════════════
   Agent / workspace selection
   ════════════════════════════════════════════════════════════ */

const AGENT_ORDER = ['auto', 'regina', 'claude', 'antigravity', 'codex', 'bash'];

// Home composer: one chip per agent plus the workspace. Tapping the selected agent opens the model picker.
function renderAgentRow() {
  const row = $('#agentRow');
  if (!row) return;
  row.innerHTML = AGENT_ORDER.map((k) => {
    const a = AGENTS[k];
    const on = k === state.agent;
    const model = on && MODEL_AGENTS.includes(k) ? currentModel(k) : null;
    const label = k === 'claude' ? 'Claude' : a.name;
    return `<button class="agent-chip ${on ? 'on' : ''}" role="radio" aria-checked="${on}" style="--agent:${a.color}" data-agent-chip="${k}">
      <span class="dot"></span>${esc(model ? `${label} · ${modelName(k, model)}` : label)}${on && MODEL_AGENTS.includes(k) ? icon('i-chevron-down', 'xs') : ''}</button>`;
  }).join('');
  $('#wsBtnLabel').textContent = basename(state.workspace);
  $('#wsBtn').title = state.workspace;
}

function applyAgent() {
  const a = AGENTS[state.agent];
  document.documentElement.style.setProperty('--agent', a.color);
  const model = currentModel();
  $('#voiceAgent').textContent = model ? agentLabel(state.agent, model) : a.full;
  $('#setAgentSub').textContent = model ? `${a.full} · ${modelName(state.agent, model)}` : `${a.full} · default model`;
  setPlaceholder();
  store.set('agent', state.agent);
  renderAgentRow();
  updateTopbarSub();
}

function setAgent(key) {
  if (!AGENTS[key]) return;
  state.agent = key;
  applyAgent();
}

function applyWorkspace() {
  $('#setWsSub').textContent = state.workspace;
  renderAgentRow();
  updateTopbarSub();
  store.set('workspace', state.workspace);
  checkGitChanges();
}

function setWorkspace(path) {
  if (path === state.workspace) return;
  state.workspace = path;
  store.set('recentWs', [path, ...store.get('recentWs', []).filter((p) => p !== path)].slice(0, 8));
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
  renderHome();
}

// The Chats home: what is running now, then recent conversations.
// Chats grouped by the folder they ran in, busiest-recent folder first.
function groupByFolder(list) {
  const groups = new Map();
  list.forEach((s) => {
    const ws = s.workspace || '';
    if (!groups.has(ws)) groups.set(ws, []);
    groups.get(ws).push(s);
  });
  return [...groups].map(([ws, items]) => ({ ws, items, last: Math.max(...items.map((x) => x.updated_at || 0)) }))
    .sort((x, y) => y.last - x.last);
}

const prettyPath = (p) => (p || '').replace(/^\/root(?=\/|$)/, '~');

function groupToggle() {
  const f = state.groupBy === 'folder';
  return `<div class="group-toggle" role="radiogroup" aria-label="Group chats">
    <button role="radio" aria-checked="${f}" class="${f ? 'on' : ''}" data-group-by="folder">Folders</button>
    <button role="radio" aria-checked="${!f}" class="${f ? '' : 'on'}" data-group-by="date">Latest</button>
  </div>`;
}

function folderHead(ws, count) {
  const cur = ws && ws === state.workspace;
  return `<div class="folder-head ${cur ? 'current' : ''}">
    ${icon('i-folder', 'xs')}
    <span class="folder-head-main"><span class="folder-head-name">${esc(ws ? basename(ws) : 'No folder')}</span>${ws ? `<span class="folder-head-path">${esc(prettyPath(ws))}</span>` : ''}</span>
    <span class="folder-head-count">${count}</span>
    ${ws ? `<button class="icon-btn sm" data-browse-ws="${esc(ws)}" aria-label="Browse files in ${esc(basename(ws))}" title="Browse files">${icon('i-folder')}</button>
    <button class="icon-btn sm" data-new-in-ws="${esc(ws)}" aria-label="New task in ${esc(basename(ws))}" title="New task in this folder">${icon('i-plus')}</button>` : ''}
  </div>`;
}

function chatRow(s) {
  const a = AGENTS[s.agent] || AGENTS.antigravity;
  return `
    <div class="swipe-row chat-swipe-row" data-sess-id="${esc(s.id)}">
      <div class="swipe-actions">
        <button class="swipe-del-btn" data-del="${esc(s.id)}" aria-label="Delete conversation" title="Delete conversation">
          ${icon('i-trash')}
          <span>Delete</span>
        </button>
      </div>
      <div class="chat-row" data-open="${esc(s.id)}" role="button" tabindex="0">
        <span class="dot" style="--agent:${a.color}"></span>
        <span class="chat-row-main">
          <span class="chat-row-title">${esc(s.title || 'Untitled')}</span>
          <span class="chat-row-meta">${esc(a.name)} · ${esc(relTime(s.updated_at))}</span>
        </span>
      </div>
    </div>`;
}

// The Chats home: what is running now, then recent conversations (by folder or by date).
function renderHome() {
  if (state.messages.length || state.sessionId) return;
  const agentOf = (s) => AGENTS[s.agent] || AGENTS.antigravity;
  const running = state.sessions.filter((s) => state.running.has(s.id));
  const rest = state.sessions.filter((s) => !state.running.has(s.id));
  const runCards = running.map((s) => `
    <button class="run-card" data-open="${esc(s.id)}" style="--agent:${agentOf(s).color}">
      <span class="run-card-head">
        <span class="avatar">${icon(agentOf(s).icon)}</span>
        <span class="run-card-main">
          <span class="run-card-title">${esc(s.title || 'Untitled')}</span>
          <span class="run-card-meta">${esc(agentOf(s).name)}${s.workspace ? ` · ${esc(basename(s.workspace))}` : ''}</span>
        </span>
      </span>
      <span class="run-card-live"><span class="live-dot"></span>Working — tap to follow along</span>
    </button>`).join('');

  let list;
  if (!rest.length) {
    list = `<p class="home-empty">${state.sessionsLoaded ? 'No conversations yet. Describe a task above and pick an agent.' : 'Loading conversations…'}</p>`;
  } else if (state.groupBy === 'folder') {
    list = groupByFolder(rest).slice(0, 8).map((g) => {
      return `<div class="folder-group-card">${folderHead(g.ws, g.items.length)}${g.items.slice(0, 3).map(chatRow).join('')}
        ${g.items.length > 3 && g.ws ? `<button class="link-btn more" data-history-ws="${esc(g.ws)}">All ${g.items.length} in ${esc(basename(g.ws))}</button>` : ''}</div>`;
    }).join('');
  } else {
    list = rest.slice(0, 8).map(chatRow).join('');
  }

  threadEl().innerHTML = `
    <div class="home">
      ${running.length ? `<section class="home-sec"><h2>Running now</h2>${runCards}</section>` : ''}
      <section class="home-sec">
        <div class="home-sec-head"><h2>Recent</h2>${rest.length ? groupToggle() : ''}</div>
        ${list}
        ${state.sessions.length ? '<button class="link-btn" data-tab="history">All chats</button>' : ''}
      </section>
    </div>`;
}

const TAG_PARTIAL_RE = /^\s*(?:🚀|🟣|🟢|🔷|⚙️)(?:\s*\*(?:\[[^\n\]]*)?)?\s*$/u;

function stripTag(text) {
  const m = TAG_RE.exec(text);
  if (!m) return { text: TAG_PARTIAL_RE.test(text) ? '' : text, agent: null };
  return { text: text.slice(m[0].length), agent: AGENT_TAGS[m[1]] || null };
}

function mdToHtml(text) {
  if (!window.marked || !window.DOMPurify) return `<p style="white-space:pre-wrap">${esc(text)}</p>`;
  let processed = (text || '').replace(/!\[([^\]]*)\]\((file:\/\/\/?[^\)]+|\/[^\)]+)\)/g, (match, alt, rawUrl) => {
    let clean = rawUrl;
    if (clean.startsWith('file://')) clean = clean.slice(7);
    if (clean.startsWith('/') && !clean.startsWith('/static') && !clean.startsWith('/uploads') && !clean.startsWith('/api/')) {
      return `![${alt}](/api/file/raw?path=${encodeURIComponent(clean)})`;
    }
    return match;
  });
  return DOMPurify.sanitize(marked.parse(processed, { gfm: true, breaks: true }));
}

function openPhoneSheet(tel, label) {
  const shown = (label || tel).trim();
  openSheet(`
    <div class="fx-menu-head"><span class="fx-menu-name">${esc(shown)}</span></div>
    <div class="fx-menu-list">
      <a class="opt" href="tel:${esc(tel)}" data-sheet="close"><span class="opt-ico">${icon('i-link')}</span><span class="opt-main"><span class="opt-title">Call</span></span></a>
      <button class="opt" data-copy-val="${esc(shown)}"><span class="opt-ico">${icon('i-copy')}</span><span class="opt-main"><span class="opt-title">Copy number</span></span></button>
    </div>
  `);
}

function openLinkSheet(url) {
  openSheet(`
    <div class="fx-menu-head"><span class="fx-menu-name" style="word-break:break-all">${esc(url)}</span></div>
    <div class="fx-menu-list">
      <a class="opt" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><span class="opt-ico">${icon('i-globe')}</span><span class="opt-main"><span class="opt-title">Open in browser</span></span></a>
      <button class="opt" data-copy-val="${esc(url)}"><span class="opt-ico">${icon('i-copy')}</span><span class="opt-main"><span class="opt-title">Copy link</span></span></button>
    </div>
  `);
}

function formatDiffCode(rawCode) {
  const lines = (rawCode || '').split('\n');
  let adds = 0;
  let dels = 0;
  const htmlLines = lines.map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) {
      return `<div class="diff-line diff-meta"><span class="diff-sign"> </span><span class="diff-text">${esc(line)}</span></div>`;
    }
    if (line.startsWith('+')) {
      adds++;
      return `<div class="diff-line diff-add"><span class="diff-sign">+</span><span class="diff-text">${esc(line.slice(1))}</span></div>`;
    }
    if (line.startsWith('-')) {
      dels++;
      return `<div class="diff-line diff-del"><span class="diff-sign">-</span><span class="diff-text">${esc(line.slice(1))}</span></div>`;
    }
    if (line.startsWith('@@')) {
      return `<div class="diff-line diff-hunk"><span class="diff-sign"> </span><span class="diff-text">${esc(line)}</span></div>`;
    }
    const cleanL = line.startsWith(' ') ? line.slice(1) : line;
    return `<div class="diff-line diff-ctx"><span class="diff-sign"> </span><span class="diff-text">${esc(cleanL)}</span></div>`;
  });
  return { html: htmlLines.join(''), adds, dels };
}

const PHONE_RE = /(?<![\w@/.:-])\+?\(?\d[\d ()./-]{6,17}\d(?![\w@-])/g;
function linkifyPhones(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !n.parentElement.closest('a, pre, code, .katex, button')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    const txt = node.nodeValue;
    PHONE_RE.lastIndex = 0;
    let last = 0, m, frag = null;
    while ((m = PHONE_RE.exec(txt))) {
      const digits = m[0].replace(/\D/g, '');
      const hasPlus = m[0].startsWith('+');
      // skip dates, IPs and plain numbers: need a leading + or 0, or phone-style separators
      if (digits.length < 7 || digits.length > 15 || /^\d{4}-\d{2}-\d{2}$/.test(m[0]) || (!hasPlus && !/^0|[ ()-]/.test(m[0]))) continue;
      frag = frag || document.createDocumentFragment();
      frag.append(txt.slice(last, m.index));
      const a = document.createElement('a');
      a.href = 'tel:' + (hasPlus ? '+' : '') + digits;
      a.textContent = m[0];
      frag.append(a);
      last = m.index + m[0].length;
    }
    if (frag) { frag.append(txt.slice(last)); node.replaceWith(frag); }
  });
}

function enhanceMarkdown(root, final) {
  if (final) linkifyPhones(root);
  $$('a', root).forEach((a) => {
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    const href = a.getAttribute('href') || '';
    if (/^tel:/i.test(href)) a.dataset.smartTel = href.replace(/^tel:/i, '');
    else if (/^https?:/i.test(href)) a.dataset.smartLink = href;
  });
  $$('table', root).forEach((t) => {
    const w = document.createElement('div'); w.className = 'table-wrap';
    t.replaceWith(w); w.appendChild(t);
  });
  $$('img', root).forEach((img) => {
    let src = img.getAttribute('src') || '';
    if (src.startsWith('file://')) src = src.slice(7);
    if (src.startsWith('/') && !src.startsWith('/static') && !src.startsWith('/uploads') && !src.startsWith('/api/')) {
      img.src = `/api/file/raw?path=${encodeURIComponent(src)}`;
    }
    img.loading = 'lazy';
    img.style.maxWidth = '100%';
    img.style.maxHeight = '420px';
    img.style.objectFit = 'contain';
    img.style.borderRadius = '12px';
    img.style.marginTop = '10px';
    img.style.border = '1px solid var(--line)';
    img.style.background = '#0a0a10';
    img.style.display = 'block';
    img.style.cursor = 'zoom-in';
    img.onclick = () => {
      openSheet(`
        <div style="text-align:center;">
          <img src="${esc(img.src)}" style="max-width:100%; max-height:75vh; border-radius:12px; object-fit:contain;" alt="${esc(img.alt || 'Preview')}">
          <div style="margin-top:14px; display:flex; justify-content:center; gap:10px;">
            <a href="${esc(img.src)}" target="_blank" download class="btn btn-primary btn-sm" style="display:inline-flex; align-items:center; gap:6px;">${icon('i-download')} Download Image</a>
          </div>
        </div>
      `);
    };
  });
  $$('pre', root).forEach((pre) => {
    const code = $('code', pre);
    const lang = (((code && code.className.match(/language-([\w+-]+)/)) || [])[1]) || '';
    const rawText = code ? code.textContent : pre.textContent;
    if (RICH_LANGS.has(lang)) {
      const rich = richBlock(lang, rawText);
      if (rich) { pre.replaceWith(rich); return; }
    }
    const isDiff = lang === 'diff' || lang === 'patch' || (rawText && (rawText.includes('\n@@ ') || (rawText.includes('\n+') && rawText.includes('\n-'))));

    if (isDiff) {
      const { html, adds, dels } = formatDiffCode(rawText);
      const wrap = document.createElement('div');
      wrap.className = 'codeblock is-diff';
      const statsBadge = (adds > 0 || dels > 0)
        ? `<span class="diff-stats"><span class="diff-badge-add">+${adds}</span> <span class="diff-badge-del">-${dels}</span></span>`
        : '';
      wrap.innerHTML = `
        <div class="codeblock-head">
          <div class="diff-head-left">
            <span>${esc(lang || 'diff')}</span>
            ${statsBadge}
          </div>
          <button class="act" data-copy-code aria-label="Copy code">${icon('i-copy')}Copy</button>
        </div>
        <pre><code class="diff-content">${html}</code></pre>
      `;
      pre.replaceWith(wrap);
      return;
    }

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
  enrichMarkdown(root, final);
}

/* ── Rich rendering: tables, stat tiles, callouts, progress ───────────────
   Everything is derived from plain markdown, so every agent gets it for free. */
const STATUS_RULES = [
  ['ok', /^(ok|okay|success(ful(ly)?)?|succeeded|pass(ed)?|done|complete[d]?|healthy|active|running|enabled|online|up|ready|resolved|fixed|merged|deployed|cleared|removed|deleted|discarded|discarded\s*\/\s*removed|yes|true|available)$/i],
  ['bad', /^(fail(ed|ure)?|error(ed)?|critical|down|offline|crash(ed)?|reject(ed)?|denied|blocked|unhealthy|dead[- ]?letter(ed)?|no|false|missing|expired)$/i],
  ['warn', /^(warn(ing)?|pending|waiting|queued|degraded|stale|partial|retry(ing)?|in[- ]progress|paused|skipped|unknown|review)$/i],
  ['muted', /^(info|n\/a|na|none|disabled|inactive|idle|-|—|–)$/i],
];
const STATUS_EMOJI = { '✅': 'ok', '🟢': 'ok', '✔️': 'ok', '❌': 'bad', '🔴': 'bad', '🚫': 'bad', '⚠️': 'warn', '🟡': 'warn', '🟠': 'warn' };

function statusOf(text) {
  const t = (text || '').trim();
  if (!t || t.length > 32) return null;
  const em = /^(✅|🟢|✔️|❌|🔴|🚫|⚠️|🟡|🟠)\s*(.*)$/u.exec(t);
  if (em) return { kind: STATUS_EMOJI[em[1]], label: em[2] || '' };
  const clean = t.replace(/[*_`]/g, '');
  for (const [kind, re] of STATUS_RULES) if (re.test(clean)) return { kind, label: clean };
  return null;
}

const DT_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?))?\s*(UTC|Z)?$/;
function parseDate(text) {
  const m = DT_RE.exec((text || '').trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2] || '00:00:00'}${m[3] || !m[2] ? 'Z' : ''}`);
  return isNaN(d) ? null : d;
}
function relTimeFrom(d) {
  const s = Math.round((Date.now() - d.getTime()) / 1000), a = Math.abs(s);
  const u = a < 60 ? [a, 's'] : a < 3600 ? [a / 60, 'm'] : a < 86400 ? [a / 3600, 'h'] : a < 2592000 ? [a / 86400, 'd'] : a < 31536000 ? [a / 2592000, 'mo'] : [a / 31536000, 'y'];
  const n = Math.round(u[0]);
  return s >= 0 ? `${n}${u[1]} ago` : `in ${n}${u[1]}`;
}
const NUM_RE = /^[-+]?\d[\d,]*(\.\d+)?\s*(%|ms|s|kb|mb|gb|tb|b|k|m|x)?$/i;
const numOf = (t) => parseFloat((t || '').replace(/[,\s]/g, ''));
const pillHtml = (st) => `<span class="pill ${st.kind}"><i></i>${esc(st.label)}</span>`;

function copyOnTap(el, text) {
  el.classList.add('copyable'); el.title = 'Tap to copy';
  el.addEventListener('click', async (e) => {
    if (window.getSelection && String(window.getSelection())) return;
    e.stopPropagation();
    toast((await copyText(text)) ? 'Copied' : 'Copy failed', 'ok'); haptic(6);
  });
}

function enrichTable(table, wrap, final) {
  const head = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  const rows = [...table.querySelectorAll('tbody tr')];
  if (!head.length || !rows.length) return;
  const cols = head.length;
  const cell = (r, c) => r.children[c];
  const cols_ = head.map((h, c) => {
    const texts = rows.map((r) => (cell(r, c)?.textContent || '').trim());
    const filled = texts.filter(Boolean);
    const n = Math.max(filled.length, 1);
    const codeCells = rows.filter((r) => cell(r, c)?.querySelector('code')).length;
    return {
      status: filled.length > 0 && filled.every((t) => statusOf(t)),
      num: filled.length > 0 && filled.every((t) => NUM_RE.test(t)) && !rows.some((r) => cell(r, head.indexOf(h))?.querySelector('code')) && !/(^|\W)(id|seq\w*|number|no\.?|#|version|port|year|code)(\W|$)/i.test(h),
      date: filled.length > 0 && filled.every((t) => parseDate(t)),
      mono: codeCells / rows.length >= 0.5,
      plainNum: filled.length > 0 && filled.every((t) => /^[-+]?\d[\d,]*(\.\d+)?$/.test(t)),
      texts,
    };
  });

  // Normalise every cell: one font per column, no mixed chips.
  rows.forEach((r) => cols_.forEach((k, c) => {
    const td = cell(r, c); if (!td) return;
    const text = td.textContent.trim();
    td.querySelectorAll('code').forEach((cd) => cd.classList.add('cell-code'));
    if (k.status) { const st = statusOf(text); td.innerHTML = pillHtml(st); td.classList.add('c-status'); return; }
    if (k.mono) { td.classList.add('c-mono'); if (text.length >= 10) copyOnTap(td, text); }
    if (k.date) {
      const d = parseDate(text);
      td.classList.add('c-date'); td.dataset.sort = d.getTime();
      td.innerHTML = `<span class="dt-main">${esc(text)}</span><span class="dt-rel">${esc(relTimeFrom(d))}</span>`;
    }
    if (k.num) { td.classList.add('c-num'); td.dataset.sort = numOf(text); }
  }));
  const headCells = [...table.querySelectorAll('thead th')];
  headCells.forEach((th, c) => { const k = cols_[c]; if (k.num) th.classList.add('c-num'); if (k.date) th.classList.add('c-date'); });

  // Inline data bars for plain numeric columns (counts, sizes…).
  cols_.forEach((k, c) => {
    if (!k.plainNum || k.mono || rows.length < 3 || /(^|\W)(id|seq\w*|number|no\.?|#|version|port|year|code)(\W|$)/i.test(head[c])) return;
    const vals = rows.map((r) => numOf(cell(r, c).textContent));
    const max = Math.max(...vals.map(Math.abs));
    if (!(max > 0)) return;
    rows.forEach((r, i) => { const td = cell(r, c); td.classList.add('has-bar'); td.style.setProperty('--pct', `${Math.max(3, Math.abs(vals[i]) / max * 100).toFixed(0)}%`); });
  });

  if (!final) return;

  // Cards view (mobile friendly) built from the same data.
  const cards = document.createElement('div'); cards.className = 'tbl-cards'; cards.hidden = true;
  rows.forEach((r) => {
    const tds = [...r.children];
    const card = document.createElement('div'); card.className = 'tbl-card';
    const first = tds[0];
    const ft = (first?.textContent || '').trim();
    const t = document.createElement('div'); t.className = 'tbl-card-title'; t.innerHTML = first ? first.innerHTML : '';
    card.appendChild(t);
    tds.slice(1).forEach((td, i) => {
      const line = document.createElement('div'); line.className = 'tbl-card-row';
      line.innerHTML = `<span class="k">${esc(head[i + 1] || '')}</span><span class="v ${td.className}">${td.innerHTML}</span>`;
      card.appendChild(line);
    });
    card.dataset.q = tds.map((td) => td.textContent).join(' ').toLowerCase();
    cards.appendChild(card);
  });

  // Toolbar: count · filter · table/cards · copy CSV
  const bar = document.createElement('div'); bar.className = 'tbl-bar';
  bar.innerHTML = `<span class="tbl-count">${rows.length} row${rows.length === 1 ? '' : 's'} · ${cols} col${cols === 1 ? '' : 's'}</span>
    ${rows.length > 6 ? '<input class="tbl-filter" type="search" placeholder="Filter…" aria-label="Filter rows">' : ''}
    <span class="tbl-actions">
      ${cols > 2 ? `<span class="seg" role="group"><button data-v="table" class="on" aria-label="Table view">Table</button><button data-v="cards" aria-label="Card view">Cards</button></span>` : ''}
      <button class="act" data-csv aria-label="Copy as CSV">${icon('i-copy')}CSV</button>
    </span>`;
  wrap.before(bar); wrap.after(cards);

  const LIMIT = 8; let expanded = rows.length <= LIMIT, q = '';
  const more = document.createElement('button'); more.className = 'tbl-more'; cards.after(more);
  const apply = () => {
    let shown = 0, matched = 0;
    rows.forEach((r, i) => {
      const hit = !q || r.textContent.toLowerCase().includes(q);
      if (hit) matched++;
      const vis = hit && (expanded || q || shown < LIMIT);
      if (vis) shown++;
      r.hidden = !vis;
      cards.children[i].hidden = !vis;
    });
    more.hidden = expanded || !!q || rows.length <= LIMIT;
    more.textContent = `Show all ${rows.length} rows`;
    bar.querySelector('.tbl-count').textContent = q ? `${matched} of ${rows.length} rows` : `${rows.length} row${rows.length === 1 ? '' : 's'} · ${cols} col${cols === 1 ? '' : 's'}`;
  };
  more.onclick = () => { expanded = true; apply(); };
  const filter = bar.querySelector('.tbl-filter');
  if (filter) filter.addEventListener('input', () => { q = filter.value.trim().toLowerCase(); apply(); });
  const setView = (v) => {
    wrap.hidden = v === 'cards'; cards.hidden = v !== 'cards';
    bar.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    apply();
  };
  bar.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.v)));
  bar.querySelector('[data-csv]').addEventListener('click', async () => {
    const esc_ = (s) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const csv = [head, ...rows.map((r) => [...r.children].map((td) => td.textContent.trim()))].map((l) => l.map(esc_).join(',')).join('\n');
    toast((await copyText(csv)) ? 'Table copied as CSV' : 'Copy failed', 'ok');
  });

  // Tap a header to sort.
  let sortCol = -1, dir = 1;
  headCells.forEach((th, c) => {
    th.classList.add('sortable');
    th.addEventListener('click', () => {
      dir = sortCol === c ? -dir : 1; sortCol = c;
      headCells.forEach((h) => h.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
      const key = (r) => { const td = r.children[c]; return td.dataset.sort !== undefined ? parseFloat(td.dataset.sort) : td.textContent.trim().toLowerCase(); };
      const order = rows.map((r, i) => i).sort((a, b) => { const x = key(rows[a]), y = key(rows[b]); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
      const tb = rows[0].parentNode;
      order.forEach((i) => tb.appendChild(rows[i]));
      order.forEach((i) => cards.appendChild(cards.children[i]));
      rows.splice(0, rows.length, ...order.map((i) => rows[i]));
      apply();
    });
  });

  const narrow = window.matchMedia && matchMedia('(max-width: 560px)').matches;
  if (narrow && cols >= 4) setView('cards'); else apply();
}

const CALLOUTS = {
  note: ['info', 'Note'], info: ['info', 'Info'], tip: ['tip', 'Tip'], hint: ['tip', 'Tip'], important: ['important', 'Important'],
  warning: ['warn', 'Warning'], caution: ['bad', 'Caution'], danger: ['bad', 'Danger'], success: ['ok', 'Success'], done: ['ok', 'Done'], error: ['bad', 'Error'],
};
const CALLOUT_EMOJI = { 'ℹ️': 'info', '💡': 'tip', '⚠️': 'warn', '🚨': 'bad', '❌': 'bad', '✅': 'ok', '📌': 'important', '❗': 'important' };
const CALLOUT_GLYPH = { info: 'i', tip: '✦', important: '!', warn: '!', bad: '✕', ok: '✓' };

function enrichCallouts(root) {
  $$('blockquote', root).forEach((bq) => {
    const p = bq.querySelector(':scope > p'); if (!p) return;
    const txt = p.textContent.trim();
    let key = null, strip = null;
    let m = /^\[!(\w+)\]\s*/.exec(txt);
    if (m && CALLOUTS[m[1].toLowerCase()]) { key = CALLOUTS[m[1].toLowerCase()]; strip = m[0]; }
    if (!key && (m = /^(note|tip|warning|important|caution|info|success)\s*[:：]\s*/i.exec(txt))) { key = CALLOUTS[m[1].toLowerCase()]; strip = m[0]; }
    if (!key) for (const [e, k] of Object.entries(CALLOUT_EMOJI)) if (txt.startsWith(e)) { key = [k, CALLOUTS[k]?.[1] || ({ ok: 'Success', bad: 'Problem', warn: 'Warning', tip: 'Tip', info: 'Note', important: 'Important' })[k]]; strip = e; break; }
    if (!key) return;
    // remove the marker from the first text node
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode(), left = strip.length;
    while (node && left > 0) { const t = node.nodeValue.replace(/^\s+/, ''); const cut = Math.min(left, t.length); node.nodeValue = t.slice(cut); left -= cut; node = walker.nextNode(); }
    while (p.firstChild && (p.firstChild.nodeName === 'BR' || (p.firstChild.nodeType === 3 && !p.firstChild.nodeValue.trim()))) p.firstChild.remove();
    const div = document.createElement('div'); div.className = `callout ${key[0]}`;
    div.innerHTML = `<span class="callout-ico">${CALLOUT_GLYPH[key[0]]}</span><div class="callout-main"><div class="callout-title">${esc(key[1])}</div><div class="callout-body"></div></div>`;
    $('.callout-body', div).append(...bq.childNodes);
    bq.replaceWith(div);
  });
}

// "- **Active Messages:** `0`" lists → a grid of stat tiles.
function enrichStats(root) {
  $$('ul', root).forEach((ul) => {
    if (ul.closest('.callout, .stat-grid, li') || ul.querySelector('input[type=checkbox]')) return;
    const lis = [...ul.children].filter((n) => n.tagName === 'LI');
    if (lis.length < 2 || lis.length > 8) return;
    const parsed = lis.map((li) => {
      if (li.querySelector('ul, ol, pre, table')) return null;
      const t = li.textContent.trim();
      const m = /^([^:\n]{2,34}):\s*(.{1,60})$/.exec(t);
      if (!m) return null;
      let value = m[2].trim(), note = '';
      const nm = /^(.*?)\s*\(([^)]{1,60})\)$/.exec(value);
      if (nm && nm[1]) { value = nm[1].trim(); note = nm[2].trim(); }
      return { label: m[1].replace(/[*_`]/g, '').trim(), value: value.replace(/[`*]/g, ''), note };
    });
    if (parsed.some((x) => !x) || lis.some((li) => !li.querySelector('strong, b'))) return;
    const grid = document.createElement('div'); grid.className = 'stat-grid';
    grid.innerHTML = parsed.map((s) => {
      const st = statusOf(s.value);
      const big = /^[-+]?\d[\d,.]*\s*\S{0,3}$/.test(s.value) && !st;
      const val = st ? pillHtml(st) : `<span class="stat-val ${big ? 'big' : ''}${s.value === '0' ? ' zero' : ''}">${esc(s.value)}</span>`;
      return `<div class="stat"><div class="stat-label">${esc(s.label)}</div>${val}${s.note ? `<div class="stat-note">${esc(s.note)}</div>` : ''}</div>`;
    }).join('');
    ul.replaceWith(grid);
  });
}

// GFM task lists → progress bar header.
function enrichTasks(root) {
  $$('ul', root).forEach((ul) => {
    const boxes = [...ul.querySelectorAll(':scope > li > input[type=checkbox]')];
    if (boxes.length < 2) return;
    const done = boxes.filter((b) => b.checked).length, pct = Math.round(done / boxes.length * 100);
    ul.classList.add('task-list');
    boxes.forEach((b) => b.closest('li').classList.toggle('done', b.checked));
    const prog = document.createElement('div'); prog.className = 'progress';
    prog.innerHTML = `<div class="bar"><i style="width:${pct}%"></i></div><span>${done} of ${boxes.length} done</span>`;
    ul.before(prog);
  });
}

function enrichMarkdown(root, final) {
  try {
    enrichCallouts(root);
    enrichStats(root);
    enrichTasks(root);
    enrichMath(root);
    $$('.table-wrap', root).forEach((w) => { const t = $('table', w); if (t) enrichTable(t, w, final); });
    $$('p code, li code, h1 code, h2 code, h3 code, h4 code', root).forEach((c) => {
      if (c.closest('.table-wrap, .tbl-cards, .codeblock, .copyable')) return;
      const t = c.textContent;
      if (t.length >= 10 && !/\s/.test(t)) copyOnTap(c, t);
    });
  } catch (e) { console.warn('rich render failed', e); }
}

// Render LaTeX once a message is settled. Block math ($$…$$ / \[…\]) becomes a
// .katex-block, inline math (\(…\) / $…$) is replaced in place. KaTeX is
// lazy-loaded from CDN on first use; until it arrives, the raw TeX is shown.
function enrichMath(root) {
  const hasTex = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$])\$[^$\n]+\$/.test(root.textContent || '');
  const placeholders = $$('.katex-block', root);
  if (!hasTex && !placeholders.length) return;

  const paint = () => {
    $$('.katex-block', root).forEach((b) => { const tex = b.dataset.tex || b.textContent; b.innerHTML = renderKatex(tex, true); });
    walkTextMath(root);
  };
  if (window.katex) { paint(); return; }
  loadKatex().then((ok) => { if (ok) paint(); });
}

// Replace inline $$…$$ / $…$ / \(…\) / \[…\] text nodes with rendered math, skipping code.
function walkTextMath(root) {
  const RE = /\$\$([^$\n]+?)\$\$|(?<![\\$])\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/;
  const skip = (n) => { const p = n.parentNode; return p && p.closest && p.closest('code, pre, .codeblock, .katex-block, .katex, .matrix, .tree'); };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (RE.test(n.nodeValue || '') && !skip(n)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const targets = [];
  let n; while ((n = walker.nextNode())) targets.push(n);
  targets.forEach((node) => {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    const re = new RegExp(RE.source, 'g');
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tex = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
      const display = m[1] != null || m[4] != null;
      const span = document.createElement('span');
      span.className = display ? 'katex-display-inline' : 'katex-inline';
      span.innerHTML = renderKatex(tex, display);
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (frag.childNodes.length && node.parentNode) node.parentNode.replaceChild(frag, node);
  });
}

/* ── Chart + timeline blocks (```chart JSON, ```timeline lines) ─────────────── */
const CHART_COLORS = ['#7c8cff', '#34d399', '#fbbf24', '#c79bff', '#5fd4e8', '#f87171', '#f0a35e', '#9aa5ff'];
const fmtNum = (n) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(Math.round(n * 100) / 100));

const RICH_LANGS = new Set(['chart', 'timeline', 'kv', 'keyvalue', 'record', 'gauge', 'gauges', 'spark', 'sparkline', 'metrics', 'dashboard', 'heatmap', 'calendar', 'matrix', 'compare', 'options', 'steps', 'stepper', 'pipeline', 'rings', 'badges', 'tree', 'math', 'latex', 'katex', 'tex', 'mermaid', 'sequence', 'flow', 'flowchart']);
function richBlock(lang, text) {
  try {
    if (lang === 'chart') return chartBlock(JSON.parse(text));
    if (lang === 'timeline') return timelineBlock(text);
    if (lang === 'kv' || lang === 'keyvalue' || lang === 'record') return kvBlock(JSON.parse(text));
    if (lang === 'gauge' || lang === 'gauges') return gaugeBlock(JSON.parse(text));
    if (lang === 'spark' || lang === 'sparkline') return sparkBlock(JSON.parse(text));
    if (lang === 'metrics' || lang === 'dashboard') return metricsBlock(JSON.parse(text));
    if (lang === 'heatmap' || lang === 'calendar') return heatBlock(JSON.parse(text));
    if (lang === 'matrix') return matrixBlock(JSON.parse(text));
    if (lang === 'compare' || lang === 'options') return compareBlock(JSON.parse(text));
    if (lang === 'steps' || lang === 'stepper' || lang === 'pipeline') return stepsBlock(JSON.parse(text));
    if (lang === 'rings') return ringsBlock(JSON.parse(text));
    if (lang === 'badges') return badgesBlock(JSON.parse(text));
    if (lang === 'tree') return treeBlock(text);
    if (lang === 'mermaid' || lang === 'sequence' || lang === 'flow' || lang === 'flowchart') return mermaidBlock(lang, text);
    if (lang === 'math' || lang === 'latex' || lang === 'katex' || lang === 'tex') return mathBlock(text);
  } catch { /* still streaming, or malformed: it stays a normal code block */ }
  return null;
}

/* ── Mermaid diagrams (```mermaid, ```sequence, ```flow): lazy-loaded from CDN ── */
let mermaidReady = null;
function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = new Promise((resolve, reject) => {
      if (window.mermaid) return resolve(window.mermaid);
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js';
      sc.onload = () => {
        window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', fontFamily: 'inherit' });
        resolve(window.mermaid);
      };
      sc.onerror = () => { mermaidReady = null; reject(new Error('mermaid load failed')); };
      document.head.appendChild(sc);
    });
  }
  return mermaidReady;
}
let mermaidSeq = 0;
function mermaidBlock(lang, text) {
  let src = text.trim();
  if (!src) return null;
  // ```sequence / ```flow may omit the Mermaid header line
  if (lang === 'sequence' && !/^sequenceDiagram/.test(src)) src = `sequenceDiagram\n${src}`;
  if ((lang === 'flow' || lang === 'flowchart') && !/^(flowchart|graph)\b/.test(src)) src = `flowchart TD\n${src}`;
  const el = document.createElement('figure');
  el.className = 'chart mermaid-block';
  el.innerHTML = '<div class="mermaid-body muted">Rendering diagram…</div>';
  const body = el.firstChild;
  loadMermaid()
    .then((m) => m.render(`mmd-${Date.now()}-${mermaidSeq++}`, src))
    .then(({ svg }) => { body.classList.remove('muted'); body.innerHTML = svg; })
    .catch(() => {
      // malformed or still streaming: fall back to a plain code block
      document.querySelectorAll('[id^="dmmd-"]').forEach((n) => n.remove());
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = text;
      pre.appendChild(code);
      el.replaceWith(pre);
    });
  return el;
}

function chartBlock(spec) {
  let pts = [];
  if (Array.isArray(spec.data)) pts = spec.data.map((d) => ({ label: String(d.label ?? d.name ?? ''), value: Number(d.value) }));
  else if (Array.isArray(spec.labels) && Array.isArray(spec.values)) pts = spec.labels.map((l, i) => ({ label: String(l), value: Number(spec.values[i]) }));
  pts = pts.filter((p) => Number.isFinite(p.value)).slice(0, 24);
  if (pts.length < 2) return null;
  const type = ['bar', 'line', 'donut'].includes(spec.type) ? spec.type : 'bar';
  const unit = spec.unit ? String(spec.unit) : '';
  const el = document.createElement('figure');
  el.className = `chart chart-${type}`;
  const title = spec.title ? `<figcaption class="chart-title">${esc(String(spec.title))}</figcaption>` : '';
  const val = (v) => `${fmtNum(v)}${unit ? ` <span class="chart-unit">${esc(unit)}</span>` : ''}`;

  if (type === 'bar') {
    const max = Math.max(...pts.map((p) => Math.abs(p.value))) || 1;
    el.innerHTML = `${title}<div class="chart-bars">${pts.map((p, i) => `
      <div class="cb-row"><span class="cb-label" title="${esc(p.label)}">${esc(p.label)}</span>
      <span class="cb-track"><i style="width:${Math.max(2, Math.abs(p.value) / max * 100).toFixed(1)}%;background:${p.value < 0 ? '#f87171' : CHART_COLORS[0]}"></i></span>
      <span class="cb-val">${val(p.value)}</span></div>`).join('')}</div>`;
  } else if (type === 'line') {
    const W = 320, H = 140, L = 34, R = 10, T = 10, B = 24;
    const vals = pts.map((p) => p.value), lo = Math.min(...vals), hi = Math.max(...vals);
    const span = hi - lo || 1;
    const x = (i) => L + (pts.length === 1 ? 0 : i * (W - L - R) / (pts.length - 1));
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / span);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    const area = `${line}L${x(pts.length - 1).toFixed(1)},${H - B}L${x(0).toFixed(1)},${H - B}Z`;
    const every = Math.ceil(pts.length / 6);
    el.innerHTML = `${title}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(String(spec.title || 'Line chart'))}">
      <line class="ch-grid" x1="${L}" x2="${W - R}" y1="${y(hi)}" y2="${y(hi)}"/><line class="ch-grid" x1="${L}" x2="${W - R}" y1="${y(lo)}" y2="${y(lo)}"/>
      <text class="ch-axis" x="${L - 4}" y="${y(hi) + 3}" text-anchor="end">${esc(fmtNum(hi))}</text><text class="ch-axis" x="${L - 4}" y="${y(lo) + 3}" text-anchor="end">${esc(fmtNum(lo))}</text>
      <path class="ch-area" d="${area}"/><path class="ch-line" d="${line}"/>
      ${pts.map((p, i) => `<circle class="ch-dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3"><title>${esc(p.label)}: ${esc(fmtNum(p.value))}${esc(unit)}</title></circle>`).join('')}
      ${pts.map((p, i) => (i % every === 0 || i === pts.length - 1) ? `<text class="ch-axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === pts.length - 1 && pts.length > 2 ? 'end' : i === 0 ? 'start' : 'middle'}">${esc(p.label.length > 8 ? p.label.slice(0, 7) + '…' : p.label)}</text>` : '').join('')}
    </svg>`;
  } else {
    const total = pts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
    const R = 46, C = 2 * Math.PI * R; let off = 0;
    const arcs = pts.map((p, i) => {
      const len = Math.max(0, p.value) / total * C;
      const a = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${CHART_COLORS[i % CHART_COLORS.length]}" stroke-width="16" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 60 60)"><title>${esc(p.label)}: ${esc(fmtNum(p.value))}${esc(unit)}</title></circle>`;
      off += len; return a;
    }).join('');
    el.innerHTML = `${title}<div class="chart-donut-wrap"><svg viewBox="0 0 120 120" role="img" aria-label="${esc(String(spec.title || 'Donut chart'))}">${arcs}<text x="60" y="60" text-anchor="middle" dominant-baseline="central" class="ch-total">${esc(fmtNum(total))}</text></svg>
      <ul class="chart-legend">${pts.map((p, i) => `<li><i style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></i><span>${esc(p.label)}</span><b>${val(p.value)}</b><em>${(Math.max(0, p.value) / total * 100).toFixed(0)}%</em></li>`).join('')}</ul></div>`;
  }
  return el;
}


/* ── v2 component pack: kv, gauge, spark, metrics, heatmap, matrix,
   tree, compare, stepper, rings, badges, math. All from fenced blocks. ── */

function svgSpark(values, { width = 100, height = 30, pad = 2 } = {}) {
  const vals = values.map(Number).filter(Number.isFinite);
  if (vals.length < 2) return '';
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const x = (i) => pad + (vals.length === 1 ? 0 : (i * (width - pad * 2)) / (vals.length - 1));
  const y = (v) => pad + (height - pad * 2) * (1 - (v - lo) / span);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('');
  const area = `${line}L${x(vals.length - 1).toFixed(2)},${height - pad}L${x(0).toFixed(2)},${height - pad}Z`;
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path class="sp-area" d="${area}"/><path class="sp-line" d="${line}"/></svg>`;
}

function kvBlock(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const entries = Array.isArray(spec.items)
    ? spec.items.map((it) => [String(it.key ?? it.label ?? ''), it])
    : Object.entries(spec.data || spec.fields || {});
  if (!entries.length) return null;
  const el = document.createElement('div');
  el.className = 'kv';
  const title = spec.title ? `<div class="kv-head">${spec.icon ? `<span class="kv-ico">${icon(spec.icon)}</span>` : ''}<span class="kv-title">${esc(String(spec.title))}</span>${spec.subtitle ? `<span class="kv-sub">${esc(String(spec.subtitle))}</span>` : ''}</div>` : '';
  const rows = entries.map(([k, v]) => {
    const obj = (v && typeof v === 'object') ? v : { value: v };
    const raw = obj.value ?? obj.v ?? '';
    const st = statusOf(String(raw));
    const isCode = obj.mono || obj.code || (/^[\w./@:-]{1,64}$/.test(String(raw)) && !st);
    let valHtml = st ? pillHtml(st)
      : `<span class="${isCode ? 'kv-mono' : ''}">${esc(String(raw))}</span>`;
    if (obj.link) valHtml = `<a href="${esc(String(obj.link))}" target="_blank" rel="noopener noreferrer">${valHtml}</a>`;
    const copy = (obj.copy !== false && !st && String(raw).length >= 4 && !/\s/.test(String(raw)))
      ? `<button class="act kv-copy" aria-label="Copy">${icon('i-copy', 'xs')}</button>` : '';
    return `<div class="kv-cell kv-key">${obj.icon ? icon(obj.icon, 'xs k-ico') : ''}${esc(k)}</div>`
      + `<div class="kv-cell kv-val">${valHtml}${copy}</div>`;
  }).join('');
  el.innerHTML = `${title}<div class="kv-grid">${rows}</div>`;
  $$('.kv-copy', el).forEach((btn) => {
    const cell = btn.closest('.kv-cell');
    const text = (cell ? cell.textContent : '').trim();
    btn.addEventListener('click', async () => { toast((await copyText(text)) ? 'Copied' : 'Copy failed', 'ok'); haptic(6); });
  });
  return el;
}

function gaugeTone(pct, spec) {
  if (spec && spec.tone) return spec.tone;
  const warnAt = spec && spec.warnAt != null ? spec.warnAt : 75;
  const badAt = spec && spec.badAt != null ? spec.badAt : 90;
  return pct >= badAt ? 'bad' : pct >= warnAt ? 'warn' : 'ok';
}

function gaugeRingHtml(pct, label, big, unit, tone, sub) {
  const R = 44, C = 2 * Math.PI * R, off = C * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return `<div class="gauge-item ${tone}"><div class="gauge-ring"><svg viewBox="0 0 104 104">
      <circle class="g-track" cx="52" cy="52" r="${R}"/>
      <circle class="g-val" cx="52" cy="52" r="${R}" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/>
    </svg><div class="gauge-center"><div><span class="gauge-big">${esc(big)}</span><span class="gauge-unit">${unit ? ' ' + esc(unit) : ''}</span></div></div></div>
    ${label ? `<div class="gauge-label">${esc(label)}</div>` : ''}${sub ? `<div class="gauge-sub">${esc(sub)}</div>` : ''}</div>`;
}

function gaugeBlock(spec) {
  const items = Array.isArray(spec.items) ? spec.items
    : Array.isArray(spec.gauges) ? spec.gauges
    : (spec.value != null ? [spec] : null);
  if (!items || !items.length) return null;
  const el = document.createElement('div');
  el.className = 'gauge';
  el.innerHTML = `<div class="gauge-set">${items.slice(0, 8).map((it) => {
    const max = it.max != null ? Number(it.max) : 100;
    const val = Number(it.value ?? it.pct ?? 0);
    const pct = it.pct != null ? Number(it.pct) : (max ? (val / max) * 100 : val);
    const big = it.display != null ? String(it.display) : (it.pct != null || max === 100 ? `${Math.round(pct)}%` : fmtNum(val));
    const unit = it.pct != null || max === 100 ? '' : (it.unit || '');
    return gaugeRingHtml(pct, it.label != null ? String(it.label) : (spec.title || ''), big, unit, gaugeTone(pct, it), it.sub || it.note || '');
  }).join('')}</div>`;
  return el;
}

function sparkBlock(spec) {
  let vals = [];
  let labels = [];
  if (Array.isArray(spec)) vals = spec;
  else if (Array.isArray(spec.values)) { vals = spec.values; labels = spec.labels || []; }
  else if (Array.isArray(spec.data)) {
    vals = spec.data.map((d) => Number(d.value ?? d));
    labels = spec.data.map((d) => String(d.label ?? d.name ?? ''));
  }
  vals = vals.map(Number).filter(Number.isFinite);
  if (vals.length < 2) return null;
  const last = vals[vals.length - 1], first = vals[0];
  const delta = last - first;
  const dir = Math.abs(delta) < 1e-9 ? 'flat' : delta > 0 ? 'up' : 'down';
  const unit = spec.unit ? String(spec.unit) : '';
  const el = document.createElement('div');
  el.className = 'spark';
  el.innerHTML = `<div class="spark-head">
      <span class="spark-title">${esc(String(spec.title || 'Trend'))}</span>
      ${spec.delta !== false ? `<span class="spark-delta ${dir}">${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'} ${esc(fmtNum(Math.abs(delta)))}${esc(unit)}</span>` : ''}
      <span class="spark-last">${esc(fmtNum(last))}${unit ? ` <span class="chart-unit">${esc(unit)}</span>` : ''}</span>
    </div>${svgSpark(vals, { width: 240, height: 48 })}
    <div class="spark-foot"><span>${esc(labels[0] || '')}</span><span>${vals.length} pts</span><span>${esc(labels[labels.length - 1] || '')}</span></div>`;
  return el;
}

function metricsBlock(spec) {
  const items = Array.isArray(spec) ? spec : (Array.isArray(spec.items) ? spec.items : Array.isArray(spec.metrics) ? spec.metrics : null);
  if (!items || !items.length) return null;
  const el = document.createElement('div');
  el.className = 'metrics';
  el.innerHTML = items.slice(0, 12).map((it) => {
    const st = statusOf(String(it.value ?? ''));
    const tone = it.tone || (st ? st.kind : '');
    const spark = Array.isArray(it.spark) && it.spark.length >= 2 ? `<div class="metric-spark">${svgSpark(it.spark, { width: 120, height: 26 })}</div>` : '';
    const val = st ? pillHtml(st) : `<span class="metric-val">${esc(String(it.value ?? it.v ?? ''))}${it.unit ? `<small>${esc(String(it.unit))}</small>` : ''}</span>`;
    return `<div class="metric ${tone ? 'metric-tone-' + tone : ''}">
      <div class="metric-top">${it.icon ? icon(it.icon, 'xs') : ''}<span class="metric-label">${esc(String(it.label ?? it.k ?? ''))}</span></div>
      ${val}${it.note ? `<div class="metric-note">${esc(String(it.note))}</div>` : ''}${spark}</div>`;
  }).join('');
  return el;
}

function heatBlock(spec) {
  let days = [];
  if (Array.isArray(spec.data)) days = spec.data.map((d) => ({ date: String(d.date ?? d.label ?? ''), value: Number(d.value ?? d.count ?? 0) }));
  else if (Array.isArray(spec.values)) days = spec.values.map((v, i) => ({ date: String((spec.labels || [])[i] ?? ''), value: Number(v) }));
  days = days.filter((d) => Number.isFinite(d.value));
  if (days.length < 4) return null;
  const max = Math.max(...days.map((d) => d.value), 1);
  const level = (v) => (v <= 0 ? 0 : v >= max ? 4 : Math.max(1, Math.round((v / max) * 4)));
  // Arrange into weeks (columns of 7). Pad the first week so days align by weekday.
  const firstDate = parseDate(days[0].date) || new Date();
  const lead = firstDate.getDay();
  const cells = [...Array(lead).fill(null), ...days];
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const el = document.createElement('div');
  el.className = 'heatmap';
  el.innerHTML = `${spec.title ? `<div class="heat-title">${esc(String(spec.title))}</div>` : ''}
    <div class="heat-grid">${weeks.map((w) => `<div class="heat-col">${w.map((d) => {
      if (!d) return `<div class="heat-cell" style="visibility:hidden"></div>`;
      const lv = level(d.value);
      const cls = d.status ? String(d.status) : (lv ? 'l' + lv : '');
      return `<div class="heat-cell ${cls}" title="${esc(d.date)}: ${esc(fmtNum(d.value))}"></div>`;
    }).join('')}</div>`).join('')}</div>
    <div class="heat-legend">Less<span class="heat-cell"></span><span class="heat-cell l1"></span><span class="heat-cell l2"></span><span class="heat-cell l3"></span><span class="heat-cell l4"></span>More · peak ${esc(fmtNum(max))}</div>`;
  return el;
}

function matrixBlock(spec) {
  const rows = Array.isArray(spec.rows) ? spec.rows : null;
  const cols = Array.isArray(spec.cols) ? spec.cols : null;
  if (!rows || !cols) return null;
  const norm = (v) => {
    const t = String(v ?? '').toLowerCase().trim();
    if (['ok', 'pass', 'passed', '✓', '✅', '1', 'true', 'good', 'yes'].includes(t)) return 'ok';
    if (['bad', 'fail', 'failed', '✗', '❌', '0', 'false', 'error', 'no'].includes(t)) return 'bad';
    if (['warn', 'warning', '⚠️', 'flaky', 'skip', 'skipped', '-', '—', 'n/a', 'na'].includes(t)) return 'warn';
    return 'skip';
  };
  const sym = { ok: '✓', bad: '✕', warn: '⚠', skip: '·' };
  const el = document.createElement('div');
  el.className = 'matrix';
  el.innerHTML = `<table><thead><tr><th></th>${cols.map((c) => `<th>${esc(String(c))}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => {
      const cells = Array.isArray(r.cells) ? r.cells : (Array.isArray(r.values) ? r.values : []);
      return `<tr><th style="text-align:right">${esc(String(r.label ?? r.name ?? ''))}</th>${cols.map((_, i) => {
        const k = norm(cells[i]);
        return `<td class="${k}" title="${esc(String(cells[i] ?? ''))}">${sym[k]}</td>`;
      }).join('')}</tr>`;
    }).join('')}</tbody></table>${spec.caption ? `<div class="matrix-caption">${esc(String(spec.caption))}</div>` : ''}`;
  return el;
}

function treeBlock(text) {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  if (lines.length < 1) return null;
  const iconFor = (name, isDir) => isDir ? 'i-folder' : (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(name) ? 'i-globe' : /\.(md|txt|json|ya?ml|toml)$/i.test(name) ? 'i-box' : 'i-terminal');
  const el = document.createElement('div');
  el.className = 'tree';
  el.innerHTML = lines.map((raw) => {
    // Derive depth from the box-drawing prefix, keep the connector as literal art.
    const m = /^([│├└─\s]*)(.*)$/.exec(raw);
    const prefix = m[1], rest = m[2];
    const isDir = /\/\s*$/.test(rest) || /\/(\s|$)/.test(rest) && !/\.\w+/.test(rest);
    const metaM = /\s*\(([^)]+)\)\s*$/.exec(rest);
    const name = metaM ? rest.slice(0, metaM.index) : rest;
    const meta = metaM ? metaM[1] : '';
    const clean = name.replace(/\/\s*$/, '');
    return `<div class="tree-row ${isDir ? 'dir' : ''}" data-src="${esc(clean)}"><span style="color:var(--text-3)">${esc(prefix)}</span>`
      + `<span class="tr-ico">${icon(iconFor(clean, isDir), 'xs')}</span>`
      + `<span class="tr-name">${esc(clean)}${isDir ? '/' : ''}</span>`
      + `${meta ? `<span class="tr-meta">${esc(meta)}</span>` : ''}</div>`;
  }).join('');
  return el;
}

function compareBlock(spec) {
  const cards = Array.isArray(spec) ? spec : (Array.isArray(spec.cards) ? spec.cards : (Array.isArray(spec.options) ? spec.options : null));
  if (!cards || cards.length < 1) return null;
  const el = document.createElement('div');
  el.className = 'compare' + (cards.length === 1 ? ' single' : '');
  el.innerHTML = cards.slice(0, 2).map((c) => {
    const items = Array.isArray(c.items) ? c.items : Array.isArray(c.points) ? c.points : [];
    return `<div class="cmp-card ${c.recommended || c.rec ? 'rec' : ''}">
      <div class="cmp-head">${c.icon ? icon(c.icon, 'xs') : ''}${esc(String(c.title ?? c.label ?? ''))}${(c.recommended || c.rec) ? `<span class="cmp-badge">Recommended</span>` : ''}</div>
      <div class="cmp-body">${items.map((it) => {
        const obj = (it && typeof it === 'object') ? it : { text: it };
        const t = String(obj.text ?? obj.label ?? obj.value ?? '');
        const tone = obj.tone || (obj.good === true ? 'good' : obj.bad === true ? 'bad' : 'neutral');
        const glyph = obj.icon || (tone === 'good' ? 'i-check' : tone === 'bad' ? 'i-x' : 'i-chevron');
        return `<div class="cmp-item ${tone}"><span class="ci">${icon(glyph, 'xs')}</span><span>${mdInline(t)}</span></div>`;
      }).join('')}</div></div>`;
  }).join('');
  return el;
}

function stepsBlock(spec) {
  const items = Array.isArray(spec) ? spec : (Array.isArray(spec.steps) ? spec.steps : null);
  if (!items || items.length < 2) return null;
  const parsed = items.map((it) => (it && typeof it === 'object') ? it : { label: String(it) });
  let current = parsed.findIndex((s, i) => (s.state || s.status || '').toLowerCase() === 'current' || (s.state || '').toLowerCase() === 'active' || (s.state || '').toLowerCase() === 'now');
  if (current < 0) current = parsed.filter((s) => ['done', 'ok', 'complete', 'completed', 'success'].includes(String(s.state || s.status || '').toLowerCase())).length;
  const stateOf = (s, i) => {
    const st = String(s.state || s.status || '').toLowerCase();
    if (['done', 'ok', 'complete', 'completed', 'success'].includes(st)) return 'ok';
    if (['failed', 'error', 'bad'].includes(st)) return 'bad';
    if (['warn', 'warning'].includes(st)) return 'warn';
    if (['current', 'active', 'now'].includes(st)) return 'now';
    if (i === current) return 'now';
    return 'todo';
  };
  const el = document.createElement('div');
  el.className = 'stepper';
  el.innerHTML = parsed.map((s, i) => {
    const st = stateOf(s, i);
    return `<div class="step-node ${st}">
      <div class="step-mark">
        <div class="step-dot2">${st === 'ok' ? icon('i-check', 'xs') : st === 'bad' ? icon('i-x', 'xs') : i + 1}</div>
        <div class="step-label2">${esc(String(s.label ?? s.title ?? ''))}</div>
        ${s.note || s.detail ? `<div class="step-note">${esc(String(s.note ?? s.detail))}</div>` : ''}
      </div></div>`;
  }).join('');
  return el;
}

function ringsBlock(spec) {
  const items = Array.isArray(spec) ? spec : (Array.isArray(spec.items) ? spec.items : Array.isArray(spec.rings) ? spec.rings : null);
  if (!items || items.length < 1) return null;
  const el = document.createElement('div');
  el.className = 'rings';
  el.innerHTML = items.slice(0, 6).map((it) => {
    const max = it.max != null ? Number(it.max) : 100;
    const val = Number(it.value ?? it.pct ?? 0);
    const pct = it.pct != null ? Number(it.pct) : (max ? (val / max) * 100 : val);
    const big = it.display != null ? String(it.display) : `${Math.round(pct)}%`;
    return gaugeRingHtml(pct, it.label != null ? String(it.label) : '', big, it.unit || '', gaugeTone(pct, it), it.sub || it.note || '');
  }).join('');
  return el;
}

function badgesBlock(spec) {
  const items = Array.isArray(spec) ? spec : (Array.isArray(spec.items) ? spec.items : Array.isArray(spec.badges) ? spec.badges : null);
  if (!items || !items.length) return null;
  const el = document.createElement('div');
  el.className = 'badges';
  el.innerHTML = items.map((it) => {
    const obj = (it && typeof it === 'object') ? it : { label: String(it) };
    const st = statusOf(String(obj.value ?? '')) || (obj.status ? { kind: String(obj.status).toLowerCase().replace('warn', 'warn'), label: '' } : null);
    const kind = obj.tone || obj.status || (st ? st.kind : '');
    const label = String(obj.label ?? obj.name ?? '');
    const value = obj.value != null ? `<b>${esc(String(obj.value))}</b>` : '';
    return `<span class="badge2 ${esc(String(kind || ''))}">${obj.icon ? icon(obj.icon, 'xs') : '<span class="b2-dot"></span>'}<span>${esc(label)}</span>${value}</span>`;
  }).join('');
  return el;
}

function mdInline(text) {
  try { return DOMPurify.sanitize(marked.parseInline(String(text || ''), { gfm: true })); }
  catch { return esc(String(text || '')); }
}

/* ── LaTeX math (```math block + inline $$…$$ / \(…\)) ──── */
const KATEX_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/';
let katexPromise = null;
function loadKatex() {
  if (window.katex) return Promise.resolve(true);
  if (katexPromise) return katexPromise;
  katexPromise = new Promise((resolve) => {
    if (!document.querySelector('link[data-katex]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = KATEX_BASE + 'katex.min.css'; link.dataset.katex = '1';
      document.head.appendChild(link);
    }
    const s = document.createElement('script');
    s.src = KATEX_BASE + 'katex.min.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return katexPromise;
}

function renderKatex(tex, display) {
  try {
    return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
  } catch {
    return `<span class="katex-err">${esc(tex)}</span>`;
  }
}

function mathBlock(text) {
  const el = document.createElement('div');
  el.className = 'katex-block';
  el.dataset.tex = text;
  if (window.katex) el.innerHTML = renderKatex(text, true);
  else el.textContent = text;
  return el;
}

function timelineBlock(text) {
  const rows = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('|').map((x) => x.trim()));
  if (!rows.length || rows.some((r) => r.length < 2)) return null;
  const el = document.createElement('ol');
  el.className = 'tl';
  el.innerHTML = rows.map(([date, title, detail, status]) => {
    const st = ['ok', 'warn', 'bad', 'info'].includes((status || '').toLowerCase()) ? status.toLowerCase() : (['ok', 'warn', 'bad', 'info'].includes((detail || '').toLowerCase()) ? detail.toLowerCase() : '');
    const det = detail && !['ok', 'warn', 'bad', 'info'].includes(detail.toLowerCase()) ? detail : '';
    return `<li class="tl-item ${st}"><span class="tl-dot"></span><div class="tl-date">${esc(date)}</div><div class="tl-title">${esc(title)}</div>${det ? `<div class="tl-detail">${esc(det)}</div>` : ''}</li>`;
  }).join('');
  return el;
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
  const cleanText = (stripped || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/g, '')
    .trim();
  const text = isShell ? formatShell(cleanText) : cleanText;
  const body = $('.msg-body', msgEl);
  if (!body) return;

  const activityHtml = stepsHtml(msgEl, final);
  body.innerHTML = activityHtml + (text ? mdToHtml(text) : '');
  enhanceMarkdown(body, final);
  if (agent && msgEl._agentKey === 'auto') setMsgAgent(msgEl, agent, true);
}

function stepLine(act, live) {
  return `<li class="step ${live ? 'live' : ''}"><span class="step-dot"></span><span class="step-label">${esc(act.label || 'Working')}</span>${act.detail ? `<code class="step-detail">${esc(act.detail)}</code>` : ''}</li>`;
}

// What the agent did, from the ACTIVITY markers in its output: a live list while it runs,
// then one collapsed "Worked … · N steps" line.
function stepsHtml(msgEl, final) {
  const acts = extractAllActivities(msgEl._raw);
  if (!acts.length) return '';
  if (!final) {
    const shown = acts.slice(-5);
    const hidden = acts.length - shown.length;
    return `<ol class="steps">${hidden > 0 ? `<li class="step more">${hidden} earlier step${hidden === 1 ? '' : 's'}</li>` : ''}${shown.map((a, i) => stepLine(a, i === shown.length - 1)).join('')}</ol>`;
  }
  const took = msgEl._elapsed ? `Worked ${fmtDuration(msgEl._elapsed)} · ` : '';
  return `<details class="run-summary"><summary>${icon('i-check', 'xs')}<span>${took}${acts.length} step${acts.length === 1 ? '' : 's'}</span>${icon('i-chevron-down', 'xs')}</summary><ol class="steps">${acts.map((a) => stepLine(a, false)).join('')}</ol></details>`;
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

  el.innerHTML = `<div class="bubble">${attachHtml}${mentionHtml(text)}</div>
    <div class="msg-actions"><span class="msg-time">${clock(ts)}</span><button class="act" data-copy-user aria-label="Copy message">${icon('i-copy')}Copy</button></div>`;
  el._text = text;
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
      ${streaming ? '<span class="status-pill">working</span>' : ''}
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
  updateSendEnabled();
}

// One primary button: Stop while an agent works, Send when there is something to send, otherwise Talk.
function updateSendEnabled() {
  const btn = $('#sendBtn');
  if (!btn) return;
  const hasInput = !!$('#promptInput')?.value.trim() || !!(state.attachments && state.attachments.length);
  const mode = state.streaming ? 'stop' : hasInput ? 'send' : 'talk';
  if (btn.dataset.mode === mode) return;
  btn.dataset.mode = mode;
  btn.disabled = false;
  btn.setAttribute('aria-label', { stop: 'Stop agent', send: 'Send', talk: 'Talk to the agent' }[mode]);
  btn.innerHTML = icon({ stop: 'i-stop', send: 'i-send', talk: 'i-wave' }[mode]) + (mode === 'talk' ? '<span class="primary-label">Talk</span>' : '');
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
      if (sid && sid !== state.sessionId) { state.sessionId = sid; store.set('session', sid); api('/api/active-session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sid }) }).catch(() => {}); }
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
    el._elapsed = Math.floor((Date.now() - started) / 1000);
    if (pill) pill.textContent = el._reconnecting ? 'reconnecting…' : `working ${fmtDuration(el._elapsed)}`;
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
      renderInspector();
      scrollToBottom();
    });
  };

  const { stopped, failed } = await followRun(el, ctrl, schedule, (open && (() => open(ctrl.signal))));
  clearInterval(tick);
  cancelAnimationFrame(frame);
  state.abort = null;
  el._elapsed = Math.floor((Date.now() - started) / 1000);

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
  checkGitChanges();

  if (newTitle && state.sessionId) state.title = newTitle;
  if (state.sessionId) sessionStorage.setItem('ah.open', state.sessionId);
  updateTitle();
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

  const mentioned = findMentions(prompt);
  if (mentioned.length) {
    const lines = mentioned.map((m) => m.kind === 'Connector'
      ? `- ${m.label} (mail connector): use the ${m.id === 'm365' ? 'outlook' : 'email'} MCP tools (mcp__${m.id === 'm365' ? 'outlook' : 'email'}__*)`
      : `- ${m.label} (MCP server): use its tools (mcp__${m.id}__*)`).join('\n');
    enrichedPrompt = `[User explicitly selected these integrations with @ — use them for this request]:\n${lines}\n\n${enrichedPrompt}`;
  }

  state.lastPromptLength = enrichedPrompt.length;
  const userText = prompt || (attachments.length ? `Attached ${attachments.length} file(s)` : '');
  const userTokens = Math.max(1, Math.round(enrichedPrompt.length / 3.8));
  state.messages.push({ role: 'user', content: userText, agent: agentKey, ts: now, attachments, tokens: userTokens });
  addUserMessage(userText, now, attachments);
  updateTitle();

  const model = agentKey === 'bash' || agentKey === 'auto' ? null : currentModel(agentKey);
  const el = addAssistantMessage({ agent: agentKey, streaming: true, model });
  if (opts.onEl) opts.onEl(el);
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

function newChat({ focus = true } = {}) {
  if (state.streaming) detachStreaming();
  sessionStorage.removeItem('ah.open');
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
  if (focus) $('#promptInput').focus();
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
    sessionStorage.setItem('ah.open', data.id);
    api('/api/active-session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: data.id }) }).catch(() => {});
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
    resetSyncCount();

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
const vcFoot = () => (typeof live !== 'undefined' && live.on) ? liveFoot() : 'Pause to send · tap the orb to interrupt';
const VC_LABEL = { idle: 'Tap to talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };
// Replies are played through high-definition neural audio via <audio>.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const ttsAudio = new Audio();
ttsAudio.preload = 'auto';
ttsAudio.setAttribute('playsinline', '');

function unlockAudio() {
  try {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    ttsAudio.src = SILENT_WAV;
    const p = ttsAudio.play();
    if (p && p.catch) p.catch(() => {});
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
  if (typeof vadSpeakingMode === 'function') vadSpeakingMode(phase === 'speaking');
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

function vcIsStreamHealthy() {
  if (!vc.stream || !vc.stream.active) return false;
  const tracks = vc.stream.getAudioTracks();
  if (!tracks || !tracks.length) return false;
  return tracks.some((t) => t.readyState === 'live' && !t.muted);
}

async function vcEnsureStream() {
  if (vcIsStreamHealthy()) {
    if (vc.ctx && vc.ctx.state === 'suspended') {
      try { await vc.ctx.resume(); } catch {}
    }
    return true;
  }
  try {
    if (vc.stream) {
      try { vc.stream.getTracks().forEach((t) => t.stop()); } catch {}
    }
    vc.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      if (!vc.ctx || vc.ctx.state === 'closed') {
        vc.ctx = new AC();
      } else if (vc.ctx.state === 'suspended') {
        try { await vc.ctx.resume(); } catch {}
      }
      try {
        vc.analyser = vc.ctx.createAnalyser();
        vc.analyser.fftSize = 1024;
        vc.ctx.createMediaStreamSource(vc.stream).connect(vc.analyser);
      } catch (e) {
        console.warn('AudioContext setup error', e);
      }
    }
    return true;
  } catch (err) {
    console.warn('Failed to acquire voice stream:', err);
    return false;
  }
}

async function voiceOpen() {
  if (vc.open || vc.opening) return;                 // a second tap must not start a second conversation
  vc.opening = true;
  setTimeout(() => { vc.opening = false; }, 1500);
  unlockAudio();                                 // must happen synchronously inside the tap
  if (typeof liveEngine === 'function' && liveEngine() === 'live') liveUnlock();
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
  const ok = await vcEnsureStream();
  if (!ok) {
    toast('Could not access the microphone', 'err');
    return;
  }
  try { if (navigator.wakeLock) vc.wake = await navigator.wakeLock.request('screen'); } catch { /* optional */ }

  vc.open = true; vc.run++;
  document.body.classList.add('voice-mode');
  const a = AGENTS[state.agent] || AGENTS.antigravity;
  $('#voice').style.setProperty('--agent', a.color);
  $('#voiceAgent').textContent = currentModel(state.agent) ? agentLabel(state.agent, currentModel(state.agent)) : a.full;
  syncVoiceLabel();
  $('#voiceYou').textContent = ''; $('#voiceReply').textContent = '';
  vcSyncMute();
  $('#voice').hidden = false;
  if (typeof voiceEngineSync === 'function') voiceEngineSync();
  if (typeof liveEngine === 'function' && liveEngine() === 'live') {
    liveStart().then((ok) => { if (!ok && vc.open) liveFallback(); });
    return;
  }
  vcListen();
}

function voiceClose() {
  if (!vc.open) return;
  vc.open = false; vc.run++;
  if (typeof liveStop === 'function') liveStop();
  if (typeof vadDestroy === 'function') vadDestroy();
  vcSpeechCancel();
  document.body.classList.remove('voice-mode');
  cancelAnimationFrame(vc.raf);
  if (vc.recorder && vc.recorder.state !== 'inactive') { vc.cancelled = true; try { vc.recorder.stop(); } catch { /* already stopped */ } }
  stopSpeaking();
  if (state.streaming) detachStreaming();      // the agent keeps working; the reply lands in the chat
  clearInterval(vc.tt);
  if (vc.stream) {
    try { vc.stream.getTracks().forEach((t) => t.stop()); } catch {}
  }
  if (vc.ctx) {
    try { vc.ctx.close().catch(() => {}); } catch {}
  }
  if (vc.wake) {
    try { vc.wake.release().catch(() => {}); } catch {}
  }
  vc.stream = vc.ctx = vc.analyser = vc.recorder = vc.wake = null;
  $('#voice').hidden = true;
  vcPhase('idle');
  if (vc.prevAgent) { setAgent(vc.prevAgent); vc.prevAgent = null; }
  scrollToBottom(true);
}

async function vcListen() {
  if (!vc.open) return;
  const ok = await vcEnsureStream();
  if (!ok) {
    vcPhase('idle', 'Tap to talk');
    toast('Microphone disconnected — tap to talk', 'err');
    return;
  }
  // Voice-activity model (loads in the background the first time; until then the simple detector below is used).
  if (typeof vadLoad === 'function') {
    if (vadv.inst && vadv.stream !== vc.stream) await vadDestroy();          // the mic stream was replaced
    if (!vadv.inst && !vadv.failed) { await Promise.race([vadLoad(), new Promise((r) => setTimeout(r, 2500))]); if (vadv.inst) vadv.stream = vc.stream; }
    if (!vc.open) return;
    if (vadv.inst && await vadListen()) return;
  }
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
  try {
    vc.recorder.start(100);
  } catch (e) {
    console.warn('MediaRecorder start error:', e);
    vc.stream = null;
    vcPhase('idle', 'Tap to talk');
    return;
  }
  vcPhase('listening');
  haptic(6);
  if (vc.analyser) vcMeter(run);
}

// Level meter + voice-activity detection: stop ~0.8 s after you stop talking.
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

    if (vc.heard && now - vc.lastVoice > 800) return vcStopListening();
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

async function vcHandleAudio(run, wavBlob, sttPromise) {
  if (!vc.open || run !== vc.run) return;
  if (vc.cancelled && !wavBlob) { if (vc.phase === 'listening') vcPhase('idle'); return; }
  vcPhase('thinking', 'Transcribing…');
  let text = '';
  if (sttPromise) {                                  // transcribed live while you were talking
    const t = await Promise.race([sttPromise, new Promise((r) => setTimeout(() => r(null), 2500))]);
    if (t) text = t.trim();
  }
  try {
    if (text) throw new Error('already transcribed');
    const mime = wavBlob ? 'audio/wav' : ((vc.recorder && vc.recorder.mimeType) || 'audio/mp4');
    const blob = wavBlob || new Blob(vc.chunks, { type: mime });
    if (blob.size < 200) { vcPhase('idle', 'Tap to talk'); return; }
    const fd = new FormData();
    const ext = mime.includes('mp4') ? 'mp4' : mime.includes('webm') ? 'webm' : 'wav';
    fd.append('file', blob, `speech.${ext}`);
    const curAgent = state.agent || 'antigravity';
    text = ((await api(`/api/transcribe?agent=${encodeURIComponent(curAgent)}`, { method: 'POST', body: fd })).transcript || '').trim();
  } catch (e) {
    if (!text) { console.error('Transcription error:', e); toast('Transcription failed', 'err'); }
  }
  if (!vc.open || run !== vc.run) return;
  if (!text) { toast("Didn't catch that"); return vcListen(); }

  $('#voiceYou').textContent = text;
  $('#voiceReply').textContent = '';
  vcPhase('thinking');
  vc.thinkStart = Date.now();
  // Speak while the reply is still being written: each finished sentence is voiced right away.
  const sp = vcSpeechStart(run);
  let streamEl = null;
  const pump = setInterval(() => { if (streamEl && streamEl._raw) sp.push(streamEl._raw, false); }, 120);
  // A long task: every so often, while nothing is being said, reassure the user out loud.
  const t0 = Date.now(), nudgeAt = [15, 40, 75, 120]; let nudged = 0;
  const NUDGES = ['Still working on it.', 'Still on it. Thanks for waiting.', 'It is taking a little longer, but I am still on it.', 'Almost there, still working.'];
  const nudge = setInterval(() => {
    if (!vc.open || run !== vc.run || sp.cancelled || vc.muted) return;
    if (nudged < nudgeAt.length && (Date.now() - t0) / 1000 >= nudgeAt[nudged] && vc.phase === 'thinking' && !sp.done) {
      const phrase = NUDGES[nudged++];
      const item = { text: phrase, p: ttsFetch(phrase) };
      item.p.catch(() => {});
      sp.items.push(item);
      if (sp.wake) sp.wake();
    }
  }, 1000);
  let res;
  try { res = await send(text, { voice: true, onEl: (el) => { streamEl = el; } }); }
  finally { clearInterval(pump); clearInterval(nudge); }
  if (!vc.open || run !== vc.run) return vcSpeechCancel(sp);
  if (!res) { vcSpeechCancel(sp); return vcPhase('idle', 'Still working on the last one'); }
  if (res.stopped) { vcSpeechCancel(sp); return vcPhase('idle'); }
  if (res.failed) { vcSpeechCancel(sp); toast(res.failed, 'err'); return vcPhase('idle'); }

  $('#voiceReply').textContent = speakable(res.text).display;
  haptic(12);
  sp.push(res.text, true);                       // flush the last sentence; the player returns to listening when it's done
  if (vc.muted || !sp.items.length) { vcSpeechCancel(sp); return vcListen(); }
}

// Sentence queue for streamed replies. Audio for every sentence is requested as soon as the sentence
// is complete, and played back to back, so speech starts after the first sentence, not the whole reply.
function vcSpeechStart(run) {
  vcSpeechCancel();
  const sp = { run, queued: 0, items: [], done: false, cancelled: false, wake: null };
  vc.sp = sp;
  const LIMIT = 3;                                  // sentences read verbatim; anything longer gets a spoken summary
  const enqueue = (text) => { const item = { text, p: ttsFetch(text) }; item.p.catch(() => {}); sp.items.push(item); };
  const finish = () => { sp.done = true; if (sp.wake) sp.wake(); };
  sp.push = (raw, final) => {
    if (sp.cancelled || vc.muted || sp.summarizing) return;
    const { chunks, display } = speakable(raw, { partial: !final });
    for (; sp.queued < Math.min(chunks.length, LIMIT); sp.queued++) enqueue(chunks[sp.queued]);
    if (!final) { if (sp.wake) sp.wake(); return; }
    if (chunks.length > LIMIT) {
      sp.summarizing = true;
      fetch('/api/voice/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: display, spoken: chunks.slice(0, LIMIT).join(' ') }) })
        .then((r) => r.json())
        .then((d) => enqueue((d && d.summary) || 'The rest is on screen.'))
        .catch(() => enqueue('The rest is on screen.'))
        .finally(finish);
      return;
    }
    finish();
  };
  const live = () => vc.open && vc.sp === sp && !sp.cancelled && vc.run === run;
  const idle = () => new Promise((r) => { sp.wake = () => { sp.wake = null; r(); }; });
  (async () => {
    for (let i = 0; live();) {
      if (i >= sp.items.length) {
        if (sp.done) break;
        if (vc.phase === 'speaking') vcPhase('thinking');      // acknowledgement finished, the agent is still working
        await idle(); continue;
      }
      const item = sp.items[i++];
      let url;
      try { url = await item.p; } catch {
        // Server voice unavailable: wait for the full reply, then read the rest with the browser voice.
        while (!sp.done && live()) await idle();
        if (!live()) return;
        const rest = sp.items.slice(i - 1).map((x) => x.text);
        vcPhase('speaking');
        if (hasTTS && rest.length) return vcSpeakFallback(rest, run);
        toast('Could not play audio', 'err');
        return vcListen();
      }
      if (!live()) { URL.revokeObjectURL(url); return; }
      if (vc.phase !== 'speaking') vcPhase('speaking');
      try { await playUrl(url); } catch (err) {
        if (live()) toast(`Could not play audio (${(err && (err.name || err.message)) || 'unknown'})`, 'err');
      } finally { URL.revokeObjectURL(url); }
    }
    if (live()) { vc.sp = null; vcListen(); }
  })();
  return sp;
}

function vcSpeechCancel(sp) {
  const cur = sp || vc.sp;
  if (!cur) return;
  cur.cancelled = true;
  if (cur.wake) cur.wake();
  if (vc.sp === cur) vc.sp = null;
}

// Turn a markdown reply into short speakable chunks (sentences), skipping code and comments.
function speakable(md, { partial = false } = {}) {
  let t = stripTag(md).text;
  t = (t || '')
    .replace(/<!--[\s\S]*?-->/g, '')     // strip complete HTML comments (including JSON containing '>')
    .replace(/<!--[\s\S]*$/g, '')        // strip in-flight partial comments
    .replace(/(~{3,}|`{3,})[\s\S]*?\1/g, ' (code omitted) ')
    .replace(partial ? /(~{3,}|`{3,})[\s\S]*$/ : /(?!)/, ' ')     // a code block still being written
    .replace(/<[^>]+>/g, '')             // strip HTML tags
    .replace(/<[^>]*$/g, '')             // strip partial trailing tags
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
  // While streaming, the last line may be unfinished: leave its punctuation alone so we never speak half a sentence.
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let flat = lines.map((l, i) => (partial && i === lines.length - 1) || /[.!?:)]$/.test(l) ? l : l + '.').join(' ');
  let cut = false;
  if (flat.length > 900) { flat = flat.slice(0, 900).replace(/[^.!?]*$/, '') || flat.slice(0, 900); cut = true; }
  const chunks = (flat.match(/.+?[.!?]+["')\]]*(?=\s|$)|.+$/g) || []).map((c) => c.trim()).filter(Boolean);
  if (partial && !cut && chunks.length && !/[.!?]["')\]]*$/.test(flat)) chunks.pop();     // unfinished sentence
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

let cachedVoiceCatalog = null;

async function loadVoiceCatalog() {
  if (cachedVoiceCatalog) return cachedVoiceCatalog;
  try {
    const data = await api('/api/tts/voices');
    cachedVoiceCatalog = data?.voices || [];
    return cachedVoiceCatalog;
  } catch {
    return [];
  }
}

let activeVoiceTab = 'antigravity';

function getAgentDefaultVoice(agent) {
  if (agent === 'antigravity') return 'en-US-ChristopherNeural';
  if (agent === 'claude') return 'en-US-AriaNeural';
  if (agent === 'regina') return 'en-US-AriaNeural';
  if (agent === 'codex') return 'en-US-EricNeural';
  return 'en-US-JennyNeural';
}

function getAgentVoice(agent) {
  const ag = (agent || state.agent || 'antigravity').toLowerCase();
  const override = store.get('agent_voice_' + ag);
  if (override) return override;
  const globalPref = store.get('preferredVoice');
  if (globalPref) return globalPref;
  return getAgentDefaultVoice(ag);
}

function setAgentVoice(agent, voiceId) {
  const ag = (agent || 'all').toLowerCase();
  if (ag === 'all') {
    if (voiceId) {
      store.set('preferredVoice', voiceId);
    } else {
      store.remove('preferredVoice');
    }
  } else {
    if (voiceId) {
      store.set('agent_voice_' + ag, voiceId);
    } else {
      store.remove('agent_voice_' + ag);
    }
  }
  syncVoiceLabel();
}

function syncVoiceLabel() {
  const vId = getAgentVoice(state.agent);
  const short = vId.split('-')[2]?.replace('Neural', '').replace('Expressive', '') || 'Voice';

  const label = $('#voiceName');
  if (label) label.textContent = short;

  const setSub = $('#setVoiceSub');
  if (setSub) setSub.textContent = `${short} (Neural Human)`;
}

function ttsFetch(text, agent = state.agent, voiceOverride = null) {
  const voice = voiceOverride || getAgentVoice(agent) || '';
  return fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, agent, voice })
  })
    .then((r) => { if (!r.ok) throw new Error(`TTS ${r.status}`); return r.blob(); })
    .then((b) => URL.createObjectURL(b));
}

async function openVoicePickerSheet(targetAgent = null) {
  openSheet(`<div class="file-loading">Loading neural voices…</div>`);
  const voices = await loadVoiceCatalog();
  if (targetAgent && ['antigravity', 'claude', 'codex', 'regina', 'all'].includes(targetAgent)) {
    activeVoiceTab = targetAgent;
  } else if (!activeVoiceTab) {
    activeVoiceTab = state.agent || 'antigravity';
  }

  const renderSheetContent = () => {
    const isAll = activeVoiceTab === 'all';
    const currentVoice = isAll ? (store.get('preferredVoice') || '') : getAgentVoice(activeVoiceTab);
    const defaultVoice = isAll ? 'en-US-JennyNeural' : getAgentDefaultVoice(activeVoiceTab);
    const hasCustom = isAll ? !!store.get('preferredVoice') : !!store.get('agent_voice_' + activeVoiceTab);

    return `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <h3 style="margin:0;">Agent Voice Settings</h3>
        <button class="icon-btn" data-sheet="cancel">${icon('i-x')}</button>
      </div>
      <p class="lead" style="margin-bottom:12px;">Choose human-like neural voices for each AI assistant.</p>

      <!-- Agent Selection Tabs -->
      <div class="segmented" style="display:flex; width:100%; margin-bottom:14px; background:var(--surface-1); padding:3px; border-radius:12px; border:1px solid var(--line);">
        <button type="button" class="btn btn-sm ${activeVoiceTab === 'antigravity' ? 'btn-primary' : 'btn-ghost'}" data-voice-tab="antigravity" style="flex:1; font-size:12.5px; padding:6px 0;">🔵 Antigravity</button>
        <button type="button" class="btn btn-sm ${activeVoiceTab === 'claude' ? 'btn-primary' : 'btn-ghost'}" data-voice-tab="claude" style="flex:1; font-size:12.5px; padding:6px 0;">🟣 Claude</button>
        <button type="button" class="btn btn-sm ${activeVoiceTab === 'regina' ? 'btn-primary' : 'btn-ghost'}" data-voice-tab="regina" style="flex:1; font-size:12.5px; padding:6px 0;">🌸 Regina</button>
        <button type="button" class="btn btn-sm ${activeVoiceTab === 'codex' ? 'btn-primary' : 'btn-ghost'}" data-voice-tab="codex" style="flex:1; font-size:12.5px; padding:6px 0;">🟢 Codex</button>
        <button type="button" class="btn btn-sm ${activeVoiceTab === 'all' ? 'btn-primary' : 'btn-ghost'}" data-voice-tab="all" style="flex:1; font-size:12.5px; padding:6px 0;">🌐 All</button>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <span style="font-size:12.5px; color:var(--text-2); font-weight:600;">
          ${activeVoiceTab === 'all' ? 'Default Voice for All Agents' : `Voice for ${AGENTS[activeVoiceTab]?.full || activeVoiceTab}`}
        </span>
        ${hasCustom ? `
          <button type="button" class="btn btn-ghost btn-sm" id="btnResetVoice" style="font-size:11.5px; color:#60a5fa; padding:2px 8px;">
            ${icon('i-refresh', 'xs')} Reset to Provider Default
          </button>` : ''}
      </div>

      <!-- Voice List -->
      <div class="stack" style="gap:8px; max-height:55vh; overflow-y:auto; padding-right:2px;">
        ${voices.map(v => {
          const isSel = (currentVoice === v.id);
          const isAgentDef = (defaultVoice === v.id);
          const flag = v.accent === 'UK' ? '🇬🇧' : v.accent === 'IN' ? '🇮🇳' : '🇺🇸';
          return `
          <div class="opt ${isSel ? 'active' : ''}" data-pick-voice="${esc(v.id)}" style="display:flex; align-items:center; justify-content:space-between; cursor:pointer; padding:11px 13px; border-radius:12px; border:1px solid ${isSel ? 'var(--accent)' : 'var(--line)'}; background:${isSel ? 'rgba(124, 140, 255, 0.08)' : 'var(--surface-1)'};">
            <div style="display:flex; align-items:center; gap:11px; min-width:0;">
              <div style="width:36px; height:36px; border-radius:18px; background:var(--surface-2); display:grid; place-items:center; font-size:17px; flex:none;">
                ${v.gender === 'Female' ? '👩' : '👨'}
              </div>
              <div style="min-width:0;">
                <div style="font-weight:600; font-size:14.5px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                  <span>${esc(v.name)}</span>
                  <span style="font-size:10.5px; padding:1px 5px; border-radius:6px; background:var(--surface-3); color:var(--text-2); font-weight:500;">${flag} ${esc(v.accent)}</span>
                  ${isAgentDef ? `<span style="font-size:10.5px; padding:1px 6px; border-radius:6px; background:rgba(96, 165, 250, 0.15); color:#60a5fa; font-weight:600;">Provider Default</span>` : ''}
                </div>
                <div style="font-size:12px; color:var(--text-3); margin-top:2px;">${esc(v.style)}</div>
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:6px; flex:none;">
              <button class="btn btn-ghost btn-sm" data-preview-voice="${esc(v.id)}" style="padding:5px 9px; font-size:11.5px; gap:3px;" title="Listen to preview">
                ${icon('i-volume', 'xs')} Preview
              </button>
              ${isSel ? `<span style="color:var(--accent);">${icon('i-check')}</span>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    `;
  };

  openSheet(renderSheetContent(), (body) => {
    const bindSheetEvents = () => {
      // Tab switching
      $$('[data-voice-tab]', body).forEach(tabBtn => {
        tabBtn.addEventListener('click', (e) => {
          activeVoiceTab = tabBtn.dataset.voiceTab;
          body.innerHTML = renderSheetContent();
          bindSheetEvents();
        });
      });

      // Reset to provider default
      $('#btnResetVoice', body)?.addEventListener('click', (e) => {
        setAgentVoice(activeVoiceTab, null);
        toast(`Reset ${activeVoiceTab} to provider default voice`, 'ok');
        body.innerHTML = renderSheetContent();
        bindSheetEvents();
      });

      // Preview audio
      $$('[data-preview-voice]', body).forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const vId = btn.dataset.previewVoice;
          btn.disabled = true;
          const orig = btn.innerHTML;
          btn.innerHTML = 'Speaking…';
          try {
            unlockAudio();
            const sample = "Hello! I am speaking with a natural human neural voice. How do I sound?";
            const url = await ttsFetch(sample, activeVoiceTab === 'all' ? state.agent : activeVoiceTab, vId);
            await playUrl(url);
            URL.revokeObjectURL(url);
          } catch (err) {
            toast('Preview failed: ' + err.message, 'err');
          } finally {
            btn.disabled = false;
            btn.innerHTML = orig;
          }
        });
      });

      // Select voice
      $$('[data-pick-voice]', body).forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('[data-preview-voice]')) return;
          const vId = card.dataset.pickVoice;
          setAgentVoice(activeVoiceTab, vId);
          const vName = card.querySelector('span')?.textContent || 'selected voice';
          const targetName = activeVoiceTab === 'all' ? 'all agents' : (AGENTS[activeVoiceTab]?.full || activeVoiceTab);
          toast(`Set ${targetName} voice to ${vName}`, 'ok');
          body.innerHTML = renderSheetContent();
          bindSheetEvents();
        });
      });
    };

    bindSheetEvents();
  });
}

let isUserInterrupt = false;

// Play one audio URL; resolves when it ends or errors.
function playUrl(url) {
  return new Promise((resolve) => {
    isUserInterrupt = false;
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      ttsAudio.removeEventListener('ended', onEnd);
      ttsAudio.removeEventListener('error', onErr);
      resolve();
    };
    const onEnd = () => cleanup();
    const onErr = (e) => {
      console.warn('Audio playback error', e);
      cleanup();
    };

    ttsAudio.addEventListener('ended', onEnd);
    ttsAudio.addEventListener('error', onErr);
    ttsAudio.src = url;

    if ('mediaSession' in navigator) {
      try {
        const vName = getAgentVoice(state.agent).split('-')[2]?.replace('Neural','').replace('Expressive','') || 'Voice';
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Spoken Agent Reply',
          artist: AGENTS[state.agent]?.full || 'AgentHub',
          album: `${vName} Neural Speech`
        });
      } catch {}
    }

    const p = ttsAudio.play();
    if (p && p.catch) {
      p.catch((err) => {
        // If paused by OS backgrounding, don't break - let it resolve cleanly
        console.warn('Playback notice:', err?.message || err);
        cleanup();
      });
    }
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
  isUserInterrupt = true;
  try { ttsAudio.pause(); } catch { /* ignore */ }
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch { /* ignore */ }
}

async function vcSpeak(chunks, run) {
  vcPhase('speaking');
  const live = () => vc.open && run === vc.run && vc.phase === 'speaking';
  let pending = ttsFetch(chunks[0]);
  try {
    for (let i = 0; i < chunks.length && live() && !isUserInterrupt; i++) {
      const url = await pending;
      pending = i + 1 < chunks.length ? ttsFetch(chunks[i + 1]) : null;
      if (!live() || isUserInterrupt) { URL.revokeObjectURL(url); break; }
      try {
        await playUrl(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch (err) {
    console.warn('vcSpeak error:', err);
  }
  if (live() && !isUserInterrupt) vcListen();
}

async function vcOrbTap() {
  unlockAudio();
  if (typeof liveEngine === 'function' && liveEngine() === 'live') { liveUnlock(); return liveOrbTap(); }
  haptic(10);
  if (vc.phase === 'idle') {
    const ok = await vcEnsureStream();
    if (!ok) {
      toast('Microphone unavailable — please tap again or grant permission', 'err');
      return;
    }
    vcListen();
  } else if (vc.phase === 'listening') {
    if (typeof vadSendNow === 'function' && vadSendNow()) return;
    vc.heard = true;
    vc.cancelled = false;
    vcStopListening();
  } else if (vc.phase === 'thinking') {
    vc.run++;
    vcSpeechCancel();
    if (state.streaming) stopStreaming();
    vcPhase('idle', 'Tap to talk');
  } else if (vc.phase === 'speaking') {
    vc.run++;                                    // drop anything still queued or streaming
    vcSpeechCancel();
    if (state.streaming) stopStreaming();
    stopSpeaking();
    const ok = await vcEnsureStream();
    if (ok) vcListen();
    else vcPhase('idle', 'Tap to talk');
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
    term.attachCustomKeyEventHandler(termClipboardKeys);
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

// Copy: Ctrl/Cmd+Shift+C, Cmd+C, or Ctrl+C while text is selected (otherwise ^C
// still interrupts). Paste: Ctrl/Cmd+V and Ctrl+Shift+V fall through to the
// browser's native paste event, which xterm turns into a (bracketed) paste.
function termClipboardKeys(e) {
  if (e.type !== 'keydown') return true;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return true;
  if (k === 'c' && (e.shiftKey || e.metaKey || term.hasSelection())) {
    e.preventDefault();
    termCopy();
    return false;
  }
  if (k === 'v') return false;
  return true;
}

async function termCopy() {
  if (!term) return;
  if (!term.hasSelection()) { termSelectSheet(); return; }
  const ok = await copyText(term.getSelection());
  term.clearSelection();
  toast(ok ? 'Copied' : 'Copy failed', ok ? 'ok' : 'err');
  term.focus();
}

async function termPaste() {
  if (!term) return;
  try {
    if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) {
      const text = await navigator.clipboard.readText();
      if (text) { term.paste(text); term.focus(); return; }
    }
  } catch { /* permission denied — fall back to a paste box */ }
  termPasteSheet();
}

// Phones can't select text on xterm's canvas, so show the buffer as plain text
// where the OS's long-press selection works.
function termBufferText(maxLines = 2000) {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = Math.max(0, buf.length - maxLines); i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const s = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += s;
    else lines.push(s);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

function termSelectSheet() {
  openSheet(`
    <h3>Copy from terminal</h3>
    <p class="lead">Long-press or drag to select, then copy — or copy everything.</p>
    <textarea id="termCopyText" class="sheet-input term-clip" readonly spellcheck="false"></textarea>
    <div class="sheet-actions">
      <button class="btn" data-sheet="cancel">Close</button>
      <button class="btn" data-term-copy-sel>Copy selection</button>
      <button class="btn btn-primary" data-term-copy-all>Copy all</button>
    </div>`, (body) => {
    const ta = body.querySelector('#termCopyText');
    ta.value = termBufferText();
    ta.scrollTop = ta.scrollHeight;
    const done = async (text) => {
      const ok = text && await copyText(text);
      toast(ok ? 'Copied' : text ? 'Copy failed' : 'Nothing selected', ok ? 'ok' : 'err');
      if (ok) closeSheet();
    };
    body.querySelector('[data-term-copy-sel]').addEventListener('click', () => done(ta.value.slice(ta.selectionStart, ta.selectionEnd)));
    body.querySelector('[data-term-copy-all]').addEventListener('click', () => done(ta.value));
  }, { full: true });
}

function termPasteSheet() {
  openSheet(`
    <h3>Paste into terminal</h3>
    <p class="lead">Paste (long-press → Paste) or type below, then send.</p>
    <textarea id="termPasteText" class="sheet-input term-clip" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus></textarea>
    <div class="sheet-actions">
      <button class="btn" data-sheet="cancel">Cancel</button>
      <button class="btn btn-primary" data-term-paste-ok>Send</button>
    </div>`, (body) => {
    const ta = body.querySelector('#termPasteText');
    body.querySelector('[data-term-paste-ok]').addEventListener('click', () => {
      const v = ta.value;
      closeSheet();
      if (v) { term.paste(v); term.focus(); }
    });
    ta.focus();
  });
}

function setCtrl(on) {
  ctrlOn = on;
  $('#ctrlKey').classList.toggle('on', on);
}

const KEYS = { esc: '\x1b', tab: '\t', '^C': '\x03', '^D': '\x04', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', clear: '\x0c' };

function pressKey(k) {
  haptic(5);
  if (k === 'ctrl') return setCtrl(!ctrlOn);
  if (k === 'copy') return termCopy();
  if (k === 'paste') return termPaste();
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

let monTimer = null;
let showAllProcs = false;

function syncMonitorPolling() {
  const want = state.tab === 'monitor' && !document.hidden;
  if (want && !monTimer) { pollSystem(); monTimer = setInterval(pollSystem, 3000); }
  if (!want && monTimer) { clearInterval(monTimer); monTimer = null; }
}

const levelCls = (pct) => (pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '');

function setGauge(id, pct, val, sub) {
  const g = $(id);
  const fill = $('.bar-fill', g);
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  fill.className = `bar-fill ${levelCls(pct)}`;
  const v = $('.gauge-val', g);
  v.textContent = val;
  v.className = `res-val gauge-val ${levelCls(pct)}`;
  const s = $('.gauge-sub', g); if (s && sub !== undefined) s.textContent = sub;
}

function setUsageBar(fillId, pct) {
  const f = $(fillId);
  if (!f) return;
  f.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  f.className = `bar-fill ${levelCls(pct)}`;
}

async function pollUsage() {
  try {
    const b5h = state.prefs.fiveHourBudget || 200000;
    const bwk = state.prefs.weeklyBudget || 1500000;
    const u = await api(`/api/usage?five_hour_budget=${encodeURIComponent(b5h)}&weekly_budget=${encodeURIComponent(bwk)}&agent=all`);
    const w5 = u && u.window_5h;
    const w7 = u && u.window_7d;
    if (w5) {
      $('#u5hUsed').textContent = `~${formatTokens(w5.tokens_used)}`;
      $('#u5hPct').textContent = `${w5.percent_used}% of ${formatTokens(w5.tokens_budget)}`;
      setUsageBar('#u5hBarFill', w5.percent_used);
      $('#u5hReset').textContent = w5.next_reset_formatted && w5.next_reset_formatted !== 'Idle' ? `Oldest usage leaves the 5-hour window in ${w5.next_reset_formatted}` : '';
      const entries = Object.entries(w5.by_agent || {}).sort((x, y) => y[1].tokens - x[1].tokens);
      const max = Math.max(1, ...entries.map(([, st]) => st.tokens));
      $('#u5hAgentChips').innerHTML = entries.length ? entries.map(([k, st]) => {
        const ag = AGENTS[k];
        return `<div class="usage-agent" style="--agent:${ag ? ag.color : 'var(--text-3)'}">
          <span class="ua-name">${esc(ag ? ag.name : k)}</span>
          <span class="bar"><span class="bar-fill agent" style="width:${Math.max(3, Math.round((st.tokens / max) * 100))}%"></span></span>
          <span class="ua-val">~${formatTokens(st.tokens)}</span></div>`;
      }).join('') : '<span class="muted sm">No agent activity in the last 5 hours.</span>';
    }
    if (w7) {
      $('#u7dUsed').textContent = `~${formatTokens(w7.tokens_used)}`;
      $('#u7dPct').textContent = `${w7.percent_used}% of ${formatTokens(w7.tokens_budget)}`;
      setUsageBar('#u7dBarFill', w7.percent_used);
    }
  } catch {
    /* ignore usage poll error */
  }
}

async function pollSystem() {
  try {
    const d = await api('/api/system');
    setGauge('#gCpu', d.cpu_percent, `${Math.round(d.cpu_percent)}%`);
    setGauge('#gMem', d.memory_percent, `${Math.round(d.memory_percent)}%`, `${d.memory_used_gb.toFixed(1)} of ${d.memory_total_gb.toFixed(1)} GB`);
    setGauge('#gDisk', d.disk_percent, `${Math.round(d.disk_percent)}%`, `${Math.round(d.disk_free_gb)} GB free of ${Math.round(d.disk_total_gb)} GB`);
    $('#monUptime').textContent = `Up ${d.uptime_formatted}`;
    state.procs = d.agent_processes || [];
    renderProcesses(state.procs);
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

// Agent CLIs first, helper processes (servers, daemons) behind "Show all".
function procColor(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('antigravity') || t.includes('agy')) return AGENTS.antigravity.color;
  if (t.includes('claude')) return AGENTS.claude.color;
  if (t.includes('codex')) return AGENTS.codex.color;
  return 'var(--text-3)';
}

function renderProcesses(list) {
  $('#procCount').textContent = list.length ? `${list.length} running` : '';
  const shown = showAllProcs ? list : list.slice(0, 5);
  $('#processList').innerHTML = list.length ? shown.map((p) => {
    const self = p.agent_type === 'AgentHub Server';
    return `
    <div class="proc">
      <span class="dot" style="--agent:${procColor(p.agent_type)}"></span>
      <div class="proc-main">
        <div class="proc-name">${esc(p.agent_type)} <span class="proc-pid">#${p.pid}</span></div>
        <div class="proc-cmd" title="${esc(p.cmd)}">${esc(p.cmd)}</div>
      </div>
      <div class="proc-meta">${p.cpu}% CPU<br>${p.memory}% RAM · ${fmtDuration(p.running_sec)}</div>
      ${self ? '<span class="proc-self">this app</span>' : `<button class="icon-btn" data-kill="${p.pid}" data-kill-name="${esc(p.agent_type)}" aria-label="Stop ${esc(p.agent_type)}">${icon('i-more')}</button>`}
    </div>`;
  }).join('') + (list.length > 5 ? `<button class="link-btn row-more" data-toggle-procs>${showAllProcs ? 'Show fewer' : `Show all ${list.length}`}</button>` : '')
    : '<div class="empty-inline">No agent processes running.</div>';
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
    updateHomeStatus();
  } catch {
    if (!state.sessionsLoaded) $('#sessionList').innerHTML = '<div class="empty-inline">Could not load conversations.</div>';
    return;
  }
  renderHistory();
  renderRail();
  if (chromeMode() === 'home') renderHome();
}

function sessRow(s) {
  return `
    <div class="swipe-row sess-swipe-row" data-sess-id="${esc(s.id)}">
      <div class="swipe-actions">
        <button class="swipe-del-btn" data-del="${esc(s.id)}" aria-label="Delete conversation" title="Delete conversation">
          ${icon('i-trash')}
          <span>Delete</span>
        </button>
      </div>
      <div class="sess ${s.id === state.sessionId ? 'current' : ''}" data-open="${esc(s.id)}" role="button" tabindex="0">
        <span class="dot" style="--agent:${(AGENTS[s.agent] || AGENTS.antigravity).color}"></span>
        <div class="sess-main">
          <div class="sess-title">${esc(s.title || 'Untitled')}</div>
          <div class="sess-meta">${esc((AGENTS[s.agent] || { name: s.agent }).name)} · ${state.running.has(s.id) ? '<span class="sess-run">Running…</span>' : relTime(s.updated_at)}</div>
        </div>
        <button class="sess-del" data-del="${esc(s.id)}" aria-label="Delete conversation">${icon('i-trash')}</button>
      </div>
    </div>`;
}

function renderHistory() {
  if (activeSwipedRow && !activeSwipedRow.isConnected) activeSwipedRow = null;
  const q = $('#historySearch').value.trim().toLowerCase();
  const list = state.sessions.filter((s) => !q || (s.title || '').toLowerCase().includes(q) || (s.agent || '').toLowerCase().includes(q) || (s.workspace || '').toLowerCase().includes(q));
  const el = $('#sessionList');
  if (!list.length) {
    el.innerHTML = `${groupToggle()}<div class="empty-inline">${q ? 'No conversations match your search.' : 'No conversations yet. Start one from the Chats tab.'}</div>`;
    return;
  }
  if (state.groupBy === 'folder') {
    el.innerHTML = groupToggle() + groupByFolder(list).map((g) => `
      <div class="hist-group">${folderHead(g.ws, g.items.length)}${g.items.map(sessRow).join('')}</div>`).join('');
    return;
  }
  const groups = new Map();
  list.forEach((s) => { const k = dayBucket(s.updated_at); (groups.get(k) || groups.set(k, []).get(k)).push(s); });
  el.innerHTML = groupToggle() + [...groups].map(([label, items]) => `
    <div>
      <div class="day-label">${label}</div>
      ${items.map(sessRow).join('')}
    </div>`).join('');
}

function renderRail() {
  const el = $('#railRecent');
  if (!el) return;
  const row = (s) => `
    <button class="rail-item ${s.id === state.sessionId ? 'current' : ''}" data-open="${esc(s.id)}">
      <span class="dot ${state.running.has(s.id) ? 'live' : ''}" style="--agent:${(AGENTS[s.agent] || AGENTS.antigravity).color}"></span><span>${esc(s.title || 'Untitled')}</span>
    </button>`;
  const running = state.sessions.filter((s) => state.running.has(s.id));
  const rest = state.sessions.filter((s) => !state.running.has(s.id));
  let body;
  if (!rest.length) body = '<div class="rail-empty">No conversations yet</div>';
  else if (state.groupBy === 'folder') {
    body = groupByFolder(rest).slice(0, 8).map((g) => {
      const open = state.expandedWs.has(g.ws);
      const collapsed = state.collapsedRailWs.has(g.ws);
      return `<div class="rail-folder">
        <button class="rail-section-title folder rail-folder-toggle" data-toggle-rail-folder="${esc(g.ws)}" aria-expanded="${!collapsed}" title="${esc(g.ws)}">${icon('i-chevron', 'xs rail-folder-chevron')}${icon('i-folder', 'xs')}<span>${esc(g.ws ? basename(g.ws) : 'No folder')}</span><span class="rail-count">${g.items.length}</span></button>
        ${collapsed ? '' : (open ? g.items : g.items.slice(0, 4)).map(row).join('')}
        ${!collapsed && g.items.length > 4 ? `<button class="rail-more" data-expand-ws="${esc(g.ws)}">${open ? 'Show fewer' : `${g.items.length - 4} more`}</button>` : ''}
      </div>`;
    }).join('');
  } else body = rest.slice(0, 14).map(row).join('');
  el.innerHTML = (running.length ? `<div class="rail-section-title">Running</div>${running.map(row).join('')}` : '')
    + `<div class="rail-section-title rail-head">${state.groupBy === 'folder' ? 'By folder' : 'Recent'}${groupToggle()}</div>` + body;
}

/* ── iPhone-style Swipe to Delete ────────────────────────── */
let activeSwipedRow = null;
let isSuppressingClick = false;
let suppressClickTimer = null;

let swipeState = {
  row: null,
  content: null,
  startX: 0,
  startY: 0,
  startTime: 0,
  initialX: 0,
  currentX: 0,
  isSwiping: false,
  isScrolling: false,
  directionLocked: false,
  pointerId: null,
  fullSwipeTriggered: false
};

function closeSwipedRow(row) {
  if (!row) return;
  const content = row.querySelector('.sess, .chat-row');
  if (content) {
    content.style.transition = 'transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1)';
    content.style.transform = 'translateX(0)';
  }
  delete row.dataset.swiped;
  row.classList.remove('is-swiping', 'full-swipe');
}

function initSwipeToDelete() {
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.swipe-del-btn, .sess-del, [data-del]')) return;

    const row = e.target.closest('.swipe-row');
    if (!row) {
      if (activeSwipedRow) {
        closeSwipedRow(activeSwipedRow);
        activeSwipedRow = null;
      }
      return;
    }

    if (activeSwipedRow && activeSwipedRow !== row) {
      closeSwipedRow(activeSwipedRow);
      activeSwipedRow = null;
    }

    const content = row.querySelector('.sess, .chat-row');
    if (!content) return;

    const isOpen = row.dataset.swiped === 'true';
    const initialX = isOpen ? -84 : 0;

    swipeState = {
      row,
      content,
      startX: e.clientX,
      startY: e.clientY,
      startTime: Date.now(),
      initialX,
      currentX: initialX,
      isSwiping: false,
      isScrolling: false,
      directionLocked: false,
      pointerId: e.pointerId,
      fullSwipeTriggered: false
    };
  }, { passive: true });

  document.addEventListener('pointermove', (e) => {
    if (!swipeState.row || swipeState.isScrolling) return;
    if (swipeState.pointerId !== null && e.pointerId !== swipeState.pointerId) return;

    const dx = e.clientX - swipeState.startX;
    const dy = e.clientY - swipeState.startY;

    if (!swipeState.directionLocked) {
      if (Math.hypot(dx, dy) < 6) return;
      swipeState.directionLocked = true;

      if (Math.abs(dy) >= Math.abs(dx)) {
        swipeState.isScrolling = true;
        if (activeSwipedRow && activeSwipedRow === swipeState.row) {
          closeSwipedRow(activeSwipedRow);
          activeSwipedRow = null;
        }
        return;
      } else {
        swipeState.isSwiping = true;
        swipeState.row.classList.add('is-swiping');
        try {
          swipeState.row.setPointerCapture(e.pointerId);
        } catch {}
      }
    }

    if (!swipeState.isSwiping) return;

    let nextX = swipeState.initialX + dx;
    if (nextX > 0) {
      nextX = nextX * 0.15;
    }

    const fullSwipeThreshold = Math.min(-170, -(swipeState.row.offsetWidth * 0.48));
    if (nextX <= fullSwipeThreshold && !swipeState.fullSwipeTriggered) {
      swipeState.fullSwipeTriggered = true;
      swipeState.row.classList.add('full-swipe');
      haptic(15);
    } else if (nextX > fullSwipeThreshold && swipeState.fullSwipeTriggered) {
      swipeState.fullSwipeTriggered = false;
      swipeState.row.classList.remove('full-swipe');
    }

    swipeState.currentX = nextX;
    swipeState.content.style.transition = 'none';
    swipeState.content.style.transform = `translateX(${nextX}px)`;
  });

  const onPointerEnd = (e) => {
    if (!swipeState.row) return;
    if (swipeState.pointerId !== null && e.pointerId !== swipeState.pointerId) return;

    const { row, content, isSwiping, initialX, currentX, fullSwipeTriggered, startTime } = swipeState;

    if (isSwiping) {
      isSuppressingClick = true;
      clearTimeout(suppressClickTimer);
      suppressClickTimer = setTimeout(() => { isSuppressingClick = false; }, 220);

      try {
        if (e.pointerId !== null) row.releasePointerCapture(e.pointerId);
      } catch {}

      const dx = currentX - initialX;
      const dt = Math.max(1, Date.now() - startTime);
      const vx = dx / dt;

      if (fullSwipeTriggered || currentX < Math.min(-180, -(row.offsetWidth * 0.5))) {
        content.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.9, 0.3, 1)';
        content.style.transform = 'translateX(-100%)';
        activeSwipedRow = null;
        delete row.dataset.swiped;
        row.classList.remove('is-swiping', 'full-swipe');
        const id = row.dataset.sessId;
        if (id) deleteSession(id);
      } else if (currentX < -38 || vx < -0.3) {
        content.style.transition = 'transform 0.32s cubic-bezier(0.18, 0.89, 0.32, 1.15)';
        content.style.transform = 'translateX(-84px)';
        row.dataset.swiped = 'true';
        row.classList.remove('is-swiping', 'full-swipe');
        activeSwipedRow = row;
        haptic(8);
      } else {
        closeSwipedRow(row);
        if (activeSwipedRow === row) activeSwipedRow = null;
      }
    }

    swipeState.row = null;
    swipeState.content = null;
    swipeState.isSwiping = false;
    swipeState.isScrolling = false;
    swipeState.directionLocked = false;
    swipeState.pointerId = null;
    swipeState.fullSwipeTriggered = false;
  };

  document.addEventListener('pointerup', onPointerEnd);
  document.addEventListener('pointercancel', onPointerEnd);

  window.addEventListener('scroll', () => {
    if (activeSwipedRow) {
      closeSwipedRow(activeSwipedRow);
      activeSwipedRow = null;
    }
  }, { passive: true, capture: true });
}

async function deleteSession(id) {
  const row = document.querySelector(`.swipe-row[data-sess-id="${id}"]`);
  const ok = await confirmSheet({ title: 'Delete conversation?', message: 'This removes it from history permanently.', confirm: 'Delete', danger: true });
  if (!ok) {
    if (row) closeSwipedRow(row);
    return;
  }
  if (row) {
    row.style.transition = 'max-height 0.28s ease, margin 0.28s ease, opacity 0.25s ease, transform 0.25s ease';
    row.style.maxHeight = row.offsetHeight + 'px';
    void row.offsetHeight;
    row.style.maxHeight = '0px';
    row.style.marginTop = '0px';
    row.style.marginBottom = '0px';
    row.style.opacity = '0';
    row.style.pointerEvents = 'none';
    row.style.transform = 'scale(0.96)';
    await new Promise((r) => setTimeout(r, 260));
  }
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
  sessionStorage.removeItem('ah.open');
  renderEmpty(); updateTitle();
}

/* ════════════════════════════════════════════════════════════
   Settings & connectivity
   ════════════════════════════════════════════════════════════ */

function refreshSettings() {
  $('#setOrigin').textContent = location.origin;
  if ($('#setOrigin')) $('#setOrigin').dataset.copy = location.origin;
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
  // The canonical secure address is the single origin every device must use.
  // localStorage/sessionStorage are per-origin, so opening a different address
  // (a raw IP, or a rotating trycloudflare link) creates a separate isolated app.
  const canonical = state.tunnel.url || '';
  const onCanonical = canonical && location.origin === canonical;
  $('#tunnelSub').textContent = canonical ? canonical.replace(/^https?:\/\//, '') : 'Not running';
  $('#tunnelSub').dataset.copy = canonical;
  btn.textContent = state.tunnel.active ? 'Stop' : 'Start';
  btn.classList.toggle('btn-danger', state.tunnel.active);

  // Show the device-mismatch banner whenever this device is not on the one
  // canonical HTTPS origin (covers http, raw IP, and tunnel URLs alike).
  const insecureRemote = location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname);
  const mismatch = !!canonical && !onCanonical;
  const banner = $('#httpsBanner');
  banner.hidden = !(insecureRemote || mismatch);
  if (canonical) $('#httpsLink').href = canonical;
  if ($('#httpsBannerText')) {
    $('#httpsBannerText').textContent = mismatch
      ? 'You are on a different address — open the secure link so this device shares conversations.'
      : 'Voice input needs HTTPS on this device.';
  }
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
  state.online = !!ok;
  const dot = $('#connDot');
  if (dot) dot.className = `conn-dot ${state.online ? 'ok' : 'bad'}`;
  const txt = $('#connText');
  if (txt) txt.textContent = state.online ? 'Connected to VM' : 'Offline';
  updateHomeStatus();
}

function updateHomeStatus() {
  const n = state.running ? state.running.size : 0;
  const isOnline = state.online !== false;
  const dot = $('#homeConnDot');
  if (dot) dot.className = `conn-dot ${isOnline ? 'ok' : 'bad'}`;
  const txt = $('#homeConnText');
  if (txt) {
    txt.textContent = !isOnline ? 'VM offline'
      : `Connected${n ? ` · ${n} task${n === 1 ? '' : 's'} running` : ''}`;
  }
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
  if ($('#skillsCount')) $('#skillsCount').textContent = allSkills.length || '';
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
    <button class="item-row" data-action="view-skill" data-name="${esc(s.name)}">
      <span class="item-ico">${icon('i-box')}</span>
      <span class="item-main">
        <span class="item-title"><span class="mono">${esc(s.name)}</span><span class="tag">${esc(s.is_builtin ? 'built-in' : (s.agent_scope || 'global'))}</span></span>
        <span class="item-desc">${esc(s.description || 'No description provided')}</span>
      </span>
      ${icon('i-chevron', 'xs muted')}
    </button>`).join('');
}

function renderMcp() {
  if ($('#mcpCount')) $('#mcpCount').textContent = allMcpServers.length || '';
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
    <div class="item-row">
      <span class="item-ico">${icon('i-link')}</span>
      <span class="item-main">
        <span class="item-title"><span class="mono">${esc(m.name)}</span><span class="tag">${esc(m.type || 'stdio')}</span></span>
        <span class="item-desc mono">${esc(m.command || m.url || '')} ${esc((m.args || []).join(' '))}</span>
        <span class="item-meta">${esc((m.agents || ['claude', 'antigravity']).map((k) => (AGENTS[k] || { name: k }).name).join(', '))}${m.tools && m.tools.length ? ` · ${m.tools.length} tools` : ''}</span>
      </span>
      <button class="icon-btn" data-action="delete-mcp" data-name="${esc(m.name)}" aria-label="Remove ${esc(m.name)}">${icon('i-trash')}</button>
    </div>`).join('');
}

function switchSkillsPanel(panel) {
  skillsPanelActive = panel;
  $('#panelSkills').hidden = panel !== 'skills';
  $('#panelMcp').hidden = panel !== 'mcp';
  $$('#skillsTabToggle button').forEach((b) => {
    b.classList.toggle('active', b.dataset.panel === panel);
    b.setAttribute('aria-selected', String(b.dataset.panel === panel));
  });
}

function openSkillCreator({ name = '', description = '', content = '', agent_scope = 'global', is_builtin = false } = {}) {
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
          <option value="global" ${agent_scope === 'global' ? 'selected' : ''}>Global (All Agents: Antigravity, Claude, Codex)</option>
          <option value="antigravity" ${agent_scope === 'antigravity' ? 'selected' : ''}>Google Antigravity Only</option>
          <option value="claude" ${agent_scope === 'claude' ? 'selected' : ''}>Claude Code Only</option>
          <option value="codex" ${agent_scope === 'codex' ? 'selected' : ''}>OpenAI Codex Only</option>
        </select>
      </label>
      <label>
        <span class="sheet-meta">Skill Instructions & Rules (Markdown)</span>
        <textarea class="composer-input" id="skillInputContent" rows="7" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px; font-family:var(--mono); font-size:12.5px;" placeholder="# Instructions for the agent...">${esc(content)}</textarea>
      </label>
    </div>
    <div class="sheet-actions" style="margin-top:14px;">
      <button class="btn" data-sheet="cancel">Cancel</button>
      <button class="btn btn-primary" id="saveSkillBtn">Save skill</button>
    </div>
    ${name && !is_builtin ? `<button class="btn btn-ghost btn-sm danger-link" data-action="delete-skill" data-name="${esc(name)}">${icon('i-trash', 'xs')}Delete this skill</button>` : ''}
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
    <h3>Generate a skill with AI</h3>
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
        openSkillCreator({ name: res?.name || '', description: res?.description || '', content: res?.content || '' });
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
    <h3>Configure an MCP server with AI</h3>
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
        openMcpCreator({ name: res?.name || '', command: res?.command || '', args: res?.args || [], env: res?.env || {} });
      } catch (err) {
        toast('Generation failed: ' + err.message, 'err');
        e.target.disabled = false;
        e.target.textContent = 'Generate Config';
      }
    });
  });
}

async function openConnectorsSheet() {
  const badge = (c) => {
    const m = { ready: ['#34d399', 'Connected'], error: ['#fbbf24', 'Needs attention'], unauthenticated: ['#f87171', 'Not connected'] }[c.status] || ['#f87171', c.status];
    return `<span style="font-size:11.5px; font-weight:600; color:${m[0]};">● ${m[1]}</span>`;
  };
  openSheet(`
    <h3 style="margin:0 0 4px;">Connectors</h3>
    <p class="lead">Mail accounts agents can search and read via the <span class="mono">search_emails</span> / <span class="mono">read_email</span> tools.</p>
    <div id="connList" style="margin-top:12px; display:flex; flex-direction:column; gap:10px;">
      <div style="text-align:center; padding:16px; color:var(--text-2);">Checking connections…</div>
    </div>
  `, async (body) => {
    const cont = $('#connList', body);
    const renderMsgs = (box, msgs) => {
      box.style.display = 'block';
      const errs = msgs.filter(m => m.error);
      if (errs.length) { box.innerHTML = `<span style="color:#fbbf24;">${esc(errs[0].error)}</span>`; return; }
      box.innerHTML = msgs.length ? msgs.map(m => `
        <div style="padding:6px 0; border-top:1px solid var(--line);">
          <div style="font-weight:600; font-size:13px;">${esc(m.subject || '(No Subject)')}</div>
          <div style="font-size:12px; color:var(--text-2);">${esc(m.from || '')} · ${esc((m.date || '').slice(0, 16))}</div>
        </div>`).join('') : '<span style="color:var(--text-2);">No messages found.</span>';
    };
    const draw = (items) => {
      cont.innerHTML = items.map(c => `
        <div class="card" style="padding:12px 14px; display:flex; flex-direction:column; gap:8px; background:var(--surface-1); border:1px solid var(--line); border-radius:12px;" data-conn="${esc(c.id)}">
          <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px;">
            <div style="font-weight:650; font-size:14px;">${esc(c.label)}</div>${badge(c)}
          </div>
          <div class="mono" style="font-size:12px; color:var(--text-2);">${esc(c.account || '')}</div>
          ${c.error ? `<div style="font-size:12px; color:#fbbf24;">${esc(c.error)}${c.id === 'm365' ? '<br>Needs an Azure app registration with Mail.Read.' : ''}</div>` : ''}
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <input type="search" placeholder="Search mail (blank = latest)" data-conn-q style="flex:1; min-width:140px; height:32px; border-radius:8px; background:var(--surface-2); border:1px solid var(--line-strong); color:var(--text); padding:0 10px; font-size:13px; outline:none;">
            <button class="btn btn-sm" data-conn-search>Search</button>
            <button class="btn btn-sm btn-ghost" data-conn-test>Test</button>
          </div>
          <div data-conn-out style="display:none; font-size:12.5px;"></div>
        </div>`).join('');
      $$('[data-conn]', cont).forEach(card => {
        const id = card.dataset.conn;
        const out = $('[data-conn-out]', card);
        const q = $('[data-conn-q]', card);
        const search = async () => {
          out.style.display = 'block'; out.textContent = 'Searching…';
          try { renderMsgs(out, (await api(`/api/connectors/${id}/messages?q=${encodeURIComponent(q.value)}&limit=6`)).messages || []); }
          catch (e) { out.textContent = 'Search failed: ' + e.message; }
        };
        $('[data-conn-search]', card).addEventListener('click', search);
        q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
        $('[data-conn-test]', card).addEventListener('click', async (e) => {
          e.target.disabled = true;
          try {
            const r = await api(`/api/connectors/${id}/test`, { method: 'POST' });
            toast(`${r.label}: ${r.status === 'ready' ? 'connected' : (r.error || r.status)}`, r.status === 'ready' ? 'info' : 'err');
            const i = items.findIndex(x => x.id === id); items[i] = r; draw(items);
          } catch (err) { toast('Test failed: ' + err.message, 'err'); e.target.disabled = false; }
        });
      });
    };
    try { draw((await api('/api/connectors')).connectors || []); }
    catch (e) { cont.innerHTML = `<div style="color:#f87171;">Could not load connectors: ${esc(e.message)}</div>`; }
  });
}

async function openVaultSheet() {
  openSheet(`
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
      <h3 style="margin:0;">Encrypted Credentials Vault</h3>
      <button class="btn btn-primary btn-sm" id="vaultBtnNew" style="display:inline-flex; align-items:center; gap:4px;">${icon('i-plus', 'xs')} New Login</button>
    </div>
    <p class="lead">All credentials, passwords, and 2FA secrets are AES-256-GCM encrypted and available to all agents.</p>
    <div id="vaultListContainer" style="margin-top:12px; display:flex; flex-direction:column; gap:8px;">
      <div style="text-align:center; padding:16px; color:var(--text-2);">Loading credentials…</div>
    </div>
  `, async (body) => {
    $('#vaultBtnNew', body)?.addEventListener('click', () => {
      openVaultCreator();
    });

    try {
      const res = await api('/api/vault');
      const list = res.credentials || [];
      const cont = $('#vaultListContainer', body);
      if (!cont) return;
      if (!list.length) {
        cont.innerHTML = `
          <div style="text-align:center; padding:24px 12px; background:var(--surface-1); border-radius:12px; border:1px dashed var(--line);">
            <div style="font-size:24px; margin-bottom:6px;">🔐</div>
            <div style="font-weight:600; font-size:14px;">Vault is empty</div>
            <div style="font-size:12px; color:var(--text-2); margin-top:4px;">Add your first site login or API credential to share with agents.</div>
          </div>
        `;
        return;
      }

      cont.innerHTML = list.map(c => `
        <div class="card" style="padding:12px 14px; display:flex; flex-direction:column; gap:6px; background:var(--surface-1); border:1px solid var(--line); border-radius:12px;">
          <div style="display:flex; justify-content:space-between; align-items:baseline;">
            <div style="font-weight:650; font-size:14px; color:var(--text);">${esc(c.name || c.service)} <span class="mono" style="font-size:11px; color:var(--text-2); font-weight:normal;">(${esc(c.service)})</span></div>
            <div style="display:flex; gap:6px;">
              ${c.has_totp ? `<button class="btn btn-sm btn-ghost" data-vault-totp="${esc(c.service)}" style="font-size:12px; padding:2px 8px; color:#7c8cff;">🔑 2FA</button>` : ''}
              ${c.url ? `<button class="btn btn-sm btn-ghost" data-vault-login="${esc(c.service)}" style="font-size:12px; padding:2px 8px; color:#34d399;">🌐 Auto Login</button>` : ''}
              <button class="btn btn-sm btn-ghost" data-vault-del="${esc(c.service)}" style="font-size:12px; padding:2px 6px; color:#f87171;">🗑️</button>
            </div>
          </div>
          <div style="font-size:12.5px; color:var(--text-2); display:flex; gap:12px; flex-wrap:wrap;">
            ${c.username ? `<span>👤 ${esc(c.username)}</span>` : ''}
            ${c.url ? `<span class="mono" style="overflow:hidden; text-overflow:ellipsis; max-width:240px;">🔗 ${esc(c.url)}</span>` : ''}
            ${c.has_password ? `<span>🔒 Password stored</span>` : ''}
            ${c.has_token ? `<span>🎟️ API Token</span>` : ''}
          </div>
          <div id="vaultResult_${esc(c.service)}" style="display:none; margin-top:6px; font-size:12px; padding:6px 10px; border-radius:6px; background:var(--surface-2);"></div>
        </div>
      `).join('');

      // Wire TOTP buttons
      $$('[data-vault-totp]', body).forEach(btn => {
        btn.addEventListener('click', async () => {
          const s = btn.dataset.vaultTotp;
          const box = $(`#vaultResult_${s}`, body);
          btn.disabled = true;
          try {
            const totp = await api(`/api/vault/${encodeURIComponent(s)}/totp`);
            if (box) {
              box.style.display = 'block';
              box.innerHTML = `🔑 <strong>2FA Code:</strong> <span class="mono" style="font-size:16px; font-weight:700; color:#7c8cff; letter-spacing:2px; margin-left:6px;">${totp.code}</span> <span style="color:var(--text-2); margin-left:8px;">(${totp.remaining_seconds}s remaining)</span>`;
            }
          } catch (e) {
            toast('TOTP error: ' + e.message, 'err');
          } finally {
            btn.disabled = false;
          }
        });
      });

      // Wire Auto Login buttons
      $$('[data-vault-login]', body).forEach(btn => {
        btn.addEventListener('click', async () => {
          const s = btn.dataset.vaultLogin;
          const box = $(`#vaultResult_${s}`, body);
          btn.disabled = true;
          btn.textContent = 'Logging in…';
          if (box) {
            box.style.display = 'block';
            box.innerHTML = `⏳ Executing headless Playwright browser login for <code>${esc(s)}</code>…`;
          }
          try {
            const res = await api(`/api/vault/${encodeURIComponent(s)}/login`, { method: 'POST' });
            if (res.success) {
              toast(`Logged into ${s}!`, 'ok');
              if (box) {
                box.innerHTML = `✅ <strong>Login Success!</strong> Saved session cookies to <code>${esc(res.session_saved)}</code>. Page: <em>${esc(res.title || res.final_url)}</em>`;
              }
            } else {
              toast(`Login failed: ${res.error}`, 'err');
              if (box) {
                box.innerHTML = `❌ <strong>Login Failed:</strong> ${esc(res.error)}`;
              }
            }
          } catch (e) {
            toast('Login error: ' + e.message, 'err');
          } finally {
            btn.disabled = false;
            btn.textContent = '🌐 Auto Login';
          }
        });
      });

      // Wire Delete buttons
      $$('[data-vault-del]', body).forEach(btn => {
        btn.addEventListener('click', async () => {
          const s = btn.dataset.vaultDel;
          if (!confirm(`Delete credential for "${s}"?`)) return;
          try {
            await api(`/api/vault/${encodeURIComponent(s)}`, { method: 'DELETE' });
            toast(`Deleted "${s}"`, 'ok');
            openVaultSheet();
          } catch (e) {
            toast('Delete failed: ' + e.message, 'err');
          }
        });
      });

    } catch (e) {
      toast('Failed to load vault: ' + e.message, 'err');
    }
  });
}

function openVaultCreator({ service = '', name = '', username = '', password = '', totp_secret = '', url = '', api_token = '', notes = '' } = {}) {
  openSheet(`
    <h3>${service ? 'Edit Credential' : 'Add Credential to Vault'}</h3>
    <p class="lead">Encrypted with AES-256-GCM. Available to Antigravity, Claude, and Codex.</p>
    <div class="stack" style="gap:10px; margin-top:10px;">
      <label>
        <span class="sheet-meta">Service ID (e.g. github, tentamus-ciam, azure)</span>
        <input class="composer-input" id="vaultInputService" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(service)}" placeholder="e.g. github" ${service ? 'readonly' : ''}>
      </label>
      <label>
        <span class="sheet-meta">Friendly Name</span>
        <input class="composer-input" id="vaultInputName" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(name)}" placeholder="e.g. GitHub Production">
      </label>
      <label>
        <span class="sheet-meta">Login or Web Portal URL</span>
        <input class="composer-input" id="vaultInputUrl" type="url" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(url)}" placeholder="https://github.com/login">
      </label>
      <label>
        <span class="sheet-meta">Username or Email</span>
        <input class="composer-input" id="vaultInputUser" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(username)}" placeholder="user@example.com">
      </label>
      <label>
        <span class="sheet-meta">Password</span>
        <input class="composer-input" id="vaultInputPass" type="password" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(password)}" placeholder="Enter password (AES-256 encrypted)">
      </label>
      <label>
        <span class="sheet-meta">2FA / TOTP Base32 Secret (Optional)</span>
        <input class="composer-input mono" id="vaultInputTotp" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(totp_secret)}" placeholder="e.g. JBSWY3DPEHPK3PXP">
      </label>
      <label>
        <span class="sheet-meta">API Token / Secret Key (Optional)</span>
        <input class="composer-input mono" id="vaultInputToken" type="password" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" value="${esc(api_token)}" placeholder="e.g. ghp_xxxxxxxx">
      </label>
      <label>
        <span class="sheet-meta">Notes / Metadata (Optional)</span>
        <textarea class="composer-input" id="vaultInputNotes" rows="2" style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:4px;" placeholder="Notes, recovery codes, or tenant details">${esc(notes)}</textarea>
      </label>
    </div>
    <div class="sheet-actions" style="margin-top:14px;">
      <button class="btn" data-sheet="cancel">Cancel</button>
      <button class="btn btn-primary" id="saveVaultBtn">Save to Vault</button>
    </div>
  `, (body) => {
    $('#saveVaultBtn', body)?.addEventListener('click', async () => {
      const vService = $('#vaultInputService', body).value.trim();
      const vName = $('#vaultInputName', body).value.trim();
      const vUrl = $('#vaultInputUrl', body).value.trim();
      const vUser = $('#vaultInputUser', body).value.trim();
      const vPass = $('#vaultInputPass', body).value;
      const vTotp = $('#vaultInputTotp', body).value.trim();
      const vToken = $('#vaultInputToken', body).value.trim();
      const vNotes = $('#vaultInputNotes', body).value.trim();

      if (!vService) { toast('Service ID is required', 'err'); return; }

      try {
        await api('/api/vault', {
          method: 'POST',
          body: JSON.stringify({
            service: vService,
            name: vName,
            url: vUrl,
            username: vUser,
            password: vPass,
            totp_secret: vTotp,
            api_token: vToken,
            notes: vNotes
          })
        });
        closeSheet();
        toast(`Credentials for "${vService}" saved to vault!`, 'ok');
        openVaultSheet();
      } catch (e) {
        toast(`Save failed: ${e.message}`, 'err');
      }
    });
  });
}

let lastGeoSync = 0;
async function syncBrowserLocation(force = false) {
  if (!('geolocation' in navigator)) return;
  const now = Date.now();
  if (!force && now - lastGeoSync < 60000) return;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      lastGeoSync = Date.now();
      try {
        const { latitude, longitude, accuracy } = pos.coords;
        const res = await api('/api/location/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latitude, longitude, accuracy, force })
        });
        const sub = $('#setLocationSub');
        if (sub && res.location) {
          const acc = accuracy ? ` (±${Math.round(accuracy)}m)` : '';
          sub.textContent = `${res.location.city || res.location.name || 'Synced'}${acc}`;
        }
        if (force) {
          toast(`Location updated: ${res.location?.city || res.location?.name || 'Synced'}`);
        }
      } catch (e) {
        console.warn('Location sync failed:', e);
        if (force) toast(`Location sync failed: ${e.message}`, 'err');
      }
    },
    (err) => {
      if (force) toast(`Geolocation access denied: ${err.message}`, 'err');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

async function updateLocationSub() {
  try {
    const loc = await api('/api/location');
    const sub = $('#setLocationSub');
    if (sub && loc) {
      const acc = loc.accuracy_m ? ` (±${Math.round(loc.accuracy_m)}m)` : '';
      sub.textContent = `${loc.city || loc.name || 'Synced'}${acc}`;
    }
  } catch {}
}

async function openLocationSheet() {
  openSheet(`
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
      <h3 style="margin:0;">Live Location & Travel</h3>
      <button class="btn btn-primary btn-sm" id="btnSyncGps" style="display:inline-flex; align-items:center; gap:4px;">${icon('i-globe', 'xs')} Sync GPS Now</button>
    </div>
    <p class="lead">Shared travel context across all agents. Automatically tracks your browser's live GPS location.</p>
    <div id="locationCardContainer" style="margin-top:12px; display:flex; flex-direction:column; gap:10px;">
      <div style="text-align:center; padding:16px; color:var(--text-2);">Loading location…</div>
    </div>
  `, async (body) => {
    const cont = $('#locationCardContainer', body);
    const renderCard = (loc) => {
      if (!cont) return;
      const acc = loc.accuracy_m ? ` · ±${Math.round(loc.accuracy_m)}m accuracy` : '';
      cont.innerHTML = `
        <div class="card" style="padding:14px; background:var(--surface-1); border:1px solid var(--line); border-radius:12px; display:flex; flex-direction:column; gap:8px;">
          <div style="display:flex; justify-content:space-between; align-items:baseline;">
            <div style="font-weight:700; font-size:15px; color:var(--text);">${esc(loc.name || loc.city || 'Current Location')}</div>
            <span style="font-size:11px; padding:2px 8px; border-radius:12px; background:rgba(52, 211, 153, 0.15); color:#34d399; font-weight:600;">Active</span>
          </div>
          <div style="font-size:13px; color:var(--text-2); line-height:1.4;">${esc(loc.address || '')}</div>
          <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:4px; font-size:11.5px; color:var(--text-3);">
            <span>📍 ${loc.latitude ? loc.latitude.toFixed(4) : ''}, ${loc.longitude ? loc.longitude.toFixed(4) : ''}${acc}</span>
            <span>🕒 ${esc(loc.timezone || 'UTC')}</span>
            <span>🔄 ${esc(loc.updated?.slice(0, 16) || '')}</span>
          </div>
          ${loc.maps_url ? `<div style="margin-top:6px;"><a href="${esc(loc.maps_url)}" target="_blank" rel="noopener" style="font-size:12px; color:var(--accent); text-decoration:none; font-weight:600;">View in Google Maps ↗</a></div>` : ''}
        </div>

        <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
          <div style="font-weight:600; font-size:13px;">Manual Override</div>
          <div style="display:flex; gap:6px;">
            <input type="text" id="manualPlaceInput" class="input" placeholder="City or hotel (e.g. Palma, Mallorca)" style="flex:1;">
            <button class="btn btn-secondary btn-sm" id="btnSetPlace">Set</button>
          </div>
          <button class="btn btn-secondary btn-sm" id="btnResetHome" style="align-self:flex-start; margin-top:4px;">Reset to Home (Berlin)</button>
        </div>
      `;

      $('#manualPlaceInput', body)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#btnSetPlace', body)?.click();
      });
      $('#btnSetPlace', body)?.addEventListener('click', async () => {
        const p = $('#manualPlaceInput', body)?.value.trim();
        if (!p) return;
        try {
          const res = await api('/api/location/set-place', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ place: p })
          });
          toast(`Location set to: ${res.location?.city || res.location?.address || p}`);
          renderCard(res.location);
          updateLocationSub();
        } catch (err) {
          toast(`Failed: ${err.message}`, 'err');
        }
      });
      $('#btnResetHome', body)?.addEventListener('click', async () => {
        try {
          const res = await api('/api/location/reset-home', { method: 'POST' });
          toast('Location reset to Home (Berlin)');
          renderCard(res.location);
          updateLocationSub();
        } catch (err) {
          toast(`Failed: ${err.message}`, 'err');
        }
      });
    };

    $('#btnSyncGps', body)?.addEventListener('click', () => {
      syncBrowserLocation(true).then(() => {
        api('/api/location').then(renderCard).catch(() => {});
      });
    });

    try {
      const loc = await api('/api/location');
      renderCard(loc);
    } catch (e) {
      cont.innerHTML = `<div style="color:var(--text-2); text-align:center; padding:16px;">Failed to load location: ${esc(e.message)}</div>`;
    }
  });
}

function openChatMenu() {
  const g = state.git;
  const agentKey = state.agent || 'antigravity';
  const selVoice = getAgentVoice(agentKey);
  const vName = selVoice ? selVoice.split('-')[2]?.replace('Neural','').replace('Expressive','') : 'Christopher';
  const agentObj = AGENTS[agentKey] || AGENTS.antigravity;
  openSheet(`
    <h3>${esc(state.title || 'This conversation')}</h3>
    <div>
      <button class="opt" data-action="new-chat"><span class="opt-ico" style="background:rgba(124, 140, 255, 0.16); color:#7c8cff;">${icon('i-plus')}</span><span class="opt-main"><span class="opt-title">New chat</span><br><span class="opt-sub">Start a fresh conversation</span></span></button>
      <button class="opt" data-action="open-agents"><span class="opt-ico">${icon(agentObj.icon || 'i-sparkle')}</span><span class="opt-main"><span class="opt-title">Agent &amp; model</span><br><span class="opt-sub">${esc(agentLabel(agentKey, currentModel()))}</span></span></button>
      <button class="opt" data-action="open-voice-picker"><span class="opt-ico" style="background:rgba(236, 72, 153, 0.16); color:#ec4899;">${icon('i-volume')}</span><span class="opt-main"><span class="opt-title">Speech voice</span><br><span class="opt-sub">${esc(vName)} (Neural Human)</span></span></button>
      <button class="opt" data-action="open-workspaces"><span class="opt-ico">${icon('i-folder')}</span><span class="opt-main"><span class="opt-title">Workspace</span><br><span class="opt-sub mono">${esc(state.workspace || '/root')}</span></span></button>
      ${g ? `<button class="opt" data-action="open-git-changes"><span class="opt-ico">${icon('i-git')}</span><span class="opt-main"><span class="opt-title">Code changes</span><br><span class="opt-sub">${g.files.length} files · +${g.total_adds} −${g.total_dels}</span></span></button>` : ''}
      <button class="opt" data-action="open-qr"><span class="opt-ico">${icon('i-qr')}</span><span class="opt-main"><span class="opt-title">Open on phone</span><br><span class="opt-sub">Show a QR code for this app</span></span></button>
      ${state.sessionId ? `<button class="opt danger" data-del="${esc(state.sessionId)}"><span class="opt-ico">${icon('i-trash')}</span><span class="opt-main"><span class="opt-title">Delete conversation</span></span></button>` : ''}
    </div>`);
}

/* ════════════════════════════════════════════════════════════
   Event wiring
   ════════════════════════════════════════════════════════════ */

function setInspectorOpen(open, focusToggle = false) {
  document.body.classList.toggle('inspector-closed', !open);
  store.set('inspectorOpen', open);
  const toggle = $('#inspectorToggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close run details' : 'Open run details');
  toggle.title = open ? 'Close run details' : 'Open run details';
  if (focusToggle) toggle.focus();
}

const actions = {
  'toggle-inspector': () => setInspectorOpen(document.body.classList.contains('inspector-closed')),
  'close-inspector': () => setInspectorOpen(false, true),
  'toggle-nav': toggleNav,
  'open-nav': openNav,
  'close-nav': closeNav,
  'new-chat': () => { closeSheet(); newChat({ focus: true }); },
  'go-home': () => newChat({ focus: false }),
  'open-chat-menu': openChatMenu,
  'open-vault': openVaultSheet,
  'open-connectors': openConnectorsSheet,
  'open-location': openLocationSheet,
  'open-create-menu': () => {
    const mcp = skillsPanelActive === 'mcp';
    openSheet(`
      <h3>${mcp ? 'Add an MCP server' : 'New skill'}</h3>
      <button class="opt" data-action="${mcp ? 'open-mcp-create' : 'open-skill-create'}"><span class="opt-ico">${icon('i-file-code')}</span><span class="opt-main"><span class="opt-title">Write it yourself</span><br><span class="opt-sub">${mcp ? 'Command, arguments and environment' : 'Name, trigger and instructions in Markdown'}</span></span></button>
      <button class="opt" data-action="${mcp ? 'open-mcp-gen' : 'open-skill-gen'}"><span class="opt-ico">${icon('i-sparkle')}</span><span class="opt-main"><span class="opt-title">Describe it, an agent drafts it</span><br><span class="opt-sub">You review before saving</span></span></button>`);
  },
  'open-agents': openAgentSheet,
  'open-voice-picker': openVoicePickerSheet,
  'open-workspaces': openFolderPicker,
  'open-git-changes': () => openGitChangesSheet(),
  'view-file-diff': (el) => openGitChangesSheet(el.dataset.file),
  'open-qr': openQrSheet,
  'open-attach': openAttachSheet,
  'pick-camera': () => { closeSheet(); $('#cameraInput')?.click(); },
  'pick-device-file': () => { closeSheet(); $('#mediaFileInput')?.click(); },
  'pick-vm-file': () => { browseMode = 'attach'; openWorkspaceSheet(state.workspace || '/root'); },
  'fetch-attach-url': () => { const val = $('#attachUrlInput')?.value.trim(); if (val) attachExternalUrl(val); },
  send: () => {
    const mode = $('#sendBtn').dataset.mode;
    if (mode === 'stop') stopStreaming();
    else if (mode === 'talk') voiceOpen();
    else send();
  },
  mic: toggleMic,
  'voice-open': voiceOpen,
  'test-voice': testVoice,
  'voice-close': voiceClose,
  'voice-orb': vcOrbTap,
  'voice-mute': () => { vc.muted = !vc.muted; store.set('voiceMuted', vc.muted); vcSyncMute(); if (vc.muted) { if (live.on) { liveSilence(); live.turnDone = true; liveIdleCheck(); } else { stopSpeaking(); if (vc.phase === 'speaking') vcListen(); } } },
  'voice-engine': (el) => voiceEngineSet(el.dataset.engine),
  'voice-headphones': () => voiceHeadphonesToggle(),
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
      const listed = allSkills.find((x) => x.name === name);
      openSkillCreator({ name: sk.name, description: sk.description, content: sk.content, agent_scope: sk.agent_scope, is_builtin: !!(sk.is_builtin || (listed && listed.is_builtin)) });
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
  if (isSuppressingClick) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }

  const t = e.target;
  if (!navDesktop.matches && t.closest('#rail [data-tab], #rail [data-files-tab], #rail [data-action="new-chat"], #rail [data-session]')) closeNav();
  const q = (s) => t.closest(s);
  let el;

  if ((el = q('a[data-smart-tel], a[data-smart-link]'))) {
    e.preventDefault();
    if (el.dataset.smartTel) openPhoneSheet(el.dataset.smartTel, el.textContent);
    else openLinkSheet(el.dataset.smartLink);
    return;
  }
  if ((el = q('[data-copy-val]'))) {
    toast((await copyText(el.dataset.copyVal)) ? 'Copied' : 'Copy failed', 'ok'); haptic(6); closeSheet();
    return;
  }

  const clickedSwipeRow = q('.swipe-row');
  if (clickedSwipeRow && clickedSwipeRow.dataset.swiped === 'true') {
    if (q('.swipe-del-btn, .sess-del, [data-del]')) {
      // Tap delete button -> let data-del handle it
    } else {
      // Tap row body to dismiss swipe -> close row, do NOT open chat
      e.preventDefault();
      e.stopImmediatePropagation();
      closeSwipedRow(clickedSwipeRow);
      activeSwipedRow = null;
      return;
    }
  } else if (activeSwipedRow && !clickedSwipeRow) {
    // Tap outside open row -> close it
    closeSwipedRow(activeSwipedRow);
    activeSwipedRow = null;
  }

  if ((el = q('[data-action]'))) { actions[el.dataset.action]?.(el); return; }
  if (q('[data-files-tab]')) { browseMode = 'files'; openWorkspaceSheet(state.workspace || '/root'); return; }
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
    showAllModels = false;
    if (MODEL_AGENTS.includes(state.agent)) openAgentSheet(); else closeSheet();   // stay open to pick a model
    return;
  }
  if (q('[data-toggle-all-models]')) { showAllModels = !showAllModels; openAgentSheet(); return; }
  if ((el = q('[data-agent-chip]'))) {
    const k = el.dataset.agentChip;
    if (k === state.agent && MODEL_AGENTS.includes(k)) { showAllModels = false; openAgentSheet(); }
    else { setAgent(k); haptic(); }
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
  if ((el = q('[data-copy-file-content]'))) {
    const body = el.closest('.sheet-body');
    const ok = await copyText(body?._fileContent || '');
    toast(ok ? 'File contents copied' : 'Copy failed', ok ? 'ok' : 'err');
    return;
  }
  if ((el = q('[data-copy]'))) { if (el.dataset.copy) toast((await copyText(el.dataset.copy)) ? 'Copied' : 'Copy failed', 'ok'); return; }
  if ((el = q('[data-copy-code]'))) {
    const ok = await copyText($('pre', el.closest('.codeblock')).innerText);
    el.innerHTML = `${icon(ok ? 'i-check' : 'i-alert')}${ok ? 'Copied' : 'Failed'}`;
    setTimeout(() => { el.innerHTML = `${icon('i-copy')}Copy`; }, 1600);
    return;
  }
  if ((el = q('[data-copy-user]'))) {
    const ok = await copyText(el.closest('.msg')._text || '');
    toast(ok ? 'Message copied' : 'Copy failed', ok ? 'ok' : 'err');
    return;
  }
  if ((el = q('[data-copy-msg]'))) {
    const raw = el.closest('.msg')._raw || '';
    const clean = stripTag(raw).text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[\s\S]*$/g, '').trim();
    const ok = await copyText(clean);
    toast(ok ? 'Reply copied' : 'Copy failed', ok ? 'ok' : 'err');
    return;
  }
  if (q('[data-retry]')) { retryLast(); return; }
  if ((el = q('[data-group-by]'))) {
    state.groupBy = el.dataset.groupBy;
    store.set('groupBy', state.groupBy);
    renderHistory(); renderRail(); if (chromeMode() === 'home') renderHome();
    return;
  }
  if ((el = q('[data-history-ws]'))) {
    $('#historySearch').value = el.dataset.historyWs;
    switchTab('history');
    return;
  }
  if ((el = q('[data-toggle-rail-folder]'))) {
    const ws = el.dataset.toggleRailFolder;
    if (state.collapsedRailWs.has(ws)) state.collapsedRailWs.delete(ws); else state.collapsedRailWs.add(ws);
    store.set('collapsedRailWs', [...state.collapsedRailWs]);
    renderRail();
    $('#railRecent').querySelectorAll('[data-toggle-rail-folder]').forEach((button) => {
      if (button.dataset.toggleRailFolder === ws) button.focus();
    });
    return;
  }
  if ((el = q('[data-expand-ws]'))) {
    const ws = el.dataset.expandWs;
    if (state.expandedWs.has(ws)) state.expandedWs.delete(ws); else state.expandedWs.add(ws);
    renderRail(); if (chromeMode() === 'home') renderHome();
    return;
  }
  if ((el = q('[data-browse-ws]'))) {
    browseMode = 'files';
    openWorkspaceSheet(el.dataset.browseWs);
    return;
  }
  if ((el = q('[data-fx-new]'))) { fxCreate(el.dataset.fxNew); return; }
  if ((el = q('[data-fx-menu]'))) { fxMenu(el.dataset.path, el.dataset.name, el.dataset.isDir === '1'); return; }
  if ((el = q('[data-fx-open]'))) { browseMode = 'files'; openWorkspaceSheet(el.dataset.fxOpen); return; }
  if ((el = q('[data-fx-edit]'))) { openFileEditor(el.dataset.fxEdit); return; }
  if ((el = q('[data-fx-rename]'))) { fxRename(el.dataset.fxRename, el.dataset.name); return; }
  if ((el = q('[data-fx-delete]'))) { fxDelete(el.dataset.fxDelete, el.dataset.name, el.dataset.isDir === '1'); return; }
  if ((el = q('[data-fx-copy-path]'))) { toast((await copyText(el.dataset.fxCopyPath)) ? 'Path copied' : 'Copy failed', 'ok'); return; }
  if (q('[data-fx-save]')) { fxSave(); return; }
  if ((el = q('[data-new-in-ws]'))) {
    setWorkspace(el.dataset.newInWs);
    if (state.tab !== 'chat' || chromeMode() !== 'home') newChat({ focus: false });
    $('#promptInput').focus();
    return;
  }
  if (q('[data-toggle-procs]')) { showAllProcs = !showAllProcs; renderProcesses(state.procs || []); return; }
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

// Keyboard activation for history and chat rows
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.sess, .chat-row')) { e.preventDefault(); openSession(e.target.dataset.open); }
});

// Keep the terminal's on-screen keyboard from stealing focus on key taps
$('#keybar').addEventListener('mousedown', (e) => e.preventDefault());

/* ════════════════════════════════════════════════════════════
   @-mention picker (MCP servers & connectors)
   ════════════════════════════════════════════════════════════ */

const CONNECTOR_MENTIONS = [
  { id: 'gmail', label: 'Gmail', kind: 'Connector', sub: 'Mail connector', ico: 'i-chat' },
  { id: 'm365', label: 'Outlook Email', kind: 'Connector', sub: 'Microsoft 365 mail', ico: 'i-chat' },
];
const mentionState = { open: false, items: [], idx: 0, start: -1 };

function mentionSources() {
  const mcp = (allMcpServers || []).map((m) => ({ id: m.name, label: m.name, kind: 'MCP', sub: m.command || m.url || m.type || 'MCP server', ico: 'i-link' }));
  return [...CONNECTOR_MENTIONS, ...mcp];
}

function findMentions(text) {
  const out = [];
  for (const m of mentionSources()) {
    const re = new RegExp(`(^|\\s)@${(m.label.replace(/\s+/g, '-')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s.,;:!?])`, 'i');
    if (re.test(text || '')) out.push(m);
  }
  return out;
}

function mentionHtml(text) {
  let html = esc(text);
  for (const m of mentionSources()) {
    const tok = esc('@' + m.label.replace(/\s+/g, '-'));
    const re = new RegExp(`(^|\\s)(${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[\\s.,;:!?])`, 'gi');
    html = html.replace(re, (_, pre, t) => `${pre}<span class="mention-pill ${m.kind === 'MCP' ? 'mcp' : 'conn'}">${t}</span>`);
  }
  return html;
}

function mentionQuery() {
  const t = $('#promptInput');
  const pos = t.selectionStart ?? t.value.length;
  const m = /(^|\s)@([\w.\-]*)$/.exec(t.value.slice(0, pos));
  return m ? { q: m[2].toLowerCase(), start: pos - m[2].length - 1 } : null;
}

function closeMention() {
  mentionState.open = false;
  const el = $('#mentionMenu');
  if (el) el.hidden = true;
}

async function updateMention() {
  const mq = mentionQuery();
  if (!mq) return closeMention();
  if (!allMcpServers.length && !mentionState.loaded) {
    mentionState.loaded = true;
    try { allMcpServers = (await api('/api/mcp')).servers || []; } catch {}
  }
  const norm = (x) => x.toLowerCase().replace(/[\s_]+/g, '-');
  const items = mentionSources().filter((m) => !mq.q || norm(m.label).includes(mq.q) || m.id.toLowerCase().includes(mq.q));
  if (!items.length) return closeMention();
  mentionState.items = items; mentionState.idx = 0; mentionState.start = mq.start; mentionState.open = true;
  renderMention();
}

function renderMention() {
  let el = $('#mentionMenu');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mentionMenu'; el.className = 'mention-menu'; el.setAttribute('role', 'listbox');
    $('#composer').prepend(el);
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      const row = e.target.closest('[data-mi]');
      if (row) pickMention(+row.dataset.mi);
    });
  }
  el.hidden = false;
  el.innerHTML = mentionState.items.map((m, i) => `
    <div class="mention-row${i === mentionState.idx ? ' on' : ''}" role="option" data-mi="${i}">
      <span class="mention-ico ${m.kind === 'MCP' ? 'mcp' : 'conn'}">${icon(m.ico)}</span>
      <span class="mention-main"><span class="mention-name">${esc(m.label)}</span><span class="mention-sub">${esc(m.sub)}</span></span>
      <span class="mention-kind">${m.kind === 'MCP' ? 'MCP' : 'Connector'}</span>
    </div>`).join('');
  fitMention();
  el.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}

// Home opens the picker downward: cap its height to the visible area above the keyboard
function fitMention() {
  const el = $('#mentionMenu');
  if (!el || el.hidden) return;
  if (!$('#view-chat')?.classList.contains('is-home')) { el.style.maxHeight = ''; return; }
  const vv = window.visualViewport;
  const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
  const top = el.getBoundingClientRect().top;
  el.style.maxHeight = Math.max(120, Math.min(300, bottom - top - 12)) + 'px';
}

function pickMention(i) {
  const m = mentionState.items[i];
  const t = $('#promptInput');
  if (!m) return;
  const pos = t.selectionStart ?? t.value.length;
  const tok = '@' + m.label.replace(/\s+/g, '-') + ' ';
  t.value = t.value.slice(0, mentionState.start) + tok + t.value.slice(pos);
  const caret = mentionState.start + tok.length;
  t.setSelectionRange(caret, caret);
  closeMention(); autosize(); store.set('draft', t.value); t.focus();
}

const input = $('#promptInput');
input.addEventListener('input', () => { autosize(); store.set('draft', input.value); updateMention(); });
// Keep the picker open when the keyboard is dismissed; close only on outside tap
document.addEventListener('pointerdown', (e) => {
  if (mentionState.open && !e.target.closest('#mentionMenu') && e.target !== input) closeMention();
});
if (window.visualViewport) {
  visualViewport.addEventListener('resize', () => mentionState.open && fitMention());
  visualViewport.addEventListener('scroll', () => mentionState.open && fitMention());
}
input.addEventListener('keydown', (e) => {
  if (mentionState.open) {
    const n = mentionState.items.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.idx = (mentionState.idx + 1) % n; return renderMention(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.idx = (mentionState.idx - 1 + n) % n; return renderMention(); }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickMention(mentionState.idx); }
    if (e.key === 'Escape') { e.preventDefault(); return closeMention(); }
  }
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

document.addEventListener('visibilitychange', () => {
  syncMonitorPolling();
  if (document.hidden) {
    // App backgrounded or screen locked: stop recording so hardware microphone is cleanly released
    if (vc.open) {
      if (vc.phase === 'listening') {
        vc.cancelled = true;
        vcStopListening();
        vcPhase('idle', 'Tap to talk');
      }
      if (vc.stream) {
        try { vc.stream.getTracks().forEach((t) => t.stop()); } catch {}
        vc.stream = null;
      }
    }
    if (voice.active) {
      cancelMic();
    }
  } else {
    // App foregrounded / unlocked: resume audio subsystem, sync messages, and ensure idle state
    unlockAudio();
    checkForUpdate();
    checkTunnel();
    syncCurrentSession();
    loadSessions(true);
    if (vc.open) {
      if (vc.phase === 'speaking' && ttsAudio.paused && !ttsAudio.ended && ttsAudio.src) {
        try { ttsAudio.play(); } catch {}
      } else if (vc.phase === 'listening') {
        vcPhase('idle', 'Tap to talk');
      }
      if (vc.ctx && vc.ctx.state === 'suspended') {
        try { vc.ctx.resume(); } catch {}
      }
    }
  }
});

window.addEventListener('pageshow', () => {
  unlockAudio();
  if (vc.open && vc.ctx && vc.ctx.state === 'suspended') {
    try { vc.ctx.resume(); } catch {}
  }
});

window.addEventListener('focus', () => {
  if (vc.open && vc.ctx && vc.ctx.state === 'suspended') {
    try { vc.ctx.resume(); } catch {}
  }
});
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
    // Don't auto-reload and disrupt the user's active session or open sheets.
    if (!updateNoted) {
      updateNoted = true;
      toast('Update available · Pull or refresh to update', 'ok');
    }
  } catch { /* offline */ }
}

/* ════════════════════════════════════════════════════════════
   Cross-device message sync — poll for new messages in the open conversation
   ════════════════════════════════════════════════════════════ */

let _syncKnownCount = 0;

async function syncCurrentSession() {
  if (state.streaming || !state.sessionId || document.hidden) return;
  try {
    const { count } = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/message-count`);
    if (count > _syncKnownCount) {
      _syncKnownCount = count;
      const data = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}`);
      const newMsgs = (data.messages || []).map((m) => ({
        role: m.role, content: m.content, agent: m.agent || data.agent,
        model: m.model || null, tokens: m.tokens != null ? m.tokens : null, ts: m.timestamp
      }));
      if (newMsgs.length > state.messages.length) {
        state.messages = newMsgs;
        threadEl().innerHTML = '';
        state.messages.forEach((m) => {
          if (m.role === 'user') addUserMessage(m.content, m.ts);
          else addAssistantMessage({ content: m.content, agent: AGENTS[m.agent] ? m.agent : 'antigravity', ts: m.ts, model: m.model, tokens: m.tokens });
        });
        scrollToBottom(true);
        const run = await api(`/api/runs/${encodeURIComponent(state.sessionId)}`).catch(() => ({ running: false }));
        if (run.running && !state.streaming) {
          const agentKey = AGENTS[run.agent] ? run.agent : state.agent;
          const el = addAssistantMessage({ agent: agentKey, streaming: true, model: run.model || null });
          scrollToBottom(true);
          drive(el, agentKey, (signal) => fetch(`/api/runs/${encodeURIComponent(state.sessionId)}/stream`, { signal }));
        }
      }
    }
  } catch { /* offline or session deleted */ }
}

function resetSyncCount() {
  _syncKnownCount = state.messages.length;
}

/* ════════════════════════════════════════════════════════════
   Boot
   ════════════════════════════════════════════════════════════ */

// iOS home-screen apps with a translucent status bar get a viewport that is short by the
// status-bar height, which leaves an empty band under the tab bar and the composer.
// Size the app to the physical screen there instead.
function fitStandaloneHeight() {
  const root = document.documentElement;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  if (!ios || !standalone || !portrait) { root.style.removeProperty('--app-h'); return; }
  const full = Math.max(screen.width, screen.height);
  const gap = full - window.innerHeight;
  if (gap >= 0 && gap < 80) root.style.setProperty('--app-h', `${full}px`);
  else root.style.removeProperty('--app-h');
}
fitStandaloneHeight();
window.addEventListener('resize', fitStandaloneHeight);
window.addEventListener('orientationchange', () => setTimeout(fitStandaloneHeight, 300));
window.addEventListener('pageshow', fitStandaloneHeight);

async function boot() {
  setInspectorOpen(store.get('inspectorOpen', true));
  applySize();
  applyAgent();
  syncVoiceLabel();
  applyWorkspace();
  updateHint();
  renderEmpty();
  switchTab('chat');
  initSwipeToDelete();

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
  checkGitChanges();
  updateLocationSub();
  syncBrowserLocation(false);
  setInterval(checkTunnel, 30000);
  setInterval(checkGitChanges, 10000);
  setInterval(() => { if (!document.hidden) syncBrowserLocation(false); }, 300000);
  window.addEventListener('focus', () => syncBrowserLocation(false));
  checkForUpdate();
  setInterval(checkForUpdate, 45000);
  setInterval(() => { if (!document.hidden && (state.running.size || state.tab === 'history')) loadSessions(true); }, 5000);
  setInterval(syncCurrentSession, 3000);

  // Start on the Chats home. A reload of the same tab (e.g. an auto-update) reopens the conversation it had open.
  const fresh = new URLSearchParams(location.search).has('new');
  const last = sessionStorage.getItem('ah.open');
  let resumed = false;
  if (!fresh && last && state.sessions.some((s) => s.id === last)) { await openSession(last); resumed = true; }
  if (!fresh && !resumed) {
    try {
      const { session_id: serverActive } = await api('/api/active-session');
      if (serverActive && state.sessions.some((s) => s.id === serverActive)) { await openSession(serverActive); resumed = true; }
    } catch { /* offline */ }
  }
  if (fresh) input.focus();
}

boot();
