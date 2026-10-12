// store.js — เก็บประวัติและการตั้งค่าไว้ในเครื่อง (localStorage) พร้อมสรุปสถิติ
// ไม่ส่งข้อมูลออกนอกเครื่อง ใช้งานใน Node ได้ด้วย (สำรองเป็นหน่วยความจำ)

const KEY = 'replens.v1';
export const KINDS = ['pushup', 'squat'];
export const DEFAULT_SETTINGS = { sound: 'beep', facing: 'user', quality: 'lite', kind: 'pushup' };

let mem = null;
let state = null;

function readRaw() {
  try {
    const s = localStorage.getItem(KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return mem;
  }
}

function writeRaw() {
  mem = JSON.parse(JSON.stringify(state));
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function validSession(s) {
  return (
    s && typeof s.id === 'string' && Number.isFinite(s.ts) && KINDS.includes(s.kind) &&
    Number.isFinite(s.reps) && s.reps >= 0
  );
}

function normalize(s) {
  return {
    id: s.id,
    ts: Math.round(s.ts),
    kind: s.kind,
    reps: Math.round(s.reps),
    clean: Math.max(0, Math.min(Math.round(s.clean || 0), Math.round(s.reps))),
    dur: Math.max(0, Math.round(s.dur || 0)),
    depth: Number.isFinite(s.depth) ? Math.round(s.depth) : null,
  };
}

export function init() {
  const d = readRaw() || {};
  state = {
    v: 1,
    sessions: (Array.isArray(d.sessions) ? d.sessions : []).filter(validSession).map(normalize),
    settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
  };
  state.sessions.sort((a, b) => b.ts - a.ts);
  return state;
}

export const get = () => state || init();

export function updateSettings(patch) {
  get().settings = { ...state.settings, ...patch };
  return writeRaw();
}

export function newId() {
  try {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* ignore */ }
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function addSession(s) {
  const rec = normalize({ id: newId(), ...s });
  get().sessions.unshift(rec);
  state.sessions.sort((a, b) => b.ts - a.ts);
  return { ok: writeRaw(), rec };
}

export function deleteSession(id) {
  get().sessions = state.sessions.filter((s) => s.id !== id);
  return writeRaw();
}

export function clearAll() {
  get().sessions = [];
  return writeRaw();
}

export function exportJSON() {
  return JSON.stringify({ app: 'RepLens', v: 1, exportedAt: new Date().toISOString(), sessions: get().sessions }, null, 2);
}

export function importJSON(text) {
  let d;
  try { d = JSON.parse(text); } catch { return { ok: false, error: 'ไฟล์ไม่ใช่ JSON ที่ถูกต้อง' }; }
  const list = Array.isArray(d) ? d : d && d.sessions;
  if (!Array.isArray(list)) return { ok: false, error: 'ไม่พบรายการบันทึกในไฟล์' };
  const have = new Set(get().sessions.map((s) => s.id));
  let added = 0, skipped = 0;
  for (const raw of list) {
    if (!validSession(raw) || have.has(raw.id)) { skipped++; continue; }
    state.sessions.push(normalize(raw));
    have.add(raw.id);
    added++;
  }
  state.sessions.sort((a, b) => b.ts - a.ts);
  writeRaw();
  return { ok: true, added, skipped };
}

// ---------- สถิติ ----------
export function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const DAY_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

export function summarize(sessions, now = Date.now()) {
  const zero = () => ({ pushup: 0, squat: 0 });
  const days = [];
  const index = {};
  const base = new Date(now);
  base.setHours(12, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    const row = { key: dayKey(d.getTime()), label: DAY_TH[d.getDay()], ...zero() };
    index[row.key] = row;
    days.push(row);
  }
  const todayKey = days[6].key;
  const today = zero();
  const week = zero();
  const total = { pushup: { reps: 0, sessions: 0, best: 0 }, squat: { reps: 0, sessions: 0, best: 0 } };
  for (const s of sessions) {
    const t = total[s.kind];
    t.reps += s.reps;
    t.sessions += 1;
    t.best = Math.max(t.best, s.reps);
    const k = dayKey(s.ts);
    if (index[k]) {
      index[k][s.kind] += s.reps;
      week[s.kind] += s.reps;
    }
    if (k === todayKey) today[s.kind] += s.reps;
  }
  return { days, today, week, total, todayKey };
}
