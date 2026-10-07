# 分支调度与连续执行

## 保持已授权的执行范围

本人已经授权持续推进后，新消息“看看同事回复”或“检查一下”作为该工作中的补充。读完新交付，继续核对依赖、执行本人复查、修正授权内的问题并检查结果。明确“只读/不执行/暂停/先给方案”等新限制优先；不从持续推进推断新增业务范围、发送批准或真人验收。

收尾前完整读任务台账，对每个尚未完成的next_action作决定：

- 有授权、输入就绪、工具可用：本轮继续，不结束等“继续”。
- 工具或外部依赖受阻：记具体blocked动作、实际错误和恢复方法，下轮只核查恢复，不重复跑同一已正常场景。
- 缺本人才能提供的事实或决定：只阻塞相关动作，其余继续。不能以工具截图代替本人肉眼观察，也不自动签收。
- 需要发信确认：完成具体正文与预览，集中请求；等待期间继续不依赖发送的工作。

保存round_exit，含reason（no_actionable_work/blocked/awaiting_human/paused/runtime_limit）、remaining_task_ids、blocked_actions、resume_condition及真实检查证据。reason与台账须一致；queued/in_progress项仍可执行时不能宣称no_actionable_work。运行限制安全收尾时保留可执行next_action供下一轮接续。自动轮次另按state.md写匹配marker的round_result；不要把“所有任务完成”当成processed的含义。

## 工作目录或分支变化

先核对用户是否要求隔离分支，再核对四项实际绑定：目标thread_id/session_log、project_workspace、该分支config/state/run.lock、专属worker_state摘要。独立开发与团队协作可以共用用户授权的群输入，但不能共用执行锁、写入台账或把一方成果当另一方验收。

优先复用已有调度器。按新分支更新真实settings和服务poller-config的project_workspace/branch_id，并核对schedule的control_path/status_path/worker_state_path；无意外取消/暂停才启用。后台配置的workspace可以是服务目录，其project_workspace必须是实际项目分支目录。模板均为占位值，实际身份、目录和线程须现场核验。

修改前备份，并取得poller锁及该分支独占执行权；其他轮次执行中不改它的台账、也不删除它的锁。保留所有未处理消息、取消/暂停、未知发送和既有报告回执。明确的分支迁移可从该分支真实state生成专属worker摘要，不从父目录复制另一条工作的任务；旧摘要保留作历史，不再作为新分支执行依据。已有pending_dispatch未核清前不更换绑定。

只安装skill不算完成自动接入。验证真实系统触发、完整读群、目标分支路径、对应会话收到marker、实际执行以及匹配结果；业务工作真实受阻时如实报告阻塞，不能用测试或入队回执证明业务完成。只验证到入队时明确说尚待接收/执行，不宣称完整流程已通过。

后台无法直接读取受保护项目文件时，服务配置只用于路由，不冒充实际配置验证。带branch_id的自动轮次必须先在已安装skill目录运行scripts/check_binding.py，使用提示里的workspace/branch-id/owner-open-id/chat-id及--automatic参数；返回verified=true才执行。脚本只读实际配置，不能替代飞书在线身份及完整读群。
