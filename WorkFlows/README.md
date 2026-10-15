---
kind: 容器
desc: 工作流总文件夹：一个具体工作流一个子文件夹，每个子文件夹都是独立项目
---

# WorkFlows 工作流总文件夹

**这是容器，不是项目**：容器本身不建 git、不记 LOG、不进 TREE 的"项目"统计（它的 `README.md` / `AGENTS.md` 由工作区**根仓库**跟踪）。其下每个具体工作流才是一个独立项目——各自 git、README、LOG，按 `CONVENTIONS.md` 第 2 节的标准结构建。

## 结构

```text
WorkFlows\
├─ README.md          本文件（frontmatter 里的 kind: 容器 让 ws.mjs 认出这是容器）
├─ AGENTS.md          在这下面干活时的规则
└─ <工作流名>\        一个具体工作流 = 一个独立项目
   ├─ README.md       frontmatter：desc / status / next
   ├─ LOG.md
   ├─ AGENTS.md
   └─ .git\
```

## 新增一个工作流

```bash
node D:\WorkSpace\ws.mjs new WorkFlows\<工作流名> --desc "一句话说明"
```

已经装了东西的文件夹（从别处搬来的）用 `adopt` 接入：

```bash
node D:\WorkSpace\ws.mjs adopt WorkFlows\<文件夹> --desc "一句话说明"
```

建完把 `README.md` 的 `desc` / `next` 填实，再跑 `node D:\WorkSpace\ws.mjs tree`。

## 约定

- **一个工作流一个文件夹**，容器下不放别的东西；文件夹名不带空格，允许中文。
- 工作流可以是任意形态：脚本、SOP 文档、自动化管线、ZCode 动态工作流脚本——判据还是工作区那一条：**能不能 `git init` 并且只提交自己写的东西**。
- 索引不手写：`ws.mjs tree` 会把容器下的项目连同 `status` / `next` 一起列进 `TREE.md`；容器下出现不是项目的文件夹，会被列进 TREE 的「需要补齐」。
- 边界：跨工作流共享的**工具**进 `D:\WorkSpace\Tools\`，共享的 **agent 技能**进 `D:\WorkSpace\Skills\`；只有"具体一条流水线"才放这里。
- 容器本身**不要** `git init`：子文件夹各自是仓库，容器建仓会让它们变成 gitlink（容器的说明文件由根仓库跟踪，够用）。

## 相关

- 项目统一规范：`D:\WorkSpace\CONVENTIONS.md`（第 2 节标准项目结构、第 1 节的"容器"小节）
- 工作区规则：`D:\WorkSpace\AGENTS.md`
