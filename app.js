// app.js — หน้าจอ กล้อง การตรวจจับท่า และการบันทึก
import { CONFIG, measure, RepCounter } from './counter.js';
import * as store from './store.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const params = new URLSearchParams(location.search);
const SIM = ['pushup', 'squat'].includes(params.get('sim')) ? params.get('sim') : null;
const SIM_SPEED = Math.min(8, Math.max(0.5, Number(params.get('speed')) || 1));
const COUNTDOWN_SEC = SIM ? 2 : 5;

// ไลบรารีตรวจท่าของ Google MediaPipe โหลดจาก CDN ครั้งแรก แล้ว service worker แคชไว้ใช้ออฟไลน์
const MP_VERSION = '0.10.21';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODELS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};

const TEXT = {
  pushup: {
    label: 'วิดพื้น', joint: 'มุมศอก',
    tip: '<b>วางมือถือบนพื้นด้านข้างลำตัว</b> ห่างราว 1.5–2 เมตร ให้เห็นตัวตะแคงตั้งแต่ไหล่ ศอก ข้อมือ ถึงข้อเท้า แล้วกด "เริ่ม" จะมีเวลาตั้งท่า 5 วินาที',
    partial: 'ลงไม่ลึกพอ — งอศอกให้ถึงราว 90°',
    lostHint: 'เห็นไม่ครบ — ให้เห็นไหล่ ศอก ข้อมือ',
    waiting: 'ยืดแขนให้ตรงก่อนเริ่ม',
  },
  squat: {
    label: 'สควอต', joint: 'มุมเข่า',
    tip: '<b>วางมือถือระดับเอว</b> ห่างราว 2 เมตร หันตัวตะแคงข้างให้กล้อง ให้เห็นสะโพก เข่า ข้อเท้า แล้วกด "เริ่ม" จะมีเวลาตั้งท่า 5 วินาที',
    partial: 'ย่อไม่ลึกพอ — ให้ต้นขาขนานพื้น',
    lostHint: 'เห็นไม่ครบ — ให้เห็นสะโพก เข่า ข้อเท้า',
    waiting: 'ยืนตรงก่อนเริ่ม',
  },
};
const ISSUE = {
  hip_sag: { long: 'สะโพกตก — เกร็งท้องและยกสะโพกขึ้น', short: 'สะโพกตก' },
  hip_pike: { long: 'สะโพกสูงเกินไป — ลดสะโพกให้ลำตัวเป็นเส้นตรง', short: 'สะโพกสูง' },
  lean: { long: 'ตัวโน้มไปข้างหน้ามาก — ยกอกขึ้น', short: 'ตัวโน้มหน้า' },
};
const PHASE_LABEL = { waiting: 'ตั้งท่า', up: 'ท่าบน', bottom: 'ท่าล่าง', moving: 'กำลังเคลื่อน', lost: 'ไม่เห็นตัว' };

// ---------- สถานะ ----------
const settings0 = store.init().settings;
const S = {
  tab: 'train',
  kind: settings0.kind === 'squat' ? 'squat' : 'pushup',
  cam: 'off',          // off | starting | on
  model: 'none',       // none | loading | ready | error
  phase: 'idle',       // idle | ready | countdown | active
  counter: null,
  aspect: 0.75,
  mirror: false,
  dpr: 1,
  lastLms: null,
  lastM: { ok: false },
  prevAngle: null,
  flash: null,
  flashUntil: 0,
  flashTone: '',
  err: '',
  sessionTs: 0,
  sessionStart: 0,
  pending: null,
};
S.counter = new RepCounter(S.kind);

const video = $('#video');
const canvas = $('#overlay');
const ctx = canvas.getContext('2d');
const stage = $('#stage');

let stream = null;
let landmarker = null;
let landmarkerKey = '';
let delegateUsed = '';
let looping = false;
let lastDet = 0;
let lastTs = 0;
let simT0 = 0;
let cdTimer = null;
let clockTimer = null;
let toastTimer = null;

const settings = () => store.get().settings;

