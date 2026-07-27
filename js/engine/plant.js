/* 时间花园 · 植物骨架生成 + Canvas 渲染
 *
 * 两个阶段：
 *   1. buildSkeleton(genome) —— 纯几何，与时间无关，可缓存。
 *      每一段茎/每一片叶/每一朵花都带有 birth + span（它在生长时间轴上的出生时刻）。
 *   2. renderPlant(ctx, genome, g, opts) —— 给定生长值 g，逐元素求 e=(g-birth)/span，
 *      茎按弧长截断、叶按缩放展开、花按开度旋转。
 *      因此生长是「连续」的：任意 g 都是一帧合法的植物，没有阶段跳变。
 */

import { Rng, clamp, lerp, easeOutCubic, easeOutBack, smoothstep } from './rng.js';
import { STAGES } from './growth.js';

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

/* 渲染层微差的确定性哈希：输入取自种子与元素自身的几何身份（位置/自转量化），
 * 不依赖渲染顺序、不新增骨架状态——同一株植物任何一帧重绘都逐位一致。
 * 花瓣抖动、叶面噪声、土粒都从这里取值，全流程依旧零 Math.random()。 */
function hashU32(n) {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}
const hash01 = (n) => hashU32(n >>> 0) / 4294967296;
/** 元素身份：把局部坐标量化后混进种子 */
const elemKey = (seed, x, y, extra = 0) =>
  (seed ^ Math.imul(Math.round(x * 8192) & 0xffff, 0x85eb) ^ Math.imul(Math.round(y * 8192) & 0xffff, 0xc2b2) ^ Math.imul(extra & 0xffff, 0x27d4)) >>> 0;

/* 渲染时间轴的三个锚点直接取自 SPEC §2.3 的阶段边界，不另立参数 */
const STRUCTURE_START = STAGES[1].from;   // 0.15 萌芽：破土，地表开始有东西
const BUD_START = STAGES[3].from;         // 0.65 结蕾：花苞出现
const BLOOM_START = STAGES[4].from;       // 0.88 绽放：花瓣开始张开

/* ================= 骨架 ================= */

const skelCache = new Map();
export function skeletonFor(gn) {
  if (skelCache.has(gn.seed)) return skelCache.get(gn.seed);
  const s = buildSkeleton(gn);
  skelCache.set(gn.seed, s);
  return s;
}

/** 从起点按恒定曲率步进出一条茎的折线；angle: 0=向上，正=向右 */
function stemPolyline(x, y, angle, len, totalTurn, n = 14) {
  const pts = [{ x, y }];
  const step = len / n;
  let cx = x, cy = y, ca = angle;
  for (let i = 0; i < n; i++) {
    ca += totalTurn / n;
    cx += Math.sin(ca) * step;
    cy += Math.cos(ca) * step;
    pts.push({ x: cx, y: cy });
  }
  return { pts, endAngle: ca, endX: cx, endY: cy };
}

function buildSkeleton(gn) {
  const r = new Rng(gn.seed ^ 0x9e3779b9);
  const segs = [], leaves = [], blooms = [], tendrils = [];
  const ctxObj = { gn, r, segs, leaves, blooms, tendrils };

  switch (gn.archetype) {
    case 'succulent': buildRosette(ctxObj); break;
    case 'grass': buildGrass(ctxObj); break;
    case 'umbel': buildUmbel(ctxObj); break;
    case 'vine': buildVine(ctxObj); break;
    case 'shrub': buildBranching(ctxObj, 'shrub'); break;
    default: buildBranching(ctxObj, 'herb');
  }

  // 子叶：所有植物共有的两片，最早出现、中期枯萎——一个只有认真看才会发现的细节
  const cotW = gn.baseLength * 0.16;
  for (const side of [-1, 1]) {
    leaves.push({
      x: side * cotW * 0.25, y: cotW * 0.5, angle: side * 78 * D2R,
      len: cotW * 1.5, wid: cotW * 1.1, shape: 'ovate', curl: side * 0.1,
      birth: STRUCTURE_START, span: 0.055, cotyledon: true, depth: 0, serration: 0,
    });
  }

  /* 叶量硬上限：递归分枝的叶数是指数增长的，任何参数微调都挡不住。
   * 叶越大，允许的片数越少——这是「留白」的最后一道闸。 */
  const CAP = Math.round(44 * ({ palmate: 0.40, cordate: 0.52, ovate: 0.78, lance: 1.0, needle: 1.25 }[gn.leafShape] || 1));
  const body = leaves.filter((l) => !l.cotyledon && !l.rosette);
  if (body.length > CAP) {
    const stride = body.length / CAP;
    const keep = new Set();
    for (let i = 0; i < CAP; i++) keep.add(body[Math.floor(i * stride)]);
    for (let i = leaves.length - 1; i >= 0; i--) {
      const l = leaves[i];
      if (!l.cotyledon && !l.rosette && !keep.has(l)) leaves.splice(i, 1);
    }
  }

  /* 归一化生长时间轴，锚在 SPEC §2.3 的阶段边界上：
   *   v < 0.15  种子：地表无物（结构窗口从 0.15 开始，不是更早）
   *   v = 0.65  结蕾：花苞出现
   *   v = 0.88  绽放：花瓣开始张开
   *   v = 1.00  主花全开 */
  const maxDist = Math.max(0.001, ...segs.map((s) => s.dist + s.len));
  const t0 = STRUCTURE_START, t1 = gn.bloomStart;
  for (const s of segs) {
    const u = s.dist / maxDist;
    s.birth = lerp(t0, t1 * 0.94, u);
    s.span = Math.max(0.055, (t1 - t0) * (s.len / maxDist) * 1.5);
  }
  for (const lf of leaves) {
    if (lf.cotyledon) continue;
    const host = segs[lf.segIndex] || segs[0];
    lf.birth = host.birth + host.span * (0.25 + 0.65 * (lf.tAlong ?? 0.5));
    lf.span = 0.085;
  }
  // 花：按 rank 依次开放，主花在 v=1.0 恰好全开
  blooms.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  blooms.forEach((b, i) => {
    const host = segs[b.segIndex] || segs[0];
    b.budBirth = Math.max(BUD_START, host.birth + host.span * 0.7) + i * 0.012;
    b.budSpan = 0.14;
    b.openBirth = clamp(BLOOM_START + i * 0.028, BLOOM_START, 1.08);
    b.openSpan = 1 - BLOOM_START;
  });

  // 满开时的包围盒（用于统一缩放，保证生长过程中画框不跳动）
  const bb = measure(gn, { segs, leaves, blooms, tendrils });
  return { segs, leaves, blooms, tendrils, ...bb };
}

function measure(gn, sk) {
  let maxY = 0.001, minX = 0, maxX = 0;
  const acc = (x, y) => { if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; };
  for (const s of sk.segs) for (const p of s.pts) acc(p.x, p.y);
  for (const l of sk.leaves) {
    acc(l.x + Math.sin(l.angle) * l.len, l.y + Math.cos(l.angle) * l.len);
    acc(l.x - Math.sin(l.angle) * l.len * 0.2, l.y);
  }
  for (const b of sk.blooms) { acc(b.x + gn.bloomSize, b.y + gn.bloomSize * 1.2); acc(b.x - gn.bloomSize, b.y); }
  return { height: maxY, minX: minX - 0.02, maxX: maxX + 0.02 };
}

/* ---- 直立草本 / 木本灌木：递归分枝 ---- */
function buildBranching({ gn, r, segs, leaves, blooms }, kind) {
  const dirSign = gn.lean >= 0 ? 1 : -1;
  let rank = 0;

  function grow(x, y, angle, len, width, depth, dist) {
    const turn = (gn.curvature * (0.5 + 0.5 * r.next()) * dirSign) * (1 - depth * 0.12);
    const poly = stemPolyline(x, y, angle, len, turn, 13);
    const idx = segs.length;
    segs.push({ pts: poly.pts, w0: width, w1: width * gn.widthRatio, depth, len, dist });

    /* 叶只长在新枝上（老木是裸的），且叶片越大数量越少。
     * 「留白」不是省事，是植物真实的样子：一株枫不会长成一团苔。 */
    const leafy = kind === 'shrub' ? depth <= 1 : true;
    const bulk = { palmate: 0.42, cordate: 0.54, ovate: 0.76, lance: 1.0, needle: 1.2 }[gn.leafShape] || 0.8;
    const perAdj = gn.leafPerNode === 3 ? 0.55 : gn.leafPerNode === 2 ? 0.78 : 1;
    const density = kind === 'shrub' ? 0.62 : 0.42 + 0.17 * depth;   // 基部叶多、枝端叶少
    const nodes = leafy ? Math.max(2, Math.round(gn.internodes * density * bulk * perAdj)) : 0;
    for (let i = 1; i <= nodes; i++) {
      const t = i / (nodes + 0.6);
      const pi = Math.min(poly.pts.length - 1, Math.round(t * (poly.pts.length - 1)));
      const p = poly.pts[pi];
      const stemA = angle + turn * t;
      const per = gn.leafPerNode;
      for (let k = 0; k < per; k++) {
        const side = per === 1 ? (i % 2 === 0 ? 1 : -1) : per === 2 ? (k === 0 ? -1 : 1) : [-1, 1, 0.15][k];
        const spread = gn.leafAngle * D2R * (0.8 + 0.4 * r.next());
        const sizeFall = (0.72 + 0.11 * depth) * (1 - t * 0.14) * (kind === 'shrub' ? 0.92 : 1);
        leaves.push({
          x: p.x, y: p.y, segIndex: idx, tAlong: t,
          angle: stemA + side * spread,
          len: gn.leafLength * sizeFall * (0.82 + 0.36 * r.next()),
          wid: gn.leafLength * gn.leafWidthRatio * sizeFall * (0.9 + 0.2 * r.next()),
          shape: gn.leafShape, curl: gn.leafCurl * (side || 1),
          serration: gn.serration, depth, side, tone: r.range(-1, 1),
        });
      }
    }

    if (depth <= 0) {
      blooms.push({
        x: poly.endX, y: poly.endY, angle: poly.endAngle, segIndex: idx,
        rank: rank++, size: gn.bloomSize * (1 - depth * 0.1), spin: r.range(0, TAU),
      });
      return;
    }

    const nChild = kind === 'shrub' ? (depth >= 3 && r.bool(0.3) ? 3 : 2) : 2;
    for (let c = 0; c < nChild; c++) {
      const spreadIdx = nChild === 2 ? (c === 0 ? -1 : 1) : c - 1;
      let childAngle, childLen;
      if (kind === 'herb' && c === 0) {
        // 单轴分枝：主轴继续，侧枝退让 —— 草本的挺拔感来自这里
        childAngle = poly.endAngle + r.jitter(gn.angleJitter * D2R * 0.5);
        childLen = len * 0.84;
      } else {
        childAngle = poly.endAngle + spreadIdx * gn.branchAngle * D2R + r.jitter(gn.angleJitter * D2R);
        childLen = len * gn.lengthRatio * (0.88 + 0.24 * r.next());
      }
      grow(poly.endX, poly.endY, childAngle, childLen, width * gn.widthRatio, depth - 1, dist + len);
    }
  }

  grow(0, 0, gn.lean * 0.35, gn.baseLength, gn.baseWidth, gn.depth, 0);
  trimBlooms(blooms, gn.budCount);
}

