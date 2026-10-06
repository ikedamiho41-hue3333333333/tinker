# 成员接入与调度

安装团队包中的 `feishu-project-runner` 文件夹到本人 Codex skills 目录；跨运行时也可使用 `~/.agents/skills`。不要覆盖同名已有 skill，先核对版本。无需共享 appSecret、令牌或另一个人的登录态。

在实际项目工作目录建立 `.feishu-project-runner/config.json`，填写：

| 字段 | 用途 |
| --- | --- |
| schema_version | 当前为1 |
| project_name / chat_name / chat_id | 真实项目及核对过的群；先用 `im +chat-search` 解析名称 |
| workspace | 本机实际项目目录，不复用同事电脑路径 |
| owner_name / owner_open_id | 本人账号，与 `auth status --json --verify` 核对 |
| sender_name / sender_app_id | 用于报告的机器人；刚子默认饺子 |
| report_recipient_open_id | 默认真人本人，不能填机器人 ID；保留兼容旧配置 |
| report_routing | 可选；owner_always=true、strategy=owner_and_next_responsible；contacts绑定协作者真实身份及分工来源，每轮按职责选择，不将联系人全体作为默认收件人 |
| read_identity / send_identity | 分别为 user / bot；具体例外依用户明确指令 |
| profile | 可选，缺省保留当前 CLI 配置 |
| role_scope | 本人在本项目获分配的职责与允许工作范围 |
| reporting_authorized | 本人是否已经明确授权本轮/后续实质成果报告 |
| schedule | interval_minutes、window_mode、start、end、timezone、enabled、status；all_day表示全天，start/end为null，时区不影响10分钟相对间隔；只有指定时间窗口才需先确认时区 |

调用入口：在项目工作目录告诉 Codex：

```text
使用 $feishu-project-runner，按本工作目录配置执行一轮项目任务；只完成本人职责内的工作，实际检查后报告成果，不发配置或巡检消息。
```

演练入口加“仅核对群任务和生成本地台账，不执行任务，不发送消息”。手动调用不受定时窗口限制，因为它有本人当次明确指令。

自动运行需要实际调度器。优先使用宿主提供的定时任务管理界面或工具，将上述入口保存为每轮提示，绑定真实项目目录及正确时区。若宿主不支持该周期，可在用户明确允许后配置本机调度器调用已登录的 Codex CLI；不得通过绕过沙箱/审批来获得无人值守执行。

定时提示还须写明：按配置全天或指定窗口启动，先锁后读，同轮持续推进已授权可执行事项，必要确认去重集中提出、等待期间继续独立工作，按state恢复，不发配置/巡检消息，成果检查完成后以配置机器人报告并@配置的本人及按项目分工需接手/确认的成员，需介入时按授权渠道通知，取消时停止。

启用前验证：

1. 配置身份和读群成功，报告机器人是预期身份；缺权限按实际缺项补齐。
2. 在本项目手动运行一轮，确认任务归属、真实执行、检查结果和状态保存。只有有实质成果时才测试报告。
3. 验证同一任务不会重做，下一轮能继续未完成工作，发信超时不会重复报告。
4. 创建实际调度记录并回读；证明一次由调度触发的运行及其台账。仅写配置不能标 enabled/verified。
5. 向用户说明触发方式、时区、项目目录和停止方法。电脑与宿主必须满足所选本地调度方式的运行条件，休眠/断网后恢复未完成事项。

如遇 CLI 高风险确认退出码10、沙箱审批、自动审批拒绝，暂停对应动作并向本人解释真实门禁，不静默追加确认参数。

本机可用launchd每600秒触发只读轮询，核验身份并完整读群后向既有Codex项目会话入队。运行中或已有待处理轮次时不重复入队，期间发现的新消息仍保留待处理。调度记录与轮询日志独立于任务台账；需要保留本机运行、网络及目标会话可用条件。不得添加绕过审批或沙箱的参数。

项目config.schedule.control_path绑定轮询配置的真实路径；用户暂停自动推进时由执行窗口修改该配置enabled=false。任务台账scheduler必须从已核实的系统触发记录同步，不能只留旧的not_created。