// ---------- ตัวช่วย ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const fmtTime = (sec) => {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
};
const pad2 = (n) => String(n).padStart(2, '0');

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- เสียง / หน้าจอ ----------
let actx = null;
function audio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
  } catch { /* ไม่มีเสียงก็ใช้งานต่อได้ */ }
  return actx;
}
function beep(freq = 880, ms = 90, vol = 0.2) {
  if (settings().sound === 'off') return;
  const c = audio();
  if (!c) return;
  try {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    o.connect(g);
    g.connect(c.destination);
    const t = c.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.start(t);
    o.stop(t + ms / 1000 + 0.03);
  } catch { /* ignore */ }
}
function say(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'th-TH';
    u.rate = 1.1;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* ignore */ }
}
function soundRep(n, clean) {
  const m = settings().sound;
  if (m === 'beep') beep(clean ? 880 : 520, 110);
  else if (m === 'voice') say(String(n));
}

let wake = null;
async function lockScreen() {
  try {
    if ('wakeLock' in navigator && !wake) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    }
  } catch { /* ignore */ }
}
function unlockScreen() {
  try { if (wake) wake.release(); } catch { /* ignore */ }
  wake = null;
}

// ---------- แท็บ ----------
function showTab(name) {
  S.tab = name;
  for (const b of $$('.tabbar button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const v of $$('.view')) v.hidden = v.id !== 'view-' + name;
  $('#main').scrollTop = 0;
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
}
for (const b of $$('.tabbar button')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------- เลือกท่า ----------
function setKind(kind) {
  if (S.phase === 'countdown' || S.phase === 'active') return;
  S.kind = kind;
  S.counter = new RepCounter(kind);
  S.prevAngle = null;
  store.updateSettings({ kind });
  $('#repNum').textContent = '0';
  syncUI();
}
for (const b of $$('#kindSeg button')) b.addEventListener('click', () => setKind(b.dataset.kind));

// ---------- กล้อง ----------
function camErrorMsg(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return 'ไม่ได้รับอนุญาตให้ใช้กล้อง ไปที่ การตั้งค่า > Safari > กล้อง เลือก "ถาม" หรือ "อนุญาต" แล้วรีเฟรชหน้านี้';
  }
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'ไม่พบกล้องที่เลือก ลองสลับกล้องหน้า/หลังในตั้งค่า';
  if (n === 'NotReadableError') return 'กล้องถูกแอปอื่นใช้อยู่ ปิดแอปนั้นแล้วลองใหม่';
  return 'เปิดกล้องไม่สำเร็จ: ' + ((e && e.message) || e);
}

function setAspect(a) {
  if (!a || !isFinite(a)) return;
  S.aspect = a;
  stage.style.setProperty('--ar', a.toFixed(4));
}

function resizeCanvas() {
  S.dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(stage.clientWidth * S.dpr));
  canvas.height = Math.max(1, Math.round(stage.clientHeight * S.dpr));
}
new ResizeObserver(resizeCanvas).observe(stage);

video.addEventListener('resize', () => {
  if (S.cam === 'on' && !SIM && video.videoWidth) setAspect(video.videoWidth / video.videoHeight);
});

async function ensureModel() {
  if (SIM) { S.model = 'ready'; return; }
  const key = settings().quality;
  if (landmarker && landmarkerKey === key) { S.model = 'ready'; return; }
  S.model = 'loading';
  syncUI();
  try {
    if (landmarker) { try { landmarker.close(); } catch { /* ignore */ } landmarker = null; }
    const mod = await import(`${MP_BASE}/vision_bundle.mjs`);
    const fileset = await mod.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const make = (delegate) => mod.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS[key], delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      landmarker = await make('GPU');
      delegateUsed = 'GPU';
    } catch (e) {
      console.warn('GPU delegate ใช้ไม่ได้ สลับเป็น CPU', e);
      landmarker = await make('CPU');
      delegateUsed = 'CPU';
    }
    landmarkerKey = key;
    S.model = 'ready';
  } catch (e) {
    console.error(e);
    S.model = 'error';
    throw e;
  }
}

