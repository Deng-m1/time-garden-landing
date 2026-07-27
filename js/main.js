/* 时间花园 · 高考季落地页
 * 植物引擎为 prototype/js 的原样复制（js/engine/），此处只做：
 * 倒计时 → 生长值 → 实时渲染。
 * （原邮箱留资链路依赖 Formspree 占位端点、从未配置，
 *   已照 focus-canvas 先例摘除，上架 CTA 为静态「敬请期待」。） */

import { genomeFor } from './engine/genome.js';
import { growthState, STAGES, stageOf } from './engine/growth.js';
import { renderPlant } from './engine/plant.js';

const $ = (s) => document.querySelector(s);
const DAY = 86400000;

/* —— 高考倒计时：目标 6 月 7 日；考后（6/10 起）滚动到次年 —— */
function gaokao(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), 5, 7);
  let daysLeft = Math.round((target - today) / DAY);
  if (daysLeft < -2) {
    target = new Date(now.getFullYear() + 1, 5, 7);
    daysLeft = Math.round((target - today) / DAY);
  }
  return { target, daysLeft };
}

const { target, daysLeft } = gaokao();
const st = growthState(365, daysLeft); // 倒数窗口：上一届高考结束 → 下一届，约一年

/* —— 文案状态 —— */
const weekday = target.toLocaleDateString('zh-CN', { weekday: 'long' });
$('#count-date').textContent = `${target.getFullYear()} 年 6 月 7 日 · ${weekday}`;
if (daysLeft > 0) {
  $('#count-label').textContent = `距离 ${target.getFullYear()} 年高考还有`;
  $('#count-num').textContent = daysLeft;
} else if (daysLeft === 0) {
  $('#count-label').textContent = '今天，高考。';
  $('#count-num').textContent = '0';
  $('#count-unit').textContent = '天 · 花已开好';
} else {
  $('#count-label').textContent = '高考进行中';
  $('#count-num').textContent = '——';
  $('#count-unit').textContent = '全力以赴';
}

const stage = stageOf(st.v);
$('#stage-name').textContent = `${stage.zh}期`;
$('#stage-fig').textContent = daysLeft > 0
  ? `已长成 ${Math.round(Math.min(st.v, 1) * 100)}% · 6 月 7 日绽放`
  : '满开长青';

/* —— 植物渲染 —— */
const gn = genomeFor('高考', 'exam');
const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canvas = $('#plant');
const DPR = Math.min(devicePixelRatio || 1, 2);

function paint(time) {
  const cssW = canvas.clientWidth || 360;
  const cssH = cssW * (520 / 720);
  if (canvas.width !== Math.round(cssW * DPR)) {
    canvas.width = Math.round(cssW * DPR);
    canvas.height = Math.round(cssH * DPR);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const baseY = cssH - 6;
  // 地面软影（植物越大影越宽）
  const sw = cssW * (0.13 + 0.20 * Math.min(st.v, 1));
  const g = ctx.createRadialGradient(cssW / 2, baseY, 0, cssW / 2, baseY, sw);
  g.addColorStop(0, theme === 'dark' ? 'hsla(224,30%,3%,.5)' : 'hsla(28,25%,25%,.14)');
  g.addColorStop(1, 'transparent');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cssW / 2, baseY, sw, sw * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();

  renderPlant(ctx, gn, st.v, {
    x: cssW / 2, y: baseY, scale: cssH * 0.86,
    time, theme, centerX: true, reduceMotion,
  });
}

if (reduceMotion) {
  paint(0);
} else {
  let last = 0;
  const loop = (ms) => {
    if (ms - last > 33) { last = ms; paint(ms / 1000); } // ~30fps 足够摇曳
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/* —— 六阶段预览（静态小图） —— */
const PREVIEW_V = [0.08, 0.24, 0.50, 0.76, 0.95, 1.12];
const row = $('#stage-row'), names = $('#stage-names');
STAGES.forEach((s, i) => {
  const c = document.createElement('canvas');
  c.width = 52 * DPR; c.height = 64 * DPR;
  row.appendChild(c);
  const ctx = c.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  renderPlant(ctx, gn, PREVIEW_V[i], {
    x: 26, y: 62, scale: 54, time: 0, theme, centerX: true, reduceMotion: true, detail: 0.4,
  });
  const n = document.createElement('span');
  n.textContent = s.zh;
  if (s.key === stage.key) n.className = 'on';
  names.appendChild(n);
});

/* —— 过零点自动刷新（“实时算”）—— */
const now = new Date();
const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
setTimeout(() => location.reload(), Math.min(midnight - now, 2147000000));
