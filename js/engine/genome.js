/* 时间花园 · 植物基因组
 *
 * 事件名 → hash → 21 个基因维度。
 * 关键设计：基因不是均匀随机的。archetype（形态原型）先被抽出，
 * 它决定了这株植物「可行的叶形/花形词汇表」与参数区间。
 * 这一层形态学约束是生成结果始终可信、而不是随机噪声的原因。
 */

import { hashString, seedKey, Rng, clamp } from './rng.js';

/* ---------- 形态原型 ---------- */
export const ARCHETYPES = {
  herb: { zh: '直立草本', pack: 'base' },      // 单主茎 + 对生/互生叶 + 顶生花
  shrub: { zh: '木本灌木', pack: 'base' },     // 二叉分枝，枝端开花
  vine: { zh: '藤蔓', pack: 'base' },          // 长弯曲主茎，沿途着花
  umbel: { zh: '伞形', pack: 'base' },         // 裸茎 + 顶端伞状小花簇
  succulent: { zh: '多肉莲座', pack: 'succ' }, // 莲座叶盘 + 细高花箭
  grass: { zh: '禾本', pack: 'base' },         // 弧形叶丛 + 穗
};

/* archetype → 可行叶形（形态学约束） */
const LEAF_VOCAB = {
  herb: ['ovate', 'lance', 'cordate', 'palmate'],
  shrub: ['ovate', 'lance', 'needle'],
  vine: ['cordate', 'palmate', 'ovate'],
  umbel: ['lance', 'palmate'],
  succulent: ['succ'],
  grass: ['blade'],
};
/* archetype → 可行花形 */
const BLOOM_VOCAB = {
  herb: ['star', 'pom', 'bell', 'disc'],
  shrub: ['pom', 'star', 'disc'],
  vine: ['bell', 'star', 'disc'],
  umbel: ['umbel'],
  succulent: ['star', 'bell', 'spike'],
  grass: ['spike', 'pom'],
};

export const LEAF_ZH = {
  ovate: '卵形', lance: '披针形', cordate: '心形',
  palmate: '掌裂', needle: '针形', succ: '肉质匙形', blade: '线形叶',
};
export const BLOOM_ZH = {
  star: '单瓣星形', pom: '重瓣球形', bell: '铃状垂花',
  disc: '盘状射瓣', spike: '穗状', umbel: '复伞形',
};

/* ---------- 花色词典 ----------
 * 手工挑选自植物图谱，刻意排除「SaaS 紫」「霓虹青」这类屏幕原生色。
 * 每个色都有名字——一个没法命名的颜色不该出现在这个 App 里。 */
export const BLOOM_HUES = [
  { key: 'madder',    zh: '茜红',   h: 354, s: 62, l: 58 },
  { key: 'cinnabar',  zh: '朱砂',   h: 10,  s: 70, l: 56 },
  { key: 'persimmon', zh: '柿橙',   h: 24,  s: 72, l: 58 },
  { key: 'apricot',   zh: '杏',     h: 34,  s: 76, l: 66 },
  { key: 'gamboge',   zh: '藤黄',   h: 46,  s: 74, l: 58 },
  { key: 'sprout',    zh: '芽绿',   h: 74,  s: 40, l: 52 },
  { key: 'porcelain', zh: '白瓷',   h: 38,  s: 26, l: 90 },
  { key: 'sakura',    zh: '樱',     h: 344, s: 52, l: 79 },
  { key: 'rose',      zh: '蔷薇',   h: 336, s: 46, l: 63 },
  { key: 'mallow',    zh: '木槿',   h: 308, s: 28, l: 60 },
  { key: 'iris',      zh: '鸢尾',   h: 266, s: 25, l: 56 },
  { key: 'lapis',     zh: '青金',   h: 217, s: 42, l: 56 },
  { key: 'celadon',   zh: '天青',   h: 176, s: 30, l: 57 },
  { key: 'ochre',     zh: '赭',     h: 30,  s: 44, l: 50 },
];

/* ---------- 分类 ----------
 * 分类不改变形态，只把花色偏向一个语义子集：
 * 生日温暖、考试冷静、旅行明亮、纪念柔和。
 * 「等待什么」影响「开出什么颜色」，这是可解释的，不是随机上色。 */