async function rebuildOnCpu() {
  try {
    const mod = await import(`${MP_BASE}/vision_bundle.mjs`);
    const fileset = await mod.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    try { landmarker.close(); } catch { /* ignore */ }
    landmarker = await mod.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS[landmarkerKey || 'lite'], delegate: 'CPU' },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    delegateUsed = 'CPU';
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

async function openCamera() {
  if (S.cam !== 'off') return;
  S.err = '';
  if (!SIM && (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) {
    S.err = 'insecure';
    syncUI();
    return;
  }
  S.cam = 'starting';
  syncUI();
  try {
    S.mirror = settings().facing === 'user';
    if (SIM) {
      simT0 = performance.now();
      setAspect(SIM === 'pushup' ? 4 / 3 : 3 / 4);
      S.mirror = false;
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: settings().facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
      });
      video.srcObject = stream;
      await video.play();
      if (!video.videoWidth) {
        await new Promise((res) => video.addEventListener('loadedmetadata', res, { once: true }));
      }
      setAspect(video.videoWidth / video.videoHeight);
    }
    S.cam = 'on';
    stage.classList.toggle('mirror', S.mirror);
    stage.classList.toggle('sim', !!SIM);
    resizeCanvas();
    syncUI();
    lockScreen();
    await ensureModel();
    S.phase = 'ready';
    S.prevAngle = null;
    startLoop();
    syncUI();
  } catch (e) {
    console.error(e);
    const modelFail = S.model === 'error';
    closeCamera();
    S.err = modelFail
      ? 'โหลดโมเดลตรวจท่าไม่ได้ ต้องต่ออินเทอร์เน็ตในการเปิดครั้งแรก ตรวจสัญญาณแล้วลองใหม่'
      : camErrorMsg(e);
    syncUI();
  }
}

function closeCamera() {
  looping = false;
  clearInterval(cdTimer);
  clearInterval(clockTimer);
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  video.srcObject = null;
  S.cam = 'off';
  S.phase = 'idle';
  S.lastLms = null;
  S.lastM = { ok: false };
  S.flash = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  unlockScreen();
  syncUI();
}

$('#btnOff').addEventListener('click', () => { if (S.phase === 'ready') { S.err = ''; closeCamera(); } });
$('#btnFlip').addEventListener('click', async () => {
  if (S.phase !== 'ready') return;
  const next = settings().facing === 'user' ? 'environment' : 'user';
  store.updateSettings({ facing: next });
  closeCamera();
  await openCamera();
});

// ---------- วงรอบตรวจจับ ----------
function startLoop() {
  if (looping) return;
  looping = true;
  schedule();
}
function schedule() {
  if (!looping) return;
  if (!SIM && 'requestVideoFrameCallback' in video) video.requestVideoFrameCallback(frame);
  else requestAnimationFrame(frame);
}
function frame() {
  if (!looping) return;
  const now = performance.now();
  if (now - lastDet >= 30) {
    lastDet = now;
    try { process(now); } catch (e) { console.error(e); }
  }
  schedule();
}

function process(now) {
  let lms = null;
  if (SIM) {
    lms = simModule.simPose(SIM, ((now - simT0) / 1000) * SIM_SPEED, S.aspect, { sag: SIM === 'pushup' }).lms;
  } else if (landmarker && video.readyState >= 2) {
    const ts = Math.max(now, lastTs + 1);
    lastTs = ts;
    try {
      const res = landmarker.detectForVideo(video, ts);
      lms = (res.landmarks && res.landmarks[0]) || null;
    } catch (e) {
      console.warn('detect error', e);
      if (delegateUsed === 'GPU') {
        looping = false;
        rebuildOnCpu().then((ok) => { if (ok && S.cam === 'on') { looping = false; startLoop(); } else if (!ok) { closeCamera(); S.err = 'ตรวจจับท่าไม่ได้บนเครื่องนี้'; syncUI(); } });
        return;
      }
    }
  }
  onPose(lms, now);
}

let simModule = null;

function onPose(lms, now) {
  const m = lms ? measure(S.kind, lms, S.aspect) : { ok: false, reason: 'missing' };
  S.lastLms = lms;
  S.lastM = m;
  let snap = null;
  if (S.phase === 'active') {
    snap = S.counter.update(now, m);
    if (snap.event) onEvent(snap.event, now);
  } else if (m.ok) {
    S.prevAngle = S.prevAngle == null ? m.angle : S.prevAngle + (m.angle - S.prevAngle) * 0.35;
  } else {
    S.prevAngle = null;
  }
  updateHud(snap, now);
  draw(lms, m, snap);
}

function onEvent(ev, now) {
  if (ev.type === 'rep') {
    const n = $('#repNum');
    n.textContent = String(ev.n);
    n.classList.remove('pop');
    void n.offsetWidth;
    n.classList.add('pop');
    $('#rdClean').textContent = String(S.counter.clean);
    soundRep(ev.n, ev.clean);
    const issue = ev.issues.length ? ' · ' + ISSUE[ev.issues[0]].short : '';
    flash(`ครั้งที่ ${ev.n}${issue}`, ev.clean ? 'good' : 'warn', now, 1300);
  } else if (ev.type === 'partial') {
    beep(300, 160, 0.18);
    flash(TEXT[S.kind].partial, 'warn', now, 2300);
  }
}

