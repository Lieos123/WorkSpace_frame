# D:\WorkSpace\Tools — 本地工具库（AI coding agent 工具）

**规则：工具本体集中放这里，一份共享；每个项目的索引/图谱数据留在各自项目里（不进本目录）。**

## 文档约定（本库说明只在这里维护）

- 本工具库的说明——版本、升级、卸载、每项目接入步骤——**只在本 README 维护**，不写进任何 `AGENTS.md` / `CLAUDE.md` / `AGENT.md` 等 agent 说明文件。
- agent 侧只保留必要接线（MCP 条目、PATH、工具白名单）和一行指向本文件的指路；安装器若往 agent 说明文件写入"说明块"（如 CodeGraph 的 `<!-- CODEGRAPH_START -->` 托管块），一律以本文件为准，写回即删。
- 工具功能不依赖那些说明块：MCP 服务自身的 instructions 和工具列表已足够让 agent 知道怎么用；`codegraph install --yes` 可随时把托管块写回，`codegraph uninstall` 可一键撤销全部接线。

## 迁移记录

- **2026-10-14：`D:\Tools` → `D:\WorkSpace\Tools`**（并入工作区，规则见 `D:\WorkSpace\AGENTS.md`）。已同步的引用点：本 README 全文、`_setup` 两个脚本、`~\.zcode\cli\config.json`（MCP 绝对路径）、用户 PATH 里的 `...\codegraph\current\bin`、三个 agent 说明文件里的一行指路、`D:\WorkSpace\AGENTS.md`、`ws.mjs`、ZCode 记忆。
- 迁移时工具本体无进程占用；旧目录内容已清空，只剩空壳，需关闭 ZCode 后删除（ZCode 把工作区目录当自己的工作目录占着，根目录改名/删除会被 Windows 拒绝）。
- 2026-10-14 复查补漏：`_template\README.md` 与 `Tools\understand-anything\README.md` 各有一处旧路径 `D:\Tools`，已改为 `D:\WorkSpace\Tools\...`（前者会随模板复制进每个新项目，影响面最大）。

目录结构：

```
D:\WorkSpace\Tools\
├─ _setup\                 安装/升级脚本（可重复执行）
├─ codegraph\              CodeGraph v1.6.2
├─ aoci\                   AOCI-CODE 0.1.0-rc20
│   └─ _versions\          版本包存档（zip + SHA256SUMS）
└─ understand-anything\    预留（UA 未装到这里，见下）
```

---

## CodeGraph v1.6.2（按需检索层）

- 启动器：`D:\WorkSpace\Tools\codegraph\current\bin\codegraph.cmd`（已加入用户 PATH，新终端生效）
- **升级**：改 `_setup\codegraph-install.ps1` 里的 `CODEGRAPH_VERSION` 后重跑；日常也可直接 `codegraph upgrade`
- **卸载**：`codegraph uninstall`（会先列出它改过的所有配置给你确认）；项目索引用 `codegraph uninit` 移除
- **遥测**（可选关闭）：`codegraph telemetry off`，或设环境变量 `CODEGRAPH_TELEMETRY=0`
- 2026-10-14 接线（MCP 条目 + 工具白名单；**说明文字不留在 agent 说明文件里**，只留一行指路）：
  - Claude Code：`~\.claude.json`（MCP 条目）、`~\.claude\settings.json`（工具自动放行）、`~\.claude\CLAUDE.md`（一行指路）
  - Codex CLI：`~\.codex\config.toml`（MCP 条目）、`~\.codex\AGENTS.md`（一行指路；原先由安装器写入的说明块已移除）
  - opencode：`~\.config\opencode\opencode.jsonc`（MCP 条目）、`~\.config\opencode\AGENTS.md`（一行指路）
  - VS Code Copilot Chat：`%APPDATA%\Code\User\mcp.json`；Copilot CLI：`~\.copilot\mcp-config.json`（只改 MCP，无说明文件）
- ZCode：已写入 `~\.zcode\cli\config.json` → `mcp.servers.codegraph`（绝对路径指向 D 盘启动器）。重启 ZCode 后到 **设置 → MCP** 确认状态

## AOCI-CODE 0.1.0-rc20（持久认知层）

- 主程序：`D:\WorkSpace\Tools\aoci\aoci.exe` —— 官方要求的 **stable absolute path**，被项目引用后请勿移动/改名（2026-10-14 从 `D:\Tools` 迁入，引用点已同步，见上面「迁移记录」）
- 版本存档：`_versions\aoci_0.1.0-rc20_windows_amd64.zip`（SHA256 已校验，`SHA256SUMS` 同目录）
- **升级**：改 `_setup\aoci-fetch.ps1` 里的 `$Tag`（如 `v0.1.0-rc21`）后重跑 —— 自动下载、校验哈希、替换 exe、打印新版本号
- **离线**：本体不联网（只读声明的数据库 schema）；未配置 AI endpoint 时是纯离线工具，配置后才批量生成索引内容。索引文本由你 agent 的模型写入
- 索引文件（进项目 Git，勿 gitignore）：`aoci.txt`、`aoci.meta.txt`、`aoci.code.txt`、`AGENTS.md`

---

## 每个项目的接入步骤

### CodeGraph（每项目一次）

```powershell
cd <项目目录>
codegraph init        # 建项目内 .codegraph\ 索引；之后自动同步，无需手动维护
```

### AOCI-CODE（每项目一次）

```powershell
& 'D:\WorkSpace\Tools\aoci\aoci.exe' --repo . init --agent claude --hooks --locale zh-CN
& 'D:\WorkSpace\Tools\aoci\aoci.exe' --repo . scan
```

- `--agent` 可选值：`claude` / `codex` / `cursor` / `opencode` / `qoder` / `all`
- `--locale zh-CN` 让索引内容用中文（默认 en-US）
- 之后让 agent 按 `aoci index agent guide` 的引导批量建索引（约 1 小时 / 20 万行）
- ZCode 接入（可选；写入项目内 `<repo>\.zcode\config.json`，注意 `<项目绝对路径>` 要替换）：

```json
{
  "mcp": {
    "servers": {
      "aoci": {
        "type": "stdio",
        "command": "D:\\WorkSpace\\Tools\\aoci\\aoci.exe",
        "args": ["--repo", "<项目绝对路径>", "mcp"]
      }
    }
  }
}
```

### Understand Anything（暂未安装）

- Claude Code（官方推荐路径，不建议搬）：`/plugin marketplace add Egonex-AI/Understand-Anything`
- 其他平台想把 clone 放 D 盘：设 `$env:UA_DIR='D:\WorkSpace\Tools\understand-anything\repo'` 后运行其 install.ps1
- 项目数据：`.ua\` 目录；建议提交 Git 共享（`intermediate/` 和 `diff-overlay.json` 除外）

---

## 共同注意

- 所有 agent 配置里用**绝对路径**引用本目录；不依赖 PATH（PATH 只方便终端手敲）
- 索引/图谱永远留在项目里：`.codegraph\`、`aoci*.txt`、`.ua\` —— 不要放到本目录
- 本目录是本地 NTFS 盘；网络盘/移动盘会有 SQLite WAL 退化等坑
- 三个工具本体都不依赖云端；整体是否全离线取决于你 agent 的模型（接本地模型即可全离线）
