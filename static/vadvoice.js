/* ════════════════════════════════════════════════════════════
   Standard voice, upgraded: a real voice-activity model (Silero, self-hosted in /static/vad)

   Replaces the volume-threshold detector. It decides you've finished speaking in ~0.45 s without
   cutting you off mid-sentence, hands back exactly the audio of what you said (16 kHz, with a short
   lead-in so the first word isn't clipped), and keeps listening while the reply is spoken so you can
   simply talk over it. If the model can't load (old browser, no WASM), voice mode keeps using the
   simple detector in app.js. Loaded after app.js and shares its globals (vc, state, …).
   ════════════════════════════════════════════════════════════ */

const vadv = { inst: null, loading: null, failed: false, ring: [], seg: [], inSpeech: false, idleTimer: 0 };

const VAD_LISTEN = { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, redemptionMs: 600, minSpeechMs: 200 };
// While a reply is playing the speaker can leak into the mic: demand clearly louder, longer speech before treating it as you.
const VAD_SPEAKING = { positiveSpeechThreshold: 0.82, negativeSpeechThreshold: 0.55, redemptionMs: 600, minSpeechMs: 450 };

function vadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

const vadReady = () => !!(vadv.inst && !vadv.failed);

async function vadLoad() {
  if (vadv.inst) return vadv.inst;
  if (vadv.failed || !window.AudioWorklet || !window.WebAssembly) return null;
  if (vadv.loading) return vadv.loading;
  vadv.loading = (async () => {
    try {
      if (!window.ort) await vadScript('/static/vad/ort.wasm.min.js');
      if (!window.vad) await vadScript('/static/vad/bundle.min.js');
      window.ort.env.wasm.wasmPaths = '/static/vad/';
      window.ort.env.wasm.numThreads = 1;
      const inst = await window.vad.MicVAD.new({
        model: 'v5',
        baseAssetPath: '/static/vad/',
        onnxWASMBasePath: '/static/vad/',
        startOnLoad: false,
        submitUserSpeechOnPause: true,                 // tapping the orb while you talk sends what you've said
        preSpeechPadMs: 320,
        ...VAD_LISTEN,
        getStream: async () => vc.stream,
        pauseStream: async () => {},
        resumeStream: async () => vc.stream,
        onSpeechStart: vadSpeechStart,
        onSpeechRealStart: vadSpeechRealStart,
        onSpeechEnd: vadSpeechEnd,
        onVADMisfire: () => { vadv.inSpeech = false; vadv.seg = []; sttCancel(); if (vc.phase === 'listening') vc.heard = false; },
        onFrameProcessed: vadFrame,
      });
      vadv.inst = inst; vadv.stream = vc.stream;
      return inst;
    } catch (e) {
      console.warn('Voice-activity model unavailable, using the simple detector:', e);
      vadv.failed = true;
      return null;
    } finally { vadv.loading = null; }
  })();
  return vadv.loading;
}

async function vadDestroy() {
  clearTimeout(vadv.idleTimer);
  const inst = vadv.inst; vadv.inst = null;
  if (inst) { try { await inst.destroy(); } catch { /* already gone */ } }
}

function vadFrame(probs, frame) {
  if (vc.phase === 'listening') $('#orb').style.setProperty('--lvl', Math.min(1, probs.isSpeech * 1.2).toFixed(2));
  if (!frame) return;
  const copy = new Float32Array(frame);
  if (vadv.inSpeech) { vadv.seg.push(copy); sttFeed(copy); }
  else { vadv.ring.push(copy); if (vadv.ring.length > 12) vadv.ring.shift(); }   // ~0.4 s of lead-in before speech is detected
}

function vadSpeechStart() {
  if (!vc.open) return;
  vadv.inSpeech = true;
  vadv.seg = vadv.ring.slice(); vadv.ring = [];
  if (vc.phase === 'listening') {
    vc.heard = true; vc.lastVoice = performance.now(); clearTimeout(vadv.idleTimer);
    sttOpen(vadv.seg);                                  // start transcribing while you are still talking
  }
}

// Clearly you, mid-reply: stop talking and listen. (Fires only after the speech passed the "not a cough" check.)
function vadSpeechRealStart() {
  if (!vc.open || !store.get('voiceBargeIn', true)) return;
  // Mid-reply, or still finishing your sentence just after sending (a long task already running is left alone).
  const quick = vc.phase === 'thinking' && vc.thinkStart && Date.now() - vc.thinkStart < 3500;
  if (vc.phase !== 'speaking' && !quick) return;
  vc.run++;                                           // abandon this turn's playback loop and handler
  vcSpeechCancel();
  if (state.streaming) stopStreaming();
  stopSpeaking();
  vc.heard = true; vc.cancelled = false; vc.thinkStart = 0;
  vcPhase('listening');
  haptic(8);
  vadv.inst && vadv.inst.setOptions(VAD_LISTEN);
  sttOpen(vadv.seg);                                   // everything since you started talking
}

