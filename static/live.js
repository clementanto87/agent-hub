/* ════════════════════════════════════════════════════════════
   Live voice — native realtime conversation (Gemini Live)

   The microphone is streamed to the server as 16 kHz PCM and the model's spoken reply comes back
   as 24 kHz PCM, so there is no separate record → transcribe → think → synthesise pipeline: it
   answers a moment after you stop talking and you can talk over it. Tasks that need the computer are
   handed to the selected agent by the server ("let me check…"), and the agent's full reply lands in
   the chat. Loaded after app.js and shares its globals (vc, state, addUserMessage, …).

   Audio design (the parts that matter on a phone):
   • ONE AudioContext does capture and playback — iOS suspends a second context when the first plays.
   • Playback is a ring-buffer AudioWorklet with a jitter buffer: network bursts and gaps don't
     crackle, and "stop" flushes instantly.
   • Echo: a phone speaker leaks into the mic and the model would hear itself, interrupt itself and
     stop listening. While it is speaking the mic is held back (silence is sent instead); you can still
     talk over it — clearly louder than the echo for ~0.3 s — and the audio just before that is sent too.
     With headphones on, turn "🎧" on and the mic is never held back.
   • If the connection drops it reconnects by itself (the conversation continues from the saved history).
   ════════════════════════════════════════════════════════════ */

const live = {
  on: false, ws: null, ready: false, starting: null,
  ctx: null, capNode: null, capSrc: null, capMute: null, playNode: null, outDest: null, audioEl: null, workletReady: false,
  playing: false, drop: false, turnDone: true, working: 0, agentEl: null, agentRaf: 0, raf: 0, userSpoke: false, avail: null,
  echo: 0.02, loud: 0, ring: [], playChunks: 0, tailUntil: 0, prebuffer: 0.14, retries: 0, retryTimer: 0, lastReadyAt: 0,
};

const LIVE_WORKLET = `
class Cap extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.t = 0; this.sum = 0; this.cnt = 0; this.out = new Int16Array(1600); this.o = 0; }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x) return true;
    for (let i = 0; i < x.length; i++) {
      this.sum += x[i]; this.cnt++; this.t += 1;
      if (this.t >= this.ratio) {
        this.t -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.cnt)); this.sum = 0; this.cnt = 0;
        this.out[this.o++] = v < 0 ? v * 32768 : v * 32767;
        if (this.o === 1600) { this.port.postMessage(this.out.buffer, [this.out.buffer]); this.out = new Int16Array(1600); this.o = 0; }
      }
    }
    return true;
  }
}
registerProcessor('cap', Cap);

// Gapless player: 24 kHz PCM goes into a ring buffer, the audio thread resamples it to the device rate.
class Play extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bits = 18; this.ring = new Float32Array(1 << this.bits); this.mask = (1 << this.bits) - 1;
    this.w = 0; this.r = 0; this.step = 24000 / sampleRate; this.playing = false; this.pre = 0.14 * 24000;
    this.lvl = 0; this.lvlN = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.pcm) {
        const p = new Int16Array(m.pcm);
        for (let i = 0; i < p.length; i++) this.ring[(this.w + i) & this.mask] = p[i] / 32768;
        this.w += p.length;
        if (this.w - this.r > this.mask - 4800) this.r = this.w - (this.mask - 4800);
      } else if (m.clear) { this.r = this.w; this.setPlaying(false); }
      else if (m.pre !== undefined) this.pre = m.pre * 24000;
    };
  }
  setPlaying(v) { if (v !== this.playing) { this.playing = v; this.port.postMessage({ playing: v }); } }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.playing && this.w - this.r >= this.pre) this.setPlaying(true);
    let i = 0;
    if (this.playing) {
      for (; i < out.length; i++) {
        if (this.r + 1 >= this.w) { this.setPlaying(false); break; }          // ran dry
        const idx = Math.floor(this.r), f = this.r - idx;
        out[i] = this.ring[idx & this.mask] * (1 - f) + this.ring[(idx + 1) & this.mask] * f;
        this.r += this.step;
      }
    }
    let s = 0;
    for (let k = 0; k < i; k++) s += out[k] * out[k];
    for (; i < out.length; i++) out[i] = 0;
    this.lvl += s; this.lvlN += out.length;
    if (this.lvlN >= sampleRate * 0.1) { this.port.postMessage({ lvl: Math.sqrt(this.lvl / this.lvlN) }); this.lvl = 0; this.lvlN = 0; }
    return true;
  }
}
registerProcessor('play', Play);`;