function flash(text, tone, now, ms) {
  S.flash = { text, tone, until: now + ms };
  S.flashUntil = now + 450;
  S.flashTone = tone;
}

// ---------- HUD ----------
const hudCache = {};
function setText(key, el, value) {
  if (hudCache[key] !== value) {
    hudCache[key] = value;
    el.textContent = value;
  }
}

function computeCue(now) {
  const kind = S.kind, m = S.lastM;
  if (S.flash && now < S.flash.until) return S.flash;
  if (!S.lastLms) return { text: 'ไม่พบคนในภาพ — ถอยให้เห็นทั้งตัว', tone: 'bad' };
  if (!m.ok) {
    if (m.reason === 'orient') return { text: 'วางมือถือด้านข้าง ให้เห็นลำตัวตะแคงขนานพื้น', tone: 'warn' };
    return { text: TEXT[kind].lostHint, tone: 'warn' };
  }
  if (kind === 'squat' && m.view === 'front') return { text: 'หันตัวตะแคงข้างให้กล้อง เพื่อวัดมุมเข่าได้ถูกต้อง', tone: 'warn' };
  if (m.form && m.form.length) return { text: ISSUE[m.form[0]].long, tone: 'bad' };
  if (S.phase === 'ready') return { text: 'พร้อมแล้ว — กด "เริ่ม" ได้เลย', tone: 'good' };
  if (S.phase === 'active' && S.counter.state === 'waiting') return { text: TEXT[kind].waiting, tone: 'info' };
  return { text: '', tone: '' };
}

function updateHud(snap, now) {
  if (S.cam !== 'on') return;
  const cue = S.model === 'loading' ? { text: 'กำลังโหลดโมเดลตรวจท่า (ครั้งแรกราว 10 MB)', tone: 'info' } : computeCue(now);
  const cueEl = $('#cue');
  const ck = cue.text + '|' + cue.tone;
  if (hudCache.cue !== ck) {
    hudCache.cue = ck;
    cueEl.textContent = cue.text;
    cueEl.dataset.tone = cue.tone;
  }
  const angle = S.phase === 'active' && snap && snap.angle != null ? snap.angle : S.prevAngle;
  setText('angle', $('#rdAngle'), angle != null && S.lastM.ok ? Math.round(angle) + '°' : '–');
  const phase = S.phase === 'active' && snap ? snap.phase : '';
  const pill = $('#hudPhase');
  if (S.phase === 'active') {
    pill.hidden = false;
    setText('phase', pill, PHASE_LABEL[phase] || '');
    pill.dataset.phase = phase;
  } else {
    pill.hidden = true;
  }
}

function tickClock() {
  if (S.phase !== 'active') return;
  setText('time', $('#rdTime'), fmtTime((Date.now() - S.sessionStart) / 1000));
}

// ---------- วาดโครงกระดูก ----------
const CONN = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [27, 29], [28, 30], [29, 31], [30, 32]];
const JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const C_ACC = '#ffb21f', C_GOOD = '#4fd18b', C_BAD = '#ff6e5f';