function vadSpeechEnd(audio) {
  vadv.inSpeech = false; vadv.seg = [];
  if (!vc.open || vc.phase !== 'listening' || !audio || audio.length < 4000) { sttCancel(); return; }   // < 0.25 s: not an utterance
  vc.heard = false;
  vcHandleAudio(vc.run, floatToWav(audio, 16000), sttEnd());
}

// Called by vcListen() instead of starting the MediaRecorder + volume meter.
async function vadListen() {
  const inst = vadv.inst;
  if (!inst) return false;
  vc.cancelled = false; vc.heard = false;
  vcPhase('listening');
  haptic(6);
  inst.setOptions(VAD_LISTEN);
  try { await inst.start(); } catch (e) { console.warn('VAD start failed', e); return false; }
  clearTimeout(vadv.idleTimer);
  // Nobody speaks for a while: stop listening instead of holding the mic forever.
  vadv.idleTimer = setTimeout(() => {
    if (vc.open && vc.phase === 'listening' && !vc.heard) vcPhase('idle', 'Tap to talk');
  }, 30000);
  return true;
}

// Orb tapped while listening: send what's been said so far.
function vadSendNow() {
  if (!vadv.inst || !vc.heard) return false;
  vadv.inst.pause().then(() => vadv.inst && vadv.inst.start()).catch(() => {});
  return true;
}

function vadSpeakingMode(on) {
  if (vadv.inst) vadv.inst.setOptions(on ? VAD_SPEAKING : VAD_LISTEN);
}

function floatToWav(f32, rate) {
  const n = f32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) { const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}


/* ── Streaming transcription (/ws/stt) ───────────────────────
   While you speak, 16 kHz PCM is streamed to the server, which transcribes it live. When the voice
   model says you're done, sttEnd() returns a promise of the finished text (~0.3 s). If anything goes
   wrong it resolves null and the caller uploads the recorded audio the normal way. */

const stt = { cur: null };

function sttOpen(preroll) {
  sttCancel();
  if (!store.get('sttStream', true) || !window.WebSocket) return;
  const s = { ws: null, ready: false, queue: [], pending: [], pendingLen: 0, resolve: null, done: false };
  s.promise = new Promise((r) => { s.resolve = (v) => { if (!s.done) { s.done = true; r(v); } }; });
  try {
    s.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/stt`);
  } catch { return; }
  s.ws.binaryType = 'arraybuffer';
  s.ws.onmessage = (e) => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (d.type === 'ready') { s.ready = true; s.queue.forEach((b) => s.ws.send(b)); s.queue = []; }
    else if (d.type === 'final') s.resolve((d.text || '').trim() || null);
    else if (d.type === 'error') s.resolve(null);
  };
  s.ws.onerror = () => s.resolve(null);
  s.ws.onclose = () => s.resolve(null);
  stt.cur = s;
  (preroll || []).forEach((f) => sttFeed(f));
}

function sttFeed(frame) {
  const s = stt.cur;
  if (!s || s.done) return;
  s.pending.push(frame); s.pendingLen += frame.length;
  if (s.pendingLen >= 1600) sttFlush(s);                // ~100 ms per message
}

function sttFlush(s) {
  if (!s.pendingLen) return;
  const out = new Int16Array(s.pendingLen);
  let o = 0;
  for (const f of s.pending) for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); out[o++] = v < 0 ? v * 32768 : v * 32767; }
  s.pending = []; s.pendingLen = 0;
  if (s.ready && s.ws.readyState === 1) s.ws.send(out.buffer); else s.queue.push(out.buffer);
}

function sttEnd() {
  const s = stt.cur; stt.cur = null;
  if (!s) return null;
  sttFlush(s);
  const finish = () => { try { s.ws.send(JSON.stringify({ type: 'end' })); } catch { s.resolve(null); } };
  if (s.ready && s.ws.readyState === 1) finish();
  else { const t0 = Date.now(); const wait = setInterval(() => { if (s.ready) { clearInterval(wait); finish(); } else if (s.done || Date.now() - t0 > 2500) { clearInterval(wait); s.resolve(null); } }, 40); }
  setTimeout(() => { s.resolve(null); try { s.ws.close(); } catch {} }, 5000);
  return s.promise;
}

function sttCancel() {
  const s = stt.cur; stt.cur = null;
  if (!s) return;
  s.resolve(null);
  try { s.ws.readyState === 1 && s.ws.send(JSON.stringify({ type: 'cancel' })); s.ws.close(); } catch {}
}
