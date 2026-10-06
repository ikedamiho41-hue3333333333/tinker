const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function rejectSymlinkTree(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) throw new Error('skill 路径不能是符号链接: ' + dir);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(dir)) rejectSymlinkTree(path.join(dir, name));
  } else if (!stat.isFile()) throw new Error('skill 包只能包含普通文件和目录: ' + dir);
}

function installSkills(source, names, root, agent) {
  const baseDir = path.join(root, agent === 'codex' ? '.agents' : '.claude', 'skills');
  // Only check paths we write; root may itself use a normal OS alias (/var -> /private/var).
  for (const dir of [path.dirname(baseDir), baseDir, path.join(baseDir, '.tinker-backups')]) {
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('安装目录必须是普通目录: ' + dir);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of names) {
    rejectSymlinkTree(path.join(source, name));
    const target = path.join(baseDir, name);
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error('skill 目标不能是符号链接: ' + target);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fs.mkdirSync(baseDir, { recursive: true });
  const backups = [];
  for (const name of names) {
    const target = path.join(baseDir, name);
    const stage = path.join(baseDir, '.install-' + randomUUID());
    let backup;
    try {
      fs.cpSync(path.join(source, name), stage, { recursive: true, errorOnExist: true, force: false });
      if (fs.existsSync(target)) {
        const backupDir = path.join(baseDir, '.tinker-backups');
        fs.mkdirSync(backupDir, { recursive: true });
        backup = path.join(backupDir, name + '-' + randomUUID());
        fs.renameSync(target, backup);
      }
      fs.renameSync(stage, target);
      if (backup) backups.push({ name, path: backup });
    } catch (error) {
      if (backup && !fs.existsSync(target)) fs.renameSync(backup, target);
      throw error;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  return { baseDir, backups };
}

module.exports = { installSkills };
