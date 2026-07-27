# 时间花园 · 高考季营销页

> **2026-07-27 邮箱留资摘除。** 原「上架时通知我」邮箱链路依赖 Formspree 占位端点、
> 从未配置（部署快检发现），已照 focus-canvas 先例整体摘除：上架 CTA 改为静态
> 「敬请期待」+ App Store 徽标占位，`tools/shoot-landing.mjs` 的邮箱断言同步换为
> 「敬请期待在页 + 无表单残留 + `privacy/` 可达」；邮箱版页面以 git 历史留档。
> **上架后**把占位徽标换成官方徽标（Apple Marketing Tools 生成）并加商店链接。

纯静态单屏：`index.html` + `js/`。零构建、零框架、零表单、零跟踪——本页不收集任何
访客数据，与 App 的「未收集数据」隐私标签同一口径。植物由 `js/engine/`（自
`prototype/js/` 原样复制的确定性引擎，已随美术三期+复核尾项同步花朵厚度与烧透）实时渲染：
形态由「高考」二字推导、同名同株，生长值由剩余天数决定——日子越近长得越盛，
6 月 7 日绽放；考后（6/10 起）自动滚动到次年。

页面结构：品牌头 → 高考倒计时（实时算，过零点自动刷新）→ 实时生长的植物 + 阶段徽章 →
六阶段小图 → 主张「把等待种成花园」→ 静态「敬请期待」上架区 → 页脚（承诺句 + 隐私政策）。
明暗两套配色随系统（`prefers-color-scheme`），设计 tokens 与 App（`prototype/css/tokens.css`）同步。

---

## 1. 部署（三步）

> **✅ 已上线（2026-07-27，方式 A）**：`https://deng-m1.github.io/time-garden-landing/` —— 公开仓
> `Deng-m1/time-garden-landing`（本目录全部文件推仓库根）+ GitHub Pages（legacy 构建，
> `main` / 根目录，HTTPS 强制）。curl 实测：首页、随机 3 个资源（`preview/desktop.jpg`、
> `js/engine/plant.js`、`preview/mobile-390.jpg`，其余 4 个 js 亦补验）、`privacy/` 全部 200，
> 首页与 `privacy/` 线上内容与仓内源 md5 一致；`privacy/` 与统一法务站
> `https://deng-m1.github.io/studio-legal/time-garden/privacy/`（ASC 隐私政策 URL）同文冗余，
> md5 实测一致。**更新方式**：改完本目录后把全部文件同步推到该仓 `main`，Pages 约
> 1 分钟自动重建。

### 方式 A：GitHub Pages

1. 新建一个仓库（如 `time-garden-landing`），把 `landing/` 目录下所有文件推到仓库根：
   ```bash
   cd landing && git init && git add -A && git commit -m "landing" \
     && git remote add origin git@github.com:<你>/time-garden-landing.git && git push -u origin main
   ```
2. 仓库 Settings → Pages → Source 选 `Deploy from a branch`，分支选 `main` / 根目录，保存。
3. 等约 1 分钟，访问 `https://<你>.github.io/time-garden-landing/`。

### 方式 B：Vercel

1. `npm i -g vercel`（或直接用 vercel.com 网页导入）。
2. 在 `landing/` 目录里执行 `vercel --prod`。
3. 按提示回车三次（scope / 项目名 / 目录确认 `./`），得到 `*.vercel.app` 地址。

> ES Module 需要 http 服务：本地预览用 `python3 -m http.server`（双击 `index.html` 会因
> CORS 渲染不出植物）；正式自测用下面的冒烟脚本。

## 2. 营销页口径（与商店元数据对齐）

文案的唯一上游是 `store/metadata-zh.md`（SPEC §8 口径纪律同样适用于本页）：

- **承诺句**：完全离线 · 无广告 · 一次买断（与描述首行同源）；副标题「每个期待都长成一株植物」进页脚。
- **定价**：页面不出现价格数字；免费边界口径为「免费下载，免费种 5 株」（描述【定价】段），
  完整价格以 App Store 实际显示为准。
- **1.0 收敛纪律**：iCloud / 通知 / 小组件等未随 1.0 交付的能力一律不上页（2026-07-26
  提审收敛 B3–B5，「不预售未上架内容」）；「通知」字样已随邮箱链路摘除后归零。
- **上架 CTA**：静态「敬请期待」+ App Store 徽标占位（见顶部说明）。
- 页脚「隐私政策」指向 `privacy/`（与 ASC 隐私政策 URL——统一法务站——同文冗余；
  ASC 正式填写以统一法务站地址为准）。

## 3. 自测（截图 + 冒烟）

```bash
node tools/shoot-landing.mjs
```

本地起服后输出到 `preview/`：`desktop.jpg`（1440 亮色）、`mobile-390.jpg`（390@2x 亮色）。
冒烟断言：无控制台错误、倒计时天数合法（1–730）、植物画布非空、六阶段小图齐全、
阶段名已渲染、「敬请期待」在页、全页无表单残留、页脚 `privacy/` 可达。
