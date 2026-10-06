// CLI 冒烟测试 · 兜底"改代码别把命令跑崩"
// 背景:tinker.js 一万行单文件 + 团队命令拆到 lib/team-commands.js · 大改动只有这层网
// 守两件事:
//   1) 每个命令在隔离 HOME 下能跑到底 · 不冒 ReferenceError / is not defined 这类 JS 崩溃
//      (退出码 0 或 1 都行 · "没登录"是正常处理过的错 · JS 栈崩才是回归)
//   2) 给 AI 用的结构化出口 (schema / skills / action / state) 输出合法 · 关键命令在册
// 不连网:空 HOME 没有 config · 需要 server 的命令会在 mustHaveConfig 就干净退出

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'tinker.js');

// 每个 case 一个全新的空 HOME · 互不污染 · 也不碰用户真实 ~/.tinker
function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tinker-smoke-'));
}

// 带 config + 工作室的 HOME · 给需要登录/工作室态的命令用 (server 指向死地址 · 真发会快速失败)
function homeWithStudio() {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.tinker'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tinker', 'config.json'),
    JSON.stringify({ serverUrl: 'http://127.0.0.1:1', token: 'tk_x', handle: 'me' }));
  fs.writeFileSync(path.join(home, '.tinker', 'studios.json'),
    JSON.stringify({ active: 'demo', studios: [{ slug: 'demo', name: 'Demo', secret: 'realsecret123456', id: 's1' }] }));
  return home;
}

// 从混合输出里挑出那行 JSON (有些命令会先打本地日志再输出 json)
function lastJson(out) {
  const line = out.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
  return JSON.parse(line);
}

// 跑一条命令 · 返回 { status, out }（out = stdout+stderr 合并 · 去掉颜色码）
function run(args, { home } = {}) {
  const HOME = home || freshHome();
  const env = { ...process.env, HOME };
  // 清掉环境里的 TINKER_* · 保证真的是"没配置"状态 · 不被 CI/本机 env 干扰
  delete env.TINKER_TOKEN; delete env.TINKER_SERVER; delete env.TINKER_HANDLE;
  const r = spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env,
    input: '',            // 空 stdin · 万一某命令要交互 · 立刻 EOF 不挂起
    timeout: 20000,
  });
  if (r.error) throw new Error(`spawn 失败 (${args.join(' ')}): ${r.error.message}`);
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '');
  return { status: r.status, out };
}

const CRASH = /ReferenceError|is not defined|is not a function|Cannot find module|TypeError:|\bat Object\.<anonymous>/;

// ============================================
// 1. 无崩溃扫描 · 覆盖个人 + 团队 + 给 AI 三类命令
// ============================================
const NO_CRASH = [
  ['--help'], ['schema', '--json'], ['skills', '--json'],
  // 团队命令 (拆到 team-commands.js · 这几条守住依赖注入没漏 helper)
  ['studio'], ['studio', 'list'], ['ping'], ['send'], ['handoff'], ['handoff', 'reply'],
  ['inbox'], ['inbox', 'fetch', 'x'], ['inbox', 'verify', 'x'], ['outbox'],
  ['witness'], ['witness', 'draft'], ['witness', 'self'],
  ['team-knowledge'], ['bridge', 'auto-ping', '--status'], ['bridge', 'failed'], ['bridge', 'retry'],
  ['bridge-check-inbox'],
  // 个人命令
  ['config', '--json'], ['state', '--json'], ['pending', '--json'],
  ['recent'], ['feed', '@x'], ['borrow', 'test'], ['voice'], ['triggers'],
];

for (const args of NO_CRASH) {
  test(`无 JS 崩溃 · tinker ${args.join(' ')}`, () => {
    const { out } = run(args);
    assert.ok(!CRASH.test(out), `命令冒出 JS 崩溃:\n${out.slice(0, 600)}`);
  });
}

// ============================================
// 2. 给 AI 的结构化出口 · 合法 + 关键命令在册
// ============================================
test('schema --json 合法 · 含核心命令', () => {
  const { out } = run(['schema', '--json']);
  const j = JSON.parse(out);
  assert.equal(j.ok, true);
  assert.ok(Array.isArray(j.commands));
  const names = j.commands.map(c => c.name);
  for (const n of ['check', 'push', 'ship', 'borrow', 'skills', 'action']) {
    assert.ok(names.includes(n), `schema 缺命令 ${n}`);
  }
});