async function liveAvailable() {
  if (live.avail !== null) return live.avail;
  try {
    const s = await fetch('/api/live/status').then((r) => r.json());
    live.avail = !!(s.enabled && window.AudioWorklet && window.WebSocket);
  } catch { live.avail = false; }
  return live.avail;
}

const liveEngine = () => (store.get('voiceEngine', 'live') === 'classic' ? 'classic' : 'live');
const liveHeadphones = () => !!store.get('liveHeadphones', false);
const LIVE_CLIENT = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));   // one live session per page, server-side

// Must run synchronously inside the tap that opens voice mode (iOS only unlocks audio then).
function liveUnlock() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!live.ctx || live.ctx.state === 'closed') {
      live.ctx = new AC({ latencyHint: 'interactive' });
      live.workletReady = false;
      live.ctx.onstatechange = () => { if (live.on && live.ctx && live.ctx.state !== 'running' && live.ctx.state !== 'closed') live.ctx.resume().catch(() => {}); };
    }
    live.ctx.resume().catch(() => {});
    if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
    // Without audioSession (older iOS) route playback through a media element so the silent switch doesn't mute it.
    if (!navigator.audioSession && !live.audioEl) {
      live.audioEl = new Audio();
      live.audioEl.setAttribute('playsinline', '');
    }
    if (live.audioEl) live.audioEl.play().catch(() => {});
  } catch { /* best effort */ }
}

function liveFoot() { return liveHeadphones() ? 'Headphones mode · talk over it any time · tap the orb to stop the reply' : 'Just talk · talk over it to interrupt · tap the orb to stop the reply'; }

// Only ever one connection: a second tap while "Connecting…" must not open another.
function liveStart() {
  if (live.on && live.ws) return Promise.resolve(true);
  if (live.starting) return live.starting;
  live.starting = liveStartInner().finally(() => { live.starting = null; });
  return live.starting;
}