export const CATEGORIES = {
  anniversary: { zh: '纪念日', hues: ['rose', 'madder', 'sakura', 'porcelain', 'mallow'] },
  birthday:    { zh: '生日',   hues: ['apricot', 'sakura', 'gamboge', 'persimmon', 'rose'] },
  exam:        { zh: '考试',   hues: ['celadon', 'lapis', 'sprout', 'porcelain', 'iris'] },
  travel:      { zh: '旅行',   hues: ['lapis', 'persimmon', 'celadon', 'gamboge', 'ochre'] },
  concert:     { zh: '演出',   hues: ['madder', 'cinnabar', 'mallow', 'iris', 'gamboge'] },
  wish:        { zh: '心愿',   hues: BLOOM_HUES.map((h) => h.key) },
};

const hueByKey = Object.fromEntries(BLOOM_HUES.map((h) => [h.key, h]));

/* ---------- 生长曲线 ----------
 * 生长模型（t → v、阶段边界、绝对天数钳制、730 上限、短事件轴）全部住在
 * ./growth.js，那里是唯一权威实现。此处只做转发，避免出现第二份定义。 */
export { GROWTH, STAGES, stageOf, growthState, daysLeftForV } from './growth.js';

/* ---------- 基因组 ---------- */
const cache = new Map();

export function genomeFor(name, category = 'wish') {
  // 缓存键走种子键，保证「妈妈生日」与「妈妈 生日」命中同一条
  const key = `${seedKey(name)}::${category}`;
  if (cache.has(key)) return cache.get(key);
  const g = buildGenome(name, category);
  cache.set(key, g);
  return g;
}