test('skills --json · 技能入口齐全且都带 category', () => {
  const { out } = run(['skills', '--json']);
  const j = JSON.parse(out);
  assert.equal(j.ok, true);
  const names = new Set(j.skills.map(s => s.name));
  for (const name of ['tinker', 'tinker-borrow', 'tinker-collab', 'tinker-record', 'tinker-todo', 'tinker-triggers', 'tinker-voice', 'feishu-project-runner']) {
    assert.ok(names.has(name), `技能缺入口 ${name}`);
  }
  assert.equal(names.size, j.skills.length, '技能名不能重复');
  assert.ok(j.skills.every(s => s.description && s.category), '技能缺描述或分组');
  const cats = new Set(j.skills.map(s => s.category));
  for (const c of ['通用', '个人', '团队']) assert.ok(cats.has(c), `技能缺分组 ${c}`);
});

test('--help · 个人/团队/给AI 三栏都在', () => {
  const { out } = run(['--help']);
  for (const h of ['个人', '团队协作', '给 AI']) {
    assert.ok(out.includes(h), `help 缺分栏 ${h}`);
  }
});

test('state --json 合法', () => {
  const { out } = run(['state', '--json']);
  const j = JSON.parse(out);
  assert.equal(j.ok, true);
});

// ============================================
// 3. action 逃生口 · 各分支
// ============================================
test('action --dry-run · 回显不发送', () => {
  const { out } = run(['action', 'reactToProject', '--payload', '{"projectId":"p-1"}', '--dry-run', '--json']);
  const j = JSON.parse(out);
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
  assert.equal(j.type, 'reactToProject');
  assert.deepEqual(j.payload, { projectId: 'p-1' });
});

test('action 缺 type → USAGE', () => {
  const { out, status } = run(['action', '--json']);
  const j = JSON.parse(out);
  assert.equal(j.ok, false);
  assert.equal(j.code, 'USAGE');
  assert.equal(status, 1);
});

test('action 坏 JSON → BAD_JSON', () => {
  const { out, status } = run(['action', 'foo', '--payload', '{bad', '--json']);
  const j = JSON.parse(out);
  assert.equal(j.ok, false);
  assert.equal(j.code, 'BAD_JSON');
  assert.equal(status, 1);
});

// handoff --dry-run 离线可测 (dry-run 点在本地 packDossier 之后 · 发送之前 · 不连网)
// 注:push/ship 的 --dry-run 要先 apiState 拉项目列表 · 离线测不了 · 需真 server · 这里只守 handoff
test('handoff --dry-run · 离线预览不发送', () => {
  const { out } = run(['handoff', '-m', '测试预览别当真', '--no-situation', '--dry-run', '--json'], { home: homeWithStudio() });
  const j = lastJson(out);
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
  assert.equal(j.action, 'handoff');
  assert.equal(j.broadcast, true);
});

// ============================================
// 4. 团队模块拆分守卫 · 工厂返回的都是真函数 (防注入漏 helper / 返回表漏项)
// ============================================
test('team-commands 工厂 · 30 个导出全是 function', () => {
  const stub = new Proxy({}, { get: () => (() => {}) });
  const t = require('../lib/team-commands')(stub);
  const expected = [
    'cmdBridgeAutoPing', 'sha256Hex', 'cmdStudio', 'stripAnsi', 'appendOutbox', 'cmdOutbox',
    'cmdBridgeFailed', 'cmdBridgeRetry', 'cmdPing', 'cmdSend', 'uploadHandoffBlob', 'fetchHandoffBlob',
    'sendHandoffReceipt', 'cmdHandoff', 'cmdHandoffReply', 'cmdInbox', 'ensureBlobFetched',
    'cmdInboxFetch', 'cmdInboxVerify', 'cmdBridgeCheckInbox', 'pullBridgeMessagesForHook',
    'cmdTeamKnowledge', 'cmdWitness', 'cmdWitnessDraft', 'packClaudeTranscript', 'cmdWitnessPublish',
    'cmdWitnessReply', 'cmdWitnessClose', 'cmdWitnessSelf', 'cmdTeamKnowledgePublish',
  ];
  for (const n of expected) {
    assert.equal(typeof t[n], 'function', `team-commands 缺函数 ${n}`);
  }
});
