// counter.js — ตรรกะล้วน (ไม่ผูกกับเบราว์เซอร์) สำหรับวัดมุมข้อต่อ ตรวจท่า และนับครั้ง
// ใช้ได้ทั้งในเบราว์เซอร์และ Node (เพื่อทดสอบ)

export const CONFIG = {
  pushup: {
    label: 'วิดพื้น',
    up: 150,      // แขนเหยียดตรงอย่างน้อยเท่านี้ ถึงนับว่า "ขึ้นสุด"
    leave: 138,   // ศอกงอต่ำกว่านี้ ถือว่าเริ่มลง
    count: 105,   // งอศอกถึงเท่านี้ ถึงนับเป็น 1 ครั้ง
    partial: 128, // งอถึงเท่านี้แต่ไม่ถึง count = ลงไม่ลึกพอ
    minRepMs: 400,
  },
  squat: {
    label: 'สควอต',
    up: 155,
    leave: 145,
    count: 112,
    partial: 135,
    minRepMs: 500,
  },
};

const SIDES = {
  L: { s: 11, e: 13, w: 15, h: 23, k: 25, a: 27 },
  R: { s: 12, e: 14, w: 16, h: 24, k: 26, a: 28 },
};

const VIS = 0.5;

const vis = (lms, i) => (lms[i] && lms[i].visibility != null ? lms[i].visibility : 1);
const iso = (lms, i, aspect) => ({ x: lms[i].x * aspect, y: lms[i].y });

export function angleAt(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-6 || n2 < 1e-6) return null;
  let cos = (v1x * v2x + v1y * v2y) / (n1 * n2);
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

function jointAngle(lms, aspect, ids) {
  return angleAt(iso(lms, ids[0], aspect), iso(lms, ids[1], aspect), iso(lms, ids[2], aspect));
}

// เลือกข้างที่มองเห็นชัดกว่า (กล้องมักเห็นข้างใกล้ชัดกว่า)
function pickSides(lms, keys) {
  const out = [];
  for (const sd of ['L', 'R']) {
    const idx = keys.map((k) => SIDES[sd][k]);
    const vs = idx.map((i) => vis(lms, i));
    const min = Math.min(...vs);
    if (min >= VIS) out.push({ sd, idx, min, mean: vs.reduce((x, y) => x + y, 0) / vs.length });
  }
  out.sort((a, b) => b.mean - a.mean);
  return out;
}

function blendAngle(lms, aspect, sides) {
  const best = sides[0];
  let ang = jointAngle(lms, aspect, best.idx);
  if (ang == null) return null;
  if (sides.length === 2 && best.mean >= 0.7 && sides[1].mean >= 0.7) {
    const other = jointAngle(lms, aspect, sides[1].idx);
    if (other != null) ang = (ang + other) / 2;
  }
  return ang;
}

/**
 * วัดมุมหลักของท่าจาก landmarks ของ MediaPipe (33 จุด, พิกัด 0..1)
 * aspect = กว้าง/สูง ของภาพ ใช้ปรับแกน x ให้มุมไม่เพี้ยน
 * คืนค่า { ok, angle, idx, side, form[], view, reason }
 */
export function measure(kind, lms, aspect) {
  if (!lms || lms.length < 29) return { ok: false, reason: 'missing' };
  return kind === 'pushup' ? measurePushup(lms, aspect) : measureSquat(lms, aspect);
}

function measurePushup(lms, aspect) {
  const sides = pickSides(lms, ['s', 'e', 'w']);
  if (!sides.length) return { ok: false, reason: 'missing' };
  const best = sides[0];
  const ang = blendAngle(lms, aspect, sides);
  if (ang == null) return { ok: false, reason: 'missing' };
  const m = SIDES[best.sd];
  const S = iso(lms, m.s, aspect);

  // จุดล่างสุดที่เห็น ใช้ตรวจว่าตัวขนานพื้นหรือไม่
  let F = null;
  for (const key of ['a', 'k', 'h']) {
    if (vis(lms, m[key]) >= 0.4) { F = { p: iso(lms, m[key], aspect), key }; break; }
  }
  const form = [];
  if (F) {
    const dx = F.p.x - S.x, dy = F.p.y - S.y;
    const len = Math.hypot(dx, dy);
    if (len > 0.15) {
      const incl = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
      if (incl > 50) return { ok: false, reason: 'orient', angle: ang, idx: best.idx, side: best.sd };
      // เส้นลำตัว: ไหล่ -> ข้อเท้า/เข่า ดูว่าสะโพกตกหรือยกจากเส้นนี้
      if (vis(lms, m.h) >= 0.4 && F.key !== 'h' && Math.abs(dx) > 0.05) {
        const H = iso(lms, m.h, aspect);
        const yLine = S.y + (dy * (H.x - S.x)) / dx;
        const dev = (H.y - yLine) / len;
        if (dev > 0.08) form.push('hip_sag');
        else if (dev < -0.09) form.push('hip_pike');
      }
    }
  }
  return { ok: true, angle: ang, idx: best.idx, side: best.sd, form, view: 'side' };
}

