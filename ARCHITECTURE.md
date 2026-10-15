---
arch-version: 6
updated: 2026-10-15
---

# WorkSpace 工作区架构

> 一句话：**把一台机器上所有项目装进同一个容器，用一份约定 + 一个脚本让任意 agent 可复现地管理它们——白天人机协作、夜里无人值守推进、每天早上树是干净的。**

本文是这套架构的**可移植说明书**，三种用法：

| 你要做什么 | 怎么用本文 |
| --- | --- |
| 在另一台机器 / 另一个环境复现这套架构 | §1 读懂设计 → §3 改参数 → §4 逐模块落地 → §7 验收 |
| 拿到外部改进版，升级当前架构 | 直接照 **§8 升级协议**执行（唯一入口，不要自由发挥） |
| 只想理解它为什么长这样 | §1 → §2 → §5 |

**本文的边界**：本文只描述"有哪些部件、为什么这样设计、契约格式是什么、怎么验收、怎么升级"。**各文件的具体内容不在本文复述**——真源永远在各文件本身（`CONVENTIONS.md` / `AGENTS.md` / `ws.mjs` / `_night\` …）。这样本文升级时不会和各文件漂移。

**术语**

- **工作区（WorkSpace）**：容纳所有项目的根目录。**本身是一个 git 仓库，但只是框架仓库**——白名单 `.gitignore` 只跟踪框架（根规则、`ws.mjs`、`_template\`、`_night\`、容器与库的说明文件），项目与生成物不进。
- **项目**：工作区下的一级目录，各自是独立 git 仓库。判据只有一条（M01）。
- **容器**：只用来按类归拢项目的目录（如 `WorkFlows\`）。本身不是项目。
- **库**：跨项目共享的资源目录（`Tools\`、`Skills\`）。不是项目、不进项目统计。
- **架构层**：让上面四样运转起来的基础设施（根规则、工具脚本、模板、夜跑机制、本文）。升级时只有这一层会被改动。

---

## 1. 设计目标与硬约束

目标（按重要性）：

1. **项目互不干扰**：一个项目一个目录一个 git，任何项目出问题不牵连别的。
2. **全貌一眼可见**：任意时刻一条命令就知道有哪些项目、各自什么状态、下一步是什么。
3. **规范不靠人记**：规范写成脚本能执行的形式，偏差由工具自动暴露，不靠自觉。
4. **Agent 无关**：ZCode / Codex / Claude Code / … 任何 agent 进来都读同一套规则、共用同一套库。
5. **离线 / 内网可用**：技能与工具的真源都在本地，不依赖联网市场。
6. **夜里也能推进**：无人值守队列 + 夜跑 / 早检闭环，早上交付一个干净的树。

硬约束（决定了结构为什么长这样）：

| 约束 | 原因 |
| --- | --- |
| 根目录只有**一个框架仓库**（白名单只跟踪框架） | 根建仓最容易踩的坑是子目录变 submodule / gitlink。解法不是"根不建仓"，而是白名单 `.gitignore`：`/*` 先全部忽略，再逐个 `!` 放开框架文件——项目 / 工具本体 / 产物默认被忽略，`git add -A` 碰不到子仓库，框架文件又有了版本控制 |
| 规范与行为**分成两份真源** | 一份管"结构长什么样"、一份管"agent 该怎么做"；混在一起，改一边会误伤另一边 |
| **生成物绝不手改** | 手改必被下次生成覆盖，而且掩盖真实状态 |
| **单一真源** | 技能 / 工具本体只维护一份，多处分发用链接；两份真源必然漂移 |
| 软件本体、产物、下载物**不进工作区** | 工作区只装"自己写的东西"，否则 git、备份、统计全部失真 |
| 生成物与项目**不进根仓库** | 根仓库只装"框架自己写的东西"（判据同 M01，见上一条）：产物进历史则 diff 全是噪声，子仓库进历史则变 gitlink |

## 2. 分层结构

```text
                     人 / 各种 Agent（ZCode · Codex · Claude Code · …）
                                        │
L7  收尾仪式        每次任务四步：LOG → frontmatter → commit → 刷新 TREE
L6  夜间自动化      两级 NIGHT 清单 → 23:00 夜跑 → 08:30 早检（_night\）
L5  容器            WorkFlows\（kind: 容器，装工作流）
L4  共享库          Tools\（工具）· Skills\（技能分发）
L3  工作区工具      ws.mjs：tree / today / new / adopt / night
L2  标准项目结构    README + LOG + NIGHT + AGENTS + .gitignore + 自己的 .git
L1  工作区骨架      AGENTS.md · CONVENTIONS.md · TREE.md · _template\ · _archive\
L0  边界判据        「能不能 git init 并且只提交你自己写的东西？」
```

各层详解见 §4。两条贯穿全层的原则：**能自动化的一律自动化**（项目树、统计、合规检查、夜间执行）；**状态写在文件里，不留在对话里**（frontmatter 的 `next`、LOG 的取舍、NIGHT 的队列）。

## 3. 参数：复现到别处只需要改这些

可移植性来自两点：**工具脚本全部按自身位置定位工作区根**（`ws.mjs`、`_night\run.mjs`、`Skills\sync.mjs` 都用脚本自身路径求根——整棵树可以整体搬走、脚本不用改）；真正要按环境调整的只有下表。

<!-- LOCAL-PARAMS: begin 本地参数区。升级时保留本区块，用本工作区的值覆盖新文档里的同名区块 -->

| 参数 | 本工作区取值 | 出现位置（改动点） |
| --- | --- | --- |
| 工作区根 | `D:\WorkSpace` | 各说明文档里的绝对路径文字：根 `AGENTS.md` / `CONVENTIONS.md`、`_template\*`、`_night\prompts\*.md`、`_night\tasks\*.xml`、容器层 README / AGENTS |
| 无头 agent CLI | 默认 `zcode`（`D:\Zcode\resources\glm\zcode.cjs`，`%ZCODE_CLI%` 可覆盖）；可切 `codex`（自动找 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`，`%CODEX_CLI%` 可覆盖）；再加别家就往 `_night\agents.json` 加一段 | `_night\agents.json`（命令模板 + 候选路径 + 环境变量）· `_night\agent.mjs`（解析/拼接）· `_night\run.mjs` 的 `--agent` / 环境变量 `NIGHT_AGENT` |
| 换 agent / 换模型 | 只改数据不改代码：`agents.json` 的 `default` 换默认、`argv` 改命令形状、`extra` 塞 `--profile <名字>` 之类；`node _night\run.mjs --list-agents` / `--dry-run --agent codex` 先看结果。**内网模型接在 Codex 上**：写 `%USERPROFILE%\.codex\<名字>.config.toml`（provider / base_url / 模型），再把 `["--profile","<名字>"]` 放进 `extra` | `_night\agents.json` · `_night\agent.mjs` · `_night\README.md` 的「换 agent / 换模型」一节 |
| node 可执行文件 | 注册时自动注入当前 node | `_night\tasks\*.xml` 的 `<Command>`（由 `register.mjs` 注入，不用手改） |
| 夜跑时刻 | 23:00 起跑 · 07:30 agent 停开新任务 · 07:45 归档完成 · 07:50 编排器自杀 · 08:00 计划任务硬超时（PT9H） | `_night\tasks\night-run.xml`（`StartBoundary` / `ExecutionTimeLimit`）· `_night\run.mjs` 的 `NIGHT_SELF_KILL` · `_night\prompts\night.md` |
| 早检时刻 | 08:30 起跑 · 编排器 25 分钟后自杀（≈08:55）· 09:00 计划任务硬超时（PT30M） | `_night\tasks\morning-check.xml` · `_night\run.mjs`（`MORNING_SELF_KILL_HOUR` / `MORNING_MAX_MINUTES`）· `_night\prompts\morning.md` |
| 补跑时机 | 夜跑 23:00 + 00:30 / 02:00 / 03:30 / 05:00 / 06:30；早检 08:30 + 09:45（`StartWhenAvailable` 实测**不**补跑，所以挂多个定时；`run.mjs` 的 `nightKey()` 保证一晚只跑一次） | `_night\tasks\*.xml` 的多个 `<CalendarTrigger>` · `_night\run.mjs` 的 `nightKey()` / `hasPendingReview()` |
| 简报时刻 | 09:00 弹「前日总结 + 待审」窗口 · **窗口不自动关闭**（看完自己关；关窗＝什么都没批）· 计划任务脱手起窗口（`PT20M` 只是兜底）· 早检在 08:55 前预生成简报 | `_night\tasks\daily-brief.xml` · `_night\brief.mjs`（默认 `--timeout 0`）· `_night\launch-hidden.vbs` · `_night\prompts\morning.md` |
| 无头 CLI 环境变量 | 只有 `zcode` 这条需要：计划任务环境里必须自补 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（桌面端才会设它），`agent.mjs` 按 `~\.zcode\v2\runtime\provider\<平台>\<版本>\endpoint-*\zcode-builtin.json` 推导；别的 agent 不触发这个逻辑，也不会因此告警 | `_night\agents.json` 的 `env."@zcode-provider"` · `_night\agent.mjs` 的 `zcodeProviderConfig()` |
| 运行时间窗 | 夜跑 21:00–07:00 · 早检 06:00–10:00（挡住"机器晚开机补跑"落到白天；调试/演练可用环境变量 `NIGHT_WINDOW` / `MORNING_WINDOW` 覆盖） | `_night\run.mjs` 的 `inWindow(NIGHT_WINDOW/MORNING_WINDOW)` 调用点 |
| 失败重试 | 一整晚最多 6 次尝试（= 6 个触发时机）；同一轮内"快速失败"（<5 分钟且非强杀）隔 120 秒再试一次；被强杀不重试 | `_night\run.mjs` 的 `MAX_ATTEMPTS` / `RETRY_DELAY_SEC` / `FAST_FAIL_MIN`（环境变量 `NIGHT_MAX_ATTEMPTS` / `NIGHT_RETRY_DELAY_SEC` / `NIGHT_SELF_KILL`） |
| 工具库路径 | `Tools\`（相对根） | `Tools\README.md` 的迁移记录 + 各 agent 配置里的绝对路径 + `_template\README.md` 的"相关"节 |

<!-- LOCAL-PARAMS: end -->

**改法**：把架构层文件复制到新环境后，逐项把上表改成新环境的值；除表中注明的位置外，脚本本身不用改。若某个参数在新环境不适用（例如不部署夜跑），把对应模块整块略去，不要留半套。

**架构层文件清单（复现时按这份清单复制）**：

```text
<工作区根>\               （= 一个 git 仓库：框架仓库，白名单 .gitignore 只跟踪本层）
├─ .gitignore           根仓库白名单：默认全部忽略，只放开框架文件
├─ .gitattributes       按原样存取（* -text，不做 CRLF ↔ LF 自动转换）
├─ AGENTS.md            行为规则（含收尾四步、库在哪、硬性禁止）
├─ CONVENTIONS.md       规范真源（结构 / 格式 / 命名 / 接入流程 / 边界）
├─ ARCHITECTURE.md      本文（版本 + 模块清单 + 升级协议）
├─ CLAUDE.md            指向 AGENTS.md 的一行（其他 agent 的入口别名）
├─ NIGHT.md             工作区级夜间清单（可空）
├─ ws.mjs               工作区工具（tree / today / new / adopt / night）
├─ TREE.md              生成物，可留空，跑 tree 重建（不进根仓库）
├─ _template\           新项目模板：README.md / LOG.md / NIGHT.md / AGENTS.md / .gitignore
├─ _archive\README.md   休眠区说明（归档规则；里面的休眠项目不进根仓库）
├─ _night\              夜间机制：run.mjs / prompts\ / tasks\ / register.cmd|mjs / README.md（runs\ 等产物不进根仓库）
├─ WorkFlows\           容器示例：README.md（kind: 容器）+ AGENTS.md（子项目不进根仓库）
├─ Tools\               共享工具库（README.md 与 _setup\ 随根仓库跟踪，工具本体不进）
└─ Skills\              技能库：README/AGENTS + sync.mjs + skills\（库内容按需，本身是项目，不进根仓库）
```

各项目目录（含容器下的子项目）不属于架构层——它们各自带自己的内容与 git，复制架构时不要连带搬走；根仓库的白名单也保证它们不会被收进框架的版本控制。

## 4. 模块清单

升级协议（§8）的执行单位就是下面 13 个模块。每个模块给出：**作用 / 落点 / 验证**。

### M01 边界判据
- **作用**：定义"什么算项目"，挡住一切不该进来的东西。唯一判据：**能不能 `git init` 并且只提交你自己写的东西？** 不能的（软件本体、反编译产物、下载物、压缩包、临时文件）不是项目。
- **落点**：`CONVENTIONS.md` 第 0 节（真源）；`ws.mjs` 的 `adopt` 按它拒绝接入模板 / 库 / 根。
- **验证**：拿一个安装包问自己这条判据，答案应为"不是项目"。

### M02 双真源：规范与行为
- **作用**：`CONVENTIONS.md` = 规范（结构、格式、命名、接入流程、边界）；`AGENTS.md` = 行为（agent 每次要做什么、常用命令、库在哪）。两者不互相复述，改哪边只改哪边。
- **落点**：根 `CONVENTIONS.md`、根 `AGENTS.md`；容器与项目各有自己的 `AGENTS.md`（只写局部规则、指回根）；根 `CLAUDE.md` 只是指向 `AGENTS.md` 的一行（不同 agent 的入口文件名不同，避免两处维护）。
- **验证**：随便挑一条规则，它应只在一份文件里被完整描述。

### M03 标准项目结构
- **作用**：每个项目固定骨架——`README.md`（frontmatter 机器读 + 正文人读）、`LOG.md`（日期倒序的取舍记录）、`NIGHT.md`（夜间队列）、`AGENTS.md`（本项目规则）、`.gitignore`（通用基线）、自己的 `.git`。
- **落点**：`_template\` 是真源；`ws.mjs new` 复制模板并替换占位符；`ws.mjs adopt` 只补缺、不覆盖已有内容（沿革：新项目走 `new`，已有内容走 `adopt`）。
- **验证**：`node ws.mjs tree` 里该项目行没有 `[?]`、`无 git`。

### M04 收尾固定动作
- **作用**：每次任务结束四步——① `LOG.md` 追加当日条目（写意图 / 取舍 / 为什么，不抄 git 能记住的）② `README.md` frontmatter 更新 `status` / `next` ③ `git add -A && git commit`（一句话说清）④ 项目状态有变则刷新 `TREE.md`。目的是"两周后的自己 / 下一个 agent 能直接接上"。
- **落点**：`_template\AGENTS.md` 与各项目 `AGENTS.md`；`CONVENTIONS.md` 第 8 节。
- **验证**：任意项目 `git status` 干净、`LOG.md` 有当天日期小节。

### M05 工作区工具 `ws.mjs`
- **作用**：把规范变成可执行命令，是"规范不靠人记"的落点。子命令：
  - `tree` 重新生成 `TREE.md`
  - `today [--date YYYY-MM-DD]` 汇总某天推进（git 提交 + LOG 条目）
  - `new <名称> [--desc]` 按模板建项目并首次提交（名称可带路径，如 `WorkFlows\<名>`，父目录不存在会自动建）
  - `adopt <目录>` 把已有内容接进规范：缺什么补什么，**绝不覆盖**已有文件 / 已有 `.gitignore` 规则 / 已有 git 历史；不是仓库才 `git init`，已是仓库不替用户提交
  - `night` 看两级夜间清单现状 + 上次夜跑结果 + 锁状态
  - `task add <标题> [--desc] [--project] [--review] [--source]` 往夜间清单加一条（默认 `[待跑]` 进工作区级；`--review` 记成 `[待审]`，agent 用这个；项目没有 `NIGHT.md` 就从模板新建）——积压攒任务的入口
  - `review [--report 一页 HTML] [--title 文本]` 弹审批窗口审 `[待审]`（带 `--report` 时窗口多一个报告页签，没有待审条目也能开窗纯展示），结果写回 NIGHT.md 并只提交改动过的那个文件
  - `status [--json] [--date D] [--history N]` 全量状态快照。`--json` 是机器读契约（`workspace-status/1`）：看板、前日简报、将来接内网的模型都只读它，不各自解析 markdown
  - `board [--open]` 生成夜跑看板 HTML（渲染逻辑转发 `_night\board.mjs`，只有一份）
- **落点**：根 `ws.mjs`（零依赖，只吃系统 node）。按自身位置定位根目录。
- **验证**：各子命令各跑一次不报错；`task add` 加完 `night` / `status --json` 能立刻读出来。

### M06 `TREE.md` 与合规暴露
- **作用**：自动生成的工作区全貌——项目树（每个项目的状态 / 最后更新 / 提交数 / 下一步）、活跃项目下一步汇总、夜间清单概况、**"需要补齐"**（一切不合规项：缺 frontmatter 字段、没有 git、容器里不是项目的目录）。它是唯一的合规检查入口：**看这一份就知道哪里不对**，不需要单独的检查命令。
- **约定**：文件头标"自动生成，请勿手改"；扫描跳过 `_template\`、`Tools\`、`_night\`（基础设施不参与项目统计）；"最后更新"取 git 提交时间 / LOG 日期 / 目录 mtime 三者最新，不用手写。
- **落点**：`ws.mjs tree` 生成。
- **验证**：故意删掉某项目 frontmatter 的 `status`，重跑 `tree`，该项目应出现在"需要补齐"。

### M07 库之一：`Tools\`（共享工具）
- **作用**：跨项目共享的 agent 工具本体集中放这里，一份共享。**不是项目**：不建自己的 git、不进 TREE 统计（`README.md` 与 `_setup\` 随根仓库跟踪，工具本体不进）。
- **约定**：库自己的说明（版本、升级、卸载、每项目接入步骤）只在本库 README 维护，**不写进任何 agent 说明文件**（agent 侧只留必要接线 + 一行指路）；代码索引 / 图谱类数据永远留在各项目里，不进库；库内文件被别处以绝对路径引用——**移动库必须同步所有引用点**，引用点清单记在库 README 的「迁移记录」，搬之前先看那里。
- **落点**：`Tools\` + 库内 `README.md`。
- **验证**：库目录不出现在 `TREE.md` 的项目统计里；库内说明能被单独读懂。

### M08 库之二：`Skills\`（技能真源与分发）
- **作用**：所有 agent 共用技能的**唯一真源**，离线可用。**它本身是一个符合规范的项目**（可当样板）。
- **约定**：技能放 `skills\<名称>\SKILL.md`，目录名必须等于 `SKILL.md` 里的 `name` 字段；分发走链接——编辑链接目录等于编辑库，不要在两处分别改；某个项目要固定技能时用复制（真实文件随项目提交）。工具 `sync.mjs` 四步：`list`（看库与各分发点状态）/ `pull`（从项目或仓库发现技能并入库）/ `link`（链接分发到各 agent 技能目录）/ `use`（复制某技能进某项目）。
- **落点**：`Skills\`（含 `sync.mjs`）。
- **验证**：`node sync.mjs list` 无异常；某技能在库与至少一个 agent 目录同时可见且同源。

### M09 容器
- **作用**：按类归拢项目而不破坏"项目各自独立"——容器本身不是项目（不建 git、不记 LOG、不进项目统计），只负责分组；其下每个子文件夹各自是独立项目。
- **约定**：容器目录 `README.md` 的 frontmatter 写 `kind: 容器`（`ws.mjs` 靠它识别并继续往里扫子项目）；容器里"不是项目"的子文件夹会被列进 TREE 的"需要补齐"并附接入命令；容器**不要** `git init`（子目录会变 gitlink）。将来加别的容器（按客户、按阶段）照同法标记。
- **落点**：`WorkFlows\`（README + AGENTS）是真源示例。
- **验证**：容器在 `TREE.md` 里渲染成节点、子项目缩进列出；容器自身行没有提交数统计。

### M10 生命周期与 `_archive\`
- **作用**：项目状态只允许四个词 `活跃 / 暂停 / 已完成 / 归档`（TREE 按它统计，漏填显示 `[?]`）。停掉的项目**只移不删**：移进 `_archive\`，`status` 改 `归档`，补一句为什么停；复活就移回根目录改回 `活跃`。
- **落点**：`CONVENTIONS.md` 第 3 / 7 节；`_archive\README.md`。
- **验证**：`_archive\` 里的项目仍在 `TREE.md` 可见（只是不计入活跃）。

### M11 夜间清单（两级队列）
- **作用**：把"适合夜里做的任务"从对话里沉淀成可执行队列。**工作区级**队列（根 `NIGHT.md`）只放跨项目、动基础设施的事；**项目级**队列（各项目 `NIGHT.md`）放那个项目自己的事。
- **约定**：一行一条 `- [状态] 标题 | 说明或验收标准 | 来源 日期`。状态词：`待跑`（可执行）/ `待审`（等用户点头，**夜跑绝不碰**）/ `完成 YYYY-MM-DD` / `未完成` / `搁置`。**谁能写**：用户随时写 `[待跑]`（或 `ws.mjs task add`）；agent 想到夜间任务只能写 `[待审]`（`task add --review`），并在收尾时提醒用户，用户点头后才可改 `[待跑]`；项目级 → 工作区级的提升只有用户能做。
- **积压与节奏（v4）**：清单是**积压队列**——任务可以一直攒，夜跑每晚最多开工工作区级 `NIGHT.md` frontmatter 的 `每晚条数` 那么多条（默认 3），同一项目一晚最多 2 条；没轮到 / 没做完的**自动顺延**到下一晚，`[未完成]` 下一晚优先接着收尾。`搁置` 只用于"需要用户拍板 / 依赖外部条件"，不拿来清积压。
- **落点**：根 `NIGHT.md`、`_template\NIGHT.md`；节奏规则在 `_night\prompts\night.md`（真源）。
- **验证**：`node ws.mjs night` 能列出两级清单与各自计数；`node ws.mjs task add "验收测试"` 后同一口径能读出新条目。

### M12 夜间自动化（夜跑 + 早检 + 09:00 简报）
- **作用**：无人值守执行 `[待跑]` 队列，早上交付干净的树，并把「昨天+昨晚」总结成一页、在 09:00 弹成窗口。**它是基础设施，不是项目**：不建自己的 git（代码/配置/提示词随**根仓库**跟踪，`runs\` 等产物不跟踪）、不进统计。
- **一天**：23:00 计划任务起夜跑（另有 5 个凌晨补跑时机，`nightKey()` 保证一晚只跑一次）→ 无头 agent 读 `_night\prompts\night.md`，按"工作区级 → 各活跃项目"执行，只做 `[待跑]`；每条完成即 LOG + README + commit + 改清单状态为 `[完成]` → 07:30 停止开新任务、归档、写报告 → 07:50 编排器自杀进程树 → 08:00 计划任务硬超时（最后兜底）→ 08:30 早检 agent 核实收口（清残留、提交脏树、补 `[未完成]` 接续点）并**预生成前日简报**（`brief.mjs --build`，可选写 3–5 句人话摘要）→ 09:00 计划任务 `WorkSpace-DailyBrief` 弹**一个**窗口：「前日总结」+「待审 勾选」。
- **机制要点**：
  - 编排器 `_night\run.mjs`（`night` / `morning` 两个模式，`--force` 手动跑）；收尾会刷看板（失败不影响本体）。
  - **框架文件的提交归属（v6）**：工作区级任务改的多是框架文件——在**根仓库**提交（`git -C <工作区根> add -A && git commit`），白名单保证项目不会被卷进来。夜跑开局对"本次要动"的项目归拢日间遗留时，根仓库同样归拢一条 `日间遗留：工作区框架`；早检收口时补 `夜跑收尾：工作区框架 · <说明>`（口径在 `prompts\night.md` / `prompts\morning.md`）。
  - **三道停止闸，顺序有讲究**：agent 自己 07:30 停机（软）→ 07:50 编排器强杀（防 agent 卡死）→ 08:00 计划任务硬超时。**编排器自杀必须早于计划任务硬超时**，否则 agent 会成为没人管的孤儿。8:30 早检再收一次口。四道都为了"早上 9 点前树是干净的"。
  - **无头 CLI 要自补 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`**（只有 `zcode` 这条需要）：这个变量只有 ZCode 桌面端给子进程时才设，计划任务环境里没有，缺了它整个夜跑当场失败（2026-10-15 实测）。`agent.mjs` 按目录推导，不写死版本号与哈希。
  - **换 agent / 换模型是配置不是代码**：起哪个 CLI、带什么参数、补什么环境变量全在 `_night\agents.json`；`run.mjs` 只问 `agent.mjs` 要一条命令。默认 `zcode`，可切 `codex`（`codex exec <prompt> --cd <root> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --color never`）；内网模型接在 Codex 上就用 `extra: ["--profile","<名字>"]` 选 `%USERPROFILE%\.codex\<名字>.config.toml`。`--list-agents` / `--dry-run --agent X` 可在白天先看清将执行的命令。
  - **`StartWhenAvailable` 靠不住**：实测机器晚开机时错过的触发不会补，所以每个任务挂多个定时时机，靠时间去重键 `nightKey()` 收敛成"一晚一次"。
  - **失败自动重试（断网 / 关机 / 断电加固，v3）**：一晚是否算跑过，看状态账本 `runs\<日期>-night.state.json` 的 `autoDone`（**自动**的一轮走完归档、报告落了 `NIGHT-SUMMARY` 才置真），尝试上限也只数 `autoAttempts`；不看"日志/报告在不在"——一次快速失败不再毒死本晚后面所有补跑时机。同一轮内快速失败（<5 分钟且非强杀）隔 120 秒再试一次；一整晚最多 6 次自动尝试，到顶留到下一晚。**手动 `--force` 不占名额**（不写 `autoDone`、不进 `autoAttempts`：测试跑不顶掉当晚自动夜跑、也不吃重试额度）；`--force` 本身不受去重与上限约束。
  - **失败也要留痕**：agent 没走完归档时，编排器替它写一份「编排器兜底报告」（刻意不含汇总行），早上的简报/看板据此把"夜跑失败（断网 / CLI 起不来 / 被强杀）"和"机器没开"区分开；提示词里还交代了断网空转（停止尝试、条目保持 `[待跑]`）与断电残锁（`git index.lock` 确认后删除，唯一的删文件例外）。
  - 开关：`_night\PAUSE` 存在 = 停用夜跑；`_night\STOP` 存在 = 本轮收尾退出（agent 处理完自删）。
  - 锁：`.lock` / `.lock-morning`（含 pid），正常结束删除，残留说明上轮异常、下轮自动接管。
  - 产物：`_night\runs\<日期>-night.md`（报告）/ `.log`（完整输出）/ `<日期>-morning.md` / `_scheduler.log`；报告末尾一行机器可读汇总（格式见 §5）。
  - **09:00 简报窗口**：`brief.mjs --show` → `ws.mjs review --report <简报 html>` → `审批窗口\approve.ps1`。全程确定性脚本，**不依赖模型、不联网**：模型只做可选的 3–5 句人话摘要（`prompts\brief-notes.md`），不做数据、渲染和决定；**窗口不自动关闭**（看完自己关），关窗一律＝什么都没批。窗口任务经 `launch-hidden.vbs` 脱手起 node：任务进程立刻退出（窗口不受任务超时限制），也不会有黑控制台窗口。
  - 计划任务以"交互式登录令牌 + 最低权限"注册（免管理员、免存密码，代价是注销状态不跑）。
- **落点**：`_night\`（`run.mjs` / `prompts\` / `tasks\*.xml` / `register.cmd|mjs` / `board.mjs`+`board\` / `brief.mjs`+`brief\` / `lib.mjs` / `sections.mjs` / `agent.mjs`+`agents.json` / `launch-hidden.vbs`）；窗口引擎在项目 `审批窗口\`（见 M14）。
- **验证**：`node _night\run.mjs night --force` 端到端跑通（首次部署必做），锁正常释放、报告有汇总行；`node ws.mjs status --json` 输出合法 JSON；`node _night\brief.mjs --selftest` 与 `node _night\board.mjs --selftest` 通过；`node _night\brief.mjs --show --force` 能弹出窗口（窗口可见、无多余控制台）。

### M13 本文档自身（版本与升级）
- **作用**：让架构可搬运、可演进。自带 `arch-version`、模块清单、参数区、升级协议、变更历史。
- **约定**：对外每发布一版 `arch-version` 加 1；变更历史逐版记"改了什么、为什么"；本地参数区用 `<!-- LOCAL-PARAMS -->` 标记，升级时保留本地值；升级一律走 §8。
- **验证**：模块清单与实际文件对得上；参数表无过期路径。

### M14 视图层：状态快照 · 看板 · 前日简报 · 弹窗（v2 新增）
- **作用**：把"状态"从文件里读出来、渲染成人一眼能看的东西，并让用户在一个窗口里完成早上的"看总结 + 点头"。分三层，模型只在最薄的一层（可选）出现：
  - **取数**：`node ws.mjs status --json`（唯一解析 markdown 的口径）→ 契约 `workspace-status/1`；
  - **渲染**：`_night\lib.mjs`（共用取数/转义/模板小库）+ `_night\sections.mjs`（分区渲染：状态条/两级清单/项目一览/推进/夜跑历史/需补齐）+ `_night\board.mjs`（看板整页）+ `_night\brief.mjs`（前日总结页，**内嵌 sections 的同一批分区**——早上一个窗口全看完）；文案与样式在模板文件里，逻辑不碰文案；
  - **交互**：窗口引擎是项目 `审批窗口\`——spec JSON 进、result JSON 出；spec 的 `report` 字段让它多一个 HTML 页签（前日总结走这条），关窗/超时绝不等于同意。
- **约定**：
  - 视图全部是**确定性生成物**：离线、零依赖、无 JS、无 CDN；数据变化先落回文件（NIGHT.md / README.md / LOG.md / runs\），再重跑命令刷新；生成物不手改。
  - 模板只用最保守的 CSS（无 flex/grid/变量）——简报会被 WinForms 的 IE 内核渲染；`{{占位符}}` 少一个就报错，宁可报错也不出半张页面。
  - 每个模板文件头部注释列出它的全部占位符；改文案只改模板，不改逻辑。
  - 弹窗**只有一个日常入口**：09:00 的 `WorkSpace-DailyBrief`（`brief.mjs --show`）；想单独审清单用 `ws.mjs review`。
  - 为「将来接内网慢/弱模型」准备：模型只写 `brief\notes-<日期>.md` 的 3–5 句（`prompts\brief-notes.md`，含格式示例与"写不出就跳过"的兜底）；数据、统计、渲染、决定全部不经过模型。
- **落点**：`ws.mjs`（`status` / `board` / `review`）；`_night\lib.mjs`、`_night\sections.mjs`、`_night\board.mjs` + `board\template.html`、`_night\brief.mjs` + `brief\template.html`；`审批窗口\`（`approve.mjs` / `approve.ps1`）。
- **验证**：`node ws.mjs status --json` 是合法 JSON；`node _night\board.mjs --selftest`、`node _night\brief.mjs --selftest`、`node ws.mjs review --report <html> --selftest` 均通过；生成的看板/简报离线能打开、中文不乱码。

## 5. 机器可读契约汇总

复现与升级都要的精确格式。真源分散在各处，这里只汇总语法：

| 契约 | 格式 | 真源 |
| --- | --- | --- |
| 项目 frontmatter | 文件顶部 `---` 块，字段 `desc` / `status` / `next`；`status` ∈ {活跃, 暂停, 已完成, 归档} | `CONVENTIONS.md` 第 3 节 |
| 容器标记 | 容器 README frontmatter 增加 `kind: 容器` | `CONVENTIONS.md` 第 1 节 |
| LOG 日期小节 | `## YYYY-MM-DD`，日期倒序，同日合并 | `CONVENTIONS.md` 第 4 节 |
| 夜间清单条目 | `- [状态] 标题 \| 说明或验收标准 \| 来源 日期` | `CONVENTIONS.md` 第 5 节 |
| 夜间清单 frontmatter | 工作区级 `NIGHT.md` 顶部：`level: 工作区` / `updated: YYYY-MM-DD` / `每晚条数: N`（夜跑每晚开工上限，默认 3；`ws.mjs task add` 也会读它做提示） | `NIGHT.md` · `_night\prompts\night.md` |
| 夜跑汇总行 | 报告末尾 `<!-- NIGHT-SUMMARY: date=YYYY-MM-DD done=N unfinished=N blocked=N finish=HH:MM -->`（一字不差）；同一报告有多行时**取最后一行**（白天手动跑 + 当晚自动跑会写进同一份报告，最终结果才算数） | `_night\prompts\night.md` · 读取口径 `ws.mjs` |
| 运行锁 | `.lock` / `.lock-morning`：JSON `{mode, pid, startedAt}`；正常结束删除 | `_night\run.mjs` |
| 开关文件 | `_night\PAUSE`（停用夜跑）/ `_night\STOP`（本轮收尾退出，agent 自删） | `_night\run.mjs` |
| 运行产物 | `runs\<日期>-night.md`、`<日期>-night.log`、`<日期>-morning.md`、`<日期>-<模式>.state.json`、`_scheduler.log`（日志与状态账本超 90 天自动清理，报告不删） | `_night\run.mjs` |
| 本晚运行状态 | `runs\<日期>-<模式>.state.json`：`{key, mode, attempts, autoAttempts, lastExit, ok, autoDone, lastEndedAt}`；跨触发时机去重（`autoDone`）与重试上限（`autoAttempts`）都看它，手动跑只进 `attempts` | `_night\run.mjs` |
| 兜底报告 | 报告存在但**没有** NIGHT-SUMMARY = 没走完归档（视图层据此判"失败"）；编排器在失败时写「编排器兜底报告」，开头写明"这不是 agent 写的" | `_night\run.mjs` · `_night\prompts\morning.md` |
| 技能目录 | `skills\<名称>\SKILL.md`，目录名 == `SKILL.md` 的 `name` | `Skills\README.md` |
| 生成物 | `TREE.md` 头部标"自动生成，请勿手改" | `ws.mjs` |
| 根仓库跟踪范围 | `.gitignore` 白名单：`/*` 全部忽略 + 逐条 `!` 放开框架文件（根规则 / `ws.mjs` / `_template\` / `_night\` 代码配置提示词 / 容器与库的说明文件）；`.gitattributes` = `* -text`（按原样存取） | `CONVENTIONS.md` 第 1 节「根仓库」· 根 `.gitignore` |
| 状态快照 | `node ws.mjs status --json` 输出 `{schema:"workspace-status/1", generatedAt, date, root, counts, workspace.night, projects[], nightSystem{pause,stop,lock,last,history[]}, needsFix[]}`；清单条目带 `file` + `line`（写回用） | `ws.mjs` 的 `snapshot()` |
| 简报事实快照 | `_night\brief\data-<日期>.json`：`{schema:"daily-brief/1", date, generatedAt, headline[], notes, facts{day, night, doneItems, stuck, pending, morning, dirty}}` | `_night\brief.mjs` |
| 窗口 spec | JSON：`title / message / topMost / countdownFormat / buttons{} / items[{id,title,tag,detail,checked}] / report{title,file,itemsTitle?,openPath?,openLabel?}`；带 `report` 时 `items` 可为空（纯展示） | `审批窗口\approve.mjs`（校验）/ `approve.ps1`（渲染） |
| 窗口 result | `{action: ok\|rejectAll\|later\|timeout, decisions:{id: approve\|reject\|later}, at}`；写入 `--out`；关窗/超时＝全部 later | `审批窗口\approve.ps1` |
| 隐藏启动器 | `_night\launch-hidden.vbs <脚本> [参数...]`，node 路径读同目录 `node-path.txt`（`register.mjs` 写） | `_night\launch-hidden.vbs` |
| agent 定义 | `_night\agents.json`：`{ default, agents: { <名字>: { label, bin[], scan[], argv[]（`{bin}` `{node}` `{prompt}` `{root}` `{extra}`）, env{}, extra[] } } }`；`bin`/`scan` 支持 `%VAR%` 与 `*` 通配（取最新） | `_night\agents.json`（真源）· `_night\agent.mjs`（读 + 拼 + `--list` / `--dry-run`） |

## 6. 一天的样子（运转时序）

```text
白天（人在）
  接任务 → 干活 → 四步收尾（LOG / frontmatter / commit / 刷 TREE）
  想到"适合夜里做"的活 → 写进 NIGHT.md：
      用户提的     → [待跑]
      agent 想到的 → [待审]（收尾时提醒用户）→ 用户点头后才改 [待跑]
  看状态：node ws.mjs tree | today | night

夜里（无人）
  23:00 夜跑开始：只做 [待跑]；每条完成即 LOG + README + commit + 改清单状态
  07:30 停开新任务 → 归档、写报告（含 NIGHT-SUMMARY 行）
  07:50 编排器自杀（兜底 agent 卡死）
  08:00 计划任务硬超时（最后兜底）

早上（无人 → 人）
  08:30 早检：清残留、提交脏树、补 [未完成] 接续点、预生成前日简报（+可选人话摘要）
  08:55 早检结束 → 工作树干净
  09:00 弹一个窗口：「前日总结」+「待审 勾选」（纯确定性，不依赖模型）
  09:15 窗口没人动自动关＝什么都没批；人接手
```

## 7. 验收清单（复现完 / 升级完跑一遍）

- [ ] `node ws.mjs tree` → 项目树正确、零"需要补齐"（全新环境为空属正常）
- [ ] `node ws.mjs today` → 能列出当天推进
- [ ] `node ws.mjs new 验收测试 --desc "临时"` → 生成标准骨架并首次提交；验完删掉这个临时目录
- [ ] `node ws.mjs night` → 两级清单与夜跑状态可读
- [ ] `node ws.mjs task add "验收测试" --desc "临时"` → 条目进清单、`night` / `status --json` 计数一致；验完把那行删掉
- [ ] `node ws.mjs status --json` → 合法 JSON（喂给 `JSON.parse` 不报错）
- [ ] `git -C <工作区根> status --porcelain` → 空（框架仓库只跟踪框架；新建项目、跑完 tree、夜跑过后它都不该变脏）
- [ ] `node _night\board.mjs --selftest` 与 `node _night\brief.mjs --selftest` → 通过
- [ ] `node ws.mjs review --report <一页 html> --selftest` → 窗口自动开合、清单未被改动
- [ ] `node ws.mjs adopt <已有内容的目录>` → 只补缺、已有文件未被覆盖、输出提示清晰
- [ ] §3 参数表逐项对照新环境已改；全文搜索旧根路径，应为空
- [ ] `node _night\register.mjs` → 三个计划任务注册成功（部署夜跑才需要）：NightRun / MorningCheck / DailyBrief
- [ ] `node _night\run.mjs night --force` → 端到端跑通、锁正常释放、报告有 NIGHT-SUMMARY（首次部署必做）
- [ ] **故障演练**：把 `run.mjs` 复制到临时目录、用假 CLI 扮演失败（秒退 / 卡死），验一遍重试、强杀、兜底报告与去重（配方见 `_night\README.md`「调试与调参」）
- [ ] `node _night\brief.mjs --show --force` → 简报窗口可见（屏幕上真的能看到；无多余控制台窗口）
- [ ] 建一个 `_night\PAUSE` → 夜跑跳过；删掉恢复
- [ ] （有 Skills 库时）`node sync.mjs list` → 分发状态正常

## 8. 升级协议（外部改进版进来时怎么执行）

**触发场景**：从外部（另一台机器 / 另一个网络）带来一份改进版本文档，要升级当前架构。升级全程**不需要联网**——新文档以文件形式带入，本文与它逐模块对照即可执行。

**核心思想**：升级不是打补丁，是**逐模块对齐到新文档**。因此新文档必须自带完整的模块清单与参数区，能被单独读懂。

### 8.0 版本规则
- `arch-version` 整数单调递增，每次对外发布加 1。
- 变更历史逐版记一段（改了什么、为什么）。

### 8.1 文件分级（决定升级面）
| 级 | 是什么 | 升级时 |
| --- | --- | --- |
| **A 架构层** | 根 `AGENTS.md` / `CONVENTIONS.md` / `ws.mjs`、`_template\*`、`_night\*`（不含 `runs\`）、`_archive\README.md`、容器层 README / AGENTS、本文 | 可被升级改写 |
| **B 生成物** | `TREE.md`、`_night\runs\*` | 只重跑命令重建，绝不手工迁移（也不进根仓库：白名单已忽略） |
| **C 库** | `Tools\`、`Skills\`（本体与说明） | 独立演进；升级只动接线与指路，不动库内容 |
| **D 内容** | 各项目的全部文件（含各 `NIGHT.md` 里用户写的任务条目、LOG 历史）、库内工具 / 技能本体 | **绝不触碰** |

拿不准归 D。

### 8.2 步骤

1. **通读新文档**：版本、变更历史、模块清单、参数区。
2. **对比**：与现有 `ARCHITECTURE.md` 逐模块列出"有实质变化的模块"；注意新文档可能**新增或删除模块**。
3. **列计划给用户过一眼**：要改哪些文件、每处对应哪个模块。升级是白天的交互操作，不适用夜跑那种"拿不准就选保守做法"——**可以也应该停下来问**。
4. **备份 A 类**：A 类的版本控制就是**根仓库**——先 `git -C <工作区根> status` 确认干净（不干净就先提交一条 `升级前快照`），再照旧复制一份到**工作区外**的时间戳目录（双保险；白名单之外的文件不在版本控制里，备份仍不可省）。
5. **逐模块应用**：只动"有变化"的模块；没变的只跑验证。新增模块按新文档落地；删除模块移除对应 A 类文件与引用（绝不牵连 D 类）。**同步改 `_template\`**——改规范不落模板必然漂移。
6. **参数回填**：按新文档参数区的每一个出现位置，套回本工作区的实际值（§3 的区块就是为这一步准备的）。
7. **验收**：跑 §7 清单 + 本次动过的模块各自验证。
8. **替换本文**：新文档覆盖 `ARCHITECTURE.md`；把它的本地参数区替换回第 4 步前记录的本工作区值；在变更历史追加一条（日期 / 来源 / 改了什么）。
9. **报告**：改了什么 / 没改什么 / 遗留什么 / 需要用户知道的取舍。

### 8.3 冲突处理
- 新文档改动 vs 本地项目内容 → **保项目内容**（架构向项目让路）。
- 新文档改动 vs 本地对架构层的私自改动 → **以新文档为准**，但保留本参数值。
- 新文档自相矛盾，或执行会破坏现有项目 → **停下来问用户**，不要猜。

### 8.4 回滚
`git -C <工作区根> reset --hard <升级前快照>`（或第 4 步的工作区外备份覆盖回 A 类文件）即回到升级前。升级只对**根仓库**做提交，不影响任何项目的 git 历史。

### 8.5 用户可以直接复制的指令

```text
我把架构文档的新版带来了：<新文档路径>，当前工作区是 v<旧版本号>。
按 D:\WorkSpace\ARCHITECTURE.md 第 8 节「升级协议」执行升级：通读两份文档 → 列出
升级计划给我确认 → 备份 A 类文件 → 逐模块应用（同步改 _template\）→ 回填参数 →
跑验收清单 → 用新文档替换 ARCHITECTURE.md 并记变更历史。
不要碰任何项目内容（D 类）。
```

## 9. 不要做什么（反模式清单）

**硬性禁止**

- 不要把项目、工具本体、生成物加进根仓库（根仓库只跟踪框架，白名单 `.gitignore` 已兜底；子仓库进根仓库就变 gitlink）。
- 不要在根仓库里 `git reset --hard` / `git clean -xfd`：白名单之外的东西不在版本控制里，删了找不回来。
- 不要把软件本体、反编译产物、下载物、压缩包放进工作区（判据见 M01）。
- 不要批量搬迁老项目——会切断 agent 会话记忆、项目内 agent 配置里的绝对路径指向、代码索引。老项目用到哪个搬哪个，搬完重跑索引与接线。
- 不要手改生成物（`TREE.md`）。
- 不要把 `[待审]` 当 `[待跑]` 执行（那是在等用户点头的）。

**常见退化（会慢慢毁掉架构）**

- 只在对话里说"下一步"，不落到 frontmatter `next` / `LOG.md`——下一个接手的人或 agent 只能重问一遍。
- 只写日志不提交，或只提交不写日志——前者丢历史，后者丢意图。
- 规范改了不落 `_template\`——新项目从一开始就不合规。
- 技能 / 工具出现第二份真源（在分发点直接改真实文件）——两处必然漂移。
- 容器里随手塞非项目文件——TREE 会点名，但也说明有人在绕过边界判据。

## 变更历史

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 1 | 2026-10-14 | 首版：从 `D:\WorkSpace` 现状整理出八层结构、13 个模块、机器可读契约汇总、复现参数表与升级协议。 |
| 2 | 2026-10-15 | 视图层与早间闭环：新增 **M14**（状态快照 `ws.mjs status --json` / 看板 `_night\board.mjs` / 前日简报 `_night\brief.mjs` / 弹窗复用 `审批窗口\` 的 `report` 页签）；`ws.mjs` 增 `review` / `status` / `board`（更新 M05）；M12 补 09:00 简报窗口、凌晨多补跑时机 + `nightKey()` 去重、无头 CLI 的 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 环境变量、`launch-hidden.vbs`；参数区与契约表同步补行；验收清单补 status/board/brief/弹窗项。全部为"确定性生成、离线、零依赖"，唯一可选的模型介入点缩到 3–5 句人话摘要（`prompts\brief-notes.md`），为接内网慢/弱模型准备。当日第二版：看板与前日简报按"一屏看完"重排（一行一条、长文截断、空层级合并），弹窗按钮/配色重做，**取消自动关闭**（看完自己关；计划任务脱手起窗口）。 |
| 3 | 2026-10-15 | 夜跑健壮性（断网 / 关机 / 断电）：去重判据从"日志文件在不在"改成状态账本的 `autoDone`（**自动**的一轮走完归档才置真；手动 `--force` 跑成功不占名额），一次失败不再毒死本晚后续补跑时机；新增同一轮快速失败重试（隔 120 秒、被强杀不重试）、一整晚尝试上限（6 次）、失败兜底报告与状态账本（`runs\<日期>-<模式>.state.json`）；`night` / `morning` 的时间窗、自杀时刻、尝试次数、重试间隔支持环境变量覆盖（供调试与白天演练）；提示词补"断网停止尝试、条目保持 `[待跑]`"与 `git index.lock` 残锁处置（唯一的删文件例外）。隔离沙箱假 CLI 实测 49 项断言全过（`_night\README.md` 实测记录）。`ws.mjs` 读取报告汇总从"第一行"改成"最后一行"（手动跑与自动跑写同一份报告时以最终结果为准，更新 M05 的读取口径）：两行汇总的隔离验证通过。 |
| 4 | 2026-10-15 | 积压队列与夜间节奏：`ws.mjs` 增 `task add`（攒任务的入口；`--project` 进项目、没有 `NIGHT.md` 时从模板新建；`--review` 记 `[待审]`、agent 专用；标题里的 `\|` 自动换全角）——更新 M05。工作区级 `NIGHT.md` frontmatter 增 `每晚条数`（默认 3，显式写在文件里）；夜间节奏写进 `_night\prompts\night.md`（**一晚最多开工「每晚条数」条、同一项目最多 2 条、单条约 45 分钟不硬啃、`[未完成]` 优先收尾、没轮到的原样顺延、`搁置` 不用于清积压**）——更新 M11；`morning.md` 同步"不因积压改搁置"。契约表增夜间清单 frontmatter 行；验收清单增 `task add` 项。隔离沙箱 31 项断言全过（占位符替换 / 追加顺序 / `--project` / `--review` / 竖线清洗 / 容器拒绝 / `night`+`status` 口径一致）。 |
| 5 | 2026-10-15 | **agent 可换（为内网模型接入 Codex 准备）**：新增 `_night\agents.json`（声明式 agent 定义：候选路径 + 命令模板 `{bin} {node} {prompt} {root} {extra}` + 环境变量）与 `_night\agent.mjs`（解析/拼接/`--list`/`--dry-run`）；`run.mjs` 不再认识任何一家 CLI 的参数（删掉写死的 `resolveZcode` / `builtinProviderConfig`），改问 `agent.mjs` 要命令，并新增 `--agent <名字>` / `--list-agents` / `--dry-run`；日志里多记 `agent:` 与完整 `cmd:` 两行。默认仍是 `zcode`（行为一字未变，干跑输出逐字比对过）；`codex` 条目按 `codex exec …--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox` 实测跑通（真 CLI、假工作区）。参数区、契约表、M12 同步更新。 |
| 6 | 2026-10-15 | **根仓库（框架的版本控制）**：`D:\WorkSpace` 建了一个 git 仓库，但**只跟踪框架**——根规则文件、`ws.mjs`、`_template\`、`_night\`（代码/配置/提示词/`tasks\*.xml`/手写的 `brief\notes-*.md`）、容器与库的说明文件（`WorkFlows\README.md`+`AGENTS.md`、`_archive\README.md`、`Tools\README.md`+`_setup\`）。办法是**白名单 `.gitignore`**（`/*` 先全部忽略，再逐个 `!` 放开）+ `.gitattributes` 的 `* -text`（本机 system 级 `core.autocrlf=true`，不覆盖就会在 checkout/回滚时把 LF 文件整篇改成 CRLF）：项目、工具本体、生成物（`TREE.md`、`_night\runs\` 等）默认被忽略，`git add -A` 碰不到子仓库，杜绝 gitlink——即"根目录不建 git"当年要防的那个坑。相应改动：§1 硬约束表与 §9 反模式清单去掉"根不建 git"，术语与 §3 结构块标明只有**根这一层**是框架仓库，M12 增"框架文件的提交归属"（夜跑/早检归拢根仓库），`night.md`/`morning.md` 补口径，`ws.mjs review` 不再把根 `NIGHT.md` 当"不受版本控制"跳过（改走正常提交），§8.1/§8.2/§8.4 的备份与回滚改以根仓库为主、外部备份为辅，§5/§7 各增一行/一项。**同日补记**：根仓库接上 GitHub 远程（公开 `WorkSpace_frame`，分支 `master`，凭据走本机 GCM）；推送仍是手动动作——`_night` 提示词里的 `git push` 硬禁令不变，夜跑/早检只提交不推。 |