function draw(lms, m, snap) {
  const W = canvas.width, H = canvas.height, d = S.dpr;
  ctx.clearRect(0, 0, W, H);
  if (!lms) return;
  const P = (i) => {
    const l = lms[i];
    return { x: (S.mirror ? 1 - l.x : l.x) * W, y: l.y * H, v: l.visibility == null ? 1 : l.visibility };
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3 * d;
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  for (const [a, b] of CONN) {
    const pa = P(a), pb = P(b);
    if (pa.v < 0.35 || pb.v < 0.35) continue;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  for (const i of JOINTS) {
    const p = P(i);
    if (p.v < 0.35) continue;
    ctx.beginPath(); ctx.arc(p.x, p.y, 3.5 * d, 0, Math.PI * 2); ctx.fill();
  }
  if (!m || !m.idx) return;
  const now = performance.now();
  const flashing = now < S.flashUntil && S.flashTone === 'good';
  const bad = !m.ok || (m.form && m.form.length);
  const color = bad ? C_BAD : flashing ? C_GOOD : C_ACC;
  const [a, b, c] = m.idx.map(P);
  ctx.strokeStyle = color;
  ctx.lineWidth = 6 * d;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.stroke();
  ctx.fillStyle = color;
  for (const p of [a, c]) { ctx.beginPath(); ctx.arc(p.x, p.y, 5 * d, 0, Math.PI * 2); ctx.fill(); }
  ctx.beginPath(); ctx.arc(b.x, b.y, 8 * d, 0, Math.PI * 2); ctx.fill();

  const ang = m.ok ? (S.phase === 'active' && snap && snap.angle != null ? snap.angle : S.prevAngle ?? m.angle) : null;
  if (ang != null) {
    const text = Math.round(ang) + '°';
    ctx.font = `800 ${15 * d}px ui-rounded, system-ui, sans-serif`;
    const tw = ctx.measureText(text).width + 14 * d, th = 24 * d;
    let x = b.x + 14 * d, y = b.y - th - 8 * d;
    if (x + tw > W - 4 * d) x = b.x - 14 * d - tw;
    x = Math.max(4 * d, x);
    y = Math.max(4 * d, Math.min(H - th - 4 * d, y));
    ctx.fillStyle = 'rgba(8,11,14,.78)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, tw, th, 8 * d); else ctx.rect(x, y, tw, th);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 7 * d, y + th / 2 + 1 * d);
  }
}

// ---------- นับถอยหลัง / เซ็ต ----------
function startCountdown() {
  if (S.phase !== 'ready' || S.model !== 'ready') return;
  audio();
  S.phase = 'countdown';
  let n = COUNTDOWN_SEC;
  const el = $('#countdown');
  el.textContent = String(n);
  beep(660, 80);
  syncUI();
  cdTimer = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(cdTimer);
      beginSession();
    } else {
      el.textContent = String(n);
      beep(660, 80);
    }
  }, 1000);
}

function cancelCountdown() {
  clearInterval(cdTimer);
  S.phase = 'ready';
  syncUI();
}

function beginSession() {
  S.counter = new RepCounter(S.kind);
  S.phase = 'active';
  S.sessionStart = Date.now();
  S.sessionTs = S.sessionStart;
  S.flash = null;
  $('#repNum').textContent = '0';
  $('#rdClean').textContent = '0';
  $('#rdTime').textContent = '0:00';
  hudCache.time = '0:00';
  beep(990, 220, 0.22);
  clearInterval(clockTimer);
  clockTimer = setInterval(tickClock, 250);
  syncUI();
}

function stopSession() {
  if (S.phase !== 'active') return;
  clearInterval(clockTimer);
  const c = S.counter;
  const dur = (Date.now() - S.sessionStart) / 1000;
  S.phase = 'ready';
  beep(520, 220, 0.2);
  syncUI();
  if (c.reps === 0) {
    toast('ยังไม่มีครั้งที่นับได้ จึงไม่บันทึก');
    return;
  }
  const depth = c.records.length ? c.records.reduce((s, r) => s + r.minAngle, 0) / c.records.length : null;
  S.pending = { kind: S.kind, ts: S.sessionTs, reps: c.reps, clean: c.clean, dur, depth };
  openSheet();
}

$('#btnMain').addEventListener('click', () => {
  audio();
  if (S.phase === 'idle') openCamera();
  else if (S.phase === 'ready') startCountdown();
  else if (S.phase === 'countdown') cancelCountdown();
  else if (S.phase === 'active') stopSession();
});

