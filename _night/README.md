# 夜间自动化（夜跑 + 早检）

无人值守跑夜间任务清单的机制本体。**这是工作区基础设施，不是项目**：不建自己的 git、不进 TREE 统计（`ws.mjs` 里已跳过 `_night`）。机制本体（代码 / 配置 / 提示词 / `tasks\*.xml`）随工作区**根仓库**跟踪；`runs\`、看板与简报的生成件不跟踪（口径见 `CONVENTIONS.md` 第 1 节「根仓库」）。

## 一天的样子

```text
23:00  计划任务 WorkSpace-NightRun（另有 00:30 / 02:00 / 03:30 / 05:00 / 06:30 五个补跑时机，
       └─ node _night\run.mjs night          一晚只跑一次；失败会自动重试，见「机器关机/断网/断电会怎样」）
          └─ 无头 ZCode（zcode.cjs -p … --mode yolo）读 prompts\night.md
             └─ 按清单逐条干活：工作区级 → 各活跃项目；每条做完就 LOG + README + git commit
07:30  agent 自己停止开新任务，归档、写报告、退出
07:50  编排器（run.mjs）自己强杀进程树——兜底 agent 卡住的情况，必须早于 08:00
08:00  计划任务硬超时（PT9H）：连编排器一起杀掉，最后一层
08:30  计划任务 WorkSpace-MorningCheck（另有 09:45 补检时机）
       └─ node _night\run.mjs morning → 无头 ZCode 读 prompts\morning.md
          └─ 核实收口：残锁/残留进程清掉、脏树提交、清单标注
          └─ 预生成前日简报（brief.mjs --build）+ 顺手刷看板；有时间就写 3–5 句人话摘要
08:55  早检结束，工作树干净
09:00  计划任务 WorkSpace-DailyBrief
       └─ node _night\brief.mjs --show → 弹**一个**窗口：「前日总结」+「待审」两个页签
          · 「前日总结」这一页**内嵌夜跑看板的全部内容**（状态条/两级清单/项目一览/夜跑历史/需补齐）——
            早上一个窗口全看完，不用再单独开看板（两边同源：分区渲染都在 `sections.mjs`）
          · 勾选＝同意（写回 NIGHT.md 并提交），没勾保持待审，关窗＝什么都没批
          · **不自动关闭**：窗口留到你调完，自己关掉才算完
          · 任务进程脱手起完就退出（窗口寿命不受任务超时限制）
          · 纯确定性：不依赖模型、不联网、零依赖；乱改窗口也不会误批准任何事
