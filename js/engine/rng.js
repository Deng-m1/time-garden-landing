/* 时间花园 · 确定性随机源
 * 同一个事件名 → 同一颗种子 → 同一株植物（全世界一致）。
 * 不使用 Math.random()，渲染任何一帧都不引入非确定性。 */

/** 所有 Unicode 空白（半角/全角/不换行/制表/换行/零宽） */
const WS = /[\s\u00a0\u1680\u180e\u2000-\u200b\u202f\u205f\u2060\u3000\ufeff]+/g;

/**
 * 显示用归一化：连续空白折叠为单个半角空格并去首尾。
 * 用户看到的名字保持所见即所得，不参与种子推导。
 */
export const displayName = (str) => String(str ?? '').normalize('NFC').replace(WS, ' ').trim();

/**
 * 种子键（SPEC §2.1.1「空白折叠」公理的唯一实现处）。
 *   · NFC 规范化
 *   · **移除全部空白** —— 因此「妈妈生日」「妈妈 生日」「妈妈　生日」「 妈妈  生日 」
 *     四种写法得到同一颗种子，同一株植物。这条公理的存在理由是：中文里加不加空格
 *     纯属输入习惯，用户不会认为自己写了两件不同的事。
 *   · **不做**大小写折叠、**不**剥离标点 —— 「Mom」与「mom」在用户眼里是两段不同的
 *     文本，所见即所得优先于「聪明的归一化」。这条规则要写进帮助文档，
 *     因为用户一定会发现它。
 */
export const seedKey = (str) => String(str ?? '').normalize('NFC').replace(WS, '');

/** FNV-1a 32bit，逐字节处理 UTF-16 码元，中英文均稳定 */
export function hashString(str) {
  const s = seedKey(str);
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ ((c >>> 8) & 0xff), 0x01000193) >>> 0;
  }
  // 末尾雪崩，避免短字符串（如「1」「a」）种子过于接近
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32：小、快、分布好 */
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this._n = mulberry32(this.seed);
  }
  next() { return this._n(); }
  /** [a,b) 浮点 */
  range(a, b) { return a + (b - a) * this._n(); }
  /** [a,b] 整数 */
  int(a, b) { return a + Math.floor(this._n() * (b - a + 1)); }
  pick(arr) { return arr[Math.floor(this._n() * arr.length)]; }
  /** 权重挑选：weights 与 arr 等长 */
  pickWeighted(arr, weights) {
    const total = weights.reduce((s, w) => s + w, 0);
    let r = this._n() * total;
    for (let i = 0; i < arr.length; i++) { r -= weights[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  }
  bool(p = 0.5) { return this._n() < p; }
  /** 偏向中值的分布（两次取样求平均），用于「大多数植物是常态、少数是极端」 */
  centered(a, b) { return a + (b - a) * (this._n() + this._n()) / 2; }
  /** 有符号抖动 */
  jitter(amount) { return (this._n() * 2 - 1) * amount; }
}

/* ---------- 通用数学 ---------- */
export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t), 3);
export const easeInOutCubic = (t) => (t = clamp(t), t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** 轻微回弹，用于叶片展开 */
export const easeOutBack = (t) => {
  t = clamp(t); const c1 = 1.24, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