// ---------- แผ่นสรุป ----------
function openSheet() {
  const p = S.pending;
  $('#sheetTitle').textContent = 'สรุปเซ็ต · ' + TEXT[p.kind].label;
  $('#sumDepthLab').textContent = p.kind === 'pushup' ? 'ศอกต่ำสุดเฉลี่ย' : 'เข่าต่ำสุดเฉลี่ย';
  $('#sumKind').textContent = 'นับได้ ' + p.reps + ' ครั้ง ถ้าตัวเลขไม่ตรงกับที่ทำจริง กด − หรือ + ปรับก่อนบันทึกได้';
  renderSheet();
  $('#scrim').hidden = false;
  $('#sumSave').focus();
}
function renderSheet() {
  const p = S.pending;
  p.clean = Math.min(p.clean, p.reps);
  $('#sumReps').textContent = String(p.reps);
  $('#sumClean').textContent = String(p.clean);
  $('#sumTime').textContent = fmtTime(p.dur);
  $('#sumDepth').textContent = p.depth != null ? Math.round(p.depth) + '°' : '–';
}
$('#repMinus').addEventListener('click', () => { if (S.pending && S.pending.reps > 1) { S.pending.reps--; renderSheet(); } });
$('#repPlus').addEventListener('click', () => { if (S.pending && S.pending.reps < 999) { S.pending.reps++; renderSheet(); } });
$('#sumDiscard').addEventListener('click', () => { S.pending = null; $('#scrim').hidden = true; toast('ไม่ได้บันทึกเซ็ตนี้'); resetAfterSet(); });
$('#sumSave').addEventListener('click', async () => {
  const p = S.pending;
  if (!p) return;
  const r = store.addSession({ ts: p.ts, kind: p.kind, reps: p.reps, clean: p.clean, dur: p.dur, depth: p.depth });
  S.pending = null;
  $('#scrim').hidden = true;
  toast(r.ok ? 'บันทึกในเครื่องแล้ว' : 'บันทึกในเครื่องไม่สำเร็จ (โหมดส่วนตัวหรือพื้นที่เต็ม) ลองส่งออกไฟล์สำรอง', r.ok ? 2200 : 5000);
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* ignore */ }
  resetAfterSet();
});
function resetAfterSet() {
  S.counter = new RepCounter(S.kind);
  $('#repNum').textContent = '0';
  $('#rdClean').textContent = '0';
  $('#rdTime').textContent = '0:00';
  hudCache.time = '0:00';
}

// ---------- ซิงก์หน้าจอฝึก ----------
function syncUI() {
  const main = $('#btnMain');
  const cam = S.cam, ph = S.phase;
  const busy = cam === 'starting' || (cam === 'on' && S.model === 'loading');
  let label = 'เปิดกล้อง', mode = '';
  if (busy) label = cam === 'starting' ? 'กำลังเปิดกล้อง…' : 'กำลังโหลดโมเดล…';
  else if (ph === 'ready') label = 'เริ่ม';
  else if (ph === 'countdown') label = 'ยกเลิก';
  else if (ph === 'active') { label = 'หยุดและสรุป'; mode = 'stop'; }
  main.textContent = label;
  main.dataset.mode = mode;
  main.disabled = busy;

  $('#btnFlip').hidden = !(ph === 'ready');
  $('#btnOff').hidden = !(ph === 'ready');

  for (const b of $$('#kindSeg button')) {
    b.setAttribute('aria-checked', String(b.dataset.kind === S.kind));
    b.disabled = ph === 'countdown' || ph === 'active';
  }
  $('#rdAngleLab').textContent = TEXT[S.kind].joint;
  $('#tip').innerHTML = TEXT[S.kind].tip;

  const live = cam === 'on';
  $('#hudCount').hidden = !live;
  $('#countdown').hidden = ph !== 'countdown';
  $('#simBadge').hidden = !SIM;
  if (!live) { $('#cue').textContent = ''; hudCache.cue = ''; $('#hudPhase').hidden = true; }
  stage.classList.toggle('mirror', S.mirror && live && !SIM);

  const phEl = $('#placeholder');
  phEl.hidden = live;
  phEl.dataset.tone = S.err ? 'bad' : '';
  if (!live) {
    let title = 'พร้อมตรวจท่า', text = 'กด "เปิดกล้อง" แล้ววางมือถือให้เห็นตัวตะแคง ภาพไม่ถูกอัปโหลดที่ไหน';
    if (cam === 'starting') { title = 'กำลังขอใช้กล้อง'; text = 'ถ้ามีหน้าต่างถามสิทธิ์ ให้แตะ "อนุญาต"'; }
    else if (S.err === 'insecure') {
      title = 'ต้องเปิดผ่าน https';
      text = 'Safari ให้ใช้กล้องเฉพาะเว็บที่เป็น https อัปโหลดแอปไว้บนโฮสต์ฟรีตามคู่มือ แล้วเปิดลิงก์นั้น';
    } else if (S.err) { title = 'เริ่มไม่สำเร็จ'; text = S.err; }
    $('#phTitle').textContent = title;
    $('#phText').textContent = text;
  }
  updateChip();
}