function measureSquat(lms, aspect) {
  const sides = pickSides(lms, ['h', 'k', 'a']);
  if (!sides.length) return { ok: false, reason: 'missing' };
  const best = sides[0];
  const ang = blendAngle(lms, aspect, sides);
  if (ang == null) return { ok: false, reason: 'missing' };
  const m = SIDES[best.sd];
  const form = [];
  let view = 'side';

  const sOk = vis(lms, m.s) >= 0.5 && vis(lms, m.h) >= 0.5;
  if (sOk) {
    const S = iso(lms, m.s, aspect), H = iso(lms, m.h, aspect);
    const torso = Math.hypot(S.x - H.x, S.y - H.y);
    if (torso > 0.08) {
      const lean = (Math.atan2(Math.abs(S.x - H.x), H.y - S.y) * 180) / Math.PI;
      if (lean > 65 && ang < 150) form.push('lean');
    }
    if (vis(lms, 11) >= 0.5 && vis(lms, 12) >= 0.5 && torso > 0.08) {
      const sep = Math.abs(lms[11].x - lms[12].x) * aspect;
      if (sep > 0.55 * torso) view = 'front';
    }
  }
  return { ok: true, angle: ang, idx: best.idx, side: best.sd, form, view };
}

/**
 * ตัวนับครั้ง: เครื่องสถานะ waiting -> up -> moving -> (นับ 1 ครั้งเมื่อกลับมา up)
 * ใช้มุมที่ผ่านการเกลี่ย (EMA) และมีช่วง hysteresis กันตัวเลขกระโดด
 */
export class RepCounter {
  constructor(kind) {
    this.kind = kind;
    this.cfg = CONFIG[kind];
    this.reset();
  }

  reset() {
    this.state = 'waiting';
    this.angle = null;
    this.lastT = null;
    this.lostMs = 0;
    this.reps = 0;
    this.clean = 0;
    this.partials = 0;
    this.records = [];
    this.exc = null;
  }

  get phase() {
    if (this.state === 'waiting') return 'waiting';
    if (this.state === 'up') return 'up';
    return this.angle != null && this.angle <= this.cfg.count ? 'bottom' : 'moving';
  }

  update(t, m) {
    const dt = this.lastT == null ? 0 : Math.max(0, Math.min(120, t - this.lastT));
    this.lastT = t;

    if (!m || !m.ok) {
      this.lostMs += dt;
      if (this.lostMs > 900) {
        this.state = 'waiting';
        this.exc = null;
      }
      return this.snapshot(this.lostMs > 250 ? 'lost' : this.phase, m && m.reason, null);
    }
    this.lostMs = 0;

    if (this.angle == null) this.angle = m.angle;
    else this.angle += (m.angle - this.angle) * (1 - Math.exp(-dt / 60));
    const a = this.angle;
    const cfg = this.cfg;
    let event = null;

    if (this.state === 'waiting') {
      if (a >= cfg.up) this.state = 'up';
    } else if (this.state === 'up') {
      if (a < cfg.leave) {
        this.state = 'moving';
        this.exc = { t0: t, min: a, frames: 0, flags: {} };
      }
    } else if (this.state === 'moving') {
      const e = this.exc;
      e.min = Math.min(e.min, a);
      e.frames++;
      for (const f of m.form || []) e.flags[f] = (e.flags[f] || 0) + 1;
      if (a >= cfg.up) {
        const dur = t - e.t0;
        if (e.min <= cfg.count && dur >= cfg.minRepMs) {
          const issues = Object.keys(e.flags).filter((f) => e.flags[f] / Math.max(1, e.frames) >= 0.3);
          this.reps++;
          if (!issues.length) this.clean++;
          const rec = { n: this.reps, clean: !issues.length, issues, minAngle: Math.round(e.min), durMs: Math.round(dur) };
          this.records.push(rec);
          event = { type: 'rep', ...rec };
        } else if (e.min <= cfg.partial && dur >= cfg.minRepMs * 0.5) {
          this.partials++;
          event = { type: 'partial', minAngle: Math.round(e.min) };
        }
        this.state = 'up';
        this.exc = null;
      } else if (t - e.t0 > 20000) {
        this.state = 'waiting';
        this.exc = null;
      }
    }
    return this.snapshot(this.phase, null, event);
  }

  snapshot(phase, reason, event) {
    return { phase, reason: reason || null, angle: this.angle, reps: this.reps, clean: this.clean, event };
  }
}
