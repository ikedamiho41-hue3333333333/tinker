# Tinker / 捣鼓

> 给"用 AI 创造但不必懂代码"的人的工作室。
>
> GitHub 是给写代码的人的工作室。我们是给"捣鼓东西的人"的工作室 —— ta 们用 AI · 做出真的能跑的东西 · 但不必是程序员。

## 🟢 Alpha 测试

正式上线 · 跑在阿里云 ECS · 公网入口：

**https://daogu.cc**

⚠️ Alpha 期注意:
- 暂时用 IP 访问 · 域名 daogu.cc 已买但未备案 (阿里云对未备案域名做了拦截 · 所有端口都拦)
- 没有真实认证 · 多人测试约定不同 handle (`@xx`) 避免冲突
- 数据存在 server 的 JSON 文件 · 有原子写入 + 5 份 backup 旋转 · 但还没接数据库
- 备案完成后切到 `https://daogu.cc` (7-30 天流程进行中)

---

## 三件套

```
server/      ← Express + JSON 存储 + 静态服务 webapp
webapp/      ← SPA · fetch /api/state + /api/action
cli/         ← `tinker push` 命令行 · 用 LLM 自动生成进展
prototypes/  ← 历史原型 v0.1 - v0.23 (设计迭代记录)
docs/        ← 产品哲学 + spec
```

完整的"创作 → 反馈 → 通知 → 召回"闭环。看 [`docs/01-product-spec.md`](docs/01-product-spec.md) 了解产品哲学。

---

## 本地跑

需要 Node.js 18+ (用 built-in fetch)。

```bash
# 1. 起 server (默认 8788)
cd server
npm install
node index.js
# 浏览器访问 http://localhost:8788/

# 2. (可选) 装 CLI
cd ../cli
npm install
npm link              # 全局可用 `tinker` 命令
tinker login          # 配置 (server URL + handle + 可选 LLM key)
tinker push -m "你的第一条进展"
```

---

## CLI 用法

```bash
tinker push                          # 交互式 · 选项目 · 写一句 · 推
tinker push -m "..."                 # 直接推一条
tinker push --since 1h               # 抓最近 1 小时 git 历史作为建议
tinker push --auto                   # LLM 自动生成 + 推 (无交互)
tinker push --since 1h --auto        # LLM 总结 1 小时进展 + 推
tinker draft                         # LLM 看建议 (不推)
tinker draft --since 30m             # 自定义时间窗
tinker projects                      # 列我的活跃项目
tinker hook install                  # 装 git post-commit hook
tinker config                        # 看当前配置
```

`--since` 支持: `30m` / `2h` / `1d` / `today` / `yesterday` / 任意 git 能理解的格式。

LLM 支持: Anthropic Claude (默认) / OpenAI / DeepSeek。

### 飞书项目推进 skill（可独立使用）

无需 Tinker 登录，在仓库根目录运行 `node cli/bin/tinker.js skills install --agent codex --only feishu-project-runner`，即可安装完整的 `$feishu-project-runner` 包。成员在自己的项目窗口核对飞书身份、群、职责和授权后调用；安装不会自动启动调度。

包内提供可选的 macOS/Codex 后台轮询：神来－圆周率全天每10分钟检查，实际任务与成果报告由本人项目会话处理。[团队接入、手动执行、调度验证与停止步骤](cli/skills/feishu-project-runner/references/automation.md)。此版本不接入 Tinker 网页任务状态。

---

## 让小伙伴一起测试

直接给 ta 们 **https://daogu.cc** 这个链接：

1. 浏览器打开 · 弹"你是谁?" → 填 handle + 一句 tagline → 进入主屏
2. 想发动静 → 「+ 记一笔」→ 选项目或开新项目（开新项目必须挂 https:// 产物链接）
3. 想反馈别人 → 项目页 「想试试」/「做了延伸版」/ 留便签

⚠️ **多用户冲突**：当前没有真认证，所有人共用 `handle` 字段空间。alpha 期约定每人用不同 handle (`@xx`) 避免撞。真生产前会加 OAuth。

### 给 CLI 用户（懂代码的小伙伴）

```bash
git clone https://github.com/Hldao/tinker.git
cd tinker/cli
npm install && npm link
tinker login   # server URL 填 https://daogu.cc · handle 填自己的
tinker push    # 试着推一条
```

### 自己搭一套（fork 自部署）

```bash
# 国内服务器 (阿里云/腾讯云等 · 未备案用 8788 高端口)
wget -O - https://raw.githubusercontent.com/Hldao/tinker/main/deploy/setup-vps-cn.sh | bash

# 海外服务器 (DigitalOcean/Hetzner 等 · 80/443 + 自动 HTTPS)
wget https://raw.githubusercontent.com/Hldao/tinker/main/deploy/setup-vps.sh
bash setup-vps.sh your-domain.com your@email.com
```

详见 [`docs/03-deployment.md`](docs/03-deployment.md)。

---

## 架构

```
                ┌─────────────────────────┐
                │   webapp (浏览器)         │
                │   index.html · fetch API  │
                └────────────┬────────────┘
                             │ /api/*
                ┌────────────▼────────────┐
                │   server (Express)        │
                │   ├ /api/state            │
                │   ├ /api/action           │
                │   └ /api/reset            │
                └────────────┬────────────┘
                             │ load/save
                ┌────────────▼────────────┐
                │   data.json               │
                │   (server-managed JSON)   │
                └─────────────────────────┘
                             ▲
                             │ /api/action
                ┌────────────┴────────────┐
                │   CLI (tinker push)      │
                │   ├ git history          │
                │   └ LLM (Claude/GPT/DS)  │
                └─────────────────────────┘
```

**关键决策**:
- API 单一可变面: `GET /api/state` + `POST /api/action { type, payload }`
- 12 个 action handlers (`server/actions.js`)
- 每个 action 触发 saveData() · 防丢失
- CLI 和 webapp 完全等权 (调同一 API)

---

## 哲学速查 (写代码前请读)

按 [`docs/01-product-spec.md`](docs/01-product-spec.md)，加新功能前过一遍这 9 个判断问题:

1. **工程**: 长期维护成本?
2. **法律**: 合规红线?
3. **情感**: 让用户更焦虑还是更安心?
4. **真实**: 让数据更真实还是更"看起来繁荣"?
5. **运营**: 上线后谁来持续维护?
6. **行为可执行性**: 用户那个时刻真的会做这个操作吗?
7. **视角对称性**: 不同用户群体的能力/信息差异是什么?
8. **情感时刻不数据化**: 这个功能把善意/事件商品化吗?
9. **反技术中心化**: 这个功能/字段/词汇假设用户懂代码吗?

**任一答案不理想 → 默认不做。** 做减法比做加法需要更多勇气。

---

## 完整文档

- [`docs/01-product-spec.md`](docs/01-product-spec.md) — 产品哲学 + 9 个判断问题 + 不做清单 (必读)
- [`docs/02-api.md`](docs/02-api.md) — REST API 完整参考
- [`docs/03-deployment.md`](docs/03-deployment.md) — 部署 runbook (VPS / Docker / Caddy)
- [`docs/04-roadmap.md`](docs/04-roadmap.md) — 优先级判断备忘
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 协作指南 (PR / 测试 / 代码风格)
- [`CHANGELOG.md`](CHANGELOG.md) — 版本变更记录

## License

MIT (or whatever you decide)
