# 独立运行与团队安装

此 skill 通过官方 lark-cli 读取飞书，在成员自己的 Codex 项目窗口执行任务。无需登录 Tinker 网页；不依赖 Tinker 邮件、API、数据库或任务板。当前集成提供完整包和安装入口，不做 Tinker 任务双向同步。

成员首次使用可先看[团队操作说明与可复制指令](team-guide.md)，本页用于本机调度部署和运行证据核验。

## 1. 安装

准备 Node.js >=18、Git、可用的 Codex 和已授权的官方 lark-cli。在 Tinker 仓库根目录运行：

```sh
node cli/bin/tinker.js skills install --agent codex --only feishu-project-runner
```

安装到 `~/.agents/skills/feishu-project-runner/`。已安装 Tinker CLI 时可用等价的 `tinker skills install --agent codex --only feishu-project-runner`。仅用于当前项目时，在该项目目录执行命令并添加 `--local`，安装到 `.agents/skills/`。

安装保留旧版本备份并输出路径，不创建定时任务。若旧路径 `~/.codex/skills` 已有同名 skill，先比较和备份，选择一个位置，避免重复发现。Codex 未显示新技能时重新打开项目窗口；通过 `/skills` 核对入口及路径。

## 2. 个人接入与手动验证

每人使用自己的飞书授权、项目目录和 Codex 会话，不复制同事账号、令牌或会话ID。先读 [接入字段](onboarding.md)，从包内 `assets/examples/project-config.example.json` 创建项目目录的 `.feishu-project-runner/config.json`，逐项填写真实核验的信息。占位模板默认关闭调度和成果报告授权，不能原样运行。

在实际项目窗口输入：

```text
使用 $feishu-project-runner 为我接入飞书项目推进。
核对本人账号、项目群、分工、报告机器人和授权，建立独立个人配置。
先仅核对群任务和生成本地台账，不执行任务，不发送消息。
```

确认身份、群、分工和范围后，在同一窗口执行一轮：

```text
使用 $feishu-project-runner，按本项目配置推进本人已授权任务。
实际检查并保存证据；只有已检查的实质成果才按已有发送授权报告。
不发配置或巡检消息，保留必要确认与发送门禁。
```

检查真实群历史完整读取、任务归属、实际执行与证据保存。报告用本人配置的机器人，刚子侧为饺子；@本人及需要接手或确认的负责人。无实质成果不为了测试而发群消息。

## 3. 可选后台运行（macOS + Codex）

包含的 `scripts/scheduler.py` 使用 Unix 文件锁，以下接入步骤仅用于 macOS launchd，以及支持 `codex queue --thread … --message …` 的 Codex CLI。先查本机 `codex queue --help`；没有该命令时只能手动使用 skill，需选择宿主支持的调度方式，不宣称后台已运行。Claude Code 可加载技能规则，但此轮询脚本不会唤醒 Claude 会话。

此脚本当前提示围绕神来－圆周率，全天24小时、每600秒运行；其他项目或指定时间窗口需适配并验证，不能直接沿用。脚本使用当前 CLI 默认用户 profile；多账号用户须确认当前 profile 就是本人，身份核验失败会停止业务派发。

让本人 Codex 按以下步骤部署，已有本人调度时先核对并复用，避免重复安装：

1. 创建本人后台目录，例如 `~/.local/share/feishu-project-runner/`，权限700；将包内 `scripts/scheduler.py` 复制到此处。后台目录避免受系统隐私保护的桌面/文稿目录。
2. 从 `assets/examples/poller-config.example.json` 和 `scheduler-settings.example.json` 生成权限600的个人配置。poller-config 填核验过的 owner_open_id、chat_id、workspace（后台目录）；初始 schedule.enabled=false。
3. settings 填个人 project_config 路径、既有 thread_id、真实 session_log、lark/codex 可执行文件路径、project_workspace（实际项目目录）和 worker_state（后台摘要路径）。不能猜测会话ID。
4. 项目 config.schedule 绑定后台 scheduler-status.json、worker-state.json、poller-config.json 的真实路径，分别填 status_path、worker_state_path、control_path。
5. 用个人配置手动运行 `python3 /实际后台目录/scheduler.py --settings /实际后台目录/scheduler-settings.json --origin manual`，先验证禁用状态不派发。本人明确授权自动推进后才将个人 poller-config 的 schedule.enabled 改为 true，再验证身份、完整读群及目标窗口接收。
6. 创建本人唯一的 `~/Library/LaunchAgents/<本人唯一label>.plist`。ProgramArguments 依次为本机 Python 的绝对路径、后台 scheduler.py、`--settings`、个人 settings 路径、`--origin`、`launchd`；设置 StartInterval=600、RunAtLoad=true，StandardOutPath/StandardErrorPath 指向后台目录。用 `plutil -lint` 检查，再用 `launchctl bootstrap gui/<本人uid> <plist绝对路径>` 加载。保留现有沙箱与审批策略，不加入绕过参数。

后台轮询只负责完整读群和向既有项目会话入队，不执行任务或发送飞书消息。任务执行、检查、报告由该会话按 skill 完成。

## 4. 证明已经运行

同时核对：launchctl 系统记录加载；scheduler-status 的真实 trigger_origin=launchd 触发和 read_complete；身份正确；目标会话实际收到 marker；本轮真实任务执行、检查及台账记录。入队回执仅证明请求被接收，不能代替执行或验收。无本人可执行任务时如实记录空轮，不虚构成果。

检查下一次系统触发时间，确认600秒周期；忙碌时变化保留、无重复入队；任务被中断后暂停派发。保持本机开机登录、联网及授权/目标会话可用，休眠期间不运行。每10分钟是检查节奏，不是任务完成时限。

## 5. 停止、恢复与故障

将本人 poller-config 中 schedule.enabled 改为 false，停止后续业务派发；原项目窗口同时明确暂停正在执行的任务。彻底停掉轮询时用 `launchctl bootout gui/<本人uid> <plist绝对路径>` 卸载本人的记录。自动轮次中断后保留待办、暂停派发，只有本人明确恢复后才重新启用。

身份/权限、网络、CLI 或会话失败时看本机 scheduler-status 的 last_error 和 needs_input；只通知本人执行窗口，不发送巡检群消息。遇发送或系统审批门禁保留原有确认，不静默追加跳过参数。

## 维护验证

在仓库根目录运行：

```sh
cd cli
npm test
python3 -m unittest discover -s test/feishu_project_runner -v
```

Node 测试验证真实 CLI 安装和完整资源可用；22项 Python 测试执行真实调度器、状态与文件锁，模拟外部飞书和 Codex CLI，不触达真实群或会话。测试通过不证明某位新成员的真实任务、发送或人工验收完成。

锁占用时scheduler-status.json显示waiting_for_lock，消息修订仍保留，释放后下一次真实触发接续。worker摘要的round_result协议见[state.md](state.md)；task_complete不再单独证明项目输入已处理。升级后既有窗口应重新读取skill；旧轮次缺处理结果时需基于真实记录补结果，不能直接清空pending。