/* ---- 藤蔓：一条向上抽出、随长度渐渐被自重压弯的长弧 ---- */
function buildVine({ gn, r, segs, leaves, blooms, tendrils }) {
  const dirSign = gn.lean >= 0 ? 1 : -1;
  let x = 0, y = 0, angle = gn.lean * 0.22, dist = 0, rank = 0;
  const n = gn.internodes;
  const segLen = gn.baseLength * 1.7 / Math.sqrt(n);
  // 单向累积的弯曲：越往上越弯，末端下垂——重力性，不是折线
  const bendUnit = gn.curvature * dirSign * 1.55 / n;
  for (let i = 0; i < n; i++) {
    const turn = bendUnit * (0.30 + 1.35 * (i / (n - 1 || 1))) + r.jitter(0.04);
    const poly = stemPolyline(x, y, angle, segLen, turn, 10);
    const idx = segs.length;
    const w = gn.baseWidth * (1 - i / (n * 1.5));
    segs.push({ pts: poly.pts, w0: w, w1: w * 0.9, depth: 0, len: segLen, dist });
    const stemA = angle + turn * 0.6;
    const side = i % 2 === 0 ? 1 : -1;
    const fall = 1 - i / (n * 2.4);
    // 叶柄外展后被重力拉下
    const droop = 0.34 * Math.abs(Math.sin(stemA));
    leaves.push({
      x: poly.pts[6].x, y: poly.pts[6].y, segIndex: idx, tAlong: 0.6,
      angle: stemA + side * gn.leafAngle * D2R + side * droop,
      len: gn.leafLength * fall, wid: gn.leafLength * gn.leafWidthRatio * fall,
      shape: gn.leafShape, curl: gn.leafCurl * side, serration: gn.serration,
      depth: 0, side, tone: r.range(-1, 1),
    });
    if (i >= 1 && i % 2 === 1 && rank < gn.budCount) {
      blooms.push({
        x: poly.pts[9].x, y: poly.pts[9].y, angle: stemA - side * 0.62, segIndex: idx,
        rank: rank++, size: gn.bloomSize * (0.85 + 0.3 * r.next()), spin: r.range(0, TAU),
      });
    }
    if (i % 3 === 2) {
      tendrils.push({ x: poly.endX, y: poly.endY, angle: stemA - side * 1.1, size: segLen * 0.45, segIndex: idx, dir: side });
    }
    x = poly.endX; y = poly.endY; angle = poly.endAngle; dist += segLen;
  }
  blooms.push({ x, y, angle, segIndex: segs.length - 1, rank: rank++, size: gn.bloomSize * 1.1, spin: r.range(0, TAU) });
}

/* ---- 伞形：裸茎 + 顶端复伞状花序 ---- */
function buildUmbel({ gn, r, segs, leaves, blooms }) {
  const total = gn.baseLength * 2.1;
  const poly = stemPolyline(0, 0, gn.lean * 0.25, total, gn.curvature * 0.6, 16);
  segs.push({ pts: poly.pts, w0: gn.baseWidth, w1: gn.baseWidth * 0.55, depth: 0, len: total, dist: 0 });
  // 基生叶
  for (let i = 0; i < 4; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const t = 0.06 + i * 0.09;
    const p = poly.pts[Math.round(t * (poly.pts.length - 1))];
    leaves.push({
      x: p.x, y: p.y, segIndex: 0, tAlong: t, angle: side * (52 + i * 9) * D2R,
      len: gn.leafLength * (1.25 - i * 0.14), wid: gn.leafLength * gn.leafWidthRatio * (1.2 - i * 0.14),
      shape: gn.leafShape, curl: side * 0.34, serration: gn.serration, depth: 0, side,
    });
  }
  // 花梗放射
  const n = gn.budCount;
  const pedLen = gn.bloomSize * 4.2;
  for (let i = 0; i < n; i++) {
    const a = lerp(-1.05, 1.05, n === 1 ? 0.5 : i / (n - 1)) + r.jitter(0.06);
    const L = pedLen * (0.72 + 0.4 * Math.cos(a * 0.9)) * (0.9 + 0.2 * r.next());
    const pp = stemPolyline(poly.endX, poly.endY, poly.endAngle + a, L, a * 0.32, 6);
    segs.push({ pts: pp.pts, w0: gn.baseWidth * 0.24, w1: gn.baseWidth * 0.16, depth: 1, len: L, dist: total });
    blooms.push({
      x: pp.endX, y: pp.endY, angle: pp.endAngle, segIndex: segs.length - 1,
      rank: n - Math.abs(i - (n - 1) / 2), size: gn.bloomSize, spin: r.range(0, TAU), floret: true,
    });
  }
}

/* ---- 多肉莲座：分层叶轮（斜上方视角）+ 细高花箭
 * 先试过黄金角极坐标投影，结果是一片趴着的三叶草——真正的莲座在二维里
 * 靠的是「一圈套一圈、每圈更短更立」的层叠，而不是数学上的螺旋。 */
function buildRosette({ gn, r, segs, leaves, blooms }) {
  const R = gn.baseLength * 1.22;
  const cy = R * 0.16;
  const TIERS = [
    { n: 8, len: 1.00, y: 0.02, spread: 1.36 },
    { n: 7, len: 0.76, y: 0.13, spread: 1.14 },
    { n: 5, len: 0.54, y: 0.24, spread: 0.90 },
    { n: 3, len: 0.33, y: 0.32, spread: 0.60 },
  ];
  const total = TIERS.reduce((s, t) => s + t.n, 0);
  let idx = 0;
  TIERS.forEach((T, ti) => {
    for (let i = 0; i < T.n; i++) {
      const u = T.n === 1 ? 0 : (i / (T.n - 1)) * 2 - 1;
      const a = u * T.spread + (ti % 2 ? 0.17 : 0) + gn.lean * 0.25 + r.jitter(0.05);
      const len = R * T.len * (0.92 + 0.16 * r.next());
      leaves.push({
        x: Math.sin(a) * R * 0.11, y: cy + T.y * R + Math.cos(a) * R * 0.05,
        segIndex: 0, tAlong: idx / total,
        angle: a,
        len, wid: len * gn.leafWidthRatio * 0.86,
        shape: 'succ', curl: 0.20 + ti * 0.07, serration: 0, depth: 0,
        side: a >= 0 ? 1 : -1,
        // 外圈先画（更老更暗），同圈里越朝观者的越靠前
        order: ti + Math.abs(u) * 0.42,
        rosette: true, tone: -1.7 + (3.4 * ti) / (TIERS.length - 1),
      });
      idx++;
    }
  });
  segs.push({ pts: [{ x: 0, y: 0 }, { x: 0, y: cy }], w0: R * 0.24, w1: R * 0.18, depth: 0, len: cy, dist: 0, hidden: true });
  // 花箭：从莲座心里抽出的一根细高弧
  const spikeLen = R * 4.1;
  const sp = stemPolyline(R * 0.06, cy + R * 0.24, 0.26 + gn.lean, spikeLen, 0.55, 14);
  segs.push({ pts: sp.pts, w0: R * 0.05, w1: R * 0.030, depth: 1, len: spikeLen, dist: R * 0.3 });
  const bc = gn.budCount;
  for (let i = 0; i < bc; i++) {
    const t = 0.52 + (i / Math.max(1, bc - 1)) * 0.48;
    const pi = Math.round(t * (sp.pts.length - 1));
    blooms.push({
      x: sp.pts[pi].x, y: sp.pts[pi].y, angle: sp.endAngle + (i % 2 ? 0.5 : -0.4),
      segIndex: segs.length - 1, rank: i, size: gn.bloomSize * 0.85, spin: r.range(0, TAU),
    });
  }
}