```

看板随时可看：`_night\board\index.html`（`node ws.mjs board --open`，夜跑/早检收尾会自动刷新）。

不依赖 ZCode 桌面端是否开着——用的是 `D:\Zcode\resources\glm\zcode.cjs` 这个无头 CLI（已实测：桌面端同时开着也能跑）。

## 目录

| 路径 | 作用 |
| --- | --- |
| `run.mjs` | 唯一入口：加锁、起无头 agent、到点强杀、写运行日志、收尾刷看板。`night` / `morning` 两个模式 |
| `prompts\night.md` | 夜间 agent 的完整指令（时间预算、执行顺序、收尾、归档） |
| `prompts\morning.md` | 早检 agent 的完整指令（只收口、只预生成简报，不开新工） |
| `prompts\brief-notes.md` | 前日简报「人话摘要」槽的写法（3–5 句）——整条链路唯一需要模型写的东西，弱模型也能接 |
| `board.mjs` + `board\` | 夜跑看板：`board.mjs` 采集渲染 → `board\index.html`（打开这个）+ `data.json`（机器读快照）；`template.html` 是文案模板 |
| `sections.mjs` | 视图片段库：状态条 / 两级清单 / 项目一览 / 推进 / 夜跑历史 / 需补齐——**看板和前日简报用的是同一份**，两处不会漂移 |
| `brief.mjs` + `brief\` | 前日简报：生成 `<日期>.html` / `latest.html`（窗口用它）/ `data-<日期>.json`（事实快照）；`notes-<日期>.md` 是人话摘要槽。`--show` 弹窗**默认不自动关**，`--wait` 等它关掉 |
| `lib.mjs` | 看板与简报共用的取数/转义/模板小库（口径只有一份，才不会两边漂移） |
| `tasks\*.xml` | 三个 Windows 计划任务的定义（`register.mjs` 用它注册）：夜跑 / 早检 / 09:00 简报 |
| `launch-hidden.vbs` + `node-path.txt` | 09:00 简报任务的启动器：用 `wscript` 隐藏起 node（否则会挂一个黑控制台窗口 15 分钟）；node 路径由 `register.mjs` 写进 `node-path.txt` |
| `register.cmd` / `register.mjs` | 注册/重注册计划任务。换机器、重装、node 挪位置都跑它——`.mjs` 负责把 UTF-8 的 XML 转成 schtasks 要的 UTF-16，并注入当前 node / wscript 路径 |
| `runs\` | 运行产物：`<日期>-night.md` 夜跑报告、`<日期>-morning.md` 早检摘要、两份 `.log` 完整输出、`<日期>-<模式>.state.json` 本晚运行状态（尝试次数 / 上次退出码，跨触发时机去重用）、`_scheduler.log` 调度流水（日志与状态账本超 90 天自动清理，报告不删） |
| `.lock` / `.lock-morning` | 运行中的锁（内含 pid）。正常结束会删掉；残留说明上一轮异常退出 |
| `PAUSE` | 你自己建一个空文件就停用夜跑；删掉即恢复 |
| `STOP` | 当前这轮夜跑收尾退出的信号；agent 处理完会自己删掉 |

## 看板展示与验证（2026-10-16）

- **工作台布局**：深青侧栏提供分区与功能入口，主列为连续功能目录、业务项目和当日进展，右列集中审批与队列；移动端顺序单列。功能目录原位展开，具名入口支持键盘；矮窗口侧栏独立滚动。设计配色、排版取舍与验证记录见 `board-plan.md` 的 Frontend Design 小节。
- **用途分组**：Skills、Tools、WorkFlows（含具体工作流）、公共组件属于功能组；项目组只展示具体业务。当前业务项目为 0 时明确显示空状态；功能条目仍可查看状态与下一步，原任务队列不因面板分类而遗漏。分类由 `ws.mjs status --json` 统一提供，详见 `CONVENTIONS.md` 第 1 节。
- **快照**：顶部显示生成时间，分区导航直达审批、队列、项目和历史。页面离线可读，不自动取数；数据变化后运行 `node ws.mjs board` 再刷新页面。
- **队列口径**：「可执行队列」展示工作区及活跃项目的未完成/待跑；工作区先于项目，每一级未完成优先。它展示积压，不承诺当晚全部执行；每晚限额与顺延仍按原有夜跑规则。待审、搁置及非活跃项目不会混入该队列。
- **详情**：任务说明和长下一步使用原生 `details/summary`，支持点击、触屏与键盘 Enter/Space；不增加客户端 JS。不支持该元素的旧简报内核直接显示说明正文。
- **状态**：运行事实、PAUSE 与 STOP 分别显示；失败报告即使没有汇总也保留入口。项目徽标严格对应四种规范状态，其他原始值标为「待规范」，不修改 README 数据。
- **窄屏**：任务卡片单列重排；宽表格单独横向滚动，可键盘聚焦后使用方向键查看，整页不横向溢出。
- **回归命令**：`node --test _night/sections.test.mjs _night/groups.test.mjs`（16 项，含真实 CLI 分类与功能目录锚点/展开命名检查）及原有 board/brief 两个 `--selftest`；真实生成使用 `node ws.mjs board`、`node _night/brief.mjs --build`。
- **视觉验证**：已检查 1440、1280、768、390、320 像素宽度，以及 1024×450 矮窗口；侧栏入口与详情支持键盘操作，主文/辅助文/操作文字对比度分别为 12.54/5.18/6.01。最新桌面与手机截图在 `runs/2026-10-16-ui/design-desktop.png`、`design-mobile.png`。
- **本次检查**：浏览器在 1280、390、320 像素宽度下检查真实快照、说明展开/收起、长下一步及局部滚动；截图在生成物目录 `runs/2026-10-16-ui/`。报告窗口用空审批条目启动自检，返回 `action: ok`、`decisions: {}`；该自检确认启动链路，不代表已逐项验证 WinForms IE 的视觉排版。

## 清单在哪

- **工作区级**：`D:\WorkSpace\NIGHT.md` —— 跨项目、工作区基础设施的事
- **项目级**：`<项目>\NIGHT.md` —— 那个项目自己的事

格式与「谁能写、怎么提升」见 `D:\WorkSpace\AGENTS.md` 的「夜间清单与夜跑」一节。一句话：`[待跑]` 才会被执行，`[待审]` 是等你点头的。

## 积压怎么消化（节奏）

清单是**积压队列**：任务可以一直攒，夜里按节奏慢慢做，做不完自动顺延——不用抢，也不会丢。

- **一晚最多开工「每晚条数」条**（工作区级 `NIGHT.md` 顶部 frontmatter，默认 3）——做完就归档退出，留余量给收尾。
- **同一个项目一晚最多 2 条**，别的项目才排得上：积压均匀消化，不让一个项目把队列堵死。
- **单条别敞开做**：估计要超过约 45 分钟的，做到能收尾的一半就提交、标 `[未完成]` 写清接续点，剩下的留给下一晚；小任务就接着做下一条。
- **顺序**：有接续点的 `[未完成]` 先收尾（有上下文），再按文件顺序做 `[待跑]`（先来的先做）；没轮到的原样留着。
- **`[搁置]` 不拿来清积压**：只有"需要用户拍板 / 依赖外部条件"才搁置；同一条连续两晚推不动 → 跳过并在报告里点名，留给用户定夺。
- 攒任务：`node ws.mjs task add "标题" [--desc "说明或验收标准"] [--project <项目>] [--review]`。

## 手动操作

```bash
node D:\WorkSpace\_night\run.mjs night --force      # 立刻跑一轮夜跑（忽略 PAUSE/STOP/时间窗/去重）
                                                    # 手动跑成功不占当晚名额：23:00 的自动夜跑照常跑（夜里新加的任务不白等）
