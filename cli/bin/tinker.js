#!/usr/bin/env node
/**
 * tinker — 在 coding 时一句话发布到捣鼓
 *
 * 命令:
 *   tinker login                       # 配置 server URL + handle + (可选) LLM
 *   tinker config                      # 看当前配置
 *   tinker projects | ls               # 列我的活跃项目
 *
 *   tinker push                        # 交互式 · 选项目 · 写一句 · 推
 *   tinker push -m "..."               # 直接推一条
 *   tinker push --since 1h             # 抓最近 1 小时 git 历史作为建议
 *   tinker push --auto                 # LLM 自动生成内容并推 (无交互)
 *   tinker push --since 1h --auto      # LLM 总结 1 小时进展并推
 *
 *   tinker draft                       # 用 LLM 生成一句建议 (默认 1h history)
 *   tinker draft --since 30m           # 自定义时间窗
 *
 *   tinker hook install                # 装 git post-commit hook
 *   tinker hook uninstall              # 卸 hook
 *
 * --since 支持: 30m / 2h / 1d / today / yesterday / 任意 git 能理解的格式
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.tinker');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
// v0.12 踩坑全周期状态机 · lazy 加载避免影响主 CLI 启动速度
let _struggleModule;
function getStruggleModule() {
  if (!_struggleModule) _struggleModule = require('../lib/struggle');
  return _struggleModule;
}

// =============================================
// 工具 — 颜色 / log
// =============================================
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', vermilion: '\x1b[38;5;166m',
  moss: '\x1b[38;5;28m', sepia: '\x1b[38;5;243m',
};
function log(s) { process.stdout.write(s + '\n'); }
function dim(s) { return C.dim + s + C.reset; }
function bold(s) { return C.bold + s + C.reset; }
function vermilion(s) { return C.vermilion + s + C.reset; }
function moss(s) { return C.moss + s + C.reset; }
function sepia(s) { return C.sepia + s + C.reset; }
function err(s) { process.stderr.write(C.red + '✗ ' + s + C.reset + '\n'); }
function ok(s) { log(moss('✓ ') + s); }

// JSON 模式输出 helper · 给 AI agent 用 · 错误也走 JSON 走 stdout + exit 1
// 所有 --json 命令统一用这两个 · 不要走 log/err 文本输出
function outputJson(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function agoZh(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  const m = Math.floor(s / 60); if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60); if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}
function errJson(msg, code, extra) {
  const out = { ok: false, error: msg, code: code || 'ERROR' };
  if (extra) Object.assign(out, extra);
  outputJson(out);
  process.exit(1);
}

// =============================================
// Config
// =============================================
function loadConfig() {
  // 优先级:env var > config 文件 · 让 AI agent / CI / 远程跑都能用
  // TINKER_TOKEN / TINKER_SERVER / TINKER_HANDLE 三个 env 都支持
  let cfg = null;
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) {}
  }
  if (process.env.TINKER_TOKEN || process.env.TINKER_SERVER || process.env.TINKER_HANDLE) {
    cfg = cfg || {};
    if (process.env.TINKER_TOKEN) cfg.token = process.env.TINKER_TOKEN;
    if (process.env.TINKER_SERVER) cfg.serverUrl = process.env.TINKER_SERVER.replace(/\/$/, '');
    if (process.env.TINKER_HANDLE) cfg.handle = process.env.TINKER_HANDLE;
    if (!cfg.serverUrl) cfg.serverUrl = DEFAULT_SERVER_URL;
  }
  return cfg;
}
function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// 待办本地缓存 · ~/.tinker/todos-cache.json
// 目的:todo list 离线可看 / 秒开 · 也给"到期提醒"每条 prompt 的探测提供零网络数据源
// 尽力而为:读写失败都不抛 · 缓存坏了就当没缓存 · 绝不拖垮主命令
const TODOS_CACHE_FILE = path.join(CONFIG_DIR, 'todos-cache.json');
function saveTodosCache(todos) {
  try {
    if (!Array.isArray(todos)) return;
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(TODOS_CACHE_FILE, JSON.stringify({ at: Date.now(), todos }, null, 2));
  } catch (e) { /* 缓存写失败不影响主流程 */ }
}
function loadTodosCache() {
  try {
    if (!fs.existsSync(TODOS_CACHE_FILE)) return null;
    const c = JSON.parse(fs.readFileSync(TODOS_CACHE_FILE, 'utf-8'));
    if (!c || !Array.isArray(c.todos)) return null;
    return c; // { at, todos }
  } catch (e) { return null; }
}
// 默认 / 兜底 server URL (备案后正式域名) · 旧 config 的 IP / ngrok 地址会失效 · 这是 fallback
const DEFAULT_SERVER_URL = 'https://daogu.cc';

function mustHaveConfig(opts) {
  const requireToken = !opts || opts.requireToken !== false;
  const cfg = loadConfig();
  if (!cfg) {
    err('还没配置 · 跑 ' + vermilion('tinker login'));
    process.exit(1);
  }
  if (requireToken && !cfg.token) {
    err('config 是老版的 · 没有钥匙(token)');
    log(sepia('  原因:v0.1 alpha 时代用 handle 信任登录 · 现在改 Bearer token · 不兼容'));
    log(sepia('  解法:'));
    log(sepia('    1. 浏览器到 ') + vermilion(DEFAULT_SERVER_URL + '/#/w/<你的 handle>'));
    log(sepia('    2. 在工作室 tagline 旁点 "CLI 钥匙" · 生成一把(只显示一次 · 复制下来)'));
    log(sepia('    3. 跑 ' + vermilion('tinker login') + ' · 粘上钥匙'));
    process.exit(1);
  }
  if (cfg.serverUrl && /ngrok/.test(cfg.serverUrl)) {
    log(sepia('  ⚠ config 里的 server 还是 ngrok 临时地址 · 大概率已经死了 · 跑 ') + vermilion('tinker login') + sepia(' 会换成新的'));
  }
  return cfg;
}

// =============================================
// API client
// =============================================
function authHeaders(cfg) {
  if (!cfg.token) return { 'Content-Type': 'application/json' };
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token };
}

// 统一 fetch 包装 · 把 404/401/403/网络错误翻成 actionable 中文提示
async function safeFetch(cfg, path, init) {
  let res;
  try {
    res = await fetch(cfg.serverUrl + path, init);
  } catch (e) {
    throw new Error('连不上 server (' + cfg.serverUrl + ') · 网络不通或地址变了 · 跑 `tinker login` 重新配 server + 钥匙');
  }
  if (!res.ok) {
    // 看响应体 · 但 404 时 server 可能返 HTML
    let bodyErr = '';
    try {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const data = await res.json();
        bodyErr = data.error || '';
      }
    } catch (e) { /* swallow */ }
    if (res.status === 404) {
      throw new Error('404 · server 找不到这个接口 · 可能 config 里 server 地址旧了 · 跑 `tinker login` 重新配');
    }
    if (res.status === 401) {
      throw new Error('401 · 钥匙过期或不对 · 跑 `tinker login` 重新粘一把新的');
    }
    if (res.status === 403) {
      throw new Error('403 · 这把钥匙没权限做这件事 (比如 API token 不能管理 token)');
    }
    if (res.status === 429) {
      throw new Error('429 · 请求太频繁 · 等 1 分钟再试');
    }
    throw new Error('server ' + res.status + ' · ' + (bodyErr || '(没具体错误信息)'));
  }
  return res;
}

// v0.21 helper · cmdStudio / cmdBridge* 用 · 直接拿 JSON body · 不用每个 case 写 res.json()
async function safeFetchJson(cfg, path, init) {
  const res = await safeFetch(cfg, path, init);
  return res.json();
}

async function apiState(cfg) {
  const res = await safeFetch(cfg, '/api/state', { headers: authHeaders(cfg) });
  const state = await res.json();
  // 顺手刷待办本地缓存 · 任何拉 state 的命令都让缓存保鲜 · 供离线读 + 到期提醒探测
  if (state && Array.isArray(state.todos)) saveTodosCache(state.todos);
  return state;
}
async function apiMe(cfg) {
  const res = await safeFetch(cfg, '/api/auth/me', { headers: authHeaders(cfg) });
  return res.json();
}
async function apiAction(cfg, type, payload) {
  // x-tinker-no-state: CLI 不渲染全站 state · 让 server 跳过 buildState 别回 179KB
  // (webapp 需要回 state 重渲染 · 不带这个头)
  const res = await safeFetch(cfg, '/api/action', {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'x-tinker-no-state': '1' },
    body: JSON.stringify({ type, payload }),
  });
  return res.json();
}

// =============================================
// Git helpers
// =============================================
function inGitRepo() {
  try { execSync('git rev-parse --git-dir', { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}
function gitOneCommit() {
  if (!inGitRepo()) return '';
  try {
    return execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
  } catch (e) { return ''; }
}
function parseSinceForGit(spec) {
  if (!spec) return '1 hour ago';
  const s = spec.trim();
  let m;
  if ((m = s.match(/^(\d+)m$/))) return `${m[1]} minutes ago`;
  if ((m = s.match(/^(\d+)h$/))) return `${m[1]} hours ago`;
  if ((m = s.match(/^(\d+)d$/))) return `${m[1]} days ago`;
  if (s === 'today') return 'midnight';
  if (s === 'yesterday') return '24 hours ago';
  return s; // git 能理解的其他格式
}
function gitHistorySince(spec) {
  if (!inGitRepo()) return null;
  const gitSince = parseSinceForGit(spec);
  try {
    const log = execSync(
      `git log --since="${gitSince}" --pretty=format:"%h %s" --no-merges`,
      { encoding: 'utf-8' }
    ).trim();
    const stat = execSync(
      `git log --since="${gitSince}" --shortstat --pretty=format:"" --no-merges`,
      { encoding: 'utf-8' }
    ).trim();
    // 当前未 commit 的 changes summary
    let pendingStat = '';
    try {
      pendingStat = execSync('git diff --shortstat', { encoding: 'utf-8' }).trim();
    } catch (e) {}
    return { log, stat, pendingStat, since: gitSince };
  } catch (e) { return null; }
}

// =============================================
// LLM
// =============================================
// 默认 Tinker 工艺人日志 voice · 用户可以在项目里 .tinker/voice.md 覆盖
const DEFAULT_VOICE = `Tinker(中文名:捣鼓)是给 vibe coder 的工作室社区,进展 voice 是工匠的工作日志,不是 release note,不是 changelog,不是产品发布会。

最重要的反直觉:不要总结所有事。挑一个具体的转向或具体的发现讲清楚就够。

==================
对作者自己写 vs 对 LLM 代写 · 这条规则有两种走法
==================
- 作者自己写:挑心里咯噔一下的事讲,把那一刻的想法说清楚。
- LLM 代写:只在 commit / git history 里能找到具体转向锚点时才讲转向。
  如果作者没说怎么想,你 (LLM) 不要硬猜情绪。
  不要编"咯噔""卡得厉害""突然意识到""服气""纠结"这种内心活动。
  没锚点时,退一步:只描述实际发生的事,加一句可复用的 takeaway,不编情绪。

字数:控制在 150 到 280 字之间。宁可少,不要长。

==================
一个真实的好例子(模仿这种节奏):
==================
没怎么写代码,但产品改了不少。

把"动静"和"陈列馆"合成一个屏了,叫"工坊"。陈列馆的进门规矩也松了,你写了一笔进展,作品就自动在那儿。

不过更关键的转向,是想明白 Tinker 真正值钱的是命令行,不是网页。

我们用 AI 做东西的人,大部分时间在终端里。最值得记的那个想法常常是 commit 完那十几秒冒出来的,等我打开网页那股劲就过了。所以给命令行加了一个能力:commit 完它自己判断要不要问你一笔。

规矩定死:永远是"要不要"不是命令,不打分,不告诉别人你卡了,觉得烦随时关。

接下来想接 AI 帮起草。

为什么这是好例子:开头一句话状态总览,然后一个具体改动,然后一个"咯噔一下"的转向,接着把这个转向讲清楚,结尾一句话规矩或下一步。有节奏,有反思,有边界感。

==================
一个坏例子(避免这种)
==================
把触发机制跑通了一版 v0.2,5 处优化收尾。卡在 "捣鼓" 歧义上——试了只匹配动词形,避开产品名误触;又试了把词升格成 BRAND_MENTION 品牌信号才稳住。接着扩了触发器组合:BREAKTHROUGH / TINKER / DISCOVERY 加上 FRUSTRATED 破防。UI 那边同步推了 v0.68。

为什么这是坏例子:版本号当锚点、ALL_CAPS 代码标识符当名词、em-dash、罗列动作没反思、读起来像 PM 周报。

==================
硬性禁用清单(违反一条就重来):
==================
1. 不要用 ALL_CAPS 英文标识符当中文名词。代码里叫 BRAND_MENTION,中文写"品牌信号"或就用具体说什么的话。
2. 不要在正文里堆版本号(v0.62 / v0.63 这种)。一条 update 里出现 1 次以上版本号就太多了。
3. 不要用中圆点(·)做句中分隔。用逗号、顿号、句号。
4. 不要用 em-dash(——、—)。中文写作里几乎不用这个。
5. 不要"第一...第二...接着...同时..."这种枚举结构。改用自然过渡:"不过""然后"。
6. 不要"feature add""bug fix""完成了 X 模块""推了一版"这种 changelog 词。
7. 不写"今天/最近/这段时间"开头。平台显示时间,作者不重复。
8. 不写"很有意思""值得记""有意义"这种自我评价。读者自己感受。
9. 不要 markdown 块级元素(# 标题 / - 列表 / > 引用)。inline 的 **粗体** 和 \`代码\` 可以。
10. LLM 代写时,不写"咯噔""服气""卡得厉害""突然意识到""纠结"这种作者内心活动。git history 里没写就不许编。作者自己写时这条不限制。
11. 不写"Tinker 真正值钱的是命令行""主战场转向 X""用户根本不是 Y 是 Z"这种立场宣告。除非作者明确说过,LLM 不允许替作者下产品方向定论。

==================
鼓励的写法
==================
- 短句优先,普通句号断开
- 第一句话给个状态概览("没怎么写代码,但..." / "改了一下 X" / "加了一个东西")
- 选一个最值得说的事讲透,不是全部 commit 列一遍
- "为什么"比"做了什么"重要
- 实事求是。git 没说的别替作者编
- 末尾留一句 takeaway 或可复用的小判断,不强求,但有的话其他人 (或其他 AI) 看了能学到东西
  例:"AI 没作者视角,让它替你想会走偏,让它替你整理可以"
  例:"这种决策几个月后想不起来当时为什么这么做,要写下来"
  例:"卡住可以发,只要还在试就行"

==================
实事求是规则(最重要 · 你做不到就直接返回 candidates 空数组)
==================
- 只写 git history 里真正发生的事,commit message 里没写的别瞎编
- 别替作者捏造情绪("卡了一晚上""试了三次")
- 别凭空说时间("一个月前""半年前")
- 提团队/朋友时不确定性别用名字带过

最严重的捏造类型(绝对不要写):
1. "结果发现 / 实际跑下来 / 我观察到" 这种事后反思 — 你只看到了 commit,不知道后续真实发生了什么
2. "agent 比真人 X / 这种模式很常见" 这种凭空数据论断 — 你没有数据
3. "可复用的 takeaway / 可以总结为 / 这告诉我们" 这种 consultant 收尾 — LLM 偷懒填补结尾的常见模板,真人写日志不会这样收
4. "出乎意料 / 没想到" — 你不知道作者预期是什么
5. 把作者没在 commit message 里说的设计原因当成既定事实写出来

作者能写的反思只有这三种:
- 设计意图("我加了 X 是想让 Y 更容易")
- 当前判断("我觉得这个方向是对的,因为...")
- 下一步打算("接下来想做 Z")

不能写的伪反思:
- 事后效果观察(没数据)
- 用户反应(没跟真用户聊过)
- 跟其他产品对比(LLM 不知道竞品)`;

const DRAFT_PROMPT_TEMPLATE = `${'$'}{voice}

${'$'}{fingerprint}

${'$'}{goodSamples}

${'$'}{rejectSamples}

==================
任务
==================
看下面的 git 历史和当前未 commit 改动,挑一个最值得说的角度,起草一条进展。

注意:
- 只起草 1 条,不是 1-3 条。LLM 写多了反而都平庸。
- 这一条要符合上面所有规则,尤其是字数(150-280 字)和硬性禁用清单。
- 如果上面给了 fingerprint / 真实样本,优先 mimic 那种节奏和语言习惯,而不是单纯按规则避雷。
- 如果 git 全是 typo / 格式调整 / 自动 lint / 没真实信号,返回 { "candidates": [] }。
- 写完之前自检一遍:有没有 ALL_CAPS 标识符?有没有版本号?有没有中圆点(·)?有没有 em-dash?有没有"接着...然后..."?有的话重写。

输出严格 JSON(只输出 JSON 本体,不要 markdown 代码块):
{
  "candidates": [
    { "text": "...", "rationale": "一句话说为什么挑这个角度,不会发布" }
  ]
}

==================
Git 时间窗:${'$'}{since}

Git commits:
${'$'}{history}

${'$'}{pending}`;

function loadVoice() {
  // 在当前 cwd 往上找 .tinker/voice.md
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    const f = path.join(dir, '.tinker', 'voice.md');
    if (fs.existsSync(f)) {
      try { return fs.readFileSync(f, 'utf-8').trim(); } catch (e) {}
    }
    dir = path.dirname(dir);
  }
  return DEFAULT_VOICE;
}

// v0.4 Phase 3 · 读 .tinker/voice-fingerprint.md (cmdVoiceAnalyze 生成的)
// 没有就返回空串 · 不强求 (alpha 期 pool 薄时 fingerprint 不存在很正常)
function loadFingerprint() {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    const f = path.join(dir, '.tinker', 'voice-fingerprint.md');
    if (fs.existsSync(f)) {
      try {
        const raw = fs.readFileSync(f, 'utf-8').trim();
        if (!raw) return '';
        return `==================
voice fingerprint · 作者真实风格画像 (优先 mimic 这个 · 比 voice 硬规则准)
==================
${raw}`;
      } catch {}
    }
    dir = path.dirname(dir);
  }
  return '';
}

// v0.4 Phase 3 · 从 ~/.tinker/style-pool/good/ 抽 N 篇最近的 good sample
// 默认 3 篇 · 不够就有几篇用几篇 · 完全没就返回空串
function loadGoodSamples(n = 3) {
  const dir = path.join(CONFIG_DIR, 'style-pool', 'good');
  if (!fs.existsSync(dir)) return '';
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse();
  } catch { return ''; }
  if (files.length === 0) return '';
  const picked = files.slice(0, n);
  const texts = picked.map(f => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
    const m = raw.match(/---\s*\n[\s\S]*?\n---\s*\n([\s\S]+)$/);
    return m ? m[1].trim() : raw.trim();
  }).filter(Boolean);
  if (texts.length === 0) return '';
  const joined = texts.map((t, i) => `### 真实样本 ${i + 1}\n${t}`).join('\n\n');
  return `==================
作者最近发过的 ${texts.length} 篇真实 update (学这种节奏 / 句法 / 词汇)
==================
${joined}`;
}

// v0.4 Phase 4 · 读 ~/.tinker/style-pool/reject-diff/*.json (LLM 草稿被作者改的 case)
// 给 LLM 看 "AI 起草版" vs "作者改后版" 的对比 · 学怎么避免类似错
function loadRejectSamples(n = 2) {
  const dir = path.join(CONFIG_DIR, 'style-pool', 'reject-diff');
  if (!fs.existsSync(dir)) return '';
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
  } catch { return ''; }
  if (files.length === 0) return '';
  const picked = files.slice(0, n);
  const diffs = picked.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { return null; }
  }).filter(Boolean);
  if (diffs.length === 0) return '';
  const joined = diffs.map((d, i) => `### 改稿 ${i + 1}
[AI 起草版]
${d.llmDraft || ''}

[作者改后版]
${d.finalText || ''}`).join('\n\n');
  return `==================
AI 起草过的草稿 · 作者改成下面这样了 (避免起草版那种 tell · 学改后版怎么写)
==================
${joined}`;
}

// anthropic 默认模型 · 之前硬编码在 6 处 LLM 调用里 · 收成一个常量 · 换型号只改这
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// 三家 provider 的 LLM 调用收口 · fetch / header / body / 解析 / 错误全在这一处
// provider 由调用方传 (各命令默认不同 · draft 默认 anthropic · voice analyze 默认 deepseek)
// 返 { text, tokens } · text 是 trim 过的回复 · tokens 交给调用方按 kind 记 usage
// 出错统一 throw · 调用方按需 try/catch (有的吞成 null · 有的 err+exit)
async function callLLM(cfg, provider, prompt, opts = {}) {
  const apiKey = cfg.llm.apiKey;
  const maxTokens = opts.maxTokens || 1500;
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.llm.model || DEFAULT_ANTHROPIC_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Anthropic API ' + res.status);
    return { text: data.content[0].text.trim(), tokens: data.usage && (data.usage.input_tokens + data.usage.output_tokens) };
  } else if (provider === 'openai') {
    const body = { model: cfg.llm.model || 'gpt-4o-mini', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
    if (opts.jsonMode) body.response_format = { type: 'json_object' };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'OpenAI API ' + res.status);
    return { text: data.choices[0].message.content.trim(), tokens: data.usage && data.usage.total_tokens };
  } else if (provider === 'deepseek') {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.llm.model || 'deepseek-chat', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'DeepSeek API ' + res.status);
    return { text: data.choices[0].message.content.trim(), tokens: data.usage && data.usage.total_tokens };
  }
  throw new Error('不支持的 LLM provider: ' + provider);
}

async function llmDraft(cfg, gitContext) {
  if (!cfg.llm || !cfg.llm.apiKey) {
    throw new Error('LLM 没配置 · 重新跑 ' + vermilion('tinker login') + ' 配一下');
  }
  const provider = cfg.llm.provider || 'anthropic';
  const history = gitContext.log || '(没有 commit)';
  const pending = gitContext.pendingStat
    ? `当前未 commit 的改动:\n${gitContext.pendingStat}` : '';
  const voice = loadVoice();
  // v0.4 Phase 3 · 加 fingerprint + few-shot 真实样本 + 改稿对比
  // 三个都有就全用 · 空就跳过 (DEFAULT_VOICE 保底)
  const fingerprint = loadFingerprint();
  const goodSamples = loadGoodSamples(3);
  const rejectSamples = loadRejectSamples(2);
  const prompt = DRAFT_PROMPT_TEMPLATE
    .replaceAll('${voice}', voice)
    .replaceAll('${fingerprint}', fingerprint)
    .replaceAll('${goodSamples}', goodSamples)
    .replaceAll('${rejectSamples}', rejectSamples)
    .replaceAll('${since}', gitContext.since)
    .replaceAll('${history}', history)
    .replaceAll('${pending}', pending);

  const { text, tokens } = await callLLM(cfg, provider, prompt, { maxTokens: 2000, jsonMode: true });
  let rawText = text;
  recordLLMUsage(provider, tokens, 'draft');

  // 容错:有时 LLM 会用 ```json 包起来 · 剥掉
  rawText = rawText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch (e) {
    throw new Error('LLM 返回的不是合法 JSON:\n' + rawText.slice(0, 200));
  }
  if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
    throw new Error('LLM 返回结构不对 · 应该有 candidates 数组');
  }
  return parsed.candidates;
}

// v0.64 · prompt 流程里用的简版 · 拿单条草稿当 input 默认值
// 没配 LLM / 调用失败 都返回 null · 调用方走原本的空 input 路径
// 默认时间窗 1 小时 · UI session 时传 session 起始时间更精准
//
// validate / 重写循环:
// 1. LLM 起草 · sanitize 一遍
// 2. 跑 validateDraft 检测"伪数据论断"(用户没收集过的)
// 3. 有违规就让 LLM 重写一次 · 把违规句指给它
// 4. 重写还有违规 → 返 null · 用户手敲 (宁可没草稿也不放伪论断进 update)
async function llmQuickDraft(cfg, opts = {}) {
  if (!cfg || !cfg.llm || !cfg.llm.apiKey) return null;
  try {
    const sinceSpec = opts.sinceMinutes ? `${opts.sinceMinutes}m` : '1h';
    const gitCtx = gitHistorySince(sinceSpec);
    if (!gitCtx || !gitCtx.log) return null;

    const candidates = await llmDraft(cfg, gitCtx);
    if (!candidates || candidates.length === 0) return null;
    let draft = sanitizeDraft(candidates[0].text || null);
    if (!draft) return null;

    // Round 1 检测
    const violations = validateDraft(draft);
    if (violations.length === 0) return draft;

    // Round 2 · 让 LLM 拿着违规重写一次
    const reworked = await llmRework(cfg, gitCtx, draft, violations);
    if (!reworked) return null;
    const reworkedClean = sanitizeDraft(reworked);
    if (!reworkedClean) return null;
    const reworkViolations = validateDraft(reworkedClean);
    if (reworkViolations.length > 0) return null; // 还是违规 · 放弃
    return reworkedClean;
  } catch (e) {
    return null;  // 静默失败 · 不打断 prompt 流程
  }
}

// 用 LLM 重写一次 · 指明违规给它 · 让它拿走那几句
async function llmRework(cfg, gitCtx, badDraft, violations) {
  if (!cfg.llm || !cfg.llm.apiKey) return null;
  const provider = cfg.llm.provider || 'anthropic';
  const prompt = `你刚才写的草稿里有"伪数据论断"——作者没收集过这种数据 · 你凭空编了。

你的草稿:
"""
${badDraft}
"""

检测到的违规:
${violations.map(v => '- ' + v).join('\n')}

重写一次 · 拿走违规那几句 · 保留其他能讲清设计意图的部分。
如果拿走后剩下的太少 / 没意思 · 直接返回 { "candidates": [] }。

输出严格 JSON:
{ "candidates": [ { "text": "...", "rationale": "..." } ] }`;

  try {
    const { text } = await callLLM(cfg, provider, prompt, { maxTokens: 1500, jsonMode: true });
    let rawText = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(rawText);
    if (!parsed.candidates || parsed.candidates.length === 0) return null;
    return parsed.candidates[0].text || null;
  } catch { return null; }
}

// 检测草稿里的"伪数据论断" · 返违规清单
// 设计:这些 pattern 100% 需要数据才能说 · git 里没数据 = LLM 在编
// v2 修正了两处假阳性:
//   - "比之前" "比过去" 是合理设计观察 · 不挡
//   - 单独 % 是合理进度数 (完成度 70% 之类) · 不挡 · 只挡靠近效果性动词的
function validateDraft(text) {
  if (!text) return [];
  const violations = [];

  // 用户反应类 (没问过用户)
  if (/用户\s*(更|不)?\s*(喜欢|偏好|反映|说|觉得|想要|认为)/.test(text)) {
    violations.push('"用户喜欢/反映/觉得 X" — 没问过用户');
  }

  // 跟"真人 / 人工 / 手动" 做对比类 · 这三个真的需要 benchmark
  // 把"之前 / 过去 / 普通 / 原来" 去掉 · 那些是合理设计观察 ("比之前简化了")
  if (/(比|超过|远胜|低于|高于|不如)\s*(真人|人工|手动)/.test(text)) {
    violations.push('"X 比 Y 好/差" 对比 — 没 benchmark');
  }

  // 跑下来 / 测下来 / 对比下来 (隐含实验)
  if (/(实际|真实|真)\s*(跑|测|对比|跟|看)\s*(下来|过|完)/.test(text)) {
    violations.push('"实际跑/测下来" — 没数据');
  }

  // 命中率 / 准确率 这类必须有数字的
  if (/(成功率|准确率|命中率|转化率|留存率|完成率|响应率)/.test(text)) {
    violations.push('"成功率/准确率" — 没指标');
  }

  // 效果性数字 · 只挡靠近评估动词的 %
  // 命中条件:前 8 字 / 后 8 字内有效果词 · 单独的 "完成度 70%" 不挡
  const EFFECT_WORDS = '快|慢|提升|降低|减少|增加|多|少|增长|下降|上升';
  const effectPctRe = new RegExp(`(${EFFECT_WORDS})\\s*了?\\s*\\d+\\s*%|\\d+\\s*%\\s*(${EFFECT_WORDS})`, 'g');
  if (effectPctRe.test(text)) {
    violations.push('"X 了 Y%" — 效果论断没 benchmark');
  }
  // 单独 % 不再挡 · "完成度 70%" / "10% 改了 a 文件" 之类是合理的

  // 结果发现 / 出乎意料 / 数据显示 (经典 LLM 收尾)
  if (/结果发现|出乎意料|数据显示|意外发现/.test(text)) {
    violations.push('"结果发现/出乎意料/数据显示" — 这种事后观察 LLM 不该写');
  }

  return violations;
}

// === LLM token 用量记录 (给 tinker goodnight / config 用) ===
const LLM_USAGE_FILE = path.join(CONFIG_DIR, 'llm-usage.json');
function recordLLMUsage(provider, tokens, kind) {
  if (!tokens) return;
  try {
    let history = [];
    try { history = JSON.parse(fs.readFileSync(LLM_USAGE_FILE, 'utf-8')); } catch {}
    if (!Array.isArray(history)) history = [];
    history.push({ at: Date.now(), provider, tokens, kind: kind || 'unknown' });
    // 只保留最近 1000 条 · 防止文件越来越大
    if (history.length > 1000) history = history.slice(-1000);
    fs.writeFileSync(LLM_USAGE_FILE, JSON.stringify(history, null, 2));
  } catch {}
}
function getTodayLLMUsage() {
  try {
    const history = JSON.parse(fs.readFileSync(LLM_USAGE_FILE, 'utf-8'));
    if (!Array.isArray(history)) return [];
    const tk = todayKey();
    return history.filter(h => {
      const d = new Date(h.at);
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') === tk;
    });
  } catch { return []; }
}

// 草稿后处理 · 抹掉最常见的 LLM tell
// 设计原则:只动那些 99% 是 AI 写作 tell 的东西 (em-dash · 堆中圆点 · "今天" 开头)
// 不动正常的中文标点 · 不擅自重写句子
function sanitizeDraft(text) {
  if (!text) return null;
  let t = text.trim();

  // em-dash 几乎全是 AI tell · 转成逗号
  t = t.replace(/——+/g, '，');
  t = t.replace(/[­‐‑‒–—―]+/g, '，');

  // 句中堆 · 的兜底:正文里超过 2 次 · 间隔分隔的全换成逗号
  const midDotCount = (t.match(/(?<=[^\s])·(?=[^\s])/g) || []).length;
  if (midDotCount > 2) {
    t = t.replace(/(?<=[^\s])·(?=[^\s])/g, '，');
  }

  // "今天 / 最近 / 这段时间" 开头是 LLM 戒不掉的习惯 · 平台已显示时间 · 直接砍
  // 砍掉之后首字母不强求大写 · 中文不需要
  t = t.replace(/^\s*(今天|最近|这段时间|这几天|昨天|这两天)\s*[，,。\s]+\s*/, '');

  // 多个连续标点折叠
  t = t.replace(/，{2,}/g, '，');
  t = t.replace(/。{2,}/g, '。');

  // trim 末尾的标点
  t = t.replace(/[，、；]\s*$/, '。');

  return t.trim();
}

// =============================================
// commands
// =============================================
async function cmdLogin(opts = {}) {
  // v0.35 非交互模式 · --server + --token 给齐就跳过 prompt 直接配
  // 给"复制 AI 指令一键安装"那条体验跑通用 · 用户把 webapp 上的指令粘给 AI · AI 直接跑这条命令
  // LLM 配置不在这里 · 留给 tinker llm set 走 (token 链路跟 LLM 链路分开 · 各自单一职责)
  if (opts.server && opts.token) {
    const token = String(opts.token).trim();
    if (!/^tk_/.test(token)) {
      err('钥匙格式不对 · 应该以 tk_ 开头');
      process.exit(1);
    }
    const cfg = { serverUrl: String(opts.server).replace(/\/$/, ''), token };
    log(sepia('  验证钥匙...'));
    try {
      const me = await apiMe(cfg);
      if (!me) throw new Error('钥匙没认到任何账号');
      cfg.handle = me.handle;
      cfg.userId = me.id;
    } catch (e) {
      err('钥匙无效: ' + (e.message || ''));
      process.exit(1);
    }
    saveConfig(cfg);
    ok('登录成功 — ' + bold('@' + cfg.handle));
    log(sepia('  配置: ') + CONFIG_FILE);
    log(sepia('  下一步: ') + vermilion('tinker recent --limit 3') + sepia(' 验证看你最近的 update'));
    log(sepia('  想要 AI 自动起草? ') + vermilion('tinker llm set') + sepia(' 配 LLM key'));
    return;
  }

  const { input, select, password } = promptKit();
  log(vermilion('\n  tinker login') + sepia('   · 一次性配置'));
  log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━'));
  const serverUrl = await input({
    message: 'server URL',
    default: 'https://daogu.cc',
  });
  log('');
  log(sepia('  到 ' + vermilion(serverUrl.replace(/\/$/, '') + '/#/w/<你的handle>') + sepia(' · 点 "CLI 钥匙" 生成一把')));
  log(sepia('  钥匙以 ' + vermilion('tk_') + sepia(' 开头 · 只显示一次 · 错过就重新生成') + '\n'));
  const token = await password({
    message: '粘贴钥匙(以 tk_ 开头)',
    validate: (v) => /^tk_/.test(v.trim()) || '钥匙应该以 tk_ 开头',
  });
  const cfg = { serverUrl: serverUrl.replace(/\/$/, ''), token: token.trim() };
  // 校验:用这把钥匙读一下 /me · 看是谁
  log(sepia('  ' + dim('验证钥匙...')));
  try {
    const me = await apiMe(cfg);
    if (!me) throw new Error('钥匙没认到任何账号');
    cfg.handle = me.handle;
    cfg.userId = me.id;
    ok('认到了 — ' + bold('@' + me.handle));
  } catch (e) {
    err('钥匙无效:' + (e.message || ''));
    process.exit(1);
  }

  // 可选: LLM
  const wantLLM = await select({
    message: '配置 LLM? (用于 tinker draft)',
    choices: [
      { name: '先不配 · 之后再说', value: false },
      { name: '配一下', value: true },
    ],
    default: false,
  });

  if (wantLLM) {
    const provider = await select({
      message: 'LLM provider',
      choices: [
        { name: 'Anthropic Claude (推荐 · 跟产品哲学一致)', value: 'anthropic' },
        { name: 'OpenAI GPT', value: 'openai' },
        { name: 'DeepSeek (国内友好)', value: 'deepseek' },
      ],
      default: 'anthropic',
    });
    const apiKey = await password({
      message: 'LLM API key',
      validate: (v) => v.trim().length > 0 || '不能空',
    });
    cfg.llm = { provider, apiKey: apiKey.trim() };
  }

  saveConfig(cfg);
  ok('配置保存到 ' + sepia(CONFIG_FILE));
  log('');
  log(sepia('  下一步: ') + vermilion('tinker onboard') + sepia(' 一站式配齐 (项目 / git hook / claude hook / CLAUDE.md)'));
  log('');
}

// =====================================================
// v0.51 onboard · 新用户装好 CLI + login 之后一站式配齐
// 串起: 配置检查 → repo 关联 Tinker 项目 → git hook → claude hook → 当前 repo CLAUDE.md
// CLAUDE.md 是 Tinker 协作的真正大脑 · 没这份 hook 注入 reminder 也没人响应
// =====================================================
async function cmdOnboard(opts = {}) {
  const cfg = loadConfig();
  if (!cfg || !cfg.token || !cfg.handle) {
    err('还没登录 · 先跑 tinker login --server <url> --token tk_xxx');
    log(sepia('  或者交互式: ') + vermilion('tinker login'));
    process.exit(1);
  }

  log('');
  log(vermilion('  tinker onboard') + sepia(' · 一站式配齐 Tinker 协作环境'));
  log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  log('');

  // [1/5] 登录
  log(bold('  [1/5]') + ' 登录');
  ok('  已登录 @' + cfg.handle + sepia(' · server: ') + cfg.serverUrl);
  log('');

  // [2/5] 当前 repo 是否关联 Tinker 项目
  log(bold('  [2/5]') + ' 当前 repo 关联 Tinker 项目');
  const isRepo = inGitRepo();
  let repoCfg = null;
  if (!isRepo) {
    log(sepia('  当前目录不是 git 仓库 · 跳过 repo 关联跟 git hook · 后面只装 claude hook + CLAUDE.md'));
    log('');
  } else {
    repoCfg = loadRepoConfig();
    if (repoCfg) {
      ok('  已关联: ' + bold(repoCfg.projectName));
    } else {
      const state = await apiState(cfg);
      const mine = (state.projects || []).filter(p => p.owner === cfg.handle);
      const { select, input } = promptKit();

      let projectIdToBind = null;
      let projectName = null;
      if (mine.length === 0) {
        log(sepia('  你在 Tinker 还没建过项目 · 现在建一个吧'));
        const name = await input({ message: '项目名 (中文/英文都行)', validate: v => v.trim().length > 0 || '不能空' });
        const desc = await input({ message: '一句话说做啥', validate: v => v.trim().length > 0 || '不能空' });
        const r = await apiAction(cfg, 'addProject', { name: name.trim(), desc: desc.trim(), productLink: '', tools: [] });
        const newProj = r && r.result;
        if (!newProj || !newProj.id) { err('建项目失败'); process.exit(1); }
        projectIdToBind = newProj.id;
        projectName = newProj.name;
      } else {
        const choices = mine.map(p => ({ name: p.name + sepia('  ' + (p.desc || '').slice(0, 40)), value: p.id }));
        choices.push({ name: sepia('+ 建一个新项目'), value: '__new__' });
        const picked = await select({ message: '这个 repo 对应哪个 Tinker 项目?', choices });
        if (picked === '__new__') {
          const name = await input({ message: '项目名', validate: v => v.trim().length > 0 || '不能空' });
          const desc = await input({ message: '一句话说做啥', validate: v => v.trim().length > 0 || '不能空' });
          const r = await apiAction(cfg, 'addProject', { name: name.trim(), desc: desc.trim(), productLink: '', tools: [] });
          const newProj = r && r.result;
          if (!newProj || !newProj.id) { err('建项目失败'); process.exit(1); }
          projectIdToBind = newProj.id;
          projectName = newProj.name;
        } else {
          const p = mine.find(x => x.id === picked);
          projectIdToBind = p.id;
          projectName = p.name;
        }
      }
      repoCfg = { projectId: projectIdToBind, projectName, installedAt: Date.now() };
      saveRepoConfig(repoCfg);
      registerRepoForDrift(process.cwd(), repoCfg);
      ok('  绑定: ' + bold(projectName));
    }
    log('');

    // [3/5] git hooks
    log(bold('  [3/5]') + ' git hooks (post-commit / post-push / post-checkout)');
    try {
      const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim();
      installSingleGitHook(gitDir, 'post-commit', HOOK_BLOCK);
      installSingleGitHook(gitDir, 'post-push', POST_PUSH_BLOCK);
      installSingleGitHook(gitDir, 'post-checkout', POST_CHECKOUT_BLOCK);
      ok('  三件套装好 · commit 后跑触发器评估');
    } catch (e) {
      err('  装 git hook 失败: ' + e.message);
    }
    log('');
  }

  // [4/5] Claude Code hooks
  log(bold('  [4/5]') + ' Claude Code hooks');
  try {
    await cmdClaudeHookInstall({ clean: true });
  } catch (e) {
    err('  装 claude hook 失败: ' + e.message);
  }

  // [5/5] CLAUDE.md
  log(bold('  [5/5]') + ' CLAUDE.md (告诉 AI 看到 reminder 怎么响应)');
  const claudeMdPath = path.join(process.cwd(), 'CLAUDE.md');
  const tmpl = require('../lib/claude-md-template');
  const wantReplace = !!opts.update;
  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf-8');
    if (existing.includes(tmpl.BEGIN_MARKER)) {
      // 替换已有 Tinker 段
      const escapedBegin = tmpl.BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedEnd = tmpl.END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escapedBegin + '[\\s\\S]*?' + escapedEnd, 'g');
      const newContent = existing.replace(re, tmpl.TEMPLATE.trim());
      fs.writeFileSync(claudeMdPath, newContent);
      ok('  已刷新 CLAUDE.md 里的 Tinker 段 (BEGIN/END 之间)');
    } else if (wantReplace) {
      // --update 但没有 BEGIN/END 标记 · 不动用户已有内容 · append 到末尾
      const newContent = existing.trimEnd() + '\n\n' + tmpl.TEMPLATE;
      fs.writeFileSync(claudeMdPath, newContent);
      ok('  追加 Tinker 协作约定段到 CLAUDE.md 末尾');
    } else {
      log(sepia('  CLAUDE.md 已存在 · 没找到 Tinker 标记块 · 追加到末尾'));
      const newContent = existing.trimEnd() + '\n\n' + tmpl.TEMPLATE;
      fs.writeFileSync(claudeMdPath, newContent);
      ok('  追加完成');
    }
  } else {
    fs.writeFileSync(claudeMdPath, tmpl.TEMPLATE);
    ok('  建了 ' + sepia(claudeMdPath));
  }
  log('');

  log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  log('');
  ok('Tinker 协作环境配齐了');
  log('');
  log(sepia('  试一下:'));
  log('    ' + vermilion('tinker push -m "今天装好了 tinker"') + sepia('  · 发第一条进展'));
  log('    ' + vermilion('tinker --help') + sepia('                       · 看全命令'));
  log('    ' + vermilion('tinker borrow "<关键词>"') + sepia('             · 搜方法库'));
  log('');
  log(sepia('  以后想刷新 CLAUDE.md 里的 Tinker 段: ') + vermilion('tinker onboard --update'));
  log('');
}

// v0.14 skills · 把 Tinker 协作知识拆成一域一个 Claude Code Skill · 按场景自动加载
// 比一整块 CLAUDE.md 省 context · AI 只在相关场景才读对应技能
// 源文件在 cli/skills/<name>/SKILL.md · 这里读出来拷进目标 skills 目录
const SKILLS_SRC_DIR = path.join(__dirname, '..', 'skills');

// 技能归类 · 跟 help 的个人/团队分栏一个心智
// 团队技能只在工作室场景才被 AI 加载 (靠 description 里的场景词自动 gate)
const SKILL_TEAM = new Set(['tinker-collab', 'feishu-project-runner']);
const SKILL_COMMON = new Set(['tinker', 'tinker-triggers']);
function skillCategory(name) {
  if (SKILL_TEAM.has(name)) return '团队';
  if (SKILL_COMMON.has(name)) return '通用';
  return '个人';
}

function readSkillSources() {
  if (!fs.existsSync(SKILLS_SRC_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(SKILLS_SRC_DIR).sort()) {
    const skillFile = path.join(SKILLS_SRC_DIR, name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const body = fs.readFileSync(skillFile, 'utf-8');
    // 抓 frontmatter 里的 description 一行 · 只为列表展示 · 不做严格 yaml 解析
    const m = body.match(/^description:\s*(.+)$/m);
    out.push({ name, body, description: m ? m[1].trim() : '' });
  }
  return out;
}

async function cmdSkills(sub, opts = {}) {
  const skills = readSkillSources();
  // flag 开头的不算 subcommand (tinker skills --json 等价于 tinker skills list --json)
  if (sub && sub.startsWith('--')) sub = null;

  // 默认列表 · tinker skills · 按 个人/团队 分组 (跟 help 一个心智)
  if (!sub || sub === 'list') {
    if (opts.json) { log(JSON.stringify({ ok: true, skills: skills.map(s => ({ name: s.name, description: s.description, category: skillCategory(s.name) })) })); return; }
    if (skills.length === 0) { err('没找到 skill 源文件 (' + SKILLS_SRC_DIR + ')'); return; }
    log('');
    log(vermilion('  Tinker Skills') + sepia(' · 一域一个 · 装进 AI 后按场景自动加载'));
    log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    const groups = [
      ['通用', '通用'],
      ['个人', '个人'],
      ['团队', '团队 (工作室协作)'],
    ];
    for (const [cat, label] of groups) {
      const inCat = skills.filter(s => skillCategory(s.name) === cat);
      if (inCat.length === 0) continue;
      log('');
      log(sepia('  ') + bold(label));
      for (const s of inCat) {
        log('  ' + bold(s.name));
        log(sepia('    ' + (s.description || '').slice(0, 90)));
      }
    }
    log('');
    log(sepia('  装进本机所有项目: ') + vermilion('tinker skills install'));
    log(sepia('  只装当前 repo:   ') + vermilion('tinker skills install --local'));
    log(sepia('  Codex 选装飞书:  ') + vermilion('tinker skills install --agent codex --only feishu-project-runner'));
    log('');
    return;
  }

  if (sub === 'install') {
    if (skills.length === 0) { err('没找到 skill 源文件 (' + SKILLS_SRC_DIR + ')'); process.exit(1); }
    const agent = opts.agent === undefined ? 'claude' : opts.agent;
    if (!['claude', 'codex'].includes(agent)) { err('--agent 必须是 claude 或 codex'); process.exit(1); }
    const selected = opts.only === undefined ? skills : skills.filter(s => s.name === opts.only);
    if (selected.length === 0) { err('未知 skill: ' + opts.only); process.exit(1); }
    let result;
    try {
      result = require('../lib/skills').installSkills(SKILLS_SRC_DIR, selected.map(s => s.name),
        opts.local ? process.cwd() : os.homedir(), agent);
    } catch (error) {
      err('安装 skill 失败: ' + error.message); process.exit(1);
    }
    const { baseDir, backups } = result;
    const written = selected.map(s => s.name);
    if (opts.json) { log(JSON.stringify({ ok: true, installed: written, dir: baseDir, agent, backups })); return; }
    log('');
    ok('装好 ' + written.length + ' 个 Tinker skill');
    log(sepia('  位置: ') + baseDir);
    for (const n of written) log(sepia('    · ') + n);
    for (const b of backups) log(sepia('  原版本已备份: ') + b.path);
    log('');
    log(sepia('  ' + (opts.local ? '只对当前 repo 生效' : '本机所有项目生效') + ' · 下次起 AI session 自动能按场景加载'));
    log('');
    return;
  }

  err('用法: tinker skills [list] | tinker skills install [--agent claude|codex] [--only <name>] [--local]');
  process.exit(1);
}

async function cmdConfig(opts = {}) {
  const cfg = loadConfig();
  if (opts.json) {
    if (!cfg) { errJson('还没配置 · 先跑 tinker login', 'NO_CONFIG'); return; }
    outputJson({
      ok: true,
      serverUrl: cfg.serverUrl,
      handle: cfg.handle || null,
      tokenSet: !!cfg.token,
      tokenSuffix: cfg.token ? cfg.token.slice(-4) : null,
      llm: cfg.llm ? { provider: cfg.llm.provider, configured: true } : { configured: false },
      screenshot: (() => { const s = getShotConfig(cfg); return { provider: s.provider, keySet: !!s.apiKey }; })(),
      configFile: CONFIG_FILE,
    });
    return;
  }
  if (!cfg) { err('还没配置 · 先跑 ' + vermilion('tinker login')); process.exit(1); }
  log(sepia('\n  current config:'));
  log('    server     ' + bold(cfg.serverUrl));
  log('    handle     ' + bold('@' + (cfg.handle || '(未知 · 没填)')));
  log('    token      ' + (cfg.token ? bold('tk_…' + cfg.token.slice(-4)) : sepia('(未配置)')));
  if (cfg.llm) {
    log('    llm        ' + bold(cfg.llm.provider) + sepia(' (key: ****' + cfg.llm.apiKey.slice(-4) + ')'));
  } else {
    log('    llm        ' + sepia('(未配置)'));
  }
  const shot = getShotConfig(cfg);
  log('    screenshot ' + bold(shot.provider) + (shot.apiKey ? sepia(' (key: ****' + shot.apiKey.slice(-4) + ')') : sepia(' (免费档 · 无 key)')));
  log(sepia('    file       ' + CONFIG_FILE));
  // 警告区
  const warnings = [];
  if (!cfg.token) warnings.push('钥匙没配 · v0.1 alpha 时代的旧 config · 跑 ' + vermilion('tinker login') + sepia(' 配新钥匙'));
  if (cfg.serverUrl && /ngrok/.test(cfg.serverUrl)) warnings.push('server 还是 ngrok 临时地址 · 大概率已经死了 · 跑 ' + vermilion('tinker login') + sepia(' 换成生产地址'));
  if (warnings.length > 0) {
    log('');
    log(sepia('  ⚠ 注意:'));
    warnings.forEach(w => log(sepia('    · ' + w)));
  }
  log('');
}

// tinker screenshot                 看当前截图后端
// tinker screenshot <provider> <key> 设置 (apiflash / screenshotone)
// tinker screenshot microlink        退回免费档 (清掉 key)
// tinker screenshot test             用当前后端抓一张 prod 试试 · 验 key 通不通
async function cmdScreenshotConfig(opts = {}) {
  const cfg = loadConfig();
  if (!cfg) { err('还没配置 · 先跑 ' + vermilion('tinker login')); process.exit(1); }
  const pos = opts.positional || [];
  const sub = pos[0];

  if (!sub) {
    const { provider, apiKey } = getShotConfig(cfg);
    log(sepia('\n  截图后端:'));
    log('    provider   ' + bold(provider));
    log('    key        ' + (apiKey ? bold('****' + apiKey.slice(-4)) : sepia('(无 · microlink 免费档不要 key)')));
    log(sepia('\n  换后端: ') + vermilion('tinker screenshot apiflash <KEY>') + sepia(' 或 ') + vermilion('tinker screenshot screenshotone <KEY>'));
    log(sepia('  退免费: ') + vermilion('tinker screenshot microlink'));
    log(sepia('  测一张: ') + vermilion('tinker screenshot test') + '\n');
    return;
  }

  if (sub === 'test') {
    const { provider } = getShotConfig(cfg);
    const tmp = path.join(CONFIG_DIR, 'snapshots', 'test-' + Date.now() + '.jpg');
    try { fs.mkdirSync(path.dirname(tmp), { recursive: true }); } catch {}
    log(sepia('\n  用 ') + bold(provider) + sepia(' 抓一张 ') + cfg.serverUrl + sepia(' ...'));
    const okShot = captureScreenshotToFile(cfg, cfg.serverUrl, tmp);
    if (okShot) {
      const kb = Math.round(fs.statSync(tmp).size / 1024);
      try { fs.unlinkSync(tmp); } catch {}
      ok('截图成功 · ' + kb + 'KB · 后端通了');
    } else {
      err('截图失败 · key 不对 / 配额用完 / 死链都可能 · 跑 tinker screenshot 看当前配置');
    }
    return;
  }

  const provider = sub;
  if (!['apiflash', 'screenshotone', 'microlink'].includes(provider)) {
    err('provider 只支持: apiflash / screenshotone / microlink');
    process.exit(1);
  }
  cfg.screenshot = cfg.screenshot || {};
  cfg.screenshot.provider = provider;
  if (provider === 'microlink') {
    delete cfg.screenshot.apiKey;
  } else {
    const key = pos[1] || opts.token;
    if (!key) { err('要给 key · 例: tinker screenshot ' + provider + ' <KEY>'); process.exit(1); }
    cfg.screenshot.apiKey = key;
  }
  saveConfig(cfg);
  ok('截图后端 → ' + bold(provider) + (provider === 'microlink' ? sepia(' (免费档)') : sepia(' (key ****' + cfg.screenshot.apiKey.slice(-4) + ')')));
  log(sepia('  验一下: ') + vermilion('tinker screenshot test') + '\n');
}

async function cmdProjects(opts = {}) {
  const cfg = mustHaveConfig();
  const state = await apiState(cfg);
  const me = cfg.handle;
  const mine = state.projects.filter(p => p.owner === me);

  if (opts.json) {
    outputJson({
      ok: true,
      handle: me,
      projects: mine.map(p => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        desc: p.desc,
        status: p.status,
        productLink: p.productLink || null,
        updateCount: (p.updates || []).length,
        lastUpdateAt: p.updates && p.updates[0] ? p.updates[0].at : null,
        shippedAt: p.shippedAt || null,
        hiddenFromShowcase: !!p.hiddenFromShowcase,
        url: cfg.serverUrl + '/#/p/' + me + '/' + p.slug,
      })),
    });
    return;
  }

  if (mine.length === 0) {
    log(sepia('\n  你还没有项目 · 去 ' + cfg.serverUrl + ' 开张工作室\n'));
    return;
  }
  log('');
  mine.forEach(p => {
    const status = p.status === 'active' ? moss('● 在做')
                 : p.status === 'stuck' ? vermilion('● 卡住')
                 : p.status === 'live' ? moss('✦ 上线 (持续打磨)')
                 : p.status === 'done' ? sepia('◯ 停手')
                 : p.status === 'archive' ? sepia('▪ 归档')
                 : sepia('● ' + p.status);
    log('  ' + bold(p.name) + '  ' + status);
    log('  ' + sepia(p.desc));
    log('  ' + sepia('  id: ' + p.id + ' · ' + p.updates.length + ' 条进展\n'));
  });
}

async function cmdDraft(opts) {
  const cfg = mustHaveConfig();
  const since = opts.since || '1h';
  if (!inGitRepo()) {
    err('不在 git 仓库 · draft 需要 git 历史作为上下文');
    process.exit(1);
  }
  const history = gitHistorySince(since);
  if (!history || (!history.log && !history.pendingStat)) {
    err('git 历史是空的 · 这段时间没 commit 也没改动');
    process.exit(1);
  }
  log(sepia('\n  分析 git 历史 (since ' + history.since + ')...'));
  if (history.log) log(sepia('  ' + history.log.split('\n').slice(0, 5).join('\n  ')));
  if (history.pendingStat) log(sepia('  pending: ' + history.pendingStat));
  log('');
  log(sepia('  起草中(走 ' + (cfg.llm?.provider || 'anthropic') + ')...'));
  let candidates;
  try {
    candidates = await llmDraft(cfg, history);
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
  if (candidates.length === 0) {
    log('');
    log(sepia('  这段时间 LLM 觉得没什么值得发的。等下次有真东西再来。'));
    log('');
    return;
  }

  // 写到 .tinker/drafts/YYYY-MM-DD-HHMM.md
  const draftsDir = path.join(process.cwd(), '.tinker', 'drafts');
  if (!fs.existsSync(draftsDir)) fs.mkdirSync(draftsDir, { recursive: true });
  const now = new Date();
  const stamp = now.getFullYear() + '-' +
    String(now.getMonth()+1).padStart(2,'0') + '-' +
    String(now.getDate()).padStart(2,'0') + '-' +
    String(now.getHours()).padStart(2,'0') +
    String(now.getMinutes()).padStart(2,'0');
  const draftFile = path.join(draftsDir, stamp + '.md');

  // v0.4 bug 修复:cmdDraft 之前漏调 sanitize · LLM 的 em-dash 等 tell 没被清掉
  candidates.forEach(c => { if (c && c.text) c.text = sanitizeDraft(c.text); });
  const md = renderDraftMarkdown({
    candidates, since: history.since, commits: (history.log||'').split('\n').filter(Boolean).length, handle: cfg.handle,
  });
  fs.writeFileSync(draftFile, md);

  // v0.4 Phase 4 · 记最新 LLM 草稿 · 让 cmdResolve 跟用户改后版本比较 · 收集 reject-diff
  try {
    const lastDraft = {
      at: Date.now(),
      text: (candidates[0] && candidates[0].text) || '',
      projectId: null,  // 跨命令不一定知道 projectId · cmdResolve 凭 pending 判断
      since: history.since,
    };
    fs.writeFileSync(path.join(CONFIG_DIR, 'last-llm-draft.json'), JSON.stringify(lastDraft, null, 2));
  } catch {}

  log('');
  ok('起草了 ' + bold(candidates.length + '') + ' 条候选 → ' + sepia(path.relative(process.cwd(), draftFile)));
  log('');
  candidates.forEach((c, i) => {
    log(vermilion('  候选 ' + (i+1)));
    const preview = (c.text || '').replace(/\n/g,' ').slice(0, 80);
    log('    ' + preview + (c.text.length > 80 ? '…' : ''));
    log(sepia('    自评: ') + sepia(c.rationale || ''));
    log('');
  });
  log(sepia('  下一步:'));
  log(sepia('    1) 打开 ') + bold(path.relative(process.cwd(), draftFile)) + sepia(' · 删掉不想发的段落'));
  log(sepia('    2) ') + vermilion('tinker push ' + path.relative(process.cwd(), draftFile)));
  log('');
}

function renderDraftMarkdown({ candidates, since, commits, handle }) {
  const lines = [];
  lines.push('# Tinker 草稿 · @' + (handle || '') + ' · ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  lines.push('');
  lines.push('— 时间窗 since `' + since + '` · 包含 ' + commits + ' 个 commit');
  lines.push('— 删掉不想发的整个候选段落(从 `## 候选 N` 到下一个 `---`)·然后跑 `tinker push <这个文件>`');
  lines.push('— 自评行 (以 `> 自评:` 开头) 不会被发到 Tinker · 是给你筛选用的');
  lines.push('');
  lines.push('---');
  lines.push('');
  candidates.forEach((c, i) => {
    lines.push('## 候选 ' + (i+1));
    lines.push('');
    lines.push((c.text || '').trim());
    lines.push('');
    lines.push('> 自评: ' + (c.rationale || ''));
    lines.push('');
    lines.push('---');
    lines.push('');
  });
  return lines.join('\n');
}

function parseDraftMarkdown(md) {
  // 切割 ## 候选 N 段 · 提取每段的 text(去掉自评行)
  const candidates = [];
  const sections = md.split(/^##\s+候选\s+\d+\s*$/m).slice(1);  // 第一个是 header 前的内容
  for (const sec of sections) {
    // 砍到 --- 之前 · 去掉 > 自评: 行
    const upToHr = sec.split(/^---\s*$/m)[0];
    const noEval = upToHr.replace(/^>\s*自评:.*$/gm, '').trim();
    if (noEval) candidates.push({ text: noEval });
  }
  return candidates;
}

async function cmdPush(opts) {
  const cfg = mustHaveConfig();

  // 如果传了文件路径 · 走"从草稿发"路径
  if (opts.draftFile) {
    return cmdPushFromDraft(cfg, opts);
  }

  const state = await apiState(cfg);
  const me = cfg.handle;
  const mine = state.projects.filter(p => p.owner === me && ['active', 'stuck', 'live'].includes(p.status));
  if (mine.length === 0) {
    err('你没有 active/stuck 的项目 · 去 ' + cfg.serverUrl + ' 开一个');
    process.exit(1);
  }

  // 选项目
  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (mine.length === 1) {
    projectId = mine[0].id;
    log(sepia('  自动选了唯一一个项目: ') + bold(mine[0].name));
  } else {
    const { select } = promptKit();
    projectId = await select({
      message: '推到哪个项目?',
      choices: mine.map(p => ({
        name: p.name + sepia('  ' + p.desc.slice(0, 40)),
        value: p.id,
      })),
    });
  }

  let pushText = opts.text;
  if (!pushText) {
    const { input } = promptKit();
    const suggestion = gitOneCommit();
    pushText = await input({ message: '一句进展', default: suggestion || undefined });
  }
  pushText = (pushText || '').trim();
  if (!pushText) { err('内容不能空'); process.exit(1); }

  // v0.14 dry-run · 只回显会发什么 (含 voice 打分) · 不真发 · AI 代发前预览
  if (opts.dryRun) {
    const p = mine.find(x => x.id === projectId);
    const vc = require('../lib/voice-check').detectAIVoice(pushText);
    const gateHint = vc.score >= 3 ? '会被强拒(需 --force)' : vc.score === 2 ? 'TTY 会弹确认' : '通过';
    if (opts.json) { outputJson({ ok: true, dryRun: true, action: 'push', projectId, project: p && p.name, text: pushText, voiceScore: vc.score, voiceGate: gateHint }); return; }
    log('');
    log(sepia('  dry-run · 不会发送'));
    log('  项目:      ' + bold((p && p.name) || projectId));
    log('  内容:      ' + pushText);
    log('  voice 守门: ' + (vc.score >= 2 ? bold('score ' + vc.score) : 'score ' + vc.score) + sepia(' · ' + gateHint) + (vc.list && vc.list.length ? sepia(' (' + vc.list.join('/') + ')') : ''));
    log('');
    return;
  }

  // v0.20 voice 守门 · 防裸奔 AI 直出 (尤其 -m 直接 push 没经 draft 的)
  const gate = await gateVoiceCheck(pushText, opts);
  if (!gate.ok) process.exit(1);

  // 推 · server 从 token 拿身份 · 不需要 currentUser
  // v0.11 idempotency: --idem-key X 时 · 同 key 24h 内重复调直接返缓存
  try {
    const result = await withIdempotency(opts.idemKey, async () => {
      const r = await apiAction(cfg, 'addUpdate', { projectId, text: pushText });
      recordPushAt(projectId);
      return r;
    });
    const p = mine.find(x => x.id === projectId);
    log('');
    if (result && result.cacheHit) {
      ok('已 push (幂等命中 · 同 key 之前发过)');
    } else {
      ok('记上了 — ' + bold(p.name));
    }
    log(sepia('  内容: ') + pushText);
    // v0.12: 用 server 返的 projectSlug + ownerHandle 拼项目页 URL
    // (webapp hash routing 不支持从 URL 传 anchor · 但项目页打开最新 update 就在顶)
    const slug = (result && result.projectSlug) || p.slug;
    const handle = (result && result.ownerHandle) || cfg.handle;
    if (slug && handle) {
      log(sepia('  去看: ') + cfg.serverUrl + '/#/p/' + handle + '/' + slug);
    } else {
      log(sepia('  去看: ') + cfg.serverUrl + '/');
    }
    if (result && result.id) {
      log(sepia('  update id: ') + result.id);
    }
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

// 从草稿文件发布 · tinker push <file> [--only=1,3]
async function cmdPushFromDraft(cfg, opts) {
  const file = opts.draftFile;
  if (!fs.existsSync(file)) { err('找不到草稿:' + file); process.exit(1); }
  const md = fs.readFileSync(file, 'utf-8');

  // v0.13 检测 autopsy 草稿 · 支持 experience / learning / decision 三种 productTag
  // autopsy 草稿是单一 markdown · 没 "## 候选 N" 切割 · 整篇当 text
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  let productTag = null;
  if (opts.asExperience) productTag = 'experience';
  else if (opts.asLearning) productTag = 'learning';
  else if (opts.asDecision) productTag = 'decision';
  else if (fmMatch) {
    if (/as_experience:\s*true/i.test(fmMatch[1])) productTag = 'experience';
    else if (/as_learning:\s*true/i.test(fmMatch[1])) productTag = 'learning';
    else if (/as_decision:\s*true/i.test(fmMatch[1])) productTag = 'decision';
  }
  if (productTag) {
    return cmdPushExperienceDraft(cfg, opts, fmMatch ? fmMatch[2].trim() : md.trim(), productTag);
  }

  const candidates = parseDraftMarkdown(md);
  if (candidates.length === 0) {
    err('草稿里没有候选(可能都被删了)');
    process.exit(1);
  }
  // 解析 --only=1,3
  let selected = candidates.map((_, i) => i);
  if (opts.only) {
    const want = new Set(opts.only.split(',').map(x => parseInt(x.trim(), 10) - 1));
    selected = selected.filter(i => want.has(i));
  }
  if (selected.length === 0) { err('--only 选了空集合 · 没东西可发'); process.exit(1); }

  log(sepia('\n  从草稿发布 · 选中 ' + selected.length + ' 条 / 共 ' + candidates.length + ' 条候选'));

  // 拿项目列表 · 让用户选
  const state = await apiState(cfg);
  const me = cfg.handle;
  const mine = state.projects.filter(p => p.owner === me && ['active', 'stuck', 'live'].includes(p.status));
  if (mine.length === 0) { err('你没有 active/stuck 的项目'); process.exit(1); }

  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (mine.length === 1) {
    projectId = mine[0].id;
    log(sepia('  自动选了唯一一个项目: ') + bold(mine[0].name));
  } else {
    const { select } = promptKit();
    projectId = await select({
      message: '发到哪个项目?',
      choices: mine.map(p => ({
        name: p.name + sepia('  ' + p.desc.slice(0, 40)),
        value: p.id,
      })),
    });
  }

  // 确认
  const p = mine.find(x => x.id === projectId);
  log('');
  selected.forEach(i => {
    log(vermilion('  候选 ' + (i+1)));
    const preview = candidates[i].text.replace(/\n/g, ' ').slice(0, 80);
    log('    ' + preview + (candidates[i].text.length > 80 ? '…' : ''));
  });
  log('');
  // --yes 跳过确认 (跟 experience 草稿路径一致 · 给 AI / 非交互场景用)
  if (!opts.yes) {
    const { confirm } = promptKit();
    const yes = await confirm({ message: '发到「' + p.name + '」?', default: true });
    if (!yes) { log(sepia('  取消了')); return; }
  }

  let posted = 0;
  for (const i of selected) {
    try {
      // v0.20 voice 守门 · 草稿也要过 · 因为 LLM 起草后用户可能没改就发
      const gate = await gateVoiceCheck(candidates[i].text, opts);
      if (!gate.ok) { log(C.red + '  ✗ ' + C.reset + sepia('候选 ' + (i+1) + ' 被 voice 守门拦了 · 加 --force 强发')); continue; }
      await apiAction(cfg, 'addUpdate', { projectId, text: candidates[i].text });
      recordPushAt(projectId);
      posted++;
      log(moss('  ✓ ') + sepia('候选 ' + (i+1) + ' 发了'));
    } catch (e) {
      log(C.red + '  ✗ ' + C.reset + sepia('候选 ' + (i+1) + ' 失败: ' + e.message));
    }
  }
  log('');
  ok('发了 ' + bold(posted + '') + ' 条到 ' + bold(p.name));
  log(sepia('  去看: ') + cfg.serverUrl + '/');
  log('');
}

// v0.12 experience 草稿一键发 · 单 update + 自动 markAsExperience
// text 已经去掉 frontmatter · 用户在 confirm 前能预览
async function cmdPushExperienceDraft(cfg, opts, text, productTag = 'experience') {
  const PRODUCT_LABELS = { experience: '踩坑经验', learning: '上手指南', decision: '决策推演' };
  const ACTION_MAP = { experience: 'markAsExperience', learning: 'markAsLearning', decision: 'markAsDecision' };
  const CMD_MAP = { experience: 'tinker mark-experience', learning: 'tinker mark-learning', decision: 'tinker mark-decision' };
  const productLabel = PRODUCT_LABELS[productTag] || '踩坑经验';
  if (!text || text.length < 20) { err('草稿内容太短 · ' + productLabel + ' 池要求 ≥ 20 字'); process.exit(1); }
  const state = await apiState(cfg);
  const me = cfg.handle;
  const mine = state.projects.filter(p => p.owner === me && ['active', 'stuck', 'live'].includes(p.status));
  if (mine.length === 0) { err('你没有 active/stuck 的项目'); process.exit(1); }

  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (mine.length === 1) {
    projectId = mine[0].id;
    log(sepia('  自动选了唯一一个项目: ') + bold(mine[0].name));
  } else {
    const { select } = promptKit();
    projectId = await select({
      message: '发到哪个项目?',
      choices: mine.map(p => ({
        name: p.name + sepia('  ' + p.desc.slice(0, 40)),
        value: p.id,
      })),
    });
  }
  const p = mine.find(x => x.id === projectId);

  // 预览 + 确认 (除非 --yes)
  log('');
  log(sepia('  ' + productLabel + '草稿预览 (前 10 行):'));
  log(sepia('  ─────────'));
  text.split('\n').slice(0, 10).forEach(line => log('  ' + line));
  log(sepia('  ─────────'));
  log('');
  if (!opts.yes) {
    const { confirm } = promptKit();
    const yes = await confirm({
      message: `发到「${p.name}」并标为${productLabel}?`,
      default: true,
    });
    if (!yes) { log(sepia('  取消了')); return; }
  }

  // v0.20 voice 守门 · --as-experience / --as-learning / --as-decision 也要过
  const gate = await gateVoiceCheck(text, opts);
  if (!gate.ok) process.exit(1);

  // 发 + 自动 mark · v0.13 phase 2 完整版
  try {
    const res = await apiAction(cfg, 'addUpdate', { projectId, text });
    recordPushAt(projectId);
    const updateId = res && (res.id || (res.result && res.result.id));
    if (updateId) {
      const markAction = ACTION_MAP[productTag] || 'markAsExperience';
      const manualCmd = CMD_MAP[productTag] || 'tinker mark-experience';
      try {
        await apiAction(cfg, markAction, { updateId });
      } catch (e) {
        log(sepia('  ⚠ mark ' + productTag + ' 失败: ' + e.message + ' · 手动跑 ') + vermilion(`${manualCmd} ${updateId}`));
      }
    }
    log('');
    ok('发了 + 标为' + productLabel + ' — ' + bold(p.name));
    if (updateId) log(sepia('  update id: ') + updateId);
    const slug = (res && res.projectSlug) || p.slug;
    const handle = (res && res.ownerHandle) || cfg.handle;
    if (slug && handle) {
      log(sepia('  去看: ') + cfg.serverUrl + '/#/p/' + handle + '/' + slug);
    }
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

// 标记项目卡住 + 记一条 "卡在 X" · 触发 server A4 通知 wantToTry + tinkered 用户
async function cmdStuck(opts) {
  const cfg = mustHaveConfig();
  const state = await apiState(cfg);
  const me = cfg.handle;
  // 卡住命令只对 active 项目有意义 (stuck 项目再 stuck 没意义 · done/archive 也不该用 stuck)
  const mine = state.projects.filter(p => p.owner === me && p.status === 'active');
  if (mine.length === 0) {
    err('你没有 active 的项目可以标卡住 · 去 ' + cfg.serverUrl + ' 看看');
    process.exit(1);
  }

  // 选项目
  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (mine.length === 1) {
    projectId = mine[0].id;
    log(sepia('  自动选了唯一一个项目: ') + bold(mine[0].name));
  } else {
    const { select } = promptKit();
    projectId = await select({
      message: '哪个项目卡住了?',
      choices: mine.map(p => ({
        name: p.name + sepia('  ' + p.desc.slice(0, 40)),
        value: p.id,
      })),
    });
  }

  // 决定卡住描述 (-m 给了 / 交互问)
  let stuckText = opts.text;
  if (!stuckText) {
    const { input } = promptKit();
    stuckText = await input({
      message: '卡在哪? (一句话 · 越具体越容易被人接上)',
      default: undefined,
    });
  }
  stuckText = (stuckText || '').trim();
  if (!stuckText) { err('得说一下卡在哪 · 不然别人没法帮上忙'); process.exit(1); }

  // voice 守门 · 卡住文字进队友视野 · 跟 push 同等严
  const stuckGate = await gateVoiceCheck(stuckText, { profile: 'for_humans_team', force: opts.force });
  if (!stuckGate.ok) process.exit(1);

  // server 端要求 commit 文字本身没规定 prefix · 这里加 "卡在 " 让时间线读起来一致
  if (!stuckText.startsWith('卡')) stuckText = '卡在 ' + stuckText;

  const p = mine.find(x => x.id === projectId);

  // 两步操作 · 顺序: 先改 status (触发 A4 通知) · 再记 commit (出现在时间线)
  // server 从 Bearer token 拿身份 · 不需要 currentUser
  try {
    await apiAction(cfg, 'changeProjectStatus', { projectId, newStatus: 'stuck' });
    await apiAction(cfg, 'addUpdate', { projectId, text: stuckText });
    recordPushAt(projectId);
    log('');
    ok('标了卡住 — ' + bold(p.name));
    log(sepia('  写的是: ') + stuckText);
    const watcherCount = (p.reactions.wantToTry?.length || 0) + (p.reactions.tinkered?.length || 0);
    if (watcherCount > 0) {
      log(sepia('  通知了 ') + bold(watcherCount + '') + sepia(' 个想试试 / 延伸过你项目的人 · 也许能搭把手'));
    } else {
      log(sepia('  还没人想试试或延伸过 · 但写出来比闷着强'));
    }
    log(sepia('  去看: ') + cfg.serverUrl + '/');
    log('');
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

// 把本地图片转 base64 data URL,作为 ship images 的一员
function imageFromPath(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('找不到图: ' + filePath);
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
  return [{ src: 'data:' + mime + ';base64,' + buf.toString('base64'), caption: '' }];
}

// =====================================================
// 截图后端 · 可换 (v0.57)
// 默认 microlink (免费 50/天 · 无 key) · 配了 key 走 apiflash / screenshotone
// config.json 的 screenshot 段: { provider: 'apiflash'|'screenshotone'|'microlink', apiKey }
// 历史: microlink Pro 要 $50/月 · 对两人小工作室太贵 · 换便宜档免费档够用
// =====================================================
function getShotConfig(cfg) {
  const sc = (cfg && cfg.screenshot) || {};
  // env 覆盖 · 让 CI / watcher 子进程也能拿到
  const apiKey = process.env.TINKER_SHOT_KEY || sc.apiKey || null;
  const provider = process.env.TINKER_SHOT_PROVIDER || sc.provider || (apiKey ? 'screenshotone' : 'microlink');
  return { provider, apiKey };
}

// 同步抓 URL 截图存到 outPath (走 curl) · 成功返 true · 三个调用点共用
// 统一 16:9 1280x720 · scale 2 · jpeg q85 · 跟陈列馆 figure 比例匹配
function captureScreenshotToFile(cfg, targetUrl, outPath) {
  const { provider, apiKey } = getShotConfig(cfg);
  try {
    if (provider === 'apiflash') {
      if (!apiKey) return false;
      const p = new URLSearchParams({
        access_key: apiKey, url: targetUrl, format: 'jpeg',
        width: '1280', height: '720', quality: '85',
        wait_until: 'network_idle', response_type: 'image', fresh: 'true',
      });
      execSync(`curl -sS --max-time 60 -o "${outPath}" "https://api.apiflash.com/v1/urltoimage?${p.toString()}"`, { encoding: 'utf-8' });
    } else if (provider === 'screenshotone') {
      if (!apiKey) return false;
      const p = new URLSearchParams({
        access_key: apiKey, url: targetUrl, format: 'jpg',
        viewport_width: '1280', viewport_height: '720', device_scale_factor: '2',
        image_quality: '85', block_ads: 'true', block_cookie_banners: 'true', cache: 'false',
      });
      execSync(`curl -sS --max-time 60 -o "${outPath}" "https://api.screenshotone.com/take?${p.toString()}"`, { encoding: 'utf-8' });
    } else {
      // microlink · 两步 (先 JSON 拿 url · 再下图)
      const p = new URLSearchParams({
        url: targetUrl, screenshot: 'true', type: 'jpeg',
        'viewport.width': '1280', 'viewport.height': '720', 'viewport.deviceScaleFactor': '2',
        waitUntil: 'networkidle0', waitForTimeout: '2500', 'screenshot.quality': '85', meta: 'false',
      });
      const json = JSON.parse(execSync(`curl -sS --max-time 60 "https://api.microlink.io/?${p.toString()}"`, { encoding: 'utf-8' }));
      const shotUrl = json.data && json.data.screenshot && json.data.screenshot.url;
      if (!shotUrl) return false;
      execSync(`curl -sS --max-time 60 -o "${outPath}" "${shotUrl}"`, { encoding: 'utf-8' });
    }
    // 空白页 / 错误页通常 < 4KB · 拒掉
    const sz = fs.statSync(outPath).size;
    if (sz < 4096) { try { fs.unlinkSync(outPath); } catch {} return false; }
    return true;
  } catch { try { fs.unlinkSync(outPath); } catch {} return false; }
}

// 抓 URL 截图 → 转 base64 data URL (ship 封面用)
// 走 captureScreenshotToFile · provider 可换 · 临时文件落地后读出来转 base64
async function screenshotUrl(url) {
  const cfg = loadConfig();
  const tmp = path.join(CONFIG_DIR, 'snapshots', 'cover-' + Date.now() + '.jpg');
  try { fs.mkdirSync(path.dirname(tmp), { recursive: true }); } catch {}
  const okShot = captureScreenshotToFile(cfg, url, tmp);
  if (!okShot) throw new Error('截图失败 (provider: ' + getShotConfig(cfg).provider + ') · 死链 / 配额 / 空白页都可能');
  const buf = fs.readFileSync(tmp);
  const sizeKB = Math.round(buf.length / 1024);
  const base64 = buf.toString('base64');
  try { fs.unlinkSync(tmp); } catch {}
  return { images: [{ src: 'data:image/jpeg;base64,' + base64, caption: '自动抓的首页截图' }], sizeKB };
}

async function cmdShip(opts) {
  const cfg = mustHaveConfig();
  const state = await apiState(cfg);
  const me = cfg.handle;
  // 完工只对当前不是 done 的项目有意义
  const mine = state.projects.filter(p => p.owner === me && p.status !== 'done' && p.status !== 'archive');
  if (mine.length === 0) {
    err('你没有可以完工的项目 (都已 done 或 archive 了),去 ' + cfg.serverUrl + ' 看看');
    process.exit(1);
  }

  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (mine.length === 1) {
    projectId = mine[0].id;
    log(sepia('  自动选了唯一一个项目: ') + bold(mine[0].name));
  } else {
    const { select } = promptKit();
    projectId = await select({
      message: '哪个项目完工了?',
      choices: mine.map(p => ({
        name: p.name + sepia('  ' + p.desc.slice(0, 40)),
        value: p.id,
      })),
    });
  }

  let reflection = opts.text;
  if (!reflection) {
    const { input } = promptKit();
    reflection = await input({
      message: '写一句完工感想 (会进时间线,也进陈列馆代表这件作品)',
      default: undefined,
    });
  }
  reflection = (reflection || '').trim();
  if (!reflection) { err('完工感想不能空,说一句也行'); process.exit(1); }

  // --feedback-ask "..." 启用求反馈 + 写问题,--no-feedback 关求反馈
  let seekingFeedback = true;
  let feedbackAsk = '';
  if (opts.noFeedback) seekingFeedback = false;
  if (opts.feedbackAsk) feedbackAsk = opts.feedbackAsk;

  const p = mine.find(x => x.id === projectId);

  // v0.14 dry-run · 回显完工会发生什么 · 不改状态 · 不抓截图 · 不进陈列馆
  if (opts.dryRun) {
    const coverPlan = opts.image ? ('本地图 ' + opts.image)
      : (!opts.noScreenshot && p.productLink) ? ('首页截图 (会抓 ' + p.productLink + ')')
      : '无封面';
    if (opts.json) { outputJson({ ok: true, dryRun: true, action: 'ship', projectId, project: p.name, reflection, seekingFeedback, feedbackAsk, cover: coverPlan }); return; }
    log('');
    log(sepia('  dry-run · 不会发送 · 不改状态'));
    log('  项目:   ' + bold(p.name) + sepia(' · status → live'));
    log('  感想:   ' + reflection);
    log('  封面:   ' + coverPlan);
    log('  求反馈: ' + (seekingFeedback ? (feedbackAsk || '勾上 · 没填具体问题') : '否'));
    log('');
    return;
  }

  // 决定 images:
  //   --image <path>  : 用本地图(优先)
  //   --no-screenshot : 不带图
  //   默认            : microlink 抓 productLink 截图当封面
  let images;
  let coverNote = '';
  if (opts.image) {
    try {
      images = imageFromPath(opts.image);
      coverNote = '本地图 ' + opts.image;
    } catch (e) {
      log(sepia('  ⚠ ') + e.message + sepia(',这次不带图发'));
    }
  } else if (!opts.noScreenshot && p.productLink) {
    log(sepia('  抓首页截图 ') + dim('(microlink.io,如果失败也会继续 ship)') + '...');
    try {
      const r = await screenshotUrl(p.productLink);
      images = r.images;
      coverNote = '首页截图 ' + r.sizeKB + 'KB';
    } catch (e) {
      log(sepia('  ⚠ 截图失败:') + e.message + sepia(',这次不带图发'));
    }
  }

  try {
    await apiAction(cfg, 'shipProject', { projectId, reflection, seekingFeedback, feedbackAsk, images });
    recordPushAt(projectId);
    const wt = (p.reactions && p.reactions.wantToTry) ? p.reactions.wantToTry.length : 0;
    log('');
    ok(vermilion('✦ 上线了 ') + '— ' + bold(p.name) + sepia(' · status: live (持续打磨中)'));
    log(sepia('  感想: ') + reflection.slice(0, 80) + (reflection.length > 80 ? '…' : ''));
    if (coverNote) log(sepia('  封面: ') + coverNote);
    if (seekingFeedback) log(sepia('  求反馈: ') + (feedbackAsk || '勾上了,没填具体问题'));
    if (wt > 0) log(sepia('  已通知 ') + bold(wt + '') + sepia(' 个想试试的人'));
    log(sepia('  陈列馆: ') + cfg.serverUrl + '/#/showcase');

    // v0.32 ship 完同步起草项目编年史 · LLM 看 update 流挑节点 · 落到 .tinker/drafts/
    // 失败静默 · 不阻塞 ship 成功的喜悦 · 用户随时可以手动 tinker timeline draft 重试
    if (cfg.llm && cfg.llm.apiKey) {
      log('');
      log(sepia('  起草编年史中...'));
      try {
        const state2 = await apiState(cfg);
        const shipped = state2.projects.find(x => x.id === projectId);
        if (shipped) {
          const draftPath = await draftTimelineForProject(cfg, shipped);
          log(sepia('  编年史草稿: ') + draftPath);
          log(sepia('  改完发: ') + vermilion('tinker timeline push ' + projectId + ' ' + draftPath));
        }
      } catch (e) {
        log(sepia('  ⚠ 编年史起草失败: ') + e.message);
        log(sepia('  随时可以手动重跑: ') + vermilion('tinker timeline draft ' + projectId));
      }
    } else {
      log('');
      log(sepia('  想要自动起草编年史? 跑 ') + vermilion('tinker login') + sepia(' 配个 LLM key'));
    }
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

// =====================================================
// v0.34 edit-ship · 改老 ship update 的感想 / 求反馈
// 老项目 ship 时的 feedbackAsk 可能过时 · 加这个命令撤回 / 改写
// =====================================================

// tinker edit-ship [-p <projectId>] [-m "新感想"] [--feedback-ask "..."] [--no-feedback]
async function cmdEditShip(opts) {
  const cfg = mustHaveConfig();
  const state = await apiState(cfg);
  const me = cfg.handle;

  let projectId = opts.projectId;
  if (!projectId) {
    const candidates = state.projects.filter(p => p.owner === me && p.updates.some(u => u.kind === 'ship'));
    if (candidates.length === 0) { err('你没 ship 过任何项目'); process.exit(1); }
    if (candidates.length === 1) {
      projectId = candidates[0].id;
      log(sepia('  自动选了唯一一个 shipped 项目: ') + bold(candidates[0].name));
    } else {
      const { select } = promptKit();
      projectId = await select({
        message: '改哪个项目的完工感想?',
        choices: candidates.map(p => ({ name: p.name + sepia('  ' + p.desc.slice(0, 40)), value: p.id })),
      });
    }
  }

  const project = state.projects.find(p => p.id === projectId);
  if (!project) { err('项目不存在'); process.exit(1); }

  // 找 ship update 的 idx (按 updates 数组顺序 · 跟 server editUpdate 的 updateIdx 对齐)
  const shipIdx = project.updates.findIndex(u => u.kind === 'ship');
  if (shipIdx < 0) { err('这个项目没 ship 过'); process.exit(1); }
  const shipUpdate = project.updates[shipIdx];

  let newText = (opts.text || shipUpdate.text || '').trim();
  // v1.0 改了感想文字才走 voice 守门 (只改图/反馈时 newText 是旧文 · 不查)
  if (opts.text) {
    const gate = await gateVoiceCheck(newText, opts);
    if (!gate.ok) { if (opts.json) return errJson(gate.reason || 'voice 守门拒绝', gate.code || 'VOICE_GATE_BLOCK'); process.exit(1); }
  }
  let seekingFeedback;
  let feedbackAsk;

  if (opts.noFeedback) {
    seekingFeedback = false;
    feedbackAsk = '';
  } else if (opts.feedbackAsk !== undefined) {
    seekingFeedback = true;
    feedbackAsk = opts.feedbackAsk;
  } else {
    seekingFeedback = shipUpdate.feedbackAsk !== null && shipUpdate.feedbackAsk !== undefined;
    feedbackAsk = shipUpdate.feedbackAsk || '';
  }

  try {
    await apiAction(cfg, 'editUpdate', {
      projectId,
      updateIdx: shipIdx,
      text: newText,
      seekingFeedback,
      feedbackAsk,
    });
    log('');
    ok('改好了 — ' + bold(project.name));
    if (opts.text) log(sepia('  感想已更新'));
    if (opts.noFeedback) log(sepia('  求反馈撤了 · feedback 横条不再显示'));
    else if (opts.feedbackAsk !== undefined) log(sepia('  求反馈问题改成: ') + opts.feedbackAsk);
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

// =====================================================
// v0.33 freeze / relaunch · 上线产品的"暂停维护 / 重新动起来"
// =====================================================

// tinker freeze [-p <projectId>] · live → done · 主动暂停维护
async function cmdFreeze(opts) {
  const cfg = mustHaveConfig();
  const state = await apiState(cfg);
  const me = cfg.handle;
  const candidates = state.projects.filter(p => p.owner === me && p.status === 'live');
  if (candidates.length === 0) { err('你没有 live 状态的项目 (上线后还在维护的) 可以暂停'); process.exit(1); }

  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (candidates.length === 1) {
    projectId = candidates[0].id;
    log(sepia('  自动选了唯一一个 live 项目: ') + bold(candidates[0].name));
  } else {
    const { select } = promptKit();
    projectId = await select({
      message: '暂停维护哪个?',
      choices: candidates.map(p => ({ name: p.name + sepia('  ' + p.desc.slice(0, 40)), value: p.id })),
    });
  }

  try {
    await apiAction(cfg, 'changeProjectStatus', { projectId, newStatus: 'done' });
    const p = candidates.find(x => x.id === projectId);
    log('');
    ok('◯ 暂停维护 — ' + bold(p.name));
    log(sepia('  状态: live → done · 想重新动 ') + vermilion('tinker relaunch'));
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

// tinker relaunch [-p <projectId>] · done → live · 重新动起来
async function cmdRelaunch(opts) {
  const cfg = mustHaveConfig();
  const state = await apiState(cfg);
  const me = cfg.handle;
  const candidates = state.projects.filter(p => p.owner === me && p.status === 'done');
  if (candidates.length === 0) { err('你没有 done 状态的项目可以重新激活'); process.exit(1); }

  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (candidates.length === 1) {
    projectId = candidates[0].id;
    log(sepia('  自动选了唯一一个 done 项目: ') + bold(candidates[0].name));
  } else {
    const { select } = promptKit();
    projectId = await select({
      message: '重新激活哪个?',
      choices: candidates.map(p => ({ name: p.name + sepia('  ' + p.desc.slice(0, 40)), value: p.id })),
    });
  }

  try {
    await apiAction(cfg, 'changeProjectStatus', { projectId, newStatus: 'live' });
    const p = candidates.find(x => x.id === projectId);
    log('');
    ok('✦ 重新动起来 — ' + bold(p.name));
    log(sepia('  状态: done → live · 后续 ') + vermilion('tinker push') + sepia(' 就是上线后迭代'));
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

// 一键更新到 git 最新版 · 适用于按"装 CLI 一键命令"那条进展装的人
// 装的时候 git clone 到 ~/.tinker-src · update 就是 pull + 重新 npm install -g
const SRC_DIR = path.join(os.homedir(), '.tinker-src');

// === 版本检测 · 不强求更新 · 只在背景里查一下并提示 ===
const UPDATE_CACHE_FILE = path.join(CONFIG_DIR, 'update-status.json');
const GITHUB_REPO = 'Hldao/tinker';

// 拿本地 CLI 源码的 git SHA · 不存在(直接 npm 安装)返 null
function getInstalledSha() {
  try {
    if (fs.existsSync(path.join(SRC_DIR, '.git'))) {
      return execSync('git rev-parse HEAD', { cwd: SRC_DIR, encoding: 'utf-8' }).trim();
    }
  } catch {}
  return null;
}

// 升级检查 · 优先问自己的 server (一次往返 · 只算 cli/ 改动 · 不依赖 GitHub 限额)
// server 不可达 / 没这端点 / 没装 git 时 · 回退到直接打 GitHub
async function fetchRemoteStatus() {
  const installedSha = getInstalledSha();
  const fromServer = await fetchRemoteStatusFromServer(installedSha);
  if (fromServer) return fromServer;
  return fetchRemoteStatusFromGitHub(installedSha);
}

async function fetchRemoteStatusFromServer(installedSha) {
  try {
    const cfg = loadConfig();
    if (!cfg || !cfg.serverUrl) return null;
    const url = cfg.serverUrl + '/api/cli-version' + (installedSha ? '?since=' + installedSha : '');
    const r = await fetch(url, {
      headers: { 'User-Agent': 'tinker-cli' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || !d.available) return null; // server 没装 git / 没历史 · 回退 GitHub
    return {
      checkedAt: Date.now(),
      latestSha: d.latestSha,
      latestMsg: d.latestMsg || '',
      latestDate: null,
      installedSha,
      behindBy: d.behindBy || 0,
      recentCommits: d.recentCommits || [],
      source: 'server',
    };
  } catch {
    return null;
  }
}

// 从 GitHub 拉最新 main commit · 计算 behindBy (本地落后多少 commit) · server 不可达时的兜底
async function fetchRemoteStatusFromGitHub(installedShaArg) {
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/main`, {
      headers: { 'User-Agent': 'tinker-cli', 'Accept': 'application/vnd.github+json' },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const latestSha = data.sha;
    const latestMsg = (data.commit && data.commit.message || '').split('\n')[0];
    const latestDate = data.commit && data.commit.author && data.commit.author.date;

    const installedSha = installedShaArg || getInstalledSha();
    let behindBy = 0;
    let recentCommits = [];
    if (installedSha && installedSha !== latestSha) {
      // GitHub compare API · 算 ahead_by (从我方到 latest 多少 commit)
      const cr = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/compare/${installedSha}...${latestSha}`, {
        headers: { 'User-Agent': 'tinker-cli', 'Accept': 'application/vnd.github+json' },
      });
      if (cr.ok) {
        const cd = await cr.json();
        behindBy = cd.ahead_by || 0;
        // v0.36 顺手存最近 5 个 commit 标题 · 横幅显示给用户看"改了什么" · 决定升不升时有信息看
        recentCommits = (cd.commits || []).slice(-5).reverse().map(c => {
          const msg = (c.commit && c.commit.message || '').split('\n')[0];
          return msg.slice(0, 80);
        });
      }
    }
    return { checkedAt: Date.now(), latestSha, latestMsg, latestDate, installedSha, behindBy, recentCommits };
  } catch {
    return null;
  }
}

// 后台异步刷新 cache · fire and forget
function spawnUpdateCheckAsync() {
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.argv[0], [process.argv[1], 'update', '--check-only'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {}
}

// v0.36 阈值从 ≥5 commit 或 ≥7 天 收紧到 ≥1 commit · alpha 期版本变化快 · 落后 5 commit 才提醒太晚
// 加 dismiss · 看过提醒之后当天不再重复 (避免每次跑命令都弹)
function showUpdateBannerIfNeeded() {
  let cache;
  try { cache = JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf-8')); } catch { return; }
  if (!cache.behindBy || cache.behindBy < 1) return;
  // 当天看过就跳过 · 不每次跑命令都弹
  const todayKeyStr = todayKey();
  if (cache.lastShownDate === todayKeyStr) return;

  log('');
  log(sepia('  ── ') + vermilion('CLI 有更新 · 落后 ') + bold(cache.behindBy + ' 个 commit') + sepia(' ──'));
  if (Array.isArray(cache.recentCommits) && cache.recentCommits.length > 0) {
    for (const msg of cache.recentCommits.slice(0, 3)) {
      log(sepia('    · ') + sepia(msg));
    }
    if (cache.recentCommits.length > 3) log(sepia('    · 还有 ' + (cache.recentCommits.length - 3) + ' 条...'));
  } else if (cache.latestMsg) {
    log(sepia('    最新: ') + sepia(cache.latestMsg.slice(0, 60)));
  }
  log(sepia('  升级跑 ') + vermilion('tinker update') + sepia(' · 不急 · 今天不再提'));
  log('');

  // 标记当天看过 · 不每次都弹
  try {
    cache.lastShownDate = todayKeyStr;
    fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

async function cmdUpdate(opts = {}) {
  // --check-only · 只刷新 update cache · 不真的升级 (后台 spawn 用)
  if (opts.checkOnly) {
    // cache TTL 24h · 在 TTL 内直接退 · 不打 GitHub API
    try {
      const cache = JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf-8'));
      if (Date.now() - cache.checkedAt < 24 * 60 * 60 * 1000) return;
    } catch {}
    const status = await fetchRemoteStatus();
    if (status) {
      try {
        if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(status, null, 2));
      } catch {}
    }
    return;
  }
  return cmdUpdateReal();
}

async function cmdUpdateReal() {
  log('');
  // v0.14 命名错位兜底:tinker update 在 CLI 业内是"升级自己" · 但 Tinker 里 update 是
  // 核心概念词 (一条进展记录) · 新用户手敲 tinker update 大概率是想"记一条进展"
  // TTY 时先确认 · 防误用 · 非 TTY (LLM / hook / pipe) 直接跑升级 不打扰
  if (process.stdin.isTTY && process.stdout.isTTY) {
    log(sepia('  ── ') + vermilion('提醒一下') + sepia(' ──'));
    log('  你是想' + bold('记一条进展') + '? 那个命令是 ' + vermilion("tinker push -m '...'"));
    log(sepia('  这个 ') + vermilion('tinker update') + sepia(' 是升级 CLI 自己 · 拉最新代码 + npm install -g'));
    log('');
    try {
      const { confirm } = promptKit();
      const go = await confirm({ message: '要继续升级 CLI 吗?', default: false });
      if (!go) {
        log('');
        log(sepia('  好 · 没升级'));
        log(sepia('  记一条进展跑 ') + vermilion("tinker push -m '今天搞了 ...'"));
        log('');
        return;
      }
    } catch {
      log(sepia('  好 · 没升级'));
      return;
    }
    log('');
  }

  if (!fs.existsSync(SRC_DIR)) {
    err('找不到 ' + sepia(SRC_DIR) + err('  这意味着你不是按官方一键命令装的'));
    log('');
    log(sepia('  如果你忘了当时怎么装的,可以重新跑一遍一键命令清装:'));
    log('  ' + vermilion('git clone https://github.com/Hldao/tinker.git ~/.tinker-src && npm install -g ~/.tinker-src/cli'));
    log('');
    process.exit(1);
  }

  log(sepia('  拉最新代码 (git pull)...'));
  let pullOut;
  try {
    pullOut = execSync('git pull --ff-only', { cwd: SRC_DIR, encoding: 'utf-8' });
  } catch (e) {
    err('git pull 失败:' + (e.message || ''));
    log(sepia('  可能是网络问题,或者本地修改了文件 · 自己 cd 进 ' + SRC_DIR + ' 看看'));
    process.exit(1);
  }

  if (pullOut.includes('Already up to date')) {
    log(moss('  ✓ 已经是最新的 · 不用重装'));
    log('');
    return;
  }
  log(sepia('  ' + pullOut.split('\n').slice(0, 4).join('\n  ')));

  log(sepia('  重装 CLI (npm install -g)...'));
  try {
    execSync('npm install -g ' + path.join(SRC_DIR, 'cli'), { stdio: 'inherit' });
  } catch (e) {
    err('npm install 失败');
    log(sepia('  如果是权限问题,可能要 sudo · 或者改 npm prefix 到 ~/.npm-global'));
    process.exit(1);
  }

  log('');
  ok('CLI 升级完成');

  // 升级后自动刷新 Claude Code hook · 防"更新了 CLI 但没拿到新 hook"
  // (只在原本装过的情况下重装 · 不给没装过的人硬塞 · 尊重 opt-in)
  // 案例:notify-claude 桌面通知是新加的 hook · 光 tinker update 不会装上 · 用户白等
  if (hasClaudeHooksInstalled()) {
    log(sepia('  刷新 Claude Code hook (补上新增的) ...'));
    try { await cmdClaudeHookInstall({ quiet: true }); ok('hook 已刷新'); }
    catch { log(sepia('  hook 刷新没成 · 手动跑一下 ') + vermilion('tinker hook install-claude')); }
  }
  // 升级后也刷新 Codex 的 AGENTS.md 块 (跟 Claude hook 同理 · 只在原本装过时刷 · 让 Codex 用户也拿到新版指令)
  if (hasCodexAgentsInstalled()) {
    log(sepia('  刷新 AGENTS.md 的 Tinker 块 (Codex) ...'));
    try { writeAgentsBlock(); ok('AGENTS.md 已刷新'); }
    catch { log(sepia('  AGENTS.md 刷新没成 · 手动跑一下 ') + vermilion('tinker hook install-codex')); }
  }

  // 最近几条更新内容(粗略)
  try {
    const recent = execSync('git log --since="7 days ago" --pretty=format:"  %s" -n 8 cli/', { cwd: SRC_DIR, encoding: 'utf-8' }).trim();
    if (recent) {
      log(sepia('  最近 CLI 的几个改动:'));
      log(sepia(recent));
    }
  } catch (e) {}
  log('');
  log(sepia('  跑 ') + vermilion('tinker help') + sepia(' 看看新命令'));
  log('');
}

// 检测用户是否已经装过 Claude Code hook (settings.json 里有 tinker 命令)
function hasClaudeHooksInstalled() {
  try {
    const p = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(p)) return false;
    const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const hooks = s.hooks || {};
    for (const evt of Object.keys(hooks)) {
      for (const entry of (hooks[evt] || [])) {
        if ((entry.hooks || []).some(h => /\btinker\s/.test(h.command || ''))) return true;
      }
    }
  } catch {}
  return false;
}

// =============================================
// v0.63 PROACTIVE PROMPT 框架
// post-commit hook 装上之后 · 每次 commit 自动跑 tinker check
// check 评估触发器 · 满足条件才出 prompt · 否则安静退出
// 默认全 opt-in · 不打分 · 不推送给别人 · 不烦人
// =============================================

const PROMPT_STATE_FILE = path.join(CONFIG_DIR, 'prompt-state.json');
const HOOK_BEGIN = '# >>> tinker-hook-v2 >>>';
const HOOK_END = '# <<< tinker-hook-v2 <<<';
// v0.17 post-commit hook 默认走 --json · 命中触发器只 stdout JSON + append pending-reminders.jsonl
// 不再弹 inquirer (Claude Code Bash tool 没 TTY · 弹了立刻 fall back 到 later · 用户感受不到)
// 用户后续可以跑 tinker pending --json 看待处理 reminder · AI 工具也能主动调
const HOOK_BLOCK = `${HOOK_BEGIN}
# 装/改/卸: tinker hook install | uninstall
command -v tinker >/dev/null 2>&1 && tinker check --from-hook --json >/dev/null 2>&1 || true
${HOOK_END}
`;

// v0.13 post-push hook · 用户 git push 时 · 自然的"模块告一段落" 信号
// detached spawn backfill · 不阻塞 push 返回 · 草稿后台跑
const POST_PUSH_BLOCK = `${HOOK_BEGIN}
# tinker post-push: detached backfill · 不阻塞
command -v tinker >/dev/null 2>&1 && \\
  (tinker situation backfill --type design-loop --hours 4 --quiet >/dev/null 2>&1 &) || true
${HOOK_END}
`;

// v0.13 post-checkout hook · 切回 main 分支时触发 (feature done)
// $1 = previous HEAD · $2 = new HEAD · $3 = 1 if branch checkout (not file)
const POST_CHECKOUT_BLOCK = `${HOOK_BEGIN}
# tinker post-checkout: 切回 main 时认为 feature 做完了 · 触发推演总结
if [ "$3" = "1" ]; then
  CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$CUR_BRANCH" = "main" ] || [ "$CUR_BRANCH" = "master" ]; then
    command -v tinker >/dev/null 2>&1 && \\
      (tinker situation backfill --type design-loop --hours 4 --quiet >/dev/null 2>&1 &) || true
  fi
fi
${HOOK_END}
`;

// CONFIG_DIR 下一堆本地缓存/状态文件 · 读写都是同一套容错样板 · 收成两个 helper
// 读:文件没了 / 坏了 都返 fallback · 写:失败静默 (缓存而已 · 不影响主流程)
function loadJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { return fallback; }
}
function saveJsonSafe(file, obj) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch { /* 容错 · 失败不影响 */ }
}

function loadPromptState() { return loadJsonSafe(PROMPT_STATE_FILE, {}); }
function savePromptState(s) { saveJsonSafe(PROMPT_STATE_FILE, s); }

// v0.35 通知偏好闭环 · server 端 user_prefs 的本地 cache · 5min TTL
// 设计:同步代码用 cache · 过期就后台异步刷新 · 网络/无 token 都不影响触发器
const PREFS_CACHE_FILE = path.join(CONFIG_DIR, 'prefs-cache.json');
const PREFS_CACHE_TTL_MS = 5 * 60 * 1000;
function loadPrefsCache() { return loadJsonSafe(PREFS_CACHE_FILE, null); }
function savePrefsCache(prefs) { saveJsonSafe(PREFS_CACHE_FILE, { prefs, fetchedAt: Date.now() }); }
async function fetchPrefsFromServer() {
  try {
    const cfg = loadConfig();
    if (!cfg || !cfg.serverUrl || !cfg.token) return null;
    const res = await fetch(cfg.serverUrl + '/api/user/prefs', {
      headers: { 'Authorization': 'Bearer ' + cfg.token },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.ok) return null;
    savePrefsCache(data.prefs);
    return data.prefs;
  } catch { return null; }
}
// 同步入口 · 返当前 cache · 过期/没 cache 就后台刷新
function getPrefsSync() {
  const c = loadPrefsCache();
  if (!c) {
    fetchPrefsFromServer().catch(() => {});
    return null;
  }
  const age = Date.now() - (c.fetchedAt || 0);
  if (age > PREFS_CACHE_TTL_MS) {
    fetchPrefsFromServer().catch(() => {});
  }
  return c.prefs || null;
}
function shouldSuppressKindLocal(kind, prefs) {
  if (!prefs) return false;
  if (prefs.mutedUntil && prefs.mutedUntil > Date.now()) return true;
  if (prefs.quietStart && prefs.quietEnd) {
    const now = new Date();
    const [sh, sm] = prefs.quietStart.split(':').map(Number);
    const [eh, em] = prefs.quietEnd.split(':').map(Number);
    if (!isNaN(sh) && !isNaN(eh)) {
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      if (startMin !== endMin) {
        const inWindow = startMin < endMin
          ? (nowMin >= startMin && nowMin < endMin)
          : (nowMin >= startMin || nowMin < endMin);
        if (inWindow) return true;
      }
    }
  }
  if (Array.isArray(prefs.cliDisabledKinds) && prefs.cliDisabledKinds.includes(kind)) return true;
  return false;
}
// v0.25 Tinker 服务东八区用户 · 所有"今天 / 这周 / 这个月" 一律按北京时间算
// 不依赖运行机器时区 (阿里云 ECS 跑 UTC / 国外协作者跑 CLI 都能拿到一致结果)
const TZ_BEIJING = 'Asia/Shanghai';

// 北京时间今天 YYYY-MM-DD · en-CA locale 自然输出 ISO 日期格式
function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_BEIJING, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// 北京当前 0-23 小时 (用来判断凌晨)
function beijingHour() {
  return parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ_BEIJING, hour: 'numeric', hour12: false,
  }).format(new Date()), 10);
}

// 北京时间 (今天 + offsetDays) hour:00:00 对应的 UTC epoch ms
// hour 可以溢出 (28 = 明天 4am · 跟原 setHours(28) 语义一致)
function beijingDayStart(offsetDays = 0, hour = 0) {
  const [y, m, d] = todayKey().split('-').map(Number);
  return Date.UTC(y, m - 1, d + offsetDays, hour - 8, 0, 0);
}

// git log --since 用的 ISO 字符串 (UTC · git 能正确解析时区)
function beijingSinceISO(offsetDays = 0, hour = 4) {
  return new Date(beijingDayStart(offsetDays, hour)).toISOString();
}

// v0.88 工作日 key · 北京凌晨 0-4 算前一天的 tail · 给 maybe-goodnight 和 goodnight 标记用
function workdayKey() {
  if (beijingHour() >= 4) return todayKey();
  // 凌晨 · 拿昨天 (北京) 的 key
  const [y, m, d] = todayKey().split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1));
  return yesterday.getUTCFullYear() + '-' +
    String(yesterday.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(yesterday.getUTCDate()).padStart(2, '0');
}

// 记录最近一次 push 到 Tinker 的时间 (按项目) · 给触发器 C "长时间未发" 用
function recordPushAt(projectId) {
  if (!projectId) return;
  const state = loadPromptState();
  state.lastPushAtByProject = state.lastPushAtByProject || {};
  state.lastPushAtByProject[projectId] = Date.now();
  savePromptState(state);
}

function loadRepoConfig() {
  // 项目级 config · 告诉 check 这个 repo 关联哪个 Tinker 项目
  const f = path.join(process.cwd(), '.tinker', 'repo.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; }
}
function saveRepoConfig(obj) {
  const dir = path.join(process.cwd(), '.tinker');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'repo.json'), JSON.stringify(obj, null, 2));
}

async function cmdHookInstall() {
  if (!inGitRepo()) { err('不在 git 仓库'); process.exit(1); }
  const cfg = mustHaveConfig();

  // 先让用户选 · 这个 repo 关联哪个 Tinker 项目
  let repoCfg = loadRepoConfig();
  if (!repoCfg) {
    const state = await apiState(cfg);
    const mine = state.projects.filter(p => p.owner === cfg.handle);
    if (mine.length === 0) {
      err('你在 Tinker 上还没项目 · 先去 ' + cfg.serverUrl + ' 开张');
      process.exit(1);
    }
    const { select } = promptKit();
    const projectId = mine.length === 1 ? mine[0].id : await select({
      message: '这个 git 仓库对应哪个 Tinker 项目?',
      choices: mine.map(p => ({ name: p.name + sepia('  ' + (p.desc||'').slice(0, 40)), value: p.id })),
    });
    const picked = mine.find(p => p.id === projectId);
    repoCfg = { projectId, projectName: picked.name, installedAt: Date.now() };
    saveRepoConfig(repoCfg);
    ok('记下了 · 这个 repo = ' + bold(picked.name));
  }

  // 记到 ~/.tinker/repos.json · 给 drift 检测用 (扫所有注册的 repo 算今日活动分布)
  registerRepoForDrift(process.cwd(), repoCfg);

  // 装 hook · 不暴力覆盖 · 用 marker 块附加 · 兼容用户已有 hook
  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim();
  installSingleGitHook(gitDir, 'post-commit', HOOK_BLOCK);
  installSingleGitHook(gitDir, 'post-push', POST_PUSH_BLOCK);
  installSingleGitHook(gitDir, 'post-checkout', POST_CHECKOUT_BLOCK);

  ok('hooks 装好了 · 三件套:');
  log(sepia('    post-commit    每次 commit 跑触发器评估 (24 个触发器自动判断)'));
  log(sepia('    post-push      推上之后后台起草推演总结 (不阻塞)'));
  log(sepia('    post-checkout  切回 main 后台起草推演总结 (feature done 信号)'));
  log('');
  log(sepia('  默认: 静默 · 满足触发条件才会出来问'));
  log(sepia('  关:    ') + vermilion('tinker hook uninstall'));
  log(sepia('  静音: ') + vermilion('tinker mute 1h') + sepia(' / ') + vermilion('tinker mute today'));
}

// v0.13 helper · 装一个 git hook · 复用 marker 块逻辑
function installSingleGitHook(gitDir, name, block) {
  const hookFile = path.join(gitDir, 'hooks', name);
  let content = '';
  if (fs.existsSync(hookFile)) {
    content = fs.readFileSync(hookFile, 'utf-8');
    content = content.replace(new RegExp(HOOK_BEGIN + '[\\s\\S]*?' + HOOK_END + '\\n?', 'g'), '');
  } else {
    content = '#!/bin/sh\n';
  }
  content = content.trimEnd() + '\n\n' + block;
  fs.writeFileSync(hookFile, content);
  fs.chmodSync(hookFile, 0o755);
}

// ============================================
// Codex / 其他读 AGENTS.md 的 agent 集成 (v1.0)
// Codex 没有 Claude Code 那种 per-prompt hook · 但它读项目根的 AGENTS.md (相当于它的 CLAUDE.md)
// 所以集成 = git hook (工具无关 · commit 触发器) + 往 AGENTS.md 写一段指令 (让 agent 主动调 tinker)
// ============================================
const AGENTS_BEGIN = '<!-- TINKER:START -->';
const AGENTS_END = '<!-- TINKER:END -->';

function buildAgentsBlock() {
  return [
    AGENTS_BEGIN,
    '## Tinker / 捣鼓 集成 (本 repo 绑了 Tinker 项目 · 这段由 `tinker hook install-codex` 生成 · 别手改)',
    '',
    '你在跟一个 Tinker 作者结对 coding。这台机器装了 `tinker` CLI。按下面主动调命令,不靠用户提醒:',
    '',
    '- 用户聊到某技术 / 报错 / 想入门 X → `tinker borrow "<关键词>" --json --limit 5` 拿别人沉淀的方法,注入你的回答',
    '- 用户说"懂了 / 通了 / 顿悟"(真顿悟,不是随口) → 建议 `tinker push -m "..."` 留一笔进展',
    '- 用户说"卡住 / 不行 / 跑不起来"(真卡住) → 建议 `tinker stuck -m "..."` 让在意 ta 的人看到',
    '- 用户说"帮我发个求方法 / 我缺个 X 的方法 / 求人指路" → `tinker seek -m "缺什么方法"` 发一条求方法(进方法库「有人在找」· 注意不是 ship 的求反馈)',
    '- 用户说"把这个沉淀成方法 / 存成方法"(做通了别人能复用的事) → `tinker contribute [updateId]` 把某条 update 标成方法(进方法库「沉淀的方法」)',
    '- 用户说"完工 / 上线 / 发出去了"(真发布) → 建议 `tinker ship -m "一句话感想"` 进陈列馆',
    '- 做工具 / 方案决策 → 建议 `tinker push -m "..."` 记下为什么选这个',
    '',
    '**session / 对话开头**:跑 `tinker bridge-check-inbox --json` 看队友有没有发接力(handoff)、工作室邀请、征求意见(witness)过来。有就 `cat ~/.tinker/inbox/<id>/README.md` 看完整说明,跟用户确认要不要处理,处理完 `tinker inbox done <id>`。(Claude Code 靠 SessionStart hook 自动跑这个,你这边要主动跑,不然会漏掉队友发来的东西。)',
    '',
    '**对话内触发器 (跨 AI 通用入口)**:看到用户消息像顿悟/卡住/决策/砍/完工,Bash 跑:',
    '`tinker maybe-check --text "<用户最近一条消息>" --json`',
    '看返回的 `fired` 数组,按里面的 reminder 跟用户对话(仍看上下文判断,不每次都弹)。',
    '',
    '**git commit 之后**:commit 会触发后台评估(post-commit hook 已装)。跑 `tinker pending --json` 看有没有待处理提醒,合适时机提醒用户;处理完 `tinker pending --mark-handled <id>`。',
    '',
    '**帮用户起草 push / ship 的文字**:读 `.tinker/voice-fingerprint.md` 学作者口吻(冲突时以这份 AGENTS.md / 用户明确反馈为准)。纯中文,不中英混杂,别堆中点(·)、别堆破折号(——),用普通话口语标点。被 voice 守门拦了先看 hits 改,别急着 --force。',
    '',
    '完整命令:`tinker --help` · 结构化:`tinker schema --json`',
    AGENTS_END,
    '',
  ].join('\n');
}

// AGENTS.md 里 Tinker 块的剥离正则 (install / uninstall / 升级刷新 共用)
function agentsBlockStripRegex() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc(AGENTS_BEGIN) + '[\\s\\S]*?' + esc(AGENTS_END) + '\\n?', 'g');
}
// 当前 repo 装没装 Codex/AGENTS.md 集成 (给 tinker update 升级后判断要不要刷新)
function hasCodexAgentsInstalled() {
  try { return fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8').includes(AGENTS_BEGIN); }
  catch { return false; }
}
// 写/更新项目根 AGENTS.md 的 Tinker 块 (带标记 · 不覆盖用户其它内容) · 返回文件是否原本就存在
function writeAgentsBlock() {
  const agentsFile = path.join(process.cwd(), 'AGENTS.md');
  let content = '', existed = false;
  if (fs.existsSync(agentsFile)) {
    existed = true;
    content = fs.readFileSync(agentsFile, 'utf-8').replace(agentsBlockStripRegex(), '');
  }
  content = content.trimEnd();
  content = content ? content + '\n\n' + buildAgentsBlock() : buildAgentsBlock();
  fs.writeFileSync(agentsFile, content);
  return existed;
}

async function cmdCodexHookInstall(opts = {}) {
  // 第一步: 装 git hook + 绑 repo (跟 tinker hook install 一样 · 工具无关 · commit 触发器靠这个)
  await cmdHookInstall();
  // 第二步: 往项目根 AGENTS.md 写 Tinker 指令块 (Codex 读这个 · 带标记 · 可更新可删)
  const existed = writeAgentsBlock();
  log('');
  ok('Codex 集成装好了 (AGENTS.md)');
  log(sepia('    AGENTS.md       ') + (existed ? '已更新 Tinker 指令块' : '新建 · 写入 Tinker 指令块') + sepia(' (Codex 读它 · 学会主动调 tinker)'));
  log('');
  log(sepia('  Codex 没有 Claude Code 那种逐条注入的 hook · 靠 AGENTS.md 指令让 agent 主动调命令'));
  log(sepia('  commit 触发器走的是 git hook (工具无关 · 上面已装)'));
  log(sepia('  以后 ') + vermilion('tinker update') + sepia(' 升级时 · AGENTS.md 块会自动跟着刷新 (跟 Claude hook 一样)'));
  log(sepia('  关:    ') + vermilion('tinker hook uninstall-codex') + sepia(' (删 AGENTS.md 里的块) · ') + vermilion('tinker hook uninstall') + sepia(' (删 git hook)'));
}

function cmdCodexHookUninstall() {
  const agentsFile = path.join(process.cwd(), 'AGENTS.md');
  if (!fs.existsSync(agentsFile)) { log(sepia('  AGENTS.md 不存在 · 没什么要删')); return; }
  let content = fs.readFileSync(agentsFile, 'utf-8');
  if (!content.includes(AGENTS_BEGIN)) { log(sepia('  AGENTS.md 里没有 Tinker 块 · 没删')); return; }
  content = content.replace(agentsBlockStripRegex(), '').trimEnd();
  if (content) { fs.writeFileSync(agentsFile, content + '\n'); }
  else { fs.unlinkSync(agentsFile); }  // 整个文件就剩 Tinker 块就删掉
  ok('删了 AGENTS.md 里的 Tinker 块' + (content ? '' : ' · AGENTS.md 空了 · 一并删掉'));
  log(sepia('  git hook 还在 · 要删跑 ') + vermilion('tinker hook uninstall'));
}

// v0.13 装 Claude Code SessionStart compact hook
// 当用户跑 /compact · Claude Code 触发 SessionStart 事件 (matcher: compact)
// 我们的 hook 跑 tinker situation backfill --type design-loop --hours 4 --quiet
// 后台起草草稿到 .tinker/drafts/ · 用户在新 session 第一眼能看到
async function cmdClaudeHookInstall(opts = {}) {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (e) {
      err('~/.claude/settings.json 解析失败:' + e.message + ' · 手动修一下再来');
      process.exit(1);
    }
  } else {
    // .claude 目录已经存在 (用户用 Claude Code 必然有) · 但 settings.json 可能没建
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }

  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = settings.hooks.SessionStart || [];
  settings.hooks.SessionEnd = settings.hooks.SessionEnd || [];
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];
  settings.hooks.Notification = settings.hooks.Notification || [];
  settings.hooks.Stop = settings.hooks.Stop || [];

  // --clean · 先把历史装过的 tinker hook 全清掉 · 再下面正常装一份新的
  // 修历史 install bug 留下的重复 entry · 不影响用户自己装的 hook
  if (opts.clean) {
    for (const lifecycle of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'Stop']) {
      const arr = settings.hooks[lifecycle] || [];
      settings.hooks[lifecycle] = arr
        .map(entry => {
          if (!entry.hooks) return entry;
          entry.hooks = entry.hooks.filter(h => !h.command || !/\btinker\s/.test(h.command));
          return entry;
        })
        .filter(entry => entry.hooks && entry.hooks.length > 0);
    }
    log(sepia('  --clean · 已清掉旧 tinker hook entry · 下面重装一份干净的'));
  }

  // 命令:每个 lifecycle 都试一遍 (design-loop 优先 · 不命中再 learning · 都不命中静默退)
  const backfillCmd = 'tinker situation backfill --type design-loop --hours 4 --quiet 2>/dev/null || tinker situation backfill --type learning --hours 4 --quiet 2>/dev/null || true';

  // SessionStart matcher=compact · 用户 /compact 时触发
  installClaudeHookEntry(settings.hooks.SessionStart, 'compact', backfillCmd, 'compact');

  // v0.22 SessionStart (无 matcher · 每次 Claude Code 启动跑) · 看 inbox 有没有未处理 handoff
  // 有的话 stdout 注入 reminder · 让接收方 Claude 自动 load 接力现场
  installClaudeHookEntry(settings.hooks.SessionStart, null, 'tinker bridge-check-inbox 2>/dev/null || true', 'bridge-inbox');

  // SessionEnd · 用户 Cmd+Q 或 session 终止时触发
  installClaudeHookEntry(settings.hooks.SessionEnd, null, backfillCmd, 'session-end');

  // 砍掉收工时间提醒 (旧版 maybe-deep-summary hook) · 用户嫌"现在北京时间 X 点"那句烦
  // 旧版本装过的 · 这里主动摘除孤儿 entry · 让所有已安装的下次 install / update 自愈
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
    h => !(h && h.hooks && h.hooks.some(x => x.command && /tinker maybe-(deep-summary|goodnight)/.test(x.command)))
  );

  // v0.16 词典统一:matcher 词从 MAYBE_KINDS 拿 · 改词只动 MAYBE_KINDS 一处 · DRY
  // 跨 AI 通用入口 `tinker maybe-check --text "..."` 跟这里共用同一份词典
  // 6 组 maybe-X · 每组 matcher 词从 MAYBE_KINDS 取
  // kind camelCase → shell command kebab-case (cleverFix → clever-fix)
  const KIND_TO_CMD = { stuck: 'stuck', breakthrough: 'breakthrough', decision: 'decision', subtraction: 'subtraction', cleverFix: 'clever-fix', ship: 'ship', handoff: 'handoff', invite: 'invite' };
  for (const [kind, cfg] of Object.entries(MAYBE_KINDS)) {
    if (!cfg.matcher) continue;
    const cmdName = KIND_TO_CMD[kind];
    installClaudeHookEntry(settings.hooks.UserPromptSubmit, cfg.matcher, `tinker maybe-${cmdName} 2>/dev/null || true`, cmdName);
  }

  // v0.17 全局 UserPromptSubmit (无 matcher) · 每次用户 prompt 都 check pending reminders
  // post-commit hook 触发的 reminder 没人处理时 · 这里会注入 AI context · 让 AI 主动汇报
  // 顺手 notify-claude prompt 记这轮开始时间 (给 Stop 算耗时 · 只有长任务才弹通知) · 它 stdout 干净不污染 pending 注入
  installClaudeHookEntry(settings.hooks.UserPromptSubmit, null, 'tinker notify-claude prompt 2>/dev/null; tinker maybe-borrow-worked 2>/dev/null; tinker pending --check 2>/dev/null || true', 'pending-check');

  // 桌面通知 · Claude Code 要你确认权限 / 等你输入时弹 (matcher 限定 · 不噪)
  installClaudeHookEntry(settings.hooks.Notification, 'permission_prompt', 'tinker notify-claude notification 2>/dev/null || true', 'notify-permission');
  installClaudeHookEntry(settings.hooks.Notification, 'idle_prompt', 'tinker notify-claude notification 2>/dev/null || true', 'notify-idle');
  // 长任务跑完弹 · Stop 每轮都触发 · 但只有这轮超 60s 才弹 (notify-claude 内部判耗时)
  installClaudeHookEntry(settings.hooks.Stop, null, 'tinker notify-claude stop 2>/dev/null || true', 'notify-done');

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  if (opts.quiet) return;  // tinker update 升级后静默刷新时 · 不刷这一大段清单
  log('');
  ok('Claude Code hooks 装好了:');
  log(sepia('    SessionStart compact              · /compact 时'));
  log(sepia('    SessionStart bridge-inbox         · 每次启动 · 看 inbox 有未处理 handoff'));
  log(sepia('    SessionEnd                         · 关 Claude Code / 系统 sleep 时'));
  log(sepia('    UserPromptSubmit pending-check    · 每次用户 prompt · 检查 hook 触发的待处理 reminder'));
  log(sepia('    UserPromptSubmit stuck            · 说卡住类的话'));
  log(sepia('    UserPromptSubmit breakthrough     · 说顿悟类的话'));
  log(sepia('    UserPromptSubmit decision         · 做工具/方案选择'));
  log(sepia('    UserPromptSubmit subtraction      · 说砍 / 删类的话'));
  log(sepia('    UserPromptSubmit clever-fix       · 说搞通 / 跑通类的话'));
  log(sepia('    UserPromptSubmit ship             · 说完工 / 上线类的话'));
  log(sepia('    UserPromptSubmit handoff          · 说接力 / 交接给类的话 · 自动跑 tinker handoff'));
  log(sepia('    UserPromptSubmit invite           · 说邀请加入类的话 · 自动跑 tinker studio invite'));
  log(sepia('    Notification permission_prompt    · Claude Code 要你确认权限 · 弹桌面通知'));
  log(sepia('    Notification idle_prompt          · Claude Code 在等你输入 · 弹桌面通知'));
  log(sepia('    Stop notify-done                  · 长任务 (超 60s) 跑完 · 弹桌面通知'));
  log(sepia('  matcher 命中 → maybe-X 静默判断 → 输出 reminder 注入 AI 上下文 → AI 看上下文决定是否提醒'));
  log(sepia('  桌面通知走系统自带 (Mac osascript / Win 气泡 / Linux notify-send) · Mac 装了 terminal-notifier 更稳'));
  log('');
  log(sepia('  关:    ') + vermilion('tinker hook uninstall-claude'));
}

// helper · 装一个 Claude Code hook entry (匹配 matcher 或没 matcher 的全局 hook)
// 已存在我们装的 · 覆盖;别人的 · 附加(不重复);否则新建
function installClaudeHookEntry(arr, matcher, cmd, kind) {
  const existingIdx = matcher
    ? arr.findIndex(h => h && h.matcher === matcher)
    : arr.findIndex(h => h && !h.matcher);
  const newEntry = matcher
    ? { matcher, hooks: [{ type: 'command', command: cmd }] }
    : { hooks: [{ type: 'command', command: cmd }] };

  if (existingIdx >= 0) {
    const cur = arr[existingIdx];
    // 老 bug:isOurs 只看 'tinker situation' · 其他 maybe-X 装的 entry 都判 false · 走 push 累积 · 一次 install 多一份
    // 改成:任意一个 hook 命令是 tinker 自己的都算我们装的 · 覆盖而不是追加
    const isOurs = cur.hooks && cur.hooks.some(h => h.command && /\btinker\s/.test(h.command));
    if (isOurs) {
      arr[existingIdx] = newEntry;
    } else {
      cur.hooks = cur.hooks || [];
      if (!cur.hooks.some(h => h.command === cmd)) {
        cur.hooks.push({ type: 'command', command: cmd });
      }
    }
  } else {
    arr.push(newEntry);
  }
}

function cmdClaudeHookUninstall() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) { log(sepia('  没装 · 直接退')); return; }
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); }
  catch { err('settings.json 解析失败 · 手动看一下'); process.exit(1); }

  const before = JSON.stringify(settings);
  // 卸所有 lifecycle 里 tinker 自己装的 hook (命令含 "tinker ") · 别人装的不动
  for (const evt of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'Stop']) {
    const list = (settings.hooks && settings.hooks[evt]) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      list[i].hooks = (list[i].hooks || []).filter(h => !/\btinker\s/.test(h.command || ''));
      if (list[i].hooks.length === 0) list.splice(i, 1);
    }
  }

  if (JSON.stringify(settings) === before) {
    log(sepia('  没找到 Tinker hook · 没动'));
    return;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  ok('Claude Code hooks 删了 (所有 tinker hook · 含桌面通知)');
}

function cmdHookUninstall() {
  if (!inGitRepo()) { err('不在 git 仓库'); process.exit(1); }
  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim();
  // v0.13 卸 3 个 hooks
  let any = false;
  ['post-commit', 'post-push', 'post-checkout'].forEach(name => {
    if (uninstallSingleGitHook(gitDir, name)) any = true;
  });
  if (any) ok('hooks 移除了');
  else log(sepia('  没找到 tinker 的 hook 块'));
}

// v0.13 helper · 卸 marker 块
function uninstallSingleGitHook(gitDir, name) {
  const hookFile = path.join(gitDir, 'hooks', name);
  if (!fs.existsSync(hookFile)) return false;
  let content = fs.readFileSync(hookFile, 'utf-8');
  const before = content;
  content = content.replace(new RegExp(HOOK_BEGIN + '[\\s\\S]*?' + HOOK_END + '\\n?', 'g'), '');
  content = content.replace(/^.*tinker post-commit hook[\s\S]*?esac\s*\n/m, '');
  content = content.trimEnd();
  if (content === before.trimEnd()) return false;
  if (content === '#!/bin/sh' || content === '') {
    fs.unlinkSync(hookFile);
  } else {
    fs.writeFileSync(hookFile, content + '\n');
  }
  return true;
}

// === 触发器评估 ===
// 每个返回 { fired, priority, msg }; priority 大的优先 (高信号触发器盖低信号)
// 优先级表:
//   B keyword 100  · "我刚说我跑通了" 是最强信号
//   D first   60  · 早安式 · 不可错过
//   C silence 50  · 累了 commit 但没 push · 提醒
//   A cumul   30  · 默认 background · 防止整天不知不觉

// A · 60 min 内累积 commit 数 >= 阈值
function triggerCumulativeCommits(opts = {}, state) {
  // v0.2 #6: 一天只触发一次低优先级 · 防 first-commit / silence / cumulative 互相撞车
  if (state && state.lowFiredTodayKey === todayKey()) return { fired: false };
  const windowMin = opts.windowMin || 60;
  const threshold = opts.threshold || 3;
  try {
    const out = execSync(
      `git log --since="${windowMin} minutes ago" --no-merges --pretty=format:"%h"`,
      { encoding: 'utf-8' }
    ).trim();
    const count = out ? out.split('\n').length : 0;
    if (count >= threshold) {
      return { fired: true, priority: 30, count, reason: 'cumulative', msg: `今天累了 ${count} 个 commit (近 ${windowMin} 分钟)` };
    }
    return { fired: false };
  } catch { return { fired: false }; }
}

// B · 最近一条 commit 标题 (第一行) 含关键词 · 高信号
// 只看标题不看 body · body 里提到关键词 (比如"about 页讲的是卡住") 不算作者卡住
// 优先级:
//   FRUSTRATED 95 · 炸毛 / 破防 · 文案和选项跟其他都不一样
//   BREAKTHROUGH 95 · 顿悟时刻 · 最值得记
//   SHIP/STUCK/PROTOTYPE 100 · 显式仪式信号
//   FIX 80 · 修好了 · 说说这个坑
//   TINKER 70 · 在捣鼓 · 一句话说一下
//   DISCOVERY 70 · 学到 / 发现
function triggerKeywordMatch() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    if (!title) return { fired: false };
    // v0.2 #4: 加 commit body 第一行扫描 · 捕获"为什么这么改"的信号
    let bodyFirstLine = '';
    try {
      const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
      bodyFirstLine = (body.split('\n')[0] || '').trim();
    } catch {}
    const scanText = title + (bodyFirstLine ? '\n' + bodyFirstLine : '');
    const titleSnippet = '"' + title.slice(0, 50) + '"';

    // 检查顺序很重要 · 同时命中时早的先返回 · 跟 priority 不是一个概念
    // 排序逻辑:
    //   v0.90 FRUSTRATED 从这里搬走 · 改看 reflog 行为 (triggerFrustrationBehavior)
    //   原因: commit msg 是计划文字 · "靠 X 实现" 不是骂人 · "测试崩了" 不是个人崩溃
    //   SHIP / STUCK / PROTOTYPE · 显式仪式词 · 信号最直接 priority 100
    //   BREAKTHROUGH · "终于明白" 不含跑通 · 没被 SHIP 吃掉才到这 95
    //   DECISION · v0.2 新加 · 工具链选型 priority 85 · 比 fix 长期价值高
    //   FIX / TINKER / DISCOVERY · 弱信号最后

    // v0.91 conventional commit prefix 检测 · feat:/fix:/refactor: 等开头 = 技术叙述
    // 主要给 BRAND 用 · 避免项目作者自指误触发 · 其他触发器维持原判断
    const isConventionalCommit = /^(feat|fix|refactor|chore|docs|test|style|build|ci|perf|revert)(\([^)]+\))?:/i.test(title);

    // SHIP (仪式信号 · 完工) · 优先级 100 · 同时命中时盖过 BREAKTHROUGH
    // v0.91 砍 merged? (git merge 高频) / done|finished? (多义) / 发布|完成 (描述性)
    // 留显式仪式词 · 真完工才命中
    const SHIP_WORDS = /(\bship(?:ped|s|it)?\b|\bdeployed?\b|\breleased?\b|\blaunch(?:ed)?\b|\brolled out\b|完工|跑通|上线|上架)/i;
    if (SHIP_WORDS.test(scanText)) {
      return { fired: true, priority: 100, reason: 'keyword-ship', kind: 'ship', msg: `像完工的 commit: ${dim(titleSnippet)}`, suggestion: '要不要进陈列馆 · 写一句感想' };
    }

    // STUCK (技术性卡住 · 不像 FRUSTRATED 那么情绪化)
    // v0.91 砍 hotfix (是 commit prefix 不是状态)
    const STUCK_WORDS = /(\bstuck\b|卡住|卡了|卡在|\bbroken\b|挂了|不对劲|出问题|报错了|\bblocker\b)/i;
    if (STUCK_WORDS.test(scanText)) {
      return { fired: true, priority: 100, reason: 'keyword-stuck', kind: 'stuck', msg: `像卡住的 commit: ${dim(titleSnippet)}`, suggestion: '要不要标卡住 · 让在意的人看到' };
    }

    // PROTOTYPE
    // v0.91 砍 demo (demo 数据 / demo 视频高频)
    const PROTO_WORDS = /(\bprototype\b|原型|\bmockup\b)/i;
    if (PROTO_WORDS.test(scanText)) {
      return { fired: true, priority: 100, reason: 'keyword-prototype', kind: 'prototype', msg: `像原型节点的 commit: ${dim(titleSnippet)}`, suggestion: '要不要把原型挂上 · 顺便记一笔' };
    }

    // BREAKTHROUGH · "终于明白 / 想清楚了" · 没被 SHIP 吃掉的顿悟时刻
    // v0.91 砍 clicked (UI 词高频) / got it (太宽泛) · 修了 done|done 重复 bug
    const BREAKTHROUGH_WORDS = /(终于(?:明白|搞清|搞定|想通|懂了)|搞清楚了|想清楚了|想通了|想明白了|顿悟|\baha\b|\bfinally\b(?!\s+(?:ship|done)))/i;
    if (BREAKTHROUGH_WORDS.test(scanText)) {
      return { fired: true, priority: 95, reason: 'keyword-breakthrough', kind: 'progress', msg: `像顿悟的 commit: ${dim(titleSnippet)}`, suggestion: '这种十秒钟很难复现 · 一笔留下来吧' };
    }

    // v0.2 #1 DECISION · 工具链选型 · 长期记得起来比 fix 重要
    // v0.91 砍 升级|降级|引入(了)?|移除(了)?|去掉了|选了 (高频日常依赖管理 · 不是工具链决策)
    // 留明确动词性决策: adopt / switch to / migrate to / 换成 / 改用 / 切到 / 采用 / 放弃 等
    const DECISION_WORDS = /(\badopt(?:ed|ing)?\b|\bswitch(?:ed|ing)?\s+to\b|\bmov(?:e|ed|ing)\s+to\b|\bmigrat(?:e|ed|ing)\s+to\b|\bstop\s+using\b|\bdeprecat(?:e|ed|ing)\b|装(?:了|上)|装上|换成|改用|不再用|不用了|切到|切换到|定下来|决定用|采用|放弃(?:了)?|改回)/i;
    if (DECISION_WORDS.test(scanText)) {
      return { fired: true, priority: 85, reason: 'keyword-decision', kind: 'decision', msg: `像工具链决策的 commit: ${dim(titleSnippet)}`, suggestion: '这种决策几个月后自己都想不起为什么 · 记一笔吧' };
    }

    // v0.91 FIX 触发器整体砍 (§12 砍 > 加)
    // 原因: 每个 fix:/fix(scope): commit 都命中 · 最大疲劳源
    // 真值钱的 fix 会自动被 BREAKTHROUGH ("终于搞定") / DECISION ("换成 X 修了") 抓走
    // 普通 fix 不需要 prompt · 违反 §10 不烦人精神

    // BRAND_MENTION · "捣鼓" / "Tinker" 出现 = 品牌 engagement 信号
    // 设计:全世界除了 Tinker 社区谁会写"捣鼓" · 一旦出现就大概率关于我们
    // v0.91 加自指守卫: conventional commit prefix 开头 + 看 git remote 是 tinker repo → 跳过
    // 项目作者在自己 repo 里 commit 含"捣鼓" = 必然 · 不算品牌 mention
    let isOwnTinkerRepo = false;
    try {
      const remote = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      isOwnTinkerRepo = /tinker/i.test(remote);
    } catch {}
    const BRAND_WORDS = /(捣鼓|\btinker\b)/i;
    if (BRAND_WORDS.test(scanText) && !(isConventionalCommit && isOwnTinkerRepo)) {
      return { fired: true, priority: 75, reason: 'keyword-brand', kind: 'brand', msg: `commit 里有"捣鼓": ${dim(titleSnippet)}`, suggestion: '这是关于 Tinker 的什么?' };
    }

    // v0.91 TINKER 触发器整体砍 (§12 砍 > 加)
    // 原因: "玩了/弄了/搞了/折腾/试了" 全是日常虚词 · 无独占价值
    // 真有趣的探索会被 DISCOVERY / PROTOTYPE / BREAKTHROUGH 抓走
    // 留 TINKER 只是噪音 · priority 70 实际命中率高但价值低

    // DISCOVERY (发现 / 学到)
    // v0.91 砍 原来 (太宽 "原来在这"/"原来配置错了")
    const DISCOVERY_WORDS = /(发现|意识到|才知道|学到|学了|理解了|\blearned\b|\brealized?\b|\bdiscovered?\b|\bturns out\b)/i;
    if (DISCOVERY_WORDS.test(scanText)) {
      return { fired: true, priority: 70, reason: 'keyword-discovery', kind: 'progress', msg: `像学到东西的 commit: ${dim(titleSnippet)}`, suggestion: '学到 / 发现了什么? 给别人看看' };
    }

    return { fired: false };
  } catch { return { fired: false }; }
}

// C · 长时间没发 update + 累了 commit · 需要 state 里有 lastPushAt 才能判断
// === 幂等性 · 给 AI agent 重试不重复 push ===
// 客户端缓存 · 24h TTL · 同 key 直接返之前的响应
const IDEM_CACHE_FILE = path.join(CONFIG_DIR, 'idem-cache.json');
const IDEM_TTL_MS = 24 * 60 * 60 * 1000;
function loadIdemCache() { return loadJsonSafe(IDEM_CACHE_FILE, {}); }
function saveIdemCache(cache) { saveJsonSafe(IDEM_CACHE_FILE, cache); }
function idemGet(key) {
  if (!key) return null;
  const cache = loadIdemCache();
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.at > IDEM_TTL_MS) {
    delete cache[key];
    saveIdemCache(cache);
    return null;
  }
  return entry.response;
}
function idemSet(key, response) {
  if (!key) return;
  const cache = loadIdemCache();
  // 清掉过期的 (顺手)
  const now = Date.now();
  for (const k of Object.keys(cache)) {
    if (now - cache[k].at > IDEM_TTL_MS) delete cache[k];
  }
  cache[key] = { at: now, response };
  saveIdemCache(cache);
}
// 包装 API 动作 · key 重复直接返缓存
async function withIdempotency(key, fn) {
  if (!key) return fn();
  const cached = idemGet(key);
  if (cached) return { ...cached, idempotent: true, cacheHit: true };
  const result = await fn();
  idemSet(key, result);
  return result;
}

// === drift 检测 · 跨 repo · 用户说在做 A 但实际在折腾 B ===
// 数据来源: ~/.tinker/repos.json · 所有 tinker hook install 过的 repo
// 算法: 拉所有注册 repo 今天 commit 数 · 如果当前 repo 占比 < 30% 且有别的 > 50% · 触发
const REPOS_REGISTRY_FILE = path.join(CONFIG_DIR, 'repos.json');
function loadReposRegistry() { return loadJsonSafe(REPOS_REGISTRY_FILE, {}); }
function saveReposRegistry(reg) { saveJsonSafe(REPOS_REGISTRY_FILE, reg); }
function registerRepoForDrift(repoPath, repoCfg) {
  const reg = loadReposRegistry();
  reg[repoPath] = {
    projectId: repoCfg.projectId,
    projectName: repoCfg.projectName,
    registeredAt: Date.now(),
  };
  saveReposRegistry(reg);
}
function triggerCrossRepoDrift(state, currentRepoCfg) {
  if (state && state.lowFiredTodayKey === todayKey()) return { fired: false };
  if (!currentRepoCfg) return { fired: false };
  const reg = loadReposRegistry();
  const regPaths = Object.keys(reg);
  if (regPaths.length < 2) return { fired: false };  // 只有 1 个 repo 没法 drift
  const cwd = process.cwd();
  const since = beijingSinceISO(0, 4);
  // 算每个 registered repo 今日 commit 数 (北京时间 4am 起)
  const counts = {};
  let total = 0;
  for (const p of regPaths) {
    try {
      if (!fs.existsSync(path.join(p, '.git'))) continue;
      const out = execSync(`git log --since="${since}" --no-merges --pretty=format:"%h"`, { cwd: p, encoding: 'utf-8' }).trim();
      const c = out ? out.split('\n').length : 0;
      counts[p] = c;
      total += c;
    } catch { counts[p] = 0; }
  }
  if (total < 3) return { fired: false };  // 总量太小不算
  const currentCount = counts[cwd] || 0;
  const currentRatio = currentCount / total;
  if (currentRatio >= 0.30) return { fired: false };  // 当前 repo 占比够 · 没 drift
  // 找占比最高的别的 repo
  let other = null, otherCount = 0;
  for (const [p, c] of Object.entries(counts)) {
    if (p !== cwd && c > otherCount) { other = p; otherCount = c; }
  }
  if (!other || otherCount / total < 0.50) return { fired: false };
  const otherInfo = reg[other];
  return {
    fired: true,
    priority: 65,
    reason: 'cross-repo-drift',
    kind: 'progress',
    msg: `今天主要在 ${dim('"' + (otherInfo.projectName || path.basename(other)) + '"')} 干活 (${otherCount}/${total} commits) · 这边 ${currentRepoCfg.projectName} 只占 ${currentCount}/${total}`,
    suggestion: `要不切到那边记一笔 · 还是这边其实没动 (那这一笔可能不发就好)`,
  };
}

function triggerLongSilence(state, repoCfg) {
  if (!repoCfg) return { fired: false };
  // v0.2 #6: 一天只触发一次低优先级
  if (state && state.lowFiredTodayKey === todayKey()) return { fired: false };
  const last = (state.lastPushAtByProject || {})[repoCfg.projectId];
  if (!last) return { fired: false };  // 第一次 install · 不算 silence
  const HOURS = 24;
  if (Date.now() - last < HOURS * 60 * 60 * 1000) return { fired: false };
  // 这段时间有 commit 才算
  try {
    const out = execSync(
      `git log --since="${Math.floor((Date.now() - last) / 1000)} seconds ago" --no-merges --pretty=format:"%h"`,
      { encoding: 'utf-8' }
    ).trim();
    const count = out ? out.split('\n').length : 0;
    if (count === 0) return { fired: false };
    const hours = Math.floor((Date.now() - last) / 3600 / 1000);
    return { fired: true, priority: 50, reason: 'silence', count, hours, msg: `${hours} 小时没发进展了 · 这段时间累了 ${count} 个 commit` };
  } catch { return { fired: false }; }
}

// v0.5 高价值瞬间触发器 · 不只识别 commit 模式 · 识别"对社区有沉淀价值的瞬间"

// 巧妙修复 · fix 关键词 + diff 小 + commit body 长
// 作者花时间解释"为什么这么修" 但代码只动几行 · 大概率是巧妙修法
// 对社区价值 ★★★ · 别人撞到同样坑能直接学
function triggerCleverFix() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    const FIX_WORDS_LOCAL = /(\bfix(?:ed|es|ing)?\b|\bpatch(?:ed)?\b|\bworkaround\b|修好|修了|搞定|解决了|处理了|绕过|绕开)/i;
    if (!FIX_WORDS_LOCAL.test(scanText)) return { fired: false };
    // body 必须够长 (作者花时间解释)
    if (body.length < 100) return { fired: false };
    // diff 净改动 < 30 行
    let ins = 0, del = 0;
    try {
      const statOut = execSync('git diff HEAD~1 HEAD --shortstat 2>/dev/null', { encoding: 'utf-8' }).trim();
      const insMatch = statOut.match(/(\d+) insertion/);
      const delMatch = statOut.match(/(\d+) deletion/);
      ins = insMatch ? parseInt(insMatch[1], 10) : 0;
      del = delMatch ? parseInt(delMatch[1], 10) : 0;
    } catch {}
    const netChange = ins + del;
    if (netChange === 0 || netChange > 30) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 90,
      reason: 'clever-fix',
      kind: 'clever-fix',
      msg: `像巧妙修法的 commit (${netChange} 行改动 · body ${body.length} 字): ${dim(titleSnippet)}`,
      suggestion: '这个修法看起来挺巧 · 别人撞到类似坑能学',
    };
  } catch { return { fired: false }; }
}

// 减法决策 · 删 >> 加 或 含"砍/删/不用了/撤回/revert"
// 工程师圈极少见 · 减掉东西比加东西难 · 这种经验稀缺
// 对社区价值 ★★★ · 最反直觉的决策
function triggerSubtraction() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + (body.split('\n')[0] || '');
    // 关键词模式
    const SUBTRACTION_WORDS = /(\bremov(?:e|ed|ing)\b|\bdrop(?:ped|ping)?\b|\bdelet(?:e|ed|ing)\b|\brevert(?:ed|ing)?\b|\bcleanup\b|\bsimplif(?:y|ied|ication)\b|砍(?:了|掉)|删了|不用了|撤回|去掉了|移除|简化|抽掉)/i;
    const wordMatch = SUBTRACTION_WORDS.test(scanText);
    // diff stats (删 > 加 × 3 且至少删 30 行避免微小 cleanup 误触)
    let ins = 0, del = 0;
    try {
      const statOut = execSync('git diff HEAD~1 HEAD --shortstat 2>/dev/null', { encoding: 'utf-8' }).trim();
      const insMatch = statOut.match(/(\d+) insertion/);
      const delMatch = statOut.match(/(\d+) deletion/);
      ins = insMatch ? parseInt(insMatch[1], 10) : 0;
      del = delMatch ? parseInt(delMatch[1], 10) : 0;
    } catch {}
    const statMatch = del > ins * 3 && del > 30;
    if (!wordMatch && !statMatch) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 85,
      reason: 'subtraction',
      kind: 'subtraction',
      msg: `像减法决策的 commit (删 ${del} · 加 ${ins}): ${dim(titleSnippet)}`,
      suggestion: '减了不少 · 说说为什么砍掉这些 · 减法决策最难学',
    };
  } catch { return { fired: false }; }
}

// AI 边界经验 · 含 AI 工具名 + 含边界词
// vibe coder 最需要的经验:这个 AI 在什么场景行/不行 · 怎么绕
// 对社区价值 ★★★ · alpha 期最贵的"手艺"
function triggerAiLimit() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    // AI 工具名 · 大小写不敏感
    const AI_TOOL_WORDS = /(\bclaude(?:\s*code)?\b|\bcodex\b|\bcursor\b|\bcopilot\b|\bdeepseek\b|\bchatgpt\b|\bgpt[-]?4?o?\b|\bo[34]\b|\bgemini\b|\bbolt\b|\blovable\b|\bv0\b|\breplit\b|\bwindsurf\b|\btrae\b)/i;
    // 边界词 · 表明 AI 这次有局限
    const LIMIT_WORDS = /(绕过|没想到|不行|失败|局限|还得自己|手写|搞错|搞不定|搞砸|装大佬|乱编|说反|理解错|脑补|hallucinat|made\s*up|got\s*confused|infinite\s*loop|too\s*many\s*token|context\s*limit|忽略了|漏掉|蒙了|犟|拗|改了\s*\d+\s*[次回轮版])/i;
    const toolMatch = AI_TOOL_WORDS.test(scanText);
    const limitMatch = LIMIT_WORDS.test(scanText);
    if (!toolMatch || !limitMatch) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 85,
      reason: 'ai-limit',
      kind: 'ai-limit',
      msg: `像 AI 边界经验的 commit: ${dim(titleSnippet)}`,
      suggestion: 'AI 这次的边界经验 · 别人会用得上 · vibe coder 最需要这种',
    };
  } catch { return { fired: false }; }
}

// v0.7 又 7 个高价值瞬间触发器 · 补足"对社区有沉淀价值的瞬间"

// 重启 · 项目沉默 7+ 天后第一条 commit
// 跟 silence (22h 没发但有 commit) 不同 · 这是"放弃后回来"的经验
// 对社区价值 ★★ · 别人也常有这种时刻
function triggerRestart() {
  try {
    const out = execSync('git log -2 --pretty=%ct', { encoding: 'utf-8' }).trim();
    const lines = out.split('\n');
    if (lines.length < 2) return { fired: false };  // 第一条 commit 不算
    const now = parseInt(lines[0], 10) * 1000;
    const prev = parseInt(lines[1], 10) * 1000;
    const gap = now - prev;
    if (gap < 7 * 24 * 60 * 60 * 1000) return { fired: false };
    const days = Math.floor(gap / 86400000);
    return {
      fired: true,
      priority: 80,
      reason: 'restart',
      kind: 'restart',
      msg: `沉了 ${days} 天后又动了 · 这条是回来后第一个 commit`,
      suggestion: '回来了 · 说说这段时间想清楚了什么 / 为什么回来',
    };
  } catch { return { fired: false }; }
}

// 工具组合发现 · commit msg 含 2+ AI 工具名 + 创作词
// 手艺组合是 vibe coder 最珍贵的事 · 单工具好用大家都会 · 组合才是手艺
// v0.13 触发器: 这次 commit 改了 docs/*.md 类的文档
// vibe coder 的文档基本都是 AI 写给 AI 看的 · 直接建议 contribute --auto
// 让 LLM 挑段 · 用户一句 "好" 就发了 · 不用打开文件
//
// 不触发的情况:
// - 改的是 README / CHANGELOG / LICENSE 这种太通用的
// - md 总改动行数 <30 (typo 修复不值得整段 contribute)
function triggerDocsEdit() {
  try {
    // git show 列文件 · 对 initial commit 也工作 (diff-tree 在 root commit 返空)
    const files = execSync('git show --name-only --format= HEAD', { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    const COMMON_DOCS = /^(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|AUTHORS)\.md$/i;
    const mdFiles = files.filter(f => /\.md$/i.test(f) && !COMMON_DOCS.test(path.basename(f)));
    if (mdFiles.length === 0) return { fired: false };
    // 看改动 size · typo 不值得 contribute
    const stat = execSync('git show --stat=200 HEAD -- ' + mdFiles.map(f => '"' + f + '"').join(' '), { encoding: 'utf-8' }).trim();
    const totalChanged = (stat.match(/(\d+) (?:insertions?|deletions?)/g) || [])
      .reduce((s, m) => s + parseInt(m.match(/(\d+)/)[1], 10), 0);
    if (totalChanged < 30) return { fired: false };
    const target = mdFiles[0];
    return {
      fired: true,
      priority: 78,
      reason: 'docs-edit',
      kind: 'docs-contribute',
      msg: `改了 ${dim(target)}${mdFiles.length > 1 ? ' (+' + (mdFiles.length - 1) + ' 个 md)' : ''} · +/- ${totalChanged} 行`,
      suggestion: '让 AI 帮挑一段分享出去 · ' + vermilion('tinker contribute --from-file ' + target + ' --auto'),
    };
  } catch { return { fired: false }; }
}

function triggerToolCombo() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    const AI_TOOLS = ['claude', 'codex', 'cursor', 'copilot', 'deepseek', 'chatgpt', 'gpt', 'gemini', 'bolt', 'lovable', 'replit', 'windsurf', 'trae', 'v0', 'kimi', '通义', '豆包', '文心'];
    const found = [];
    AI_TOOLS.forEach(t => {
      const re = new RegExp('\\b' + t + '(?:\\s*code)?\\b', 'i');
      if (re.test(scanText)) found.push(t);
    });
    if (found.length < 2) return { fired: false };
    const CREATIVE_WORDS = /(做了|加了|写了|配合|一起|搭配|换\s*用|改用|结合|串|接)/i;
    if (!CREATIVE_WORDS.test(scanText)) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 80,
      reason: 'tool-combo',
      kind: 'tool-combo',
      msg: `用了 ${found.join(' + ')} · ${dim(titleSnippet)}`,
      suggestion: '工具组合是 vibe coder 最贵的手艺 · 这个组合怎么搭的',
    };
  } catch { return { fired: false }; }
}

// 跨项目借鉴 · commit 含"借鉴 / 仿照 / 像 X 那样" 等
// 手艺谱系信号 · vibe coder 之间学手艺的网状
function triggerCrossProject() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    const REF_WORDS = /(借鉴|仿照|模仿|参考|学(?:了|过|的是)|像\s*\S+\s*(?:那样|一样|的做法)|套了\s*\S+\s*的|拿\s*\S+\s*的|从\s*\S+\s*学|copy(?:ed|ing)?\s+from|inspired\s+by)/i;
    if (!REF_WORDS.test(scanText)) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 75,
      reason: 'cross-project',
      kind: 'cross-project',
      msg: `像借鉴别人作品的 commit: ${dim(titleSnippet)}`,
      suggestion: '借鉴谁的什么 · 怎么改用到自己项目',
    };
  } catch { return { fired: false }; }
}

// 长 commit body 兜底 · body > 200 字 + 其他触发器都没命中
// 作者花时间写 = 觉得值得记 · 简单粗暴但有效
// priority 65 · 比其他都低 · 只在其他都没命中时兜底
function triggerLongBody() {
  try {
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    if (body.length < 200) return { fired: false };
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 65,
      reason: 'long-body',
      kind: 'long-body',
      msg: `这条 commit 你写了 ${body.length} 字 · 用心了: ${dim(titleSnippet)}`,
      suggestion: '作者花时间写的事一般值得记 · 顺手记一笔吧',
    };
  } catch { return { fired: false }; }
}

// 测试 / 验证发现 · commit 加了测试文件 + commit msg 含验证词
// 别人不用再重复实验 · 验证 == 缩短全社区的探索时间
function triggerTestVerify() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + (body.split('\n')[0] || '');
    const VERIFY_WORDS = /(试了|验证|跑通|测试|确认|实测|实验|检验|\btest(?:ed|s)?\b|\bverify\b|\bconfirm\b)/i;
    if (!VERIFY_WORDS.test(scanText)) return { fired: false };
    let hasTestFile = false;
    try {
      const files = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
      const TEST_FILE_RE = /(^|\/)tests?\/|_test\.[a-z]+$|\.test\.[a-z]+$|\.spec\.[a-z]+$|^test_[^\/]+\.[a-z]+$/i;
      hasTestFile = files.split('\n').some(f => TEST_FILE_RE.test(f));
    } catch {}
    if (!hasTestFile) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 75,
      reason: 'test-verify',
      kind: 'test-verify',
      msg: `加了测试 · 验证了什么: ${dim(titleSnippet)}`,
      suggestion: '别人不用再重复 · 说说这次验证了什么 + 结果',
    };
  } catch { return { fired: false }; }
}

// 命名 / 概念灵感 · commit 含改名词 或 文件改名
// 命名是创造力的体现 · 重要的命名值得记
function triggerNaming() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    const NAME_WORDS = /(改名|改叫|重命名|改成叫|换个名|叫\s*\S+\s*不叫|名字\s*改|\brename(?:d|ing)?\b)/i;
    const wordMatch = NAME_WORDS.test(scanText);
    let renamedFiles = false;
    try {
      const status = execSync('git diff --name-status HEAD~1 HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
      renamedFiles = /^R\d+\s/m.test(status);
    } catch {}
    if (!wordMatch && !renamedFiles) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 70,
      reason: 'naming',
      kind: 'naming',
      msg: `像改名 / 重命名的 commit: ${dim(titleSnippet)}`,
      suggestion: '命名是创造力 · 为什么换这个名 / 之前哪里不对',
    };
  } catch { return { fired: false }; }
}

// 反向选择 · 撤回的勇气 · 跟 subtraction 不同
// subtraction = 砍掉东西 (减法决策)
// reversal = 撤回决定 (回退 / 改回 / 走不通 / 想错了)
// 这种"承认走错了"的经验 · 比 ship 更稀缺
function triggerReversal() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    const REVERSAL_WORDS = /(\brevert(?:ed|ing)?\b|\bundo(?:ne)?\b|\broll\s*back\b|撤回|回退|改回|还原|放弃了|认怂|认输|这条路不通|走不通|想错了|想反了|算了不|删掉那条|走错路|绕了弯路)/i;
    if (!REVERSAL_WORDS.test(scanText)) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 85,
      reason: 'reversal',
      kind: 'reversal',
      msg: `像撤回 / 改回的 commit: ${dim(titleSnippet)}`,
      suggestion: '撤回需要勇气 · 说说一开始为什么选 X / 后来为什么改回',
    };
  } catch { return { fired: false }; }
}

// v0.12 跨上下文触发器 · v0.13 升级成 lifecycle 通用 (struggle + learning)
// 命中条件:state.currentStruggle 刚 resolved (5min 内) + 当前 commit 形态匹配 lifecycle 收尾词
// 对社区价值 ★★★★ · vibe coder 时代最稀缺的"踩坑经验" / "上手指南"
function triggerAiDebugBreakthrough() {
  try {
    const state = loadPromptState();
    const cur = state.currentStruggle;
    if (!cur || !cur.resolved || !cur.justResolvedAt) return { fired: false };
    if (Date.now() - cur.justResolvedAt > 5 * 60 * 1000) return { fired: false };

    const lifecycleType = cur.lifecycleType || 'struggle';
    const isLearning = lifecycleType === 'learning';
    const isDesignLoop = lifecycleType === 'design-loop';
    const struggleMod = (() => { try { return require('../lib/struggle'); } catch { return null; } })();
    const config = struggleMod && struggleMod.LIFECYCLE_CONFIGS[lifecycleType];

    // 当前 commit 必须匹配收尾形态
    // struggle: fix 类 + diff < 50 行 (长 debug 最终小修复的特征)
    // learning: done / setup / wired up / 跑通了 类 + diff 不限大小 (新东西从 0 开始就是大改)
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;

    if (isLearning) {
      // learning 出口词:跑通 / 配通 / hello world / 接通 / 初次 / 第一个 / 入门完成
      const LEARNING_DONE = /(跑通|配通|接通|hello\s*world|跑起来|跑出来|搞通|搞懂|入门完成|第一个.*跑|setup.*done|wired up|integrated|got it working|first.*working)/i;
      if (!LEARNING_DONE.test(scanText)) return { fired: false };
    } else if (isDesignLoop) {
      // design-loop 没有特定 commit 形态约束 · 推演不一定 commit code
      // 状态机已经看 Claude 对话的"决策词" 判断 resolved · 这里不再约束
    } else {
      const FIX_WORDS = /(\bfix(?:ed|es|ing)?\b|\bpatch(?:ed)?\b|\bworkaround\b|修好|修了|搞定|搞通|跑通|通了|解决了|绕过|绕开)/i;
      if (!FIX_WORDS.test(scanText)) return { fired: false };

      let ins = 0, del = 0;
      try {
        const statOut = execSync('git diff HEAD~1 HEAD --shortstat 2>/dev/null', { encoding: 'utf-8' }).trim();
        const insMatch = statOut.match(/(\d+) insertion/);
        const delMatch = statOut.match(/(\d+) deletion/);
        ins = insMatch ? parseInt(insMatch[1], 10) : 0;
        del = delMatch ? parseInt(delMatch[1], 10) : 0;
      } catch {}
      const netChange = ins + del;
      if (netChange === 0 || netChange > 50) return { fired: false };
    }

    // 检查 autopsy 草稿是否就绪 · prefix 跟 lifecycle 一致
    const draftDir = path.join(process.cwd(), '.tinker', 'drafts');
    const draftPrefix = config ? config.draftPrefix : 'experience';
    let draftReady = null;
    if (fs.existsSync(draftDir)) {
      const drafts = fs.readdirSync(draftDir)
        .filter(f => f.startsWith(draftPrefix + '-') && f.endsWith('.md'));
      if (drafts.length > 0) {
        const newest = drafts
          .map(f => ({ f, mtime: fs.statSync(path.join(draftDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)[0];
        if (newest.mtime >= (cur.endedAt || cur.justResolvedAt)) {
          draftReady = newest.f;
        }
      }
    }

    const spanHours = cur.endedAt && cur.startedAt
      ? Math.max(0.1, Math.round((cur.endedAt - cur.startedAt) / 360000) / 10)
      : '?';
    const topic = cur.topic || (isLearning ? '这次学的东西' : '这次折腾');
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    const sigCount = (cur.signals || []).length;
    const triggerKind = config ? config.triggerKind : 'ai-debug-breakthrough';
    const productTag = config ? config.productTag : 'experience';
    const msg = isLearning
      ? `「${topic}」上手了 · 跨 ${spanHours}h · ${sigCount} 条信号 · 完成: ${dim(titleSnippet)}`
      : isDesignLoop
      ? `「${topic}」推演定下来了 · 跨 ${spanHours}h · ${sigCount} 条信号`
      : `「${topic}」破局了 · 跨 ${spanHours}h · ${sigCount} 条信号 · 修复: ${dim(titleSnippet)}`;

    return {
      fired: true,
      priority: 92,
      reason: triggerKind,
      kind: triggerKind,
      msg,
      suggestion: draftReady
        ? `草稿已自动整理: .tinker/drafts/${draftReady} · tinker push <file> --as-${productTag} 一键发`
        : (isLearning
            ? '这次上手过程写出来能帮到下一个人 · 草稿后台整理中'
            : isDesignLoop
            ? '这次推演沉淀下来给后人学 product sense 用 · 草稿后台整理中'
            : '这种坑写出来能帮到下一个人 · 包括其他 AI · 草稿后台整理中'),
      autopsyDraft: draftReady ? path.join(draftDir, draftReady) : null,
      struggleId: cur.id,
      lifecycleType,
      productTag,
    };
  } catch { return { fired: false }; }
}

// D · 当天首次 commit · 早安式
function triggerFirstCommitOfDay(state) {
  // v0.2 #6: 一天只触发一次低优先级 · 避免 first-commit 被后续 cumulative 抢走
  if (state && state.lowFiredTodayKey === todayKey()) return { fired: false };
  try {
    // "今天" 从北京时间凌晨 4 点开始算 · 跟 mute 'today' 的语义对齐 · 熬夜 coder 友好
    const since = beijingSinceISO(0, 4);
    const out = execSync(
      `git log --since="${since}" --no-merges --pretty=format:"%h"`,
      { encoding: 'utf-8' }
    ).trim();
    const count = out ? out.split('\n').length : 0;
    if (count !== 1) return { fired: false }; // 不是首条不触发
    return { fired: true, priority: 60, reason: 'first-commit', msg: '早 · 今天首条 commit', suggestion: '想了想要做什么了吗? 写一笔规划自己听' };
  } catch { return { fired: false }; }
}

// v0.90 行为信号 FRUSTRATED · 替代 v0.2 keyword-frustrated 列表
// 老设计看 commit msg · 但 commit msg 是计划写出来的描述文字 · 不是当下情绪
// "靠 X 实现" 的"靠"会被当骂人 · "测试崩了"的"崩"会被当个人崩溃 · 误触发率天花板
// 真破防的人短时间会 reset --hard / amend 反复 / revert 来回 · 这才是行为信号
function triggerFrustrationBehavior() {
  try {
    const out = execSync('git reflog --date=unix -n 100', { encoding: 'utf-8' }).trim();
    if (!out) return { fired: false };
    const windowMs = 30 * 60 * 1000; // 30 分钟密度窗口
    const now = Date.now();
    const minThreshold = 3;
    let undoCount = 0;
    let hardResetCount = 0;
    for (const line of out.split('\n')) {
      // 格式: <sha> HEAD@{<unix_ts>}: <action>
      const m = line.match(/HEAD@\{(\d+)\}:\s*(.+)$/);
      if (!m) continue;
      const ts = parseInt(m[1], 10) * 1000;
      if (now - ts > windowMs) break; // reflog 时间倒序 · 越窗口就停
      const op = m[2];
      // 撤销类: reset / commit (amend) / revert · 真"卷在哪了"的信号
      if (/^reset:/.test(op) || /^commit \(amend\)/.test(op) || /^revert:/.test(op)) {
        undoCount++;
        if (/^reset:/.test(op)) hardResetCount++;
      }
    }
    if (undoCount >= minThreshold) {
      const what = hardResetCount >= 2
        ? `reset 来回 ${hardResetCount} 次`
        : `${undoCount} 次撤销操作`;
      return {
        fired: true,
        priority: 101,
        reason: 'behavior-undo-spree',
        kind: 'frustrated',
        msg: `近 30 分钟 ${what} · 卡在哪了`,
        suggestion: '不打分。不告诉别人。看你想怎么处理。'
      };
    }
    return { fired: false };
  } catch { return { fired: false }; }
}

// === UI session 管理 ===
// 设计:一波 UI 改动当成一个 session 整体看 · 不每个 commit 都问
// 起点: 第一个 UI commit (无 session 时) · 抓 BEFORE 快照 · 静默
// 结束: 60min 时间窗 / 6 个 UI commit / 当前 commit 含 ship/done/完工 任一
// 当前 commit 非 UI / 在 session 中: 静默 · 继续等结束
// UI 文件判定 · 要么明确路径 (webapp/, components/, pages/, views/, frontend/, ui/, styles/, client/)
// 要么明确 UI 后缀 (HTML / CSS / SCSS / LESS / .tsx / .jsx / .vue / .svelte / .astro)
// 不匹配光秃秃的 .js / .ts (它们更多是后端 / CLI / 工具代码)
const UI_FILE_PATTERN = /(^|\/)(webapp|components|pages|views|frontend|ui|styles|client)\/|\.html?$|\.css$|\.scss$|\.sass$|\.less$|\.styl$|\.tsx$|\.jsx$|\.vue$|\.svelte$|\.astro$/i;
const UI_MSG_PATTERN = /(\bui\b|\bstyle\b|\bcss\b|\bvisual\b|样式|排版|视觉|界面|布局|配色|按钮|字体|颜色|动效|交互|UI)/i;
const SESSION_END_KEYWORDS = /(\bship(?:ped|s|it)?\b|\bdone\b|\bdeployed?\b|\breleased?\b|完工|跑通|上线|发布)/i;

function commitIsUi() {
  // 用 git diff 拿这次 commit 的文件 · 任一 match UI_FILE_PATTERN 就算
  try {
    const files = execSync('git diff --name-only HEAD^ HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (files && files.split('\n').some(f => UI_FILE_PATTERN.test(f))) return true;
  } catch {}
  // 补救:commit msg 直接说了 UI
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    return UI_MSG_PATTERN.test(title);
  } catch { return false; }
}

function evaluateUiSession(state, cfg) {
  const now = Date.now();
  const isUi = commitIsUi();
  const session = state.uiSession;
  let title = '';
  try { title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim(); } catch {}

  // 无 session
  if (!session) {
    if (!isUi) return { fired: false };  // 啥也不做
    // 启动 session · 抓 before 快照 · 静默
    let sha = ''; try { sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim(); } catch {}
    const snapPath = takeBeforeSnapshot(cfg, sha);  // 同步阻塞 (~3-5s) · 可以接受 (在 hook 里)
    state.uiSession = {
      startedAt: now,
      startCommitHash: sha,
      lastUiCommitAt: now,
      commitCount: 1,
      beforeSnapshotPath: snapPath,
    };
    return { fired: false, sessionStarted: true };
  }

  // 有 session · 评估是否该结束
  const elapsed = now - session.startedAt;
  const timeExpired = elapsed > 60 * 60 * 1000;
  const tooMany = session.commitCount >= 6;
  const shipKeyword = SESSION_END_KEYWORDS.test(title);
  const shouldEnd = timeExpired || tooMany || shipKeyword;

  if (!shouldEnd) {
    // 继续 session
    if (isUi) {
      session.commitCount++;
      session.lastUiCommitAt = now;
    }
    return { fired: false };
  }

  // session 结束 · 触发 prompt
  const minutes = Math.round(elapsed / 60000);
  let reason = '到时间了';
  if (tooMany) reason = '改得有点多了';
  if (shipKeyword) reason = '看起来在收尾';
  return {
    fired: true,
    priority: 75,
    reason: 'ui-session-end',
    kind: 'ui-session',
    session,
    msg: `这一波 UI 改了 ${session.commitCount} 个 commit (${minutes} 分钟前开始 · ${reason})`,
    suggestion: '想记一笔总结吗? 我会自动等 deploy 完贴 before/after 对比图',
  };
}

// 抓 prod 当前样子当 before 快照 · 存到 ~/.tinker/snapshots/
// 返回保存的文件路径 · 失败返回 null · provider 可换 (走 captureScreenshotToFile)
function takeBeforeSnapshot(cfg, sha) {
  if (!cfg || !cfg.serverUrl) return null;
  const snapDir = path.join(CONFIG_DIR, 'snapshots');
  try { fs.mkdirSync(snapDir, { recursive: true }); } catch {}
  const fname = path.join(snapDir, (sha || Date.now()) + '-before.jpg');
  return captureScreenshotToFile(cfg, cfg.serverUrl, fname) ? fname : null;
}

// 启动 detached 后台进程 · 等 deploy 完成 + 抓 after + editUpdate 贴图
// 任务以 JSON 文件传给子进程 (避开 argv 长度 / 转义麻烦)
function spawnDeployWatcher(task) {
  const { spawn } = require('child_process');
  const watchDir = path.join(CONFIG_DIR, 'watch');
  try { fs.mkdirSync(watchDir, { recursive: true }); } catch {}
  const taskFile = path.join(watchDir, 'task-' + Date.now() + '.json');
  fs.writeFileSync(taskFile, JSON.stringify(task));
  // 调 tinker 自己的 watch 子命令 · 把 taskFile 路径传过去
  const child = spawn(process.argv[0], [process.argv[1], 'watch-deploy', taskFile], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  child.unref();
}

// `tinker watch <taskFile>` · 子进程实际跑的逻辑
async function cmdWatch(taskFile) {
  if (!taskFile || !fs.existsSync(taskFile)) {
    err('watch task file 不存在: ' + taskFile);
    process.exit(1);
  }
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
  const logFile = path.join(CONFIG_DIR, 'watch', 'log.txt');
  const wlog = (s) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${s}\n`); } catch {} };
  wlog(`watch start · updateId=${task.updateId}`);

  // poll /api/health · 找 deploy 重启信号 (uptime 突然变小)
  let lastUptime = null;
  let detectedReset = false;
  let stableAfterReset = 0;
  let pollResult = null;
  for (let i = 0; i < 80; i++) {  // 80 * 30s = 40 分钟最长等待
    try {
      const r = await fetch(task.serverUrl + '/api/health');
      const j = await r.json();
      const u = j.uptime || 0;
      if (lastUptime !== null && u < lastUptime && u < 60) {
        detectedReset = true;
        stableAfterReset = 0;
        wlog(`detected deploy reset (uptime ${lastUptime} → ${u})`);
      }
      if (detectedReset) {
        stableAfterReset = u;
        if (u > 40) { pollResult = 'ok'; break; }  // 重启后稳定运行 40s · deploy 完成
      }
      lastUptime = u;
    } catch (e) { wlog('poll err: ' + e.message); }
    await new Promise(r => setTimeout(r, 30000));
  }
  if (pollResult !== 'ok') {
    wlog('deploy not detected within 40min · 放弃');
    try { fs.unlinkSync(taskFile); } catch {}
    return;
  }

  // 抓 after 快照 · provider 跟 before 一致 (走同一份 config · 子进程 loadConfig)
  wlog('snapping after');
  let afterPath = null;
  {
    const snapDir = path.join(CONFIG_DIR, 'snapshots');
    try { fs.mkdirSync(snapDir, { recursive: true }); } catch {}
    afterPath = path.join(snapDir, task.updateId + '-after.jpg');
    const cfg = loadConfig();
    const okShot = captureScreenshotToFile(cfg, task.serverUrl, afterPath);
    if (!okShot) {
      wlog('snap after fail (provider: ' + getShotConfig(cfg).provider + ')');
      try { fs.unlinkSync(taskFile); } catch {}
      return;
    }
  }

  // 读 before + after · 编 data URL · editUpdate
  wlog('editUpdate attach images');
  try {
    const beforeBuf = fs.readFileSync(task.beforeSnapshotPath);
    const afterBuf = fs.readFileSync(afterPath);
    const beforeUrl = 'data:image/jpeg;base64,' + beforeBuf.toString('base64');
    const afterUrl = 'data:image/jpeg;base64,' + afterBuf.toString('base64');
    // editUpdate 用 updateIdx (排序里 ORDER BY at DESC · 最新的是 0)
    // 当前这条刚 push · 应该就是 0
    const r = await fetch(task.serverUrl + '/api/action', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + task.token, 'Content-Type': 'application/json', 'x-tinker-no-state': '1' },
      body: JSON.stringify({
        type: 'editUpdate',
        payload: {
          projectId: task.projectId,
          updateIdx: 0,
          text: task.text,
          images: [
            { src: beforeUrl, caption: '改之前' },
            { src: afterUrl, caption: '改之后' },
          ],
          seekingFeedback: false,
          feedbackAsk: '',
        },
      }),
    });
    if (r.ok) { wlog('attach ok'); } else { wlog('attach failed: ' + r.status); }
  } catch (e) {
    wlog('attach err: ' + e.message);
  }

  try { fs.unlinkSync(taskFile); } catch {}
  wlog('watch end');
}

// 把所有触发器汇总 · 选 priority 最高的那个
// v0.12 详细版 · 返回所有命中 + winner · 用于 tinker triggers 自检
// evaluateAllTriggers 是兼容老 API 的薄包装
function evaluateAllTriggersDetailed(state, repoCfg, cfg) {
  const uiResult = evaluateUiSession(state, cfg);
  const results = [
    triggerKeywordMatch(),
    triggerFrustrationBehavior(),
    triggerAiDebugBreakthrough(),
    triggerDocsEdit(),
    triggerCleverFix(),
    triggerSubtraction(),
    triggerAiLimit(),
    triggerRestart(),
    triggerToolCombo(),
    triggerCrossProject(),
    triggerTestVerify(),
    triggerNaming(),
    triggerReversal(),
    triggerLongBody(),
    triggerFirstCommitOfDay(state),
    triggerLongSilence(state, repoCfg),
    triggerCumulativeCommits({}, state),
    triggerCrossRepoDrift(state, repoCfg),
  ].filter(r => r.fired);
  if (uiResult.fired) results.push(uiResult);
  results.sort((a, b) => b.priority - a.priority);
  return {
    winner: results[0] || null,
    allFired: results,
  };
}

function evaluateAllTriggers(state, repoCfg, cfg) {
  return evaluateAllTriggersDetailed(state, repoCfg, cfg).winner;
}

// v0.12 踩坑全周期状态机入口 · cmdCheck 在评估触发器前调
// 静默原则: 用户正在 debug 不该被打扰 · enter/continue 全部静默
// resolve 切状态 + spawn autopsy 后台跑 · 不阻塞 hook
function updateStruggleState(state, { fromHook } = {}) {
  try {
    const struggle = getStruggleModule();
    const evalResult = struggle.evaluateLifecycleState(state, { cwd: process.cwd() });

    if (evalResult.transition === 'enter') {
      // 进入 active · 静默标记 (alpha 期默认 consent=true · tinker struggle off 可关)
      const s = evalResult.pendingSituation;
      s.consented = true;
      s.topic = struggle.inferTopic(s.signals);
      state.currentStruggle = s;
      struggle.saveDossier(s);
      return;
    }

    if (evalResult.transition === 'continue') {
      // 在 active 中 · 顺手 append 当前 commit 信号
      const lifecycleType = state.currentStruggle.lifecycleType || 'struggle';
      const config = struggle.LIFECYCLE_CONFIGS[lifecycleType] || struggle.LIFECYCLE_CONFIGS.struggle;
      try {
        const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
        struggle.appendSignal(state.currentStruggle, {
          type: 'wip_commit',
          sha: execSync('git log -1 --pretty=%H', { encoding: 'utf-8' }).trim().slice(0, 8),
          text: title.slice(0, 200),
        });
      } catch {}
      // 同时记录最近的 Claude 信号 (顺手刷 dossier · 让 autopsy 有料)
      if (evalResult.recent && evalResult.recent.userMessages.length > 0) {
        const signalType = lifecycleType === 'struggle' ? 'claude_fail' : 'claude_explore';
        const seen = new Set((state.currentStruggle.signals || [])
          .filter(s => s.type === signalType)
          .map(s => s.at));
        evalResult.recent.userMessages.slice(-3).forEach(m => {
          if (!seen.has(m.ts) && config.matchSignal(m.text)) {
            struggle.appendSignal(state.currentStruggle, {
              at: m.ts, type: signalType, text: m.text.slice(0, 200),
            });
          }
        });
      }
      // 推断 topic (信号更多了重推一次)
      if (!state.currentStruggle.topic || state.currentStruggle.signals.length % 5 === 0) {
        state.currentStruggle.topic = struggle.inferTopic(state.currentStruggle.signals);
        struggle.saveDossier(state.currentStruggle);
      }
      return;
    }

    if (evalResult.transition === 'resolve') {
      // 出坑 / 学会 · 标 resolved + 记 justResolvedAt (给 breakthrough 触发器用)
      state.currentStruggle.resolved = true;
      state.currentStruggle.endedAt = Date.now();
      state.currentStruggle.justResolvedAt = Date.now();
      if (!state.currentStruggle.topic) {
        state.currentStruggle.topic = struggle.inferTopic(state.currentStruggle.signals) || '未命名';
      }
      struggle.saveDossier(state.currentStruggle);
      // 后台 spawn autopsy · 不阻塞 hook · 传 lifecycle type
      spawnAutopsyAsync(state.currentStruggle.id, state.currentStruggle.lifecycleType || 'struggle');
      return;
    }

    if (evalResult.transition === 'abandon') {
      state.currentStruggle = null;
      return;
    }
    // transition === 'none' · 什么都不做
  } catch (e) {
    if (!fromHook) {
      console.error('[lifecycle] ' + e.message);
    }
  }
}

// 后台 detached child 跑 autopsy · 不阻塞 hook
// 用 process.execPath + __filename + 隐藏 args · 子进程跑 cmdAutopsy
// lifecycleType 默认 'struggle' (兼容老 dossier)
function spawnAutopsyAsync(situationId, lifecycleType = 'struggle') {
  try {
    const child = spawn(process.execPath, [__filename, '__autopsy', situationId, lifecycleType], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    });
    child.unref();
  } catch { /* 容错 */ }
}

// v0.12 记录今日触发器命中分布 · 给 tinker triggers + goodnight 用
// 只记 winner · 因为这是最有意义的"今天替我做了什么"
// 跨天 (todayKey 变化) 自动清零
function recordTriggerWinner(state, winner, suppressedByCooldown) {
  const tk = todayKey();
  if (!state.todayTriggerHits || state.todayTriggerHits.date !== tk) {
    state.todayTriggerHits = { date: tk, winners: {} };
  }
  if (!winner) return;
  const k = winner.kind || winner.reason || 'unknown';
  if (!state.todayTriggerHits.winners[k]) {
    state.todayTriggerHits.winners[k] = { count: 0, suppressed: 0 };
  }
  state.todayTriggerHits.winners[k].count++;
  if (suppressedByCooldown) state.todayTriggerHits.winners[k].suppressed++;
}

async function cmdCheck(opts) {
  if (!inGitRepo()) {
    if (!opts.fromHook) err('不在 git 仓库');
    return;
  }
  const fromHook = !!opts.fromHook;
  const state = loadPromptState();
  const now = Date.now();

  // 后台异步刷新 update cache · 不阻塞主流程
  // (cache TTL 24h · 重复跑也只在过期时真发 GitHub 请求 · 浪费小)
  spawnUpdateCheckAsync();

  // 顺手清理 30 天前的 struggle dossier · 失败容错
  // 调用频率高 (每次 hook) · cleanOldDossiers 内部判 mtime 不重读不必要文件 · 几乎零成本
  try { getStruggleModule().cleanOldDossiers({ keepDays: 30 }); } catch {}

  // v0.13: 静默逻辑分层 (用户语义对齐)
  //   mutedUntil / dismissedTodayKey = 全局静音 (用户明确表达"不要打扰我") · 早 return
  //   laterUntilByReason = per-reason 延后 (用户语义是"这一类我懒得写") · 移到 evaluate 后
  // 这样: 用户对 ai-limit 选"1 小时后再问" · subtraction (不同 reason) 仍能触发
  if (state.mutedUntil && state.mutedUntil > now) {
    if (!fromHook) log(sepia('  现在静音中 · 到 ' + new Date(state.mutedUntil).toLocaleString()));
    return;
  }
  if (state.dismissedTodayKey === todayKey()) {
    if (!fromHook) log(sepia('  今天已经选了不发 · 明天再问'));
    return;
  }
  // 冷却 30 分钟 · 同一段时间不重复 prompt
  // 例外: keyword 触发的高信号 (commit message 含 ship/done 等) 不受冷却约束
  // 因为那是用户刚刚明确说"我做完了某件事" · 不能错过

  // 知道是哪个项目
  const repoCfg = loadRepoConfig();
  if (!repoCfg) {
    if (!fromHook) log(sepia('  这个 repo 还没绑定 Tinker 项目 · 先跑 ') + vermilion('tinker hook install'));
    return;
  }
  // 顺手登记到 drift registry · 即使老用户没重装 hook 也能用 drift 检测
  registerRepoForDrift(process.cwd(), repoCfg);

  // v0.12 踩坑全周期状态机 · 在评估触发器前先更新 struggle 状态
  // 静默原则:enter/continue 时不打扰用户 (用户正在 debug 不该被弹窗)
  // resolve 时仅切状态 · ai-debug-breakthrough 触发器会从 state 看到并 prompt
  updateStruggleState(state, { fromHook });

  // 评估所有触发器 · 选最高 priority
  const cfgForUi = (() => { try { return mustHaveConfig(); } catch { return null; } })();
  const result = evaluateAllTriggers(state, repoCfg, cfgForUi);
  // UI session 评估可能写了 state (启动 session) · 即使没 fire 也存一下
  savePromptState(state);
  if (!result) {
    if (!fromHook) log(sepia('  当前没有触发器命中 · 安静'));
    return;
  }

  // v0.13: per-reason 延后 · 用户对这一类已说"稍后" · 但不同 reason 仍能突破
  const laterByReason = state.laterUntilByReason || {};
  if (laterByReason[result.reason] && laterByReason[result.reason] > now) {
    if (!fromHook) log(sepia('  这类 (' + result.reason + ') 延后到 ' + new Date(laterByReason[result.reason]).toLocaleString()));
    return;
  }

  // v0.13 冷却:30 分钟内同 reason 已经 prompt 过 + 不是 keyword 级 (priority < 100) 不再 prompt
  // 之前用全局 lastPromptedAt · clever-fix 跟 tool-combo 互压 · 一天命中 10+ 但用户只听到 1 次
  // 改成 per-reason · 不同信号源不再互相吃掉 · keyword 级 (priority >= 100) 仍豁免冷却
  const byReason = state.lastPromptedAtByReason || {};
  const lastForThisReason = byReason[result.reason];
  const suppressedByCooldown = lastForThisReason && (now - lastForThisReason) < 30 * 60 * 1000 && result.priority < 100;
  // v0.12 不管最后是否 prompt · 都记 winner 到今日 hits (给 goodnight + tinker triggers 看)
  recordTriggerWinner(state, result, suppressedByCooldown);
  savePromptState(state);
  if (suppressedByCooldown) {
    return;
  }

  // 非 TTY (Bash 工具触发 git commit / CI / detached) 时 silently 跳过
  // 之前 line 3315 select() 在非 TTY 会抛错 · catch 默认 'later' → 静默 1 小时
  // 用户看着像"被 Tinker 自动选了稍后 1 小时再问" · 实际上 select 根本没机会问
  // 不污染 state · 下次真 TTY commit 仍能正常触发 (winner 已经在 line 3143 记给 goodnight)
  if (!opts.json && !(process.stdin.isTTY && process.stdout.isTTY)) {
    try { logTriggerEvent('check-skip-non-tty', 'fired', { trigger_kind: result.kind, trigger_reason: result.reason }); } catch {}
    return;
  }

  // prompt 出来 · v0.3 --json mode 跳过人类可读输出 · 只输出 JSON
  if (!opts.json) {
    log('');
    log(sepia('  ── ') + vermilion('tinker') + sepia(' ──'));
    log('  ' + bold(result.msg) + sepia(' · 在 ') + vermilion(repoCfg.projectName));
    if (result.suggestion) log('  ' + sepia(result.suggestion));
    log('');
  }

  // 根据触发器类型 · 默认动作不一样:
  //   keyword=frustrated → 特殊:不说"想记一笔"·三选 [标卡住 / 喘口气 / 没事接着搞]
  //   keyword=ship → "进陈列馆" (走 shipProject) 排第一
  //   keyword=stuck → "标卡住" 排第一
  //   其他 → "记一笔" 排第一
  const choices = [];
  if (result.kind === 'frustrated') {
    // 破防时刻 · 文案 / 选项跟其他都不一样 · 不要产品语言
    choices.push({ name: '⚠ 标卡住 · 让在意你的人看到', value: 'stuck-quiet' });
    choices.push({ name: '暂停 30 分钟 · 出去走走', value: 'mute-30m' });
    choices.push({ name: '没事 · 我接着搞', value: 'skip-once' });
  } else if (result.kind === 'ui-session') {
    // UI session 结束 · 想记一笔 + 自动贴对比图 (第二个 commit 加 deploy watcher)
    choices.push({ name: '记一笔 · 自动贴 before / after 对比图', value: 'ui-push' });
    choices.push({ name: '只记一笔 · 不要对比图', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'brand') {
    // 品牌信号 · "捣鼓" / Tinker 出现 · 主动认歧义 · 让用户挑哪种意思
    // v0.2 #3: 两个选项 value 区分 · 让 input prompt 文案匹配语境
    choices.push({ name: '是 Tinker 项目本身的进展 · 记一笔', value: 'push-brand-self' });
    choices.push({ name: '是用 Tinker 做事情的反思 · 记一笔', value: 'push-brand-meta' });
    choices.push({ name: '巧合 · 跟 Tinker 没关系 · 跳过', value: 'skip-once' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
  } else if (result.kind === 'decision') {
    // v0.2 #1: 工具链选型决策 · 长期价值高 · 让用户记下来
    choices.push({ name: '记决策 · 写一笔', value: 'push-decision' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'clever-fix') {
    // v0.5: 巧妙修复 · 别人能学的真东西
    choices.push({ name: '记这个修法 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'subtraction') {
    // v0.5: 减法决策 · 工程师圈最难学的事
    choices.push({ name: '说说为什么砍 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'ai-limit') {
    // v0.5: AI 边界经验 · alpha 期最贵的"手艺"
    choices.push({ name: '记 AI 边界 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'restart') {
    // v0.7: 项目沉默后回归 · 放弃后重启的经验
    choices.push({ name: '记回归 · 说说为什么回来', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'tool-combo') {
    // v0.7: 工具组合发现 · 手艺组合
    choices.push({ name: '记这个组合搭法 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'cross-project') {
    // v0.7: 跨项目借鉴 · 手艺谱系
    choices.push({ name: '记这次借鉴 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'test-verify') {
    // v0.7: 测试 / 验证发现 · 别人不用再重复
    choices.push({ name: '记这次验证 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'naming') {
    // v0.7: 命名 / 重命名 · 创造力体现
    choices.push({ name: '记这次改名 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'reversal') {
    // v0.7: 撤回的勇气 · 承认走错了
    choices.push({ name: '记这次撤回 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'long-body') {
    // v0.7: 长 body 兜底 · 作者花时间写
    choices.push({ name: '顺手记一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'ship') {
    choices.push({ name: '✦ 进陈列馆 · 写一句完工感想', value: 'ship' });
    choices.push({ name: '只记一笔普通进展', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'stuck') {
    choices.push({ name: '⚠ 标卡住 · 写在哪里卡了', value: 'stuck' });
    choices.push({ name: '只记一笔普通进展', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'prototype') {
    choices.push({ name: '◐ 进陈列馆 · 作为原型', value: 'prototype' });
    choices.push({ name: '只记一笔普通进展', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else {
    choices.push({ name: '发 · 现在写一句', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  }

  // v0.3 --json mode · 给 AI agent 用 · 不弹 select · 输出 JSON + 写 pending
  // 让 Claude Code / Cursor 等无 TTY 的环境也能驱动 tinker
  if (opts.json) {
    // 持久化触发上下文 · 供后续 tinker resolve 用
    const pending = {
      at: now,
      kind: result.kind,
      reason: result.reason,  // v0.13: 给 --ai mode 的 later 选项做 per-reason 静默
      priority: result.priority,
      msg: stripAnsi(result.msg),
      suggestion: result.suggestion || '',
      projectId: repoCfg.projectId,
      projectName: repoCfg.projectName,
      commitTitle: (() => { try { return execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim(); } catch { return ''; } })(),
      session: result.session || null,  // ui-session 时携带 before snapshot path 等
    };
    savePending(pending);
    // v0.17 累积模式 · 同时 append 到 pending-reminders.jsonl
    // savePending 是单条覆盖 (给 tinker resolve 走 pending.json 路径用 · 兼容老 flow)
    // pending-reminders.jsonl 是累积 · 不覆盖 · AI 工具 / 用户随时能扫"待处理 reminder 列表"
    // post-commit hook 跑这条路径 · 命中触发器自动 append · 用户 / LLM 后续 tinker pending --json 看
    appendPendingReminder({
      id: 'pr-' + now + '-' + Math.random().toString(36).slice(2, 6),
      at: new Date(now).toISOString(),
      kind: result.kind,
      reason: result.reason,
      priority: result.priority,
      msg: stripAnsi(result.msg),
      suggestion: result.suggestion || '',
      projectId: repoCfg.projectId,
      projectName: repoCfg.projectName,
      commitSha: (() => { try { return execSync('git log -1 --pretty=%h', { encoding: 'utf-8' }).trim(); } catch { return ''; } })(),
      commitTitle: pending.commitTitle,
      cwd: process.cwd(),
      choices: choices.map(c => ({ id: c.value, label: stripAnsi(c.name) })),
      handled: false,
    });
    // 写 state · 标记已 prompt · 防重复触发
    state.lastPromptedAt = now;
    state.lastPromptedAtByReason = state.lastPromptedAtByReason || {};
    state.lastPromptedAtByReason[result.reason] = now;
    if (result.priority < 70) state.lowFiredTodayKey = todayKey();
    savePromptState(state);
    // v0.17 bridge auto-ping · 用户开了的话自动通知团队
    // 失败静默 · 不阻塞 hook
    try {
      const cfg2 = (() => { try { return loadConfig(); } catch { return null; } })();
      if (cfg2 && cfg2.serverUrl && cfg2.token) await maybeAutoPing(result, repoCfg, cfg2);
    } catch {}
    // 输出结构化 JSON 给调用方解析
    const out = {
      fired: true,
      kind: result.kind,
      priority: result.priority,
      msg: stripAnsi(result.msg),
      suggestion: result.suggestion || '',
      context: repoCfg.projectName,
      choices: choices.map(c => ({ id: c.value, label: stripAnsi(c.name) })),
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  const { select, input } = promptKit();
  let choice;
  try {
    choice = await select({ message: '怎么处理?', choices });
  } catch { choice = 'later'; }

  state.lastPromptedAt = now;
  state.lastPromptedAtByReason = state.lastPromptedAtByReason || {};
  state.lastPromptedAtByReason[result.reason] = now;
  // v0.2 #6: 低优先级触发器 (first-commit/silence/cumulative) 命中后 · 当天不再问
  // priority < 70: first-commit 60 / silence 50 / cumulative 30
  if (result.priority < 70) {
    state.lowFiredTodayKey = todayKey();
  }

  const cfg = mustHaveConfig();

  // 起草助手 · 有 LLM 就预填一句 · 没 LLM 直接走原本的空 input
  async function promptForText(message, sinceMinutes) {
    let draft = null;
    if (cfg.llm && cfg.llm.apiKey) {
      log(sepia('  起草中...'));
      draft = await llmQuickDraft(cfg, { sinceMinutes });
      if (draft) log(sepia('  ✦ LLM 起草了一句 · 改改或直接回车'));
      else log(sepia('  (LLM 没给出草稿 · 自己写吧)'));
    }
    return (await input({ message, default: draft || undefined })).trim();
  }

  if (choice === 'ui-push') {
    // UI session 结束 + 想要对比图
    // 1. 用户写一句总结
    // 2. push update
    // 3. 启动 detached watcher · 等 deploy 完抓 after · editUpdate 贴图
    // before 路径来自 result.session.beforeSnapshotPath
    const session = result.session;
    state.uiSession = null;  // 清掉 · 让下一波 UI 启动新 session
    savePromptState(state);
    const sinceMin = Math.max(60, Math.round((Date.now() - session.startedAt) / 60000) + 10);
    const text = await promptForText('一句话总结这波 UI 改动', sinceMin);
    if (!text) { log(sepia('  没写内容 · 跳过')); return; }
    // v0.20 voice 守门
    const gate1 = await gateVoiceCheck(text, opts);
    if (!gate1.ok) { log(sepia('  voice 守门拦了 · 没发')); return; }
    const pushResult = await apiAction(cfg, 'addUpdate', { projectId: repoCfg.projectId, text });
    const updateId = pushResult && (pushResult.result?.id || pushResult.id);
    state.lastPushAtByProject = state.lastPushAtByProject || {};
    state.lastPushAtByProject[repoCfg.projectId] = Date.now();
    savePromptState(state);
    ok('发出去了 → ' + cfg.serverUrl + '/#/p/' + cfg.handle + '/');
    savePoolSample(buildPendingForSample(repoCfg, result), 'ui-push', text, cfg.handle);

    // 启动后台 watcher · 等 deploy 后抓 after + editUpdate 贴图
    if (updateId && session && session.beforeSnapshotPath) {
      spawnDeployWatcher({
        updateId,
        projectId: repoCfg.projectId,
        text,
        beforeSnapshotPath: session.beforeSnapshotPath,
        serverUrl: cfg.serverUrl,
        token: cfg.token,
        startedAt: Date.now(),
      });
      log(sepia('  后台监控 deploy 中 · deploy 完会自动给那条 update 贴上 before/after 对比图'));
    } else {
      log(sepia('  before 快照丢了 · 这次没贴对比图 (后续会修)'));
    }
  } else if (choice === 'push' || choice === 'push-brand-self' || choice === 'push-brand-meta' || choice === 'push-decision') {
    savePromptState(state);
    // v0.2 #1 #3: input prompt 文案随 kind 切换 · 让用户写对语境
    let msg = '一句话进展 (会发到 ' + repoCfg.projectName + ')';
    if (choice === 'push-brand-self') {
      msg = 'Tinker 项目本身这次改了什么 (会发到 ' + repoCfg.projectName + ')';
    } else if (choice === 'push-brand-meta') {
      msg = '用 Tinker 这件事的反思 (会发到 ' + repoCfg.projectName + ')';
    } else if (choice === 'push-decision') {
      msg = '这次决策的简述 (装/换/选了什么 · 为什么 · 会发到 ' + repoCfg.projectName + ')';
    }
    const text = await promptForText(msg, 60);
    if (!text) { log(sepia('  没写内容 · 跳过')); return; }
    // v0.20 voice 守门
    const gate2 = await gateVoiceCheck(text, opts);
    if (!gate2.ok) { log(sepia('  voice 守门拦了 · 没发')); return; }
    await apiAction(cfg, 'addUpdate', { projectId: repoCfg.projectId, text });
    state.lastPushAtByProject = state.lastPushAtByProject || {};
    state.lastPushAtByProject[repoCfg.projectId] = Date.now();
    savePromptState(state);
    savePoolSample(buildPendingForSample(repoCfg, result), choice, text, cfg.handle);
    const okMsg = choice === 'push-decision' ? '✓ 决策记下来了 → ' : '发出去了 → ';
    ok(okMsg + cfg.serverUrl + '/#/p/' + cfg.handle + '/');
  } else if (choice === 'ship' || choice === 'prototype') {
    savePromptState(state);
    const verb = choice === 'ship' ? '完工感想' : '原型说明';
    const text = await promptForText(verb + ' (会进陈列馆代表 ' + repoCfg.projectName + ')', 60);
    if (!text) { log(sepia('  没写内容 · 跳过')); return; }
    await apiAction(cfg, 'exhibitProject', {
      projectId: repoCfg.projectId,
      kind: choice,
      statement: text,
      seekingFeedback: true,
    });
    state.lastPushAtByProject = state.lastPushAtByProject || {};
    state.lastPushAtByProject[repoCfg.projectId] = Date.now();
    savePromptState(state);
    savePoolSample(buildPendingForSample(repoCfg, result), choice, text, cfg.handle);
    ok((choice === 'ship' ? '✦ 完工 · 已进陈列馆' : '◐ 原型 · 已进陈列馆'));
  } else if (choice === 'stuck') {
    savePromptState(state);
    const text = await promptForText('卡在哪 (会标项目 stuck + 通知关心你的人)', 60);
    if (!text) { log(sepia('  没写内容 · 跳过')); return; }
    await apiAction(cfg, 'changeProjectStatus', { projectId: repoCfg.projectId, newStatus: 'stuck' });
    await apiAction(cfg, 'addUpdate', { projectId: repoCfg.projectId, text });
    state.lastPushAtByProject = state.lastPushAtByProject || {};
    state.lastPushAtByProject[repoCfg.projectId] = Date.now();
    savePromptState(state);
    savePoolSample(buildPendingForSample(repoCfg, result), choice, text, cfg.handle);
    ok('⚠ 卡住了 · 已通知');
  } else if (choice === 'stuck-quiet') {
    // 破防触发后选了标卡住 · 文本默认走 commit 标题 · 不强求作者再写一句 · 那时候不该再要求
    savePromptState(state);
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const fallback = '卡住了 · 这条 commit 没顺下来: ' + title;
    const text = (await input({ message: '写一句 · 或回车用 commit 标题', default: fallback })).trim() || fallback;
    await apiAction(cfg, 'changeProjectStatus', { projectId: repoCfg.projectId, newStatus: 'stuck' });
    await apiAction(cfg, 'addUpdate', { projectId: repoCfg.projectId, text });
    recordPushAt(repoCfg.projectId);
    savePoolSample(buildPendingForSample(repoCfg, result), choice, text, cfg.handle);
    ok('⚠ 卡住了 · 已通知关心你的人');
  } else if (choice === 'mute-30m') {
    state.mutedUntil = now + 30 * 60 * 1000;
    savePromptState(state);
    log(sepia('  30 分钟不再问 · 出去走走'));
  } else if (choice === 'skip-once') {
    // 这一次不动 · 不静音不延后 · 让作者继续 · 但下个触发器还是能问
    state.lastPromptedAt = now;
    savePromptState(state);
    log(sepia('  好 · 接着搞'));
  } else if (choice === 'later') {
    // v0.13: per-reason 延后 · 不同 reason 仍能突破
    state.laterUntilByReason = state.laterUntilByReason || {};
    state.laterUntilByReason[result.reason] = now + 60 * 60 * 1000;
    savePromptState(state);
    log(sepia('  这一类 (' + result.reason + ') 1 小时后再问 · 别的 commit 仍会提醒'));
  } else if (choice === 'skip-today') {
    state.dismissedTodayKey = todayKey();
    savePromptState(state);
    log(sepia('  今天不再问 · 明天见'));
  } else if (choice === 'mute') {
    state.mutedUntil = now + 24 * 60 * 60 * 1000;
    savePromptState(state);
    log(sepia('  静音 24 小时 · 用 ') + vermilion('tinker mute off') + sepia(' 解除'));
  }
}

// `tinker llm [set|off|status]` · 单独配 LLM key · 不用重跑整个 login
async function cmdLlm(sub, opts = {}) {
  const cfg = loadConfig();
  if (!cfg) {
    if (opts.json) { errJson('还没配置 · 先跑 tinker login', 'NO_CONFIG'); return; }
    err('还没配置 · 先跑 ' + vermilion('tinker login')); process.exit(1);
  }

  if (sub === 'off' || sub === 'clear') {
    delete cfg.llm;
    saveConfig(cfg);
    if (opts.json) { outputJson({ ok: true, cleared: true }); return; }
    ok('LLM 配置已清掉 · prompt 流程回到手敲模式');
    return;
  }

  if (sub === 'usage') {
    // 看 Tinker 自己用 LLM 的 token 累积 · 跟 goodnight 解耦 (不混进日总结)
    let history = [];
    try { history = JSON.parse(fs.readFileSync(LLM_USAGE_FILE, 'utf-8')); } catch {}
    if (!Array.isArray(history)) history = [];
    const today = getTodayLLMUsage();
    const total = history.reduce((s, h) => s + (h.tokens || 0), 0);
    const todayTokens = today.reduce((s, h) => s + (h.tokens || 0), 0);
    const byKind = {};
    history.forEach(h => { byKind[h.kind] = (byKind[h.kind] || 0) + h.tokens; });

    if (opts.json) {
      outputJson({
        ok: true,
        today: { tokens: todayTokens, calls: today.length },
        total: { tokens: total, calls: history.length },
        byKind,
        note: '这是 Tinker 自己消耗的 token · 不包含 Cursor / Claude Code 等编程工具',
      });
      return;
    }

    if (history.length === 0) {
      log(sepia('  还没记录过 LLM 用量'));
      return;
    }
    log('');
    log(sepia('  Tinker 自己用 LLM 的 token (起草 / 重写 / voice 分析 / narrate 等)'));
    log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━'));
    log(sepia('    今日: ') + bold(todayTokens.toLocaleString() + ' tokens') + sepia(' · ') + sepia(today.length + ' 次调用'));
    log(sepia('    累计: ') + bold(total.toLocaleString() + ' tokens') + sepia(' · ') + sepia(history.length + ' 次调用'));
    log(sepia('  按 kind 分:'));
    Object.entries(byKind).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
      log(sepia('    · ' + k.padEnd(15)) + bold(n.toLocaleString().padStart(8)));
    });
    log('');
    log(sepia('  说明: 这是 Tinker 自己消耗的 token (起草 / 总结自己用) · 不包含你在 Cursor / Claude Code 等编程工具里的 token'));
    return;
  }

  if (sub === 'status' || (sub === undefined && cfg.llm && cfg.llm.apiKey)) {
    if (!cfg.llm || !cfg.llm.apiKey) {
      log(sepia('  LLM 没配置 · 跑 ') + vermilion('tinker llm set') + sepia(' 来配'));
      return;
    }
    log('');
    log(sepia('  LLM 配置:'));
    log(sepia('    provider ') + vermilion(cfg.llm.provider || 'anthropic'));
    log(sepia('    model    ') + sepia(cfg.llm.model || '(provider 默认)'));
    log(sepia('    key      ') + sepia(cfg.llm.apiKey.slice(0, 8) + '...' + cfg.llm.apiKey.slice(-4)));
    log('');
    log(sepia('  重新配: ') + vermilion('tinker llm set'));
    log(sepia('  清掉:  ') + vermilion('tinker llm off'));
    return;
  }

  // set (or 没配过 · sub === undefined 也走这里)
  const { input, select, password } = promptKit();
  log('');
  log(sepia('  配 LLM · 给 prompt 自动起草用'));
  log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━'));
  const provider = await select({
    message: 'LLM provider',
    choices: [
      { name: 'Anthropic Claude (推荐 · 跟产品哲学一致)', value: 'anthropic' },
      { name: 'DeepSeek (国内友好 · 便宜)', value: 'deepseek' },
      { name: 'OpenAI GPT', value: 'openai' },
    ],
    default: cfg.llm?.provider || 'anthropic',
  });
  const apiKey = await password({
    message: 'API key (不会显示)',
    validate: (v) => v.trim().length > 0 || '不能空',
  });
  cfg.llm = { provider, apiKey: apiKey.trim() };
  saveConfig(cfg);
  ok('LLM 配好了 · 下次 prompt 选"发"就能看到自动起草');
}

// `tinker goodnight` · 今日总结 · 给 sleepy 时刻收个尾
// 也被 GOODNIGHT 关键词触发器命中时自动出现
async function cmdGoodnight(opts = {}) {
  const cfg = opts.json
    ? (loadConfig() || (errJson('还没配置 · 先跑 tinker login', 'NO_CONFIG'), null))
    : mustHaveConfig();
  if (!cfg) return;

  // 时间范围:--week 7 天 · --month 30 天 · --days N 自定义 · 默认今日
  const daysBack = opts.month ? 30 : opts.week ? 7 : (opts.daysBack || 1);
  const periodLabel = daysBack >= 30 ? '近 30 天' : daysBack >= 7 ? '近 7 天' : '今日';
  const isMultiDay = daysBack > 1;

  // 1. git commits in range (cwd 是 git repo 的话)
  let gitCommits = [];
  let gitStat = null;
  if (inGitRepo()) {
    try {
      const since = beijingSinceISO(-(daysBack - 1), 4);
      gitCommits = execSync(`git log --since="${since}" --no-merges --pretty=format:"%h|%s|%ai"`, { encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean).map(l => {
          const [sha, msg, at] = l.split('|');
          return { sha, msg, at };
        });
      const stat = execSync(`git log --since="${since}" --no-merges --shortstat --pretty=format:""`, { encoding: 'utf-8' }).trim();
      // shortstat 每条 commit 一行 · 全部累加
      let files = 0, ins = 0, del = 0;
      stat.split('\n').forEach(line => {
        const m = line.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
        if (m) { files += +m[1] || 0; ins += +m[2] || 0; del += +m[3] || 0; }
      });
      gitStat = { files, ins, del };
    } catch {}
  }

  // 2. updates pushed to Tinker (按范围)
  let todayUpdates = [];
  try {
    const state = await apiState(cfg);
    // 范围起始: 当前时间往回 daysBack 天 · 凌晨 4 点
    const rangeStart = beijingDayStart(-(daysBack - 1), 4);
    for (const p of state.projects) {
      if (p.owner !== cfg.handle) continue;
      for (const u of (p.updates || [])) {
        if (u.at >= rangeStart) todayUpdates.push({ projectName: p.name, text: u.text, at: u.at, kind: u.kind });
      }
    }
  } catch {}

  // 3. LLM token 用量
  const usage = getTodayLLMUsage();
  const totalTokens = usage.reduce((sum, u) => sum + (u.tokens || 0), 0);
  const usageByKind = {};
  usage.forEach(u => { usageByKind[u.kind] = (usageByKind[u.kind] || 0) + u.tokens; });

  // 4. 时间跨度
  let firstAt = null, lastAt = null;
  if (gitCommits.length > 0) {
    firstAt = new Date(gitCommits[gitCommits.length - 1].at);
    lastAt = new Date(gitCommits[0].at);
  }

  // JSON 输出 (AI agent 用 · 跳过人类可读)
  if (opts.json) {
    const projectCounts = {};
    todayUpdates.forEach(u => { projectCounts[u.projectName] = (projectCounts[u.projectName] || 0) + 1; });
    outputJson({
      ok: true,
      date: new Date().toISOString().slice(0, 10),
      coding: {
        commits: gitCommits.length,
        spanHours: firstAt && lastAt ? +((lastAt - firstAt) / 3600 / 1000).toFixed(2) : null,
        files: gitStat ? gitStat.files : 0,
        ins: gitStat ? gitStat.ins : 0,
        del: gitStat ? gitStat.del : 0,
        firstCommit: gitCommits.length > 0 ? gitCommits[gitCommits.length - 1].msg : null,
        lastCommit: gitCommits.length > 0 ? gitCommits[0].msg : null,
      },
      tinker: {
        updates: todayUpdates.length,
        byProject: projectCounts,
      },
    });
    return;
  }

  // 输出
  log('');
  const titleText = daysBack === 1 ? '今日深度总结' : daysBack === 7 ? '周总结 · ' + periodLabel : daysBack === 30 ? '月总结 · ' + periodLabel : '总结 · ' + periodLabel;
  log(sepia('  ── ') + vermilion(titleText) + sepia(' ── ') + sepia(new Intl.DateTimeFormat('zh-CN', { timeZone: TZ_BEIJING, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())));
  log('');

  log('  ' + bold('Coding'));
  if (gitCommits.length === 0) {
    log(sepia('    今天没在这个 repo commit · 是去别的项目了 / 还是没动手'));
  } else {
    log(sepia('    commit ') + bold(gitCommits.length + ' 个') + sepia(' · 跨 ') + bold(((lastAt - firstAt) / 3600 / 1000).toFixed(1) + ' 小时'));
    if (gitStat) log(sepia('    动了 ') + bold(gitStat.files + ' 个文件') + sepia(' · +') + moss(gitStat.ins) + sepia(' / -') + vermilion(gitStat.del));
    log(sepia('    第一条: ') + sepia(gitCommits[gitCommits.length - 1].msg.slice(0, 60)));
    log(sepia('    最后一条: ') + sepia(gitCommits[0].msg.slice(0, 60)));
  }
  log('');

  log('  ' + bold('Tinker'));
  if (todayUpdates.length === 0) {
    log(sepia('    今天没发任何 update'));
  } else {
    log(sepia('    push ') + bold(todayUpdates.length + ' 条 update'));
    const projectCounts = {};
    todayUpdates.forEach(u => { projectCounts[u.projectName] = (projectCounts[u.projectName] || 0) + 1; });
    Object.entries(projectCounts).forEach(([name, n]) => log(sepia('      · ') + name + sepia(' ×') + bold(n)));
  }

  // 反馈闭环 (v0.12): 自己的方法被别人借了几次
  // 沉默是金 · 0 次完全不显示 · 不让这段变成压力
  try {
    const days = daysBack >= 30 ? 30 : daysBack >= 7 ? 7 : 1;
    const r = await safeFetch(cfg, '/api/method/borrows-for-me?days=' + days, { headers: authHeaders(cfg) });
    const borrows = await r.json();
    if (borrows && borrows.total > 0) {
      log('');
      const periodWord = days >= 30 ? '近 30 天' : days >= 7 ? '近 7 天' : '今天';
      log(sepia('    你的方法被借 ') + bold(borrows.total + ' 次') + sepia(' · ') + sepia(periodWord));
      borrows.byUpdate.slice(0, 3).forEach(b => {
        const by = b.lastBorrower ? '@' + b.lastBorrower : '(匿名)';
        log(sepia('      · ') + b.projectName + sepia(' · ') + b.excerpt.slice(0, 32) + sepia('... · ×') + bold(b.count) + sepia(' · 最近 ') + by);
      });
    }
  } catch {}

  // v0.12 触发器今日 (从 prompt-state.json) · 让作者看见触发器系统在后台做了什么
  // 0 命中沉默不显示 · 跟方法被借同样的"压力友好"原则
  try {
    const ps = loadPromptState();
    const tk = todayKey();
    if (ps.todayTriggerHits && ps.todayTriggerHits.date === tk) {
      const ws = ps.todayTriggerHits.winners || {};
      const kinds = Object.keys(ws).sort((a, b) => ws[b].count - ws[a].count);
      if (kinds.length > 0) {
        log('');
        log(sepia('    触发器 (后台默默工作):'));
        kinds.forEach(k => {
          const w = ws[k];
          const supStr = w.suppressed > 0 ? sepia(' (其中 ' + w.suppressed + ' 次被冷却拦)') : '';
          log(sepia('      · ') + k + sepia(' ×') + bold(w.count) + supStr);
        });
        log(sepia('    要看为什么没 prompt: ') + vermilion('tinker triggers'));
      }
    }
  } catch {}

  // v0.12 踩坑跟踪今日 · 透明展示状态机在后台干了什么
  try {
    const struggleMod = getStruggleModule();
    const ps = loadPromptState();
    const todayStart = beijingDayStart(0, 4);
    const recent = struggleMod.listDossiers({ limit: 20 })
      .filter(d => d.startedAt >= todayStart);
    const cur = ps.currentStruggle;
    const isCurrentToday = cur && cur.startedAt >= todayStart;
    if (recent.length > 0 || isCurrentToday) {
      log('');
      log(sepia('    踩坑跟踪 (Tinker 替你记的现场):'));
      if (isCurrentToday) {
        log(sepia('      · ') + bold('正在跟踪') + sepia(' · ') + (cur.topic || '(未推断)')
          + sepia(' · ') + (cur.signals || []).length + ' 信号'
          + (cur.resolved ? moss(' · 已破局') : vermilion(' · 还在折腾')));
      }
      recent.filter(d => !cur || d.id !== cur.id).forEach(d => {
        const when = new Date(d.startedAt).toTimeString().slice(0, 5);
        log(sepia('      · ') + when + sepia(' · ') + (d.topic || '(无)')
          + sepia(' · ') + (d.signals || []).length + ' 信号'
          + (d.resolved ? moss(' · 破局') : sepia(' · 未完')));
      });
      log(sepia('    要看具体或关闭: ') + vermilion('tinker struggle'));
    }
  } catch {}
  log('');

  // Tinker 自己用 LLM 帮起草 / 分析 / narrate 的 token 用量是自指 · 不在晚安里显示
  // 想看就跑 tinker llm usage (单独命令)

  if (cfg.llm && cfg.llm.apiKey && (gitCommits.length > 0 || todayUpdates.length > 0) && !opts.narrate) {
    log(sepia('  让 AI 帮你 narrate 一下? 想要就跑 ') + vermilion('tinker deep-summary --narrate'));
    log('');
  }

  if (opts.narrate && cfg.llm && cfg.llm.apiKey) {
    log(sepia('  AI 总结中...'));
    const commitsLine = gitCommits.slice(0, 12).map(c => '- ' + c.msg).join('\n');
    const updatesLine = todayUpdates.slice(0, 6).map(u => '- (' + u.projectName + ') ' + u.text.slice(0, 80)).join('\n');
    // v0.13 注入 fingerprint + 真实样本 · 让 narrate 按作者真实气质写 · 不是通用 LLM 朋友腔
    const fingerprintBlock = loadFingerprint();
    const goodSamplesBlock = loadGoodSamples(2);
    const voiceInjection = (fingerprintBlock || goodSamplesBlock)
      ? `\n\n${fingerprintBlock}\n\n${goodSamplesBlock}\n`
      : '';
    const prompt = `今天的 git commits:\n${commitsLine}\n\n今天发到 Tinker 的 updates:\n${updatesLine || '(无)'}\n\n用一段话 (80-150 字) 替作者收个尾 · 准备睡觉 · 语气朋友式 · 不总结 · 给一句你觉得最值得说的 · 一句"明天接着搞"那种话。不要"总结今天"那种 PM 周报开头。${voiceInjection}`;
    try {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.llm.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
      });
      if (r.ok) {
        const d = await r.json();
        recordLLMUsage(cfg.llm.provider, d.usage && d.usage.total_tokens, 'goodnight');
        log('');
        log('  ' + bold('AI 帮你说一句:'));
        const cleaned = sanitizeDraft(d.choices[0].message.content.trim()) || '';
        log(sepia('  ') + cleaned.replace(/\n/g, '\n  '));
        log('');
      }
    } catch {}
  }

  // v0.88 给 maybe-goodnight 用 · 标记今天已收尾 · 让对话触发器今晚不再 prompt
  // 仅今日范围 · --week / --month 不算今日收尾
  // 用 workdayKey · 凌晨 23:50 跑 / 凌晨 00:30 又说晚安 应该算同一天
  if (daysBack === 1) {
    const ps = loadPromptState();
    ps.lastGoodnightDate = workdayKey();
    savePromptState(ps);
  }

  log(sepia('  晚安。'));
  log('');
}

// 砍了 · 收工时间提醒 ("现在北京时间 X 点...") 用户嫌烦
// 留个空壳 · 接住已安装但还没 update 的旧 hook 调用 (静默 · 不再冒提醒)
// hook install 那边已不再装这条 · 且会主动摘除旧的孤儿 entry
function cmdMaybeGoodnight() {
  return;
}

// v0.14 对话内 maybe-X 触发器 · 把 keyword 触发从 commit message 搬到 Claude Code 对话
// 思路:commit message 是事后总结 · 真正的卡住/顿悟/决策/砍/修通/完工 都发生在跟 AI 对话里
// 每个命令静默检查 per-kind 冷却 (默认 60 min) · 命中 → stdout reminder 给 hook 注入我的 context
// 我看到 reminder 才主动跟用户说 · 不命中静默退出
// v0.16 maybe-X 词典升格:install-claude (Claude Code hook) 跟 maybe-check (跨 AI 通用) 共用同一份
// matcher 字段 = 正则 · | 分隔多个关键词 · 命中任意一个就算 kind hit
// 改关键词只动这里一处 · install-claude 跟 cmdMaybeCheck 都拿到新词
// goodnight 是特殊 kind · 不在这里 (有自己的 lastGoodnightDate / commit 数判断)
const MAYBE_KINDS = {
  stuck: {
    cooldownMin: 60,
    matcher: '卡住了|卡了|不行|怎么都|还是错|搞不定|不知道哪|找不到|为什么不|跑不起来',
    reminder: '用户跟 AI 对话里出现卡住相关的话 · 如果是真的困住没思路 (不是一句普通描述) · 可以建议跑 `tinker stuck "一句话说卡哪"` 让在意 ta 的人看到 · 看上下文判断 · 不是每次都建议',
  },
  breakthrough: {
    cooldownMin: 30,
    matcher: '懂了|明白了|哦哦|原来如此|终于通了|噢|啊我懂|找到原因|找到问题|搞清楚了',
    reminder: '用户刚说了顿悟类的话 (懂了 / 明白了 / 哦哦 等) · 顿悟时刻的十秒钟难复现 · 如果是真的有发现 · 可以建议跑 `tinker push -m "..."` 留一笔 · 上下文判断',
  },
  decision: {
    cooldownMin: 60,
    matcher: '决定用|还是用|改用|选 |不用 |换成|放弃|敲定|决定不|敲定下来',
    reminder: '用户在对话里做了工具链 / 方案选择 · 几个月后自己都想不起为什么选这个 · 如果是有思考的决策 · 可以建议跑 `tinker push -m "..."` 记下来 (或者 push-decision) · 不是每次都建议',
  },
  subtraction: {
    cooldownMin: 60,
    matcher: '砍了|砍掉|删了|算了|不做了|不要这个|去掉|移除|撤了|拿掉|不做这',
    reminder: '用户刚说了砍 / 删除 / 不做了类的话 · 减法决策是工程师圈最难学的事 · 如果是有理由的取舍 (不是临时改主意) · 可以建议记一笔说为什么砍',
  },
  cleverFix: {
    cooldownMin: 30,
    matcher: '跑通了|搞通了|搞定了|搞定|跑起来了|修好了|改好了|通了|终于跑|终于成|成功了',
    reminder: '用户刚说了跑通 / 搞通 / 搞定类的话 · 如果是修复了别人能学的真坑 · 可以建议跑 `tinker push -m "..."` 把这个修法留下来 · 上下文判断不是每次都建议',
  },
  ship: {
    cooldownMin: 60,
    matcher: '完工|发出去|上线了|发布了|做完了|部署了|deploy 了|push 了|release 了|线上了|搞完了',
    reminder: '用户刚说了完工 / 发出去 / 上线类的话 · 如果是真的发布了 (不只是计划) · 可以建议跑 `tinker ship -m "一句话感想"` 进陈列馆',
  },
  handoff: {
    cooldownMin: 30,
    matcher: '接力|交接给|帮我接力|给.{0,4}接着做|让.{0,4}接|你接一下|你接着做|换人|这个给.{0,4}做|把现场|把这个交给|打包给',
    reminder: '用户对话里像是想 handoff 接力 · 把当前现场打包发给队友。\n看上下文判断是不是真的想交接 · 不是的话别打扰 (单说"接"字不算)。\n是的话主动帮用户跑命令 · 不是只提醒:\n1) 看对话上下文写一句 50-100 字 handoff 说明 · 气质参考: "X 做了一半 · 卡在 Y · 你接着 Z" · 不是产品发布会语气\n2) 找接收方 handle: handle 以 `tinker studio info <slug>` 成员列表里的为准 · 别猜拼音 (比如猫猫的 handle 就是 @猫猫 · 不是 @maomao · 写错会变死信对方收不到) · 没指定就走 active studio 广播 (不带 -t)\n3) Bash 跑 `tinker handoff -m "<你写的说明>" [-t @<handle>]`\n4) 命令输出给用户看 · 让用户确认是否真的发了 (handoff 一旦发出去对方就收到 · 没法撤回)',
  },
  invite: {
    cooldownMin: 30,
    matcher: '邀请.{0,4}加入|拉.{0,4}进|拉.{0,4}入|加入.{0,4}(工作室|团队|我们)|让.{0,4}(进|加入)|把.{0,4}拉.{0,4}进|拉一下.{0,4}(进|入)',
    reminder: '用户对话里像是想邀请队友加入工作室。跟其他 maybe-X 不同 · invite 让你主动跑命令:\n1) 找 slug: 跑 `tinker studio list` 看用户哪个 active · 用 active 的 slug\n2) 找目标 handle: 从对话里看 (比如"邀请猫猫" → @猫猫)\n3) Bash 跑 `tinker studio invite <slug> @<handle>`\n4) 命令自动通过 bridge 投递邀请通知给对方 · 不用复制 token 微信发\n5) 报告用户已发 · 对方下次起 Claude session 时自动收到 + 提示一键加入',
  },
};

// v0.14 maybe-X 命中观测 · 追加 jsonl 到 ~/.tinker/trigger-log.jsonl
// 只记 kind / event / cwd / 冷却剩余 · 不持久 prompt 内容 · 失败静默
function logTriggerEvent(kind, event, extra) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      event,
      cwd: process.cwd(),
      ...extra,
    }) + '\n';
    fs.appendFileSync(path.join(CONFIG_DIR, 'trigger-log.jsonl'), line);
  } catch { /* 容错 · 日志失败不影响触发器 */ }
}

function cmdMaybe(kind) {
  const cfg = MAYBE_KINDS[kind];
  if (!cfg) return;
  // v0.35 服务器通知偏好闭环 · 命中先看 prefs
  const prefs = getPrefsSync();
  if (shouldSuppressKindLocal(kind, prefs)) {
    logTriggerEvent(kind, 'suppressed_by_prefs', {});
    return;
  }
  const ps = loadPromptState();
  ps.lastMaybeAtByKind = ps.lastMaybeAtByKind || {};
  const last = ps.lastMaybeAtByKind[kind];
  const now = Date.now();
  if (last && (now - last) < cfg.cooldownMin * 60 * 1000) {
    logTriggerEvent(kind, 'cooled_down', { remaining_ms: cfg.cooldownMin * 60 * 1000 - (now - last) });
    return;
  }
  ps.lastMaybeAtByKind[kind] = now;
  savePromptState(ps);
  logTriggerEvent(kind, 'fired', { cooldown_min: cfg.cooldownMin });
  process.stdout.write(cfg.reminder + '\n');
}

// v0.16 跨 AI 通用入口 · 任何 AI 工具的 LLM 看用户消息 · 主动 Bash 跑这个
// 把所有 MAYBE_KINDS 的 matcher 跑一遍 · 命中且未冷却的输出 reminder
// 设计原则:
// - 共用 lastMaybeAtByKind 冷却 · 跟 hook 触发的 maybe-X 不会重复
// - 多个 kind 可能同时命中 · 全部输出 (LLM 自己看上下文挑)
// - --json 输出结构化数组 · 默认人可读
// 用法: tinker maybe-check --text "用户的最近一条消息"
function cmdMaybeCheck(opts) {
  const text = (opts.text || '').trim();
  if (!text) {
    if (opts.json) return errJson('用法: tinker maybe-check --text "<用户消息>"', 'NO_TEXT');
    err('用法: ' + vermilion('tinker maybe-check --text "<用户消息>"'));
    log(sepia('  把用户的最近一条 prompt 喂给我 · 我跑全部 matcher · 输出命中且没冷却的 reminder'));
    log(sepia('  Claude Code 用户:hook 会自动跑 · 不用手动调'));
    log(sepia('  其他 AI 用户 (Cursor / Aider 等):LLM 看到用户消息时主动 Bash 调'));
    process.exit(1);
  }
  const ps = loadPromptState();
  ps.lastMaybeAtByKind = ps.lastMaybeAtByKind || {};
  const now = Date.now();
  const fired = [];
  const cooled = [];
  const suppressed = [];
  // v0.35 服务器通知偏好闭环 · 拉一次 cache 给整批共用
  const prefs = getPrefsSync();
  for (const [kind, cfg] of Object.entries(MAYBE_KINDS)) {
    if (!cfg.matcher) continue;
    const re = new RegExp(cfg.matcher);
    if (!re.test(text)) continue;
    if (shouldSuppressKindLocal(kind, prefs)) {
      suppressed.push({ kind });
      logTriggerEvent(kind, 'suppressed_by_prefs_check', {});
      continue;
    }
    const last = ps.lastMaybeAtByKind[kind];
    if (last && (now - last) < cfg.cooldownMin * 60 * 1000) {
      cooled.push({ kind, remainingMs: cfg.cooldownMin * 60 * 1000 - (now - last) });
      logTriggerEvent(kind, 'cooled_down_check', { remaining_ms: cfg.cooldownMin * 60 * 1000 - (now - last) });
      continue;
    }
    fired.push({ kind, reminder: cfg.reminder, cooldownMin: cfg.cooldownMin });
    ps.lastMaybeAtByKind[kind] = now;
    logTriggerEvent(kind, 'fired_check', { cooldown_min: cfg.cooldownMin });
  }
  savePromptState(ps);
  if (opts.json) {
    return outputJson({ ok: true, fired, cooled, suppressed });
  }
  if (fired.length === 0) {
    const parts = [];
    if (cooled.length > 0) parts.push('冷却中: ' + cooled.map(c => c.kind).join(' / '));
    if (suppressed.length > 0) parts.push('偏好屏蔽: ' + suppressed.map(c => c.kind).join(' / '));
    if (parts.length === 0) log(sepia('  没命中任何 maybe-X'));
    else log(sepia('  ' + parts.join(' · ')));
    return;
  }
  for (const f of fired) {
    log(vermilion('[' + f.kind + ']'));
    log(sepia('  ') + f.reminder);
    log('');
  }
}

// 到期待办提醒 · 从本地缓存现算(零网络)· 挂在 pending --check 里 · 每条 prompt 探测
// 为什么现算不入 jsonl:到期是"按今天"派生的 · 累积到 jsonl 会重复堆积 · 每次现算最干净
// 冷却:同一批到期集合 3 小时内只提一次 · 集合变了(新的到期)立刻再提
const TODO_DUE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
function todoDueNudgeLine() {
  const cfg = loadConfig();
  if (!cfg || !cfg.handle) return null;            // 没登录 · 不提
  const cache = loadTodosCache();
  if (!cache || !Array.isArray(cache.todos)) return null;
  const today = todayKey();                          // 北京时间 YYYY-MM-DD · 跟 due 同格式
  const me = cfg.handle;
  // 属于我的 + 未完 + 到今天或已逾期:个人待办(我建的)或派给我的团队任务
  const due = cache.todos.filter(t =>
    !t.done && t.due && t.due <= today &&
    ((t.scope === 'personal' && (!t.owner || t.owner === me)) ||
     (t.scope === 'team' && t.assignee === me))
  );
  if (due.length === 0) return null;
  // 用户在 webapp 关了 todo-due · 或勿扰窗口内 · 静默(白拿现成勿扰逻辑)
  if (shouldSuppressKindLocal('todo-due', getPrefsSync())) return null;
  // 冷却:到期集合签名 + 时间窗
  const sig = due.map(t => t.id).sort().join(',');
  const st = loadPromptState();
  const last = st.todoDueNudge || {};
  const now = Date.now();
  if (last.sig === sig && last.at && (now - last.at) < TODO_DUE_COOLDOWN_MS) return null;
  st.todoDueNudge = { sig, at: now };
  savePromptState(st);
  // 拼提醒行 · 逾期的单拎出来说
  const overdue = due.filter(t => t.due < today);
  const titles = due.slice(0, 3).map(t => '「' + t.text.slice(0, 12).trim() + '」').join('');
  const more = due.length > 3 ? ' 等共 ' + due.length + ' 条' : '';
  const cntPart = overdue.length > 0
    ? `${due.length} 条待办到期(${overdue.length} 条已逾期)`
    : `${due.length} 条待办今天到期`;
  return `Tinker 待办提醒 · 你有 ${cntPart}: ${titles}${more} · tinker todo list 看 · 处理完 tinker todo done <id> · 别每次都催用户 · 看上下文挑合适时机提一句`;
}

// v0.17 `tinker pending` · 看 / 处理 hook 触发的待处理 reminder
// 设计:
//   --json           列待处理 (给 AI 工具用)
//   --check          UserPromptSubmit hook 用 · 命中静默 stdout 注入 AI context · 不打扰
//   --mark-handled <id>  标某条已处理
//   --clear          全清
//   不带 flag        人可读列表 (最近 10 条)
// 跨 AI 通用:Claude Code 用 hook 自动 check · Cursor / Aider 等 LLM 主动 Bash 跑 --json
function cmdPending(opts) {
  if (opts.clear) {
    if (fs.existsSync(pendingRemindersPath())) {
      try { fs.unlinkSync(pendingRemindersPath()); } catch {}
    }
    if (opts.json) return outputJson({ ok: true, cleared: true });
    ok('清空 pending reminders');
    return;
  }
  const reminders = readPendingReminders();
  if (opts.markHandled) {
    const id = opts.markHandled;
    let found = false;
    const updated = reminders.map(r => {
      if (r.id === id) { found = true; return { ...r, handled: true, handledAt: new Date().toISOString() }; }
      return r;
    });
    writePendingReminders(updated);
    if (opts.json) return outputJson({ ok: true, markedHandled: id, found });
    if (found) ok('标了 ' + id + ' 为已处理');
    else err('找不到 id: ' + id);
    return;
  }
  const pending = reminders.filter(r => !r.handled);
  if (opts.check) {
    // UserPromptSubmit hook 调用 · 跟用户每次说话时触发
    // 命中 pending → stdout 注入我 (AI) 的 context · 我看上下文判断要不要提醒用户
    // 没 pending → 静默退出 · 不打扰
    // 先现算到期待办提醒 · 跟 jsonl pending 独立 · 出错绝不拖垮 hook
    try { const dueLine = todoDueNudgeLine(); if (dueLine) process.stdout.write(dueLine + '\n'); } catch (e) {}
    if (pending.length === 0) return;
    // v0.35 服务器通知偏好闭环 · 屏蔽掉用户在 webapp 关掉的 kind + 勿扰窗口内全静默
    const prefs = getPrefsSync();
    const visible = pending.filter(r => !shouldSuppressKindLocal(r.kind, prefs));
    if (visible.length === 0) return;
    const recent = visible.slice(-3).map(r => `[${r.kind}] ${r.msg.slice(0, 60)}`).join(' / ');
    process.stdout.write(`Tinker hook 触发了 ${visible.length} 条待处理 reminder · 最近: ${recent} · 看完整列表 \`tinker pending --json\` · 跟用户聊到合适时机时建议 \`tinker resolve <choice> -m "..."\` 处理 · 或者 \`tinker pending --mark-handled <id>\` 标已处理 · 不每次都打扰用户\n`);
    return;
  }
  if (opts.json) return outputJson({ ok: true, count: pending.length, pending, handledCount: reminders.length - pending.length });
  if (pending.length === 0) {
    log(sepia('  没有待处理 reminder'));
    if (reminders.length > 0) log(sepia('  历史已处理 ' + reminders.length + ' 条 · 清掉跑 ') + vermilion('tinker pending --clear'));
    return;
  }
  log('');
  log(bold('  待处理 ' + pending.length + ' 条 (最近 10 条):'));
  log('');
  for (const r of pending.slice(-10)) {
    const t = new Date(r.at).toLocaleTimeString();
    log(vermilion('  [' + r.kind + ']') + sepia(' · ' + t + ' · ' + (r.commitSha || '').slice(0, 7) + ' · ' + (r.projectName || '')));
    log('  ' + r.msg);
    if (r.suggestion) log(sepia('    ' + r.suggestion));
    log(sepia('    id: ') + r.id);
    log('');
  }
  log(sepia('  处理一条: ') + vermilion('tinker resolve <choice> -m "..."'));
  log(sepia('  标已处理: ') + vermilion('tinker pending --mark-handled <id>'));
  log(sepia('  全清:     ') + vermilion('tinker pending --clear'));
}

// v0.12 `tinker struggle` · 看 / 关 / 重新激活 当前 struggle 状态
// 信任建设:让用户能看见 Tinker 在后台跟踪什么 · 能一键关
async function cmdStruggle(sub, opts = {}) {
  const struggleMod = getStruggleModule();
  const state = loadPromptState();
  const now = Date.now();

  const action = (sub || 'status').toLowerCase();

  if (action === 'status') {
    const cur = state.currentStruggle;
    if (opts.json) {
      const optedOut = state.struggleOptOutUntil && state.struggleOptOutUntil > now;
      const recent = struggleMod.listDossiers({ limit: 5 });
      return outputJson({
        ok: true,
        currentStruggle: cur ? {
          id: cur.id,
          topic: cur.topic,
          startedAt: cur.startedAt,
          endedAt: cur.endedAt || null,
          signalCount: (cur.signals || []).length,
          resolved: !!cur.resolved,
        } : null,
        optedOut: !!optedOut,
        optedOutUntil: optedOut ? state.struggleOptOutUntil : null,
        recent: recent.map(d => ({
          id: d.id, topic: d.topic, signals: (d.signals || []).length,
          resolved: !!d.resolved, startedAt: d.startedAt, endedAt: d.endedAt || null,
        })),
      });
    }
    log('');
    log(bold('Tinker 踩坑跟踪状态'));
    log('');
    if (state.struggleOptOutUntil && state.struggleOptOutUntil > now) {
      log(sepia('  跟踪已关 · 到 ' + new Date(state.struggleOptOutUntil).toLocaleString()));
      log(sepia('  重新开启: ') + vermilion('tinker struggle on'));
      log('');
      return;
    }
    if (!cur) {
      log(sepia('  当前没在跟踪任何 struggle · 安静'));
    } else {
      const span = Math.round((now - cur.startedAt) / 60000);
      log(sepia('  当前 struggle:'));
      log(sepia('    id     ') + cur.id);
      log(sepia('    话题   ') + bold(cur.topic || '(未推断)'));
      log(sepia('    起始   ') + new Date(cur.startedAt).toLocaleString() + sepia(` (${span} 分钟前)`));
      log(sepia('    信号   ') + bold((cur.signals || []).length + ' 条'));
      log(sepia('    状态   ') + (cur.resolved ? moss('已破局 (等草稿就绪 + 发)') : vermilion('还在折腾')));
    }
    const recent = struggleMod.listDossiers({ limit: 5 });
    const others = recent.filter(d => !cur || d.id !== cur.id);
    if (others.length > 0) {
      log('');
      log(sepia('  最近 ' + others.length + ' 段 (已存档):'));
      others.forEach(d => {
        const when = new Date(d.startedAt).toISOString().slice(0, 10);
        log(sepia('    · ') + when + sepia(' · ') + (d.topic || '(无)')
          + sepia(' · ') + (d.signals || []).length + ' 信号'
          + (d.resolved ? moss(' · 破局') : vermilion(' · 未完')));
      });
    }
    log('');
    log(sepia('  关闭跟踪 (24h): ') + vermilion('tinker struggle off'));
    log('');
    return;
  }

  if (action === 'off') {
    state.struggleOptOutUntil = now + 24 * 60 * 60 * 1000;
    state.currentStruggle = null;  // 顺手清掉
    savePromptState(state);
    if (opts.json) return outputJson({ ok: true, optedOutUntil: state.struggleOptOutUntil });
    log(sepia('  跟踪关了 · 到 ' + new Date(state.struggleOptOutUntil).toLocaleString()));
    log(sepia('  重新开启: ') + vermilion('tinker struggle on'));
    return;
  }

  if (action === 'on') {
    state.struggleOptOutUntil = null;
    savePromptState(state);
    if (opts.json) return outputJson({ ok: true });
    log(sepia('  跟踪开了'));
    return;
  }

  if (action === 'reset') {
    // v0.13 清掉当前 currentStruggle · 让状态机下次 cmdCheck 重新评估
    // 用于:lifecycle 类型误判时手动 reset (比如本来是 design-loop 被识别成 learning)
    const previousId = state.currentStruggle ? state.currentStruggle.id : null;
    state.currentStruggle = null;
    savePromptState(state);
    if (opts.json) return outputJson({ ok: true, cleared: previousId });
    if (previousId) {
      log(sepia('  清掉了: ') + bold(previousId));
      log(sepia('  下次 git commit 触发 hook 时会重新评估 · 也可以现在跑 ') + vermilion('tinker check'));
    } else {
      log(sepia('  当前没在跟踪 · 没什么可清'));
    }
    return;
  }

  if (opts.json) return errJson('用法: tinker struggle [status|off|on|reset]', 'BAD_ARG');
  err('用法: tinker struggle [status|off|on|reset]');
}

// v0.12 Breakthrough Autopsy
// 后台 detached child 调用 · tinker __autopsy <struggleId>
// 把 dossier 整理成四段 markdown · 写到 <repo>/.tinker/drafts/experience-<topic>.md
// 不阻塞主 hook · 失败容错 (fallback 到 template-based)
// v0.13 backfill 命令 · 用户主动回溯过往推演 / 学习 / 踩坑
// tinker situation backfill --type design-loop --hours 6
// 扫最近 N 小时 Claude 对话 · 构造 resolved dossier · 同步起草草稿
async function cmdSituationBackfill(opts) {
  const struggleMod = getStruggleModule();
  const hours = parseInt(opts.hours, 10) || 4;
  const type = opts.type || 'design-loop';
  const config = struggleMod.LIFECYCLE_CONFIGS[type];
  if (!config) {
    if (opts.quiet) return;  // hook 调用时安静失败 · 不卡 Claude Code
    err('不支持的 lifecycle 类型: ' + type + ' · 可用: ' + Object.keys(struggleMod.LIFECYCLE_CONFIGS).join(' / '));
    process.exit(1);
  }

  // post-commit hook 每次 commit 都后台 spawn backfill · 密集 commit 时会同一段事件生成多份草稿
  // quiet 模式 (hook 触发) 加 30 分钟 per-(cwd, type) 节流 · 手动跑不受影响
  if (opts.quiet) {
    const ps = loadPromptState();
    ps.lastBackfillAtByKey = ps.lastBackfillAtByKey || {};
    const key = type + '|' + process.cwd();
    const last = ps.lastBackfillAtByKey[key];
    const now = Date.now();
    const cooldownMs = 30 * 60 * 1000;
    if (last && (now - last) < cooldownMs) {
      try { logTriggerEvent('backfill-' + type, 'cooled_down', { remaining_ms: cooldownMs - (now - last) }); } catch {}
      return;
    }
    ps.lastBackfillAtByKey[key] = now;
    savePromptState(ps);
    try { logTriggerEvent('backfill-' + type, 'fired', { cooldown_min: 30 }); } catch {}
  }

  if (!opts.quiet) {
    log('');
    log(bold('━━━ tinker situation backfill ━━━'));
    log(sepia('  类型: ') + config.label + sepia(' · 时间窗: ') + hours + sepia(' 小时'));
    log('');
  }

  // 扫整个 N 小时 · cwd 跟 parent 都试
  const scan = struggleMod.scanClaudeRecent({ minutesBack: hours * 60, cwd: process.cwd() });
  if (scan.userMessages.length < 5) {
    if (opts.quiet) return;
    err('扫到只 ' + scan.userMessages.length + ' 条 user message · 太少 · 调大 --hours 试试');
    process.exit(1);
  }

  // 信号:匹配该 lifecycle 的 matchSignal
  const signalType = type === 'struggle' ? 'claude_fail' :
                     type === 'learning' ? 'claude_explore' :
                     type === 'design-loop' ? 'claude_debate' : 'claude';
  const signals = scan.userMessages
    .filter(m => config.matchSignal(m.text))
    .map(m => ({ at: m.ts, type: signalType, text: m.text.slice(0, 200) }));

  if (signals.length < 3) {
    if (opts.quiet) return;
    err('信号数 ' + signals.length + ' 太少 · 这段时间可能不是 ' + config.label + ' · 试别的 --type');
    process.exit(1);
  }

  const now = Date.now();
  const dossier = {
    id: type + '-backfill-' + new Date(now).toISOString().slice(0, 16).replace(/[-T:]/g, ''),
    lifecycleType: type,
    startedAt: scan.userMessages[0].ts,
    endedAt: scan.userMessages[scan.userMessages.length - 1].ts,
    justResolvedAt: now,
    resolved: true,
    consented: true,
    backfilled: true,
    signals,
    topic: struggleMod.inferTopic(signals),
  };
  struggleMod.saveDossier(dossier);

  if (!opts.quiet) {
    log(sepia('  扫到: ') + bold(scan.userMessages.length + ' 条 user message'));
    log(sepia('  信号: ') + bold(signals.length + ' 条匹配'));
    log(sepia('  话题推断: ') + bold(dossier.topic || '(未推)'));
    log(sepia('  dossier id: ') + dossier.id);
    log('');
    log(sepia('  起草中 (调 LLM · 可能需要 10-20 秒)...'));
    log('');
  }

  // 同步跑 autopsy · 不 spawn 因为用户主动等结果
  // hook 场景下也同步等 · 因为 SessionStart 后用户会立刻看新 Claude session · 草稿要就绪
  try {
    await cmdAutopsy(dossier.id, type);
  } catch (e) {
    if (opts.quiet) return;  // hook 场景失败安静吞 · 不卡 Claude Code
    throw e;
  }

  // 找新写的草稿 (按 mtime 排序)
  const draftDir = path.join(process.cwd(), '.tinker', 'drafts');
  if (fs.existsSync(draftDir)) {
    const drafts = fs.readdirSync(draftDir)
      .filter(f => f.endsWith('.md') && f.startsWith(config.draftPrefix + '-'));
    if (drafts.length > 0) {
      const newest = drafts
        .map(f => ({ f, mtime: fs.statSync(path.join(draftDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      const draftPath = path.join('.tinker/drafts', newest.f);
      if (opts.quiet) {
        // quiet 模式仍输出一行 · 给 Claude Code 用户看
        log(moss('  ✓ Tinker 起草了 ' + config.label + '草稿: ') + draftPath);
        log(sepia('     发: ') + vermilion(`tinker push ${draftPath} --as-${config.productTag}`));
      } else {
        log(moss('  ✓ 草稿就绪: ') + draftPath);
        log('');
        log(sepia('  改完一键发: ') + vermilion(`tinker push ${draftPath} --as-${config.productTag}`));
        log(sepia('  或者打开看一眼:'));
        log(sepia('    ') + vermilion('cat ' + draftPath));
      }
    }
  }
  if (!opts.quiet) log('');
}

async function cmdAutopsy(situationId, lifecycleTypeArg) {
  const struggle = getStruggleModule();
  const dossier = struggle.loadDossier(situationId);
  if (!dossier) return;  // 静默退出 · detached 不让用户看到错误

  // v0.13 lifecycle 框架 · type 来源优先: 显式参数 > dossier 字段 > 'struggle' (兼容老 dossier)
  const lifecycleType = lifecycleTypeArg || dossier.lifecycleType || 'struggle';
  const config = struggle.LIFECYCLE_CONFIGS[lifecycleType] || struggle.LIFECYCLE_CONFIGS.struggle;

  const draftDir = path.join(process.cwd(), '.tinker', 'drafts');
  fs.mkdirSync(draftDir, { recursive: true });

  // 文件名:experience-<safe-topic>-<short-id>.md / learning-<safe-topic>-<short-id>.md
  const safeTopic = (dossier.topic || 'unknown')
    .replace(/[\s\\/:*?"<>|]+/g, '-')
    .slice(0, 30);
  const shortId = dossier.id.slice(-6);
  const draftFile = path.join(draftDir, `${config.draftPrefix}-${safeTopic}-${shortId}.md`);

  // 收集 git 上下文 (突破那一刻的 fix / done commit)
  let fixTitle = '', fixBody = '', fixDiff = '';
  try {
    fixTitle = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    fixBody = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    fixDiff = execSync('git diff HEAD~1 HEAD --stat 2>/dev/null', { encoding: 'utf-8' }).trim().slice(0, 500);
  } catch {}

  // 组织 signals 时序 (按时间排序)
  const sortedSignals = (dossier.signals || []).slice().sort((a, b) => a.at - b.at);
  const signalLines = sortedSignals.slice(0, 20).map(s => {
    const when = new Date(s.at).toISOString().slice(11, 16);
    if (s.type === 'wip_commit') return `[${when}] commit · ${s.text || s.sha || ''}`;
    if (s.type === 'claude_fail') return `[${when}] 对话 · ${(s.text || '').slice(0, 100)}`;
    if (s.type === 'claude_explore') return `[${when}] 问 AI · ${(s.text || '').slice(0, 100)}`;
    return `[${when}] ${s.type} · ${(s.text || s.snippet || '').slice(0, 100)}`;
  }).join('\n');

  // 拉 voice 上下文
  const cfg = loadConfig();
  const hasLLM = cfg && cfg.llm && cfg.llm.apiKey;
  let voiceContext = '';
  try {
    const fp = loadFingerprint();
    if (fp) voiceContext = fp.slice(0, 1000);
  } catch {}

  const ctx = {
    topic: dossier.topic || '未命名',
    lifecycleType,
    spanHours: dossier.endedAt
      ? Math.max(0.1, Math.round((dossier.endedAt - dossier.startedAt) / 360000) / 10)
      : '?',
    signalLines, fixTitle, fixBody, fixDiff, voiceContext,
  };

  let markdown;
  if (hasLLM) {
    try {
      markdown = await llmAutopsy(cfg, ctx);
    } catch (e) {
      markdown = templateAutopsy({ dossier, lifecycleType, signalLines, fixTitle, fixBody });
    }
  } else {
    markdown = templateAutopsy({ dossier, lifecycleType, signalLines, fixTitle, fixBody });
  }

  // frontmatter · 标记 lifecycle type + product tag (给 push --as-X 用)
  const frontmatter = [
    '---',
    `situation_id: ${dossier.id}`,
    `lifecycle_type: ${lifecycleType}`,
    `topic: ${dossier.topic || ''}`,
    `started_at: ${new Date(dossier.startedAt).toISOString()}`,
    `ended_at: ${dossier.endedAt ? new Date(dossier.endedAt).toISOString() : ''}`,
    `signals: ${(dossier.signals || []).length}`,
    `as_${config.productTag}: true`,
    `generated_by: ${hasLLM ? 'llm' : 'template'}`,
    '---',
    '',
  ].join('\n');

  fs.writeFileSync(draftFile, frontmatter + markdown);
}

// LLM 调用 · 直接返 markdown · 不解析 JSON
// v0.13 按 lifecycleType 切 prompt 模板:struggle 写"踩坑经验" · learning 写"上手指南"
async function llmAutopsy(cfg, ctx) {
  const provider = cfg.llm.provider || 'anthropic';

  const lifecycleType = ctx.lifecycleType || 'struggle';
  const isLearning = lifecycleType === 'learning';
  const isDesignLoop = lifecycleType === 'design-loop';

  const taskLine = isLearning
    ? '你的任务: 把这次学新东西的过程整理成一篇能帮其他 vibe coder 快速上手的指南。'
    : isDesignLoop
    ? '你的任务: 把这次产品决策推演整理成一篇能帮其他 vibe coder 学 product sense 的样本。'
    : '你的任务: 把这次踩坑过程整理成一篇能帮其他 vibe coder 少踩坑的经验贴。';

  const infoLabel = isLearning ? '这次学习信息' : isDesignLoop ? '这次推演信息' : '这次踩坑信息';
  const commitLabel = isLearning ? '关键完成那一笔 commit' : isDesignLoop ? '相关 commit (推演不一定 commit 代码)' : '突破那一笔 commit';

  const designLoopTemplate = `工作日志气质 · 一段连贯的散文 · 不用 ## 标题切段 · 不用 bullet 列表 ·
段落之间用空行隔开 · 长度 200-400 字。

像作者平时写的进展那样:第一段直接说"刚理清楚一件事 / 想明白了..." 然后顺着叙述。

要包含的内容 (但用散文连起来 · 不是分点):
  1. 这次理清的核心问题是什么 (具体 · 不是 meta · 来自 signals 反复出现的具体业务名词)
  2. 真实考虑过的几种路径 (用"想过 X · 也想过 Y · 还试过 Z" 这种自然语言)
  3. 各自的权衡 (引用 signals 里出现过的具体约束 · 比如"alpha 期"  "vibe coder 新手")
  4. 最后选了什么 · 决定性理由

参考已有 update 气质 (作者自己写过的):
  "邮箱登录从代码到能真发出去 · 中间和阿里云邮件服务纠缠了 6 个小时。
   重设了 3 次密码、改了 2 次端口、查了 5 个怀疑点(账号未实名?账号余额?...) · 全部排除。
   ...
   问题在我们用的邮件库默认走 PLAIN 认证 · 阿里云只认 LOGIN。两行配置改完立刻通。"

  这是踩坑的真实 voice · 决策推演也用这种工作日志连贯叙事的气质。`;

  const learningTemplate = `工作日志气质 · 一段连贯的散文 · 不用 ## 标题切段 · 不用 bullet 列表 ·
段落之间用空行隔开 · 长度 200-400 字。

像作者写真实学习笔记那样:开头直接说"今天/这段时间把 X 大概搞清楚了" 然后顺着叙述。

要包含 (用散文连起来 · 不是分点):
  1. 想学什么具体技术 (来自 signals 的具体 SDK / API / 框架名)
  2. 几个核心概念是怎么想清楚的 (用散文描述心智模型 · 不列表)
  3. 入门时踩到的坑 (教程不会告诉的事 · 用"试了 X 发现 Y" 的叙事)
  4. 最后怎么跑通的 (含关键配置 / 代码片段 · 但用 inline 引号嵌进散文 · 不用 code block)

参考已有 update 气质:作者写阿里云邮件那段就是范例 · 保留具体错误码 / 配置名 ·
但全部用连贯散文 · 不用 markdown 装饰。`;

  const struggleTemplate = `工作日志气质 · 一段连贯的散文 · 不用 ## 标题切段 · 不用 bullet 列表 ·
段落之间用空行隔开 · 长度 200-400 字。

参考作者真实写过的踩坑总结 (照这个 voice 写):
  "邮箱登录从代码到能真发出去 · 中间和阿里云邮件服务纠缠了 6 个小时。
   重设了 3 次密码、改了 2 次端口、查了 5 个怀疑点(账号未实名?账号余额?...) · 全部排除。
   问题在我们用的邮件库默认走 PLAIN 认证 · 阿里云只认 LOGIN。两行配置改完立刻通。"

要包含 (用散文连起来 · 不是分点):
  1. 撞到什么具体问题 (含错误码 / 平台 / 表现)
  2. 试过的几条路 (用"试了 X 不行 · 又改了 Y 还是不行" 这种自然叙事)
  3. 最后发现的真正原因 (具体到平台限制 / 配置细节)
  4. 怎么解决的 (含关键配置 · 用 inline 引号嵌进散文 · 不要 code block)`;

  const outputTemplate = isDesignLoop ? designLoopTemplate : isLearning ? learningTemplate : struggleTemplate;

  const sceneSpecificConstraints = isLearning ? [
    '- ★ 工作日志气质 · 不是教程/文档气质 (这是 update 进展 · 不是方法库)',
    '  不用 ## 标题 · 不用 bullet 列表 · 不用 code block · 一段段散文',
    '- 用作者真实 voice · 自然段落 + 中文标点',
    '- 写给"也在想学这东西" 的读者 · 是工作笔记不是教程',
    '- 真实保留你撞过的具体陷阱 (跟教程的差异 · 自己摸过的边)',
    '- 含关键技术细节 (具体 SDK 版本 / API 名 / 配置) · 但用 inline 引号嵌进散文',
    '- 200-400 字 · 不必长 · 工作日志就该克制',
  ] : isDesignLoop ? [
    '- ★ 工作日志气质 · 不是文档/说明书气质',
    '  不用 ## 标题 · 不用 bullet · 一段一段连贯叙事',
    '- ★ 主题必须来自 signals 实际讨论的具体事 · 不是 meta 抽象',
    '  反例: "决策怎么沉淀给别人复用"  "推演机制怎么打造"  这种 meta 元话题不可接受',
    '  正例: "方法跟进展项目是什么关系"  "接走该不该改名启发"  "borrow 搜什么池"',
    '- 用作者真实 voice (从 fingerprint 学) · 自然段落 + 中文标点',
    '- 真实保留考虑过但拒绝的方案 · 但用"想过 X 也试过 Y" 散文连',
    '- 权衡引用 signals 里的具体约束 (alpha 期 / 用户量 / 信息密度 / 自动化优先)',
    '- 不下"正确答案" 定论 · 决策有上下文 · 别人换上下文可能选别的',
    '- 200-400 字 · 不必长 · 工作日志就该克制',
  ] : [
    '- ★ 工作日志气质 · 不是教程/文档气质 (这是 update 进展 · 不是方法库)',
    '  不用 ## 标题 · 不用 bullet 列表 · 不用 code block · 一段段散文',
    '- 用作者真实 voice · 自然段落 + 中文标点',
    '- 不替作者编情绪 · "终于" 这种词只在 commit msg 真说过时用',
    '- 保留具体平台名 / 错误码 / 配置 (这些是检索的钩子) · 但用 inline 引号嵌进散文',
    '- 200-400 字 · 工作日志就该克制 · 不必长',
  ];

  const prompt = `${taskLine}

==================
作者 voice 上下文 (照这个气质写)
==================
${ctx.voiceContext || '(暂无 voice fingerprint · 用工艺人日志气质 · 中文 · 不堆中圆点 / em-dash / italic / ALL_CAPS)'}

==================
${infoLabel}
==================
话题: ${ctx.topic}
跨度: ${ctx.spanHours} 小时

时序信号 (按时间排序 · 节选):
${ctx.signalLines || '(无)'}

${commitLabel}:
title: ${ctx.fixTitle}
body: ${ctx.fixBody || '(无 body)'}
diff: ${ctx.fixDiff || '(无 diff)'}

==================
输出
==================
严格按这四段 markdown 输出 · 每段标题用 ##:

${outputTemplate}

约束:
- 用作者真实 voice
- 不堆中圆点 (·) · 不堆 em-dash · 不堆 italic · 不 ALL_CAPS
${sceneSpecificConstraints.join('\n')}
- 不要写"总结" 或 "结论" 段 · 四段就是全部
- 不要任何 LLM 自我介绍 · 直接出正文`;

  const { text, tokens } = await callLLM(cfg, provider, prompt, { maxTokens: 1500 });
  let rawText = text;
  recordLLMUsage(provider, tokens, 'autopsy');

  // sanitize · 去 em-dash / 多余中圆点 / ANSI / 代码块包裹
  rawText = rawText.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '');
  if (typeof sanitizeDraft === 'function') {
    rawText = sanitizeDraft(rawText);
  }
  return rawText;
}

// LLM 失败时的 fallback · 不调任何 API · 直接拼时序
// v0.13 按 lifecycleType 切段落
function templateAutopsy({ dossier, lifecycleType = 'struggle', signalLines, fixTitle, fixBody }) {
  const isLearning = lifecycleType === 'learning';
  const isDesignLoop = lifecycleType === 'design-loop';
  const productTag = isDesignLoop ? 'decision' : isLearning ? 'learning' : 'experience';

  if (isDesignLoop) {
    return `(LLM 没起草 · template 兜底 · 把下面信息组成一段工作日志气质的连贯散文 · 不用 markdown 标题)

刚理清楚一件事 (待补 · 看下面信号补具体在想什么)。

想过几种走法:
${signalLines || '(信号不足 · 自己回忆补一下)'}

最后决定 (待补 · 选了哪种 · 决定性理由是什么)。

${fixTitle ? '相关 commit: ' + fixTitle : ''}

---

(LLM 没起草 · 这是 template 兜底 · 改成连贯散文再发 · \`tinker push <这个文件> --as-${productTag}\`)
`;
  }

  if (isLearning) {
    return `(LLM 没起草 · template 兜底 · 把下面信息组成一段工作日志气质的连贯散文 · 不用 markdown 标题)

最近这段时间在搞 (具体技术 / SDK / 框架 · 看下面信号补)。

试着摸了一遍 · 几个核心概念是 (待补)。

入门时撞到的坑:
${signalLines || '(信号不足 · 自己回忆补一下)'}

最后跑通的方式:
${fixTitle}
${fixBody ? '\\n' + fixBody : ''}

---

(LLM 没起草 · 这是 template 兜底 · 改成连贯散文再发 · \`tinker push <这个文件> --as-${productTag}\`)
`;
  }

  return `(LLM 没起草 · template 兜底 · 把下面信息组成一段工作日志气质的连贯散文 · 不用 markdown 标题)

这次撞到 (待补 · 具体平台 / 错误码 / 表现 · 看下面信号)。

试了几条路:
${signalLines || '(信号不足 · 自己回忆补一下)'}

最后发现真正原因 · 解法是:
${fixTitle}
${fixBody ? '\\n' + fixBody : ''}

---

(LLM 没起草 · 这是 template 兜底 · 改成连贯散文再发 · \`tinker push <这个文件> --as-${productTag}\`)
`;
}

// `tinker session status | end` · 看 / 强制结束 当前 UI session
async function cmdSession(sub, opts = {}) {
  const state = loadPromptState();
  const session = state.uiSession;

  if (opts.json) {
    if (sub === 'end') {
      if (!session) { outputJson({ ok: true, ended: false, note: '没有 session 在进行' }); return; }
      session.startedAt = Date.now() - 61 * 60 * 1000;
      state.uiSession = session;
      savePromptState(state);
      outputJson({ ok: true, ended: true });
      return;
    }
    // status (默认)
    if (!session) {
      outputJson({ ok: true, active: false });
      return;
    }
    const elapsed = Math.round((Date.now() - session.startedAt) / 60000);
    outputJson({
      ok: true,
      active: true,
      startedAt: session.startedAt,
      startCommitHash: session.startCommitHash,
      commitCount: session.commitCount,
      elapsedMinutes: elapsed,
      beforeSnapshotPath: session.beforeSnapshotPath || null,
      endConditions: {
        timeWindowMinutesLeft: Math.max(0, 60 - elapsed),
        commitsLeft: Math.max(0, 6 - session.commitCount),
        timeExpired: elapsed >= 60,
        tooMany: session.commitCount >= 6,
      },
    });
    return;
  }

  if (sub === 'status' || !sub) {
    if (!session) {
      log(sepia('  当前没有 UI session 进行中'));
      log(sepia('  会在下一次改 webapp/* / *.html / *.css / .tsx 之类的文件时启动'));
      return;
    }
    const elapsed = Math.round((Date.now() - session.startedAt) / 60000);
    log('');
    log(sepia('  UI session 进行中:'));
    log(sepia('    起点  ') + new Date(session.startedAt).toLocaleString() + sepia(' · ') + bold(elapsed + ' 分钟前'));
    log(sepia('    起始 commit ') + sepia(session.startCommitHash.slice(0, 8)));
    log(sepia('    累积 ') + bold(session.commitCount + ' 个 UI commit'));
    log(sepia('    before 快照 ') + (session.beforeSnapshotPath ? sepia(session.beforeSnapshotPath) : sepia('(没存上)')));
    log('');
    log(sepia('  结束条件 (满足任一):'));
    log(sepia('    · 60 min 时间窗') + (elapsed >= 60 ? bold(' (已超 · 下次 commit 会触发)') : sepia(` · 还剩 ${60 - elapsed} 分钟`)));
    log(sepia('    · 累 6 commit') + (session.commitCount >= 6 ? bold(' (已超 · 下次 commit 会触发)') : sepia(` · 还差 ${6 - session.commitCount}`)));
    log(sepia('    · commit msg 写 ship/done/完工'));
    log('');
    log(sepia('  强制结束: ') + vermilion('tinker session end'));
    return;
  }
  if (sub === 'end') {
    if (!session) { log(sepia('  没有 session 在进行 · 没事可结束')); return; }
    // 直接把 session 时间往回拨 · 让下一次 check 评估为已结束
    session.startedAt = Date.now() - 61 * 60 * 1000;
    state.uiSession = session;
    savePromptState(state);
    ok('session 标记为结束 · 下次 commit 时会触发 prompt');
    log(sepia('  想立刻看到 prompt 不等下次 commit · 跑 ') + vermilion('tinker check'));
    return;
  }
  err('用法: tinker session [status|end]');
  process.exit(1);
}

// v0.3 pending file · 给 --json 模式持久化 prompt 状态 · 后续 tinker resolve 用
function pendingPath() { return path.join(CONFIG_DIR, 'pending.json'); }
function savePending(p) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(pendingPath(), JSON.stringify(p, null, 2));
}
function loadPending() {
  if (!fs.existsSync(pendingPath())) return null;
  try { return JSON.parse(fs.readFileSync(pendingPath(), 'utf-8')); } catch { return null; }
}
function clearPending() {
  if (fs.existsSync(pendingPath())) { try { fs.unlinkSync(pendingPath()); } catch {} }
}

// v0.17 pending-reminders.jsonl · 累积所有 hook 触发的 reminder
// 跟 pending.json 不同:pending.json 是单条覆盖 (老 flow tinker resolve 用 · 同 commit 内只能记一个)
// jsonl 是累积 · 历史所有 reminder 都在 · 任何 AI / 用户能 scan 看到"漏掉的 ship / clever-fix 等"
function pendingRemindersPath() { return path.join(CONFIG_DIR, 'pending-reminders.jsonl'); }
function appendPendingReminder(entry) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(pendingRemindersPath(), JSON.stringify(entry) + '\n');
  } catch { /* 失败静默 · 别阻塞 hook */ }
}
function readPendingReminders() {
  if (!fs.existsSync(pendingRemindersPath())) return [];
  try {
    const lines = fs.readFileSync(pendingRemindersPath(), 'utf-8').split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function writePendingReminders(arr) {
  try {
    fs.writeFileSync(pendingRemindersPath(), arr.map(r => JSON.stringify(r)).join('\n') + (arr.length > 0 ? '\n' : ''));
  } catch { /* 失败静默 */ }
}

// v0.17 bridge auto-ping config · post-commit hook 命中触发器后自动发 bridge ping
// 默认 disabled · 用户主动开 + 选 kinds + 选目标 handle (null = 广播给团队所有人)
// 触发流程: cmdCheck --json 命中 → appendPendingReminder → maybeAutoPing → fetch /api/bridge/send
function autoPingConfigPath() { return path.join(CONFIG_DIR, 'bridge-auto-ping.json'); }
function loadAutoPingConfig() {
  if (!fs.existsSync(autoPingConfigPath())) {
    return { enabled: false, kinds: ['ship', 'stuck'], toHandle: null };
  }
  try { return JSON.parse(fs.readFileSync(autoPingConfigPath(), 'utf-8')); }
  catch { return { enabled: false, kinds: ['ship', 'stuck'], toHandle: null }; }
}
function saveAutoPingConfig(c) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(autoPingConfigPath(), JSON.stringify(c, null, 2));
}

// 触发器命中后 · 看配置 · 命中就 ping
// 失败静默 · 不阻塞 hook · 不影响 commit
async function maybeAutoPing(triggerResult, repoCfg, cfg) {
  try {
    const apCfg = loadAutoPingConfig();
    if (!apCfg.enabled) return;
    // result.kind 是 trigger kind (ship / stuck / clever-fix / decision 等)
    // result.reason 也行 · 比如 keyword-ship · 取前缀
    const kind = triggerResult.kind || (triggerResult.reason || '').replace(/^keyword-/, '');
    if (!apCfg.kinds.includes(kind)) return;
    // v0.35 服务器通知偏好 · 我自己在勿扰 / 关掉了这个 kind · 就不主动 ping 队友
    const prefs = getPrefsSync();
    if (shouldSuppressKindLocal(kind, prefs)) {
      logTriggerEvent(kind, 'auto_ping_suppressed_by_prefs', { to: apCfg.toHandle || 'broadcast' });
      return;
    }
    const bridgeLib = require('../lib/bridge');
    if (!bridgeLib.hasSecret()) return;  // 没设暗号 · 静默放弃
    const secret = bridgeLib.loadSecret();
    const title = `[auto] ${kind} · @${cfg.handle}`;
    const body = `${triggerResult.msg || ''}\n${triggerResult.suggestion || ''}\n${repoCfg.projectName || ''}`.trim();
    const level = (kind === 'stuck' || kind === 'frustrated') ? 'warn' : (kind === 'ship' ? 'ok' : 'info');
    const obj = { v: 1, title, body, level, at: Date.now(), autoPing: true, triggerKind: kind };
    const payload = bridgeLib.encrypt(JSON.stringify(obj), secret);
    const res = await fetch(cfg.serverUrl + '/api/bridge/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify({ to: apCfg.toHandle || null, kind: 'noti', payload }),
    });
    if (!res.ok) return;  // 失败静默
    // 成功 → log 一行 (hook stdout 会被丢 · 但 trigger-log 记一笔)
    logTriggerEvent(kind, 'auto_pinged', { to: apCfg.toHandle || 'broadcast' });
  } catch { /* 任何错都静默 · 不阻塞 hook */ }
}

// ── 团队命令 (工作室/接力/witness/team-knowledge/auto-ping) 已拆至 lib/team-commands.js ──
// v0.14 · 依赖注入工厂 · wiring 在文件末尾 main() 前 · 同名回填让调用点零改动

// 守门决策落档 · 留给后续看哪些 profile 的 false positive 多 / 阈值要不要调
// 现在不调阈值 · 先攒数据 · alpha 跑一两个月之后回头复盘
function recordVoiceDecision(d) {
  try {
    const file = path.join(CONFIG_DIR, 'voice-decisions.jsonl');
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      profile: d.profile || 'unknown',
      score: d.score,
      hits: d.hits,
      action: d.action,
    }) + '\n';
    fs.appendFileSync(file, line);
  } catch {}
}

// voice 守门 profile · 按"目标读者"分级 (不是按"功能类型"分)
// 产品视角:Tinker 服务两类用户 · vibe coder 本人 (人) + 他的 AI (AI)
// 同一条命令的不同部分可能服务不同读者 (handoff -m 给人 / dossier 给 AI)
// 调用方按"这段文字给谁看"选 profile
const VOICE_PROFILES = {
  for_humans_public: { warn: 2, block: 3 }, // 公开 feed · push / ship · 严查
  for_humans_team:   { warn: 2, block: 3 }, // 队友 + 他的 AI 一起读 · handoff -m / stuck · 严查 (数据多了再调)
  for_witness:       { warn: 4, block: 6 }, // AI 对谈 / 决策推演 · 半公开但本就是技术论证 · 结构化语言合理 · 松一档但不关 (纯 slop 还是拦)
  for_ai:            { warn: 99, block: 99 }, // AI 给 AI · 技术词清晰反而是优势
  internal:          { warn: 99, block: 99 }, // 不发出去 · 测试 / debug
};
function resolveVoiceProfile(name) {
  return VOICE_PROFILES[name] || VOICE_PROFILES.for_humans_public;
}

// 命令 → profile 声明表 · 集中维护 · 新加命令必须在这登记
// 不在表里 + 吃了 -m 文字 = 安全网报警 · 见 warnIfVoiceProfileMissing
// 加新命令的顺序:
//   1) 实现 cmdXxx · 想清楚文字给谁看 (人/AI/不发)
//   2) 在 cmd 内调 gateVoiceCheck(text, { profile: '...' })
//   3) 在这表里登记一笔 · 跟 cmd 实际用的 profile 对上
const VOICE_PROFILE_REGISTRY = {
  // 给人看 · 公开 feed
  push:             'for_humans_public',
  ship:             'for_humans_public',
  resolve:          'for_humans_public',
  contribute:       'for_humans_public',
  edit:             'for_humans_public',
  'edit-ship':      'for_humans_public',
  'edit-method':    'for_humans_public',

  // 给人看 · 队友 (含队友 AI 配合读)
  handoff:          'for_humans_team',
  stuck:            'for_humans_team',
  'team-knowledge': 'for_humans_team',
  witness:          'for_witness',
  note:             'for_humans_team',

  // AI 给 AI · 不查 · 但显式登记 · 不让安全网误报
  ping:             'for_ai',
  send:             'for_ai',

  // 内部 · 不发文字 · 起草 / 校验类
  draft:            'internal',
  'maybe-check':    'internal',
  scenario:         'internal',
  stash:            'internal',   // -m 是给自己的现场标签 · 不公开 · 不查
  feishu:           'internal',   // feishu notify 多是机器生成的投喂播报 · 不走 voice 守门
};

function warnIfVoiceProfileMissing(cmd, opts) {
  // 没吃文字 · 不关 voice 的事
  if (!opts || (!opts.text && !opts.body)) return;
  // 已登记 · OK
  if (cmd in VOICE_PROFILE_REGISTRY) return;
  // hook / json / 非 TTY 静默 (避免污染机器读的输出)
  if (opts.json || opts.fromHook || opts.fromClaude) return;
  process.stderr.write(
    "\n⚠ voice 守门安全网:命令 '" + cmd + "' 带了 -m 文字 · 但没在 VOICE_PROFILE_REGISTRY 登记\n" +
    "  默认按不查处理 · 这条文字会原样发出去\n" +
    "  修法:在 cli/bin/tinker.js 的 VOICE_PROFILE_REGISTRY 加一行 · 选 for_humans_public/team / for_ai / internal\n\n"
  );
}

async function gateVoiceCheck(text, opts = {}) {
  const profileName = opts.profile || 'for_humans_public';
  const profile = resolveVoiceProfile(opts.profile);
  let vc;
  try { vc = require('../lib/voice-check').detectAIVoice(text); }
  catch { return { ok: true }; }  // 模块缺失就静默通过 · 别因为守门挂掉主流程
  // force 强发 · 也要留底 (这些是"保安误报了"的候选样本 · 后续调阈值看)
  if (opts.force) {
    if (vc && vc.score >= profile.warn) {
      recordVoiceDecision({ profile: profileName, score: vc.score, hits: vc.list, action: 'forced' });
    }
    return { ok: true, forced: true };
  }
  if (!vc || vc.score < profile.warn) {
    recordVoiceDecision({ profile: profileName, score: vc ? vc.score : 0, hits: vc ? vc.list : [], action: 'pass' });
    return { ok: true };
  }
  const hits = (vc.list || []).join(' / ');
  recordVoiceDecision({ profile: profileName, score: vc.score, hits: vc.list, action: vc.score >= profile.block ? 'block' : 'warn' });
  // 强拒
  if (vc.score >= profile.block) {
    if (opts.json) return { ok: false, reason: 'voice 守门拒绝 · 命中 ' + vc.score + ' 条 AI 直出模式 (' + hits + ') · 加 --force 强发', code: 'VOICE_GATE_BLOCK' };
    log('');
    err('voice 守门拒绝 · 这段读着像 AI 直出 (命中 ' + vc.score + ' 条: ' + hits + ')');
    log(sepia('  建议:跑 ') + vermilion('tinker draft') + sepia(' 让 LLM 按你的 voice fingerprint 重写 · 再 ') + vermilion('tinker push <草稿>'));
    log(sepia('  或者:确认想这样发 · 加 ') + vermilion('--force') + sepia(' 跳过守门'));
    log('');
    return { ok: false, reason: 'blocked', code: 'VOICE_GATE_BLOCK' };
  }
  // score == 2 软警告
  if (opts.json) return { ok: true, warn: true, hits: vc.list, score: vc.score };
  log('');
  log(vermilion('  ⚠ voice 自检') + sepia(' · 这段读着有点像 AI 直出 (命中 ' + vc.score + ' 条: ' + hits + ')'));
  if (process.stdin.isTTY && process.stdout.isTTY) {
    try {
      const { confirm } = promptKit();
      const go = await confirm({ message: '还是要发吗?', default: true });
      if (!go) {
        log(sepia('  没发 · 跑 ') + vermilion('tinker draft') + sepia(' 让 LLM 按你 voice 重写一下'));
        return { ok: false, reason: 'user-cancelled', code: 'USER_CANCELLED' };
      }
    } catch { /* 没装 inquirer 走默认 · 通过 */ }
  } else {
    log(sepia('  非 TTY · 默认放过 · 想拦加 --force 反义'));  // 非 TTY 仅警告 · 不拦
  }
  return { ok: true, warned: true };
}

// v0.4 Phase 4 · 检测作者改稿 · 保存 reject-diff 给未来 LLM 学习
// LLM 草稿放在 ~/.tinker/last-llm-draft.json (cmdDraft 生成时写)
// 跟 cmdResolve 实际发出的 text 比较 · 不一样就 save 一条 diff
function saveRejectDiffIfChanged(pending, choice, finalText) {
  if (!finalText || !finalText.trim()) return;
  try {
    const lastDraftFile = path.join(CONFIG_DIR, 'last-llm-draft.json');
    if (!fs.existsSync(lastDraftFile)) return;  // 没起草过 LLM 草稿 · 不算改稿
    const lastDraft = JSON.parse(fs.readFileSync(lastDraftFile, 'utf-8'));
    if (!lastDraft || !lastDraft.text) return;
    // 30 分钟超时 · 太久就不算同一次
    if (Date.now() - lastDraft.at > 30 * 60 * 1000) return;
    const draftText = lastDraft.text.trim();
    const final = finalText.trim();
    if (draftText === final) return;  // 没改 · 不算 reject
    // 改了 · 但不能差太多 (否则可能根本是手写的不是基于草稿改) · 用 length ratio 判断
    const lenRatio = Math.min(draftText.length, final.length) / Math.max(draftText.length, final.length);
    if (lenRatio < 0.3) return;  // 长度差超过 3 倍 · 不算同一条的改稿
    const dir = path.join(CONFIG_DIR, 'style-pool', 'reject-diff');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const out = {
      at: new Date().toISOString(),
      choice,
      project: (pending && pending.projectName) || '',
      commit: (pending && pending.commitTitle) || '',
      llmDraft: draftText,
      finalText: final,
    };
    fs.writeFileSync(path.join(dir, `${stamp}-${choice}.json`), JSON.stringify(out, null, 2));
    // 用完即删 · 防止同一草稿被多次 reject
    try { fs.unlinkSync(lastDraftFile); } catch {}
  } catch {}
}

// 给 cmdCheck (interactive mode) 用 · 构造一个 pending-like 对象给 savePoolSample
// 让交互模式手敲的 update 也进 style-pool · 跟 cmdResolve (AI 模式) 的样本平等收集
function buildPendingForSample(repoCfg, result) {
  let commitTitle = '';
  try { commitTitle = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim(); } catch {}
  return {
    projectId: repoCfg && repoCfg.projectId,
    projectName: repoCfg && repoCfg.projectName,
    kind: result && result.kind,
    commitTitle,
  };
}

// v0.4 Phase 1 · 静默收集 voice sample 到 ~/.tinker/style-pool/good/
// 每次成功 push (从 cmdResolve 或 cmdCheck) 时调一次 · 累积作者真实风格样本
// 之后 tinker voice analyze 会读这个池子总结 fingerprint
function savePoolSample(pending, choice, text, handle) {
  if (!text || !text.trim()) return;
  try {
    const dir = path.join(CONFIG_DIR, 'style-pool', 'good');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const file = path.join(dir, `${stamp}-${choice}.md`);
    const meta = [
      '---',
      `handle: ${handle || ''}`,
      `at: ${new Date().toISOString()}`,
      `choice: ${choice}`,
      `kind: ${(pending && pending.kind) || ''}`,
      `project: ${(pending && pending.projectName) || ''}`,
      `commit: ${(pending && pending.commitTitle) || ''}`,
      '---',
    ].join('\n');
    fs.writeFileSync(file, `${meta}\n\n${text.trim()}\n`);
  } catch {
    // 静默失败 · 不打扰主流程
  }
}

// v0.3 cmdResolve · 接受外部 (AI agent) 决定的 choice + 可选 text · 执行 pending 动作
// 用法:
//   tinker resolve push-decision --message "装了 fnm 替代 nvm · 启动快多了"
//   tinker resolve ship -m "..."
//   tinker resolve stuck -m "..."
//   tinker resolve later        # 不需要 text
//   tinker resolve skip-today
//   tinker resolve mute
//   tinker resolve mute-30m
//   tinker resolve skip-once
async function cmdResolve(choice, opts) {
  if (!choice) { err('用法: tinker resolve <choice-id> [-m "文本"]'); process.exit(1); }
  const pending = loadPending();
  if (!pending) { err('没有待处理的提示 (pending.json) · 先跑 tinker check --json'); process.exit(1); }
  const text = (opts && opts.text || '').trim();
  const state = loadPromptState();
  const now = Date.now();
  state.lastPromptedAt = now;
  // v0.13 per-reason 冷却:pending.reason 在 cmdCheck --json 时存进了 pending
  // 老 pending 可能没 reason 字段 · 兜底 '_default'
  if (pending.reason) {
    state.lastPromptedAtByReason = state.lastPromptedAtByReason || {};
    state.lastPromptedAtByReason[pending.reason] = now;
  }

  // 文本类动作:需要 -m "..."
  const needsText = ['push', 'push-brand-self', 'push-brand-meta', 'push-decision', 'ship', 'prototype', 'stuck', 'stuck-quiet', 'ui-push'];
  if (needsText.includes(choice) && !text) {
    err('这个动作需要文本: tinker resolve ' + choice + ' -m "一句话"');
    process.exit(1);
  }

  try {
    if (choice === 'push' || choice === 'push-brand-self' || choice === 'push-brand-meta' || choice === 'push-decision') {
      const cfg = mustHaveConfig();
      // v0.20 voice 守门 · AI agent 走 tinker resolve push -m "..." 路径 · 同样要过
      const gate = await gateVoiceCheck(text, opts);
      if (!gate.ok) {
        if (opts.json) return errJson(gate.reason || 'voice 守门拦了', gate.code || 'VOICE_GATE_BLOCK');
        process.exit(1);
      }
      await apiAction(cfg, 'addUpdate', { projectId: pending.projectId, text });
      state.lastPushAtByProject = state.lastPushAtByProject || {};
      state.lastPushAtByProject[pending.projectId] = now;
      savePoolSample(pending, choice, text, cfg.handle);
      saveRejectDiffIfChanged(pending, choice, text);
      const okMsg = choice === 'push-decision' ? '✓ 决策记下来了' : '发出去了';
      ok(okMsg);
    } else if (choice === 'ship' || choice === 'prototype') {
      const cfg = mustHaveConfig();
      await apiAction(cfg, 'exhibitProject', {
        projectId: pending.projectId,
        kind: choice,
        statement: text,
        seekingFeedback: true,
      });
      state.lastPushAtByProject = state.lastPushAtByProject || {};
      state.lastPushAtByProject[pending.projectId] = now;
      savePoolSample(pending, choice, text, cfg.handle);
      saveRejectDiffIfChanged(pending, choice, text);
      ok(choice === 'ship' ? '✦ 完工 · 已进陈列馆' : '◐ 原型 · 已进陈列馆');
    } else if (choice === 'stuck' || choice === 'stuck-quiet') {
      const cfg = mustHaveConfig();
      await apiAction(cfg, 'changeProjectStatus', { projectId: pending.projectId, newStatus: 'stuck' });
      await apiAction(cfg, 'addUpdate', { projectId: pending.projectId, text });
      state.lastPushAtByProject = state.lastPushAtByProject || {};
      state.lastPushAtByProject[pending.projectId] = now;
      savePoolSample(pending, choice, text, cfg.handle);
      saveRejectDiffIfChanged(pending, choice, text);
      ok('⚠ 卡住了 · 已通知关心你的人');
    } else if (choice === 'later') {
      // v0.13: per-reason 延后 · 用 pending.reason · 兜底 '_default' (老 pending 没 reason 字段)
      state.laterUntilByReason = state.laterUntilByReason || {};
      state.laterUntilByReason[pending.reason || '_default'] = now + 60 * 60 * 1000;
      ok('这一类 (' + (pending.reason || '_default') + ') 1 小时后再问');
    } else if (choice === 'skip-today') {
      state.dismissedTodayKey = todayKey();
      ok('今天不再问 · 明天见');
    } else if (choice === 'skip-once') {
      ok('好 · 接着搞');
    } else if (choice === 'mute') {
      state.mutedUntil = now + 24 * 60 * 60 * 1000;
      ok('静音 24 小时');
    } else if (choice === 'mute-30m') {
      state.mutedUntil = now + 30 * 60 * 1000;
      ok('暂停 30 分钟 · 出去走走');
    } else if (choice === 'ui-push') {
      // v0.56 AI 模式也支持 before/after 对比图
      // deploy watcher 是 detached 后台进程 · 不需要 TTY · 原来"alpha 不支持"只是保守
      // 截图省着用: before 在 session 开始时已抓过 (复用) · 这里只多 1 次 after 抓取
      const cfg = mustHaveConfig();
      const gate = await gateVoiceCheck(text, opts);
      if (!gate.ok) {
        if (opts.json) return errJson(gate.reason || 'voice 守门拦了', gate.code || 'VOICE_GATE_BLOCK');
        process.exit(1);
      }
      const pushResult = await apiAction(cfg, 'addUpdate', { projectId: pending.projectId, text });
      const updateId = pushResult && (pushResult.result?.id || pushResult.id);
      state.lastPushAtByProject = state.lastPushAtByProject || {};
      state.lastPushAtByProject[pending.projectId] = now;
      savePoolSample(pending, 'ui-push', text, cfg.handle);
      saveRejectDiffIfChanged(pending, 'ui-push', text);

      // before 快照在 UI session 开始时抓的 · 在 prompt-state 里 · 复用 · 不重抓
      const beforePath = state.uiSession && state.uiSession.beforeSnapshotPath;
      state.uiSession = null;  // 清掉 · 下一波 UI 启动新 session
      if (updateId && beforePath && fs.existsSync(beforePath)) {
        spawnDeployWatcher({
          updateId,
          projectId: pending.projectId,
          text,
          beforeSnapshotPath: beforePath,
          serverUrl: cfg.serverUrl,
          token: cfg.token,
          startedAt: Date.now(),
        });
        ok('发出去了 · 后台等 deploy 完会自动贴 before/after 对比图 (只多花 1 次截图额度)');
      } else {
        ok('发出去了 · (没找到 before 快照 · 这次不贴对比图)');
      }
    } else {
      err('未知 choice: ' + choice);
      process.exit(1);
    }
    savePromptState(state);
    clearPending();
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

// v0.4 Phase 2 · 读 ~/.tinker/style-pool/good/*.md · 调 LLM 总结作者真实 voice fingerprint
// 输出到 当前 cwd 的 .tinker/voice-fingerprint.md
// 之后 tinker draft 应该读这个 fingerprint 加进 prompt (Phase 3 · 暂未做)
// v0.9 voice teach · 主动喂样本到 style-pool
// 用法:
//   tinker voice teach --from-claude        从 Claude Code 对话历史抽 user message
//   tinker voice teach --from-claude --limit 50   自定义条数 (默认 100)
//   tinker voice teach --file path/to/file.md     从单个文件读
// 交互式让用户标 y/n/skip · 分别进 good 池 / bad 池 / 跳过
// 直接监督 fingerprint 学习 · 是 v0.11 voice teach review 模式的核心
async function reviewCandidatesInteractively(candidates, cfg, sourceTag) {
  const { select } = promptKit();
  const goodDir = path.join(CONFIG_DIR, 'style-pool', 'good');
  const badDir = path.join(CONFIG_DIR, 'style-pool', 'bad');
  fs.mkdirSync(goodDir, { recursive: true });
  fs.mkdirSync(badDir, { recursive: true });

  let nGood = 0, nBad = 0, nSkip = 0, stopped = false;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    log('');
    log(sepia('  ── ') + bold((i + 1) + ' / ' + candidates.length) + sepia(' ──'));
    log('  ' + c.text.split('\n').join('\n  '));
    log('');
    let choice;
    try {
      choice = await select({
        message: '这条像不像你写的?',
        choices: [
          { name: '✓ 像我 · 进 good 池', value: 'y' },
          { name: '✗ 不像 · 进 bad 池 (告诉 LLM "别学这种")', value: 'n' },
          { name: '— 跳过 · 不打标', value: 'skip' },
          { name: '⏹ 停下 · 不看了', value: 'stop' },
        ],
      });
    } catch { choice = 'stop'; }

    if (choice === 'stop') { stopped = true; break; }
    if (choice === 'skip') { nSkip++; continue; }

    const targetDir = choice === 'y' ? goodDir : badDir;
    const ts = c.ts || Date.now();
    const stamp = new Date(ts).toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const file = path.join(targetDir, `${stamp}-teach-${sourceTag}-${i}.md`);
    const meta = ['---',
      `handle: ${cfg.handle || ''}`,
      `at: ${new Date(ts).toISOString()}`,
      `choice: teach-${sourceTag}-${choice === 'y' ? 'good' : 'bad'}`,
      `source: ${sourceTag}`,
      `reviewed_at: ${new Date().toISOString()}`,
      '---'].join('\n');
    fs.writeFileSync(file, `${meta}\n\n${c.text}\n`);
    if (choice === 'y') nGood++; else nBad++;
  }

  log('');
  log(sepia('  ── 完成 ──'));
  log(sepia('    good ') + moss(nGood + ' 篇'));
  log(sepia('    bad  ') + vermilion(nBad + ' 篇'));
  log(sepia('    skip ') + sepia(nSkip + ' 篇'));
  if (stopped) log(sepia('  (中途停下 · 没看完)'));
  log('');
  if (nGood + nBad >= 3) {
    log(sepia('  下一步: ') + vermilion('tinker voice analyze') + sepia(' 重新生成 fingerprint'));
  }
}

async function cmdVoiceTeach(opts) {
  const cfg = mustHaveConfig();

  if (!opts.fromClaude && !opts.fromTinker && !opts.file && !opts.review) {
    log(sepia('  用法:'));
    log(sepia('    ') + vermilion('tinker voice teach --from-claude'));
    log(sepia('      从 Claude Code 对话历史抽你说过的话当 sample (默认 100 条最近 · 自动加进 good 池)'));
    log(sepia('    ') + vermilion('tinker voice teach --from-claude --review'));
    log(sepia('      逐条让你标 y/n/skip · 分别进 good / bad / 跳过 (v0.11 新加)'));
    log(sepia('    ') + vermilion('tinker voice teach --from-tinker'));
    log(sepia('      回填:server 上自己最近 update 全部加进 good 池 (默认 30 条 · 自动去重)'));
    log(sepia('    ') + vermilion('tinker voice teach --review'));
    log(sepia('      从你最近 Tinker 推过的 update 里抽来 review (高信号样本 · v0.11 新加)'));
    log(sepia('    ') + vermilion('tinker voice teach --file <path>'));
    log(sepia('      从单个文件读 sample (整个文件当一篇)'));
    return;
  }

  // v0.11 review 模式 + 从 Tinker 自己 push 历史拉
  // v0.13 --from-tinker 默认 bulk · 回填 webapp 直发 / contribute --from-file 等不走 CLI 的 update
  const wantTinker = opts.fromTinker || (opts.review && !opts.fromClaude && !opts.file);
  if (wantTinker) {
    log(sepia('  从你最近的 Tinker update 抽样本...'));
    let candidates = [];
    try {
      const state = await apiState(cfg);
      for (const p of state.projects) {
        if (p.owner !== cfg.handle) continue;
        for (const u of (p.updates || [])) {
          if (u.text && u.text.length >= 30) candidates.push({ text: u.text, ts: u.at, updateId: u.id });
        }
      }
    } catch (e) { err('拉 Tinker 数据失败: ' + e.message); process.exit(1); }
    candidates.sort((a, b) => b.ts - a.ts);
    const N = opts.limit && opts.limit > 0 ? opts.limit : (opts.fromTinker ? 30 : 10);
    candidates = candidates.slice(0, N);
    if (candidates.length === 0) { log(sepia('  没有 update 可拉 · 先发几条再来')); return; }

    // review 模式 (review 显式)
    if (opts.review) {
      return reviewCandidatesInteractively(candidates, cfg, 'tinker-self');
    }

    // bulk 模式 (--from-tinker 默认) · 直接加 · 自动去重
    const dir = path.join(CONFIG_DIR, 'style-pool', 'good');
    fs.mkdirSync(dir, { recursive: true });
    // 去重:扫已有文件 · 读 frontmatter 里的 source_update_id · 兜底走 text head
    const existingIds = new Set();
    const existingHeads = new Set();
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        const idMatch = raw.match(/source_update_id:\s*(\S+)/);
        if (idMatch) existingIds.add(idMatch[1]);
        const bodyMatch = raw.match(/---\s*\n[\s\S]*?\n---\s*\n([\s\S]+)$/);
        if (bodyMatch) existingHeads.add(bodyMatch[1].trim().slice(0, 80));
      }
    } catch {}

    let added = 0, skipped = 0;
    candidates.forEach((m, i) => {
      if (existingIds.has(m.updateId)) { skipped++; return; }
      const head = m.text.trim().slice(0, 80);
      if (existingHeads.has(head)) { skipped++; return; }
      const ts = m.ts || Date.now();
      const stamp = new Date(ts).toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const file = path.join(dir, `${stamp}-backfill-tinker-${String(i).padStart(3, '0')}.md`);
      const meta = [
        '---',
        `handle: ${cfg.handle || ''}`,
        `at: ${new Date(ts).toISOString()}`,
        'choice: backfill-tinker',
        'source: Tinker server (回填)',
        `source_update_id: ${m.updateId}`,
        '---',
      ].join('\n');
      fs.writeFileSync(file, `${meta}\n\n${m.text}\n`);
      added++;
    });
    log('');
    ok(`加了 ${added} 条 · 跳过 ${skipped} 条 (已在 pool 里)`);
    if (added > 0) log(sepia('  下一步: ') + vermilion('tinker voice analyze') + sepia(' 生成 fingerprint'));
    return;
  }

  // 模式 1 · 从 Claude Code 对话历史抽
  if (opts.fromClaude) {
    const claudeBase = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeBase)) {
      err('找不到 ' + claudeBase + ' · 没有 Claude Code 对话历史');
      process.exit(1);
    }

    const messages = [];
    function walk(dir) {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith('.jsonl')) {
            try {
              const lines = fs.readFileSync(full, 'utf-8').split('\n').filter(Boolean);
              for (const line of lines) {
                try {
                  const obj = JSON.parse(line);
                  if (obj.type === 'user' && obj.message && obj.message.content) {
                    let content = '';
                    if (typeof obj.message.content === 'string') {
                      content = obj.message.content;
                    } else if (Array.isArray(obj.message.content)) {
                      content = obj.message.content
                        .filter(c => c.type === 'text' && c.text)
                        .map(c => c.text)
                        .join('\n');
                    }
                    if (content) {
                      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
                      messages.push({ text: content, ts });
                    }
                  }
                } catch {}
              }
            } catch {}
          }
        }
      } catch {}
    }

    log(sepia('  扫 ~/.claude/projects/ ...'));
    walk(claudeBase);
    log(sepia(`  找到 ${messages.length} 条 user message`));

    // 过滤
    const filtered = messages
      .map(m => ({ ...m, text: m.text.trim() }))
      .filter(m => m.text.length >= 30 && m.text.length <= 500)
      .filter(m => !m.text.startsWith('/'))             // skip slash command
      .filter(m => /[一-鿿]/.test(m.text))      // 含中文
      .filter(m => !/^[\s\d\W]*$/.test(m.text));        // 非纯符号 / 数字

    log(sepia(`  过滤后 ${filtered.length} 条候选 (长度 30-500 · 含中文 · 非 slash command)`));
    if (filtered.length === 0) {
      log(sepia('  没有合适的样本'));
      return;
    }

    // 按时间倒序 · 取最近 N 条
    filtered.sort((a, b) => b.ts - a.ts);
    const N = opts.limit && opts.limit > 0 ? opts.limit : 100;
    const picked = filtered.slice(0, N);

    // v0.11 --review · 逐条标 y/n/skip 而不是 bulk add
    if (opts.review) {
      return reviewCandidatesInteractively(picked, cfg, 'claude');
    }

    log('');
    log(vermilion(`  预览前 5 条 (将从这 ${picked.length} 条里全部加进 pool):`));
    picked.slice(0, 5).forEach((m, i) => {
      const preview = m.text.replace(/\n/g, ' ').slice(0, 100);
      log(sepia(`  ${i + 1}. `) + preview + (m.text.length > 100 ? sepia('...') : ''));
    });
    log('');

    let go;
    try {
      const { confirm } = promptKit();
      go = await confirm({ message: `把这 ${picked.length} 条加进 ~/.tinker/style-pool/good/ 吗?`, default: true });
    } catch { go = false; }
    if (!go) { log(sepia('  取消了')); return; }

    const dir = path.join(CONFIG_DIR, 'style-pool', 'good');
    fs.mkdirSync(dir, { recursive: true });
    picked.forEach((m, i) => {
      const ts = m.ts || Date.now();
      const stamp = new Date(ts).toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const file = path.join(dir, `${stamp}-teach-claude-${String(i).padStart(3, '0')}.md`);
      const meta = [
        '---',
        `handle: ${cfg.handle || ''}`,
        `at: ${new Date(ts).toISOString()}`,
        'choice: teach-claude',
        'source: Claude Code 对话历史',
        '---',
      ].join('\n');
      fs.writeFileSync(file, `${meta}\n\n${m.text}\n`);
    });
    log('');
    ok(`已加 ${picked.length} 条到 ~/.tinker/style-pool/good/`);
    log(sepia('  下一步: ') + vermilion('tinker voice analyze') + sepia(' 生成 fingerprint'));
    return;
  }

  // 模式 2 · 从单个文件读
  if (opts.file) {
    if (!fs.existsSync(opts.file)) { err('文件不存在: ' + opts.file); process.exit(1); }
    const raw = fs.readFileSync(opts.file, 'utf-8').trim();
    if (!raw) { err('文件是空的'); process.exit(1); }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const dir = path.join(CONFIG_DIR, 'style-pool', 'good');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${stamp}-teach-file.md`);
    const meta = [
      '---',
      `handle: ${cfg.handle || ''}`,
      `at: ${new Date().toISOString()}`,
      'choice: teach-file',
      `source: ${opts.file}`,
      '---',
    ].join('\n');
    fs.writeFileSync(file, `${meta}\n\n${raw}\n`);
    ok('已加 1 条到 ~/.tinker/style-pool/good/');
    log(sepia('  下一步: ') + vermilion('tinker voice analyze') + sepia(' 生成 fingerprint'));
  }
}

async function cmdVoiceAnalyze() {
  const cfg = mustHaveConfig();
  if (!cfg.llm || !cfg.llm.apiKey) {
    err('LLM 没配置 · 跑 ' + vermilion('tinker login') + ' 配一下');
    process.exit(1);
  }
  const poolDir = path.join(CONFIG_DIR, 'style-pool', 'good');
  if (!fs.existsSync(poolDir)) {
    log(sepia('  还没有 sample · style-pool 是空的'));
    log(sepia('  在 AI 模式下每次 ') + vermilion('tinker resolve push*') + sepia(' 会自动收集 · 用一段时间再 analyze'));
    return;
  }
  const files = fs.readdirSync(poolDir).filter(f => f.endsWith('.md')).sort();
  if (files.length < 3) {
    log(sepia(`  pool 太薄 (${files.length} 篇) · 至少需要 3 篇才能 analyze`));
    log(sepia('  少于 3 篇 fingerprint 会过拟合 · 再多发几条试试'));
    return;
  }
  log(sepia(`  读 ${files.length} 篇 sample...`));
  const samples = files.map(f => {
    const raw = fs.readFileSync(path.join(poolDir, f), 'utf-8');
    // 取 frontmatter 后的 text 内容
    const m = raw.match(/---\s*\n[\s\S]*?\n---\s*\n([\s\S]+)$/);
    return m ? m[1].trim() : raw.trim();
  }).filter(Boolean);

  const joined = samples.map((s, i) => `### 样本 ${i + 1}\n${s}\n`).join('\n');
  const prompt = `分析这位作者的语言风格,输出一份 voice fingerprint。这份 fingerprint 之后会喂给 LLM 起草草稿用,目的是让 LLM 模仿这位作者的真实气质。

==================
任务
==================
读这 ${samples.length} 篇真实 update,总结作者的:
- 节奏 (平均字数 / 句长 / 段落数)
- 标点偏好 (顿号 / 逗号 / 句号 / 中圆点 / em-dash / 引号类型和频率)
- 高频词汇 / 罕见词汇 / 完全没用过的词
- 开头习惯 (第一句话怎么开)
- 结尾习惯 (是否留 takeaway / 结尾是否带反思)
- 技术名词处理 (是否用 ALL_CAPS / 是否带版本号 / 是否解释术语)
- 工程化程度 (像 PM 周报 / 像私人日记 / 像工匠日志)
- 其他能让另一个 LLM mimic 这种气质的特征

==================
输出格式
==================
直接 markdown · 顶级标题用 \`##\` 不用 \`#\` · 不要"好的我来分析"这种废话开头 · 直接 fingerprint 正文。

==================
作者过去发过的 ${samples.length} 篇真实 update
==================
${joined}`;

  log(sepia('  调 LLM 分析中...'));
  const provider = cfg.llm.provider || 'deepseek';
  let fingerprint;
  try {
    const { text } = await callLLM(cfg, provider, prompt, { maxTokens: 3000 });
    fingerprint = text;
  } catch (e) {
    err('LLM 调用失败: ' + e.message);
    process.exit(1);
  }

  const tinkerDir = path.join(process.cwd(), '.tinker');
  try { fs.mkdirSync(tinkerDir, { recursive: true }); } catch {}
  const outFile = path.join(tinkerDir, 'voice-fingerprint.md');
  const header = `# voice fingerprint · @${cfg.handle || ''} · ${new Date().toISOString().slice(0, 10)}\n基于过去 ${samples.length} 篇真实 update 分析 · ${new Date().toLocaleString()}\n\n`;
  fs.writeFileSync(outFile, header + fingerprint + '\n');

  log('');
  ok('生成完成 → ' + sepia(path.relative(process.cwd(), outFile)));
  log('');
  log(sepia('  下一步 (Phase 3 暂未实现):'));
  log(sepia('    · tinker draft 还没读 fingerprint · 仍用 DEFAULT_VOICE 起草'));
  log(sepia('    · 等 sample 累积到 ' + bold('10+') + sepia(' 篇时再来 analyze 一次,fingerprint 会更准')));
  log('');
}

// 59 捕获借 · 把命中的一等方法记到 ~/.tinker/borrowed.jsonl
// 给"借了且跑通了自动回响"检测器当线索:methodId + 作者 + 文本指纹 + 时间
// 只记别人的、有 methodId 的 · 7 天外的自动剪掉 · 文件不无限长
const BORROWED_FILE = path.join(CONFIG_DIR, 'borrowed.jsonl');
function recordBorrowedMethods(cfg, query, hits) {
  const mine = cfg.handle;
  const fresh = (hits || [])
    .filter(h => h.methodId && h.ownerHandle && h.ownerHandle !== mine)
    .slice(0, 5)
    .map(h => ({
      methodId: h.methodId,
      owner: h.ownerHandle,
      scenario: (h.scenario || '').slice(0, 80),
      // 指纹:正文里最长的一行 (去空白) · 检测器拿它在对话里找强匹配
      fingerprint: (h.text || '').split('\n').map(s => s.trim()).filter(s => s.length >= 12).sort((a, b) => b.length - a.length)[0]?.slice(0, 120) || '',
      query: query.slice(0, 40),
      at: Date.now(),
    }));
  if (fresh.length === 0) return;
  let existing = [];
  try { existing = fs.readFileSync(BORROWED_FILE, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
  const cutoff = Date.now() - 7 * 86400000;
  // 同 methodId 去重保最新 · 7 天外剪掉
  const byId = {};
  for (const e of [...existing, ...fresh]) {
    if (e.at < cutoff) continue;
    byId[e.methodId] = e; // 后写的覆盖
  }
  const out = Object.values(byId).sort((a, b) => a.at - b.at);
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(BORROWED_FILE, out.map(e => JSON.stringify(e)).join('\n') + '\n');
  } catch {}
}

// 59b 检测 · 借了某方法、且在 Claude session 里跑通了 → 提示回个「用了」
// 保守到底:指纹够长(≥16)+ 在对话里出现 + 之后有"用户亲口说的"成功信号 · 三个都满足才算
// 宁可漏报不可误报 (误报=乱叫=跟回报引擎反着来) · 每个方法只提一次 · 永远只建议不自动发
const BORROW_SUCCESS_RE = /(跑通|搞定|成功|可以了|好了|解决了|通过了|没问题了|works|worked|fixed|passed)/i;

// 抽最近活跃 session 的 message 流 (带 role) · 给指纹/信号定位
function readRecentClaudeParts() {
  const claudeRoot = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeRoot)) return [];
  let newest = null, newestM = 0;
  try {
    for (const d of fs.readdirSync(claudeRoot)) {
      const full = path.join(claudeRoot, d);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(full, f);
        let s; try { s = fs.statSync(fp); } catch { continue; }
        if (s.mtimeMs > newestM) { newestM = s.mtimeMs; newest = fp; }
      }
    }
  } catch {}
  if (!newest) return [];
  let content = '';
  try { content = fs.readFileSync(newest, 'utf-8'); } catch { return []; }
  const parts = [];
  for (const line of content.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const msg = o.message;
    if (!msg) continue;
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) text = msg.content.map(c => (typeof c === 'string' ? c : (c && c.text) || '')).join(' ');
    if (text) parts.push({ role: o.type, text });
  }
  return parts;
}

function detectBorrowedMethodWorked() {
  let borrowed = [];
  try { borrowed = fs.readFileSync(BORROWED_FILE, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return { matches: [], borrowed: [] }; }
  const candidates = borrowed.filter(b => !b.notified && b.fingerprint && b.fingerprint.length >= 16);
  if (candidates.length === 0) return { matches: [], borrowed };
  const parts = readRecentClaudeParts();
  if (parts.length === 0) return { matches: [], borrowed };
  const matches = [];
  for (const b of candidates) {
    let fpIdx = -1;
    for (let i = 0; i < parts.length; i++) { if (parts[i].text.includes(b.fingerprint)) { fpIdx = i; break; } }
    if (fpIdx === -1) continue; // 指纹没在对话里出现 · 没真用
    let worked = false;
    for (let j = fpIdx; j < parts.length; j++) {
      if (parts[j].role === 'user' && BORROW_SUCCESS_RE.test(parts[j].text)) { worked = true; break; }
    }
    if (worked) matches.push(b);
  }
  return { matches, borrowed };
}

// hidden · UserPromptSubmit hook 调 · stdout 干净 (跟 notify-claude 一样不污染)
function cmdMaybeBorrowWorked(opts = {}) {
  const { matches, borrowed } = detectBorrowedMethodWorked();
  if (matches.length === 0) { if (opts.json) outputJson({ ok: true, fired: [] }); return; }
  const firedIds = new Set();
  for (const m of matches) {
    appendPendingReminder({
      id: 'bw-' + m.methodId, kind: 'borrowed-method-worked', at: Date.now(),
      msg: '你借了 @' + m.owner + ' 的方法' + (m.scenario ? ' (' + m.scenario + ')' : '') + ' · 看着在对话里跑通了',
      suggestion: '回个「用了」给 ta? ' + 'tinker used ' + m.methodId + ' -m "一句感想"',
      methodId: m.methodId, owner: m.owner,
    });
    firedIds.add(m.methodId);
  }
  // 标 notified · 同一条方法不再重复提
  try {
    const updated = borrowed.map(b => firedIds.has(b.methodId) ? { ...b, notified: true } : b);
    fs.writeFileSync(BORROWED_FILE, updated.map(e => JSON.stringify(e)).join('\n') + '\n');
  } catch {}
  if (opts.json) outputJson({ ok: true, fired: [...firedIds] });
}

// v0.12 方法库 · 搜 (借) 用法 · tinker borrow "supabase auth"
async function cmdBorrow(query, opts) {
  const cfg = loadConfig();
  if (!cfg.serverUrl) {
    if (opts.json) return errJson('未配置 serverUrl', 'NO_CONFIG');
    err('未配置 serverUrl · 先 tinker config'); process.exit(1);
  }
  const q = (query || '').trim();
  if (!q) {
    if (opts.json) return errJson('用法: tinker borrow "<关键词>"', 'NO_QUERY');
    log(sepia('  用法: ') + vermilion('tinker borrow "<关键词>"'));
    log(sepia('  例:   ') + vermilion('tinker borrow "阿里云 邮件"') + sepia(' (搜踩坑经验)'));
    log(sepia('  例:   ') + vermilion('tinker borrow "supabase 邮箱登录"') + sepia(' (搜方法)'));
    log(sepia('  加 --methods-only 只看方法 · --kind experience 只看踩坑经验'));
    log(sepia('  加 --discipline 设计 只看某个领域的方法 (产品/设计/数据与安全/工程/AI协作)'));
    return;
  }
  const url = new URL('/api/method/search', cfg.serverUrl);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(opts.limit || 10));
  if (opts.methodsOnly || opts['methods-only']) url.searchParams.set('methodsOnly', '1');
  if (opts.kind && ['method', 'experience', 'learning'].includes(opts.kind)) url.searchParams.set('kind', opts.kind);
  if (opts.discipline) url.searchParams.set('discipline', opts.discipline);
  // 带 handle 让作者收到反馈 (反馈闭环 v0.12) · 没登录就匿名
  if (cfg.handle) url.searchParams.set('borrower', cfg.handle);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const errMsg = '搜失败 · HTTP ' + res.status;
    if (opts.json) return errJson(errMsg, 'HTTP_' + res.status);
    err(errMsg); process.exit(1);
  }
  const data = await res.json();
  // 59 捕获借:把命中的一等方法本地记一笔 · 给"借了且跑通了自动回响"那个检测器当线索
  // (只记 methodId 的 · 那才能收 tinker used m-xxx · 自己的方法不记)
  try { recordBorrowedMethods(cfg, q, data.hits || []); } catch {}
  if (opts.json) return outputJson({ query: q, hits: data.hits || [] });
  const hits = data.hits || [];
  if (hits.length === 0) {
    log(sepia('  没搜到 "') + q + sepia('" · 试试别的词或者去掉 --methods-only'));
    return;
  }
  log('');
  log(sepia(`  搜到 ${hits.length} 条 · 关键词: `) + bold(q));
  log('');
  hits.forEach((h, i) => {
    // v0.13 四种标签 · 决策推演/经验/上手指南 排在方法之前 (更稀缺 · 更值得看)
    const flags = [];
    if (h.isDecision) flags.push(vermilion('[决策推演]'));
    if (h.isExperience) flags.push(vermilion('[踩坑经验]'));
    if (h.isLearning) flags.push(vermilion('[上手指南]'));
    if (h.isMethod) flags.push(vermilion('[方法]'));
    // v0.85 领域 · 给 AI 看 · 帮它判断这条方法适不适合当前任务
    if (h.discipline) flags.push(sepia('〔' + h.discipline + '〕'));
    const flag = flags.length ? ' ' + flags.join(' ') : '';
    const when = new Date(h.at).toISOString().slice(0, 10);
    log(bold(`  ${i + 1}. `) + h.projectName + sepia(' · @') + h.ownerHandle + sepia(' · ') + when + flag);
    const lines = h.text.split('\n').filter(Boolean).slice(0, 3);
    lines.forEach(line => log('     ' + line.slice(0, 120) + (line.length > 120 ? sepia('...') : '')));
    log(sepia(`     id: ${h.updateId}`));
    log('');
  });
  log(sepia('  借了哪条记得回头 ') + vermilion('tinker contribute') + sepia(' 把自己的总结也放进去'));

  // v0.94 追加匹配的求方法请求 · 低调放末尾 · 不污染方法结果
  try {
    const seekUrl = new URL('/api/seeking', cfg.serverUrl);
    seekUrl.searchParams.set('q', q);
    seekUrl.searchParams.set('limit', '3');
    const seekRes = await fetch(seekUrl.toString());
    if (seekRes.ok) {
      const seekData = await seekRes.json();
      const seekItems = (seekData.items || []).filter(s => s.ownerHandle !== cfg.handle);
      if (seekItems.length > 0) {
        log('');
        log(sepia('  ⊙ 有人在找类似的:'));
        seekItems.forEach(s => {
          log(sepia('    · ') + s.text.slice(0, 80) + (s.text.length > 80 ? sepia('...') : ''));
          log(sepia('      @' + s.ownerHandle + ' · ' + s.projectName + ' · id: ' + s.id));
        });
        log(sepia('  你知道怎么做? ') + vermilion('tinker contribute --from-file <文件> --reply <id>'));
      }
    }
  } catch {}
}

// v0.14 反馈链路三件套 · 让 CLI 也能完成 Tinker 反算法的核心闭环 (借了能回应 / 启发了能反馈)
// 之前 reactToProject / submitTinkered / deleteTinkered / markMethodUsed 这 4 个 server action
// 只有 webapp 在用 · CLI 没暴露 · 现在补上

// 从 p-xxx 直接 ID · 或从 URL 提取
function resolveProjectId(arg) {
  if (!arg) return null;
  if (arg.startsWith('p-')) return arg;
  // URL 形态: https://.../#/p/<handle>/<slug>  或  /#/p/<id>
  const m = arg.match(/p-[a-zA-Z0-9]+/);
  return m ? m[0] : null;
}

// tinker react <projectId|url> — toggle "想试试"
// 已标 → 撤回 (server 内部 toggle)
async function cmdReact(arg, opts) {
  const cfg = mustHaveConfig();
  const projectId = resolveProjectId(arg);
  if (!projectId) {
    if (opts.json) return errJson('用法: tinker react <projectId>', 'NO_PROJECT');
    err('用法: ' + vermilion('tinker react <projectId>') + sepia(' (例: tinker react p-mq10xkuo)'));
    process.exit(1);
  }
  try {
    const r = await apiAction(cfg, 'reactToProject', { projectId, level: 'wantToTry' });
    const action = (r && r.result && r.result.action) || 'add';
    if (opts.json) return outputJson({ ok: true, action, projectId });
    ok(action === 'undo' ? '撤回了想试试' : '标了想试试 · 项目作者会收到通知');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'REACT_FAILED');
    err(e.message); process.exit(1);
  }
}

// tinker tinkered <projectId|url> --name "..." --link "..." --inspired-by <updateId>
// --undo 撤回
// 必填: name / link / inspired-by  (link 必须 https://)
async function cmdTinkered(arg, opts) {
  const cfg = mustHaveConfig();
  const projectId = resolveProjectId(arg);
  if (!projectId) {
    if (opts.json) return errJson('用法: tinker tinkered <projectId> --name <> --link <> --inspired-by <updateId>', 'NO_PROJECT');
    err('用法: ' + vermilion('tinker tinkered <projectId> --name "..." --link "https://..." --inspired-by <updateId>'));
    err('  撤回: ' + vermilion('tinker tinkered <projectId> --undo'));
    process.exit(1);
  }
  if (opts.undo) {
    try {
      await apiAction(cfg, 'deleteTinkered', { projectId });
      if (opts.json) return outputJson({ ok: true, action: 'undo' });
      ok('撤回了接走 · 原作者通知也清了');
    } catch (e) {
      if (opts.json) return errJson(e.message, 'UNDO_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }
  if (!opts.name || !opts.link || !opts.inspiredBy) {
    if (opts.json) return errJson('必填: --name <> --link <https://...> --inspired-by <updateId>', 'MISSING_ARGS');
    err('必填: --name "你做的项目名" --link "https://..." --inspired-by <updateId>');
    process.exit(1);
  }
  try {
    await apiAction(cfg, 'submitTinkered', {
      projectId,
      name: opts.name,
      link: opts.link,
      inspiredByUpdateId: opts.inspiredBy,
    });
    if (opts.json) return outputJson({ ok: true, projectId, name: opts.name, link: opts.link, inspiredByUpdateId: opts.inspiredBy });
    ok('挂上了你的延伸版 · 原作者会收到通知');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'TINKERED_FAILED');
    err(e.message); process.exit(1);
  }
}

// tinker used <updateId> [-m "怎么用的"] — 标"用了 · 跑通了"
// server 要 updateIdx (按 at DESC 排) · 不是 updateId · 这里 CLI 拉 state 自己算
// toggle 行为:已标 → 撤回 · 没标 → 加
async function cmdUsed(updateId, opts) {
  const cfg = mustHaveConfig();
  // 一等方法路径 · tinker used m-xxx · 直接按 methodId 标 (59 的 AI 自动回响走这条)
  if (updateId && updateId.startsWith('m-')) {
    try {
      const r = await apiAction(cfg, 'markMethodUsed', { methodId: updateId, note: (opts.text || '').trim() });
      const action = (r && r.result && r.result.action) || 'add';
      if (opts.json) return outputJson({ ok: true, action, methodId: updateId });
      ok(action === 'undo' ? '撤回了"用了 · 跑通了"' : '标了"用了 · 跑通了" · 原作者会收到通知');
    } catch (e) {
      if (opts.json) return errJson(e.message, 'USED_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }
  if (!updateId || !updateId.startsWith('u-')) {
    if (opts.json) return errJson('用法: tinker used <updateId|methodId>', 'NO_ID');
    err('用法: ' + vermilion('tinker used <updateId 或 methodId>') + sepia(' (例: tinker used m-abc123 -m "我也跑通了")'));
    process.exit(1);
  }
  let state;
  try { state = await apiState(cfg); }
  catch (e) {
    if (opts.json) return errJson(e.message, 'STATE_FAILED');
    err(e.message); process.exit(1);
  }
  let foundProject = null, foundIdx = -1;
  for (const p of state.projects) {
    const idx = (p.updates || []).findIndex(u => u.id === updateId);
    if (idx >= 0) { foundProject = p; foundIdx = idx; break; }
  }
  if (!foundProject) {
    if (opts.json) return errJson('找不到 update: ' + updateId, 'NOT_FOUND');
    err('找不到这条 update: ' + updateId); process.exit(1);
  }
  if (foundProject.owner === cfg.handle) {
    if (opts.json) return errJson('不能给自己的进展标"用了"', 'SELF');
    err('不能给自己的进展标"用了"'); process.exit(1);
  }
  try {
    const r = await apiAction(cfg, 'markMethodUsed', {
      projectId: foundProject.id,
      updateIdx: foundIdx,
      note: (opts.text || '').trim(),
    });
    const action = (r && r.result && r.result.action) || 'add';
    if (opts.json) return outputJson({ ok: true, action, updateId, projectId: foundProject.id });
    ok(action === 'undo' ? '撤回了"用了 · 跑通了"' : '标了"用了 · 跑通了" · 原作者会收到通知');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'USED_FAILED');
    err(e.message); process.exit(1);
  }
}

// 收集我项目下的便签 (默认只待处理的) · 按时间倒序
function gatherMyNotes(state, myHandle, { includeResolved = false } = {}) {
  const out = [];
  for (const p of (state.projects || [])) {
    if (p.owner !== myHandle) continue;
    for (const n of (p.notes || [])) {
      if (!includeResolved && n.resolvedAt) continue;
      out.push({
        noteId: n.id, projectId: p.id, projectName: p.name,
        author: n.user, text: n.text || '', at: n.at, resolved: !!n.resolvedAt,
      });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

// tinker note-done            列我项目下待处理的便签 (编号)
// tinker note-done <n>        把第 n 条标成处理了
// tinker note-done <noteId>   按 id 标 (toggle · 再标一次撤销)
// 只有项目主人能标 · 跨人时便签作者收到回响 (自己给自己不发)
async function cmdNoteDone(arg, opts) {
  const cfg = mustHaveConfig();
  let state;
  try { state = await apiState(cfg); }
  catch (e) {
    if (opts.json) return errJson(e.message, 'STATE_FAILED');
    err(e.message); process.exit(1);
  }
  const myHandle = cfg.handle;

  async function doResolve(noteId, projectId, authorHandle) {
    const r = await apiAction(cfg, 'resolveNote', { projectId, noteId });
    const resolved = !!(r && r.result && r.result.resolved);
    if (opts.json) return outputJson({ ok: true, noteId, projectId, resolved });
    if (resolved) {
      ok(authorHandle && authorHandle !== myHandle
        ? '标了处理了 · @' + authorHandle + ' 会收到回响'
        : '标了处理了');
    } else {
      ok('撤销了处理');
    }
  }

  try {
    // 直接按 id (含已处理的 · 支持 toggle 撤销)
    if (arg && /^n-/.test(arg)) {
      const all = gatherMyNotes(state, myHandle, { includeResolved: true });
      const target = all.find(n => n.noteId === arg);
      if (!target) {
        if (opts.json) return errJson('找不到这条便签 (或不是你项目下的): ' + arg, 'NOT_FOUND');
        err('找不到这条便签 · 或它不在你的项目下: ' + arg); process.exit(1);
      }
      return await doResolve(target.noteId, target.projectId, target.author);
    }

    const pending = gatherMyNotes(state, myHandle);

    // 按编号
    if (arg && /^\d+$/.test(arg)) {
      const target = pending[parseInt(arg, 10) - 1];
      if (!target) {
        if (opts.json) return errJson('没有第 ' + arg + ' 条待处理便签', 'OUT_OF_RANGE');
        err('没有第 ' + arg + ' 条待处理便签 · 先跑 ' + vermilion('tinker note-done') + ' 看编号'); process.exit(1);
      }
      return await doResolve(target.noteId, target.projectId, target.author);
    }

    // 无参 · 列待处理
    if (opts.json) return outputJson({ ok: true, count: pending.length, notes: pending });
    if (pending.length === 0) { ok('便签墙上没有待处理的便签'); return; }
    log('');
    log(sepia('  你项目下待处理的便签:'));
    pending.forEach((n, i) => {
      const snippet = n.text.replace(/\s+/g, ' ').slice(0, 50);
      log('  ' + vermilion(String(i + 1).padStart(2)) + sepia(' · ') + bold('@' + n.author) + sepia(' / ' + n.projectName));
      log('      ' + snippet + (n.text.length > 50 ? sepia('…') : ''));
    });
    log('');
    log(sepia('  标处理了: ') + vermilion('tinker note-done <编号>'));
    log('');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'NOTE_DONE_FAILED');
    err(e.message); process.exit(1);
  }
}

// =============================================
// tinker stash · 个人现场暂存 (跨设备 / 跨时间)
// 一个人 A 机器写一半 · push 现场到 server · B 机器 pop 还原接着写
// 比 git stash 多了"卡在哪 + 当时 AI 的思路" · 不靠工作室 · 按账号隔离
// 加密可选:默认明文 (零设置 · server 可读) · 设了口令就端到端 (server 看不到)
// =============================================
async function cmdStash(sub, args, opts) {
  const cfg = mustHaveConfig();
  const dossierLib = require('../lib/dossier');
  const bridgeLib = require('../lib/bridge');
  const positional = opts.positional || [];
  const stashCfg = cfg.stash || {};

  // tinker stash key <口令> · 设本地加密钥 (别的设备设同一个才能解)
  if (sub === 'key') {
    const pass = (args[2] || positional[1] || '').trim();
    if (!pass) {
      err('用法: ' + vermilion('tinker stash key <口令>') + sepia(' · 设了之后 push 默认加密 · 别的设备设同口令才能 pop'));
      process.exit(1);
    }
    cfg.stash = { ...stashCfg, key: pass, encrypt: true };
    saveConfig(cfg);
    ok('设好 stash 加密口令 · 之后 push 默认加密');
    log(sepia('  别的设备也跑一遍同样的 ') + vermilion('tinker stash key ' + pass) + sepia(' 才能 pop'));
    return;
  }

  // tinker stash push [-m 标签] [--encrypt|--plain]
  if (sub === 'push') {
    if (!inGitRepo()) { err('不在 git 仓库 · stash 存的是当前仓库的现场'); process.exit(1); }
    const label = (opts.text || '').trim();
    const situationId = opts.situation || dossierLib.pickActiveSituationId();
    const dossier = dossierLib.packDossier({ situationId, message: label, cwd: process.cwd() });
    if (!dossier.diff && !dossier.situation) {
      log(sepia('  当前没未提交改动、也没在跟踪的卡点 · 没啥可暂存'));
      return;
    }
    const json = JSON.stringify(dossier);
    let encrypt = opts.encrypt || (stashCfg.encrypt && !opts.plain);
    if (opts.plain) encrypt = false;
    let payload, encrypted = false;
    if (encrypt) {
      if (!stashCfg.key) {
        err('要加密但没设口令 · 先 ' + vermilion('tinker stash key <口令>') + sepia(' · 或加 --plain 明文存'));
        process.exit(1);
      }
      payload = bridgeLib.encryptCompressed(json, stashCfg.key);
      encrypted = true;
    } else {
      payload = json;
    }
    try {
      const r = await apiAction(cfg, 'stashPush', { label, payload, encrypted, bytes: payload.length });
      const id = (r && r.result && r.result.id) || '';
      if (opts.json) return outputJson({ ok: true, id, encrypted });
      ok('暂存了 · ' + bold(id) + (encrypted ? sepia(' · 🔒 加密') : sepia(' · 明文')) + (label ? sepia(' · ' + label) : ''));
      log(sepia('  另一台机器: ') + vermilion('tinker stash pop') + (encrypted ? sepia(' (先设同一个口令)') : ''));
    } catch (e) {
      if (opts.json) return errJson(e.message, 'STASH_PUSH_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }

  // tinker stash drop <id>
  if (sub === 'drop' || sub === 'rm') {
    const id = args[2] || positional[1];
    if (!id) { err('用法: tinker stash drop <id>'); process.exit(1); }
    try {
      await apiAction(cfg, 'stashDrop', { id });
      if (opts.json) return outputJson({ ok: true, dropped: id });
      ok('删了 ' + id);
    } catch (e) {
      if (opts.json) return errJson(e.message, 'STASH_DROP_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }

  // tinker stash pop [id] / apply [id]
  if (sub === 'pop' || sub === 'apply') {
    if (!inGitRepo()) { err('不在 git 仓库 · pop 要在目标仓库里跑'); process.exit(1); }
    const id = args[2] || positional[1] || null;
    let stash;
    try {
      const r = await apiAction(cfg, 'stashGet', { id });
      stash = r && r.result && r.result.stash;
    } catch (e) {
      if (opts.json) return errJson(e.message, 'STASH_GET_FAILED');
      err(e.message); process.exit(1);
    }
    if (!stash) { err('找不到 stash'); process.exit(1); }

    let json;
    if (stash.encrypted) {
      if (!stashCfg.key) { err('这个 stash 加密了 · 先在本机设同一个口令 ' + vermilion('tinker stash key <口令>')); process.exit(1); }
      try { json = bridgeLib.decrypt(stash.payload, stashCfg.key); }
      catch { err('解不开 · 口令对不上?'); process.exit(1); }
    } else {
      json = stash.payload;
    }
    let dossier;
    try { dossier = JSON.parse(json); } catch { err('包坏了 · 解析不了'); process.exit(1); }

    log('');
    if (dossier.message) log(sepia('  当时: ') + bold(dossier.message));
    const cwd = process.cwd();

    // 先深验 (临时工作树重放 · 不碰你当前工作树)
    const v = dossierLib.verifyDossier({ dossier, repoPath: cwd });
    v.checks.forEach(c => log('  ' + (c.ok ? sepia('✓') : vermilion('✗')) + ' ' + c.name + (c.note ? sepia(' · ' + c.note) : '')));
    if (!v.verdict) {
      if (opts.json) return errJson(v.reason, 'STASH_VERIFY_FAILED');
      err('校验没过: ' + v.reason); process.exit(1);
    }

    // 真应用到当前工作树
    const ap = dossierLib.applyStashToWorktree({ dossier, repoPath: cwd });
    if (!ap.ok) {
      if (opts.json) return errJson(ap.error, 'STASH_APPLY_FAILED');
      err('应用失败: ' + ap.error);
      if (ap.patchFile) log(sepia('  patch 留在 ') + ap.patchFile + sepia(' · 可手动 git apply'));
      process.exit(1);
    }
    if (ap.unpushedCount > 0) {
      log(sepia('  注:包里还有 ' + ap.unpushedCount + ' 个文件的未推改动 · 那部分走正常 git push/pull · 这里只还原了未提交的'));
    }
    // pop 用完即删 · apply 留着
    if (sub === 'pop') { try { await apiAction(cfg, 'stashDrop', { id: stash.id }); } catch {} }
    if (opts.json) return outputJson({ ok: true, id: stash.id, applied: ap.applied, dropped: sub === 'pop' });
    ok(ap.applied ? ('还原了未提交的改动' + (sub === 'pop' ? ' · 已删这条 stash' : ' · stash 留着')) : (ap.note || '没改动可还原'));
    return;
  }

  // 默认 / list
  try {
    const r = await apiAction(cfg, 'stashList', {});
    const stashes = (r && r.result && r.result.stashes) || [];
    if (opts.json) return outputJson({ ok: true, stashes });
    if (stashes.length === 0) {
      log(sepia('  没有暂存的现场 · ') + vermilion('tinker stash push -m "卡在哪"') + sepia(' 存一个'));
      return;
    }
    log('');
    log(sepia('  你的现场暂存:'));
    stashes.forEach(s => {
      log('  ' + vermilion(s.id) + (s.encrypted ? ' 🔒' : '') + sepia(' · ' + (s.label || '(无标签)') + ' · ' + agoZh(s.createdAt)));
    });
    log('');
    log(sepia('  取回: ') + vermilion('tinker stash pop [id]') + sepia(' · 删: ') + vermilion('tinker stash drop <id>'));
    log('');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'STASH_LIST_FAILED');
    err(e.message); process.exit(1);
  }
}

// =============================================
// 桌面通知 · 给 Claude Code hook (要权限 / 长任务跑完) 弹本地横幅用
// =============================================
// Mac 桌面通知 · 优先 terminal-notifier (可靠 · 能点 · 独立 app 身份)
// 没装就退回 osascript (零依赖 · 但归在"脚本编辑器"名下 · 权限没开会静默丢)
let _tnPath; // undefined=没查过 · null=没装 · string=路径
function macNotifierPath() {
  if (_tnPath !== undefined) return _tnPath;
  try {
    _tnPath = require('child_process')
      .execSync('command -v terminal-notifier', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || null;
  } catch { _tnPath = null; }
  return _tnPath;
}
// 跨平台桌面通知 · Mac / Windows / Linux 都尽量用系统自带 · 不强制装东西
function fireDesktop({ title, body }) {
  const cp = require('child_process');
  const t = title || 'Tinker';
  const b = body || '';
  try {
    if (process.platform === 'darwin') {
      const tn = macNotifierPath();
      if (tn) {
        cp.execFileSync(tn, ['-title', t, '-message', b, '-group', 'tinker', '-sound', 'Glass']);
        return { ok: true, via: 'terminal-notifier' };
      }
      const esc = (s) => String(s || '').replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ');
      cp.execFileSync('osascript', ['-e', `display notification "${esc(b)}" with title "${esc(t)}" sound name "Glass"`]);
      return { ok: true, via: 'osascript' };
    }
    if (process.platform === 'win32') {
      // Windows 自带 .NET · NotifyIcon 气泡 · 不用装模块 (BurntToast 那种)
      const ps = (s) => "'" + String(s || '').replace(/'/g, "''").replace(/[\r\n]+/g, ' ') + "'";
      const script = 'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$n=New-Object System.Windows.Forms.NotifyIcon; ' +
        '$n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; ' +
        '$n.ShowBalloonTip(6000, ' + ps(t) + ', ' + ps(b) + ', [System.Windows.Forms.ToolTipIcon]::Info); ' +
        'Start-Sleep -Milliseconds 6500; $n.Dispose()';
      cp.execFileSync('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true });
      return { ok: true, via: 'powershell' };
    }
    // linux · notify-send (libnotify · 桌面发行版基本自带)
    cp.execFileSync('notify-send', [t, b]);
    return { ok: true, via: 'notify-send' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// hidden · Claude Code hook 调 · 在"要权限 / 长任务跑完"时弹本地桌面通知
// 不碰 notify 目标配置 · 直接弹 OS 横幅 (跨平台) · 桌面才是 vibe coding 主场
// 关键:这条命令 stdout 必须干净 (Claude 会把 hook stdout 当决策 JSON 解析)
const CLAUDE_TURN_DIR = path.join(CONFIG_DIR, 'claude-turns');
const STOP_NOTIFY_THRESHOLD_MS = 60 * 1000; // 长任务门槛 · 短回复不弹

function readHookStdin() {
  if (process.stdin.isTTY) return {};
  try { return JSON.parse(fs.readFileSync(0, 'utf-8')); } catch { return {}; }
}

// 真能跑交互 prompt 的前提:stdin 跟 stdout 都是 TTY
// 非 TTY (AI 用 Bash 跑 / CI / hook / 管道) 时 inquirer 会抛隐晦 EOF 错
// 交互点用这个先拦一下 · 给明确指引而不是让 inquirer crash
function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// 交互 prompt 的统一入口 · 替代直接 require('@inquirer/prompts')
// 非交互环境 (AI / CI / 管道) 先抛一个带清楚指引的错 · 不让 inquirer 崩出 EOF
// 这个错会冒泡到 main() 的 catch · 被 err() 干净打印
// (已经被 isInteractive()/isTTY 守住的调用点换成它也无害 · 那里永远 interactive)
function promptKit() {
  if (!isInteractive()) {
    const e = new Error('这步需要终端交互 · 当前是非交互环境 (AI / CI / 管道) · 改用 --json 配合对应参数 (看 tinker <命令> --help) · 或到终端里手动跑');
    e.code = 'NON_INTERACTIVE';
    throw e;
  }
  return require('@inquirer/prompts');
}

function cmdNotifyClaude(event) {
  const input = readHookStdin();
  const sid = String(input.session_id || 'default').replace(/[^\w.-]/g, '_');
  const turnFile = path.join(CLAUDE_TURN_DIR, sid);

  if (event === 'prompt') {
    // 记这轮开始时间 · 给 stop 算耗时用
    try { fs.mkdirSync(CLAUDE_TURN_DIR, { recursive: true }); fs.writeFileSync(turnFile, String(Date.now())); } catch {}
    return;
  }
  if (event === 'notification') {
    const msg = (input.message || '').trim();
    const ntype = input.notification_type || '';
    const body = msg || (ntype === 'permission_prompt' ? '要你确认权限' : '在等你');
    fireDesktop({ title: 'Claude Code', body });
    return;
  }
  if (event === 'stop') {
    let started = 0;
    try { started = parseInt(fs.readFileSync(turnFile, 'utf-8'), 10) || 0; } catch {}
    try { fs.unlinkSync(turnFile); } catch {}
    const elapsed = started ? Date.now() - started : 0;
    if (elapsed >= STOP_NOTIFY_THRESHOLD_MS) {
      const secs = Math.round(elapsed / 1000);
      const dur = secs >= 60 ? Math.round(secs / 60) + ' 分钟' : secs + ' 秒';
      fireDesktop({ title: 'Claude Code', body: '跑完了 · 用了 ' + dur + ' · 回来看看' });
    }
    return;
  }
}

// =============================================
// notify daemon · 隐形自管理的桥消息通知器
// 队友消息到 server · 这个后台进程长轮询听 · 一到就弹桌面 (中途也能收到 · 不用开 session)
// 职责砍到最小:只弹桌面 · 用自己的游标 · 绝不碰收件箱 / 不落地 / 不消费 (那条走 SessionStart hook)
// 用户永远不手动开它:SessionStart hook 顺手 ensure 它活着 · 单实例 · 空闲自退
// =============================================
const NOTIFYD_PID_FILE = path.join(CONFIG_DIR, 'notifyd.pid');
const NOTIFYD_CURSOR_FILE = path.join(CONFIG_DIR, 'notifyd.cursor');
const NOTIFYD_IDLE_EXIT_MS = 6 * 60 * 60 * 1000; // 空闲 6 小时自退 · 下次 session 再起

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// SessionStart hook 调 · 没在跑就 detached 起一个 · 在跑就什么都不做
function ensureNotifyDaemon(cfg) {
  if (!cfg || !cfg.token || !cfg.serverUrl) return;
  try {
    const raw = fs.existsSync(NOTIFYD_PID_FILE) ? JSON.parse(fs.readFileSync(NOTIFYD_PID_FILE, 'utf-8')) : null;
    if (raw && pidAlive(raw.pid)) return; // 已经有一个活着
  } catch {}
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.argv[0], [process.argv[1], 'notify-daemon', 'run'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

// 把一条桥消息压成一行桌面提示 · 能解就解 (拿标题) · 解不开就只报来源
function summarizeForDesktop(msg, bridgeLib) {
  const from = '@' + (msg.fromHandle || '?');
  let detail = '';
  try {
    const dec = bridgeLib.tryDecryptWithAnyStudio(msg.payload);
    if (dec) {
      const obj = JSON.parse(dec.plaintext);
      if (msg.kind === 'noti') detail = (obj.title || obj.body || '').slice(0, 60);
      else if (msg.kind === 'file') detail = '发来 ' + ((obj.files || []).length) + ' 个文件' + (obj.message ? ' · ' + (obj.message || '').slice(0, 40) : '');
      else if (msg.kind === 'task') detail = '发来接力包';
    }
  } catch {}
  if (!detail) detail = msg.kind === 'file' ? '发来文件' : msg.kind === 'task' ? '发来接力包' : '发来一条消息';
  return { title: 'Tinker · ' + from, body: detail };
}

async function cmdNotifyDaemon(sub) {
  // stop · 杀掉在跑的 (调试 / 用户想关)
  if (sub === 'stop') {
    try {
      const raw = JSON.parse(fs.readFileSync(NOTIFYD_PID_FILE, 'utf-8'));
      if (pidAlive(raw.pid)) { process.kill(raw.pid); ok('停了 notify daemon (pid ' + raw.pid + ')'); }
      else log(sepia('  没在跑'));
      try { fs.unlinkSync(NOTIFYD_PID_FILE); } catch {}
    } catch { log(sepia('  没在跑')); }
    return;
  }
  if (sub === 'status') {
    try {
      const raw = JSON.parse(fs.readFileSync(NOTIFYD_PID_FILE, 'utf-8'));
      log(pidAlive(raw.pid) ? sepia('  在跑 · pid ') + bold(raw.pid) + sepia(' · 起于 ' + new Date(raw.startedAt).toLocaleString()) : sepia('  没在跑 (有残留 pid 文件)'));
    } catch { log(sepia('  没在跑')); }
    return;
  }

  // run · 真正的守护循环 (detached 子进程跑这条 · stdout 已 ignore)
  const cfg = loadConfig();
  if (!cfg || !cfg.token || !cfg.serverUrl || !cfg.handle) return;

  // 单实例锁:已有活着的就退
  try {
    const raw = fs.existsSync(NOTIFYD_PID_FILE) ? JSON.parse(fs.readFileSync(NOTIFYD_PID_FILE, 'utf-8')) : null;
    if (raw && raw.pid !== process.pid && pidAlive(raw.pid)) return;
  } catch {}
  try { fs.writeFileSync(NOTIFYD_PID_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() })); } catch {}
  const cleanup = () => { try { const r = JSON.parse(fs.readFileSync(NOTIFYD_PID_FILE, 'utf-8')); if (r.pid === process.pid) fs.unlinkSync(NOTIFYD_PID_FILE); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  const bridgeLib = require('../lib/bridge');

  // 飞书通知是否已由 server 接管 · 是则客户端不再重复推(server 侧对全队零配置 · 是产品级正解)
  // 查一次即可 · 查不到当作没接管 · 客户端兜底推
  let serverFeishuActive = false;
  try {
    const r = await fetch(cfg.serverUrl + '/api/feishu/status', { headers: { Authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    if (r.ok) { const d = await r.json(); serverFeishuActive = !!d.active; }
  } catch {}

  // 初始化游标:第一次起设到当前最大 seq · 不为历史积压狂弹 · 只通知从现在起的新消息
  let cursor = 0;
  try { cursor = parseInt(fs.readFileSync(NOTIFYD_CURSOR_FILE, 'utf-8').trim(), 10) || 0; } catch {}
  if (!cursor) {
    try {
      const r = await fetch(cfg.serverUrl + '/api/bridge/poll?since=0', { headers: { Authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
      if (r.ok) { const d = await r.json(); cursor = (d.messages || []).reduce((m, x) => Math.max(m, x.seq), 0); }
    } catch {}
    try { fs.writeFileSync(NOTIFYD_CURSOR_FILE, String(cursor)); } catch {}
  }

  let lastActivity = Date.now();
  let backoff = 1000;
  while (true) {
    if (Date.now() - lastActivity > NOTIFYD_IDLE_EXIT_MS) return; // 空闲太久自退
    try {
      const r = await fetch(cfg.serverUrl + '/api/bridge/poll?since=' + cursor, {
        headers: { Authorization: 'Bearer ' + cfg.token },
        signal: AbortSignal.timeout ? AbortSignal.timeout(35000) : undefined,
      });
      if (!r.ok) { await sleepMs(backoff); backoff = Math.min(backoff * 2, 30000); continue; }
      backoff = 1000;
      const data = await r.json();
      for (const msg of (data.messages || [])) {
        cursor = Math.max(cursor, msg.seq);
        if (msg.fromHandle === cfg.handle) continue; // 不为自己发的弹
        const sum = summarizeForDesktop(msg, bridgeLib);
        fireDesktop(sum);
        if (!serverFeishuActive) feishuNotifyBridgeAsync(sum).catch(() => {});   // server 没接管才客户端兜底推 · 不双份
        lastActivity = Date.now();
      }
      try { fs.writeFileSync(NOTIFYD_CURSOR_FILE, String(cursor)); } catch {}
    } catch (e) {
      if (e && (e.name === 'AbortError' || (e.message || '').includes('timeout'))) continue; // 长轮询超时 · 正常 · 立刻再来
      await sleepMs(backoff); backoff = Math.min(backoff * 2, 30000);
    }
  }
}
function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

// v0.15 编辑/删除/建项目 · 补齐 CLI 跟 server 之间最后几个动作 gap
// 之前 editUpdate / deleteUpdate / editMethod / addProject / editProject 只有 webapp 用
// 现在 CLI 直接能做 · 写错可以改 · 测试条可以删 · 新项目命令行起手

// helper: 在自己 owned 项目里找 updateId 对应的 projectId + updateIdx
async function findMyUpdate(cfg, updateId) {
  if (!updateId || !updateId.startsWith('u-')) return null;
  const state = await apiState(cfg);
  for (const p of state.projects) {
    if (p.owner !== cfg.handle) continue;
    const idx = (p.updates || []).findIndex(u => u.id === updateId);
    if (idx >= 0) return { project: p, idx, update: p.updates[idx] };
  }
  return null;
}

// tinker edit <updateId> -m "新内容" [--scenario "..."]
async function cmdEditUpdate(updateId, opts) {
  const cfg = mustHaveConfig();
  if (!updateId || !updateId.startsWith('u-')) {
    if (opts.json) return errJson('用法: tinker edit <updateId> -m "新内容"', 'NO_ID');
    err('用法: ' + vermilion('tinker edit <updateId> -m "新内容"') + sepia(' [--scenario "..."]'));
    process.exit(1);
  }
  if (!opts.text) {
    if (opts.json) return errJson('-m "新内容" 必填', 'NO_TEXT');
    err('-m "新内容" 必填'); process.exit(1);
  }
  const found = await findMyUpdate(cfg, updateId);
  if (!found) {
    if (opts.json) return errJson('找不到你的 update: ' + updateId, 'NOT_FOUND');
    err('找不到你的 update: ' + updateId); process.exit(1);
  }
  // v1.0 edit 也走 voice 守门 (跟 push 一致 · 编辑同样能引入 AI 直出腔 · 之前漏了)
  const gate = await gateVoiceCheck((opts.text || '').trim(), opts);
  if (!gate.ok) {
    if (opts.json) return errJson(gate.reason || 'voice 守门拒绝', gate.code || 'VOICE_GATE_BLOCK');
    process.exit(1);
  }
  const payload = { projectId: found.project.id, updateIdx: found.idx, text: opts.text };
  if (opts.scenario !== undefined) payload.scenario = opts.scenario;
  try {
    await apiAction(cfg, 'editUpdate', payload);
    if (opts.json) return outputJson({ ok: true, updateId, projectId: found.project.id });
    ok('改好了');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'EDIT_FAILED');
    err(e.message); process.exit(1);
  }
}

// tinker delete <updateId> [<updateId> ...] [--yes]
// 不可逆 · TTY 默认 confirm · 非 TTY 必须显式 --yes · 支持一次删多条
// 注意: deleteUpdate 用 updateIdx (位置) · 删一条后面的 idx 全变 · 所以每条都现拉 findMyUpdate 拿新 idx
async function cmdDeleteUpdate(updateIds, opts) {
  const cfg = mustHaveConfig();
  const ids = (Array.isArray(updateIds) ? updateIds : [updateIds]).filter(x => x && x.startsWith('u-'));
  if (ids.length === 0) {
    if (opts.json) return errJson('用法: tinker delete <updateId> [<updateId> ...]', 'NO_ID');
    err('用法: ' + vermilion('tinker delete <updateId> [<updateId> ...]') + sepia(' [--yes 跳过确认]'));
    process.exit(1);
  }
  // 确认一次 · 覆盖全部 · 非 TTY 必须 --yes
  if (!opts.yes && !opts.json) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      try {
        const { confirm } = promptKit();
        const go = await confirm({ message: '确定删这 ' + ids.length + ' 条 (不可逆)?', default: false });
        if (!go) { log(sepia('  没删')); return; }
      } catch { log(sepia('  没删')); return; }
    } else {
      err('删除不可逆 · 非 TTY 调用必须加 --yes 显式确认');
      process.exit(1);
    }
  }
  const deleted = [], failed = [];
  for (const id of ids) {
    try {
      const found = await findMyUpdate(cfg, id);  // 每条现拉 · idx 随删随变 · 不能复用陈旧 idx
      if (!found) { failed.push({ id, error: '找不到你的 update' }); if (!opts.json) err('找不到: ' + id); continue; }
      await apiAction(cfg, 'deleteUpdate', { projectId: found.project.id, updateIdx: found.idx });
      deleted.push(id);
      if (!opts.json) ok('删了 ' + sepia(id));
    } catch (e) {
      failed.push({ id, error: e.message });
      if (!opts.json) err('删失败 ' + id + ': ' + e.message);
    }
  }
  if (opts.json) return outputJson({ ok: failed.length === 0, deleted, failed });
}

// tinker edit-method <methodId> [-m] [--scenario] [--title] [--tag x --tag y]
async function cmdEditMethod(methodId, opts) {
  const cfg = mustHaveConfig();
  if (!methodId || !methodId.startsWith('m-')) {
    if (opts.json) return errJson('用法: tinker edit-method <methodId> -m "..."', 'NO_ID');
    err('用法: ' + vermilion('tinker edit-method <methodId> -m "..."') + sepia(' [--scenario "..."] [--title "..."] [--tag x --tag y]'));
    process.exit(1);
  }
  const payload = { methodId };
  if (opts.text) payload.text = opts.text;
  if (opts.scenario !== undefined) payload.scenario = opts.scenario;
  if (opts.title !== undefined) payload.title = opts.title;
  if (opts.tags) payload.tags = opts.tags;
  const fieldCount = Object.keys(payload).length - 1;
  if (fieldCount === 0) {
    if (opts.json) return errJson('至少给一个字段: -m / --scenario / --title / --tag', 'NO_FIELD');
    err('至少给一个字段: -m / --scenario / --title / --tag');
    process.exit(1);
  }
  // v1.0 改了方法正文才走 voice 守门 (方法正文是公开可借的 · 只改 scenario/title/tag 不查)
  if (opts.text) {
    const gate = await gateVoiceCheck(opts.text.trim(), opts);
    if (!gate.ok) { if (opts.json) return errJson(gate.reason || 'voice 守门拒绝', gate.code || 'VOICE_GATE_BLOCK'); process.exit(1); }
  }
  try {
    await apiAction(cfg, 'editMethod', payload);
    if (opts.json) return outputJson({ ok: true, methodId, fieldsChanged: fieldCount });
    ok('方法改好了 (' + fieldCount + ' 个字段)');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'EDIT_METHOD_FAILED');
    err(e.message); process.exit(1);
  }
}

// tinker project new --name "..." --desc "..." [--link "..."] [--tool x --tool y]
// tinker project edit <projectId> [--name --desc --link --tool x --tool y]
async function cmdProject(sub, projectIdArg, opts) {
  const cfg = mustHaveConfig();
  if (sub === 'new') {
    if (!opts.name || !opts.desc) {
      if (opts.json) return errJson('用法: tinker project new --name "..." --desc "..." [--link <url>] [--tool x --tool y] [--studio <slug>]', 'MISSING_ARGS');
      err('用法: ' + vermilion('tinker project new --name "..." --desc "..."') + sepia(' [--link <url>] [--tool x --tool y] [--studio <slug>]'));
      process.exit(1);
    }
    // v0.41 归属 · 显式给 --studio 就挂 · --solo 强制 solo · 都没给默认 solo (但成功后提示)
    let studioId = null;
    const state = await apiState(cfg);
    const myStudios = ((state.users || {})[cfg.handle] && state.users[cfg.handle].studios) || [];
    if (opts.studio) {
      const targetSlug = String(opts.studio).replace(/^@/, '').trim();
      const mine = myStudios.find(s => s.slug === targetSlug);
      if (!mine) {
        if (opts.json) return errJson('你不是工作室 ' + targetSlug + ' 的成员', 'NOT_MEMBER');
        err('你不是工作室 ' + bold(targetSlug) + ' 的成员');
        process.exit(1);
      }
      const found = (state.studios || []).find(s => s.slug === targetSlug);
      if (!found) { err('找不到工作室 id: ' + targetSlug); process.exit(1); }
      studioId = found.id;
    }
    try {
      const r = await apiAction(cfg, 'addProject', {
        name: opts.name,
        desc: opts.desc,
        productLink: opts.link || '',
        tools: opts.tools || [],
        studioId,
      });
      const newProj = r && r.result;
      if (opts.json) return outputJson({ ok: true, project: newProj });
      ok('项目建好了');
      if (newProj && newProj.id) log(sepia('  projectId: ') + newProj.id);
      if (newProj && newProj.slug) log(sepia('  去看: ') + cfg.serverUrl + '/#/p/' + cfg.handle + '/' + newProj.slug);
      if (studioId) {
        log(sepia('  归属: ') + bold(opts.studio) + sepia(' 工作室'));
      } else if (myStudios.length > 0 && !opts.solo) {
        // 没传 --studio 也没 --solo · 默认 solo · 但提示一下用户有工作室可以挂
        log('');
        log(sepia('  这是个人作品 · 想挂到工作室跑 ') + vermilion('tinker project attribute ' + (newProj && newProj.id) + ' --studio <slug>'));
        log(sepia('  你的工作室:'));
        myStudios.forEach(s => log(sepia('    · ' + s.slug + ' (' + s.name + ')')));
      }
    } catch (e) {
      if (opts.json) return errJson(e.message, 'CREATE_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }
  if (sub === 'edit') {
    const projectId = resolveProjectId(projectIdArg);
    if (!projectId) {
      if (opts.json) return errJson('用法: tinker project edit <projectId> [--name --desc --link --tool]', 'NO_PROJECT');
      err('用法: ' + vermilion('tinker project edit <projectId>') + sepia(' [--name --desc --link --tool]'));
      process.exit(1);
    }
    const noField = !opts.name && !opts.desc && opts.link === undefined && !opts.tools;
    if (noField) {
      if (opts.json) return errJson('至少给一个字段', 'NO_FIELD');
      err('至少给一个字段: --name / --desc / --link / --tool');
      process.exit(1);
    }
    // editProject 要 name/desc 必填 · 没改的字段用当前值兜底
    const state = await apiState(cfg);
    const proj = state.projects.find(p => p.id === projectId);
    if (!proj) {
      if (opts.json) return errJson('找不到项目: ' + projectId, 'NOT_FOUND');
      err('找不到项目: ' + projectId); process.exit(1);
    }
    if (proj.owner !== cfg.handle) {
      if (opts.json) return errJson('只能改自己的项目', 'NOT_OWNER');
      err('只能改自己的项目'); process.exit(1);
    }
    try {
      await apiAction(cfg, 'editProject', {
        projectId,
        name: opts.name || proj.name,
        desc: opts.desc || proj.desc,
        productLink: opts.link !== undefined ? opts.link : (proj.productLink || ''),
        tools: opts.tools || proj.tools || [],
      });
      if (opts.json) return outputJson({ ok: true, projectId });
      ok('项目改好了');
    } catch (e) {
      if (opts.json) return errJson(e.message, 'EDIT_PROJECT_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }
  if (sub === 'attribute') {
    // tinker project attribute <projectId> --studio <slug>  挂到工作室
    // tinker project attribute <projectId> --solo            拿回个人作品
    const projectId = resolveProjectId(projectIdArg);
    if (!projectId) {
      if (opts.json) return errJson('用法: tinker project attribute <projectId> --studio <slug> 或 --solo', 'NO_PROJECT');
      err('用法: ' + vermilion('tinker project attribute <projectId>') + sepia(' --studio <slug> 或 --solo'));
      process.exit(1);
    }
    if (!opts.solo && !opts.studio) {
      if (opts.json) return errJson('给一个: --studio <slug> 或 --solo', 'NO_FIELD');
      err('给一个: ' + vermilion('--studio <slug>') + sepia(' 或 ') + vermilion('--solo'));
      process.exit(1);
    }
    let studioId = null;
    if (opts.studio) {
      const state = await apiState(cfg);
      const mine = ((state.users || {})[cfg.handle] && state.users[cfg.handle].studios) || [];
      const targetSlug = String(opts.studio).replace(/^@/, '').trim();
      const matched = mine.find(s => s.slug === targetSlug);
      if (!matched) {
        if (opts.json) return errJson('你不是工作室 ' + targetSlug + ' 的成员', 'NOT_MEMBER');
        err('你不是工作室 ' + bold(targetSlug) + ' 的成员');
        if (mine.length === 0) log(sepia('  你还没加入任何工作室'));
        else { log(sepia('  你所属的工作室:')); mine.forEach(s => log(sepia('    · ' + s.slug + ' (' + s.name + ')'))); }
        process.exit(1);
      }
      const allStudios = state.studios || [];
      const found = allStudios.find(s => s.slug === targetSlug);
      if (!found) {
        if (opts.json) return errJson('找不到工作室 id: ' + targetSlug, 'NO_STUDIO');
        err('找不到工作室 id: ' + targetSlug); process.exit(1);
      }
      studioId = found.id;
    }
    try {
      await apiAction(cfg, 'changeProjectStudio', { projectId, studioId });
      if (opts.json) return outputJson({ ok: true, projectId, studioId });
      ok(studioId ? '挂上工作室了 · ' + bold(opts.studio) : '改回个人作品了');
    } catch (e) {
      if (opts.json) return errJson(e.message, 'ATTRIBUTE_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }

  if (opts.json) return errJson('用法: tinker project new | edit | attribute <projectId>', 'UNKNOWN_SUB');
  err('用法:');
  log('  ' + vermilion('tinker project new --name "..." --desc "..." [--studio <slug>]'));
  log('  ' + vermilion('tinker project edit <projectId>') + sepia(' [--name --desc --link --tool]'));
  log('  ' + vermilion('tinker project attribute <projectId>') + sepia(' --studio <slug> 或 --solo'));
  process.exit(1);
}

// v0.32 项目编年史 · ship 之后的项目挂在头部的浓缩时间线
// timeline show <projectId>              · 看当前 timeline
// timeline push <projectId> -m "..."     · 直接 push 一段 markdown
// timeline push <projectId> <file.md>    · 从草稿文件 push (推荐 · LLM 起草后用)
// timeline clear <projectId>             · 清空(不再显示编年史)
async function cmdTimeline(sub, args, opts) {
  const cfg = mustHaveConfig();

  if (sub === 'show') {
    const projectId = resolveProjectId(args[2]);
    if (!projectId) {
      if (opts.json) return errJson('用法: tinker timeline show <projectId>', 'NO_PROJECT');
      err('用法: ' + vermilion('tinker timeline show <projectId>'));
      process.exit(1);
    }
    const state = await apiState(cfg);
    const proj = state.projects.find(p => p.id === projectId);
    if (!proj) {
      if (opts.json) return errJson('找不到项目: ' + projectId, 'NOT_FOUND');
      err('找不到项目: ' + projectId); process.exit(1);
    }
    if (opts.json) return outputJson({ ok: true, projectId, timeline: proj.timeline || null });
    if (!proj.timeline) {
      log(sepia('  这个项目还没编年史 · 跑 ') + vermilion('tinker timeline push ' + projectId + ' -m "..."') + sepia(' 写一份'));
      return;
    }
    log('');
    log(bold(proj.name) + sepia(' · 编年史'));
    log(sepia(''.padStart(40, '─')));
    log(proj.timeline);
    log('');
    return;
  }

  if (sub === 'push') {
    const projectId = resolveProjectId(args[2]);
    if (!projectId) {
      if (opts.json) return errJson('用法: tinker timeline push <projectId> [-m "..." | <file.md>]', 'NO_PROJECT');
      err('用法: ' + vermilion('tinker timeline push <projectId>') + sepia(' [-m "..." | <file.md>]'));
      process.exit(1);
    }
    // 来源:opts.text (-m) 优先 · 否则看第 4 个 arg 是不是文件路径
    let timeline = (opts.text || '').trim();
    const maybeFile = args[3];
    if (!timeline && maybeFile) {
      if (!fs.existsSync(maybeFile)) {
        if (opts.json) return errJson('文件不存在: ' + maybeFile, 'NO_FILE');
        err('文件不存在: ' + maybeFile); process.exit(1);
      }
      timeline = fs.readFileSync(maybeFile, 'utf-8').trim();
    }
    if (!timeline) {
      if (opts.json) return errJson('内容为空 · 给 -m "..." 或 <file.md>', 'EMPTY');
      err('内容为空 · 给 ' + vermilion('-m "..."') + sepia(' 或 ') + vermilion('<file.md>'));
      process.exit(1);
    }
    try {
      const r = await apiAction(cfg, 'editProjectTimeline', { projectId, timeline });
      if (opts.json) return outputJson({ ok: true, ...(r && r.result || {}) });
      ok('编年史更新了');
      log(sepia('  长度: ') + timeline.length + ' 字符');
      const state = await apiState(cfg);
      const proj = state.projects.find(p => p.id === projectId);
      if (proj) log(sepia('  看: ') + cfg.serverUrl + '/#/p/' + proj.owner + '/' + proj.slug);
    } catch (e) {
      if (opts.json) return errJson(e.message, 'PUSH_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }

  if (sub === 'clear') {
    const projectId = resolveProjectId(args[2]);
    if (!projectId) {
      if (opts.json) return errJson('用法: tinker timeline clear <projectId>', 'NO_PROJECT');
      err('用法: ' + vermilion('tinker timeline clear <projectId>'));
      process.exit(1);
    }
    try {
      await apiAction(cfg, 'editProjectTimeline', { projectId, timeline: '' });
      if (opts.json) return outputJson({ ok: true, projectId, timeline: null });
      ok('编年史已清空');
    } catch (e) {
      if (opts.json) return errJson(e.message, 'CLEAR_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }

  if (sub === 'draft') {
    const projectId = resolveProjectId(args[2]);
    if (!projectId) {
      if (opts.json) return errJson('用法: tinker timeline draft <projectId>', 'NO_PROJECT');
      err('用法: ' + vermilion('tinker timeline draft <projectId>'));
      process.exit(1);
    }
    if (!cfg.llm || !cfg.llm.apiKey) {
      if (opts.json) return errJson('LLM 没配,跑 tinker login 配一下', 'NO_LLM');
      err('LLM 没配,跑 ' + vermilion('tinker login') + sepia(' 配一下'));
      process.exit(1);
    }
    const state = await apiState(cfg);
    const proj = state.projects.find(p => p.id === projectId);
    if (!proj) {
      if (opts.json) return errJson('找不到项目: ' + projectId, 'NOT_FOUND');
      err('找不到项目: ' + projectId); process.exit(1);
    }
    try {
      const draftPath = await draftTimelineForProject(cfg, proj);
      if (opts.json) return outputJson({ ok: true, projectId, draftPath });
      ok('编年史草稿起好了');
      log(sepia('  路径: ') + draftPath);
      log(sepia('  改完发: ') + vermilion('tinker timeline push ' + projectId + ' ' + draftPath));
    } catch (e) {
      if (opts.json) return errJson(e.message, 'DRAFT_FAILED');
      err('起草失败: ' + e.message); process.exit(1);
    }
    return;
  }

  if (opts.json) return errJson('用法: tinker timeline show | draft | push | clear <projectId>', 'UNKNOWN_SUB');
  err('用法:');
  log('  ' + vermilion('tinker timeline show <projectId>') + sepia('              看编年史'));
  log('  ' + vermilion('tinker timeline draft <projectId>') + sepia('             LLM 起草到 .tinker/drafts/'));
  log('  ' + vermilion('tinker timeline push <projectId> -m "..."') + sepia('     直接 push 一段'));
  log('  ' + vermilion('tinker timeline push <projectId> <file.md>') + sepia('    从草稿文件 push'));
  log('  ' + vermilion('tinker timeline clear <projectId>') + sepia('             清空'));
  process.exit(1);
}

// v0.32 给 cmdTimelineDraft / cmdShip 用 · 看项目所有 update 挑重要节点 · LLM 起草编年史 markdown · 写到 .tinker/drafts/
// 返回草稿文件路径 · 失败抛 (调用方决定显不显示给用户)
async function draftTimelineForProject(cfg, proj) {
  const updates = proj.updates || [];
  if (updates.length === 0) throw new Error('这个项目还没 update 可以起编年史');

  // 排序 · 时间正序 (从开张到现在)
  const sorted = updates.slice().sort((a, b) => a.at - b.at);

  // 挑节点:第一条(开张) + 所有升格(method/experience/learning/decision) + ship 节点
  // 没升格的项目就只有第一条 + 最后一条,LLM 也能写,但内容会单薄
  const picked = [];
  picked.push(sorted[0]);
  for (const u of sorted) {
    if (u === sorted[0]) continue;
    if (u.isMethod || u.isExperience || u.isLearning || u.isDecision || u.kind === 'ship') {
      picked.push(u);
    }
  }
  // 如果就第一条 · 把最后一条也加上,LLM 至少有两端可参照
  if (picked.length === 1 && sorted.length > 1) picked.push(sorted[sorted.length - 1]);
  // 上限 10 个节点 · 太多 LLM 容易写散
  const nodes = picked.slice(0, 10);

  const nodeLines = nodes.map(u => {
    const date = new Date(u.at).toISOString().slice(0, 10);
    const tag = u.isMethod ? '[方法]' : u.isExperience ? '[踩坑]' : u.isLearning ? '[上手]' : u.isDecision ? '[决策]' : (u.kind === 'ship' ? '[完工]' : '');
    return date + (tag ? ' ' + tag : '') + ' ' + (u.text || '').replace(/\n+/g, ' ').slice(0, 280);
  }).join('\n\n');

  const fingerprint = loadFingerprint();
  const prompt = `你帮一个 Tinker 工坊作者起草项目编年史 · 给陌生人看的浓缩版时间线。

项目: ${proj.name}
描述: ${proj.desc || ''}

作者的 voice fingerprint:
"""
${fingerprint}
"""

关键时刻 (作者标过升格的 update + ship 完工节点 · 按时间正序):
"""
${nodeLines}
"""

输出要求:

1. 时间线 ${Math.min(nodes.length, 8)} 个节点左右 · 每个节点格式 \`YYYY-MM-DD · 一句话事件\` (不超 25 字)
2. 节点之间空一行
3. 时间线下面留一段 2-3 句的总结 (项目在做什么 / 跑通了什么 / 最大收获)
4. 全中文 · 工艺人日志气质 · 不堆中点 · 不用破折号 · 普通话标点
5. 不像 PM 周报 · 不像产品发布会
6. 不要写 "##" 这种标题 · 直接节点然后空一行然后总结段
7. 直接输出 markdown · 不要 \`\`\` 不要 commentary

例子格式 (你要的输出长这样,内容是你写的):

2026-03-12 · 开张 · 决定做 X
2026-04-02 · 跑通核心循环
2026-04-20 · 完工

这个项目用了大概两个月,核心想验证 Y。最大的收获是 Z,后面如果要做类似的事,
会先想清楚 W。`;

  const provider = cfg.llm.provider || 'anthropic';
  const { text, tokens } = await callLLM(cfg, provider, prompt, { maxTokens: 1500 });
  let rawText = text;
  recordLLMUsage(provider, tokens, 'timeline');

  // 容错 · 剥可能的代码块包裹
  rawText = rawText.replace(/^```(?:markdown|md)?\s*/, '').replace(/\s*```\s*$/, '');

  // 写文件
  const draftsDir = path.join(process.cwd(), '.tinker', 'drafts');
  fs.mkdirSync(draftsDir, { recursive: true });
  const draftPath = path.join(draftsDir, 'timeline-' + proj.id + '.md');
  fs.writeFileSync(draftPath, rawText + '\n');
  return draftPath;
}

// tinker seek -m "我需要一个 X 的方法" — 发一条求方法请求
async function cmdSeek(opts) {
  const cfg = mustHaveConfig();
  const state = await apiState(cfg);
  const me = cfg.handle;
  const mine = state.projects.filter(p => p.owner === me && ['active', 'stuck', 'live'].includes(p.status));
  if (mine.length === 0) {
    err('你没有 active/stuck 的项目 · 去 ' + cfg.serverUrl + ' 开一个');
    process.exit(1);
  }

  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (mine.length === 1) {
    projectId = mine[0].id;
    log(sepia('  自动选了唯一一个项目: ') + bold(mine[0].name));
  } else {
    const { select } = promptKit();
    projectId = await select({
      message: '挂在哪个项目下?',
      choices: mine.map(p => ({ name: p.name + sepia('  ' + p.desc.slice(0, 40)), value: p.id })),
    });
  }

  let seekText = opts.text;
  if (!seekText) {
    const { input } = promptKit();
    seekText = await input({ message: '你需要什么方法?' });
  }
  seekText = (seekText || '').trim();
  if (!seekText) { err('内容不能空'); process.exit(1); }

  try {
    const r = await apiAction(cfg, 'addUpdate', { projectId, text: seekText, isSeeking: true });
    if (opts.json) return outputJson({ ok: true, updateId: r.result?.updateId });
    log(moss('  求方法发出去了 · 工作室的人看到会回应'));
    log(sepia('  id: ') + (r.result?.updateId || ''));
  } catch (e) {
    if (opts.json) return errJson(e.message, 'SEEK_FAILED');
    err(e.message); process.exit(1);
  }
}

// tinker contribute <updateId> — 标自己一条 update 为方法
// 不带参数时 · 默认拿最近一条 push 的 id
async function cmdContribute(updateIdArg, opts) {
  const cfg = loadConfig();
  if (!cfg.serverUrl || !cfg.token) {
    if (opts.json) return errJson('未登录', 'NO_AUTH');
    err('未登录 · 先 tinker login'); process.exit(1);
  }
  // --unmark <id> · 删除一个方法 (兼容老 updateId 入参 · 自动判断 prefix 走 deleteMethod 或 unmarkMethod)
  if (opts.unmark) {
    const id = typeof opts.unmark === 'string' ? opts.unmark : updateIdArg;
    if (!id) {
      if (opts.json) return errJson('--unmark 需要 id (m-xxx 或 u-xxx)', 'NO_ID');
      err('--unmark 需要 id · 例: tinker contribute --unmark m-xxx (方法 id) 或 u-xxx (从 update 升格的)'); process.exit(1);
    }
    // v0.81: m-xxx 走 deleteMethod (新 API) · u-xxx 走 unmarkMethod (兼容路径)
    if (id.startsWith('m-')) {
      await apiAction(cfg, 'deleteMethod', { methodId: id });
    } else {
      await apiAction(cfg, 'unmarkMethod', { updateId: id });
    }
    if (opts.json) return outputJson({ ok: true, id, deleted: true });
    log(sepia('  删了: ') + id);
    return;
  }
  // v0.13 --from-file: 从 markdown 文件按段 contribute (走 CLI 路径承载长文档)
  if (opts.fromFile) {
    return cmdContributeFromFile(cfg, opts);
  }
  let updateId = updateIdArg;
  if (!updateId) {
    // 找最近一条自己的 update
    const state = await apiState(cfg);
    let latest = null;
    for (const p of state.projects || []) {
      for (const u of p.updates || []) {
        if (!latest || u.at > latest.at) latest = { ...u, project: p.name };
      }
    }
    if (!latest) {
      if (opts.json) return errJson('还没记过进展 · 没东西可标', 'NO_UPDATES');
      err('还没记过进展 · 没东西可标'); process.exit(1);
    }
    updateId = latest.id;
    log(sepia('  默认拿最近一条: ') + bold(latest.project) + sepia(' · ') + latest.text.slice(0, 60) + sepia('...'));
  }
  const result = await apiAction(cfg, 'markAsMethod', { updateId });
  if (opts.json) return outputJson({ ok: true, updateId, marked: true });
  log('');
  log(moss('  已标为方法 · 别人 tinker borrow 时能搜到这条'));
  log(sepia('  id: ') + updateId);
  log(sepia('  反悔: ') + vermilion(`tinker contribute --unmark ${updateId}`));
  log('');
}

// v0.13 markdown 切段 · 按 H1/H2/H3 标题切 · 跳过代码块里的 #
// 返回 [{ level, heading, body, fullText, lineStart }]
// fullText 包含 heading 自身 · 直接 push 时拿这个
function parseMarkdownSections(content) {
  const lines = content.split('\n');
  const sections = [];
  let inCode = false;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) inCode = !inCode;
    const m = inCode ? null : line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) {
      if (current) sections.push(current);
      current = {
        level: m[1].length,
        heading: m[2].trim(),
        bodyLines: [],
        headingLine: line,
        lineStart: i + 1,
      };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) sections.push(current);
  // 拼 fullText · 去掉 body 头尾空行
  return sections.map(s => {
    let body = s.bodyLines.join('\n').replace(/^\s+|\s+$/g, '');
    const fullText = s.headingLine + (body ? '\n\n' + body : '');
    return {
      level: s.level,
      heading: s.heading,
      body,
      fullText,
      charCount: fullText.length,
      lineStart: s.lineStart,
    };
  }).filter(s => s.charCount > 30); // 太短的段没 contribute 价值
}

// v0.13 让 LLM 看完整 doc 推荐 3 段最值得分享的
// 返回 [{ heading, reason }] 数组 · 失败 throw
async function llmPickSections(cfg, sections) {
  if (!cfg.llm || !cfg.llm.apiKey) throw new Error('未配置 LLM · 先 tinker llm 配置 key');
  const provider = cfg.llm.provider || 'deepseek';
  const summary = sections.map((s, i) => {
    const preview = s.fullText.slice(0, 180).replace(/\n/g, ' ');
    return `${i + 1}. 标题: ${s.heading} · ${s.charCount} 字 · 前 180 字: ${preview}${s.charCount > 180 ? '...' : ''}`;
  }).join('\n');
  const prompt = `你在帮一个 vibe coder (用 AI 编程的开发者) 整理 markdown 文档 · 挑出最值得分享给别人 borrow / 复用的几段。

文档有以下 ${sections.length} 个段落:

${summary}

判断标准:
- 包含具体可操作的方法 / 套路 / 配置 · 不是只有结论
- 对踩同样坑的人有直接价值 (而不是只对作者自己有意义)
- 不是项目特定的细节 (内部路径 / 变量名 / 私人决策)
- 字数太短 (<50 字) 一般不值得

挑 3 段 (真没合适的可以少挑)。

每段给一句 reason · 这句会直接印在方法卡片上给人看 (卡片是给人扫的 · 正文才是给 AI 用的):
- 格式优先用「概念名 · 应用场景」· 这段正文里有自己的命名 (章节标题 / 提出的概念) 就直接用那个名字当概念名
- 诚实陈述 · 一眼让人懂这方法是做什么的 · 说清"记录 / 分析 / 检查的是什么" + "什么时候用得上"
- 不反问 · 不讲收益不卖点 · 不讲故事 · 不堆形容词
- 短 · 概念名 + 场景合起来不超过约 30 字
- 没有现成概念名的 (比如就是一堆 bug 合集) · 给个诚实的清单名 + 涵盖范围 · 别硬安概念
- 例:"奥卡姆案例库 · 加功能前对照的反面清单" / "机制 vs 行为 · 检查逻辑上闭环但用户不会照做的功能"

输出严格 JSON · 不要包 \`\`\`json:
{ "picks": [{ "heading": "完整标题原文 (字符要跟上面列表里完全一样)", "reason": "<给人看的一句话 · 按上面卡片文风要求>" }] }`;

  const { text, tokens } = await callLLM(cfg, provider, prompt, { maxTokens: 1500, jsonMode: true });
  recordLLMUsage(provider, tokens, 'auto-pick');
  let rawText = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch (e) { throw new Error('LLM 返回不是合法 JSON:\n' + rawText.slice(0, 200)); }
  if (!parsed.picks || !Array.isArray(parsed.picks)) throw new Error('LLM 返回缺 picks 数组');
  return parsed.picks;
}

// v0.13 隐私扫描 · 给作者上传前提示 · 不强删 · 让作者决定
// 返回 [{ kind, sample, hint }] 命中列表
function scanPrivacyRisks(text, cfg) {
  const hits = [];
  // IPv4 (排除 0.0.0.0 跟 127. 跟 localhost · 那些不算敏感)
  const ipMatches = text.match(/\b(?!0\.|127\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g);
  if (ipMatches) hits.push({ kind: 'IPv4 地址', sample: ipMatches[0], hint: '可能是你的服务器 IP · 考虑替换成 <服务器 IP>' });
  // API key 类
  const keyMatch = text.match(/\b(sk-[A-Za-z0-9_-]{16,}|tk_[A-Za-z0-9_-]{16,}|pk_[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_.-]{16,})/);
  if (keyMatch) hits.push({ kind: 'API key / token', sample: keyMatch[0].slice(0, 20) + '...', hint: '上传前一定要删 · 或者改成 <你的 API key>' });
  // 长 base64 / hex (40+ 连续无空格字母数字)
  const longTokenMatch = text.match(/\b[A-Za-z0-9+/=]{40,}\b/);
  if (longTokenMatch) hits.push({ kind: '长随机串', sample: longTokenMatch[0].slice(0, 20) + '...', hint: '看起来像密钥 · 上传前确认' });
  // 本地路径
  if (/\/Users\/[a-zA-Z0-9_-]+\//.test(text) || /\/home\/[a-zA-Z0-9_-]+\//.test(text)) {
    hits.push({ kind: '本地用户路径', sample: '/Users/<name>/...', hint: '路径里有你的用户名 · 考虑替换成 ~/...' });
  }
  // LLM apiKey 直接命中 (用户 config 里有就检测)
  if (cfg && cfg.llm && cfg.llm.apiKey && text.includes(cfg.llm.apiKey.slice(0, 12))) {
    hits.push({ kind: '!!! 你的 LLM apiKey', sample: cfg.llm.apiKey.slice(0, 12) + '...', hint: '上传前一定要删 · 不要 contribute 含 key 的内容' });
  }
  return hits;
}

// v0.13 contribute --from-file · 从 markdown 文件按 H1/H2/H3 切段
// 让用户挑要 contribute 的段 · 每段一条 update + 自动 isMethod=true
// 隐私扫描 + 预览 + 确认 · 默认交互 (--json 模式走 --section 直接选)
async function cmdContributeFromFile(cfg, opts) {
  const filePath = opts.fromFile;
  if (!fs.existsSync(filePath)) {
    if (opts.json) return errJson('文件不存在: ' + filePath, 'NO_FILE');
    err('文件不存在: ' + filePath); process.exit(1);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const sections = parseMarkdownSections(content);
  if (sections.length === 0) {
    if (opts.json) return errJson('没切出可发的段 (≥30 字带标题的段)', 'NO_SECTIONS');
    err('没切出可发的段 (要求每段 ≥30 字 · 且要有 #/##/### 标题)'); process.exit(1);
  }

  // 决定 projectId
  // 优先级: --project <slug> > 当前 cwd repoConfig > 交互选 > 报错
  let projectId = null;
  let projectName = null;
  if (opts.projectId) {
    const state = await apiState(cfg);
    // 优先精确 (id/slug/name 全等) · 没有再退到 name 子串匹配 (大小写不敏感)
    const q = opts.projectId;
    const mine = state.projects.filter(x => x.owner === cfg.handle);
    const exact = mine.find(x => x.id === q || x.slug === q || x.name === q);
    const fuzzy = exact || mine.find(x => x.name.toLowerCase().includes(q.toLowerCase()));
    const p = fuzzy;
    if (!p) {
      if (opts.json) return errJson('找不到项目: ' + opts.projectId, 'NO_PROJECT');
      err('找不到你的项目: ' + opts.projectId); process.exit(1);
    }
    projectId = p.id; projectName = p.name;
  } else {
    const repoCfg = loadRepoConfig();
    if (repoCfg) {
      projectId = repoCfg.projectId; projectName = repoCfg.projectName;
      log(sepia('  当前 repo 绑定 ') + bold(projectName) + sepia(' · 这次 contribute 挂在它名下'));
    } else if (!opts.json && isInteractive()) {
      // 交互选项目
      const { select } = promptKit();
      const state = await apiState(cfg);
      const mine = state.projects.filter(x => x.owner === cfg.handle && x.status !== 'done');
      if (mine.length === 0) { err('你还没建项目 · 先发一条 push 创建'); process.exit(1); }
      const picked = await select({
        message: 'contribute 到哪个项目?',
        choices: mine.map(p => ({ name: p.name + sepia(' · ' + p.desc.slice(0, 40)), value: p.id })),
      });
      projectId = picked;
      projectName = mine.find(p => p.id === picked).name;
    } else {
      // --json 或非交互 (AI / CI / 管道):没法弹选择框 · 给明确指引而不是让 inquirer 崩
      const msg = '没法确定挂哪个项目 · 加 --project <slug 或项目名> 指定 · 或在已绑定项目的 repo 里跑';
      if (opts.json) return errJson(msg, 'NO_PROJECT_CTX');
      err(msg); process.exit(1);
    }
  }

  // JSON 模式必须 --section 或 --auto · 否则没法非交互运行
  if (opts.json && !opts.section && !opts.auto) {
    return errJson('--json 模式需要 --section "<标题>" 或 --auto', 'NO_SECTION_IN_JSON');
  }

  // 选段
  let chosen = [];
  if (opts.auto) {
    // --auto: LLM 看完整篇推荐 3 段最值得分享的 · 跳过手动勾
    log(sepia('  LLM 看完 ') + bold(sections.length + ' 段') + sepia(' 推荐中... (DeepSeek)'));
    let picks;
    try { picks = await llmPickSections(cfg, sections); }
    catch (e) {
      if (opts.json) return errJson('LLM 推荐失败: ' + e.message, 'LLM_FAIL');
      err('LLM 推荐失败: ' + e.message); process.exit(1);
    }
    if (!picks.length) {
      const msg = 'LLM 看完没挑出合适的方法段 (可能整篇都偏项目特定 / 偏结论) · 试试 --section 手动选';
      if (opts.json) return errJson(msg, 'NO_PICKS');
      log(sepia('  ' + msg)); return;
    }
    // 匹配回 sections (完全匹配 / 子串两端都试)
    for (const pick of picks) {
      const h = (pick.heading || '').trim();
      const match = sections.find(s =>
        s.heading === h ||
        s.heading.toLowerCase() === h.toLowerCase() ||
        s.heading.includes(h) ||
        (h.length > 4 && h.includes(s.heading))
      );
      if (match) chosen.push({ ...match, llmReason: pick.reason });
    }
    if (chosen.length === 0) {
      const msg = 'LLM 返回的标题匹配不上文档段 · 可能 LLM 改写了标题 · 试试 --section 手动';
      if (opts.json) return errJson(msg, 'NO_MATCH_AFTER_LLM');
      err(msg); process.exit(1);
    }
    log('');
    log(moss('  LLM 推荐 ') + bold(chosen.length + ' 段') + sepia(':'));
    chosen.forEach(c => log(sepia('    · ') + bold(c.heading) + sepia(' · ') + (c.llmReason || '')));
    log('');
  } else if (opts.section) {
    // --section "标题" 支持多次 · 模糊匹配 (大小写不敏感 · 子串)
    const want = (Array.isArray(opts.section) ? opts.section : [opts.section]).map(s => s.toLowerCase());
    chosen = sections.filter(s => want.some(w => s.heading.toLowerCase().includes(w)));
    if (chosen.length === 0) {
      const errMsg = '没匹配上 · 文件里的段: ' + sections.map(s => '"' + s.heading + '"').join(' / ');
      if (opts.json) return errJson(errMsg, 'NO_MATCH');
      err(errMsg); process.exit(1);
    }
  } else if (isInteractive()) {
    // 交互式选 (复选)
    const { checkbox } = promptKit();
    log('');
    log(sepia('  从 ') + bold(filePath) + sepia(' 切了 ') + bold(sections.length + ' 段') + sepia(' · 勾你想 contribute 的'));
    log('');
    chosen = await checkbox({
      message: '选要 contribute 的段 (空格勾选 · 回车确认)',
      pageSize: 12,
      choices: sections.map(s => ({
        name: '  '.repeat(s.level - 1) + s.heading + sepia(' (' + s.charCount + ' 字)'),
        value: s,
      })),
    });
    if (chosen.length === 0) { log(sepia('  没勾任何段 · 取消')); return; }
  } else {
    // 非交互 (AI / CI / 管道):没法弹多选框 · 给明确指引而不是让 inquirer 崩
    const msg = '非交互环境没法弹多选框 · 加 --section "<标题>" 选段 · 或 --auto 让 LLM 挑 · 或 --json';
    if (opts.json) return errJson(msg, 'NO_SECTION_NONINTERACTIVE');
    err(msg); process.exit(1);
  }

  // 隐私扫描 · 每段单独扫
  log('');
  const successes = [];
  const skipped = [];
  for (const sec of chosen) {
    const risks = scanPrivacyRisks(sec.fullText, cfg);
    log(sepia('  ── ') + bold(sec.heading) + sepia(' · ' + sec.charCount + ' 字 ──'));
    if (risks.length > 0) {
      log(vermilion('  ⚠ 隐私扫描命中 ' + risks.length + ' 处:'));
      risks.forEach(r => log(sepia('    · ') + bold(r.kind) + sepia(' (') + r.sample + sepia(') · ') + r.hint));
      if (opts.json) {
        skipped.push({ heading: sec.heading, reason: 'PRIVACY', risks });
        log(sepia('    --json 模式 · 自动跳过含隐私风险段'));
        continue;
      }
      const { confirm } = promptKit();
      const goAnyway = await confirm({ message: '还是要 contribute 这段? (你看过没问题就 y)', default: false });
      if (!goAnyway) { skipped.push({ heading: sec.heading, reason: 'PRIVACY_USER' }); log(sepia('    跳过')); continue; }
    }
    // 预览前 200 字
    const preview = sec.fullText.slice(0, 200).replace(/\n/g, ' ');
    log(sepia('    预览: ') + preview + (sec.charCount > 200 ? sepia('...') : ''));
    if (!opts.json) {
      const { confirm } = promptKit();
      const go = await confirm({ message: '发这段 (标方法)?', default: true });
      if (!go) { skipped.push({ heading: sec.heading, reason: 'USER_NO' }); log(sepia('    跳过')); continue; }
    }
    try {
      // v0.81: methods 是 first-class entity · 不再 addUpdate + isMethod=true
      // 直接 createMethod · 关联 projectId · 记 source_doc_path
      // v0.84: 支持 --tag · 跨用户聚类
      const r = await apiAction(cfg, 'createMethod', {
        text: sec.fullText,
        scenario: sec.llmReason || null,
        projectId,
        sourceDocPath: filePath,
        tags: opts.tags && opts.tags.length > 0 ? opts.tags : undefined,
        seekingUpdateId: opts.reply || undefined,
      });
      const newId = r.result && r.result.methodId;
      successes.push({ heading: sec.heading, methodId: newId, charCount: sec.charCount });
      log(moss('    ✓ 发了 · 进方法库 · id ' + (newId || '?')));
    } catch (e) {
      log(vermilion('    ✗ 失败: ' + e.message));
      skipped.push({ heading: sec.heading, reason: 'API_ERROR', error: e.message });
    }
    log('');
  }
  if (opts.json) return outputJson({ ok: true, projectId, projectName, file: filePath, contributed: successes, skipped });
  log('');
  log(moss('  完成 · ') + bold(successes.length + ' 段') + sepia(' 进了方法库 · ') + sepia(skipped.length + ' 段') + sepia(' 跳过'));
  log(sepia('  别人 ') + vermilion('tinker borrow "<关键词>"') + sepia(' 时就能搜到你这些段了'));
  log('');
}

// v0.12 自己最近的 update · 给 CLI / AI agent 用
// tinker recent [--limit N] [--kind experience|method|ship|stuck|prototype] [--json]
async function cmdRecent(opts) {
  const cfg = loadConfig();
  if (!cfg || !cfg.serverUrl || !cfg.token) {
    if (opts.json) return errJson('未登录 · 先 tinker login', 'NO_AUTH');
    err('未登录 · 先 ' + vermilion('tinker login')); process.exit(1);
  }
  const limit = parseInt(opts.limit, 10) || 5;
  const kind = opts.kind || (opts.experience ? 'experience' : 'all');
  const qs = new URLSearchParams({ limit: String(limit), kind }).toString();
  let data;
  try {
    const res = await safeFetch(cfg, '/api/me/updates?' + qs, {
      headers: { 'Authorization': 'Bearer ' + cfg.token },
    });
    if (!res.ok) {
      const body = await res.text();
      if (opts.json) return errJson(body || ('HTTP ' + res.status), 'HTTP_' + res.status);
      err('拉失败: HTTP ' + res.status); process.exit(1);
    }
    data = await res.json();
  } catch (e) {
    if (opts.json) return errJson(e.message, 'FETCH_FAIL');
    err(e.message); process.exit(1);
  }
  const list = (data && data.updates) || [];
  if (opts.json) return outputJson({ updates: list });
  if (list.length === 0) {
    log(sepia('  没有 update' + (kind !== 'all' ? ' (kind=' + kind + ')' : '')));
    return;
  }
  log('');
  log(bold(`  最近 ${list.length} 条` + (kind !== 'all' ? ` · 限定 ${kind}` : '')));
  log('');
  list.forEach((u, i) => {
    const when = new Date(u.at).toISOString().slice(0, 10);
    const tags = [];
    if (u.isDecision) tags.push(vermilion('[决策]'));
    if (u.isExperience) tags.push(vermilion('[经验]'));
    if (u.isLearning) tags.push(vermilion('[上手指南]'));
    if (u.isMethod) tags.push(vermilion('[方法]'));
    if (u.kind) tags.push(sepia('[' + u.kind + ']'));
    log(bold(`  ${i + 1}. `) + u.projectName + sepia(' · ') + when + ' ' + tags.join(' '));
    const lines = u.text.split('\n').filter(Boolean).slice(0, 3);
    lines.forEach(line => log('     ' + line.slice(0, 120) + (line.length > 120 ? sepia('...') : '')));
    log(sepia(`     id: ${u.id}  · ${cfg.serverUrl}/#/p/${u.ownerHandle}/${u.projectSlug}`));
    log('');
  });
}

// v0.17 tinker feed @<handle> · 看指定 handle 的最近 update + method · 公开 update 流
// 跟 bridge 不冲突:bridge 是私信加密 · feed 是公开进展流 · 两者互补
// 使用场景:想知道 ta 在做什么 / 到哪一步了 · 不靠 ta 主动 ping
async function cmdFeed(handleArg, opts) {
  const cfg = mustHaveConfig();
  if (!handleArg) {
    if (opts.json) return errJson('用法: tinker feed @<handle>', 'NO_HANDLE');
    err('用法: ' + vermilion('tinker feed @<handle>') + sepia(' [--limit N] [--watch]'));
    process.exit(1);
  }
  const handle = handleArg.replace(/^@/, '');
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;

  async function fetchEvents() {
    const state = await apiState(cfg);
    const userInfo = (state.users && state.users[handle]) || null;
    const allHandles = Object.keys(state.users || {});
    const events = [];
    for (const p of state.projects) {
      if (p.owner !== handle) continue;
      for (const u of (p.updates || [])) {
        events.push({
          type: 'update', at: u.at, projectName: p.name, projectSlug: p.slug,
          projectStatus: p.status, text: u.text, kind: u.kind, id: u.id,
          isMethod: !!u.isMethod, isExperience: !!u.isExperience,
          isLearning: !!u.isLearning, isDecision: !!u.isDecision,
        });
      }
      for (const m of (p.methods || [])) {
        events.push({
          type: 'method', at: m.at, projectName: p.name, scenario: m.scenario,
          title: m.title, id: m.id, borrowCount: m.borrowCount || 0,
        });
      }
    }
    events.sort((a, b) => b.at - a.at);
    return { userInfo, events, allHandles, projects: state.projects.filter(p => p.owner === handle) };
  }

  function renderHeader(userInfo, projects) {
    log('');
    log(bold('  @' + handle + ' · ' + (userInfo?.name || handle)));
    if (userInfo?.tagline) log(sepia('  ' + userInfo.tagline));
    const active = projects.filter(p => ['active', 'stuck', 'live'].includes(p.status));
    const stuck = projects.filter(p => p.status === 'stuck');
    const done = projects.filter(p => p.status === 'done');
    const parts = [];
    if (active.length > 0) parts.push('在做 ' + active.length);
    if (stuck.length > 0) parts.push(vermilion('卡住 ' + stuck.length));
    if (done.length > 0) parts.push('完工 ' + done.length);
    if (parts.length > 0) log(sepia('  ') + parts.join(sepia(' · ')));
    log('');
  }

  function renderEvent(e) {
    const t = new Date(e.at).toLocaleString();
    if (e.type === 'method') {
      log(vermilion('  ✤ 方法') + sepia(' · ' + t + ' · ') + bold(e.projectName)
          + (e.borrowCount > 0 ? sepia(' · 被借 ') + e.borrowCount : ''));
      if (e.scenario) log(sepia('    场景:') + ' ' + e.scenario);
    } else {
      const badges = [];
      if (e.kind === 'ship') badges.push(vermilion('✦ 完工'));
      if (e.projectStatus === 'stuck') badges.push(vermilion('⚠ 卡住'));
      if (e.isMethod) badges.push(sepia('[方法]'));
      if (e.isExperience) badges.push(sepia('[经验]'));
      if (e.isLearning) badges.push(sepia('[上手指南]'));
      if (e.isDecision) badges.push(sepia('[决策]'));
      const badgeStr = badges.length ? ' ' + badges.join(' ') : '';
      log(sepia('  ' + t + ' · ') + bold(e.projectName) + badgeStr);
      const snippet = (e.text || '').replace(/\n/g, ' ').slice(0, 120);
      log('    ' + snippet + ((e.text || '').length > 120 ? sepia('...') : ''));
    }
    log('');
  }

  let { userInfo, events, projects, allHandles } = await fetchEvents();
  if (!userInfo && projects.length === 0) {
    if (opts.json) {
      return outputJson({ ok: false, error: '找不到 @' + handle, code: 'NOT_FOUND',
        availableHandles: allHandles });
    }
    err('找不到 @' + handle);
    if (allHandles && allHandles.length > 0) {
      const list = allHandles.slice(0, 20).map(h => '@' + h).join(sepia(' · '));
      log(sepia('  现有 handles: ') + list
        + (allHandles.length > 20 ? sepia(' (共 ' + allHandles.length + ' 个)') : ''));
    }
    process.exit(1);
  }
  if (opts.json) {
    return outputJson({ ok: true, handle, name: userInfo?.name || handle,
      tagline: userInfo?.tagline || '', events: events.slice(0, limit),
      projects: projects.map(p => ({ id: p.id, slug: p.slug, name: p.name, status: p.status })),
    });
  }
  renderHeader(userInfo, projects);
  if (events.length === 0) {
    log(sepia('  还没有公开 update'));
    return;
  }
  for (const e of events.slice(0, limit)) renderEvent(e);

  if (opts.watch) {
    log(sepia('  ── watch 模式 · 每 30s 拉一次新进展 · Ctrl+C 退出 ──'));
    let lastTs = events[0]?.at || Date.now();
    while (true) {
      await new Promise(r => setTimeout(r, 30 * 1000));
      try {
        const next = await fetchEvents();
        const fresh = next.events.filter(e => e.at > lastTs);
        if (fresh.length > 0) {
          log(sepia('  ── ' + new Date().toLocaleTimeString() + ' · ' + fresh.length + ' 条新 ──'));
          for (const e of fresh) renderEvent(e);
          lastTs = fresh[0].at;
        }
      } catch (e) { log(sepia('  poll 失败: ' + e.message)); }
    }
  }
}

// v0.12 标某条 update 为"踩坑经验" · 给 AI 检索池
// tinker mark-experience <updateId>  /  --unmark <id>
// 不带参数时 · 拿最近一条 push 的 update
async function cmdMarkExperience(updateIdArg, opts) {
  const cfg = loadConfig();
  if (!cfg.serverUrl || !cfg.token) {
    if (opts.json) return errJson('未登录', 'NO_AUTH');
    err('未登录 · 先 ' + vermilion('tinker login')); process.exit(1);
  }
  if (opts.unmark) {
    const id = typeof opts.unmark === 'string' ? opts.unmark : updateIdArg;
    if (!id) {
      if (opts.json) return errJson('--unmark 需要 updateId', 'NO_ID');
      err('--unmark 需要 updateId · 例: tinker mark-experience --unmark u-xxx'); process.exit(1);
    }
    await apiAction(cfg, 'unmarkExperience', { updateId: id });
    if (opts.json) return outputJson({ ok: true, updateId: id, marked: false });
    log(sepia('  已取消经验标: ') + id);
    return;
  }
  let updateId = updateIdArg;
  if (!updateId) {
    const state = await apiState(cfg);
    let latest = null;
    for (const p of state.projects || []) {
      for (const u of p.updates || []) {
        if (!latest || u.at > latest.at) latest = { ...u, project: p.name };
      }
    }
    if (!latest) {
      if (opts.json) return errJson('还没记过进展 · 没东西可标', 'NO_UPDATES');
      err('还没记过进展 · 没东西可标'); process.exit(1);
    }
    updateId = latest.id;
    log(sepia('  默认拿最近一条: ') + bold(latest.project) + sepia(' · ') + latest.text.slice(0, 60) + sepia('...'));
  }
  await apiAction(cfg, 'markAsExperience', { updateId });
  if (opts.json) return outputJson({ ok: true, updateId, marked: true });
  log('');
  log(moss('  已标为经验 · 给 AI 检索时优先取这类 · 帮其他人少踩坑'));
  log(sepia('  id: ') + updateId);
  log(sepia('  反悔: ') + vermilion(`tinker mark-experience --unmark ${updateId}`));
  log('');
}

// v0.13 mark learning · 跟 mark-experience 同构 · 标为上手指南
async function cmdMarkLearning(updateIdArg, opts) {
  const cfg = loadConfig();
  if (!cfg.serverUrl || !cfg.token) {
    if (opts.json) return errJson('未登录', 'NO_AUTH');
    err('未登录 · 先 ' + vermilion('tinker login')); process.exit(1);
  }
  if (opts.unmark) {
    const id = typeof opts.unmark === 'string' ? opts.unmark : updateIdArg;
    if (!id) {
      if (opts.json) return errJson('--unmark 需要 updateId', 'NO_ID');
      err('--unmark 需要 updateId · 例: tinker mark-learning --unmark u-xxx'); process.exit(1);
    }
    await apiAction(cfg, 'unmarkLearning', { updateId: id });
    if (opts.json) return outputJson({ ok: true, updateId: id, marked: false });
    log(sepia('  已取消上手指南标: ') + id);
    return;
  }
  let updateId = updateIdArg;
  if (!updateId) {
    const state = await apiState(cfg);
    let latest = null;
    for (const p of state.projects || []) {
      for (const u of p.updates || []) {
        if (!latest || u.at > latest.at) latest = { ...u, project: p.name };
      }
    }
    if (!latest) {
      if (opts.json) return errJson('还没记过进展 · 没东西可标', 'NO_UPDATES');
      err('还没记过进展 · 没东西可标'); process.exit(1);
    }
    updateId = latest.id;
    log(sepia('  默认拿最近一条: ') + bold(latest.project) + sepia(' · ') + latest.text.slice(0, 60) + sepia('...'));
  }
  await apiAction(cfg, 'markAsLearning', { updateId });
  if (opts.json) return outputJson({ ok: true, updateId, marked: true });
  log('');
  log(moss('  已标为上手指南 · 给 AI 检索时优先取这类 · 帮其他人快速入门新技术'));
  log(sepia('  id: ') + updateId);
  log(sepia('  反悔: ') + vermilion(`tinker mark-learning --unmark ${updateId}`));
  log('');
}

// best-effort 把 mutedUntil 推到 server · 失败不影响本地
async function syncMuteToServer(mutedUntil) {
  try {
    const cfg = loadConfig();
    if (!cfg || !cfg.serverUrl || !cfg.token) return false;
    const res = await fetch(cfg.serverUrl + '/api/user/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token },
      body: JSON.stringify({ mutedUntil }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data && data.ok && data.prefs) savePrefsCache(data.prefs);
    return true;
  } catch { return false; }
}

// v0.35 tinker prefs · 看当前通知偏好 (从 server 拉新的)
//   tinker prefs           人可读当前状态
//   tinker prefs --json    JSON
//   tinker prefs --sync    强制拉一次 (绕过 5min cache)
async function cmdPrefs(opts) {
  if (opts && opts.sync) {
    const fresh = await fetchPrefsFromServer();
    if (!fresh) {
      if (opts.json) return errJson('拉不到 · 没 token / 离线 / server 没接通', 'PREFS_FETCH_FAIL');
      err('拉不到 prefs · 检查 token (' + vermilion('tinker login') + ') 或网络');
      process.exit(1);
    }
  }
  const prefs = getPrefsSync();
  if (opts && opts.json) {
    return outputJson({ ok: true, prefs: prefs || null, source: prefs ? 'cache' : 'none' });
  }
  if (!prefs) {
    log(sepia('  还没拉到 prefs · 跑 ') + vermilion('tinker prefs --sync') + sepia(' 强制拉一次'));
    log(sepia('  或者 ') + vermilion('tinker login') + sepia(' 配 server + token'));
    return;
  }
  log('');
  log(bold('  通知偏好 · server 同步状态'));
  log('');
  if (prefs.mutedUntil && prefs.mutedUntil > Date.now()) {
    const left = prefs.mutedUntil - Date.now();
    const leftLabel = left > 365 * 24 * 3600 * 1000 ? '一直勿扰' : Math.round(left / 60000) + ' 分钟后解除';
    log(vermilion('  · 勿扰中 · ') + leftLabel);
  } else {
    log(sepia('  · 没勿扰'));
  }
  if (prefs.quietStart && prefs.quietEnd) {
    log(sepia('  · 夜间安静时段 · ') + vermilion(prefs.quietStart + ' - ' + prefs.quietEnd));
  } else {
    log(sepia('  · 没设夜间时段'));
  }
  const disabled = prefs.cliDisabledKinds || [];
  if (disabled.length > 0) {
    log(sepia('  · CLI 触发器关掉 ' + disabled.length + ' 类: ') + vermilion(disabled.join(' / ')));
  } else {
    log(sepia('  · CLI 触发器全开'));
  }
  log('');
  log(sepia('  在 webapp 账号页改 · ') + vermilion('tinker prefs --sync') + sepia(' 强拉'));
  log('');
}

async function cmdMute(args) {
  const arg = (args || '').trim();
  const state = loadPromptState();
  const now = Date.now();
  if (arg === 'off' || arg === 'unmute') {
    state.mutedUntil = null;
    state.laterUntil = null;            // 老字段 · 向后兼容清理
    state.laterUntilByReason = {};      // v0.13 per-reason 延后清空
    state.dismissedTodayKey = null;
    savePromptState(state);
    const synced = await syncMuteToServer(null);
    ok('解除静音 · 触发器开启' + (synced ? ' · 多机同步' : ' · 仅本机 (没 token / 离线)'));
    return;
  }
  const m = arg.match(/^(\d+)(m|h|d)$/);
  let duration = 60 * 60 * 1000; // 默认 1h
  let label = '1 小时';
  if (m) {
    const n = parseInt(m[1], 10);
    if (m[2] === 'm') { duration = n * 60 * 1000; label = `${n} 分钟`; }
    else if (m[2] === 'h') { duration = n * 60 * 60 * 1000; label = `${n} 小时`; }
    else if (m[2] === 'd') { duration = n * 24 * 60 * 60 * 1000; label = `${n} 天`; }
  } else if (arg === 'today') {
    duration = beijingDayStart(1, 4) - now; // 北京明天凌晨 4:00
    label = '到明早 4 点';
  } else if (arg === 'forever') {
    state.mutedUntil = Number.MAX_SAFE_INTEGER;
    savePromptState(state);
    const fixedFar = now + 50 * 365 * 24 * 3600 * 1000;  // server 不接 MAX_SAFE_INTEGER · 用 50 年
    const synced = await syncMuteToServer(fixedFar);
    ok('永久静音 · 用 ' + vermilion('tinker mute off') + ' 解除' + (synced ? ' · 多机同步' : ' · 仅本机'));
    return;
  } else if (arg) {
    err('用法: tinker mute [Nm|Nh|Nd|today|forever|off]');
    process.exit(1);
  }
  const until = now + duration;
  state.mutedUntil = until;
  savePromptState(state);
  const synced = await syncMuteToServer(until);
  ok('静音 ' + label + ' · 用 ' + vermilion('tinker mute off') + ' 解除' + (synced ? ' · 多机同步' : ' · 仅本机'));
}

// v0.13 tinker stream <resource> · 长跑 NDJSON 输出
// 不依赖任何 AI agent · 任何能读 stdout 的 AI / 脚本都能用
//
// 资源:
//   triggers · prompt-state 快照 · 内容变化时推一行
//   today    · 今日 git commit + Tinker push 计数 · 30s 轮询
//
// 用法:
//   tinker stream triggers              一直跑 · 内容变化时打一行 NDJSON
//   tinker stream triggers --once       打完当前 snapshot 就退 (调试 / poll)
//
// 输出格式:
//   {"event":"snapshot","resource":"...","at":1234,"data":{...}}   起始快照
//   {"event":"updated","resource":"...","at":1234,"data":{...}}    变化推送
async function cmdStream(resource, opts = {}) {
  if (!resource) {
    err('用法: tinker stream <resource> · 可选: triggers / today');
    process.exit(1);
  }
  const emit = (event, data) => {
    process.stdout.write(JSON.stringify({ event, resource, at: Date.now(), data }) + '\n');
  };

  // 资源读取函数表 · 共享给 snapshot / updated 都用
  const reads = {
    triggers: () => {
      const s = loadPromptState();
      const now = Date.now();
      return {
        muted: !!(s.mutedUntil && s.mutedUntil > now),
        mutedUntil: s.mutedUntil || null,
        dismissedToday: s.dismissedTodayKey === todayKey(),
        lastPromptedAt: s.lastPromptedAt || null,
        uiSession: s.uiSession || null,
        lastPushAtByProject: s.lastPushAtByProject || {},
        pending: loadPending() || null,
      };
    },
    today: async () => {
      const cfg = loadConfig();
      let gitCommits = 0;
      if (inGitRepo()) {
        try {
          const since = beijingSinceISO(0, 4);
          const out = require('child_process').execSync(`git log --since="${since}" --no-merges --oneline`, { encoding: 'utf-8' });
          gitCommits = out.trim().split('\n').filter(Boolean).length;
        } catch {}
      }
      let tinkerPushed = 0;
      if (cfg && cfg.serverUrl && cfg.token) {
        try {
          const state = await apiState(cfg);
          const todayStart = beijingDayStart(0, 0); // 北京 0am
          for (const p of state.projects || []) {
            for (const u of p.updates || []) {
              if (u.at >= todayStart) tinkerPushed++;
            }
          }
        } catch {}
      }
      return { gitCommits, tinkerPushed };
    },
  };

  const read = reads[resource];
  if (!read) {
    err('未知资源: ' + resource + ' · 可选: ' + Object.keys(reads).join(' / '));
    process.exit(1);
  }

  // 起始 snapshot
  const initial = await read();
  emit('snapshot', initial);
  if (opts.once) return;

  let lastKey = JSON.stringify(initial);
  let polling = false;
  const checkAndPush = async () => {
    if (polling) return; // 避免并发
    polling = true;
    try {
      const next = await read();
      const k = JSON.stringify(next);
      if (k !== lastKey) { lastKey = k; emit('updated', next); }
    } catch {}
    polling = false;
  };

  // 5s 轮询 (triggers 偏低频 · today 偏低频 · 都 5s 就够)
  const interval = setInterval(checkAndPush, 5000);
  interval.unref();

  // triggers: 加 prompt-state.json 文件 watch (1s · 更灵敏)
  if (resource === 'triggers') {
    const stateFile = path.join(CONFIG_DIR, 'prompt-state.json');
    if (fs.existsSync(stateFile)) {
      fs.watchFile(stateFile, { interval: 1000 }, () => checkAndPush());
    }
  }

  // 等 SIGINT · stdin EOF · 主进程退出
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.stdin.on('end', () => process.exit(0));
  await new Promise(() => {}); // 永远 hang
}

function help() {
  // v0.14 渐进披露 · 没建/没进工作室的 solo 用户 · 团队栏折叠成一行 · 不糊一脸
  let hasStudio = false;
  try { hasStudio = (require('../lib/bridge').loadStudios().studios || []).length > 0; } catch {}

  log('');
  log(bold('  tinker') + sepia(' — 在 coding 时把进展发到捣鼓 / Tinker'));
  log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  log('');
  log(bold('  个人') + sepia('  ── 一个人也能跑的全部'));
  log('');
  log(sepia('  ') + vermilion('一次性'));
  log('  ' + vermilion('tinker login') + sepia('                       配置 server + 钥匙 + LLM'));
  log('  ' + vermilion('tinker onboard') + sepia('                     一站式配齐 · 项目 / git hook / claude hook / CLAUDE.md (login 之后跑这一条)'));
  log('  ' + vermilion('tinker onboard --update') + sepia('             刷新 CLAUDE.md 里的 Tinker 协作约定段'));
  log('  ' + vermilion('tinker skills install') + sepia('              装完整 Skills · --agent codex 使用 .agents/skills · --only 选装 · --local 当前 repo'));
  log('');
  log(sepia('  ') + vermilion('日常 · 半自动'));
  log('  ' + vermilion('tinker draft') + sepia('                       LLM 看 git 历史 · 起草 1-3 条候选到 .tinker/drafts/'));
  log('  ' + vermilion('tinker draft --since 30m') + sepia('           自定义时间窗'));
  log('  ' + vermilion('tinker push <file.md>') + sepia('              从草稿文件发布(读完文件 · 把不想发的段落删掉再发)'));
  log('  ' + vermilion('tinker push <file.md> --only=1,3') + sepia('   只发指定候选'));
  log('');
  log(sepia('  ') + vermilion('直接发'));
  log('  ' + vermilion('tinker push -m "..."') + sepia('               一句话直接发') + dim(' (加 --dry-run 先预览发到哪/voice 打分)'));
  log('  ' + vermilion('tinker push') + sepia('                        交互式 · 默认最近一条 commit 作为建议'));
  log('  ' + vermilion('tinker stuck -m "..."') + sepia('              标项目卡住 + 写"卡在哪" · 通知关心你的人'));
  log('');
  log(sepia('  ') + vermilion('完工'));
  log('  ' + vermilion('tinker ship -m "..."') + sepia('               改 done + 写完工感想 · 默认抓 productLink 截图当陈列馆封面') + dim(' (--dry-run 预览)'));
  log('  ' + vermilion('tinker ship -m "..." --feedback-ask "..."') + sepia(' · 加上"想知道"的具体问题'));
  log('  ' + vermilion('tinker ship -m "..." --no-feedback') + sepia('    · 不勾求反馈'));
  log('  ' + vermilion('tinker ship -m "..." --image ./shot.png') + sepia('     · 用本地图当封面 (优先于自动截图)'));
  log('  ' + vermilion('tinker ship -m "..." --no-screenshot') + sepia('       · 不带封面'));
  log('');
  log(sepia('  ') + vermilion('主动 prompt · 让 CLI 在合适的时间问你 (默认 opt-in)'));
  log('  ' + vermilion('tinker hook install') + sepia('                装 git post-commit hook · 25 个触发器分优先级'));
  log('  ' + vermilion('tinker hook uninstall') + sepia('              卸 hook'));
  log('  ' + vermilion('tinker check') + sepia('                       手动跑一次触发器评估 (hook 自动调这个)'));
  log('  ' + vermilion('tinker triggers') + sepia('                    自检 · 看每个触发器的状态 + 当前 winner'));
  log('  ' + vermilion('tinker resolve <choice> -m "..."') + sepia('    响应 pending prompt (push / ship / stuck 等)'));
  log('  ' + vermilion('tinker mute 1h') + sepia(' / ') + vermilion('today') + sepia(' / ') + vermilion('forever') + sepia(' / ') + vermilion('off') + sepia('   静音控制'));
  log('  ' + vermilion('tinker session status') + sepia(' / ') + vermilion('end') + sepia('     看 UI session 状态 / 手动结束'));
  log('  ' + vermilion('tinker llm set') + sepia(' / ') + vermilion('status') + sepia(' / ') + vermilion('off') + sepia('       配 / 看 / 清 LLM key (给自动起草用)'));
  log('  ' + vermilion('tinker screenshot <provider> <key>') + sepia('   换截图后端 (apiflash / screenshotone · 默认 microlink 免费档) · test 验一张'));
  log('');
  log(sepia('  ') + vermilion('收尾 · 沉淀'));
  log('  ' + vermilion('tinker goodnight') + sepia('                   今日总结 (commit + push + 方法被借)'));
  log('  ' + vermilion('tinker goodnight --week') + sepia(' / ') + vermilion('--month') + sepia('     周报 / 月报'));
  log('  ' + vermilion('tinker goodnight --narrate') + sepia('          让 LLM 替你说一句'));
  log('');
  log(sepia('  ') + vermilion('踩坑跟踪 · 自动整理经验贴'));
  log('  ' + vermilion('tinker struggle') + sepia('                    看当前是不是在折腾 + 最近的踩坑列表'));
  log('  ' + vermilion('tinker struggle off') + sepia(' / ') + vermilion('on') + sepia('             24h 关跟踪 / 重新开'));
  log(sepia('  ') + dim('Claude Code 对话里反复挣扎 → CLI 自动记 dossier → 破局后后台整理成草稿 → 一键发'));
  log('');
  log(sepia('  ') + vermilion('方法库 · 让别人借 / 借别人的'));
  log('  ' + vermilion('tinker borrow "<关键词>"') + sepia('            搜方法库 (作者标方法的排前)'));
  log('  ' + vermilion('tinker borrow ... --methods-only') + sepia('    只看作者标方法的'));
  log('  ' + vermilion('tinker seek -m "..."') + sepia('               发一条求方法 · 进方法库「有人在找」(跟 ship 的求反馈不是一回事)'));
  log('  ' + vermilion('tinker contribute [updateId]') + sepia('        标自己一条 update 为方法'));
  log('  ' + vermilion('tinker contribute --from-file <md>') + sepia('  从 markdown 按段交互选 contribute · 隐私扫描'));
  log('  ' + vermilion('tinker contribute --from-file <md> --auto') + sepia(' LLM 看完帮挑 3 段 · 一键确认'));
  log('');
  log(sepia('  ') + vermilion('反馈链路 · 反算法的闭环 (借了 / 启发了要回应)'));
  log('  ' + vermilion('tinker react <projectId>') + sepia('            toggle "想试试" · 项目作者收到通知'));
  log('  ' + vermilion('tinker used <updateId> -m "..."') + sepia('     标某条进展为"用了 · 跑通了" · 给原作者反馈'));
  log('  ' + vermilion('tinker note-done [编号|noteId]') + sepia('      把你项目下的便签标成"处理了" · 便签作者收到回响 · 无参列待处理'));
  log('  ' + vermilion('tinker tinkered <projectId> --name "..." --link "https://..." --inspired-by <updateId>'));
  log(sepia('                                       挂上你做的延伸版 · 因 ta 启发'));
  log('  ' + vermilion('tinker tinkered <projectId> --undo') + sepia('  撤回延伸版'));
  log('');
  log(sepia('  ') + vermilion('编辑 / 删除 / 建项目'));
  log('  ' + vermilion('tinker edit <updateId> -m "..."') + sepia('     改一条 update [--scenario "..."]'));
  log('  ' + vermilion('tinker delete <updateId>') + sepia('            删一条 update · TTY confirm · 非 TTY 加 --yes'));
  log('  ' + vermilion('tinker edit-method <methodId>') + sepia('       改一条 method [-m] [--scenario] [--title] [--tag]'));
  log('  ' + vermilion('tinker project new --name "..." --desc "..."') + sepia(' 建项目 [--link <url>] [--tool x --tool y]'));
  log('  ' + vermilion('tinker project edit <projectId>') + sepia('     改项目 [--name] [--desc] [--link] [--tool]'));
  log('');
  log(sepia('  ') + vermilion('看别人在做什么 (公开流 · 不需要工作室)'));
  log('  ' + vermilion('tinker feed @<handle>') + sepia('             看 ta 最近 update / method / 项目状态 [--limit N] [--watch]'));
  log('  ' + vermilion('tinker feed @<handle> --watch') + sepia('      每 30s 拉一次新进展 · 命令行里持续看 ta 在干啥'));
  log('');
  log(sepia('  ') + vermilion('stash · 跨设备暂存现场 (给自己 · 不靠工作室)'));
  log('  ' + vermilion('tinker stash push -m "卡在哪"') + sepia('         A 机器存现场 (未提交改动 + 卡点) · 到 server'));
  log('  ' + vermilion('tinker stash') + sepia(' / ') + vermilion('pop [id]') + sepia(' / ') + vermilion('drop <id>') + sepia('   列 / B 机器还原接着写 / 删'));
  log('  ' + vermilion('tinker stash key <口令>') + sepia('               设加密钥 (端到端 · server 看不到 · 别的设备设同口令) · 默认明文'));
  log('');
  log(sepia('  ') + vermilion('voice · 写作风格学习'));
  log('  ' + vermilion('tinker voice analyze') + sepia('               用 pool 样本生成 fingerprint'));
  log('  ' + vermilion('tinker voice teach --from-claude') + sepia('    从 Claude Code 对话历史抽样本'));
  log('  ' + vermilion('tinker voice teach --review') + sepia('         逐条 y/n/skip 自监督 (good / bad 池)'));
  log('');
  // v0.14 团队栏 · 渐进披露 · 有工作室才展开 · solo 只看一行提示
  log(bold('  团队协作') + sepia('  ── 需要工作室 (你跟队友共享的加密频道)'));
  log('');
  if (!hasStudio) {
    log(sepia('  你还没建/进工作室 · 接力 handoff · 决策征求 witness · 私信 ping/send 都收在这层'));
    log(sepia('  建一个展开全部: ') + vermilion('tinker studio create <slug> --name "..."'));
    log(sepia('  收到邀请就加入: ') + vermilion('tinker studio accept <token>'));
    log('');
  } else {
  log(sepia('  ') + vermilion('工作室 · 你跟队友 = 一个工作室'));
  log('  ' + vermilion('tinker studio create <slug> --name "..."') + sepia('  建工作室 · 自动当 owner'));
  log('  ' + vermilion('tinker studio invite <slug> @<handle>') + sepia('     给队友生成一次性邀请 token · e2e'));
  log('  ' + vermilion('tinker studio accept <token>') + sepia('              兑换邀请 · 自动写本地暗号'));
  log('  ' + vermilion('tinker studio list / info <slug> / leave <slug>') + sepia('  其余操作 · 跑 tinker studio help 看全'));
  log('');
  log(sepia('  ') + vermilion('接力 · 队友 AI 异步往返'));
  log('  ' + vermilion('tinker handoff -m "..." [-t @<who>] [--no-situation]') + sepia('  打包现场发队友 · 自动挑的现场会显示 · 不对加 --no-situation') + dim(' (--dry-run 预览发给谁/多大 · 发出不可撤回)'));
  log('  ' + vermilion('tinker outbox [关键词] [--days N]') + sepia('   翻我发过的私信 / handoff · 给关键词全量搜回 (借图片字段那种老上下文)'));
  log('  ' + vermilion('tinker handoff reply <msgId> [--by-claude]') + sepia('  接力方回稿给原发起方 (接到哪步 · 留了什么)'));
  log('  ' + vermilion('tinker handoff reply <msgId> publish "<content>"') + sepia(' 落地回稿 + bridge 回投递 + 自动标 inbox 完成'));
  log('  ' + vermilion('tinker inbox') + sepia('                        看收到的 handoff task · tinker inbox <id> 看详情 · tinker inbox done <id> 标完工'));
  log('  ' + vermilion('tinker inbox fetch <id>') + sepia('             取回懒取的重料到 context/ (接了才下载 · verify 会自动取)'));
  log('  ' + vermilion('tinker inbox verify <id> [--repo <path>]') + sepia('  验收接力包 · 临时工作树重放 diff · 验完自动回执/退信给发起方'));
  log('');
  log(sepia('  ') + vermilion('witness · 决策推演 (异步 AI review)'));
  log('  ' + vermilion('tinker witness draft --topic "..." --by-claude') + sepia('  起草脚手架 · Claude 写内容'));
  log('  ' + vermilion('tinker witness publish "<content>" [--with-context]') + sepia('  落地 + 广播到 active studio'));
  log('  ' + vermilion('tinker witness reply <updateId> --by-claude') + sepia('  接收方写 critique'));
  log('  ' + vermilion('tinker witness close <updateId> --decision "..."') + sepia('   发起方落定最终决策'));
  log('  ' + vermilion('tinker witness self --topic "..." --by-claude') + sepia('   自我 witness · 过去三个月的你当 reviewer · 不发 bridge (solo 也能跑)'));
  log('');
  log(sepia('  ') + vermilion('团队自动 ping · 触发器命中时提醒队友'));
  log('  ' + vermilion('tinker bridge auto-ping --enable') + sepia('   触发器命中 ship/stuck 时自动 ping 团队 [--kinds ...] [--to @who]'));
  log('  ' + vermilion('tinker bridge auto-ping --status') + sepia('   看当前配置'));
  log('  ' + vermilion('tinker bridge auto-ping --disable') + sepia('  停用'));
  log('');
  }
  log(bold('  给 AI / 辅助'));
  log('');
  log(sepia('  ') + vermilion('给 AI 用 (machine-readable)'));
  log('  ' + vermilion('tinker schema --json') + sepia('               CLI 自身能力 schema · AI 读这个知道怎么用'));
  log('  ' + vermilion('tinker action <type> --payload \'{...}\'') + sepia(' 逃生口 · 直调 server 任意 action (还没包成命令的) · --dry-run 先预览'));
  log('  ' + vermilion('tinker state --json') + sepia('                读 prompt-state 当前快照'));
  log('  ' + vermilion('tinker stream <resource>') + sepia('            长跑 NDJSON 事件流 (triggers / today)'));
  log('  ' + vermilion('tinker maybe-check --text "..."') + sepia('     跨 AI 通用入口 · 非 Claude Code 的 LLM 主动调拿 matcher 命中 reminder'));
  log('  ' + vermilion('tinker pending [--json|--check|--mark-handled <id>|--clear]') + sepia(' 看/处理 post-commit hook 触发的待处理 reminder'));
  log(sepia('  ') + dim('几乎所有命令支持 --json · 错误统一 { ok: false, error, code } 形态'));
  log('');
  // v0.14 AI agent 反向映射:关键场景 → 调什么命令 · 让 LLM 看 help 就能直接用
  // CLI 一条路线 · LLM 通过 Bash 跑 tinker + --json 拿结构化结果 · 任何 AI client 都能用
  log(sepia('  ') + vermilion('AI agent 指南 (LLM 看下方关键场景决定调什么)'));
  log(sepia('  ─────────────────────────────────────────────────────────────'));
  log(sepia('  用户聊到某技术/报错/想入门 X        → ') + vermilion('tinker borrow "<关键词>" --json --limit 5'));
  log(sepia('  用户说"卡住/不行/跑不起来"          → ') + vermilion('tinker stuck -m "..." ') + dim('(看上下文真卡才调)'));
  log(sepia('  用户说"懂了/顿悟/终于通了"          → ') + vermilion('tinker push -m "..." ') + dim('(顿悟时刻难复现)'));
  log(sepia('  用户做工具/方案决策                  → ') + vermilion('tinker resolve push-decision -m "..."'));
  log(sepia('  用户说"砍了/不做了"                 → ') + vermilion('tinker push -m "..." ') + dim('(说为什么砍)'));
  log(sepia('  用户说"完工/上线了/deploy 了"        → ') + vermilion('tinker ship -m "..." ') + dim('(进陈列馆)'));
  log(sepia('  用户问"今天都做了啥"                → ') + vermilion('tinker goodnight --json'));
  log(sepia('  用户问"上次怎么解决的"              → ') + vermilion('tinker recent --json --limit 10'));
  log(sepia('  起草前避免重复 / 引用作者过往        → ') + vermilion('tinker recent --json'));
  log(sepia('  作者要"标方法/经验/上手指南/决策"     → ') + vermilion('tinker contribute / mark-experience / mark-learning / mark-decision'));
  log(sepia('  用户借了某条 update 且跑通了          → ') + vermilion('tinker used <updateId> -m "..." ') + dim('(给原作者反馈)'));
  log(sepia('  用户说"想试试某个项目"              → ') + vermilion('tinker react <projectId>'));
  log(sepia('  用户做了延伸版 (因 ta 启发)           → ') + vermilion('tinker tinkered <projectId> --name --link --inspired-by'));
  log(sepia('  用户要改一条 update / method         → ') + vermilion('tinker edit <updateId> -m / tinker edit-method <methodId>'));
  log(sepia('  用户要删测试条 / 误发条              → ') + vermilion('tinker delete <updateId> --yes ') + dim('(非 TTY 必须 --yes)'));
  log(sepia('  用户开新项目                       → ') + vermilion('tinker project new --name "..." --desc "..."'));
  log(sepia('  hook 触发了 pending 等响应          → ') + vermilion('tinker resolve <choice> -m "..."'));
  log(sepia('  查 post-commit hook 触发的待处理      → ') + vermilion('tinker pending --json'));
  log(sepia('  用户问"猫猫在做什么 / 到哪一步了"      → ') + vermilion('tinker feed @maomao --json'));
  log(sepia('  ') + dim('  LLM 主动调:session 开头 / 用户问"今天怎么样" / commit 之后 · 看有没有漏掉的 ship / clever-fix 等'));
  log(sepia('  非 Claude Code (Cursor/Aider 等) · 没有 hook → ') + vermilion('tinker maybe-check --text "<用户消息>" --json'));
  log(sepia('  ') + dim('  上面这个跟 Claude Code hook 共用词典 + 冷却 · LLM 主动调拿命中 reminder'));
  log(sepia('  ') + dim('调前看 ') + vermilion('tinker state --json') + dim(' · 静音/冷却中别打扰'));
  log(sepia('  ') + dim('幂等保险 · 给 --idempotency-key (同 key 24h 内不重复)'));
  log(sepia('  ') + dim('关键词命中只是候选 · 看上下文判断是否真的提醒 · 不每次都建议'));
  log('');
  log(sepia('  ') + vermilion('辅助'));
  log('  ' + vermilion('tinker projects | ls') + sepia('               列我的活跃项目'));
  log('  ' + vermilion('tinker config') + sepia('                      看当前配置'));
  log('  ' + vermilion('tinker update') + sepia('                      拉最新代码 + 重装(需要按一键命令装的)'));
  log('');
  log(sepia('  voice 覆盖: 在项目里建 ') + vermilion('.tinker/voice.md') + sepia(' · LLM 起草时会用这个气质'));
  log(sepia('  --since 支持: ') + dim('30m / 2h / 1d / today / yesterday / git 能理解的格式'));
  log('');
}

// =============================================
// arg parsing
// =============================================
function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-m' || a === '--message' || a === '--text') opts.text = args[++i];
    else if (a.startsWith('--text=')) opts.text = a.slice('--text='.length);
    else if (a === '--since') opts.since = args[++i];
    else if (a === '-p' || a === '--project') opts.projectId = args[++i];
    else if (a.startsWith('--only=')) opts.only = a.slice('--only='.length);
    else if (a === '--only') opts.only = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : '';
    else if (a === '--agent') opts.agent = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : '';
    else if (a.startsWith('--agent=')) opts.agent = a.slice('--agent='.length);
    else if (a === '--feedback-ask') opts.feedbackAsk = args[++i];
    else if (a.startsWith('--feedback-ask=')) opts.feedbackAsk = a.slice('--feedback-ask='.length);
    else if (a === '--no-feedback') opts.noFeedback = true;
    else if (a === '--image') opts.image = args[++i];
    else if (a.startsWith('--image=')) opts.image = a.slice('--image='.length);
    else if (a === '--no-screenshot') opts.noScreenshot = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--from-hook') opts.fromHook = true;
    else if (a === '--from-claude') opts.fromClaude = true;
    else if (a === '--from-tinker') opts.fromTinker = true;
    else if (a === '--name') opts.name = args[++i];
    else if (a.startsWith('--name=')) opts.name = a.slice('--name='.length);
    else if (a === '--tagline') opts.tagline = args[++i];
    else if (a.startsWith('--tagline=')) opts.tagline = a.slice('--tagline='.length);
    else if (a === '--link') opts.link = args[++i];
    else if (a.startsWith('--link=')) opts.link = a.slice('--link='.length);
    else if (a === '--inspired-by') opts.inspiredBy = args[++i];
    else if (a.startsWith('--inspired-by=')) opts.inspiredBy = a.slice('--inspired-by='.length);
    else if (a === '--undo') opts.undo = true;
    else if (a === '--due') opts.due = args[++i];
    else if (a.startsWith('--due=')) opts.due = a.slice('--due='.length);
    else if (a === '--team') opts.team = true;
    else if (a === '--watch') opts.watch = true;
    else if (a === '--enable') opts.enable = true;
    else if (a === '--disable') opts.disable = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--to' || a === '-t') opts.toHandle = (args[++i] || '').replace(/^@/, '');
    else if (a.startsWith('--to=')) opts.toHandle = a.slice('--to='.length).replace(/^@/, '');
    else if (a === '--kinds') opts.kinds = (args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--kinds=')) opts.kinds = a.slice('--kinds='.length).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--check') opts.check = true;
    else if (a === '--clear') opts.clear = true;
    else if (a === '--clean') opts.clean = true;
    else if (a === '--server') opts.server = args[++i];
    else if (a.startsWith('--server=')) opts.server = a.slice('--server='.length);
    else if (a === '--token') opts.token = args[++i];
    else if (a.startsWith('--token=')) opts.token = a.slice('--token='.length);
    else if (a === '--app-id') opts.appId = args[++i];
    else if (a.startsWith('--app-id=')) opts.appId = a.slice('--app-id='.length);
    else if (a === '--app-secret') opts.appSecret = args[++i];
    else if (a.startsWith('--app-secret=')) opts.appSecret = a.slice('--app-secret='.length);
    else if (a === '--studio') opts.studio = args[++i];
    else if (a.startsWith('--studio=')) opts.studio = a.slice('--studio='.length);
    else if (a === '--solo') opts.solo = true;
    else if (a === '--mark-handled') opts.markHandled = args[++i];
    else if (a.startsWith('--mark-handled=')) opts.markHandled = a.slice('--mark-handled='.length);
    else if (a === '--desc') opts.desc = args[++i];
    else if (a.startsWith('--desc=')) opts.desc = a.slice('--desc='.length);
    else if (a === '--scenario') opts.scenario = args[++i];
    else if (a.startsWith('--scenario=')) opts.scenario = a.slice('--scenario='.length);
    else if (a === '--title') opts.title = args[++i];
    else if (a.startsWith('--title=')) opts.title = a.slice('--title='.length);
    else if (a === '--topic') opts.topic = args[++i];
    else if (a.startsWith('--topic=')) opts.topic = a.slice('--topic='.length);
    else if (a === '--update') opts.update = true;
    else if (a === '--local') opts.local = true;
    else if (a === '--tool') {
      const v = args[++i];
      if (v) { opts.tools = opts.tools || []; opts.tools.push(v); }
    } else if (a.startsWith('--tool=')) {
      const v = a.slice('--tool='.length);
      if (v) { opts.tools = opts.tools || []; opts.tools.push(v); }
    }
    else if (a === '--week') opts.week = true;
    else if (a === '--month') opts.month = true;
    else if (a === '--days') opts.daysBack = parseInt(args[++i], 10);
    else if (a.startsWith('--days=')) opts.daysBack = parseInt(a.slice('--days='.length), 10);
    else if (a === '--narrate') opts.narrate = true;
    else if (a === '--review') opts.review = true;
    else if (a === '--idempotency-key' || a === '--idem-key') opts.idemKey = args[++i];
    else if (a.startsWith('--idempotency-key=')) opts.idemKey = a.slice('--idempotency-key='.length);
    else if (a.startsWith('--idem-key=')) opts.idemKey = a.slice('--idem-key='.length);
    else if (a === '--file') opts.file = args[++i];
    else if (a.startsWith('--file=')) opts.file = a.slice('--file='.length);
    else if (a === '--limit') opts.limit = parseInt(args[++i], 10);
    else if (a.startsWith('--limit=')) opts.limit = parseInt(a.slice('--limit='.length), 10);
    else if (a === '--methods-only' || a === '--methodsOnly') opts.methodsOnly = true;
    else if (a === '--kind') opts.kind = args[++i];
    else if (a.startsWith('--kind=')) opts.kind = a.slice('--kind='.length);
    else if (a === '--discipline') opts.discipline = args[++i];
    else if (a.startsWith('--discipline=')) opts.discipline = a.slice('--discipline='.length);
    else if (a === '--as-experience' || a === '--asExperience') opts.asExperience = true;
    else if (a === '--as-learning' || a === '--asLearning') opts.asLearning = true;
    else if (a === '--as-decision' || a === '--asDecision') opts.asDecision = true;
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--payload') opts.payload = args[++i];
    else if (a.startsWith('--payload=')) opts.payload = a.slice('--payload='.length);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--by-claude') opts.byClaude = true;
    else if (a === '--with-context') opts.withContext = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--encrypt') opts.encrypt = true;
    else if (a === '--plain') opts.plain = true;
    else if (a === '--situation') opts.situation = args[++i];
    else if (a.startsWith('--situation=')) opts.situation = a.slice('--situation='.length);
    else if (a === '--no-situation') opts.noSituation = true;
    else if (a === '--search') opts.search = args[++i];
    else if (a.startsWith('--search=')) opts.search = a.slice('--search='.length);
    else if (a === '--tag') {
      // v0.84 支持多次 · 收集 · contribute 时一并发上
      const v = (args[++i] || '').trim();
      if (v) {
        if (!opts.tags) opts.tags = [];
        opts.tags.push(v);
      }
    }
    else if (a.startsWith('--tag=')) {
      const v = a.slice('--tag='.length).trim();
      if (v) {
        if (!opts.tags) opts.tags = [];
        opts.tags.push(v);
      }
    }
    else if (a === '--from-file') opts.fromFile = args[++i];
    else if (a.startsWith('--from-file=')) opts.fromFile = a.slice('--from-file='.length);
    else if (a === '--repo') opts.repo = args[++i];
    else if (a.startsWith('--repo=')) opts.repo = a.slice('--repo='.length);
    else if (a === '--auto') opts.auto = true;
    else if (a === '--once') opts.once = true;
    else if (a === '--reply') opts.reply = args[++i];
    else if (a.startsWith('--reply=')) opts.reply = a.slice('--reply='.length);
    else if (a === '--section') {
      // 支持多次 · 收集成数组 (匹配多段一起 contribute)
      const v = args[++i];
      if (opts.section) opts.section = Array.isArray(opts.section) ? [...opts.section, v] : [opts.section, v];
      else opts.section = v;
    }
    else if (a.startsWith('--section=')) {
      const v = a.slice('--section='.length);
      if (opts.section) opts.section = Array.isArray(opts.section) ? [...opts.section, v] : [opts.section, v];
      else opts.section = v;
    }
    else if (a.startsWith('--project=')) opts.projectId = a.slice('--project='.length);
    else if (a === '--unmark') {
      // 既支持 --unmark <id> 也支持 --unmark=<id> · 单独 --unmark 走 positional id
      const next = args[i + 1];
      if (next && !next.startsWith('-')) { opts.unmark = next; i++; }
      else opts.unmark = true;
    }
    else if (a.startsWith('--unmark=')) opts.unmark = a.slice('--unmark='.length);
    // 不以 - 开头的 positional · 全部收集到 opts.positional 数组 (给 ping/send/inbox 等用)
    // 同时第一个看着像文件路径的设到 opts.draftFile (push <file> 兼容)
    else if (!a.startsWith('-')) {
      if (!opts.positional) opts.positional = [];
      opts.positional.push(a);
      if (!opts.draftFile && (fs.existsSync(a) || /\.md$/i.test(a))) opts.draftFile = a;
    }
  }
  return opts;
}

// =============================================
// main
// =============================================
// `tinker state` · 给 AI agent 读 prompt-state.json 当前快照
// 看 mute/cooldown/dismissed/uiSession 状态 · 决定要不要 prompt
function cmdState(opts = {}) {
  const state = loadPromptState();
  const now = Date.now();
  // v0.13: laterUntilByReason 替代老 laterUntil · per-reason 延后状态
  const laterByReason = state.laterUntilByReason || {};
  const activeLaterByReason = Object.fromEntries(
    Object.entries(laterByReason).filter(([_, until]) => until > now)
  );
  const summary = {
    ok: true,
    now,
    muted: state.mutedUntil && state.mutedUntil > now
      ? { until: state.mutedUntil, remainingMs: state.mutedUntil - now }
      : null,
    laterByReason: Object.keys(activeLaterByReason).length > 0 ? activeLaterByReason : null,
    dismissedToday: state.dismissedTodayKey === todayKey(),
    lastPromptedAt: state.lastPromptedAt || null,
    cooldownActive: state.lastPromptedAt && (now - state.lastPromptedAt) < 30 * 60 * 1000,
    uiSession: state.uiSession || null,
    lastPushAtByProject: state.lastPushAtByProject || {},
  };
  if (opts.json) { outputJson(summary); return; }
  // 人类可读 fallback
  log('');
  log(sepia('  prompt 状态:'));
  log(sepia('    mute       ') + (summary.muted ? bold('到 ' + new Date(summary.muted.until).toLocaleString()) : sepia('(无)')));
  if (summary.laterByReason) {
    log(sepia('    later      ') + bold(Object.keys(summary.laterByReason).length + ' 类延后中:'));
    for (const [reason, until] of Object.entries(summary.laterByReason)) {
      log(sepia('      · ') + reason + sepia(' 到 ') + new Date(until).toLocaleString());
    }
  } else {
    log(sepia('    later      ') + sepia('(无)'));
  }
  log(sepia('    今日 skip  ') + (summary.dismissedToday ? bold('是') : sepia('否')));
  log(sepia('    冷却中     ') + (summary.cooldownActive ? bold('是 · 30min 内 prompt 过') : sepia('否')));
  log(sepia('    UI session ') + (summary.uiSession ? bold('进行中 · ' + summary.uiSession.commitCount + ' commits') : sepia('(无)')));
  log('');
}

// v0.12 触发器自检 · 让作者看见 Tinker 触发器系统的工作
// 三段:当前 commit 信号 / state 拦截原因 / 今日累计胜出分布
// 解决"我 commit 完了为什么没看到 prompt" 这个黑盒
function cmdTriggers(opts = {}) {
  const now = Date.now();
  const state = loadPromptState();

  // 收集结构化数据 (json 输出用 + 人类输出共用同一份)
  const data = {
    inGitRepo: inGitRepo(),
    cwd: process.cwd(),
    state: {
      muted: state.mutedUntil && state.mutedUntil > now
        ? { until: state.mutedUntil, remainingMs: state.mutedUntil - now } : null,
      laterByReason: (() => {
        const m = state.laterUntilByReason || {};
        const active = Object.fromEntries(Object.entries(m).filter(([_, u]) => u > now));
        return Object.keys(active).length > 0 ? active : null;
      })(),
      dismissedToday: state.dismissedTodayKey === todayKey(),
      cooldownActive: !!(state.lastPromptedAt && (now - state.lastPromptedAt) < 30 * 60 * 1000),
      cooldownRemainingMin: state.lastPromptedAt && (now - state.lastPromptedAt) < 30 * 60 * 1000
        ? Math.ceil((30 * 60 * 1000 - (now - state.lastPromptedAt)) / 60000) : 0,
    },
    commit: null,
    repoBound: false,
    fired: [],
    winner: null,
    wouldPrompt: false,
    blockReason: null,
    todayHits: null,
    triggerCount: 25,
  };

  if (data.inGitRepo) {
    try {
      const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
      const bodyLen = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim().length;
      let stat = null;
      try {
        const out = execSync('git diff HEAD~1 HEAD --shortstat 2>/dev/null', { encoding: 'utf-8' }).trim();
        const im = out.match(/(\d+) insertion/);
        const dm = out.match(/(\d+) deletion/);
        const fm = out.match(/(\d+) files? changed/);
        stat = { files: fm ? +fm[1] : 0, ins: im ? +im[1] : 0, del: dm ? +dm[1] : 0 };
      } catch {}
      data.commit = { title, bodyLen, stat };
    } catch {}

    const repoCfg = loadRepoConfig();
    if (repoCfg) {
      data.repoBound = true;
      data.project = { id: repoCfg.projectId, name: repoCfg.projectName };
      const cfgForUi = (() => { try { return mustHaveConfig({ requireToken: false }); } catch { return null; } })();
      const { winner, allFired } = evaluateAllTriggersDetailed(state, repoCfg, cfgForUi);
      data.fired = allFired.map(r => ({
        kind: r.kind || r.reason || null,
        reason: r.reason || null,
        priority: r.priority,
        msg: stripAnsi(r.msg || ''),
      }));
      if (winner) {
        data.winner = {
          kind: winner.kind || winner.reason || null,
          priority: winner.priority,
          msg: stripAnsi(winner.msg || ''),
        };
        const blockedByMute = data.state.muted;
        const blockedByLater = data.state.later;
        const blockedByDismissed = data.state.dismissedToday;
        const blockedByCooldown = data.state.cooldownActive && winner.priority < 100;
        if (blockedByMute) data.blockReason = '静音中';
        else if (blockedByLater) data.blockReason = '延后中';
        else if (blockedByDismissed) data.blockReason = '今日已 skip';
        else if (blockedByCooldown) data.blockReason = '冷却内 + priority < 100';
        data.wouldPrompt = !data.blockReason;
      }
    }
  }

  // 今日累计 (跨天清零的 state.todayTriggerHits)
  const tk = todayKey();
  if (state.todayTriggerHits && state.todayTriggerHits.date === tk) {
    const ws = state.todayTriggerHits.winners || {};
    const kinds = Object.keys(ws).sort((a, b) => ws[b].count - ws[a].count);
    data.todayHits = kinds.map(k => ({ kind: k, count: ws[k].count, suppressed: ws[k].suppressed }));
  }

  if (opts.json) { outputJson(data); return; }

  // 人类可读
  log('');
  log(bold('Tinker 触发器自检'));
  log('');

  // state
  log(sepia('state:'));
  log(sepia('  静音:    ') + (data.state.muted ? bold('是 · 到 ' + new Date(data.state.muted.until).toLocaleString()) : sepia('否')));
  log(sepia('  延后:    ') + (data.state.later ? bold('是 · 到 ' + new Date(data.state.later.until).toLocaleString()) : sepia('否')));
  log(sepia('  今日 skip:') + (data.state.dismissedToday ? bold(' 是 · 明天再问') : sepia(' 否')));
  if (data.state.cooldownActive) {
    log(sepia('  冷却:    ') + bold('是 · 还剩 ' + data.state.cooldownRemainingMin + ' 分钟') + sepia(' · priority < 100 不 prompt'));
  } else {
    log(sepia('  冷却:    ') + sepia('否'));
  }
  log('');

  // commit
  if (!data.inGitRepo) {
    log(sepia('  ⚠ 不在 git 仓库 · 触发器扫描跳过'));
  } else if (data.commit) {
    log(sepia('当前 commit: ') + bold(data.commit.title.slice(0, 80)));
    const statStr = data.commit.stat
      ? `${data.commit.stat.files} 文件 / +${data.commit.stat.ins} / -${data.commit.stat.del}`
      : '(无 diff)';
    log(sepia('  body ') + bold(data.commit.bodyLen + ' 字') + sepia(' · diff ') + bold(statStr));
    log('');
  }

  // 触发器扫描
  if (!data.repoBound) {
    log(sepia('  ⚠ 这个 repo 没绑定 Tinker 项目 · 跑 ') + vermilion('tinker hook install') + sepia(' 才能用'));
  } else {
    log(sepia('触发器扫描 (24 个):'));
    if (data.fired.length === 0) {
      log(sepia('  全部没命中 · 安静'));
    } else {
      data.fired.forEach(r => {
        const label = (r.kind || r.reason || '?').padEnd(28);
        log('  ' + vermilion('✓') + ' ' + label + sepia('priority ' + r.priority));
      });
      const notFired = data.triggerCount - data.fired.length;
      if (notFired > 0) log(sepia('  其他 ' + notFired + ' 个没命中'));
      log('');
      if (data.winner) {
        log(sepia('胜出: ') + bold(data.winner.kind) + sepia(' (priority ' + data.winner.priority + ')'));
        if (data.wouldPrompt) {
          log(sepia('  ') + vermilion('→') + bold(' 会 prompt'));
        } else {
          log(sepia('  ') + sepia('被拦: ') + bold(data.blockReason));
        }
      }
    }
  }

  // 今日累计
  if (data.todayHits && data.todayHits.length > 0) {
    log('');
    log(sepia('今天累计 (04:00 起):'));
    data.todayHits.forEach(h => {
      const supStr = h.suppressed > 0 ? sepia(' (' + h.suppressed + ' 次被冷却拦)') : '';
      log(sepia('  ') + h.kind.padEnd(28) + bold(h.count + ' 次胜出') + supStr);
    });
  }
  log('');
}

// v0.14 通用 action 逃生口 · server 是单一可变面 POST /api/action
// AI 能直调任何还没被包装成专门命令的 action · 也省得每加一个 action 都写一遍 CLI
// 注意:这条绕过 voice 守门和幂等封装 · 写内容类(addUpdate/shipProject 等)仍走 tinker push/ship
// 逃生口给的是"平台其余能力"的直通车 · 不是内容发布的正门
async function cmdAction(type, opts = {}) {
  if (!type || type.startsWith('--')) {
    const m = '用法: tinker action <type> [--payload \'{"k":"v"}\'] [--file <json|-> ] [--dry-run]';
    if (opts.json) errJson(m, 'USAGE');
    err(m);
    log(sepia('  action 类型看 ') + vermilion('docs/02-api.md') + sepia(' 或平台文档 · 内容发布请用 ') + vermilion('tinker push / ship'));
    process.exit(1);
  }

  // payload 来源优先级:--payload '<json>' > --file <path|-(stdin)> > 空对象
  // 输入校验 + dry-run 都不需要登录 · 真发才要 config (放最后)
  let raw = null;
  if (opts.payload != null) raw = opts.payload;
  else if (opts.file) {
    try { raw = fs.readFileSync(opts.file === '-' ? 0 : opts.file, 'utf-8'); }
    catch (e) {
      const m = '读 payload 文件失败: ' + e.message;
      if (opts.json) errJson(m, 'BAD_FILE'); else { err(m); process.exit(1); }
    }
  }
  let payload = {};
  if (raw != null && String(raw).trim() !== '') {
    try { payload = JSON.parse(raw); }
    catch (e) {
      const m = 'payload 不是合法 JSON: ' + e.message;
      if (opts.json) errJson(m, 'BAD_JSON'); else { err(m); process.exit(1); }
    }
  }

  if (opts.dryRun) {
    if (opts.json) { outputJson({ ok: true, dryRun: true, type, payload }); return; }
    log('');
    log(sepia('  dry-run · 不会发送'));
    log('  type:    ' + bold(type));
    log('  payload: ' + JSON.stringify(payload));
    log('');
    return;
  }

  const cfg = mustHaveConfig();
  try {
    const result = await apiAction(cfg, type, payload);
    if (opts.json) { outputJson({ ok: true, type, result }); return; }
    ok('action ' + bold(type) + ' 已发');
    if (result !== undefined) log(sepia('  ← ') + JSON.stringify(result));
  } catch (e) {
    if (opts.json) errJson(e.message, 'ACTION_FAILED', { type });
    err(e.message);
    process.exit(1);
  }
}

// `tinker schema --json` · 给 AI agent 一次拿到完整 CLI 能力地图
// 不需要解析 help 文本 · 不会因为 --help 改文案而变
function cmdSchema(opts = {}) {
  const schema = {
    ok: true,
    version: '0.8',
    commands: [
      { name: 'check', purpose: '评估触发器 · 看现在该不该 prompt', args: [
        { flag: '--json', purpose: '结构化输出 · pending 写盘' },
        { flag: '--from-hook', purpose: '标记 hook 调用 · 静默非命中' },
      ], jsonOutput: true, example: 'tinker check --json' },
      { name: 'resolve', purpose: '响应 check 返的 pending · 执行动作', args: [
        { arg: '<choice>', purpose: '从 check 返的 choices 里挑一个 id' },
        { flag: '-m / --message', purpose: '文本动作必填: push / ship / stuck 等' },
      ], jsonOutput: false, example: 'tinker resolve push -m "..."' },
      { name: 'projects', alias: 'ls', purpose: '列我的所有项目 (含 id/slug/status)', args: [
        { flag: '--json', purpose: '结构化数组' },
      ], jsonOutput: true, example: 'tinker projects --json' },
      { name: 'config', purpose: '看当前 server/handle/token/llm 配置', args: [
        { flag: '--json', purpose: '结构化 · token 只露后 4 位' },
      ], jsonOutput: true, example: 'tinker config --json' },
      { name: 'state', purpose: '读 prompt-state.json (mute/cooldown/uiSession 等)', args: [
        { flag: '--json', purpose: '结构化' },
      ], jsonOutput: true, example: 'tinker state --json' },
      { name: 'triggers', purpose: '触发器自检 · 当前 commit 上 24 个触发器命中情况 + state 拦截原因 + 今日累计', args: [
        { flag: '--json', purpose: '结构化' },
      ], jsonOutput: true, example: 'tinker triggers' },
      { name: 'struggle', purpose: '看 / 关 / 重新开启踩坑跟踪状态机 (透明 + 信任建设)', args: [
        { arg: 'status | off | on', purpose: '默认 status · off 关 24h · on 重新开启' },
        { flag: '--json', purpose: '结构化' },
      ], jsonOutput: true, example: 'tinker struggle' },
      { name: 'session', purpose: '看 / 强制结束 UI session', args: [
        { arg: 'status | end', purpose: 'status 看 · end 标结束' },
        { flag: '--json', purpose: '结构化' },
      ], jsonOutput: true, example: 'tinker session status --json' },
      { name: 'llm', purpose: '看 / 设 / 清 LLM 配置 · 看 token 用量', args: [
        { arg: 'set | status | off | usage', purpose: '子命令' },
        { flag: '--json', purpose: '结构化' },
      ], jsonOutput: true, example: 'tinker llm usage --json' },
      { name: 'goodnight', alias: 'recap', purpose: '今日总结 (commits / Tinker push / 方法被借)', args: [
        { flag: '--json', purpose: '结构化' },
        { flag: '--narrate', purpose: '让 LLM 朋友式说一句' },
      ], jsonOutput: true, example: 'tinker goodnight --json' },
      { name: 'push', purpose: '记一笔进展 · 直接 / 从草稿文件 / experience 单篇都支持', args: [
        { flag: '-m / --message', purpose: '内容' },
        { flag: '-p / --project', purpose: '指定项目 id (不指定时自动选唯一一个)' },
        { arg: '<file.md>', purpose: '从草稿文件发布 (含 autopsy 生成的 experience 草稿)' },
        { flag: '--as-experience', purpose: '把这条标为踩坑经验 (发完自动 markAsExperience)' },
        { flag: '--yes / -y', purpose: '跳过确认 (autopsy 草稿一键发用)' },
        { flag: '--dry-run', purpose: '只回显会发到哪个项目/内容/voice 打分 · 不真发 (配 --json 拿结构化预览)' },
      ], jsonOutput: false, example: 'tinker push -m "..." --dry-run --json' },
      { name: 'ship', purpose: '完工仪式 · 进陈列馆', args: [
        { flag: '-m / --message', purpose: '感想' },
        { flag: '-p / --project', purpose: '项目 id' },
        { flag: '--image <path>', purpose: '本地图当封面' },
        { flag: '--no-screenshot', purpose: '不带封面' },
        { flag: '--dry-run', purpose: '只回显项目/感想/封面来源/求反馈 · 不改状态不抓截图不进陈列馆' },
      ], jsonOutput: false, example: 'tinker ship -m "..." --dry-run --json' },
      { name: 'stuck', purpose: '标卡住 + 写"卡在哪" + 通知关心你的人', args: [
        { flag: '-m / --message', purpose: '卡在哪' },
      ], jsonOutput: false, example: 'tinker stuck -m "..."' },
      { name: 'draft', purpose: 'LLM 看 git 历史起草 1-3 条候选', args: [
        { flag: '--since', purpose: '时间窗 · 默认 1h' },
      ], jsonOutput: false, example: 'tinker draft --since 2h' },
      { name: 'mute', purpose: '静音/解除触发器', args: [
        { arg: 'Nm | Nh | Nd | today | forever | off', purpose: '时长' },
      ], jsonOutput: false, example: 'tinker mute today' },
      { name: 'hook', purpose: '装 / 卸 git hook + AI 工具集成', args: [
        { arg: 'install | uninstall', purpose: 'git post-commit 触发器 (工具无关)' },
        { arg: 'install-claude | uninstall-claude', purpose: 'Claude Code hook (逐条注入提醒)' },
        { arg: 'install-codex | uninstall-codex', purpose: 'Codex 等读 AGENTS.md 的 agent (写 AGENTS.md 指令)' },
      ], jsonOutput: false, example: 'tinker hook install-codex' },
      { name: 'skills', purpose: '装 Tinker Skills 进 AI · 一域一个 · 按场景自动加载 (比整块 CLAUDE.md 省 context)', args: [
        { arg: 'list | install', purpose: 'list 看有哪些技能 · install 拷进 skills 目录' },
        { flag: '--agent claude|codex', purpose: '默认 claude (.claude/skills)；codex 使用 .agents/skills' },
        { flag: '--only <name>', purpose: '只安装指定技能，复制完整配套目录' },
        { flag: '--local', purpose: '只装当前 repo；默认装到本人主目录' },
        { flag: '--json', purpose: '结构化' },
      ], jsonOutput: true, example: 'tinker skills install' },
      { name: 'voice', purpose: 'voice fingerprint 系统', args: [
        { arg: 'analyze | teach', purpose: 'analyze 从 pool 生成 fingerprint · teach 手动喂样本' },
      ], jsonOutput: false, example: 'tinker voice analyze' },
      { name: 'update', purpose: '拉最新代码 + 重装 CLI', args: [
        { flag: '--check-only', purpose: '只刷新 cache 不真升级' },
      ], jsonOutput: false, example: 'tinker update' },
      { name: 'login', purpose: '配置 server / handle / token / LLM (交互)', args: [], jsonOutput: false, example: 'tinker login' },
      { name: 'borrow', purpose: '搜方法 + 踩坑经验 + 上手指南 (任意人的 update · is_method / is_experience / is_learning 优先)', args: [
        { arg: '<关键词>', purpose: '查询词 · 可中英混杂 · 1-200 字' },
        { flag: '--methods-only', purpose: '只看作者标方法的' },
        { flag: '--kind method|experience|learning', purpose: '过滤 · experience 只搜踩坑经验 · learning 只搜上手指南' },
        { flag: '--limit N', purpose: '返回条数 · 默认 10 · 上限 50' },
        { flag: '--json', purpose: 'machine-readable 输出' },
      ], jsonOutput: true, example: 'tinker borrow "supabase realtime" --kind learning' },
      { name: 'mark-experience', alias: 'mark-exp', purpose: '把自己一条 update 标为踩坑经验 (给 AI 检索时优先取)', args: [
        { arg: '<updateId>', purpose: '不传默认拿最近一条 push' },
        { flag: '--unmark <updateId>', purpose: '取消经验标' },
        { flag: '--json', purpose: 'machine-readable 输出' },
      ], jsonOutput: true, example: 'tinker mark-experience u-xxx' },
      { name: 'mark-learning', alias: 'mark-learn', purpose: '把自己一条 update 标为上手指南 (给 AI 检索入门新技术用)', args: [
        { arg: '<updateId>', purpose: '不传默认拿最近一条 push' },
        { flag: '--unmark <updateId>', purpose: '取消上手指南标' },
        { flag: '--json', purpose: 'machine-readable 输出' },
      ], jsonOutput: true, example: 'tinker mark-learning u-xxx' },
      { name: 'contribute', purpose: '标方法 · 现有 update 升格 / 或从 markdown 文件按段批量发', args: [
        { arg: '<updateId>', purpose: '不传默认拿最近一条 push' },
        { flag: '--unmark <updateId>', purpose: '取消方法标' },
        { flag: '--from-file <path.md>', purpose: '按 H1/H2/H3 切段交互选 · 隐私扫描 · 每段一条 update + 自动标方法' },
        { flag: '--auto', purpose: '配合 --from-file · 让 LLM 看完整篇推荐 3 段最值得分享的 · 跳过手动勾' },
        { flag: '--section "<标题>"', purpose: '配合 --from-file · 直接选指定段 (可多次)' },
        { flag: '--project <slug>', purpose: '配合 --from-file · 指定项目 (否则当前 repo 绑定 / 交互选)' },
        { flag: '--json', purpose: 'machine-readable 输出' },
      ], jsonOutput: true, example: 'tinker contribute --from-file docs/08.md --section "能力地图"' },
      { name: 'stream', purpose: 'NDJSON 事件流 · 任何 AI 通过 stdout 都能订阅', args: [
        { arg: '<resource>', purpose: 'triggers / today' },
        { flag: '--once', purpose: '打完当前 snapshot 就退 · 不长跑' },
      ], jsonOutput: true, example: 'tinker stream triggers' },
      { name: 'action', purpose: '通用逃生口 · 直调 server 单一可变面 POST /api/action · 用于还没被包装成专门命令的 action · 绕过 voice 守门/幂等 · 内容发布(update/ship)仍走 push/ship', args: [
        { arg: '<type>', purpose: 'action 类型 (见平台 API 文档 docs/02-api.md)' },
        { flag: "--payload '<json>'", purpose: 'action 参数 · 合法 JSON · 默认空对象' },
        { flag: '--file <path|->', purpose: '从文件或 stdin(-) 读 payload JSON' },
        { flag: '--dry-run', purpose: '只回显 type+payload 不发送 · 发前预览' },
        { flag: '--json', purpose: '结构化 · 返回 { ok, type, result }' },
      ], jsonOutput: true, example: 'tinker action reactToProject --payload \'{"projectId":"p-123"}\' --json' },
      { name: 'note-done', purpose: '把你项目下的便签标成"处理了" (toggle) · 便签作者收到回响 · 无参列待处理', args: [
        { arg: '[编号|noteId]', purpose: '无参列待处理便签 · 给编号或 n- 开头的 id 标处理' },
        { flag: '--json', purpose: 'machine-readable 输出' },
      ], jsonOutput: true, example: 'tinker note-done 1' },
      { name: 'stash', purpose: '跨设备暂存现场 (给自己) · push 当前仓库未提交改动+卡点到 server · 另一台机器 pop 还原 · 不靠工作室', args: [
        { arg: 'push | list | pop [id] | apply [id] | drop <id> | key <口令>', purpose: 'push 存 · pop 还原即删 · apply 还原留着 · key 设端到端加密口令' },
        { flag: '-m / --message', purpose: 'push 时给现场一句话标签' },
        { flag: '--encrypt / --plain', purpose: '单次覆盖加密 (默认明文 · 设了 key 默认加密)' },
        { flag: '--json', purpose: 'machine-readable 输出' },
      ], jsonOutput: true, example: 'tinker stash push -m "登录重构做一半"' },
    ],
    pendingFile: path.join(CONFIG_DIR, 'pending.json'),
    promptStateFile: path.join(CONFIG_DIR, 'prompt-state.json'),
    configFile: CONFIG_FILE,
    notes: [
      'AI agent 工作流: 1) tinker check --json 看是否命中 · 2) 若命中读 pending · 3) tinker resolve <choice> -m "text" 执行',
      'AI 也可绕开触发器直接 push / ship / stuck (需要 -m 和 -p)',
      'json 模式下错误也走 JSON: { ok: false, error, code, exitCode: 1 }',
    ],
  };
  if (opts.json) { outputJson(schema); return; }
  // 人类可读 fallback (压缩版)
  log('');
  log(sepia('  CLI 命令清单 (用 ') + vermilion('--json') + sepia(' 拿结构化):'));
  schema.commands.forEach(c => {
    log(sepia('    ') + bold(c.name.padEnd(12)) + sepia(' ' + c.purpose));
  });
  log('');
}

// v0.14 团队命令拆到 lib/team-commands.js · 依赖注入工厂 · 放这里保证上面所有 helper 都已定义
// 同名解构回填 · switch 和其它函数里对 cmdStudio/cmdPing/... 的调用一个字都不用改
const __team = require('../lib/team-commands')({
  CONFIG_DIR, log, bold, vermilion, sepia, err, ok, outputJson,
  loadConfig, mustHaveConfig, safeFetchJson, apiState, apiAction,
  recordLLMUsage, loadRepoConfig, loadAutoPingConfig, saveAutoPingConfig,
  gateVoiceCheck, promptKit, ensureNotifyDaemon, help,
});
const {
  cmdBridgeAutoPing, cmdStudio, sha256Hex, stripAnsi, appendOutbox, cmdOutbox,
  cmdBridgeFailed, cmdBridgeRetry, cmdPing, cmdSend, uploadHandoffBlob, fetchHandoffBlob,
  sendHandoffReceipt, cmdHandoff, cmdHandoffReply, cmdInbox, ensureBlobFetched,
  cmdInboxFetch, cmdInboxVerify, cmdBridgeCheckInbox, pullBridgeMessagesForHook,
  cmdTeamKnowledge, cmdWitness, cmdWitnessDraft, packClaudeTranscript, cmdWitnessPublish,
  cmdWitnessReply, cmdWitnessClose, cmdWitnessSelf, cmdTeamKnowledgePublish,
} = __team;

// ============ 待办 (v1.x · 私密协作层) ============
// personal 只自己见 · team 工作室成员互见 · 都不进公开 feed
// 服务端 action:addTodo / toggleTodo / deleteTodo / assignTodo / promoteTodo · 列表读 state.todos
function todoResolveStudioId(state, cfg, slug) {
  const all = state.studios || [];
  if (slug) {
    const s = all.find(x => x.slug === slug);
    if (!s) { err('没找到工作室 ' + slug + ' · tinker studio list 看有哪些'); process.exit(1); }
    return s.id;
  }
  const mine = (state.users && state.users[cfg.handle] && state.users[cfg.handle].studios) || [];
  if (mine.length === 1) { const m = all.find(x => x.slug === mine[0].slug); if (m) return m.id; }
  if (mine.length === 0) { err('你还不在任何工作室 · 团队待办得先进一个'); process.exit(1); }
  err('你在多个工作室 · 用 --studio <slug> 指定放哪个'); process.exit(1);
}
function todoFind(state, partial) {
  if (!partial) { err('要指定待办 id(tinker todo list 看)'); process.exit(1); }
  const ts = state.todos || [];
  const exact = ts.find(t => t.id === partial);
  if (exact) return exact;
  // 待办 id 是 UUIDv7(时间戳打头)· 区分度在尾部 · 按后缀匹配(list 显示的就是后 6 位)
  const hit = ts.filter(t => t.id.endsWith(partial));
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) { err('id ' + partial + ' 匹配到多条 · 写全一点'); process.exit(1); }
  err('没找到待办 ' + partial + ' · tinker todo list 看'); process.exit(1);
}
function todoShortId(id) { return id.slice(-6); }

async function cmdTodo(args, opts) {
  const cfg = mustHaveConfig();
  const sub = args[1] || 'list';
  if (sub === 'list' || sub === 'ls') return todoList(cfg, opts);
  if (sub === 'sync') return cmdTodoSync(cfg, opts);
  // 改动类子命令 · 跑完后台自动同步飞书(没连飞书则跳过)
  if (sub === 'add' || sub === 'a') await todoAdd(cfg, args, opts);
  else if (sub === 'done' || sub === 'x') await todoToggle(cfg, args[2], opts, !opts.undo);
  else if (sub === 'reopen') await todoToggle(cfg, args[2], opts, false);
  else if (sub === 'rm' || sub === 'del') await todoRm(cfg, args[2], opts);
  else if (sub === 'assign') await todoAssign(cfg, args[2], opts);
  else if (sub === 'promote') await todoPromote(cfg, args[2], opts);
  else { err('未知子命令: ' + sub + ' · 用 list / add / done / reopen / rm / assign / promote / sync'); process.exit(1); }
  feishuMaybeSyncAsync();
}

async function todoList(cfg, opts) {
  // 联网优先 · 连不上就回退本地缓存(离线也能看待办)
  let ts, offline = false, cachedAt = null;
  try {
    const state = await apiState(cfg);
    ts = state.todos || [];
  } catch (e) {
    const cache = loadTodosCache();
    if (!cache) { if (opts.json) return errJson(e.message, 'TODO_LIST_FAILED'); err(e.message); process.exit(1); }
    ts = cache.todos; offline = true; cachedAt = cache.at;
  }
  if (opts.json) return outputJson({ ok: true, todos: ts, offline, cachedAt: cachedAt || undefined });
  if (offline) log(sepia('  · 离线 · 显示 ' + agoZh(cachedAt) + '的缓存 · 连上后自动更新'));
  if (ts.length === 0) { log(sepia('  还没有待办 · tinker todo add "买菜" 记一条')); return; }
  for (const [label, list] of [['个人', ts.filter(t => t.scope === 'personal')], ['团队', ts.filter(t => t.scope === 'team')]]) {
    if (!list.length) continue;
    log(''); log(bold(label + ' (' + list.filter(t => !t.done).length + ' 待办)'));
    const open = list.filter(t => !t.done), done = list.filter(t => t.done);
    for (const t of [...open, ...done]) {
      const box = t.done ? moss('[✓]') : '[ ]';
      const who = t.scope === 'team' ? sepia(' @' + (t.assignee || '待认领')) : '';
      const due = t.due ? sepia(' · 截 ' + t.due) : '';
      log('  ' + box + ' ' + sepia(todoShortId(t.id)) + '  ' + (t.done ? sepia(t.text) : t.text) + who + due);
    }
  }
  log('');
}

async function todoAdd(cfg, args, opts) {
  let text = opts.text;
  if (!text) { const pos = []; for (let i = 2; i < args.length; i++) { if (args[i].startsWith('-')) break; pos.push(args[i]); } text = pos.join(' '); }
  text = (text || '').trim();
  if (!text) { err('待办内容不能空 · tinker todo add "买菜" 或 -m "买菜"'); process.exit(1); }
  const team = !!opts.team || !!opts.studio;
  // 派给别人必须是团队任务 · 否则 handle 会被静默吞掉 · 队友永远收不到(也不会有飞书播报)
  if (opts.toHandle && !team) {
    err('派给别人得是团队任务 · 加 --team(或 --studio <名>) · 例: ' + vermilion('tinker todo add "…" --team -t @' + opts.toHandle));
    process.exit(1);
  }
  const payload = { scope: team ? 'team' : 'personal', text, due: opts.due || null };
  if (team) {
    const state = await apiState(cfg);
    payload.studioId = todoResolveStudioId(state, cfg, opts.studio);
    if (opts.toHandle) payload.assigneeHandle = opts.toHandle;
  }
  try {
    const r = await apiAction(cfg, 'addTodo', payload);
    if (team && payload.assigneeHandle) feishuNotifyAssignAsync(cfg, payload.assigneeHandle, text, opts.due);
    if (opts.json) return outputJson({ ok: true, todoId: r.result?.id });
    log(moss('  记下了 · ') + sepia(team ? '团队 ' : '个人 ') + text + (payload.assigneeHandle ? sepia(' → @' + payload.assigneeHandle) : '') + (opts.due ? sepia(' · 截 ' + opts.due) : ''));
  } catch (e) { if (opts.json) return errJson(e.message, 'TODO_ADD_FAILED'); err(e.message); process.exit(1); }
}

async function todoToggle(cfg, partial, opts, done) {
  const t = todoFind(await apiState(cfg), partial);
  try {
    await apiAction(cfg, 'toggleTodo', { todoId: t.id, done });
    if (opts.json) return outputJson({ ok: true });
    log(moss(done ? '  勾掉了 · ' : '  重开 · ') + t.text);
  } catch (e) { if (opts.json) return errJson(e.message, 'TODO_TOGGLE_FAILED'); err(e.message); process.exit(1); }
}

async function todoRm(cfg, partial, opts) {
  const t = todoFind(await apiState(cfg), partial);
  try {
    await apiAction(cfg, 'deleteTodo', { todoId: t.id });
    if (opts.json) return outputJson({ ok: true });
    log(sepia('  删了 · ') + t.text);
  } catch (e) { if (opts.json) return errJson(e.message, 'TODO_RM_FAILED'); err(e.message); process.exit(1); }
}

async function todoAssign(cfg, partial, opts) {
  if (!opts.toHandle) { err('派给谁?用 -t @handle'); process.exit(1); }
  const t = todoFind(await apiState(cfg), partial);
  try {
    await apiAction(cfg, 'assignTodo', { todoId: t.id, assigneeHandle: opts.toHandle });
    feishuNotifyAssignAsync(cfg, opts.toHandle, t.text, t.due);
    if (opts.json) return outputJson({ ok: true });
    log(moss('  派给 @' + opts.toHandle + ' · ') + t.text);
  } catch (e) { if (opts.json) return errJson(e.message, 'TODO_ASSIGN_FAILED'); err(e.message); process.exit(1); }
}

async function todoPromote(cfg, partial, opts) {
  const state = await apiState(cfg);
  const t = todoFind(state, partial);
  const studioId = todoResolveStudioId(state, cfg, opts.studio);
  try {
    await apiAction(cfg, 'promoteTodo', { todoId: t.id, studioId, assigneeHandle: opts.toHandle || undefined });
    if (opts.toHandle) feishuNotifyAssignAsync(cfg, opts.toHandle, t.text, t.due);
    if (opts.json) return outputJson({ ok: true });
    log(moss('  同步成团队任务 · ') + t.text);
  } catch (e) { if (opts.json) return errJson(e.message, 'TODO_PROMOTE_FAILED'); err(e.message); process.exit(1); }
}

// ============ 飞书同步 (待办 → 飞书任务 · 双向) ============
// 令牌 ~/.tinker/feishu-token.json(app_id/app_secret/access/refresh)· 映射 ~/.tinker/feishu-sync.json
// 生产化踩过的坑(见记忆 project_tinker_feishu_todo):
//  · 建完任务必须 add_members 把 owner 加成 assignee · 否则裸任务隐形(list 返 0 · 不推送)
//  · 完成状态走 PATCH completed_at(设时间戳=完成 / "0"=取消)· 没有 /complete 端点
//  · 提醒内联 reminders 字段建任务时一起给 · 单独 /reminders 接口 404
//  · 要落到本人列表 + 推送本人必须 user_access_token · refresh 要 scope 带 offline_access
const FEISHU_TOKEN_FILE = path.join(CONFIG_DIR, 'feishu-token.json');
const FEISHU_SYNC_FILE = path.join(CONFIG_DIR, 'feishu-sync.json');
const FEISHU_NOTIFY_LOG = path.join(CONFIG_DIR, 'feishu-notify.log');   // 派任务播报的成败留痕 · 别再当哑炮
const FEISHU_BASE = 'https://open.feishu.cn';

function feishuLoadToken() { try { return JSON.parse(fs.readFileSync(FEISHU_TOKEN_FILE, 'utf-8')); } catch (e) { return null; } }
function feishuSaveToken(t) { fs.writeFileSync(FEISHU_TOKEN_FILE, JSON.stringify(t, null, 2)); try { fs.chmodSync(FEISHU_TOKEN_FILE, 0o600); } catch (e) {} }
function feishuLoadSync() { try { return JSON.parse(fs.readFileSync(FEISHU_SYNC_FILE, 'utf-8')); } catch (e) { return { map: {} }; } }
function feishuSaveSync(s) { fs.writeFileSync(FEISHU_SYNC_FILE, JSON.stringify(s, null, 2)); }
function feishuDueTs(dueStr) { return new Date(dueStr + 'T09:00:00+08:00').getTime(); } // 截止日 → 北京 9 点
const FEISHU_SYNC_LOCK = path.join(CONFIG_DIR, 'feishu-sync.lock');

// 待办改动后 · 后台甩一个同步 · detached 不阻塞命令 · 没连飞书直接跳过
function feishuMaybeSyncAsync() {
  if (!fs.existsSync(FEISHU_TOKEN_FILE)) return; // 没连飞书 · 不同步
  try {
    const child = spawn(process.execPath, [__filename, 'todo', 'sync', '--quiet'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) { /* 后台同步失败不影响主命令 */ }
}

// 团队任务派给别人时 · 往飞书通知群甩一条"@谁 接了个新任务"
// 我自己的待办同步进我自己的飞书任务(feishuMaybeSyncAsync)· 但派给队友的落不到队友飞书
// 所以走通知群补这个缺口 · 后台 detached · 复用 tinker feishu notify(应用级 token · 不需队友连飞书)
function feishuNotifyAssignAsync(cfg, handle, text, due) {
  const flog = (s) => { try { fs.appendFileSync(FEISHU_NOTIFY_LOG, '[' + new Date().toISOString() + '] ' + s + '\n'); } catch (e) {} };
  if (!handle || handle === cfg.handle) return;      // 派给自己不用广播
  if (!fs.existsSync(FEISHU_TOKEN_FILE)) { flog('跳过播报 · 没连飞书 · handle=' + handle); return; }
  try {
    const tok = feishuLoadToken() || {};
    if (!tok.notify_chat_id) { flog('跳过播报 · 没配通知群 notify_chat_id · handle=' + handle + ' · 用 tinker feishu set-chat 设一个'); return; }
    const msg = '📋 @' + handle + ' 接了个新任务:' + text + (due ? ' · 截 ' + due : '');
    // 子进程的成败(“已发到群”/报错)写进 feishu-notify.log · 失败不再无声无息
    let out; try { out = fs.openSync(FEISHU_NOTIFY_LOG, 'a'); } catch (e) { out = null; }
    const child = spawn(process.execPath, [__filename, 'feishu', 'notify', '-m', msg], { detached: true, stdio: out == null ? 'ignore' : ['ignore', out, out] });
    child.unref();
    flog('已触发播报 spawn · handle=' + handle + ' · ' + msg.slice(0, 60));
  } catch (e) { flog('播报异常 · handle=' + handle + ' · ' + (e && e.message)); }
}

// 拿守护进程主人自己的飞书 open_id + 名字 · 用来在群里真 @ 到本人(静音也戳得到)· 取一次缓存进 token
async function feishuOwnerIdentity() {
  const t = feishuLoadToken() || {};
  if (t.owner_open_id) return { openId: t.owner_open_id, name: t.owner_name || '你' };
  try {
    const tok = await feishuAccessToken();
    const who = await feishuApi(tok, 'GET', '/open-apis/authen/v1/user_info');
    const oid = who && who.data && who.data.open_id;
    if (oid) { feishuSaveToken({ ...(feishuLoadToken() || {}), owner_open_id: oid, owner_name: who.data.name || '' }); return { openId: oid, name: who.data.name || '你' }; }
  } catch (e) {}
  return null;
}

// 队友通过 bridge 发来消息时 · 也往飞书群推一条并 @ 到本人 · 免得对方还要人工喊"给你发消息了"
// 复用守护进程本来就有的近实时轮询(cmdNotifyDaemon)· 不另开进程 · detached spawn 复用 tinker feishu notify
async function feishuNotifyBridgeAsync(sum) {
  const flog = (s) => { try { fs.appendFileSync(FEISHU_NOTIFY_LOG, '[' + new Date().toISOString() + '] ' + s + '\n'); } catch (e) {} };
  try {
    if (!sum || !fs.existsSync(FEISHU_TOKEN_FILE)) return;
    const tok = feishuLoadToken() || {};
    if (!tok.notify_chat_id) return;                   // 没配通知群 · 静默跳过
    let at = '';
    const me = await feishuOwnerIdentity();
    if (me && me.openId) at = ' <at user_id="' + me.openId + '">' + me.name + '</at> 去查看';   // 真 @ · 静音群也戳得到
    const text = '🌉 ' + (sum.title || 'Tinker') + ' · ' + (sum.body || '发来一条消息') + at + ' · tinker inbox';
    let out; try { out = fs.openSync(FEISHU_NOTIFY_LOG, 'a'); } catch (e) { out = null; }
    const child = spawn(process.execPath, [__filename, 'feishu', 'notify', '-m', text], { detached: true, stdio: out == null ? 'ignore' : ['ignore', out, out] });
    child.unref();
    flog('bridge → 飞书 · ' + text.slice(0, 80));
  } catch (e) { flog('bridge飞书播报异常 · ' + (e && e.message)); }
}

// 拿有效 access token · 快过期(5 分钟内)就 refresh 续 · 续不动让用户重新 login
async function feishuAccessToken() {
  const t = feishuLoadToken();
  if (!t || !t.access_token) throw new Error('还没连飞书 · 跑 ' + vermilion('tinker feishu login'));
  if (t.expires_at && t.expires_at - Date.now() > 5 * 60 * 1000) return t.access_token;
  if (!t.refresh_token || !t.app_id || !t.app_secret) throw new Error('飞书令牌过期且无法自动续 · 重新跑 ' + vermilion('tinker feishu login'));
  let rf;
  try {
    rf = await fetch(FEISHU_BASE + '/open-apis/authen/v2/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: t.app_id, client_secret: t.app_secret, refresh_token: t.refresh_token }) }).then(r => r.json());
  } catch (e) { throw new Error('连不上飞书 · ' + e.message); }
  if (!rf.access_token) throw new Error('飞书刷新令牌失败(可能超 7 天没同步)· 重新跑 ' + vermilion('tinker feishu login') + ' · ' + (rf.error_description || rf.msg || ''));
  const now = Date.now();
  const updated = { ...t, access_token: rf.access_token, refresh_token: rf.refresh_token || t.refresh_token, expires_at: now + (rf.expires_in || 7200) * 1000, obtained_at: now };
  feishuSaveToken(updated);
  return updated.access_token;
}

async function feishuApi(token, method, apiPath, body) {
  let res;
  try { res = await fetch(FEISHU_BASE + apiPath, { method, headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new Error('连不上飞书 · ' + e.message); }
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error('飞书接口非 JSON 响应(' + res.status + ' ' + apiPath + '): ' + text.slice(0, 100)); }
  return j;
}

// tinker feishu <status|login>
async function cmdFeishu(args, opts) {
  const sub = args[1] || 'status';
  if (sub === 'status') {
    const t = feishuLoadToken();
    if (!t || !t.access_token) { log(sepia('  还没连飞书 · 跑 ') + vermilion('tinker feishu login')); return; }
    try {
      const tok = await feishuAccessToken();
      const who = await feishuApi(tok, 'GET', '/open-apis/authen/v1/user_info');
      const sync = feishuLoadSync();
      log(moss('  已连飞书 · ') + '身份 ' + (who.data && who.data.name) + ' · 映射 ' + Object.keys(sync.map || {}).length + ' 条 · 上次同步 ' + (sync.at ? agoZh(sync.at) : '从没'));
    } catch (e) { err(e.message); }
    return;
  }
  if (sub === 'login') return cmdFeishuLogin(opts);
  if (sub === 'chats') return cmdFeishuChats(opts);
  if (sub === 'set-chat') {
    const id = args[2];
    if (!id) { err('用法: tinker feishu set-chat <chat_id>(用 tinker feishu chats 看)'); process.exit(1); }
    feishuSaveToken({ ...(feishuLoadToken() || {}), notify_chat_id: id });
    ok('默认通知群设为 ' + id); return;
  }
  if (sub === 'notify') return cmdFeishuNotify(opts);
  err('用法: tinker feishu status | login | chats | set-chat <id> | notify -m "..." · 同步待办 tinker todo sync'); process.exit(1);
}

// 应用(机器人)令牌 · 发群消息用它(以机器人身份)· 跟 user token 分开
async function feishuTenantToken() {
  const t = feishuLoadToken();
  if (!t || !t.app_id || !t.app_secret) throw new Error('缺飞书应用凭证 · 跑 ' + vermilion('tinker feishu login'));
  const r = await fetch(FEISHU_BASE + '/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: t.app_id, app_secret: t.app_secret }) }).then(x => x.json());
  if (!r.tenant_access_token) throw new Error('拿飞书应用令牌失败 · ' + (r.msg || ''));
  return r.tenant_access_token;
}

// 列机器人所在的群 · 拿 chat_id
async function cmdFeishuChats(opts) {
  const tok = await feishuTenantToken();
  const l = await feishuApi(tok, 'GET', '/open-apis/im/v1/chats?page_size=50');
  const items = (l.data && l.data.items) || [];
  if (opts.json) return outputJson({ ok: true, chats: items.map(c => ({ chat_id: c.chat_id, name: c.name })) });
  if (!items.length) { log(sepia('  机器人不在任何群 · 先把机器人加进群')); return; }
  const saved = (feishuLoadToken() || {}).notify_chat_id;
  for (const c of items) log('  ' + (c.chat_id === saved ? moss('▸ ') : '  ') + (c.name || '(无名群)') + sepia(' · ' + c.chat_id));
}

// 往默认群发一条消息(机器人身份)· 供投喂脚本等外部调用
async function cmdFeishuNotify(opts) {
  const chatId = (feishuLoadToken() || {}).notify_chat_id;
  if (!chatId) { err('还没设通知群 · tinker feishu chats 看群 · tinker feishu set-chat <chat_id> 设一个'); process.exit(1); }
  if (!opts.text) { err('要发什么?tinker feishu notify -m "..."'); process.exit(1); }
  const tok = await feishuTenantToken();
  const r = await feishuApi(tok, 'POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: opts.text }) });
  if (r.code !== 0) { if (opts.json) return errJson(r.msg, 'FEISHU_NOTIFY_FAILED'); err('发群消息失败: ' + r.msg); process.exit(1); }
  if (opts.json) return outputJson({ ok: true });
  ok('已发到群 · ' + opts.text);
}

// OAuth 登录 · 起本地回调 · 换 user token(带 refresh)存本地
async function cmdFeishuLogin(opts) {
  const existing = feishuLoadToken() || {};
  const appId = opts.appId || existing.app_id;
  const appSecret = opts.appSecret || existing.app_secret;
  if (!appId || !appSecret) { err('要飞书应用凭证 · tinker feishu login --app-id <id> --app-secret <secret>'); process.exit(1); }
  const http = require('http');
  const REDIRECT = 'http://localhost:3000/callback';
  const SCOPES = 'task:task:write task:task:read offline_access';
  const authUrl = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=' + appId + '&redirect_uri=' + encodeURIComponent(REDIRECT) + '&response_type=code&scope=' + encodeURIComponent(SCOPES) + '&state=tinker';
  await new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://localhost:3000');
      if (u.pathname !== '/callback') { res.end('ok'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (u.searchParams.get('error')) { res.end('<h2>授权出错，回终端</h2>'); err('授权失败: ' + u.searchParams.get('error_description')); server.close(); return resolve(); }
      res.end('<h2>授权成功，回终端就行</h2>');
      const tk = await fetch(FEISHU_BASE + '/open-apis/authen/v2/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: appId, client_secret: appSecret, code: u.searchParams.get('code'), redirect_uri: REDIRECT }) }).then(r => r.json());
      if (!tk.access_token) { err('换令牌失败: ' + JSON.stringify(tk).slice(0, 200)); server.close(); return resolve(); }
      const now = Date.now();
      feishuSaveToken({ app_id: appId, app_secret: appSecret, access_token: tk.access_token, refresh_token: tk.refresh_token || null, expires_at: now + (tk.expires_in || 7200) * 1000, obtained_at: now });
      ok('飞书已连上 · 令牌存 ' + FEISHU_TOKEN_FILE);
      // 顺手把自己的飞书 open_id 注册到 server · 之后 server 发通知能 @ 到本人(产品级联动 · 登录一次即可)
      try {
        const me = await feishuOwnerIdentity();
        const cfg = loadConfig();
        if (me && me.openId && cfg && cfg.serverUrl && cfg.token) {
          await fetch(cfg.serverUrl + '/api/feishu/link', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ openId: me.openId, name: me.name }) }).then(r => r.json()).catch(() => {});
          log(sepia('  已注册飞书身份到 server · 队友发你消息会在群里 @ 你'));
        }
      } catch (e) { /* 注册失败不影响登录本身 */ }
      server.close(); resolve();
    });
    server.listen(3000, () => { log(sepia('  浏览器里点「授权」…')); try { execSync('open "' + authUrl + '"'); } catch (e) { log(sepia('  手动开: ' + authUrl)); } });
    setTimeout(() => { server.close(); resolve(); }, 300000);
  });
}

// tinker todo sync · 把"我的"待办双向同步到飞书任务
async function cmdTodoSync(cfg, opts) {
  // 取锁 · 防并发同步重复建(后台自动同步 + 手动同步可能撞)· 60s 内活锁就跳过
  try {
    if (fs.existsSync(FEISHU_SYNC_LOCK)) {
      const st = JSON.parse(fs.readFileSync(FEISHU_SYNC_LOCK, 'utf-8'));
      if (Date.now() - (st.at || 0) < 60000) {
        if (opts.json) return outputJson({ ok: true, skipped: 'another-sync-running' });
        if (!opts.quiet) log(sepia('  另一个同步在跑 · 跳过'));
        return;
      }
    }
    fs.writeFileSync(FEISHU_SYNC_LOCK, JSON.stringify({ at: Date.now(), pid: process.pid }));
  } catch (e) { /* 锁是尽力而为 */ }
  try {
  const token = await feishuAccessToken();
  const who = await feishuApi(token, 'GET', '/open-apis/authen/v1/user_info');
  const openId = who.data && who.data.open_id;
  if (!openId) throw new Error('拿飞书身份失败 · 重新 ' + vermilion('tinker feishu login'));
  const state = await apiState(cfg);
  const me = cfg.handle;
  const todos = (state.todos || []).filter(t =>
    (t.scope === 'personal' && (!t.owner || t.owner === me)) ||
    (t.scope === 'team' && t.assignee === me));
  const sync = feishuLoadSync();
  const map = sync.map || {};
  const stat = { created: 0, updated: 0, forwardDone: 0, forwardReopen: 0, reverseDone: 0, reverseReopen: 0, conflict: 0 };
  for (const todo of todos) {
    const link = map[todo.id];
    if (!link) {
      if (todo.done) continue; // 已完成的没建过 · 不补历史
      const body = { summary: todo.text };
      if (todo.due) { body.due = { timestamp: String(feishuDueTs(todo.due)), is_all_day: false }; body.reminders = [{ relative_fire_minute: 0 }]; }
      const cr = await feishuApi(token, 'POST', '/open-apis/task/v2/tasks', body);
      if (cr.code !== 0) { if (!opts.json) log(sepia('  建任务失败: ' + todo.text + ' · ' + cr.msg)); continue; }
      const guid = cr.data.task.guid;
      // 必须加执行者 · 否则任务隐形不推送
      await feishuApi(token, 'POST', '/open-apis/task/v2/tasks/' + guid + '/add_members?user_id_type=open_id', { members: [{ id: openId, type: 'user', role: 'assignee' }] });
      map[todo.id] = { guid, done: false, summary: todo.text, due: todo.due || null };
      stat.created++;
      continue;
    }
    const gr = await feishuApi(token, 'GET', '/open-apis/task/v2/tasks/' + link.guid);
    if (gr.code !== 0) { delete map[todo.id]; continue; } // 飞书那条没了 · 下轮重建
    const task = gr.data.task;
    const feishuDone = !!(task.completed_at && task.completed_at !== '0');
    const base = !!link.done;
    // 完成状态三方合并(base=上次同步态)
    let agreedDone = todo.done;
    if (todo.done !== feishuDone) {
      const tinkerChanged = todo.done !== base, feishuChanged = feishuDone !== base;
      if (feishuChanged && !tinkerChanged) {
        // 飞书那边勾/取消了 → 回写 Tinker
        await apiAction(cfg, 'toggleTodo', { todoId: todo.id, done: feishuDone });
        agreedDone = feishuDone;
        if (feishuDone) stat.reverseDone++; else stat.reverseReopen++;
      } else {
        // Tinker 改了(或都改了 · Tinker 赢)→ 推飞书
        await feishuApi(token, 'PATCH', '/open-apis/task/v2/tasks/' + link.guid, { task: { completed_at: todo.done ? String(Date.now()) : '0' }, update_fields: ['completed_at'] });
        agreedDone = todo.done;
        if (tinkerChanged && feishuChanged) stat.conflict++;
        else if (todo.done) stat.forwardDone++;
        else stat.forwardReopen++;
      }
    }
    // 文案 / 截止正向更新(飞书没编辑回传通道 · Tinker 为准)
    if (task.summary !== todo.text || (link.due || null) !== (todo.due || null)) {
      const upd = { task: { summary: todo.text }, update_fields: ['summary'] };
      if (todo.due) { upd.task.due = { timestamp: String(feishuDueTs(todo.due)), is_all_day: false }; upd.update_fields.push('due'); }
      await feishuApi(token, 'PATCH', '/open-apis/task/v2/tasks/' + link.guid, upd);
      stat.updated++;
    }
    map[todo.id] = { guid: link.guid, done: agreedDone, summary: todo.text, due: todo.due || null };
  }
  sync.map = map; sync.at = Date.now(); feishuSaveSync(sync);
  if (opts.json) return outputJson({ ok: true, ...stat });
  const bits = ['新建 ' + stat.created, '更新 ' + stat.updated, '完成 ' + (stat.forwardDone + stat.reverseDone), '重开 ' + (stat.forwardReopen + stat.reverseReopen)];
  if (stat.conflict) bits.push('冲突(Tinker 赢) ' + stat.conflict);
  if (!opts.quiet) log(moss('  飞书同步完成 · ') + bits.join(' · '));
  } finally {
    try { fs.unlinkSync(FEISHU_SYNC_LOCK); } catch (e) { /* 释放锁 */ }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = parseArgs(args.slice(1));
  // voice 守门挂载安全网 · 见 VOICE_PROFILE_REGISTRY
  // 命令吃了 -m 文字 + 没在表里声明 profile · 直接 stderr 报警 · 不让"忘挂"静默
  warnIfVoiceProfileMissing(cmd, opts);
  try {
    switch (cmd) {
      case 'login': await cmdLogin(opts); break;
      case 'onboard': await cmdOnboard(opts); break;
      case 'skills': await cmdSkills(args[1], opts); break;
      case 'config': await cmdConfig(opts); break;
      case 'screenshot': await cmdScreenshotConfig(opts); break;
      case 'projects': case 'ls': await cmdProjects(opts); break;
      case 'push': await cmdPush(opts); break;
      case 'stuck': await cmdStuck(opts); break;
      case 'ship': await cmdShip(opts); break;
      // v0.33 已上线产品状态管理
      case 'freeze': await cmdFreeze(opts); break;
      case 'relaunch': await cmdRelaunch(opts); break;
      // v0.34 改老 ship 感想 / 求反馈
      case 'edit-ship': await cmdEditShip(opts); break;
      case 'update': await cmdUpdate({ checkOnly: args.includes('--check-only') }); break;
      case 'draft': await cmdDraft(opts); break;
      case 'hook':
        if (args[1] === 'install') await cmdHookInstall();
        else if (args[1] === 'uninstall') cmdHookUninstall();
        else if (args[1] === 'install-claude') await cmdClaudeHookInstall(opts);
        else if (args[1] === 'uninstall-claude') cmdClaudeHookUninstall();
        else if (args[1] === 'install-codex') await cmdCodexHookInstall(opts);
        else if (args[1] === 'uninstall-codex') cmdCodexHookUninstall();
        else { err('用法: tinker hook install | uninstall | install-claude | uninstall-claude | install-codex | uninstall-codex'); process.exit(1); }
        break;
      case 'check': await cmdCheck({ fromHook: opts.fromHook, json: opts.json }); break;
      case 'resolve': await cmdResolve(args[1], opts); break;
      case 'voice':
        if (args[1] === 'analyze') await cmdVoiceAnalyze();
        else if (args[1] === 'teach') await cmdVoiceTeach(opts);
        else {
          log(sepia('  用法:'));
          log(sepia('    ') + vermilion('tinker voice analyze'));
          log(sepia('      用 pool 里的样本生成 fingerprint'));
          log(sepia('    ') + vermilion('tinker voice teach --from-claude'));
          log(sepia('      从 Claude Code 对话历史抽样本 (默认 100 条最近)'));
          log(sepia('    ') + vermilion('tinker voice teach --file <path>'));
          log(sepia('      从单个文件读样本'));
        }
        break;
      case 'mute': await cmdMute(args[1]); break;
      case 'prefs': await cmdPrefs(opts); break;
      case 'borrow': {
        // borrow 接所有 positional 参数当查询词 · 跳过 --xxx flag
        // tinker borrow "supabase 邮箱" --kind learning
        const qParts = [];
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          if (a.startsWith('--')) {
            // 带参 flag 要再跳一个 (不能把它的值当成 query)
            if (['--limit', '--unmark', '--kind', '--file'].includes(a)) i++;
            continue;
          }
          qParts.push(a);
        }
        await cmdBorrow(qParts.join(' '), opts);
        break;
      }
      case 'seek': await cmdSeek(opts); break;
      case 'todo': case 'todos': await cmdTodo(args, opts); break;
      case 'feishu': await cmdFeishu(args, opts); break;
      case 'contribute': await cmdContribute(args[1], opts); break;
      case 'recent': await cmdRecent(opts); break;
      case 'feed': await cmdFeed(args[1], opts); break;
      case 'react': await cmdReact(args[1], opts); break;
      case 'tinkered': await cmdTinkered(args[1], opts); break;
      case 'used': await cmdUsed(args[1], opts); break;
      case 'note-done': await cmdNoteDone(args[1], opts); break;
      case 'edit': await cmdEditUpdate(args[1], opts); break;
      case 'delete': await cmdDeleteUpdate(args.slice(1).filter(a => a.startsWith('u-')), opts); break;
      case 'edit-method': await cmdEditMethod(args[1], opts); break;
      case 'project': await cmdProject(args[1], args[2], opts); break;
      case 'mark-experience': case 'mark-exp':
        await cmdMarkExperience(args[1], opts); break;
      case 'mark-learning': case 'mark-learn':
        await cmdMarkLearning(args[1], opts); break;
      case 'mark-decision': case 'mark-dec':
        await cmdMarkDecision(args[1], opts); break;
      case 'situation':
        // tinker situation backfill --type design-loop --hours 6
        if (args[1] === 'backfill') await cmdSituationBackfill(opts);
        else { err('用法: tinker situation backfill [--type design-loop] [--hours 4]'); process.exit(1); }
        break;
      case 'session': await cmdSession(args[1], opts); break;
      // v0.43 主命令名改 deep-summary · goodnight / recap 保留 alias 兼容
      case 'deep-summary': case 'goodnight': case 'recap':
        await cmdGoodnight({
          narrate: opts.narrate || args.includes('--narrate'),
          json: opts.json,
          week: opts.week,
          month: opts.month,
          daysBack: opts.daysBack,
        });
        break;
      case 'maybe-deep-summary': case 'maybe-goodnight':
        // 静默触发器 · 给 Claude Code user-prompt-submit-hook 调
        cmdMaybeGoodnight();
        return; // 不走末尾 showUpdateBannerIfNeeded · 保持 stdout 干净
      case 'maybe-stuck':         cmdMaybe('stuck'); return;
      case 'maybe-breakthrough':  cmdMaybe('breakthrough'); return;
      case 'maybe-decision':      cmdMaybe('decision'); return;
      case 'maybe-subtraction':   cmdMaybe('subtraction'); return;
      case 'maybe-clever-fix':    cmdMaybe('cleverFix'); return;
      case 'maybe-ship':          cmdMaybe('ship'); return;
      case 'maybe-handoff':       cmdMaybe('handoff'); return;
      case 'maybe-invite':        cmdMaybe('invite'); return;
      case 'maybe-check':         cmdMaybeCheck(opts); return;
      case 'pending':             cmdPending(opts); return;
      case 'bridge':
        if (args[1] === 'auto-ping') { await cmdBridgeAutoPing(opts); return; }
        if (args[1] === 'retry') { cmdBridgeRetry(opts); return; }
        if (args[1] === 'failed') { cmdBridgeFailed(opts); return; }
        err('用法:\n  tinker bridge auto-ping [--enable|--disable|--status] [--kinds X,Y] [--to @who]\n  tinker bridge retry        # 重试历史解码失败的 payload (暗号修好后跑)\n  tinker bridge failed       # 看历史解码失败的列表');
        process.exit(1);

      case 'ping': await cmdPing(opts); break;
      case 'send': await cmdSend(opts); break;
      case 'handoff': await cmdHandoff(opts); break;
      case 'stash': await cmdStash(args[1], args, opts); break;
      case 'team-knowledge': await cmdTeamKnowledge(opts); break;
      case 'witness': await cmdWitness(opts); break;
      case 'inbox': await cmdInbox(opts); break;
      case 'outbox': cmdOutbox(opts); break;  // v0.49 我发出去的私信
      case 'bridge-check-inbox': await cmdBridgeCheckInbox(); break;  // hidden · SessionStart hook 用 · v0.38 改成 async (要拉 server)
      case 'notify-claude': cmdNotifyClaude(args[1]); return;  // hidden · Claude Code Notification/Stop/UserPromptSubmit hook 用 · stdout 必须干净
      case 'notify-daemon': await cmdNotifyDaemon(args[1]); return;  // hidden · 后台桥消息通知器 (run/stop/status) · SessionStart 自动 ensure
      case 'maybe-borrow-worked': cmdMaybeBorrowWorked(opts); return;  // hidden · 59b · 借了方法且跑通了 → 提示回响 · stdout 干净
      case 'studio':
        await cmdStudio(args[1], args, opts);
        break;
      case 'timeline':
        await cmdTimeline(args[1], args, opts);
        break;

      case 'llm': await cmdLlm(args[1], opts); break;
      case 'state': cmdState(opts); break;
      case 'triggers': cmdTriggers(opts); break;
      case 'struggle': await cmdStruggle(args[1], opts); break;
      case '__autopsy':
        // 内部命令 · 不暴露给 user help · 由 spawnAutopsyAsync detached child 调
        await cmdAutopsy(args[1]);
        return;
      case 'schema': cmdSchema(opts); break;
      case 'action': await cmdAction(args[1], opts); break;
      case 'stream': await cmdStream(args[1], opts); return; // 长跑 NDJSON 输出 · 不退出
      case 'watch-deploy': await cmdWatch(args[1]); break;  // 内部命令 · 被 spawnDeployWatcher 调用
      case 'help': case '--help': case '-h': case undefined: help(); break;
      default:
        if (opts.json) errJson('未知命令: ' + cmd, 'UNKNOWN_COMMAND');
        else { err('未知命令: ' + cmd); help(); process.exit(1); }
    }
    // 命令跑完 · 如果 cache 显示有更新就在末尾静静提示一行
    // 不在 hook / watch / check (--from-hook) / update 等后台/系统命令里显示
    // v0.36 也顺手 spawn 后台刷 cache · 这样普通用户不用 commit 也能定期 (24h TTL) 收到新版提醒
    // 之前只有 post-commit hook 触发 cmdCheck 时刷 · 不 commit 的用户永远看不到更新
    if (!['watch', 'check', 'update', undefined, 'help', '--help', '-h', 'maybe-goodnight', 'maybe-stuck', 'maybe-breakthrough', 'maybe-decision', 'maybe-subtraction', 'maybe-clever-fix', 'maybe-ship', 'maybe-handoff', 'maybe-invite', 'maybe-check', 'pending', 'bridge-check-inbox', 'notify-claude', 'notify-daemon', 'maybe-borrow-worked', 'situation'].includes(cmd)) {
      showUpdateBannerIfNeeded();
      spawnUpdateCheckAsync();
    }
  } catch (e) {
    if (e.message && (e.message.includes('User force closed') || e.message.includes('ExitPromptError'))) {
      log(sepia('\n  取消了\n'));
    } else {
      err(e.message || String(e));
      process.exit(1);
    }
  }
}

// 导出给测试 / 内部 require 复用 · 不重写 API/state/git 逻辑
module.exports = {
  // 配置
  loadConfig, mustHaveConfig, CONFIG_DIR, CONFIG_FILE,
  // 待办本地缓存 (离线读 + 到期提醒探测复用)
  TODOS_CACHE_FILE, saveTodosCache, loadTodosCache,
  // API
  apiState, apiMe, apiAction, safeFetch,
  // 状态持久化
  loadPromptState, savePromptState, todayKey, recordPushAt,
  // git
  inGitRepo, gitHistorySince,
  // LLM
  llmDraft, llmQuickDraft, sanitizeDraft, validateDraft,
  recordLLMUsage, getTodayLLMUsage,
  // 触发器
  evaluateAllTriggers, loadRepoConfig,
  // pending (AI agent 路径)
  loadPending, savePending, clearPending,
  // sample pool
  savePoolSample,
  // 幂等性 (AI agent 防重放)
  withIdempotency, idemGet, idemSet,
  // drift 检测的注册表
  loadReposRegistry, registerRepoForDrift,
  // v0.13 markdown 工具 (单测可见)
  parseMarkdownSections, scanPrivacyRisks,
};

// 直接 ./tinker 跑才走 main · require 拿模块时不跑
if (require.main === module) {
  main();
}