/* ---- 禾本：弧形叶丛 + 花穗 ---- */
function buildGrass({ gn, r, segs, leaves, blooms }) {
  const n = gn.leafCount;
  const H = gn.baseLength * 1.5;
  for (let i = 0; i < n; i++) {
    const k = (i / (n - 1 || 1)) * 2 - 1;
    const lean = k * 0.9 + gn.lean * 0.4 + r.jitter(0.12);
    const L = H * (0.72 + 0.42 * (1 - Math.abs(k)) + r.jitter(0.1));
    // 禾本的「叶」就是茎本身：一片从基部抽出、渐尖、被自重压弯的线形叶
    const poly = stemPolyline(k * H * 0.045, 0, lean * 0.55, L, lean * gn.curvature * 1.5 + Math.sign(lean || 1) * 0.42, 16);
    segs.push({
      pts: poly.pts, w0: H * (0.040 + 0.028 * gn.leafWidthRatio * 8), w1: H * 0.0015,
      depth: 0, len: L, dist: Math.abs(k) * H * 0.12, blade: true, tone: r.range(-1, 1),
    });
  }
  const culms = gn.budCount;
  for (let i = 0; i < culms; i++) {
    const lean = (i - (culms - 1) / 2) * 0.16 + gn.lean * 0.3;
    const L = H * (1.45 + 0.16 * i);
    const poly = stemPolyline(lean * H * 0.1, 0, lean, L, lean * 0.5 + 0.2, 14);
    segs.push({ pts: poly.pts, w0: H * 0.012, w1: H * 0.007, depth: 1, len: L, dist: H * 0.2 });
    blooms.push({
      x: poly.endX, y: poly.endY, angle: poly.endAngle, segIndex: segs.length - 1,
      rank: culms - i, size: gn.bloomSize * (1 + i * 0.05), spin: r.range(0, TAU),
    });
  }
}

function trimBlooms(blooms, maxN) {
  if (blooms.length <= maxN) return;
  blooms.sort((a, b) => b.y - a.y);
  blooms.length = maxN;
}

/* ================= 调色 ================= */

const hsl = (h, s, l, a = 1) => `hsla(${h.toFixed(1)},${clamp(s, 0, 100).toFixed(1)}%,${clamp(l, 0, 100).toFixed(1)}%,${a})`;

/**
 * @param lift 前景提亮（L）：花园近排/详情英雄株把叶面从草地上抬起来的量，
 *             只作用于 live 模式；0 = 旧行为（金样默认档）。
 * @param fog  大气透视（美术二期）：0 近景 … 1 远景。距离越远，饱和/对比
 *             越向雾色（fogHsl，通常取 sky.hor）衰减——远排植物退进空气，
 *             不再靠 alpha 半透明「变鬼」。金样 case 不传（=0，无影响）。
 * @param fogHsl 雾色 [h,s,l]；仅 fog>0 时使用。
 */
export function plantPalette(gn, theme = 'light', mode = 'live', ambient = 1, lift = 0, fog = 0, fogHsl = null) {
  const dark = theme === 'dark';
  let lh = gn.leafHue, ls = gn.leafSat, ll = gn.leafLight;
  let ph = gn.hueA, ps = gn.satA, pl = gn.litA;
  let ch = gn.hueB, cs = gn.satB, cl = gn.litB;

  if (mode === 'pressed') {
    // 压制标本：脱水、褪色、偏向纸与赭
    ls *= 0.19; ll = lerp(ll, 51, 0.56); lh = lerp(lh, 46, 0.60);
    ps *= 0.25; pl = lerp(pl, 69, 0.55); ph = lerp(ph, 30, 0.46);
    cs *= 0.24; cl = lerp(cl, 64, 0.55);
  } else {
    /* 色彩成熟化（美术二期，对标 docs/art-target）：基因给出的叶/花色
     * 先过一道「gouache 调色刀」——叶色相向 sage 橄榄收敛（保留种间跨度）、
     * 饱和整体压 ~20%，花瓣/花心饱和同步收。糖果感由此退场；
     * 基因维度与取值域零改动，这是渲染层的显色转换。 */
    lh = lerp(lh, 106, 0.26);
    ls = ls * 0.74;
    ps = ps * 0.82;
    cs = cs * 0.88;
    /* 浦肯野效应：光线变暗时人眼对绿的敏感度下降、对蓝上升。
     * 所以夜里叶子变冷变暗，而花色相对更显眼——这是真实的视觉现象，
     * 也正好让「哪一株快开了」在夜里依然一眼可辨。 */
    const k = clamp(ambient, 0.3, 1);
    const night = 1 - k;
    lh = lerp(lh, 196, night * 0.55);
    /* 白昼提亮：叶在日光下整体 +5L，与草地压暗（sky.js meadowNear）共同拉开
     * 前景植物与地面的对比（盲评 P0-1：叶/地 1.04 → 目标 ≥3.0）。 */
    ls = ls * lerp(1, 0.52, night);
    ll = ll * lerp(1, 0.60, night) + (dark ? 11 * k + 8 : 5 * k) + lift * lerp(1, 0.4, night);
    ps = ps * lerp(1, 0.86, night);
    pl = pl * lerp(1, 0.80, night) + (dark ? 10 : 0);
    cl = cl * lerp(1, 0.82, night) + (dark ? 8 : 0);
    if (dark) { pl = Math.min(pl + 4, 82); cl = Math.min(cl, 80); }
    /* 大气透视：远景株整体向雾色收敛——去饱和、明度靠拢雾、对比衰减。
     * 只在 live 模式生效（标本无所谓远近）。 */
    if (fog > 0 && fogHsl) {
      const t = clamp(fog);
      ls *= 1 - t * 0.55;
      ll = lerp(ll, fogHsl[2], t * 0.50);
      ps *= 1 - t * 0.45;
      pl = lerp(pl, fogHsl[2], t * 0.38);
      cs *= 1 - t * 0.40;
      cl = lerp(cl, fogHsl[2], t * 0.30);
    }
  }

  return {
    dark, mode,
    /** 在叶色基础上偏移，用于逐叶的微差——一丛叶子不该是同一个色块 */
    tint: (dh = 0, dl = 0, ds = 0) => hsl(lh + dh, ls + ds, ll + dl),
    /** 花瓣微差：逐瓣色相/明度偏移（盲评 P0-3：花不许克隆） */
    petalT: (dh = 0, dl = 0) => hsl(ph + dh, ps, clamp(pl + dl, 4, 96)),
    petalDeepT: (dh = 0, dl = 0) => hsl(ph - 4 + dh, ps + 8, clamp(pl - 15 + dl, 4, 96)),
    petalLightT: (dh = 0, dl = 0) => hsl(ph + 5 + dh, ps - 6, clamp(Math.min(pl + 11, 96) + dl, 4, 97)),
    stem: hsl(lh - 4, ls + 4, ll - 5),
    stemDark: hsl(lh - 6, ls + 8, ll - 13),
    leafA: hsl(lh, ls, ll),
    /* 叶尖端色：径向渐变的亮端（盲评 P0-1/P0-3）。美术二期从 +20L 收到 +17L：
     * 亮端过曝是「粉薄荷糖果感」的元凶之一。 */
    leafB: hsl(lh + 10, ls - 4, ll + 17),
    leafEdge: dark ? hsl(lh + 10, ls * 0.7, ll + 32, 0.56) : hsl(lh - 8, ls + 14, ll - 17, 0.55),
    /** 深色迎光叶缘的月光 rim（盲评 P1-11：迎光侧 +0.15 alpha） */
    rim: hsl(lh + 14, ls * 0.55, Math.min(ll + 40, 90), 0.30),
    vein: dark ? hsl(lh + 8, ls - 4, ll + 20, 0.32) : hsl(lh - 6, ls + 8, ll - 11, 0.34),
    cot: hsl(lh + 14, ls - 2, ll + 16),
    petal: hsl(ph, ps, pl),
    petalDeep: hsl(ph - 4, ps + 8, pl - 15),
    petalLight: hsl(ph + 5, ps - 6, Math.min(pl + 11, 96)),
    // 近白的花在浅色背景上会消失，所以越淡的花，轮廓越要压得下去
    petalEdge: dark
      ? hsl(ph + 4, ps, Math.min(pl + 20, 92), 0.4)
      : hsl(ph - 6, ps + 14, pl - (pl > 78 ? 34 : 24), pl > 78 ? 0.58 : 0.42),
    center: hsl(ch, cs, cl),
    centerDeep: hsl(ch - 6, cs + 6, cl - 18),
    bud: hsl(lerp(lh, ph, 0.42), lerp(ls, ps, 0.4), lerp(ll, pl, 0.35)),
    glow: hsl(ph, Math.min(ps + 10, 90), Math.min(pl + 12, 80), dark ? 0.30 : 0.16),
    seedCoat: hsl(28, 26, dark ? 40 : 30),
  };
}

/* ================= 几何工具 ================= */

function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

/** 按弧长比例截断折线，用于连续伸长 */
function truncate(pts, e) {
  if (e >= 1) return pts;
  const total = polyLength(pts);
  const target = total * e;
  if (target <= 0) return [pts[0]];
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + d >= target) {
      const t = (target - acc) / d;
      out.push({ x: lerp(pts[i - 1].x, pts[i].x, t), y: lerp(pts[i - 1].y, pts[i].y, t) });
      return out;
    }
    acc += d; out.push(pts[i]);
  }
  return out;
}

