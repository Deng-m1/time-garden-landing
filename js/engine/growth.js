/* 时间花园 · 统一生长模型（唯一权威实现）
 *
 * SPEC §2.3.1 与 DESIGN §6.3 描述的就是这个文件，三方逐字一致。
 * 这是 4.3(b) 辩护中「可被审核员复核」的算法本体，不允许存在第二份实现。
 * 关键点数值由 `tools/verify-growth.mjs` 产出，文档中的每个数字都来自该脚本。
 *
 * ─── 输入 ───────────────────────────────────────────────
 *   T     = max(1, 天数(planted → target))     事件总时长
 *   dLeft = 天数(today → target)               剩余天数（可为负）
 *   W     = min(T, 730)                         有效倒数窗口
 *   eWin  = W − dLeft                           窗口内已过天数
 *   t     = eWin / W                            相对进度
 *
 * ─── 分支 ───────────────────────────────────────────────
 *   dLeft ≤ 0   长青：v = 1 + 0.18 · min(1, −dLeft/7)   满开保持 7 天
 *   dLeft > W   窗外：v = 0，状态 far（土中微光 +「还很远」）
 *   T < 7       短事件绝对天数轴：v = 0.18 + 0.82 · s^1.35, s = (T−dLeft)/T
 *   其余        v = max(基础曲线, 头部曲线, 天数钳制, 播种地板)
 *
 * ─── 四项的分工 ─────────────────────────────────────────
 *   基础曲线 t^1.7    「前期慢、临近加速」——「越临近开得越盛」的数学表达
 *   头部曲线 vHead    t^1.7 在长事件上前 30% 几乎不动（365 天事件纯曲线第 120 天
 *                     才破土）。vHead 是一条幂曲线，指数由「破土不晚于第 20 天」
 *                     反解，并在 v = 0.34 处与基础曲线**精确相接**，因此全程严格
 *                     递增、无死区、无跨阶段突跳。
 *   天数钳制 vDays    SPEC §2.3.1 钳制表的连续化版本（阶跃地板会造成一夜跨阶段）。
 *                     实际生效于 7–65 天的中短事件，是它们的尾部保护。
 *   播种地板 vPlant   7 天以内的事件种下即萌芽；14 天以上不生效。用来消除
 *                     T=6 与 T=7 之间的断崖。
 */

import { clamp } from './rng.js';

export const GROWTH = {
  EXP: 1.7,               // 基础缓动指数
  WINDOW_MAX: 730,        // 有效倒数窗口上限（天）
  SPROUT_V: 0.15,         // 破土（萌芽起点）
  SPROUT_BY_DAY: 20,      // 破土不晚于第 20 天（按整日取整后即「三周内破土」）
  HEAD_CEIL: 0.34,        // 头部曲线与基础曲线的相接点（< 生长阈值 0.35）
  SHORT_EVENT: 7,         // 短事件阈值（天）
  SHORT_FLOOR: 0.18,      // 种下即萌芽的起点
  SHORT_EXP: 1.35,
  PLANT_FLOOR_MAX_T: 14,  // 播种地板的退场时长（天）
  EVERGREEN_DAYS: 7,      // 满开保持天数
  EVERGREEN_MAX: 1.18,    // 长青期 v 上限
  /** SPEC §2.3.1 钳制表：[剩余天数, v 最低值] */
  DAY_CLAMPS: [[30, 0.35], [10, 0.65], [3, 0.88], [0, 1.00]],
};

/** 六个阶段边界（SPEC §2.3 表格，全工程唯一定义处） */
export const STAGES = [
  { key: 'seed',        zh: '种子', en: 'Seed',      from: 0.00, to: 0.15 },
  { key: 'sprout',      zh: '萌芽', en: 'Sprout',    from: 0.15, to: 0.35 },
  { key: 'growing',     zh: '生长', en: 'Growth',    from: 0.35, to: 0.65 },
  { key: 'budding',     zh: '结蕾', en: 'Bud',       from: 0.65, to: 0.88 },
  { key: 'blooming',    zh: '绽放', en: 'Bloom',     from: 0.88, to: 1.00 },
  { key: 'everlasting', zh: '长青', en: 'Evergreen', from: 1.00, to: 99 },
];

export function stageOf(v) {
  for (const s of STAGES) if (v >= s.from && v < s.to) return s;
  return STAGES[STAGES.length - 1];
}

/** 基础曲线到达相接点 HEAD_CEIL 的那一天（占窗口的比例 × W） */
const headJoinDay = (W) => Math.pow(GROWTH.HEAD_CEIL, 1 / GROWTH.EXP) * W;

