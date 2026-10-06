# 可恢复状态

状态是本机私有数据，不随 skill 分发。写入前完整读旧状态；采用临时文件加原子替换保存，保留原任务和已发送回执。锁从读取旧状态一直持有到保存完成。

原子创建 `run.lock` 后，在其中写 `owner.json`：run_id（本轮独立标识）、runtime（宿主或调度器）、session_ref（实际会话/调度运行记录）、started_at。Codex会话另记真实thread_id、turn_id及可读取的session_log路径；不能只填“当前窗口”或用户请求摘要。若由本机进程驱动，另记真实PID和该进程启动时刻；不填临时shell命令的PID冒充长期执行者。恢复时核对宿主运行状态或PID加启动时刻，防止PID复用。宿主不提供可验证运行标识时，自动恢复不能删除旧锁，需本人介入；正常结束仅锁持有者释放。

`schema_version: 1`，每个配置群分别保留：

- `chat_id`、`owner_open_id`、`last_run_at`。
- `read_checkpoint`：完整扫描边界、已读消息ID/修订摘要、未读分页游标。每轮回读全部可用历史后比较内容摘要，以发现旧消息修改；不能只按创建时点增量读取。读取失败不推进完整边界；全量允许分轮续读，未完成前不基于缺失历史推断授权。
- `tasks[]`：稳定task_id、source_message_ids、owner_open_id、input_version、scope、dependencies、acceptance、next_action、status。
- `tasks[].checks[]`：时间、对应版本、实际操作/命令、实际结果、证据、未测边界。状态为 queued、in_progress、blocked、waiting_for_lock、checked、awaiting_human、cancelled；checked只表示本人该交付的检查完成。
- `reports[]`：operation、task_id、input_version、artifact_digest、exact_body、recipient_open_id（默认本人）、recipient_open_ids（本次去重后的全部实际@对象）、recipient_routing（每人职责、下一动作及来源）、sender_app_id、idempotency_key、status、message_id、verified_at。status为 drafted、sending、sent_verified、delivery_unknown；没有message_id和回读证据不能记sent_verified。
- `needs_input[]`：question_id（同一决定跨轮稳定）、status（pending/answered/cancelled）、source_message_ids、input_version、question_digest、具体决定、options、recommendation及理由、affected_task_ids/blocked_actions、impact、independent_next_actions。通知保留notification_digest、notified_at、notification_channel、notification_message_id（实际发送才填）、notification_evidence；问题变化保留changed_reason，回复保留answer和answer_source。旧条目缺字段时从真实记录补齐；不能因缺字段把已问过的同一项重新通知，也不能虚构消息ID。

确认去重：按question_id和问题/影响摘要匹配旧记录，不能只按“是否已通知”布尔值判断。新项/实质变化集中一次通知；未变且待答只保留台账。受阻动作可记为带parent_task_id的独立子任务，needs_input.blocked_actions引用其task_id；独立子项继续时父任务为in_progress，仅相关动作awaiting_human；全部可执行部分确实受阻才将任务标为awaiting_human或blocked。每个具体决定独立保存，不能以视觉认可代替业务责任或双方U节点签收。
- `scheduler`：真实调度器类型、记录ID、时区、是否启用、最近真实触发证据。无实际调度时enabled=false。

用群来源message_id及其修订作为输入标识，不把每条消息都视为新任务。继续工作靠任务状态；消息已读不代表任务已完成。重读同一交付只更新证据，不重做或重发。

发信超时恢复：回读该群对应时间和线程，核对机器人、正文、@对象与成果版本；找到消息后补真实message_id。确认未送达后用原键重试；无法确认则保持delivery_unknown，不盲目重发。

本机调度使用独立scheduler-status.json记录last_trigger_at、trigger_origin、last_check_at、read_complete、message_count、message_revisions、changed_message_ids、unhandled_changes、pending_dispatch及last_completed_dispatch。运行中看到的新变化保留到后续执行，不因读过而丢失。入队状态与实际执行完成分别记录；身份/分页失败记录错误，不派发任务。真实触发证据与配置都核实后才更新任务台账scheduler的type/record_id/enabled，不覆盖轮询器私有状态。

当前轮读取失败时read_complete=false，保留最近一次成功时间作历史证据，不沿用成功标志。入队失败或超时标delivery_unknown，保存needs_input并先核对marker实际送达，不盲目重试。读群/身份失败按同一incident去重向既有执行窗口报告，窗口也不可用时保留本机告警待恢复。外部依赖blocked每轮可核查恢复；真人awaiting_human仍等待具体结论。

自动轮次完成必须匹配实际接收marker的执行轮次；其他会话轮次结束不能清除待办。检测到该自动轮次被中断时保留待办、暂停服务配置的派发并记录恢复条件，等待本人明确恢复，不能擅自重启已中断工作。

## 锁等待与轮次处理结果

锁等待是技术调度状态，不是等待真人批准。未取得锁不修改他人的项目台账，仅向配置的worker_state_path写本轮摘要及round_result，保存后结束该轮；不删除他人锁。正常锁持有者先保存台账再释放锁。核对真实会话日志的对应turn_id或PID及启动时刻；无法证明旧执行者已结束时保留锁，需要介入的具体恢复问题只通知一次。调度器每10分钟完整读群、保留消息修订并检查锁，释放后自动派发；仍须复核撤回、取消和最新授权。

worker摘要增加以下字段（marker取自动提示中的完整标识）：

```json
{"round_result":{"marker":"shenlai-auto-<真实本轮UUID>","outcome":"processed","read_complete":true},"tasks":[],"last_run_at":"<真实时间>"}
```

`processed`表示本轮已完整读群并处理全部可执行部分或准确记录具体阻塞，不表示所有任务已完成，也不表示允许发报告。无法取锁填`waiting_for_lock`且`read_complete=false`；读取、身份或检查未完成填`incomplete`，不能冒称processed。保持真实tasks，不用空数组清除旧任务。仅自动轮次使用marker，手动轮次不伪造自动处理结果。

调度器只有观察到对应会话轮次结束且收到匹配marker的processed/read_complete=true，才消耗该轮输入修订。锁等待保留待办；没有匹配结果时保留pending和待办，记录awaiting_round_result并向原执行窗口去重提示核对。旧版本仅有task_complete时不能推断工作完成。用户暂停或中断后仍暂停，锁释放不能覆盖暂停。