/** 变宽描边：转成多边形填充，比 lineWidth 描边自然得多 */
function taperedPath(ctx, pts, w0, w1, T) {
  if (pts.length < 2) return false;
  const n = pts.length;
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y;
    const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
    const w = lerp(w0, w1, i / (n - 1)) / 2;
    L.push(T(pts[i].x - dy * w, pts[i].y + dx * w));
    R.push(T(pts[i].x + dy * w, pts[i].y - dx * w));
  }
  ctx.beginPath();
  ctx.moveTo(L[0][0], L[0][1]);
  for (let i = 1; i < n; i++) ctx.lineTo(L[i][0], L[i][1]);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
  ctx.closePath();
  return true;
}

/* 叶片宽度剖面 */
const LEAF_PROFILE = {
  ovate: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.82)), 0.78),
  lance: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.58)), 1.15),
  cordate: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.50)), 0.60),
  palmate: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.70)), 0.80),
  needle: (t) => Math.pow(Math.sin(Math.PI * t), 0.32),
  succ: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 1.22)), 0.62),
  blade: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.38),
};

/** 在局部坐标系（+x 为叶尖方向）生成叶片轮廓。
 * N 从 24 升到 40（盲评 P0-3：叶缘从折线升到曲线采样），
 * 返回上下两半，供双侧明暗与月光 rim 使用。 */
function leafOutline(len, wid, shape, curl, serration, N = 40) {
  const prof = LEAF_PROFILE[shape] || LEAF_PROFILE.ovate;
  const mid = (t) => curl * len * Math.sin(t * Math.PI * 0.82);
  const top = [], bot = [];
  const teeth = shape === 'needle' || shape === 'blade' || shape === 'succ' ? 0 : serration;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let w = prof(t) * wid * 0.5;
    if (teeth) w *= 1 + teeth * 0.11 * Math.sin(t * Math.PI * 9.5);
    const m = mid(t);
    top.push([t * len, m - w]);
    bot.push([t * len, m + w]);
  }
  return { pts: top.concat([...bot].reverse()), top, bot };
}

/** 心形叶：基部两个圆耳夹一道凹口，向尖端收拢 */
function cordateOutline(len, wid, curl, N = 36) {
  const mid = (t) => curl * len * Math.sin(t * Math.PI * 0.82);
  const w = (t) => Math.pow(Math.sin(Math.PI * (0.17 + 0.83 * Math.pow(t, 0.78))), 0.72) * wid * 0.5;
  const top = [], bot = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    top.push([t * len, mid(t) - w(t)]);
    bot.push([t * len, mid(t) + w(t)]);
  }
  return { pts: [[len * 0.17, 0], ...top, ...[...bot].reverse()], top, bot };
}

/** 平滑闭合路径：过相邻中点的二次贝塞尔链——折线感的最后一道消除 */
function traceSmooth(ctx, pts) {
  const n = pts.length;
  ctx.beginPath();
  if (n < 3) {
    if (n) { ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]); }
    return;
  }
  ctx.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
  for (let i = 1; i <= n; i++) {
    const p = pts[i % n], q = pts[(i + 1) % n];
    ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  ctx.closePath();
}

/** 平滑开放折线（叶缘 rim / 噪声条带用） */
function traceSmoothOpen(ctx, pts) {
  const n = pts.length;
  ctx.beginPath();
  if (!n) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < n - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
}

/** 掌裂叶：极坐标轮廓，用一条余弦刻出 3/5/7 个裂片（枫、常春藤那一类） */
function palmateOutline(len, wid, lobes, curl, N = 72) {
  const spread = 1.16;
  const pts = [[0, 0]];
  for (let i = 0; i <= N; i++) {
    const k = -1 + (2 * i) / N;                 // -1..1
    const th = k * spread;
    const lobe = Math.pow(Math.abs(Math.cos((k * lobes * Math.PI) / 2)), 0.58);
    const taper = 0.72 + 0.28 * Math.cos(k * 1.35);   // 中央裂片最长
    const rad = len * (0.40 + 0.60 * lobe) * taper;
    pts.push([Math.cos(th) * rad, Math.sin(th) * rad * (wid / len) * 1.05 + curl * len * 0.22 * (1 - Math.abs(k))]);
  }
  return pts;
}

/* ================= 渲染 ================= */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} gn  基因组
 * @param {number} g   生长值（0..1.2，>1 为长青期）
 * @param {object} o   {x,y,scale,time,theme,mode,alpha,detail}
 */
export function renderPlant(ctx, gn, g, o = {}) {
  const sk = skeletonFor(gn);
  const {
    y = 0, scale = 100, time = 0, theme = 'light',
    mode = 'live', alpha = 1, detail = 1, reduceMotion = false, centerX = false,
    petalStagger = 0,
  } = o;
  const pal = o.palette || plantPalette(gn, theme, mode);
  const S = scale / sk.height;   // 统一到目标像素高度
  const x = (o.x ?? 0) - (centerX ? ((sk.minX + sk.maxX) / 2) * S : 0);

  /* 方向光（美术二期）：单一光源与天空时段联动（app 层传 sky 派生的 light），
   * 决定叶的受光/背光面、花瓣朝向明暗、逆光 rim 与次表面透光。
   * 无 light（分享卡/标本/缩略）时用默认左上光——版式光，不是时刻光。
   * 纯参数驱动，零随机——同株同时刻逐位一致。 */
  const light = mode === 'pressed'
    ? { x: -0.3, y: 0.9, warm: 0, k: 0.0, moon: false }
    : (o.light || { x: -0.35, y: 0.78, warm: 0.22, k: 1, moon: false });
  // 光的屏幕方位角：0 = 正上方，正 = 偏右（与叶/花的 angle 同规约）
  const lightA = Math.atan2(light.x, Math.max(light.y, 0.05));
  const lightPow = light.k * (light.moon ? 0.5 : 1);   // 月光下明暗差减半

  /* LOD：74px 高的一株禾本，如果照着近景的画法缩小，只会剩顶部一个色点。
   * 所以远景改为「轮廓特征优先」：茎加粗到最小可视线宽、花朵放大、
   * 穗状花序退化为实心穗形、过小的叶直接不画。
   * 花朵在远处比真实比例大——辨识度优先于比例正确，这是 LOD 的常规取舍。 */
  const lodK = clamp(scale / 185);                       // 0 = 最远，1 = 近景
  const wFloorPx = lerp(1.75, 0.55, lodK);               // 最小可视线宽（px）
  const bloomBoost = lerp(1.42, 1.0, lodK);              // 远景花朵放大
  const bladeBoost = lerp(2.0, 1.0, lodK);               // 远景叶片/草叶加粗
  const minLeafPx = lerp(3.4, 0.4, lodK);                // 小于此像素长度的叶不画
  const lod = { lodK, wFloorPx, bloomBoost, bladeBoost, minLeafPx, simplify: lodK < 0.55 };
  const detailK = Math.min(detail, lerp(0.25, 1, clamp((scale - 70) / 120)));

  // 摇曳：高处摆得多，每株相位不同 → 一片花园不会像节拍器
  const swayK = reduceMotion || mode === 'pressed'
    ? 0
    : gn.swayAmp * Math.sin((time / gn.swayPeriod) * TAU + gn.swayPhase) * clamp(g, 0.2, 1.05);
  const sway = (uy) => swayK * Math.pow(clamp(uy / sk.height, 0, 1), 1.4) * sk.height;
  const T = (ux, uy) => [x + (ux + sway(uy)) * S, y - uy * S];

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  drawSoilMound(ctx, T, S, g, pal, gn);
  if (g < STRUCTURE_START * 0.62) { ctx.restore(); return; }

  /* 茎锥度（盲评 P0-3）：按「到根的弧长」给整株一条 1.35 → 0.55 的宽度包络。
   * 只作用在渲染宽度上，骨架的 w0/w1 原封不动——金样骨架摘要不受影响。 */
  const maxDist = Math.max(1e-4, ...sk.segs.map((sg) => sg.dist + sg.len));
  const taperAt = (d) => lerp(1.35, 0.55, Math.pow(clamp(d / maxDist), 0.9));

  // 茎（后景枝先画）
  const segsSorted = [...sk.segs].sort((a, b) => (b.depth - a.depth));
  for (const s of segsSorted) {
    if (s.hidden) continue;
    const e = clamp((g - s.birth) / s.span);
    if (e <= 0.001) continue;
    const pts = truncate(s.pts, easeOutCubic(e));
    if (pts.length < 2) continue;
    const bb = s.blade ? lod.bladeBoost : 1;
    const tp0 = s.blade ? 1 : taperAt(s.dist);
    const tp1 = s.blade ? 1 : taperAt(s.dist + s.len * easeOutCubic(e));
    const w = Math.max(lod.wFloorPx / S, s.w0 * bb * tp0);
    if (!taperedPath(ctx, pts, w, Math.max(lod.wFloorPx * 0.55 / S, s.w1 * bb * tp1 * lerp(0.5, 1, e)), T)) continue;
    if (s.blade) {
      const [x0, y0] = T(pts[0].x, pts[0].y);
      const [x1, y1] = T(pts[pts.length - 1].x, pts[pts.length - 1].y);
      const gd = ctx.createLinearGradient(x0, y0, x1, y1);
      const tn = (s.tone || 0) * 6;
      gd.addColorStop(0, pal.tint(-4, -6 + tn));
      gd.addColorStop(1, pal.tint(10, 15 + tn));
      ctx.fillStyle = gd;
      ctx.fill();
      ctx.strokeStyle = pal.leafEdge; ctx.lineWidth = 0.6; ctx.stroke();
      continue;
    }
    if (o.thumb) { ctx.fillStyle = pal.stemDark; ctx.fill(); continue; }
    // 主干纵向渐变：基部沉、梢部接近叶色——折线茎读成圆柱的最后一步
    const [bx0, by0] = T(pts[0].x, pts[0].y);
    const [bx1, by1] = T(pts[pts.length - 1].x, pts[pts.length - 1].y);
    const sg = ctx.createLinearGradient(bx0, by0, bx1, by1);
    const c0 = s.depth > 0 ? pal.stem : pal.stemDark;
    sg.addColorStop(0, c0);
    sg.addColorStop(1, pal.tint(2, 4, 2));
    ctx.fillStyle = detailK > 0.35 ? sg : c0;
    ctx.fill();
    if (pal.dark && detailK > 0.5) { ctx.strokeStyle = pal.leafEdge; ctx.lineWidth = 0.5; ctx.stroke(); }
  }

  // 卷须
  for (const td of sk.tendrils || []) {
    const host = sk.segs[td.segIndex];
    const e = clamp((g - (host.birth + host.span * 0.8)) / 0.1);
    if (e <= 0.01 || lod.simplify || o.thumb) continue;
    drawTendril(ctx, T, S, td, e, pal);
  }

  // 叶：莲座按 order 排序（外老内新叠压），其余按深度
  let leavesSorted = [...sk.leaves].sort((a, b) =>
    (a.rosette && b.rosette) ? (a.order - b.order) : (b.depth - a.depth) || (a.y - b.y));
  if (o.thumb) {
    // 缩略 LOD（盲评 P2-13）：40×44 里叶脉描边只会糊成墨点——只留 6 片最大的叶做剪影
    leavesSorted = leavesSorted
      .filter((l) => !l.cotyledon)
      .sort((a, b) => (b.len * b.wid) - (a.len * a.wid))
      .slice(0, 6);
  }
  for (const lf of leavesSorted) {
    let e = clamp((g - lf.birth) / lf.span);
    if (e <= 0.001) continue;
    let fade = 1;
    if (lf.cotyledon) { fade = 1 - smoothstep(clamp((g - 0.38) / 0.20)); if (fade <= 0.02) continue; }
    if (lf.len * e * S < lod.minLeafPx) continue;
    /* 冠层自遮挡（美术二期）：低处、深处的叶被上方冠层荫蔽——
     * 用「分枝深度 + 离地高度」近似遮挡量，把叶基色整体压沉。
     * 莲座叶自带 tone 层次，遮挡减半以免整盘发黑。 */
    let shade = 0;
    if (!lf.cotyledon && mode !== 'pressed') {
      shade = clamp((lf.depth ?? 0) * 0.13 + (1 - (lf.y + lf.len * 0.5) / sk.height) * 0.30 - 0.10, 0, 0.5)
        * lerp(0.5, 1, lightPow) * (lf.rosette ? 0.5 : 1);
    }
    drawLeaf(ctx, T, S, gn, lf, easeOutBack(e), pal, fade, o.thumb ? 0 : detailK, lod, light, lightA, shade);
  }

  // 花
  if (o.thumb) {
    // 缩略 LOD：只画主花的一枚色块，读「有花/什么色」，不读结构
    const b = sk.blooms[0];
    if (b) {
      const bud = clamp((g - b.budBirth) / b.budSpan);
      if (bud > 0.001) {
        const open = clamp((g - b.openBirth) / b.openSpan);
        const [bx, by] = T(b.x, b.y);
        const rr = b.size * S * lod.bloomBoost * (0.55 + 0.65 * Math.max(open, bud * 0.4));
        ctx.beginPath(); ctx.arc(bx, by, Math.max(rr, 1.6), 0, TAU);
        ctx.fillStyle = open > 0.02 ? pal.petal : pal.bud;
        ctx.fill();
      }
    }
  } else {
    for (const b of sk.blooms) {
      const bud = clamp((g - b.budBirth) / b.budSpan);
      if (bud <= 0.001) continue;
      const open = clamp((g - b.openBirth) / b.openSpan);
      drawBloom(ctx, T, S, gn, b, bud, open, pal, detailK, petalStagger, lod, light, lightA, lightPow);
    }
  }

  ctx.restore();
}

