# WorkFlows 下的工作规则

工作区总规则见 `D:\WorkSpace\AGENTS.md`，项目统一规范见 `D:\WorkSpace\CONVENTIONS.md`。本文件只写这个容器里特有的。

## 核心一条

**容器本身不是项目**：不要在这里 `git init`、不要在这里记 LOG、不要手写索引。所有事情都发生在某个具体工作流文件夹里——那里才是项目，任务是那里的任务。

## 建新工作流

```bash
node D:\WorkSpace\ws.mjs new WorkFlows\<工作流名> --desc "一句话"
node D:\WorkSpace\ws.mjs adopt WorkFlows\<已有内容的文件夹> --desc "一句话"
```

`adopt` 缺什么补什么，不碰已有文件内容、不碰已有 `.gitignore` 规则、不碰已有 git 历史。

## 在工作流项目里干活时的收尾

和标准项目一样，只是路径在 `WorkFlows\<工作流>\` 下：

1. 往该工作流 `LOG.md` 追加当日条目（意图、取舍、为什么）。
2. 更新该工作流 `README.md` frontmatter 的 `status` 和 `next`。
3. 在该工作流目录里 `git add -A && git commit`。
4. `node D:\WorkSpace\ws.mjs tree` 刷新项目树，让容器下的状态可见。

## 不要做的事

- 不要在容器层放跨工作流共享的代码 / 工具 / 技能（该进 `Tools\` 或 `Skills\`）。
- 不要把工作流的 `.git` 删掉当普通文件夹放——没有仓库的文件夹会被 TREE 的「需要补齐」点名。
- 不要把工作流的产物（`runs/` `outputs/` 样本数据）提交进它自己的 git；模板 `.gitignore` 已有基线，按项目实际增删。
