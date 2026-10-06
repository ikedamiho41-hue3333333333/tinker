# 与团队任务板对接

任务板负责正式任务分配、project/key/current version、验收标准和真人验收；runner负责真实调度唤醒、理解群指令、执行本人可推进工作及检查。任务板的回报补送不等于自动执行项目，两套后台不能同时运行同一任务。

仅对明确分配给本人的任务读取正式标识和当前版本，核对群里的最新授权。已有work run覆盖的检查复用真实退出码和日志，不伪造证据或重复包装检查。台账关联正式任务ID，群消息及修订仍保留作为指令来源。

团队配置指定project-taskboard-group-report时，在开始、明确阻塞、执行并验证结束分别使用in_progress、blocked、pending_review；不得自行done。稳定operation按实际动作生成；发送前先预览，遵循用户要求的目标群、完整正文和本人身份确认；发送后回读任务详情或群卡，回执本身不证明入账。

现有任务板回报工具使用本人user身份，不能强行换成饺子bot；普通成果通知仍按配置使用饺子。安装版本与固定命令入口分别核验，不因channel已更新就断言固定入口也已更新。不要为接入自动扩权或覆盖现有配置。

本机2026-10-07核验：channel为0.1.19，固定group-report入口仍为0.1.9，升级入口需独立处理；这是现场情况，不是团队安装的固定版本要求。正式对接前核对实际CLI帮助、包版本及配置。

来源：[大岛安装协议](https://applink.feishu.cn/client/chat/open?openChatId=oc_5bb25aa43fe705b2b93011d467b0b47f&position=1875)、[工作区和自动回报](https://applink.feishu.cn/client/chat/open?openChatId=oc_5bb25aa43fe705b2b93011d467b0b47f&position=1907)、[0.1.19更新与补送](https://applink.feishu.cn/client/chat/open?openChatId=oc_5bb25aa43fe705b2b93011d467b0b47f&position=2063)。以上是针对性消息核查，不代表完整群历史扫描。