function updateChip() {
  const chip = $('#chip');
  let text = '', tone = '';
  if (!navigator.onLine && S.model !== 'ready') { text = 'ออฟไลน์'; tone = 'warn'; }
  else if (S.model === 'loading') { text = 'กำลังโหลดโมเดล…'; tone = 'warn'; }
  else if (S.model === 'ready' && !SIM) { text = 'โมเดลพร้อม'; tone = 'good'; }
  else if (S.model === 'error') { text = 'โหลดโมเดลไม่ได้'; tone = 'bad'; }
  chip.hidden = !text;
  chip.textContent = text;
  chip.dataset.tone = tone;
}
window.addEventListener('online', updateChip);
window.addEventListener('offline', updateChip);

// ---------- ประวัติ ----------
function dayLabel(ts) {
  const k = store.dayKey(ts), now = Date.now();
  if (k === store.dayKey(now)) return 'วันนี้';
  if (k === store.dayKey(now - 86400000)) return 'เมื่อวาน';
  const d = new Date(ts);
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('th-TH', opts);
}

function chartHTML(days) {
  const W = 320, Hh = 150, L = 30, R = 8, T = 10, B = 24;
  const pw = W - L - R, ph = Hh - T - B;
  const mx = Math.max(0, ...days.map((d) => d.pushup + d.squat));
  const steps = [10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500, 1000, 2000];
  const top = steps.find((s) => s >= mx) || Math.ceil(mx / 1000) * 1000;
  const y = (v) => T + ph - (v / top) * ph;
  let s = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="กราฟจำนวนครั้งรายวัน 7 วันล่าสุด">`;
  for (const g of [0, top / 2, top]) {
    s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text x="${L - 6}" y="${y(g) + 4}" text-anchor="end">${Math.round(g)}</text>`;
  }
  const slot = pw / 7, bw = slot * 0.56;
  days.forEach((d, i) => {
    const x = L + slot * i + (slot - bw) / 2;
    let yy = y(0);
    for (const k of ['pushup', 'squat']) {
      const v = d[k];
      if (!v) continue;
      const hgt = (v / top) * ph;
      yy -= hgt;
      s += `<rect class="bar ${k}" x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" rx="3"><title>${d.label}: ${k === 'pushup' ? 'วิดพื้น' : 'สควอต'} ${v} ครั้ง</title></rect>`;
    }
    s += `<text x="${(x + bw / 2).toFixed(1)}" y="${Hh - 7}" text-anchor="middle" class="${i === 6 ? 'today' : ''}">${d.label}</text>`;
  });
  return s + '</svg>';
}

function renderHistory() {
  const { sessions } = store.get();
  const sum = store.summarize(sessions);
  const block = (title, a, b) => h('div', { class: 'stat' },
    h('div', { class: 't', text: title }),
    h('div', { class: 'row' }, h('i', { class: 'dot pushup' }), h('b', { text: String(a) }), h('small', { text: 'วิดพื้น' })),
    h('div', { class: 'row' }, h('i', { class: 'dot squat' }), h('b', { text: String(b) }), h('small', { text: 'สควอต' })));
  const stats = $('#stats');
  stats.replaceChildren(
    block('วันนี้', sum.today.pushup, sum.today.squat),
    block('7 วัน', sum.week.pushup, sum.week.squat),
    block('เซ็ตที่ดีที่สุด', sum.total.pushup.best, sum.total.squat.best),
  );
  $('#chart').innerHTML = chartHTML(sum.days);

  const list = $('#list');
  list.replaceChildren();
  if (!sessions.length) {
    list.append(h('div', { class: 'empty', text: 'ยังไม่มีบันทึก ฝึกเซ็ตแรกที่แท็บ "ฝึก" ได้เลย' }));
    return;
  }
  let lastKey = '';
  for (const s of sessions) {
    const k = store.dayKey(s.ts);
    if (k !== lastKey) { lastKey = k; list.append(h('div', { class: 'day-h', text: dayLabel(s.ts) })); }
    const d = new Date(s.ts);
    const meta = `${pad2(d.getHours())}:${pad2(d.getMinutes())} · ถูกท่า ${s.clean} · ${fmtTime(s.dur)} นาที` + (s.depth != null ? ` · ${s.depth}°` : '');
    const del = h('button', { type: 'button', class: 'del', 'aria-label': 'ลบเซ็ตนี้', text: 'ลบ' });
    let timer = null;
    del.addEventListener('click', () => {
      if (del.dataset.armed === 'true') {
        clearTimeout(timer);
        store.deleteSession(s.id);
        renderHistory();
      } else {
        del.dataset.armed = 'true';
        del.textContent = 'ยืนยัน';
        timer = setTimeout(() => { del.dataset.armed = 'false'; del.textContent = 'ลบ'; }, 3000);
      }
    });
    list.append(h('div', { class: 'item' },
      h('span', { class: 'bar ' + s.kind }),
      h('div', { class: 'main' }, h('b', { text: TEXT[s.kind].label }), h('div', { text: meta })),
      h('div', { class: 'reps', text: String(s.reps) }),
      del));
  }
}

