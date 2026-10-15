#!/usr/bin/env node
/**
 * 把 _night\tasks\*.xml 注册成 Windows 计划任务。
 *
 * 两个坑在这里一并处理掉：
 *  1. schtasks 只接受 UTF-16 的 XML —— 源文件保持 UTF-8 可读，注册时转一份临时文件；
 *  2. XML 里写死的 node 路径会过期 —— 注册时换成当前跑本脚本的这个 node。
 *
 * 由 register.cmd 调用，也可以直接 `node _night\register.mjs`。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NIGHT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TASKS = [
  { name: 'WorkSpace-NightRun', xml: 'night-run.xml', when: '每天 23:00' },
  { name: 'WorkSpace-MorningCheck', xml: 'morning-check.xml', when: '每天 08:30' },
  // 09:00 前日简报走 launch-hidden.vbs：窗口只该有一个（简报弹窗），不能再挂个黑控制台
  { name: 'WorkSpace-DailyBrief', xml: 'daily-brief.xml', when: '每天 09:00', launcher: 'wscript' },
];

// launch-hidden.vbs 按这个文件找 node；注册时写死当前 node 的路径
const NODE_PATH_FILE = path.join(NIGHT_DIR, 'node-path.txt');

let failed = 0;
let nodePathWritten = false;

for (const t of TASKS) {
  const src = path.join(NIGHT_DIR, 'tasks', t.xml);
  if (!fs.existsSync(src)) {
    console.error(`× 缺少 ${src}`);
    failed++;
    continue;
  }
  const bin =
    t.launcher === 'wscript'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
      : process.execPath;
  const withBin = fs.readFileSync(src, 'utf8').replace(/(<Command>)[^<]*(<\/Command>)/, `$1${bin}$2`);
  if (!withBin.includes(bin)) {
    console.error(`× ${t.xml} 里没有找到 <Command>，无法注入路径`);
    failed++;
    continue;
  }

  const tmp = path.join(os.tmpdir(), `ws-night-${t.name}.xml`);
  fs.writeFileSync(tmp, `\ufeff<?xml version="1.0" encoding="UTF-16"?>\n${withBin}`, 'utf16le');

  const r = spawnSync('schtasks', ['/create', '/tn', t.name, '/xml', tmp, '/f'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  try {
    fs.unlinkSync(tmp);
  } catch {}

  if (r.status === 0) {
    if (t.launcher === 'wscript' && !nodePathWritten) {
      fs.writeFileSync(NODE_PATH_FILE, process.execPath, 'utf8');
      nodePathWritten = true;
    }
    console.log(`√ ${t.name}（${t.when}）· ${path.basename(bin)} = ${bin}`);
  } else {
    console.error(`× ${t.name} 注册失败：${out}`);
    failed++;
  }
}

if (nodePathWritten) console.log(`√ node 路径已写入 ${NODE_PATH_FILE}（launch-hidden.vbs 用它启动）`);

if (failed) {
  console.error(`\n${failed} 个任务没注册成功。`);
  process.exit(1);
}
console.log(`
接下来：
  schtasks /query /tn "WorkSpace-NightRun" /v /fo LIST
  node D:\\WorkSpace\\_night\\run.mjs night --force      立刻跑一轮夜跑
  node D:\\WorkSpace\\ws.mjs night                        看两级清单现状
  wscript D:\\WorkSpace\\_night\\launch-hidden.vbs D:\\WorkSpace\\_night\\brief.mjs --show --force
                                                        立刻弹一次前日简报（验证弹窗）

卸载：
  schtasks /delete /tn "WorkSpace-NightRun" /f
  schtasks /delete /tn "WorkSpace-MorningCheck" /f
  schtasks /delete /tn "WorkSpace-DailyBrief" /f`);
