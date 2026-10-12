// sim.js — โหมดสาธิต: สร้างจุดข้อต่อจำลอง (ไม่ใช้กล้อง) เพื่อลองหน้าจอและทดสอบตัวนับ
// เปิดด้วย index.html?sim=pushup หรือ ?sim=squat

const rad = (d) => (d * Math.PI) / 180;

function blank() {
  return Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
}

function put(lms, i, p, aspect, v = 0.95) {
  lms[i] = { x: p.x / aspect, y: p.y, z: 0, visibility: v };
}

// มุมเป้าหมายตามเวลา: ครั้งที่ 5 ของทุกรอบลงไม่ลึก เพื่อแสดงข้อความ "ลงไม่ลึกพอ"
function targetAngle(kind, t, period) {
  const k = Math.floor(t / period);
  const shallow = k % 5 === 4;
  const hi = kind === 'pushup' ? 172 : 176;
  const lo = shallow ? (kind === 'pushup' ? 118 : 124) : kind === 'pushup' ? 72 : 82;
  const mid = (hi + lo) / 2, amp = (hi - lo) / 2;
  // เริ่มที่ท่าขึ้นสุด แล้วลงก่อน
  return { angle: mid + amp * Math.cos((2 * Math.PI * t) / period), k };
}

export function simPose(kind, tSec, aspect, opts = {}) {
  const period = opts.period || 3.2;
  // หยุดนิ่ง 1.5 วินาทีแรกที่ท่าขึ้นสุด
  const t = Math.max(0, tSec - 1.5);
  const { angle: th, k } = targetAngle(kind, t, period);
  const lms = blank();
  if (kind === 'pushup') {
    const L1 = 0.13, L2 = 0.13, psi = 8;
    const W = { x: 0.8, y: 0.78 };
    const E = { x: W.x - L2 * Math.sin(rad(psi)), y: W.y - L2 * Math.cos(rad(psi)) };
    const S = { x: E.x + L1 * Math.sin(rad(psi + th)), y: E.y + L1 * Math.cos(rad(psi + th)) };
    const A = { x: 0.22, y: 0.74 };
    const sag = opts.sag && k % 4 === 3 ? 0.07 : 0;
    const H = { x: S.x + 0.55 * (A.x - S.x), y: S.y + 0.55 * (A.y - S.y) + sag };
    const K = { x: S.x + 0.8 * (A.x - S.x), y: S.y + 0.8 * (A.y - S.y) };
    const head = { x: S.x + 0.07, y: S.y - 0.03 };
    for (const [i, p] of [[11, S], [13, E], [15, W], [23, H], [25, K], [27, A]]) put(lms, i, p, aspect);
    for (const [i, p] of [[12, S], [14, E], [16, W], [24, H], [26, K], [28, A]]) put(lms, i, p, aspect, 0.6);
    put(lms, 0, head, aspect);
  } else {
    const shin = 0.2, thigh = 0.22, torso = 0.28;
    const A = { x: 0.3, y: 0.9 };
    const s = Math.min(35, (180 - th) * 0.4);
    const K = { x: A.x + shin * Math.sin(rad(s)), y: A.y - shin * Math.cos(rad(s)) };
    const aKA = (Math.atan2(Math.cos(rad(s)), -Math.sin(rad(s))) * 180) / Math.PI;
    const dirKH = rad(aKA + th);
    const H = { x: K.x + thigh * Math.cos(dirKH), y: K.y + thigh * Math.sin(dirKH) };
    const lean = (180 - th) * 0.35;
    const S = { x: H.x + torso * Math.sin(rad(lean)), y: H.y - torso * Math.cos(rad(lean)) };
    const E = { x: S.x + 0.12, y: S.y + 0.1 };
    const W = { x: S.x + 0.2, y: S.y + 0.02 };
    for (const [i, p] of [[11, S], [13, E], [15, W], [23, H], [25, K], [27, A]]) put(lms, i, p, aspect);
    for (const [i, p] of [[12, S], [14, E], [16, W], [24, H], [26, K], [28, A]]) put(lms, i, p, aspect, 0.6);
    put(lms, 0, { x: S.x + 0.03, y: S.y - 0.08 }, aspect);
  }
  return { lms, angle: th, k };
}