/**
 * 头部曲线：在 eWin=20 处恰为 0.15，在 eWin=D 处恰为 0.34 与基础曲线相接。
 * 指数 q = ln(0.15/0.34) / ln(20/D)，由两个约束反解，不是调出来的。
 */
export function headCurve(eWin, W) {
  if (eWin <= 0) return 0;
  const D = headJoinDay(W);
  if (D <= GROWTH.SPROUT_BY_DAY) return 0;      // 基础曲线本就在 21 天内破土
  const q = Math.log(GROWTH.SPROUT_V / GROWTH.HEAD_CEIL) / Math.log(GROWTH.SPROUT_BY_DAY / D);
  return GROWTH.HEAD_CEIL * Math.pow(Math.min(1, eWin / D), q);
}

/**
 * 绝对天数钳制：SPEC 钳制表的连续分段线性形式。
 * 结点仅在 T > 2×结点天数 时生效；并在第一个生效结点之前补一个 (2d, 0) 的
 * 引导结点，让钳制从 0 平滑爬升到该结点——否则会出现「一夜之间从萌芽跳到绽放」。
 */
export function dayClamp(daysLeft, total) {
  const active = GROWTH.DAY_CLAMPS.filter(([d]) => d === 0 || total > 2 * d);
  if (active.length < 2) return 0;
  const knots = [[2 * active[0][0], 0], ...active];
  if (daysLeft >= knots[0][0]) return 0;
  for (let i = 0; i < knots.length - 1; i++) {
    const [dA, vA] = knots[i], [dB, vB] = knots[i + 1];
    if (daysLeft <= dA && daysLeft >= dB) {
      return vA + (vB - vA) * ((dA - daysLeft) / (dA - dB || 1));
    }
  }
  return knots[knots.length - 1][1];
}

/** 播种地板：≤7 天的事件种下即萌芽，14 天以上退场 */
export const plantFloor = (total) =>
  GROWTH.SHORT_FLOOR * clamp((GROWTH.PLANT_FLOOR_MAX_T - total) / (GROWTH.PLANT_FLOOR_MAX_T - GROWTH.SHORT_EVENT));

/**
 * 唯一的 t → v 入口。
 * @returns {{v,t,total,daysLeft,elapsed,window,far,past,today,stage,driver}}
 */
export function growthState(totalDays, daysLeft) {
  const T = Math.max(1, Math.round(totalDays));
  const dLeft = Math.round(daysLeft);
  const W = Math.min(T, GROWTH.WINDOW_MAX);
  const eWin = W - dLeft;

  if (dLeft <= 0) {
    const held = Math.min(1, -dLeft / GROWTH.EVERGREEN_DAYS);
    return pack(1 + (GROWTH.EVERGREEN_MAX - 1) * held, 1, T, dLeft, W, false, 'evergreen');
  }
  if (dLeft > W) {
    return pack(0, 0, T, dLeft, W, true, 'far');
  }
  if (T < GROWTH.SHORT_EVENT) {
    const s = clamp((T - dLeft) / T);
    return pack(GROWTH.SHORT_FLOOR + (1 - GROWTH.SHORT_FLOOR) * Math.pow(s, GROWTH.SHORT_EXP),
      s, T, dLeft, W, false, 'short');
  }

  const t = clamp(eWin / W);
  const base = Math.pow(t, GROWTH.EXP);
  const head = headCurve(eWin, W);
  const days = dayClamp(dLeft, T);
  const plant = plantFloor(T);
  const v = Math.max(base, head, days, plant);
  const driver = v === days && days > base ? 'dayClamp'
    : v === plant && plant > base && plant > head ? 'plantFloor'
      : v === head && head > base ? 'headCurve' : 'curve';
  return pack(v, t, T, dLeft, W, false, driver);
}

function pack(v, t, T, dLeft, W, far, driver) {
  const vv = clamp(v, 0, GROWTH.EVERGREEN_MAX);
  return {
    v: vv, t, total: T, daysLeft: dLeft, elapsed: T - dLeft, window: W,
    far, past: dLeft < 0, today: dLeft === 0,
    stage: stageOf(vv), driver,
  };
}

/** v → 剩余天数（详情页「预览生长」滑杆的反解）。单调二分，与正向完全自洽。 */
export function daysLeftForV(totalDays, targetV) {
  const T = Math.max(1, Math.round(totalDays));
  if (targetV >= 1) {
    return -Math.round(((targetV - 1) / (GROWTH.EVERGREEN_MAX - 1)) * GROWTH.EVERGREEN_DAYS);
  }
  let lo = 0, hi = Math.min(T, GROWTH.WINDOW_MAX);
  for (let i = 0; i < 44; i++) {
    const mid = (lo + hi) / 2;
    if (growthState(T, mid).v >= targetV) lo = mid; else hi = mid;
  }
  return Math.round(lo);
}
