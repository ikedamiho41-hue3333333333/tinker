# Tinker Skills

这里是 Tinker 协作知识的**源文件**，按场景加载，支持 Claude Code 和 Codex。

以前 Tinker 靠一整块 CLAUDE.md（700 行）教 AI，每次 session 全量塞进 context。现在拆成按场景触发的技能：AI 只在相关场景（记进展 / 搜方法 / 接力 / 处理 reminder）才加载对应技能，省 context 也更聚焦。灵感来自飞书 CLI 的 `skills/` 目录。

## 技能清单

| 技能 | 什么时候加载 |
|---|---|
| `tinker` | 总纲 · 场景反查表 + 调用协议 + 概念词，指向下面各技能 |
| `tinker-record` | 记一笔 / 起草 / 完工 / 卡住，以及怎么不被 voice 守门拦 |
| `tinker-voice` | 帮用户写任何要发出去的中文文字时的文风约束 |
| `tinker-borrow` | 搜方法库 / 沉淀方法 / 求方法 |
| `tinker-collab` | 工作室接力 / 决策征求 / 邀请入室 |
| `tinker-todo` | 记待办 / 勾完成 / 派活 / 个人待办同步成团队任务（私密协作层，跟公开进展分开）|
| `tinker-triggers` | 理解和处理触发器 reminder（hook / pending / maybe-check）|
| `feishu-project-runner` | 从飞书项目群按本人分工推进任务，实际检查后报告；可独立使用，无需 Tinker 登录 |

## 装进 AI

```bash
tinker skills install            # 全局 · ~/.claude/skills · 本机所有项目生效
tinker skills install --local    # 只装当前 repo · .claude/skills
tinker skills install --agent codex # Codex 全局 · ~/.agents/skills
tinker skills install --agent codex --only feishu-project-runner # 只选装飞书 skill
tinker skills install --agent codex --only feishu-project-runner --local # 当前项目 .agents/skills
tinker skills list               # 看有哪些技能
```

## 改这里

每个技能是 `<name>/SKILL.md`，YAML 的 `name` + `description` 决定何时加载。安装复制完整技能目录（references、scripts、assets 和 agents），保留脚本执行权限。更新同名技能时先将旧目录移到 skills/.tinker-backups/，输出备份位置，再安装新包；需要恢复时可将旧目录移回。安装不需要 Tinker 登录，不创建飞书配置或启动调度。

`--agent` 默认 `claude`，`codex` 使用官方支持的 [.agents/skills 目录](https://developers.openai.com/codex/skills)。若已在旧路径 ~/.codex/skills 安装同名技能，先比较版本，选择一个安装位置，避免重复发现。

飞书团队首次接入、手动执行、可选 macOS 调度与验证步骤见 [独立运行与团队安装](feishu-project-runner/references/automation.md)。该版本不接入 Tinker 网页任务状态，不将飞书任务自动标为 Tinker 完成。