async function liveStartInner() {
  liveStop();                                        // never leave an older socket or capture graph behind
  if (!(await liveAvailable())) return false;
  if (!(await vcEnsureStream())) return false;
  liveUnlock();
  const run = vc.run;
  if (!live.ctx) return false;
  try {
    if (!live.workletReady) {
      const url = URL.createObjectURL(new Blob([LIVE_WORKLET], { type: 'application/javascript' }));
      await live.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      live.workletReady = true;
    }
  } catch (e) { console.warn('worklet failed', e); return false; }

  live.on = true; live.ready = false; live.drop = false; live.turnDone = true; live.working = 0; live.userSpoke = false;
  live.playing = false; live.echo = 0.02; live.loud = 0; live.ring = []; live.tailUntil = 0;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live`);
  ws.binaryType = 'arraybuffer';
  live.ws = ws;
  vcPhase('thinking', live.retries ? 'Reconnecting…' : 'Connecting…');

  const ok = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    ws.onopen = () => {
      if (live.ws !== ws) { try { ws.close(); } catch {} return; }
      const agent = state.agent === 'bash' || state.agent === 'auto' ? (store.get('voiceAgent', 'claude')) : state.agent;
      ws.send(JSON.stringify({ type: 'start', agent, workspace: state.workspace, session_id: state.sessionId || null, client: LIVE_CLIENT, voice: store.get('liveVoice', '') || undefined }));
    };
    ws.onmessage = (e) => {
      if (live.ws !== ws) return;                    // a stale connection must never speak
      if (typeof e.data === 'string') {
        const d = JSON.parse(e.data);
        if (d.type === 'ready') { live.ready = true; done(true); }
        if (d.type === 'error') done(false);
        liveEvent(d, run);
      } else liveAudio(e.data);
    };
    ws.onerror = () => done(false);
    ws.onclose = () => { done(false); if (live.ws === ws) liveClosed(run); };
    setTimeout(() => done(false), 9000);
  });
  if (!ok || !vc.open || run !== vc.run) { liveStop(); return false; }

  try {
    // microphone → worklet → (echo gate) → websocket;  websocket → ring-buffer player → speaker
    live.capSrc = live.ctx.createMediaStreamSource(vc.stream);
    live.capNode = new AudioWorkletNode(live.ctx, 'cap');
    live.capNode.port.onmessage = (e) => liveMic(e.data);
    live.capMute = live.ctx.createGain(); live.capMute.gain.value = 0;
    live.capSrc.connect(live.capNode); live.capNode.connect(live.capMute); live.capMute.connect(live.ctx.destination);

    live.playNode = new AudioWorkletNode(live.ctx, 'play', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    live.playNode.port.onmessage = (e) => liveFromPlayer(e.data);
    live.playNode.port.postMessage({ pre: live.prebuffer });
    if (live.audioEl) {
      live.outDest = live.ctx.createMediaStreamDestination();
      live.playNode.connect(live.outDest);
      live.audioEl.srcObject = live.outDest.stream;
      live.audioEl.play().catch(() => {});
    } else live.playNode.connect(live.ctx.destination);

    const track = vc.stream.getAudioTracks()[0];
    if (track) { track.onmute = () => live.ctx && live.ctx.resume().catch(() => {}); track.onended = () => { if (live.on && vc.open) liveRestartSoon(); }; }
  } catch (e) { console.warn('audio graph failed', e); liveStop(); return false; }

  live.retries = 0; live.lastReadyAt = Date.now();
  vcPhase('listening');
  $('#voiceFoot').textContent = liveFoot();
  haptic(6);
  liveMeter(run);
  return true;
}

function liveStop() {
  if (!live.on && !live.ws && !live.capNode) return;
  live.on = false; live.ready = false;
  clearTimeout(live.retryTimer);
  cancelAnimationFrame(live.raf);
  const ws = live.ws; live.ws = null;                // detach first so its handlers go quiet
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop' })); } catch {}
  try { ws && ws.close(); } catch {}
  try { live.playNode && live.playNode.port.postMessage({ clear: true }); } catch {}
  try { live.capSrc && live.capSrc.disconnect(); live.capNode && live.capNode.disconnect(); live.capMute && live.capMute.disconnect(); live.playNode && live.playNode.disconnect(); } catch {}
  live.capSrc = live.capNode = live.capMute = live.playNode = live.outDest = null;
  live.playing = false;
  try { live.audioEl && live.audioEl.pause(); } catch {}
  if (live.agentEl) { live.agentEl.classList.remove('streaming'); live.agentEl = null; }
}

// Session dropped (network blip, Google hiccup, time limit): reconnect by ourselves.
function liveClosed(run) {
  if (!live.on) return;                              // we closed it ourselves
  live.on = false; live.ws = null; live.ready = false;
  liveRestartSoon(run);
}

function liveRestartSoon(run) {
  if (!vc.open || (run !== undefined && run !== vc.run)) return;
  const wasStable = Date.now() - live.lastReadyAt > 20000;      // it worked for a while: this is a fresh problem
  if (wasStable) live.retries = 0;
  if (live.retries >= 4) {
    live.retries = 0;
    toast('Live voice keeps disconnecting — tap the orb to retry', 'err');
    vcPhase('idle', 'Tap to reconnect');
    return;
  }
  live.retries++;
  vcPhase('thinking', 'Reconnecting…');
  clearTimeout(live.retryTimer);
  live.retryTimer = setTimeout(() => {
    if (!vc.open || live.on) return;
    liveStart().then((ok) => { if (!ok && vc.open && !live.on) liveRestartSoon(); });
  }, 500 * live.retries);
}

function liveSilence() {
  try { live.playNode && live.playNode.port.postMessage({ clear: true }); } catch {}
  live.playing = false;
}

function liveAudio(buf) {
  if (!live.on || live.drop || vc.muted || !live.playNode) return;
  live.turnDone = false;
  live.playNode.port.postMessage({ pcm: buf }, [buf]);
  if (vc.phase !== 'speaking') vcPhase('speaking');
}

function liveFromPlayer(m) {
  if (m.playing !== undefined) {
    const was = live.playing;
    live.playing = m.playing;
    if (m.playing) { live.playChunks = 0; }
    else {
      if (!live.drop) live.tailUntil = Date.now() + 400;      // the last echo is still arriving at the mic (not after you interrupted: you are talking)
      if (was && !live.turnDone && live.prebuffer < 0.4) {                      // ran dry mid-reply: buffer more next time
        live.prebuffer = Math.min(0.4, live.prebuffer + 0.08);
        try { live.playNode.port.postMessage({ pre: live.prebuffer }); } catch {}
      }
      liveIdleCheck();
    }
  }
}

// Back to "listening" (or "working") once everything the model said has finished playing.
function liveIdleCheck() {
  if (!live.on || live.playing || !live.turnDone) return;
  vcPhase(live.working ? 'thinking' : 'listening', live.working ? 'Working on it…' : undefined);
  if (!live.working) $('#voiceFoot').textContent = liveFoot();
}

// Mic frames (100 ms of 16 kHz PCM). While the model is speaking they are replaced with silence so it
// can't hear itself — unless you clearly talk over it.
function liveMic(buf) {
  const ws = live.ws;
  if (!ws || ws.readyState !== 1 || !live.ready) return;
  const gated = !liveHeadphones() && (live.playing || Date.now() < live.tailUntil);
  if (!gated) { live.loud = 0; live.ring.length = 0; ws.send(buf); return; }

  const pcm = new Int16Array(buf);
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / pcm.length) / 32768;
  live.ring.push(buf); if (live.ring.length > 6) live.ring.shift();
  live.playChunks++;
  if (live.playChunks <= 6) live.echo = Math.max(live.echo * 0.97, rms);       // the first moments of a reply: all echo
  const thr = Math.max(0.05, live.echo * 2.2);
  if (rms > thr) {
    if (++live.loud >= 3) {                                                    // ~0.3 s clearly louder than the echo
      live.loud = 0;
      liveBargeIn();
      return;
    }
  } else { live.loud = 0; live.echo = live.echo * 0.92 + rms * 0.08; }
  ws.send(new Int16Array(pcm.length).buffer);                                   // silence
}

function liveBargeIn() {
  const ws = live.ws;
  liveSilence();
  live.drop = true;                                  // ignore what the model was still saying until it notices
  live.tailUntil = 0;
  vcPhase('listening');
  haptic(8);
  if (ws && ws.readyState === 1) { live.ring.forEach((b) => ws.send(b)); }      // the start of what you said
  live.ring = [];
}

function liveMeter(run) {
  const buf = vc.analyser ? new Uint8Array(vc.analyser.fftSize) : null;
  const tick = () => {
    if (!live.on || !vc.open || run !== vc.run) return;
    if (buf && vc.phase === 'listening') {
      vc.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      $('#orb').style.setProperty('--lvl', Math.min(1, Math.sqrt(sum / buf.length) * 10).toFixed(2));
    }
    live.raf = requestAnimationFrame(tick);
  };
  live.raf = requestAnimationFrame(tick);
}

function liveEvent(d, run) {
  if (!vc.open || run !== vc.run) return;
  switch (d.type) {
    case 'in':
      $('#voiceYou').textContent = (d.text || '').trim();
      if (!live.userSpoke) $('#voiceReply').textContent = '';      // a new turn starts: clear the last reply
      live.userSpoke = true;
      live.drop = false;                                          // you are talking: whatever comes next is the new answer
      break;
    case 'user': {
      live.userSpoke = false; live.drop = false;
      if (d.session_id && !state.sessionId) { state.sessionId = d.session_id; store.set('session', d.session_id); sessionStorage.setItem('ah.open', d.session_id); }
      if (!state.messages.length) threadEl().innerHTML = '';
      const now = Date.now() / 1000;
      state.messages.push({ role: 'user', content: d.text, agent: state.agent, ts: now, tokens: Math.max(1, Math.round(d.text.length / 3.8)) });
      addUserMessage(d.text, now);
      if (!state.title) { state.title = d.text.slice(0, 40); }
      updateTitle(); scrollToBottom(true); loadSessions(true);
      $('#voiceYou').textContent = d.text;
      if (vc.phase === 'listening') vcPhase('thinking', 'Thinking…');
      break;
    }
    case 'out':
      $('#voiceReply').textContent = d.text;
      break;
    case 'assistant': {
      const now = Date.now() / 1000;
      state.messages.push({ role: 'assistant', content: d.text, agent: state.agent, ts: now, model: d.model });
      addAssistantMessage({ content: d.text, agent: state.agent, ts: now, model: d.model });
      scrollToBottom();
      break;
    }
    case 'agent_start':
      live.working++;
      live.agentEl = addAssistantMessage({ agent: state.agent, streaming: true, model: currentModel(state.agent) });
      live.agentEl._raw = '';
      scrollToBottom(true);
      if (!live.playing) vcPhase('thinking', 'Working on it…');
      break;
    case 'agent_text':
      if (live.agentEl) {
        live.agentEl._raw = d.text;
        if (!live.agentRaf) live.agentRaf = requestAnimationFrame(() => { live.agentRaf = 0; if (live.agentEl) { renderBody(live.agentEl); scrollToBottom(); } });
      }
      break;
    case 'agent_done': {
      live.working = Math.max(0, live.working - 1);
      const el = live.agentEl; live.agentEl = null;
      if (el) {
        el._raw = d.text;
        el.classList.remove('streaming');
        $('.status-pill', el)?.remove();
        $('.msg-time', el).textContent = clock(Date.now() / 1000);
        renderBody(el, true);
        finishActions(el, d.ok ? '' : 'The agent reported a problem');
        state.messages.push({ role: 'assistant', content: d.text, agent: state.agent, ts: Date.now() / 1000, model: el._model });
        scrollToBottom();
        loadSessions(true); checkGitChanges();
      }
      break;
    }
    case 'interrupted':
      liveSilence(); live.drop = false; live.turnDone = true;
      vcPhase(live.working ? 'thinking' : 'listening', live.working ? 'Working on it…' : undefined);
      break;
    case 'turn_complete':
      live.turnDone = true; live.drop = false;
      liveIdleCheck();
      break;
    case 'notice': toast(d.text); break;
    case 'error': toast(d.text || 'Live voice error', 'err'); break;
    case 'ended': break;                                         // the socket closes next: liveClosed() reconnects
  }
}

// Orb: stop the reply that is playing, or send what you've said right now.
function liveOrbTap() {
  haptic(10);
  if (live.starting) return;                         // still connecting: one session only
  if (!live.on) {
    live.retries = 0;
    vcPhase('thinking', 'Connecting…');
    liveStart().then((ok) => { if (!ok) liveFallback(); });
    return;
  }
  if (vc.phase === 'speaking' || live.playing) { live.drop = true; liveSilence(); live.turnDone = true; liveIdleCheck(); live.tailUntil = 0; }
  else if (vc.phase === 'listening' && live.ws && live.ws.readyState === 1) live.ws.send(JSON.stringify({ type: 'audio_end' }));
}

// Live voice isn't reachable (no key, offline, unsupported browser): use the standard voice loop.
function liveFallback() {
  toast('Live voice unavailable — using standard voice');
  store.set('voiceEngine', 'classic');
  voiceEngineSync();
  if (vc.open) vcListen();
}

function voiceEngineSync() {
  const eng = liveEngine();
  $$('#voiceEngine [data-engine]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.engine === eng)));
  const hp = $('#voiceEngine [data-action=voice-headphones]');
  if (hp) { hp.hidden = eng !== 'live'; hp.setAttribute('aria-pressed', String(liveHeadphones())); }
  const pick = $('[data-action=open-voice-picker]');
  if (pick) pick.hidden = eng === 'live';       // the classic voice picker doesn't apply to Live voices
}

function voiceHeadphonesToggle() {
  store.set('liveHeadphones', !liveHeadphones());
  voiceEngineSync();
  toast(liveHeadphones() ? 'Headphones mode: you can talk over it freely' : 'Speaker mode: the mic is held back while it speaks (talk clearly to interrupt)');
  if (live.on) $('#voiceFoot').textContent = liveFoot();
}

async function voiceEngineSet(eng) {
  if (liveEngine() === eng) return;
  store.set('voiceEngine', eng);
  voiceEngineSync();
  if (!vc.open) return;
  if (eng === 'live') {
    vcSpeechCancel(); stopSpeaking();
    if (vc.recorder && vc.recorder.state !== 'inactive') { vc.cancelled = true; try { vc.recorder.stop(); } catch {} }
    cancelAnimationFrame(vc.raf);
    liveUnlock();
    live.retries = 0;
    if (!(await liveStart())) liveFallback();
  } else {
    liveStop();
    vcPhase('idle');
    vcListen();
  }
}