function buildGenome(name, category) {
  const seed = hashString(name);
  const r = new Rng(seed);
  const catDef = CATEGORIES[category] || CATEGORIES.wish;

  // 1) 形态原型：草本最常见，伞形与多肉稀有——像真实的花园
  const archetype = r.pickWeighted(
    ['herb', 'shrub', 'vine', 'umbel', 'succulent', 'grass'],
    [30, 20, 16, 12, 12, 10]
  );
  const A = archetype;

  // 2) 骨架
  const depth = { herb: r.int(2, 3), shrub: r.int(3, 4), vine: r.int(2, 3), umbel: 1, succulent: 1, grass: 1 }[A];
  const branchAngle = { herb: r.centered(16, 32), shrub: r.centered(20, 42), vine: r.centered(22, 40), umbel: 0, succulent: 0, grass: 0 }[A];
  const lengthRatio = r.centered(0.62, 0.84);
  const widthRatio = r.range(0.58, 0.76);
  // 重力性：负值下垂/拱形，正值挺拔
  const curvature = { herb: r.range(-0.10, 0.26), shrub: r.range(-0.06, 0.30), vine: r.range(0.34, 0.86), umbel: r.range(-0.05, 0.12), succulent: 0, grass: r.range(0.5, 1.0) }[A];
  const internodes = { herb: r.int(4, 7), shrub: r.int(3, 5), vine: r.int(6, 10), umbel: r.int(2, 4), succulent: 0, grass: r.int(4, 7) }[A];
  const baseLength = r.centered(0.30, 0.46) * ({ herb: 1, shrub: 0.86, vine: 1.06, umbel: 1.14, succulent: 0.5, grass: 0.95 }[A]);
  const baseWidth = r.centered(0.016, 0.032) * ({ shrub: 1.35, succulent: 1.2 }[A] || 1);
  const phyllotaxis = A === 'succulent' ? 'spiral' : r.pickWeighted(['alternate', 'opposite', 'whorl'], [50, 38, 12]);
  const lean = r.jitter(0.16);          // 整株倾斜，破对称
  const angleJitter = r.range(2, 9);

  // 3) 叶
  const leafShape = r.pick(LEAF_VOCAB[A]);
  const leafLength = r.centered(0.15, 0.27)
    * ({ needle: 0.60, blade: 2.1, succ: 0.72, palmate: 0.86, cordate: 0.90 }[leafShape] || 1)
    * ({ shrub: 0.60, vine: 0.94 }[A] || 1);
  const leafWidthRatio = { ovate: r.range(0.50, 0.66), lance: r.range(0.24, 0.34), cordate: r.range(0.74, 0.96), palmate: r.range(0.86, 1.10), needle: r.range(0.09, 0.15), succ: r.range(0.36, 0.48), blade: r.range(0.07, 0.12) }[leafShape];
  const palmateLobes = r.pick([3, 5, 5, 7]);
  const leafAngle = r.centered(38, 72);
  const leafCurl = r.range(-0.14, 0.32);
  const serration = r.bool(0.45) ? r.range(0.3, 1.0) : 0;
  const leafPerNode = phyllotaxis === 'whorl' ? 3 : phyllotaxis === 'opposite' ? 2 : 1;
  const leafCount = { succulent: r.int(13, 21), grass: r.int(5, 9) }[A] || 0;
  // 叶色跨度刻意拉宽：一座花园里应该有橄榄、有苔、有霜蓝——而不是同一罐绿颜料
  const leafHue = r.centered(74, 162);
  const leafSat = r.centered(13, 44);
  const leafLight = r.centered(26, 50);
  const veins = r.bool(0.62);

  // 4) 花
  const bloomForm = r.pick(BLOOM_VOCAB[A]);
  const petalCount = bloomForm === 'pom' ? r.int(14, 26)
    : bloomForm === 'disc' ? r.pick([13, 16, 21])
      : bloomForm === 'bell' ? r.int(5, 6)
        : r.pick([5, 5, 6, 8]);
  const petalLenRatio = r.centered(0.82, 1.30);
  const petalWidRatio = bloomForm === 'star' ? r.range(0.30, 0.52) : r.range(0.42, 0.72);
  const bloomSize = r.centered(0.050, 0.102) * ({ pom: 0.92, umbel: 0.55, spike: 0.62, disc: 1.0 }[bloomForm] || 1);
  const budCount = { herb: r.int(1, 4), shrub: r.int(3, 7), vine: r.int(3, 6), umbel: r.int(9, 17), succulent: r.int(3, 6), grass: r.int(1, 3) }[A];
  // 起花时机（v 空间）：落在「结蕾」阶段（0.65）前后，有的品种早、有的憋到最后
  const bloomStart = r.centered(0.60, 0.72);

  const hueKey = r.pick(catDef.hues);
  const base = hueByKey[hueKey];
  const hueA = base.h + r.jitter(7);
  const satA = clamp(base.s + r.jitter(9), 14, 88);
  // 垂花只有一小片受光面，暗色系挂上去就是一坨枯叶，所以铃形统一提亮
  const litFloor = bloomForm === 'bell' ? 58 : 32;
  const litA = clamp(base.l + r.jitter(6), litFloor, 93);
  // 花心：同色系推向暖黄（大多数花的花蕊是黄的），少数用对比色
  const contrastCenter = r.bool(0.22);
  const hueB = contrastCenter ? (hueA + 150) % 360 : 46 + r.jitter(10);
  const satB = contrastCenter ? satA : r.range(58, 82);
  const litB = contrastCenter ? clamp(litA - 16, 22, 70) : r.range(52, 68);

  // 5) 动
  const swayPhase = r.range(0, Math.PI * 2);
  const swayPeriod = r.range(5.2, 8.4);        // 秒，不同株不同步 → 群体自然
  const swayAmp = r.range(0.008, 0.022);

  return {
    name, category, seed, archetype, archetypeZh: ARCHETYPES[A].zh,
    depth, branchAngle, angleJitter, lengthRatio, widthRatio, curvature,
    internodes, baseLength, baseWidth, phyllotaxis, lean,
    leafShape, leafShapeZh: LEAF_ZH[leafShape], leafLength, leafWidthRatio, palmateLobes,
    leafAngle, leafCurl, serration, leafPerNode, leafCount,
    leafHue, leafSat, leafLight, veins,
    bloomForm, bloomFormZh: BLOOM_ZH[bloomForm], petalCount, petalLenRatio, petalWidRatio,
    bloomSize, budCount, bloomStart,
    hueKey, hueZh: base.zh, hueA, satA, litA, hueB, satB, litB,
    swayPhase, swayPeriod, swayAmp,
  };
}

/** 供 UI 展示的「基因表」 */
export function genomeTable(gn) {
  return [
    ['形态原型', gn.archetypeZh],
    ['叶形', gn.leafShapeZh],
    ['叶序', { alternate: '互生', opposite: '对生', whorl: '轮生', spiral: '螺旋' }[gn.phyllotaxis]],
    ['花形', gn.bloomFormZh],
    ['花瓣数', String(gn.petalCount)],
    ['花色', gn.hueZh],
    ['分枝角', `${gn.branchAngle.toFixed(0)}°`],
    ['种子', `#${gn.seed.toString(16).toUpperCase().padStart(8, '0')}`],
  ];
}
