# 夜跑看板展示优化 Implementation Plan

> 执行方式：按用户要求，在当前会话直接实现并实际运行验证。

**Goal:** 看板的信息、状态与夜跑规则一致，长说明可点击或用键盘展开，窄屏不丢失操作入口。
**Architecture:** 保持 `ws.mjs status --json` 唯一数据源；共用片段仍由 `lib.mjs` / `sections.mjs` 生成，模板负责视觉。
**Tech Stack:** Node.js 标准库、静态 HTML/CSS、原生 details/summary，无新增依赖或客户端脚本。
**Spec:** 本次会话中用户批准的前端优化提示词。

## Global Constraints

- 只改 `_night` 视图层；不改任务、审批结果或夜跑执行器。
- 看板沿用夜蓝 #141b2b、浅灰 #f2f4f7、白 #ffffff、正文 #18202d、蓝 #2453b8。
- 使用现有系统字体，正文左对齐；顶部说明快照时间，待审与可执行队列并列，项目和历史在后。
- 简报兼容 WinForms IE：保守 CSS，详情内容在不支持 details 的内核中直接可读。
- 根仓库原先干净；在 `codex/board-display` 分支直接工作，避免工作树搬迁影响绝对路径。

## Review Focus

- 暂停项目不应被展示为今晚可执行；未完成任务应按既有规则优先接续。
- 正在执行与暂停/收尾标志同时存在时，不隐藏正在执行的事实。
- 无汇总的失败报告仍然可以打开，不能误当成没有报告。
- 长标题、说明、路径及下一步信息完整保留，窄屏和键盘可读。
- 空数据、没有记录时给出清楚提示；简报仍使用同一套渲染结果。

### Task 1: 修正共用展示逻辑并补回归检查

**Files:** `_night/lib.mjs`、`_night/sections.mjs`、`_night/sections.test.mjs`。
**Interfaces:** 保持既有片段函数签名；新增 `runnableItems(status)`，仅用于展示可执行队列。

- [x] 先编写并运行 `node --test _night/sections.test.mjs`，确认队列、运行状态、失败报告、全文详情用例失败。
- [x] 最小修复；重跑同一命令，预期全部通过。

### Task 2: 优化看板与简报样式

**Files:** `_night/board/template.html`、`_night/brief/template.html`、必要的两个生成入口文案。

- [x] 补齐徽标、来源、空状态、详情样式；加入分区导航与快照说明；窄屏内容重排，表格局部滚动。
- [x] `node _night/board.mjs --selftest` 与 `node _night/brief.mjs --selftest` 均退出 0。
- [x] 浏览器检查桌面、窄屏、鼠标及键盘展开；记录截图和布局尺寸。

### Task 3: 实际生成与收尾

- [x] 运行 `node ws.mjs board` 与 `node _night/brief.mjs --build`，检查真实快照生成成功。
- [x] 独立代码审查；修正重要问题；运行回归与两个自检。
- [x] 更新 `_night/README.md` 的展示/验证说明，框架变更记录在根提交中；如架构约定变动同步 `ARCHITECTURE.md`。
- 收尾动作：验证后在根仓库提交；无项目状态变动，无需刷新项目树。

## Execution ledger

- 基线：两个内置渲染自检通过；浏览器已确认项目状态标签没有样式，长说明只有 title。
- 取舍：标题“今晚要跑”改为“可执行队列”，展示积压而不承诺当晚全部执行；限额和顺延规则保持不变。
- 预览：本机 HTTP 只提供固定生成页，移除 file 链接，不开放目录或其他文件。
- Task 1: complete — 初始 10 项均按预期失败后转绿；独立审查发现 STOP 被残锁掩盖，新增用例见失败后修正。
- Ruling: 项目徽标按快照的精确状态枚举展示 — 真实 Skills 状态含附加说明，原先徽标误显示活跃；只标出待规范，不改项目原始数据。
- Task 2: complete — 浏览器在 1280 / 390 / 320 宽度检查真实快照；320 宽时整页内容宽 305，无卡片溢出；390 宽时表格内容 560、容器 347，方向键可改变 scrollLeft；鼠标展开和 Enter 收起/展开通过。
- Review: 初审一个 P2（STOP 遮蔽）已修复；后续独立复查无重要发现，12 项回归与两个 selftest 全过。
- Task 3: generated — 真看板与简报生成成功；报告窗口空 items 启动自检返回 `action: ok`、`decisions: {}`。旧 IE 的视觉排版未逐项验收。
- Evidence: `runs/2026-10-16-ui/desktop.png`、`mobile.png`、`before.png`、`report-smoke.json` 为本机生成物，不入版本控制。

## 用户追加：功能组与业务项目组（2026-10-16）

用户明确：Skills、Tools、WorkFlows 是功能组；WorkFlows 下的具体工作流也随功能组。公共审批组件按基础功能展示；不搬动目录和仓库。

1. 在 `ws.mjs status --json` 增加功能入口、条目分类和业务统计，保留既有仓库数组与统计供旧消费者使用。验证：复制脚本到临时工作区，运行真实 CLI 检查分类、前缀边界和数量。
2. 看板和简报共用分类，在“功能组”保留状态与下一步，在“项目组”仅展示业务。验证：分组片段回归、两个渲染自检、实际生成、桌面与窄屏浏览器检查。
3. 同步规范与架构记录，独立审查后根仓库提交；运行中的早检锁和早检新写的摘要不属于本任务。

- 分类验证：新增用例先失败再转绿；目前 15 项回归全部通过，临时工作区覆盖 Tools 不作仓库扫描、WorkFlows 子流程归功能组、相似前缀 WorkFlowsPlus 仍归业务，原仓库数组兼容。
- 实际效果：真实快照为 4 个功能组、0 个业务项目；桌面展开 WorkFlows 后工作周报仍在功能组，项目组显示空状态；390 宽时功能表格内容 560、容器 317，仅局部滚动；320 宽时页面内容宽与可用宽同为 305。
- 复查：独立审查无重要发现；简报浏览器确认与看板同样分组。截图为 `runs/2026-10-16-ui/groups-desktop.png`、`groups-mobile.png`。
- 记录：规范、WorkFlows 说明、新项目模板与 ARCHITECTURE v8 已同步；早检由其自身完成并提交摘要，未卷入本任务。
