const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tinker-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, 'cli');
  fs.cpSync(path.join(__dirname, '..'), cli, { recursive: true, filter: p => !p.includes('node_modules') });
  const source = path.join(cli, 'skills', 'fixture-skill');
  fs.mkdirSync(path.join(source, 'references'), { recursive: true });
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Fixture\n---\nRead references/input.md.\n');
  fs.writeFileSync(path.join(source, 'references', 'input.md'), 'required input');
  fs.writeFileSync(path.join(source, 'scripts', 'run.py'), 'print("ready")\n');
  fs.chmodSync(path.join(source, 'scripts', 'run.py'), 0o755);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  function run(...args) {
    const env = { ...process.env, HOME: home };
    delete env.CODEX_HOME; delete env.TINKER_TOKEN; delete env.TINKER_SERVER; delete env.TINKER_HANDLE;
    return spawnSync(process.execPath, [path.join(cli, 'bin', 'tinker.js'), 'skills', 'install', ...args, '--json'],
      { cwd, env, encoding: 'utf8', timeout: 10000 });
  }
  return { root, home, cwd, source, run };
}

test('default installation retains referenced files and executable scripts', t => {
  const f = fixture(t); const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const target = path.join(f.home, '.claude', 'skills', 'fixture-skill');
  assert.equal(fs.readFileSync(path.join(target, 'references', 'input.md'), 'utf8'), 'required input');
  assert.ok(fs.statSync(path.join(target, 'scripts', 'run.py')).mode & 0o111);
});

test('Codex global installation selects only requested skill without Tinker login', t => {
  const f = fixture(t); const r = f.run('--agent', 'codex', '--only', 'fixture-skill');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).installed, ['fixture-skill']);
  assert.ok(fs.existsSync(path.join(f.home, '.agents', 'skills', 'fixture-skill', 'references', 'input.md')));
  assert.equal(fs.existsSync(path.join(f.home, '.claude')), false);
});

test('Codex local installation stays in project skill directory', t => {
  const f = fixture(t); const r = f.run('--agent=codex', '--local', '--only=fixture-skill');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(f.cwd, '.agents', 'skills', 'fixture-skill', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(f.home, '.agents')), false);
});

test('unknown agent or skill is rejected before writing', t => {
  const f = fixture(t);
  for (const args of [['--agent', 'unknown'], ['--only', 'not-found']]) {
    assert.notEqual(f.run(...args).status, 0);
    assert.equal(fs.existsSync(path.join(f.home, '.claude')), false);
  }
});

test('missing agent or selection value is rejected', t => {
  const f = fixture(t);
  for (const flag of ['--agent', '--only']) assert.notEqual(f.run(flag).status, 0);
});

test('reinstallation backs up existing files before replacing a complete bundle', t => {
  const f = fixture(t); assert.equal(f.run('--only', 'fixture-skill').status, 0);
  const target = path.join(f.home, '.claude', 'skills', 'fixture-skill');
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'personal version');
  const r = f.run('--only', 'fixture-skill'); assert.equal(r.status, 0, r.stderr);
  const backups = JSON.parse(r.stdout).backups;
  assert.equal(fs.readFileSync(path.join(backups[0].path, 'SKILL.md'), 'utf8'), 'personal version');
  assert.ok(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8').startsWith('---'));
});

test('installation refuses a symlink target and leaves outside files untouched', t => {
  const f = fixture(t);
  const base = path.join(f.home, '.claude', 'skills'); fs.mkdirSync(base, { recursive: true });
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'SKILL.md'), 'keep');
  fs.symlinkSync(outside, path.join(base, 'fixture-skill'));
  assert.notEqual(f.run('--only', 'fixture-skill').status, 0);
  assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'keep');
});

test('installed Feishu bundle runs a disabled poller without credentials or background setup', t => {
  const f = fixture(t); const r = f.run('--agent', 'codex', '--only', 'feishu-project-runner');
  assert.equal(r.status, 0, r.stderr);
  const installed = path.join(f.home, '.agents', 'skills', 'feishu-project-runner');
  for (const file of ['agents/openai.yaml', 'references/onboarding.md', 'references/state.md', 'references/shenlai.md', 'references/automation.md']) {
    assert.ok(fs.statSync(path.join(installed, file)).isFile(), `缺配套文件 ${file}`);
  }
  const examples = path.join(installed, 'assets', 'examples');
  const project = JSON.parse(fs.readFileSync(path.join(examples, 'project-config.example.json')));
  assert.equal(project.schema_version, 1);
  assert.equal(project.reporting_authorized, false);
  const config = JSON.parse(fs.readFileSync(path.join(examples, 'poller-config.example.json')));
  assert.equal(config.schedule.enabled, false);
  config.workspace = f.cwd;
  const settings = JSON.parse(fs.readFileSync(path.join(examples, 'scheduler-settings.example.json')));
  settings.project_config = path.join(f.cwd, 'poller-config.json');
  fs.writeFileSync(settings.project_config, JSON.stringify(config));
  const settingsPath = path.join(f.cwd, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const tick = spawnSync('python3', [path.join(installed, 'scripts', 'scheduler.py'), '--settings', settingsPath, '--origin', 'manual'],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(tick.status, 0, tick.stderr);
  assert.equal(JSON.parse(tick.stdout).outcome, 'disabled');
  const status = JSON.parse(fs.readFileSync(path.join(f.cwd, 'scheduler-status.json')));
  assert.equal(status.read_complete, false);
  assert.equal(status.enabled, false);
  assert.equal(fs.existsSync(path.join(f.home, 'Library', 'LaunchAgents')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.tinker', 'config.json')), false);
});

test('installation refuses a symlink backup directory before replacing an existing skill', t => {
  const f = fixture(t); assert.equal(f.run('--only', 'fixture-skill').status, 0);
  const base = path.join(f.home, '.claude', 'skills');
  fs.symlinkSync(f.cwd, path.join(base, '.tinker-backups'));
  assert.notEqual(f.run('--only', 'fixture-skill').status, 0);
  assert.ok(fs.existsSync(path.join(base, 'fixture-skill', 'references', 'input.md')));
  assert.deepEqual(fs.readdirSync(f.cwd), []);
});