// ---------- ตั้งค่า ----------
function renderSettings() {
  const st = settings();
  for (const seg of $$('.seg[data-setting]')) {
    for (const b of $$('button', seg)) b.setAttribute('aria-checked', String(st[seg.dataset.setting] === b.dataset.value));
  }
  const n = store.get().sessions.length;
  const base = `เก็บไว้ ${n} เซ็ตในเครื่องนี้`;
  $('#storageInfo').textContent = base;
  try {
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then((p) => {
        $('#storageInfo').textContent = base + (p ? ' · เบราว์เซอร์ยืนยันการเก็บถาวร' : ' · ยังไม่ได้รับการยืนยันเก็บถาวร ควรส่งออกไฟล์สำรองเป็นระยะ');
      });
    }
  } catch { /* ignore */ }
}
for (const seg of $$('.seg[data-setting]')) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    store.updateSettings({ [seg.dataset.setting]: b.dataset.value });
    if (seg.dataset.setting === 'sound') {
      audio();
      if (b.dataset.value === 'beep') beep(880, 110);
      if (b.dataset.value === 'voice') say('หนึ่ง');
    }
    renderSettings();
    if (seg.dataset.setting === 'facing' && S.cam === 'on') toast('กล้องใหม่จะใช้ตอนเปิดกล้องครั้งถัดไป');
  });
}

$('#btnExport').addEventListener('click', () => {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `replens-${store.dayKey(Date.now())}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('ส่งออกไฟล์แล้ว ดูในรายการดาวน์โหลดของ Safari');
});
$('#btnCopy').addEventListener('click', async () => {
  const text = store.exportJSON();
  try {
    await navigator.clipboard.writeText(text);
    toast('คัดลอกข้อมูลแล้ว วางเก็บไว้ในโน้ตได้');
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;left:0;top:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    toast(ok ? 'คัดลอกข้อมูลแล้ว' : 'คัดลอกไม่สำเร็จ ลองใช้ปุ่มส่งออกไฟล์แทน');
  }
});
$('#btnImport').addEventListener('click', () => $('#fileIn').click());
$('#fileIn').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const r = store.importJSON(await f.text());
  toast(r.ok ? `นำเข้า ${r.added} เซ็ต ข้ามที่ซ้ำ ${r.skipped}` : r.error, 3500);
  renderSettings();
});
let clearArmed = null;
$('#btnClear').addEventListener('click', (e) => {
  const b = e.currentTarget;
  if (clearArmed) {
    clearTimeout(clearArmed);
    clearArmed = null;
    store.clearAll();
    b.textContent = 'ลบประวัติทั้งหมด';
    toast('ลบประวัติแล้ว');
    renderSettings();
  } else {
    b.textContent = 'แตะอีกครั้งเพื่อลบทั้งหมด';
    clearArmed = setTimeout(() => { clearArmed = null; b.textContent = 'ลบประวัติทั้งหมด'; }, 4000);
  }
});

// ---------- วงจรชีวิตของหน้า ----------
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || S.cam !== 'on' || SIM) return;
  lockScreen();
  const track = stream && stream.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') {
    const wasActive = S.phase === 'active';
    closeCamera();
    if (!wasActive) await openCamera();
    else { S.err = 'กล้องหยุดทำงานระหว่างสลับแอป เปิดกล้องใหม่เพื่อเริ่มเซ็ตต่อ'; syncUI(); }
    return;
  }
  video.play().catch(() => {});
});
window.addEventListener('pagehide', () => { if (stream) for (const t of stream.getTracks()) t.stop(); });

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// ---------- เริ่มต้น ----------
(async function boot() {
  if (SIM) {
    simModule = await import('./sim.js');
    S.kind = SIM;
    S.counter = new RepCounter(SIM);
  }
  syncUI();
  showTab('train');
  resizeCanvas();
})();

// เปิดให้ทดสอบจากภายนอกได้ (ไม่กระทบการใช้งานปกติ)
window.__replens = { S, store, CONFIG };
