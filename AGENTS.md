# WorkSpace 工作区规则

`D:\WorkSpace` 是**所有项目的容器**。任何 Agent 在本目录或本目录下的任何项目里干活，都遵守本文件。

**项目规范（工作区结构、项目标准结构、frontmatter 字段、日志格式、命名、接入流程、边界判据）以 `CONVENTIONS.md` 为唯一真源。** 本文件只讲 Agent 的行为规则，不重复规范内容——规范要改就改那一份。

- 项目树（自动生成，勿手改）：`TREE.md`
- 工作区工具：`ws.mjs`
- 架构总览（可移植 · 可升级；外部带来的改进版按它第 8 节执行升级）：`ARCHITECTURE.md`
- 新项目模板：`_template\`　休眠项目：`_archive\`
- 工作流容器：`WorkFlows\`（容器不是项目：一个具体工作流一个子文件夹，建法见 `CONVENTIONS.md` 第 1 节）

## 库在哪（都是库，不是项目，不要当项目处理）

- **工具库 `Tools\`**：CodeGraph / AOCI-CODE 等工具本体。**不建 git、不进 TREE 统计。** `aoci.exe` 等被多处 agent 配置用绝对路径引用，**移动它必须同步改所有引用点**（ZCode 等配置、用户 PATH、`_setup` 脚本、各 agent 指路文件、工作区文件、记忆），清单在 `Tools\README.md` 的「迁移记录」。装新工具按那里的 `_setup` 脚本方式加。
- **技能库 `Skills\`**：所有 agent 共用技能的本地真源（离线可用）。技能本体只维护一份，`node Skills\sync.mjs link` 用目录链接分发到 `~\.zcode\skills`、`~\.codex\skills`、`~\.agents\skills`。**新做的可复用技能入库到这里**，不要只丢在某个 agent 的目录或某个项目里；用法见 `Skills\README.md`。

## 任务收尾的固定动作

**每次任务做完，不等用户提醒，按顺序做完这四件事**（细则见 `CONVENTIONS.md` 第 8 节）：

1. 往项目 `LOG.md` 追加一条当日条目（做了什么 / 为什么 / 结果 / 下一步），日期倒序。
2. 更新项目 `README.md` frontmatter 的 `status`（活跃·暂停·已完成·归档）和 `next`。
3. `git add -A && git commit`，提交信息一句话说清改了什么。
4. 项目层面状态有变化时，跑 `node D:\WorkSpace\ws.mjs tree` 刷新项目树。

## 常用命令

```bash
node ws.mjs tree                          # 刷新 TREE.md
node ws.mjs today                         # 今天推进了什么
node ws.mjs today --date 2026-10-12       # 某一天推进了什么（历史可回算）
node ws.mjs new 新项目名 --desc "一句话"   # 全新项目：模板 + git init；名称可带路径，如 WorkFlows\某工作流
node ws.mjs adopt 已有文件夹 --desc "一句话"  # 已有内容的项目按规范接入（不覆盖已有文件）
node ws.mjs status                        # 全量状态：项目 + 两级清单 + 夜跑历史（--json 是机器读契约）
node ws.mjs board --open                  # 生成并打开夜跑看板（_night\board\index.html）
node ws.mjs task add "标题" --desc "说明"  # 攒一条夜活（默认 [待跑] 进工作区级；--project <项目> 进项目；agent 用 --review）
```

**给脚本/模型读状态一律用 `node ws.mjs status --json`**（契约 `workspace-status/1`），不要各自去解析 NIGHT.md / README.md——解析口径只有 `ws.mjs` 一处，才不会出现两套说法。

新建、搬入、归档、复活，一律走 `CONVENTIONS.md` 第 7 节的接入流程。

## 夜间清单与夜跑

排给夜间无人值守执行的任务队列。**工作区级**的在根 `NIGHT.md`，只放跨项目、动工作区基础设施的事；**项目级**的在各项目 `NIGHT.md`，放那个项目自己的事。格式细则见 `CONVENTIONS.md` 第 5 节。

- 状态词：`待跑`（可执行）· `待审`（等用户点头，**夜跑不碰**）· `完成 YYYY-MM-DD` · `未完成` · `搁置`
- 一行一条：`- [待跑] 标题 | 说明或验收标准 | 用户 2026-10-14`

**谁能写**

- 用户随时可以提，写成 `[待跑]`。
- 开发过程中模型想到「适合夜里做」的任务 → 写成 `[待审]`，并在这次收尾时告诉用户等点头；**用户认可后才改成 `[待跑]`**，模型不要自己改。
- **审核走窗口**：`node ws.mjs review` 把两级清单里的 `[待审]` 弹成审批窗口——勾选＝同意（变 `[待跑]`），没勾的保持 `[待审]`，关窗或超时＝什么都没批。手改 markdown 也认。窗口是通用组件（`审批窗口\`），别的流程也能调。
- **每天 09:00 有一个合并窗口**：计划任务 `WorkSpace-DailyBrief` 弹出「前日总结 + [待审]」两页签（`_night\brief.mjs --show`）——前日总结由早检**提前**生成，弹窗段不依赖模型。审清单不必等它，`ws.mjs review` 随时能弹；要立刻看一次用 `node _night\brief.mjs --show --force`。
- 项目级 → 工作区级的**提升只有用户能做**：跨项目、影响整个工作区的才值得提升。
- **积压是常态**：任务攒着慢慢做，夜跑每晚最多开工「每晚条数」条（工作区级 `NIGHT.md` frontmatter，默认 3），没轮到/没做完的自动顺延到下一晚（`[未完成]` 优先接着收尾）；攒任务用 `node ws.mjs task add "标题"`。`[搁置]` 只用于"需要用户拍板 / 依赖外部条件"，别拿它清积压。

**什么时候跑**

| 时间 | 谁 | 做什么 |
| --- | --- | --- |
| 23:00 | 计划任务 `WorkSpace-NightRun` | 无头 ZCode 按 `_night\prompts\night.md` 逐条做：工作区级 → 各活跃项目；每条做完就 LOG + README + commit |
| 07:30 | 夜跑 agent 自己 | 停止开新任务，归档、写报告、退出——不留半成品给白天 |
| 08:00 | 计划任务硬超时（PT9H） | 进程树被强杀，兜底 |
| 08:30 | 计划任务 `WorkSpace-MorningCheck` | 早检收口：清残留、提交脏树、给 `[未完成]` 补接续点、**预生成前日简报**（可选写 3–5 句人话摘要） |
| 09:00 | 计划任务 `WorkSpace-DailyBrief` | 弹**一个**窗口：「前日总结」+「待审 勾选」；纯确定性、不依赖模型；**不自动关闭**——看完自己关，关窗＝什么都没批 |

- 看现状：`node ws.mjs night`（两级清单 + 上次夜跑结果 + 锁状态）· `node ws.mjs status`（全量）· `node ws.mjs board --open`（看板）。

- **机器夜里关机 / 断网 / 跑失败时**：不会卡死、也不会留半成品——整夜没跑就原样留到下一晚（09:00 简报会写明"昨晚没有夜跑记录"）；跑了但失败会自动重试（同一轮内快速重试 + 本晚后续补跑时机接着试，一晚最多 6 次），失败会留一份「编排器兜底报告」说明原因。细节见 `_night\README.md`「机器关机 / 断网 / 断电会怎样」。

- 开关：`_night\PAUSE` 存在 = 停用夜跑；`_night\STOP` 存在 = 当前这轮收尾退出。
- 执行器 `_night\run.mjs`（`night` / `morning` 两个模式），机制细节、手动触发、改时间见 `_night\README.md`。
- **夜里用哪个 agent CLI 由 `_night\agents.json` 定**（默认无头 ZCode，可切 Codex 等；`%NIGHT_AGENT%` 或 `run.mjs --agent <名字>` 临时换，`--dry-run` 先看将执行的命令）。这样接新模型/新 CLI 是改一段配置，不是改编排器。

## 几条最容易踩的硬性禁止

- **不要把工作区根目录变成 git 仓库**——子仓库会被当成 submodule。项目各自独立 git。
- **不要把软件本体、反编译产物、下载物、压缩包放进工作区**；判据见 `CONVENTIONS.md` 第 0 节。
- **不要批量搬迁老项目**——会切断 Agent 会话记忆、`.zcode\config.json` 的 `--repo` 绝对路径、`.codegraph\` 索引和 AOCI hooks。老项目用到哪个搬哪个，搬完重跑 `codegraph init` 和 AOCI 接线。