node D:\WorkSpace\_night\run.mjs morning --force    # 立刻跑一次早检
node D:\WorkSpace\ws.mjs night                      # 看两级清单现状 + 上次夜跑结果 + 锁状态
node D:\WorkSpace\ws.mjs status                     # 全量状态（人读）；--json 是机器读契约，看板/简报吃它
node D:\WorkSpace\ws.mjs board --open               # 生成并打开夜跑看板
node D:\WorkSpace\ws.mjs task add "标题" --desc "说明"   # 攒一条夜活（默认进工作区级；--project 进项目；--review 记成待审）
node D:\WorkSpace\ws.mjs review [--timeout 秒]      # 只审 [待审]（不带简报的纯审核窗口）
node D:\WorkSpace\_night\brief.mjs                  # 生成前日简报（不弹窗）
node D:\WorkSpace\_night\brief.mjs --show --force   # 立刻弹一次「前日总结 + 待审」窗口（默认不自动关）
node D:\WorkSpace\_night\brief.mjs --show --force --wait --selftest   # 自检：窗口 2.5 秒自动关，不动清单
node D:\WorkSpace\_night\brief.mjs --selftest       # 简报渲染自检（假数据，不弹窗）
node D:\WorkSpace\_night\board.mjs --selftest       # 看板渲染自检（假数据）
node D:\WorkSpace\_night\register.mjs               # 重注册计划任务（改过 tasks\*.xml 后跑）
schtasks /query /tn "WorkSpace-DailyBrief" /v /fo LIST
```

要在没有桌面的会话里验证弹窗链路，用 `--selftest`（窗口自动点确定、2.5 秒后关闭，不会改动清单）。

想临时改时间：`register.cmd` 里改不了时间，改 `tasks\*.xml` 里的 `<StartBoundary>`（以及 night 的 `<ExecutionTimeLimit>`，它决定几点硬杀），再跑一次 `register.cmd`。

## 机器关机 / 断网 / 断电会怎样（2026-10-15 加固）

一句话：**最坏结果是"漏一晚"，不会有半死不活的状态**。队列（`NIGHT.md`）在文件里躺着，锁会接管，失败会留痕，早上一定看得见。

| 情况 | 会发生什么 | 靠什么保证 |
| --- | --- | --- |
| 23:00 时机器关着，凌晨某时开机 | 开机后命中的那个补跑时机（00:30–06:30 任一个）自动开跑，用剩下的时间干；一晚仍只跑一次 | 6 个触发时机 + 时间窗 21:00–07:00 + `nightKey()` |
| 整夜关机，早上开机 | 补跑被时间窗挡掉（宁可漏一晚，不在白天擅自开工）；清单原样留到今晚；09:00 简报写明"昨晚没有夜跑记录" | 时间窗 + `brief.mjs` 的"没跑"文案 |
| 跑着跑着断网 / 模型不可用 | 卡住 → 07:50 编排器强杀；秒退 → 同一轮内隔 2 分钟再试一次，本晚后面的触发时机继续补（最多 6 次）。每次失败都留**兜底报告**，早上的简报/看板说清是"失败"而不是"机器没开" | 三道强杀闸 + 快速失败重试 + 尝试上限 + 兜底报告 |
| 断网导致整晚失败 | 清单一条没动（还标 `[待跑]`），下一晚照常；一次失败不再毒死本晚后面所有时机 | 去重看"**自动的那一轮**走没走完归档"（状态账本的 `autoDone`），不看日志 / 报告在不在 |
| 断电（硬拔电） | 重启后：残留锁下次运行自动接管；半途的活由"每条任务一提交"兜底；若 `git` 折在 `index.lock` 上，夜跑/早检允许确认后删这个残锁（提示词里唯一的删文件例外） | 锁接管 + 每任务一提交 + 提示词里的残锁处置 |
| 早检时机器已关 | 08:30 和 09:45 两个时机，开机后命中的那个补做；早检失败同样留兜底报告 | 双触发 + 状态账本按"上次退出码 0"去重 |

**它保证不了的**：机器整夜不在线时它什么也做不了——这是有意的（"关机/注销不跑，宁可漏跑不要乱跑"）。另外，"连续几晚都没跑"只会体现在每天早上简报的那句话里，不会弹窗报警；要确认，看 `node ws.mjs night` 或看板的状态条。

## 调试与调参（环境变量）

一般不用动；改了只影响这一次调用（计划任务调 `run.mjs` 时用的都是默认值）。

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `NIGHT_AGENT` | `agents.json` 的 `default`（现在是 `zcode`） | 这一次用哪个 agent（等同 `--agent`；可取值见 `--list-agents`） |
| `ZCODE_CLI` | `D:\Zcode\resources\glm\zcode.cjs` | 换**zcode** 这条的 CLI 位置（找不到时还会去 `D:\Zcode\resources\` 下扫一层） |
| `CODEX_CLI` | `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` | 换**codex** 这条的 CLI 位置（默认在 bin 下扫一层、取最新的） |
| `NIGHT_WINDOW` / `MORNING_WINDOW` | `21-7` / `6-10` | 临时改运行时间窗（格式 `起-止`） |
| `NIGHT_SELF_KILL` | `07:50` | 编排器自杀时刻（`HH:MM`），必须早于计划任务硬超时 |
| `NIGHT_MAX_ATTEMPTS` | `6` | 一整晚最多起几次 agent（= 触发时机数） |
| `NIGHT_RETRY_DELAY_SEC` | `120` | 同一轮内"快速失败"后隔多少秒重试 |

**故障演练（白天可做，不碰真实产物）**：把 `_night\run.mjs`（连带 `agent.mjs` 与 `agents.json`）复制到一个临时目录（脚本按自身位置定工作区根），在 `agents.json` 里加一个指向假脚本的 agent（`"bin": ["{root}\\_night\\stub.mjs"]`），配 `NIGHT_WINDOW=0-24`、`NIGHT_RETRY_DELAY_SEC=1`、`NIGHT_SELF_KILL=<一分钟后>`，就能把"秒退失败 / 卡死 / 成功"、重试、强杀、兜底报告、去重全跑一遍。2026-10-15 的加固与换 agent 适配都是这么验的（旧的 `ZCODE_CLI=<假脚本>` 写法仍然可用）。

## 换 agent / 换模型（含内网模型接 Codex）

夜里起哪个 CLI，是**配置**不是代码：全在 `_night\agents.json` 里，`run.mjs` 只问 `_night\agent.mjs` 要一条命令。

```bash
node _night\run.mjs --list-agents            # 有哪些 agent、各自的 CLI 找没找到
node _night\run.mjs --dry-run --agent codex  # 只打印将执行的命令，不真跑
node _night\run.mjs night --agent codex      # 这一次换成 codex
# 环境变量 NIGHT_AGENT=codex 等效；改 agents.json 的 "default" 就是换默认（计划任务也跟）
```

`agents.json` 里一条长这样（`bin` 支持 `%环境变量%` 与 `*` 通配，取最新改动的那个；`argv` 里的占位符 `{bin}` `{node}` `{prompt}` `{root}` `{extra}`）：

```json
"codex": {
  "bin": ["%CODEX_CLI%", "%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\*\\codex.exe"],
  "argv": ["{bin}", "exec", "{extra}", "{prompt}", "--cd", "{root}",
           "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--color", "never"],
  "extra": []
}
```

**内网模型接在 Codex 上**（推荐做法）：

1. 写一份 Codex 的 profile 文件 `%USERPROFILE%\.codex\<名字>.config.toml`，里面放你的内网 provider 与模型，例如：
   ```toml
   model_provider = "intranet"
   model = "<内网模型名>"
   model_reasoning_effort = "medium"
   [model_providers.intranet]
   name = "intranet"
   base_url = "http://<内网地址>/v1"
   wire_api = "chat"          # 按你的网关支持的类型填 chat / responses
   requires_openai_auth = false
   experimental_bearer_token = "<内网 token>"
   ```
2. `agents.json` 的 `codex` 那条把 `"extra"` 改成 `["--profile", "<名字>"]`（`codex exec -p/--profile` 会把 `$CODEX_HOME/<名字>.config.toml` 叠在用户配置上）。

不想拆文件也可以把覆盖项直接塞进 `extra`：`["-c", "model_provider=intranet", "-m", "<内网模型名>"]`。

**费用/速度旋钮**（都在 `extra` 里）：`-c model_reasoning_effort=low` 降推理档、`--ephemeral` 不落会话文件。注意 Codex 的固定开销比 ZCode 的 CLI 大：2026-10-15 实测一句"只回复 OK"就用了约 **38k token**（系统提示 + 工具表 + high 档推理），内网模型便宜就无所谓，吃 quota 的模型建议先把推理档调下来。

**安全口径不变**：`--dangerously-bypass-approvals-and-sandbox` 等价于 ZCode 的 `--mode yolo`——无人值守下没有别的选择，安全仍靠三样：提示词里的硬禁令、每条任务一提交（可回滚）、早检复核。名里带"dangerously"是提醒：这条只给"外层已经有隔离/你已经接受风险"的机器用。

## 为什么这么设计（取舍记录）

- **用系统计划任务，不用 ZCode 自带的定时**：自带的只在桌面端开着时才会触发；夜里人关了窗口就没了。计划任务只要机器开着、用户处于登录/锁屏状态就会跑（注销或关机则不跑——这是有意的，宁可漏跑不要乱跑）。
- **三道停止闸，且顺序有讲究**：agent 自己在 07:30 停机归档（软）；07:50 编排器自己强杀进程树（防 agent 卡住）；08:00 计划任务硬超时连编排器一起杀（最后兜底）。**编排器的自杀时刻必须早于计划任务的硬超时**——反过来的话计划任务会先把编排器杀掉，无头 agent 就成了没人管的孤儿，一路跑进白天。08:30 早检再收一次口。四道都为了同一个目标：**早上 9 点前树是干净的**。
- **`StartWhenAvailable` 靠不住，所以挂了多个触发时机**：机器 23:00 没开机时，它实测**没有**把错过的触发补起来（2026-10-15：机器 09:08 才开机，任务"上次运行时间"仍是从未运行）。所以夜跑挂了 6 个时机（23:00、00:30、02:00、03:30、05:00、06:30），早检挂了 2 个（08:30、09:45）。时间窗（夜跑 21:00–07:00、早检 06:00–10:00）负责把"补跑"挡在夜里——宁可漏一晚，也不在白天擅自开工。
- **一晚只跑一次靠 `nightKey()` 去重**：07:00 之前算前一晚，于是 23:00 开工与凌晨补跑落到同一份 `runs\<本晚标记>-night.log`，一起认出"这一晚已经跑过了"。去重键和日志文件名必须是同一个值，否则补跑时机之间互相看不见。
- **去重看"自动的那一轮跑完没"，不看"跑过没"**：一晚是否算跑过，判据是状态账本 `runs\<日期>-night.state.json` 里的 `autoDone`（只有**自动**的一轮走完归档、报告里落了 `NIGHT-SUMMARY` 才置真），尝试上限也只数 `autoAttempts`（自动尝试）。早先按"日志文件在不在"去重，一次快速失败（断网秒退）会把本晚后面所有补跑时机全毒死；现在失败会被后面的时机自动重试，到上限（默认 6 次 = 触发时机数）才停手。**手动 `--force` 不占名额**——不写 `autoDone`、不进 `autoAttempts`：白天测试跑几轮，既不顶掉当晚的自动夜跑，也不吃当晚的重试额度；`--force` 本身不受去重与上限约束。
- **失败也要留痕**：agent 半途死掉时，编排器替它写一份「编排器兜底报告」，开头写明"这不是 agent 写的"。早上的简报/看板靠它把"夜跑失败了（断网 / CLI 起不来 / 被强杀）"和"机器没开"区分开，而不是拿一句含糊的"没有夜跑记录"糊过去——视图层本来就按"有没有汇总行"判跑没跑完，兜底报告遵循同一约定（刻意不写汇总行）。
- **登录触发器加不了**：`LogonTrigger` 注册时被"拒绝访问"（要管理员），而本机制坚持免提权，早检的补检改用 09:45 的定时触发。
- **无头 CLI 要靠 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`**（只有 `zcode` 这条需要）：这是整个夜跑最隐蔽的坑——见下面实测记录第 2 条，`agent.mjs` 自己按目录推导它，不写死版本号。
- **换 agent 是配置，不是代码**：`agents.json` 里声明"候选路径 + 命令模板 + 环境变量"，`agent.mjs` 负责找 CLI、拼参数；`run.mjs` 不认识任何一家 CLI 的参数。这样接一个新模型/新 CLI 是加一段 JSON，不是改编排器——也是给"将来换成内网模型"留的门。`--dry-run` 让这件事在白天就能看清，不必等夜里踩。
- **`--mode yolo`**：无头环境没有人点确认，`guarded` 会卡住。安全靠三样：提示词里的硬禁令、每条任务一提交（可回滚）、早检复核。Codex 那条对应 `--dangerously-bypass-approvals-and-sandbox`，同一个取舍。
- **看板与简报共用一份数据源**：两者都只读 `node ws.mjs status --json`（`_night\lib.mjs` 是唯一的取数处），不各自去解析 NIGHT.md / README.md。解析口径只有一处，加新视图就是加个模板，不会出现"看板和简报对不上"。
- **弹窗只弹一个，且固定在 09:00**：早检（08:30）只负责**提前生成**简报（`--build`）和写人话摘要；09:00 的计划任务把「前日总结 + [待审]」合成一个窗口弹出。两个窗口会打扰人，08:30 弹还赶在用户坐下之前。想单独审清单随时 `node ws.mjs review`。
- **弹窗段完全不依赖模型**：09:00 跑的是 `brief.mjs --show` → `ws.mjs review` → `审批窗口\approve.ps1`，全是确定性脚本，不联网、不调大模型。这是奔着「将来接内网慢/弱模型」去的：模型只做可选的 3–5 句人话摘要（`prompts\brief-notes.md`），不做数据、不做渲染、不做决定；模型没有或很慢，链路照样跑完。
- **09:00 任务用 `launch-hidden.vbs` 起 node**：计划任务直接跑 node.exe 会挂一个黑控制台窗口，而简报窗口要等最多 15 分钟——那就是个碍眼的黑框。`wscript` 的 `Run(cmd, 0, ...)` 只把控制台隐藏，不影响 GUI 窗口。
- **不预设"用户会批准"**：关窗、关掉倒计时前的窗口、IE 面板加载失败，一律等于什么都没批；勾选才算点头。这个不变量在窗口引擎（`审批窗口\`）里，不在调用方。
- **窗口不自动关闭**（用户明确要求）：倒计时会"到点替你放弃"，看着像催命；现在窗口留到他看完自己关，关掉＝什么都没批。计划任务因此**脱手起**窗口（`launch-hidden.vbs` 里 node 立刻退出），否则任务超时会把窗口一起杀掉、等于变相倒计时。要看窗口前的细节随时 `node ws.mjs review`，想倒计时就 `--timeout 秒`。
- **`InteractiveToken` + 最低权限**：不需要管理员、不需要存密码。代价是「注销」状态下不跑。
- **不动不相关项目的 git**：日间遗留只在「本次要动的项目」里提交归拢；没排夜活的项目一概不碰它的工作树——白天或别的 agent 可能正在里面干活。宁可少归拢，也不要和别人正在编辑的树打架。工作区框架是**根仓库**，单独归拢它的未提交改动（`日间遗留：工作区框架` / 早检的 `夜跑收尾：工作区框架`），同样只碰它自己的。
- **`InteractiveToken` + 最低权限**：不需要管理员、不需要存密码。代价是「注销」状态下不跑。

## 实测记录

- **2026-10-14 18:23 首次端到端自检（通过）**：`run.mjs night --force` 全链路走通——读 `prompts\night.md` → 读两级清单 → 干活 → LOG/README/commit 收尾 → 改写清单状态 → 写带 `NIGHT-SUMMARY` 的报告 → 刷 `ws.mjs tree` → 退出码 0、锁正常释放，用时 3 分钟。`[待审]` 条目确实没被碰。紧接着跑了 `morning --force` 验证收口那一半。
- **2026-10-15 09:42 计划任务环境下失败（已修）**：手动 `schtasks /run` 触发的早检秒退，日志里是 `无法定位 CLI ZCode Built-in Provider Config：D:\Zcode\resources\glm\provider\zcode-builtin.json, D:\config\provider\zcode-builtin.json`。原因：无头 CLI 靠 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 定位内置 provider 配置，而这个变量**只有 ZCode 桌面端给它子进程才会设**——计划任务的环境里没有。用最小环境做对照实验确认：只补这一个变量即可跑通（`status=0`，正常回复）。`run.mjs` 现在按 `~\.zcode\v2\runtime\provider\<平台>\<版本>\endpoint-*\zcode-builtin.json` 取目录名排序最后一个，不写死版本号与 endpoint 哈希。
- **2026-10-15 09:44 修好后在计划任务环境复测（通过）**：同一个任务环境里 `run.mjs night --force` 完整跑通，agent 正常读清单、判定无待跑、写报告、刷 TREE，退出码 0，用时 4 分钟。
- **2026-10-15 跨夜实况**：机器整夜关机（09:08 才开机），23:00 与 08:30 两次触发**都没发生**，`StartWhenAvailable` 也没补——促成了上面的多触发时机改造。**结论：这套机制要求机器在夜里是开着的**；关机/注销的时段它什么也做不了。
- **2026-10-15 看板 + 前日简报 + 09:00 弹窗全链路**：
  - `ws.mjs status --json`（新的机器读契约 `workspace-status/1`）→ `board.mjs` 出 `board\index.html`、`brief.mjs` 出 `brief\<日期>.html` + `latest.html` + `data-<日期>.json`：都跑通，`--selftest` 用假数据验证模板无残留占位符。
  - 窗口链路实测：`ws.mjs review --report <简报.html> --title … --selftest` 打开「前日总结 / 待审」双页签窗口，2.5 秒自动点确定、清单未被改动（勾选为空 = 全部保持待审）。
  - **踩到一个隐蔽的坑**：`approve.mjs` 用 `spawnSync(..., { windowsHide: true })` 起 PowerShell，Node 会给子进程带 `STARTUPINFO` 的 `SW_HIDE`，Windows 把该进程**第一个窗口**吞掉——窗口进程、消息循环、倒计时全都正常，但 `IsWindowVisible=false`，屏幕上什么都没有（用 EnumWindows 逐窗口 dump 才看出来）。已在 `approve.ps1` 里用 `Shown` + 兜底定时器显式 `ShowWindow(SW_SHOW)` 修掉，并截图确认窗口与页签内容渲染正常。**排查手段留档**：`_night\brief\_enum.ps1` 式的窗口枚举（按 pid/标题/可见性/坐标 dump）比截屏可靠。
  - 09:00 任务的启动链（`wscript launch-hidden.vbs` → node → 简报窗口）实测：窗口可见、无额外控制台窗口。
  - 已知限制：窗口用的是 IE 内核（WebBrowser 控件），简报模板（`brief\template.html`）只用了最保守的 CSS（无 flex/grid/变量）；看板页面用默认浏览器打开，`board\template.html` 可以用现代 CSS。简报要更花哨的排版得换渲染方式，代价是失去"离线 + 零依赖"。
- 同日验证过的前提：无头 `zcode.cjs -p`（桌面端同时开着也能跑）、`schtasks` 免提权注册、中文提示词经 `spawn` 传参不乱码。- 已知限制：无头 agent 的 stdout 是管道块缓冲，`.log` 要等进程结束才写满，**实时进度看 `runs\<日期>-night.md`**（agent 自己增量写的那份）。
- **2026-10-15 断网 / 关机 / 断电加固（隔离沙箱实测通过）**：把 `run.mjs` 复制到临时目录、用假 CLI 扮演失败（不碰真实 `runs\`），主路径 41 项断言全过——不在窗口拒绝开工；秒退失败 → 同轮重试 → 兜底报告 + 状态账本 + 锁释放；下一个时机自动"继续第 3 次"直到成功；成功后不再重复；尝试上限停手并留痕；旧日志不作数、照常跑；手动 `--force` 成功不顶掉当晚自动夜跑；早检失败 → 兜底 → 补检时机 → 成功后去重。另测"agent 卡死 → 自定强杀时刻到点杀进程树"8 项全过（61 秒被杀、兜底报告落盘、锁释放、慢失败不重试），合计 49 项。这轮实测当场抓出三个漏洞并修掉：时间窗环境变量没接到调用点、被强杀被误判成"快速失败"去重试、**手动 `--force` 跑成功会顶掉当晚的自动夜跑**（现在手动跑不写 `autoDone`、不进 `autoAttempts`，不占名额也不吃重试额度）。配套：`ws.mjs` 读报告汇总改成取**最后一行**（手动跑和当晚自动跑写同一份报告时，看板/简报以最终结果为准），用"两行汇总"的报告在隔离副本里验证通过。
- **2026-10-15 换 agent 适配（codex 接内网模型，实测通过）**：
  - 新增 `agents.json` + `agent.mjs`；`run.mjs` 里写死的 ZCode 解析（`resolveZcode` / `builtinProviderConfig` / `ZCODE_CANDIDATES`）全部移走。**默认行为一字未变**：`--dry-run --agent zcode` 的输出与改造前的 `spawn` 参数逐字比对一致（`node.exe zcode.cjs -p <prompt> --cwd <root> --mode yolo`）。
  - 干跑（`--list-agents` / `--dry-run`）：`zcode` 找到 `D:\Zcode\resources\glm\zcode.cjs`；`codex` 自动找到 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`（两次安装留了两个 hash 目录，取 mtime 最新的那个，不写死 hash），`extra:["--profile","intranet"]` 正确插进 `exec` 与 prompt 之间。
  - **假 CLI 演练**（临时目录里复制 run.mjs/agent.mjs/agents.json，桩件扮演外部 CLI）：桩件如实收到了 `{root}` 展开的路径、`{extra}` 的两个参数、自定义环境变量 `NIGHT_DRILL=1`、以及真实提示词文本；`runs\<日期>-night.log` 里留下 `agent:` 与完整 `cmd:` 两行；桩件写出的带 `NIGHT-SUMMARY` 的报告被认成"这一轮归档退出"，退出码 0、锁释放。
  - **真 codex 无头冒烟**（临时目录、无副作用提示）：`codex exec …` 报 `approval: never` / `sandbox: danger-full-access` / `provider: custom`，正常回复并退出 0。顺带量到 Codex 的固定开销：一句话回复 ≈ **3.8 万 token**（系统提示 + 工具表 + `model_reasoning_effort=high`），夜里跑内网模型前建议在 `extra` 里把推理档调低。
  - 事实记录：本机 codex CLI 版本 `v0.162.0-alpha.17.2`；用户配置 `~\.codex\config.toml` 当前指向自定义 provider（`packycode` 网关、`gpt-5.6-sol`）。**默认 agent 仍是 zcode**，要切改 `agents.json` 的 `default` 或给 `run.mjs` 加 `--agent codex`。