function drawSoilMound(ctx, T, S, g, pal, gn) {
  if (g > STRUCTURE_START + 0.10) return;
  const fade = 1 - smoothstep(clamp((g - STRUCTURE_START) / 0.10));
  const w = gn.baseLength * 0.42, h = gn.baseLength * 0.13;
  const [cx, cy] = T(0, 0);
  ctx.save();
  ctx.globalAlpha *= fade;
  ctx.beginPath();
  ctx.ellipse(cx, cy - h * S * 0.35, w * S, h * S, 0, Math.PI, 0);
  ctx.fillStyle = pal.dark ? 'hsla(26,22%,22%,0.85)' : 'hsla(26,30%,34%,0.7)';
  ctx.fill();
  // 土丘颗粒：6–10 个，位置/明暗取自种子（盲评 P2-16）
  const gc = 6 + (hashU32(gn.seed ^ 0x51ed) % 5);
  for (let i = 0; i < gc; i++) {
    const u = hash01(gn.seed + 41 + i * 17), v = hash01(gn.seed + 42 + i * 17);
    const gx = (u * 2 - 1) * w * 0.80, gy = -h * (0.25 + v * 0.62);
    const gr = w * (0.035 + 0.04 * hash01(gn.seed + 43 + i * 17));
    ctx.beginPath();
    ctx.ellipse(cx + gx * S, cy + gy * S, gr * S, gr * S * 0.62, u * 2, 0, TAU);
    ctx.fillStyle = v > 0.5
      ? (pal.dark ? 'hsla(28,20%,34%,0.5)' : 'hsla(30,26%,48%,0.5)')
      : (pal.dark ? 'hsla(24,24%,14%,0.55)' : 'hsla(24,30%,24%,0.4)');
    ctx.fill();
  }
  if (g < STRUCTURE_START) {
    /* 半埋的种子；SPEC：种子期（v<0.15）地表无物。
     * 两帧过渡（盲评 P2-16）：前半程深埋只露肩，后半程上浮并裂口。 */
    const t = clamp(g / STRUCTURE_START);
    const risen = smoothstep(clamp((t - 0.30) / 0.55));
    const sy = cy - h * S * (0.55 + 0.45 * risen);
    ctx.beginPath();
    ctx.ellipse(cx, sy, w * S * 0.22, w * S * 0.30, 0.4, 0, TAU);
    ctx.fillStyle = pal.seedCoat;
    ctx.fill();
    // 种皮高光：受光肩部一枚小亮斑
    ctx.beginPath();
    ctx.ellipse(cx - w * S * 0.075, sy - w * S * 0.12, w * S * 0.065, w * S * 0.11, 0.5, 0, TAU);
    ctx.fillStyle = pal.dark ? 'hsla(40,24%,62%,0.30)' : 'hsla(40,36%,70%,0.45)';
    ctx.fill();
    if (t > 0.55) { // 裂口
      ctx.beginPath();
      ctx.moveTo(cx - w * S * 0.1, sy - h * S * 0.5);
      ctx.lineTo(cx + w * S * 0.06, sy - h * S * 1.0);
      ctx.strokeStyle = pal.leafB; ctx.lineWidth = Math.max(1, w * S * 0.09);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawTendril(ctx, T, S, td, e, pal) {
  const N = 22, turns = 2.4 * e;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = td.angle + t * turns * TAU * 0.35 * td.dir;
    const rad = td.size * (0.5 - 0.34 * t);
    const px = td.x + Math.sin(td.angle) * td.size * t * 0.7 + Math.sin(a) * rad * t;
    const py = td.y + Math.cos(td.angle) * td.size * t * 0.7 + Math.cos(a) * rad * t * 0.6;
    const [sx, sy] = T(px, py);
    i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
  }
  ctx.strokeStyle = pal.stem;
  ctx.lineWidth = Math.max(0.7, td.size * S * 0.055);
  ctx.stroke();
}

/* 叶片渲染（盲评 P0-3 的主战场 + 美术二期光照模型）：
 *   · 填色从「双色线性渐变」升级为基部→尖端的径向渐变（基部沉、尖端亮）
 *   · 双侧明暗从「几何朝上=亮」升级为方向光驱动：受光半亮暖、背光半沉冷，
 *     强度随光强连续变化（正午对比强、夜里近乎无向）
 *   · 冠层自遮挡（shade 参数）：荫蔽叶整体压沉——叶投影到下方叶的近似
 *   · 低日头逆光时受光缘描金橙 rim（次表面透光的边缘读数）
 *   · 8–12% 幅度的确定性明度噪声条带，消灭 std≈0.002 的扁涂
 *   · 轮廓从 lineTo 折线升为过中点的二次贝塞尔链（采样 N=40）
 *   · 深色模式迎光叶缘加月光 rim
 * 全部微差从 elemKey(种子, 叶位置) 哈希取值——骨架不动，帧帧一致。 */
const DEF_LIGHT = { x: -0.35, y: 0.78, warm: 0.22, k: 1, moon: false };
function drawLeaf(ctx, T, S, gn, lf, e, pal, fade, detail, lod = null, light = DEF_LIGHT, lightA = -0.42, shade = 0) {
  const grow = clamp(e);
  const len = lf.len * grow, wid = lf.wid * grow;
  if (len < 0.0005) return;
  const [ax, ay] = T(lf.x, lf.y);
  ctx.save();
  ctx.globalAlpha *= fade;
  ctx.translate(ax, ay);
  // 单位空间 y 向上 → 屏幕 y 向下；angle 以「向上」为 0
  ctx.rotate(lf.angle - Math.PI / 2);
  ctx.scale(S, -S);

  const tone = lf.tone || 0;
  const lid = elemKey(gn.seed, lf.x, lf.y, Math.round((lf.angle + 9) * 512));
  const px = len * S;                       // 叶的屏幕长度，决定要不要画贵的细节
  const rich = detail > 0.5 && px > 9;

  // 径向渐变：基部沉、中段本色偏亮、尖端亮（leafB 已抬到 +20L）；
  // 冠层遮挡把三段整体压沉（-10L·shade），荫蔽叶略偏冷
  const shDl = -shade * 10, shDh = -shade * 4;
  const cBase = lf.cotyledon ? pal.cot : pal.tint(-4 + shDh, tone * 5.5 - 5 + shDl, 7);
  const cMid = lf.cotyledon ? pal.cot : pal.tint(2 + shDh, tone * 5.5 + 6 + shDl);
  const cTip = lf.cotyledon ? pal.cot : pal.tint(10 + shDh, tone * 5.5 + 18 + shDl * 0.7, -4);
  const fillGrad = () => {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(len, 1e-4));
    g.addColorStop(0, cBase); g.addColorStop(0.52, cMid); g.addColorStop(1, cTip);
    return g;
  };

  if (lf.shape === 'palmate') {
    const ol = palmateOutline(len, wid, gn.palmateLobes || 5, lf.curl);
    const path = () => traceSmooth(ctx, ol);
    path();
    ctx.fillStyle = detail <= 0 ? cMid : fillGrad();
    ctx.fill();
    if (rich) {
      // 双侧明暗：掌裂叶按上下半区分光影，亮侧由方向光决定
      const litTopK = clamp(0.5 + 0.5 * Math.cos(lf.angle - Math.PI / 2 - lightA) * lerp(0.4, 1, light.k));
      ctx.save(); path(); ctx.clip();
      const sh = ctx.createLinearGradient(0, -wid * 0.55, 0, wid * 0.55);
      const warmH = 6 + light.warm * 7;
      sh.addColorStop(0, hsla01(pal.tint(warmH, 9, -4), 0.10 + 0.28 * litTopK));
      sh.addColorStop(0.5, 'transparent');
      sh.addColorStop(1, hsla01(pal.tint(-5, -8, 5), 0.10 + 0.24 * (1 - litTopK)));
      ctx.fillStyle = sh;
      ctx.fillRect(-len * 0.2, -wid, len * 1.3, wid * 2);
      drawLeafNoise(ctx, len, wid, lid, pal);
      ctx.restore();
    }
    if (detail > 0.5) {
      ctx.lineWidth = Math.max(0.4 / S, len * 0.012);
      ctx.strokeStyle = pal.leafEdge; path(); ctx.stroke();
    }
    if (gn.veins && detail > 0.7) {
      ctx.strokeStyle = pal.vein; ctx.lineWidth = Math.max(0.3 / S, len * 0.009);
      const lobes = gn.palmateLobes || 5;
      for (let k = 0; k < lobes; k++) {
        const th = (-1 + (2 * k) / (lobes - 1)) * 1.0;
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(th) * len * 0.72, Math.sin(th) * len * 0.72 * (wid / len));
        ctx.stroke();
      }
    }
    ctx.restore(); return;
  }

  const outline = lf.shape === 'cordate'
    ? cordateOutline(len, wid, lf.curl)
    : leafOutline(len, wid, lf.shape, lf.curl, lf.serration);
  const path = () => traceSmooth(ctx, outline.pts);

  path();
  ctx.fillStyle = detail <= 0 ? cMid : fillGrad();
  ctx.fill();

  const mid = (t) => lf.curl * len * Math.sin(t * Math.PI * 0.82);
  /* 受光度：叶两半的法向与光方向的对齐量（美术二期）。
   * litTopK = 1 → top 半全亮 / bot 半全阴；0.5 → 光顺着叶轴，两半无差。 */
  const litTopK = clamp(0.5 + 0.5 * Math.cos(lf.angle - Math.PI / 2 - lightA) * lerp(0.4, 1, light.k));
  if (rich && lf.shape !== 'needle') {
    // 双侧明暗 + 噪声条带，全部裁剪在叶形内
    ctx.save(); path(); ctx.clip();
    const half = (pts, litK) => {
      const ridge = [];
      for (let i = pts.length - 1; i >= 0; i--) { const t = i / (pts.length - 1); ridge.push([t * len, mid(t)]); }
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      for (const p of ridge) ctx.lineTo(p[0], p[1]);
      ctx.closePath();
      // 连续过渡：受光半涂暖亮罩，背光半涂冷沉罩，量随对齐度走
      if (litK >= 0.5) {
        ctx.fillStyle = hsla01(pal.tint(6 + light.warm * 8, 9, -4), 0.08 + (litK - 0.5) * 2 * 0.30);
      } else {
        ctx.fillStyle = hsla01(pal.tint(-6, -7, 5), 0.06 + (0.5 - litK) * 2 * 0.26);
      }
      ctx.fill();
    };
    half(outline.top, litTopK);
    half(outline.bot, 1 - litTopK);
    drawLeafNoise(ctx, len, wid, lid, pal);
    ctx.restore();
  }

  if (detail > 0.5) {
    ctx.lineWidth = Math.max(0.4 / S, len * (lf.rosette ? 0.020 : 0.012));
    ctx.strokeStyle = lf.rosette ? pal.tint(-8, -16, 8) : pal.leafEdge;
    path(); ctx.stroke();
    if (pal.dark && px > 7) {
      // 月光 rim：只描迎光的上缘（盲评 P1-11）
      traceSmoothOpen(ctx, outline.top);
      ctx.strokeStyle = pal.rim;
      ctx.lineWidth = Math.max(0.5 / S, len * 0.014);
      ctx.stroke();
    } else if (!pal.dark && px > 7 && light.warm > 0.38 && !lf.cotyledon) {
      /* 低日头逆光 rim（美术二期）：太阳压低时，受光缘一线金橙——
       * 参考图花瓣/叶缘的「镶边」。只描受光的那一半缘。 */
      const rimK = (light.warm - 0.38) / 0.62;
      traceSmoothOpen(ctx, litTopK >= 0.5 ? outline.top : outline.bot);
      ctx.strokeStyle = `hsla(36,72%,74%,${(0.10 + 0.26 * rimK * Math.abs(litTopK - 0.5) * 2).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.4 / S, len * 0.011);
      ctx.stroke();
    }
  }
  if (gn.veins && detail > 0.7 && len > 0.02 && lf.shape !== 'needle') {
    ctx.strokeStyle = pal.vein;
    ctx.lineWidth = Math.max(0.3 / S, len * 0.009);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (let i = 1; i <= 12; i++) { const t = i / 12; ctx.lineTo(t * len, mid(t)); }
    ctx.stroke();
    const prof = LEAF_PROFILE[lf.shape] || LEAF_PROFILE.ovate;
    for (let k = 1; k <= 3; k++) {
      const t = 0.22 + k * 0.20;
      const w = prof(t) * wid * 0.5, m = mid(t);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(t * len, m);
        ctx.quadraticCurveTo(t * len + len * 0.10, m + s * w * 0.4, t * len + len * 0.16, m + s * w * 0.82);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/** 叶面明度噪声：2–3 条顺叶脉方向的软条带，±8–12% 明度，位置/明暗取自叶身份哈希。
 * 调用方已把裁剪设为叶形，这里只管画。 */
function drawLeafNoise(ctx, len, wid, lid, pal) {
  const bands = 2 + (hashU32(lid) & 1);
  for (let k = 0; k < bands; k++) {
    const u = hash01(lid + 17 + k * 29);
    const v = hash01(lid + 18 + k * 29);
    const s = hash01(lid + 19 + k * 29);
    const lat = (u * 2 - 1) * 0.62;                    // 横向位置（中脉为 0）
    const light = v > 0.5;
    const amp = 8 + s * 4;                             // ±8–12% 明度
    ctx.strokeStyle = hsla01(pal.tint(light ? 5 : -4, light ? amp : -amp), 0.16);
    ctx.lineWidth = wid * (0.16 + 0.10 * s);
    ctx.beginPath();
    ctx.moveTo(len * 0.10, lat * wid * 0.22);
    ctx.quadraticCurveTo(len * 0.5, lat * wid * 0.52, len * (0.86 - 0.1 * u), lat * wid * 0.30);
    ctx.stroke();
  }
}

/** 把 hsl(a) 字符串替换成指定 alpha（tint 输出恒为 a=1，此处只重写结尾） */
function hsla01(hslStr, a) {
  return hslStr.replace(/,1\)$/, `,${a})`);
}

function drawBloom(ctx, T, S, gn, b, bud, open, pal, detail, stag = 0, lod = null, light = DEF_LIGHT, lightA = -0.42, lightPow = 1) {
  const [ax, ay] = T(b.x, b.y);
  /* 每朵花的确定性身份（盲评 P0-3：禁止同 open 值克隆）：
   * 自转 spin 与位置在骨架里就互不相同且确定，混入种子后做整花±5% 大小差、
   * 花形整体色相微差，再传给逐瓣抖动。 */
  const bk = elemKey(gn.seed, b.x, b.y, Math.round(b.spin * 2048));
  const sizeJ = 0.95 + 0.10 * hash01(bk + 1);
  const size = b.size * S * (lod ? lod.bloomBoost : 1) * sizeJ;
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(b.angle);   // 屏幕坐标：0 = 向上

  const budScale = easeOutCubic(bud);
  if (open <= 0.001) { drawBud(ctx, size * budScale, pal, gn); ctx.restore(); return; }

  const op = easeOutCubic(open);
  // 花苞外壳在开放中收缩为萼片
  if (op < 0.9) { ctx.save(); ctx.globalAlpha *= (1 - op) * 0.9; drawBud(ctx, size * budScale * (1 - op * 0.35), pal, gn); ctx.restore(); }

  ctx.save();
  ctx.globalAlpha *= clamp(op * 1.5);
  const s = lerp(0.42, 1, op);
  if (pal.dark && detail > 0.5) {
    const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 2.6 * s);
    gr.addColorStop(0, pal.glow); gr.addColorStop(1, 'transparent');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(0, 0, size * 2.6 * s, 0, TAU); ctx.fill();
  }
  ctx.rotate(b.spin + (1 - op) * 0.5);
  /* 花瓣光照（美术二期）：把方向光换算进花的局部坐标——
   * 逐瓣世界朝向 = 花头角 + 自转 + 瓣位角，受光瓣亮暖、背光瓣沉，
   * 低日头时背光瓣走「次表面透光」（尖端透出暖亮）而不是一味压黑。 */
  const lt = {
    a: lightA - (b.angle + b.spin + (1 - op) * 0.5),   // 光在花局部系里的方位
    pow: lightPow,
    warm: light.warm,
  };
  const form = gn.bloomForm;
  if (form === 'bell') drawBell(ctx, size * s, gn, pal, op, bk);
  else if (form === 'spike') drawSpike(ctx, size * s, gn, pal, op, lod, bk);
  else if (form === 'umbel' || b.floret) drawFloret(ctx, size * s, gn, pal, op, bk);
  else if (form === 'pom') drawPom(ctx, size * s, gn, pal, op, detail, stag, bk, lt);
  else if (form === 'disc') drawDisc(ctx, size * s, gn, pal, op, detail, stag, bk, lt);
  else drawStar(ctx, size * s, gn, pal, op, detail, stag, bk, lt);
  ctx.restore();
  ctx.restore();
}

/** 逐瓣确定性抖动（盲评 P0-3）：角度 ±4–9°、缩放 0.92–1.08、色相 ±5 */
function petalJitter(bk, i) {
  const a = hash01(bk + 101 + i * 13);
  const b2 = hash01(bk + 102 + i * 13);
  const c = hash01(bk + 103 + i * 13);
  return {
    rot: (a < 0.5 ? -1 : 1) * lerp(4, 9, hash01(bk + 104 + i * 13)) * D2R,
    scale: lerp(0.92, 1.08, b2),
    dh: (c * 2 - 1) * 5,
    dl: (hash01(bk + 105 + i * 13) * 2 - 1) * 3.5,
  };
}

function drawBud(ctx, r, pal, gn) {
  if (r < 0.3) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-r * 0.62, -r * 0.35, -r * 0.5, -r * 1.5, 0, -r * 1.85);
  ctx.bezierCurveTo(r * 0.5, -r * 1.5, r * 0.62, -r * 0.35, 0, 0);
  ctx.fillStyle = pal.bud;
  ctx.fill();
  ctx.strokeStyle = pal.leafEdge; ctx.lineWidth = Math.max(0.4, r * 0.06); ctx.stroke();
  // 萼片
  ctx.beginPath();
  for (const s of [-1, 1]) {
    ctx.moveTo(0, r * 0.05);
    ctx.quadraticCurveTo(s * r * 0.72, -r * 0.35, s * r * 0.34, -r * 0.95);
  }
  ctx.strokeStyle = pal.stemDark; ctx.lineWidth = Math.max(0.5, r * 0.14);
  ctx.stroke();
  ctx.restore();
}

function petalPath(ctx, L, W, shape = 'round') {
  ctx.beginPath();
  if (shape === 'point') {
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-W * 0.5, -L * 0.34, -W * 0.36, -L * 0.8, 0, -L);
    ctx.bezierCurveTo(W * 0.36, -L * 0.8, W * 0.5, -L * 0.34, 0, 0);
  } else {
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-W * 0.62, -L * 0.22, -W * 0.72, -L * 0.82, 0, -L);
    ctx.bezierCurveTo(W * 0.72, -L * 0.82, W * 0.62, -L * 0.22, 0, 0);
  }
}

/** 逐瓣错峰：stag 是「最后一瓣比第一瓣晚多少」占开放区间的比例 */
const petalOpen = (op, i, n, stag) =>
  stag > 0 ? clamp((op - (i / Math.max(1, n)) * stag) / (1 - stag)) : op;

/** 逐瓣受光度：瓣的局部朝向 vs 光的局部方位（lt.a），返回 0 背光 … 1 迎光 */
const petalLit = (lt, petalRot) =>
  lt ? clamp(0.5 + 0.5 * Math.cos(petalRot - lt.a) * lerp(0.35, 1, lt.pow)) : 0.5;

function drawStar(ctx, r, gn, pal, op, detail, stag = 0, bk = 0, lt = null) {
  const n = gn.petalCount;
  const L = r * gn.petalLenRatio * 1.35, W = r * gn.petalWidRatio * 1.5;
  for (let i = 0; i < n; i++) {
    const oi = petalOpen(op, i, n, stag);
    const j = petalJitter(bk, i);
    const rot = (i / n) * TAU + j.rot;
    /* 方向光：受光瓣 +L 微暖，背光瓣 -L；低日头时背光瓣尖端透光（次表面） */
    const litK = petalLit(lt, rot);
    const dl = j.dl + (litK - 0.5) * 7;
    const dh = j.dh + (litK - 0.5) * (lt ? lt.warm * 6 : 0);
    const trans = lt ? lt.warm * clamp(0.5 - litK) * 2 * 9 : 0;
    ctx.save();
    ctx.rotate(rot);
    ctx.scale(j.scale, j.scale * lerp(0.35, 1, oi));
    petalPath(ctx, L * lerp(0.72, 1, oi), W, 'point');
    const gd = ctx.createLinearGradient(0, 0, 0, -L);
    gd.addColorStop(0, pal.petalDeepT(dh, dl));
    gd.addColorStop(0.45, pal.petalT(dh, dl));
    gd.addColorStop(1, pal.petalLightT(dh + trans * 0.5, dl * 0.6 + trans));
    ctx.fillStyle = gd; ctx.fill();
    if (detail > 0.5) { ctx.strokeStyle = pal.petalEdge; ctx.lineWidth = Math.max(0.4, r * 0.045); ctx.stroke(); }
    ctx.restore();
  }
  centerDot(ctx, r * 0.34 * op, pal, detail);
}

function drawPom(ctx, r, gn, pal, op, detail, stag = 0, bk = 0, lt = null) {
  const rings = 3;
  const per = Math.max(6, Math.round(gn.petalCount / rings));
  for (let ring = 0; ring < rings; ring++) {
    const rr = [1, 0.74, 0.48][ring];
    const L = r * gn.petalLenRatio * 1.15 * rr, W = r * gn.petalWidRatio * 1.35 * rr;
    for (let i = 0; i < per; i++) {
      // 外圈先开、内圈后开，同圈内再逐瓣错峰
      const oi = petalOpen(op, i + ring * per, per * rings, stag);
      const j = petalJitter(bk, i + ring * 37);
      const rot = (i / per) * TAU + ring * 0.79 + j.rot * 0.8;
      // 球形重瓣的光照差按圈递减：外圈受光分明，内圈埋在花心里
      const litK = petalLit(lt, rot);
      const ringK = [1, 0.6, 0.3][ring];
      const dl = j.dl + (litK - 0.5) * 6.5 * ringK - ring * 0;
      const dh = j.dh + (litK - 0.5) * (lt ? lt.warm * 5 : 0) * ringK;
      ctx.save();
      ctx.rotate(rot);
      ctx.scale(j.scale, j.scale * lerp(0.3 + ring * 0.1, 1, oi));
      petalPath(ctx, L * lerp(0.78, 1, oi), W, 'round');
      ctx.fillStyle = ring === 0 ? pal.petalT(dh, dl)
        : ring === 1 ? pal.petalLightT(dh, dl)
          : pal.petalDeepT(dh, dl);
      ctx.fill();
      if (detail > 0.5 && ring === 0) { ctx.strokeStyle = pal.petalEdge; ctx.lineWidth = Math.max(0.35, r * 0.035); ctx.stroke(); }
      ctx.restore();
    }
  }
  centerDot(ctx, r * 0.2 * op, pal, detail);
}

function drawDisc(ctx, r, gn, pal, op, detail, stag = 0, bk = 0, lt = null) {
  const n = gn.petalCount;
  const L = r * gn.petalLenRatio * 1.5, W = r * gn.petalWidRatio * 0.9;
  for (let i = 0; i < n; i++) {
    const oi = petalOpen(op, i, n, stag);
    const j = petalJitter(bk, i);
    const rot = (i / n) * TAU + j.rot * 0.5;
    const litK = petalLit(lt, rot);
    const dl = j.dl + (litK - 0.5) * 6;
    const dh = j.dh + (litK - 0.5) * (lt ? lt.warm * 5 : 0);
    const trans = lt ? lt.warm * clamp(0.5 - litK) * 2 * 7 : 0;
    ctx.save();
    // 盘状射瓣排列紧密，角度抖动减半防止相邻重叠成锯齿
    ctx.rotate(rot);
    ctx.scale(j.scale, j.scale * lerp(0.28, 1, oi));
    petalPath(ctx, L * lerp(0.70, 1, oi), W, 'round');
    ctx.fillStyle = i % 2
      ? pal.petalT(dh + trans * 0.4, dl + trans * 0.5)
      : pal.petalLightT(dh + trans * 0.4, dl + trans * 0.5);
    ctx.fill();
    ctx.restore();
  }
  // 花盘：受光侧亮、背光侧沉——花心也是一枚球，不是一枚贴纸
  const rr = r * 0.46 * op;
  ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU);
  if (lt && rr > 2.5) {
    const ox = Math.sin(lt.a) * rr * 0.30, oy = -Math.cos(lt.a) * rr * 0.30;
    const cg = ctx.createRadialGradient(ox, oy, 0, 0, 0, rr * 1.15);
    cg.addColorStop(0, pal.center);
    cg.addColorStop(1, pal.centerDeep);
    ctx.fillStyle = cg;
  } else {
    ctx.fillStyle = pal.center;
  }
  ctx.fill();
  if (detail > 0.6) {
    ctx.fillStyle = pal.centerDeep;
    for (let i = 0; i < 22; i++) {
      const a = i * 2.399, rad = rr * 0.82 * Math.sqrt(i / 22);
      ctx.beginPath(); ctx.arc(Math.cos(a) * rad, Math.sin(a) * rad, rr * 0.075, 0, TAU); ctx.fill();
    }
  }
}

function drawBell(ctx, r, gn, pal, op, bk = 0) {
  const h = r * 1.55 * lerp(0.5, 1, op), w = r * 0.78 * lerp(0.45, 1, op);
  // 整钟微差：同株两只吊钟不允许同構（色相 ±4、裙摆倾斜 ±3°）
  const dh = (hash01(bk + 7) * 2 - 1) * 4;
  const tilt = (hash01(bk + 8) * 2 - 1) * 3 * D2R;
  ctx.save();
  ctx.rotate(Math.PI + tilt); // 垂花朝下
  ctx.beginPath();
  ctx.moveTo(-w * 0.26, 0);
  ctx.bezierCurveTo(-w * 1.0, h * 0.42, -w * 0.96, h * 0.86, -w * 0.82, h);
  const lobes = gn.petalCount;
  for (let i = 0; i <= lobes; i++) {
    const t = i / lobes;
    const px = lerp(-w * 0.82, w * 0.82, t);
    const flare = 1 + (hash01(bk + 20 + i * 3) * 2 - 1) * 0.18;   // 裙摆逐齿微差
    ctx.quadraticCurveTo(px, h + r * 0.30 * op * flare, px + (w * 1.64) / lobes, h);
  }
  ctx.bezierCurveTo(w * 0.96, h * 0.86, w * 1.0, h * 0.42, w * 0.26, 0);
  ctx.closePath();
  const gd = ctx.createLinearGradient(0, 0, 0, h);
  gd.addColorStop(0, pal.petalDeepT(dh, 0)); gd.addColorStop(0.6, pal.petalT(dh, 0)); gd.addColorStop(1, pal.petalLightT(dh, 0));
  ctx.fillStyle = gd; ctx.fill();
  ctx.strokeStyle = pal.petalEdge; ctx.lineWidth = Math.max(0.4, r * 0.05); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(0, h, w * 0.7, r * 0.2 * op, 0, 0, TAU);
  ctx.fillStyle = pal.centerDeep; ctx.globalAlpha *= 0.55; ctx.fill();
  ctx.restore();
}

function drawSpike(ctx, r, gn, pal, op, lod = null, bk = 0) {
  const H = r * 5.0;
  /* 远景简化：22 朵小花在 20px 高度上只会糊成一团噪点。
   * 换成一个实心穗形轮廓 + 两条明暗带，「穗」这个特征反而读得出来。 */
  if (lod && lod.simplify) {
    const w = r * 1.15;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-w, -H * 0.30, -w * 0.72, -H * 0.66);
    ctx.quadraticCurveTo(-w * 0.44, -H * 0.94, 0, -H);
    ctx.quadraticCurveTo(w * 0.44, -H * 0.94, w * 0.72, -H * 0.66);
    ctx.quadraticCurveTo(w, -H * 0.30, 0, 0);
    ctx.closePath();
    const gd = ctx.createLinearGradient(0, 0, 0, -H);
    gd.addColorStop(0, pal.petalDeep);
    gd.addColorStop(0.55, pal.petal);
    gd.addColorStop(1, pal.petalLight);
    ctx.fillStyle = gd;
    ctx.globalAlpha *= clamp(0.35 + op * 0.65);
    ctx.fill();
    ctx.strokeStyle = pal.petalEdge; ctx.lineWidth = Math.max(0.6, r * 0.10); ctx.stroke();
    return;
  }
  const n = 22;
  // 中轴
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -H * 0.96);
  ctx.strokeStyle = pal.stem; ctx.lineWidth = Math.max(0.6, r * 0.10); ctx.stroke();
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const local = clamp((op - t * 0.6) / 0.4);   // 自下而上依次开放
    if (local <= 0) continue;
    const y = -t * H * 0.96;
    const sj = 0.90 + 0.20 * hash01(bk + 51 + i * 7);   // 逐小花大小微差
    const s = (0.20 + 0.42 * (1 - t)) * r * (0.35 + 0.65 * local) * sj;
    const side = i % 2 ? 1 : -1;
    const dh = (hash01(bk + 52 + i * 7) * 2 - 1) * 4;
    ctx.save();
    ctx.translate(side * s * 0.75, y);
    ctx.rotate(side * 0.55 + (hash01(bk + 53 + i * 7) * 2 - 1) * 0.12);
    for (let k = 0; k < 4; k++) {
      ctx.save(); ctx.rotate((k / 4) * TAU + 0.4);
      ctx.beginPath();
      ctx.ellipse(0, -s * 0.5, s * 0.32, s * 0.52, 0, 0, TAU);
      ctx.fillStyle = k % 2 ? pal.petalLightT(dh, 0) : pal.petalT(dh, 0);
      ctx.fill();
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(0, 0, s * 0.20, 0, TAU);
    ctx.fillStyle = pal.center; ctx.fill();
    ctx.restore();
  }
}

function drawFloret(ctx, r, gn, pal, op, bk = 0) {
  const n = 5;
  const L = r * 0.95 * lerp(0.4, 1, op);
  for (let i = 0; i < n; i++) {
    const j = petalJitter(bk, i);
    ctx.save();
    ctx.rotate((i / n) * TAU + j.rot * 0.6);
    ctx.beginPath();
    ctx.ellipse(0, -L * 0.55 * j.scale, L * 0.36 * j.scale, L * 0.55 * j.scale, 0, 0, TAU);
    ctx.fillStyle = i % 2 ? pal.petalT(j.dh, j.dl) : pal.petalLightT(j.dh, j.dl);
    ctx.fill();
    ctx.restore();
  }
  ctx.beginPath(); ctx.arc(0, 0, L * 0.22, 0, TAU);
  ctx.fillStyle = pal.center; ctx.fill();
}

function centerDot(ctx, rr, pal, detail) {
  if (rr < 0.4) return;
  ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU);
  ctx.fillStyle = pal.center; ctx.fill();
  if (detail > 0.6) {
    ctx.strokeStyle = pal.centerDeep;
    ctx.lineWidth = Math.max(0.35, rr * 0.14);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * rr * 0.25, Math.sin(a) * rr * 0.25);
      ctx.lineTo(Math.cos(a) * rr * 1.5, Math.sin(a) * rr * 1.5);
      ctx.stroke();
    }
  }
}

/** 地面投影：方向与长度来自当天太阳位置——影子也是时间的读数。
 * 盲评 P0-1 / P1-9：在方向影之外，恒有两层「站位」——
 *   · 暖土丘椭圆（被踩实的土，替代亮斑）
 *   · 基座接触投影（半径随株宽），让植株真正「站在」地上而不是贴在墙上 */
export function drawGroundShadow(ctx, x, y, w, sun, strength = 1) {
  ctx.save();
  ctx.translate(x, y);
  // 站位土丘（P1-9）：hsla(30 18% 42% / .12)
  ctx.save();
  ctx.scale(1, 0.20);
  const mound = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.78);
  mound.addColorStop(0, `hsla(30,18%,42%,${(0.12 * strength).toFixed(3)})`);
  mound.addColorStop(0.72, `hsla(30,18%,42%,${(0.08 * strength).toFixed(3)})`);
  mound.addColorStop(1, 'hsla(30,18%,42%,0)');
  ctx.fillStyle = mound;
  ctx.beginPath(); ctx.arc(0, 0, w * 0.78, 0, TAU); ctx.fill();
  ctx.restore();
  // 基座接触投影（P0-1）：hsla(150 25% 18% / .18)
  ctx.save();
  ctx.scale(1, 0.17);
  const contact = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.50);
  contact.addColorStop(0, `hsla(150,25%,18%,${(0.20 * strength).toFixed(3)})`);
  contact.addColorStop(0.62, `hsla(150,25%,18%,${(0.13 * strength).toFixed(3)})`);
  contact.addColorStop(1, 'hsla(150,25%,18%,0)');
  ctx.fillStyle = contact;
  ctx.beginPath(); ctx.arc(0, 0, w * 0.50, 0, TAU); ctx.fill();
  ctx.restore();
  // 方向影：只有太阳/月亮可见时存在
  if (sun && sun.alpha > 0.01) {
    const len = w * sun.length;
    ctx.transform(1, 0, sun.skew, 1, 0, 0);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(len, w * 0.5));
    g.addColorStop(0, `hsla(${sun.hue},30%,17%,${0.58 * sun.alpha * strength})`);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(sun.dx * w * 0.5, 0, Math.max(len, w * 0.45), w * 0.11, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}
