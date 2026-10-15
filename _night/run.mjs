#!/usr/bin/env node
/**
 * 夜跑 / 早检的唯一入口。由 Windows 计划任务调用（见 _night\tasks\*.xml）：
 *
 *   node _night\run.mjs night     每天 23:00 夜间执行
 *   node _night\run.mjs morning   每天 08:30 早间检查与收口
 *
 * 用系统 node 起一个**无头 agent CLI**（默认无头 ZCode；换 Codex 或别家见 `_night\agents.json`
 * 与 `_night\agent.mjs`），不依赖任何桌面端是否开着。
 * 开关：_night\PAUSE（今晚不跑）、_night\STOP（当前这轮收尾退出）。
 * 机制说明见 _night\README.md。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCommand, describeCommand, loadAgents, pickName, resolveAgent } from './agent.mjs';

const NIGHT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(NIGHT_DIR);
const RUNS_DIR = path.join(NIGHT_DIR, 'runs');
const LOCK = path.join(NIGHT_DIR, '.lock');
const LOCK_MORNING = path.join(NIGHT_DIR, '.lock-morning');
const PAUSE = path.join(NIGHT_DIR, 'PAUSE');
const STOP = path.join(NIGHT_DIR, 'STOP');
const PROMPTS = path.join(NIGHT_DIR, 'prompts');
const SCHED_LOG = path.join(RUNS_DIR, '_scheduler.log');

const NIGHT_SELF_KILL = envTime('NIGHT_SELF_KILL') ?? '07:50'; // 编排器自己强杀的时刻，必须早于计划任务的 08:00 硬超时
const NIGHT_MAX_MINUTES = 10 * 60; // 强杀窗口上限，防止白天手工跑时算到第二天
const MORNING_SELF_KILL_HOUR = 10; // 早检最晚只能拖到这个整点
const MORNING_MAX_MINUTES = 25; // 早于计划任务早检的 PT30M
const STALE_LOCK_HOURS = 14; // 锁超过这么久视为上一轮崩了，可接管
const MORNING_EVIDENCE_HOURS = 18; // 这么久内有夜跑痕迹才起早检 agent
const LOG_KEEP_DAYS = 90; // runs\*.log 保留天数（报告 .md 不删）

/* 断网 / 关机 / 断电的加固参数（2026-10-15）：
   - 一整晚最多起几次 agent：夜里有 6 个触发时机（23:00 + 5 次补跑），等价于"每个时机最多算一次"；
   - 一次尝试"快速失败"（瞬时断网、CLI 秒退）时，同一轮内还会隔几分钟再试一次——
     因为机器可能马上休眠，后面的补跑时机不一定等得到。慢失败（卡住被强杀）不重试。 */
const MAX_ATTEMPTS = numFromEnv('NIGHT_MAX_ATTEMPTS', 6);
const RETRY_DELAY_SEC = numFromEnv('NIGHT_RETRY_DELAY_SEC', 120);
const FAST_FAIL_MIN = 5; // 尝试短于这么多分钟才算"快速失败"（分钟）
const SAME_RUN_RETRY_MIN_REMAIN = 30; // 同一轮内重试要求距白天停机时刻还剩这么多分钟
const NIGHT_WINDOW = envWindow('NIGHT_WINDOW', 21, 7); // 调试/测试可用环境变量覆盖
const MORNING_WINDOW = envWindow('MORNING_WINDOW', 6, 10);

const ZCODE_CANDIDATES = []; // 旧的候选列表已挪去 _night\agents.json（这里保留空数组只为兼容老引用）

/* ------------------------------ 小工具 ------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const stamp = () => `${ymd(new Date())} ${pad2(new Date().getHours())}:${pad2(new Date().getMinutes())}`;

function schedLog(msg) {
  const line = `[${stamp()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.appendFileSync(SCHED_LOG, line, 'utf8');
  } catch {}
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeLock(file, mode) {
  fs.writeFileSync(
    file,
    JSON.stringify({ mode, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

function dropLock(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}

function hoursSince(date) {
  return (Date.now() - date.getTime()) / 3600000;
}

/* -------------------- 断网 / 关机 / 断电的加固零件 -------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function numFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** HH:MM，格式不对当没设 */
function envTime(name) {
  const v = process.env[name];
  return v && /^\d{1,2}:\d{2}$/.test(v) ? v : null;
}

/** `21-7` 这种两段式时间窗；没设或格式不对用默认 */
function envWindow(name, defStart, defEnd) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(process.env[name] ?? '');
  return m ? { start: Number(m[1]), end: Number(m[2]) } : { start: defStart, end: defEnd };
}

/**
 * 一晚一份运行状态（尝试过几次 / 上次退出码），跨触发时机去重与重试都看它。
 * 之前只看"日志在不在"：一次快速失败会毒死本晚后面所有补跑时机——状态文件替掉它。
 */
const stateFile = (key, mode) => path.join(RUNS_DIR, `${key}-${mode}.state.json`);

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

/** 报告是否走完归档：末尾那行 NIGHT-SUMMARY 是机器可读的成功标志（视图层同样认它） */
function hasSummary(file) {
  try {
    return /NIGHT-SUMMARY:/.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * 失败/半途的兜底留痕。报告不在就建一份，让早上的简报/看板说清"这一晚为什么没有结果"，
 * 而不是被误读成"机器没开"；报告在（agent 写了一半）就补一行"编排器补记"。
 * 刻意不写 NIGHT-SUMMARY：没有汇总行 = 没走到归档退出，视图层本来就按这个判。
 */
function writeFailureStub(file, { key, mode, attempt, code }) {
  const when = stamp();
  const label = mode === 'night' ? '夜跑' : '早检';
  const logHint = `_night\\runs\\${key}-${mode}.log`;
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        [
          `# ${label}未完成（编排器兜底报告）`,
          '',
          `- 本晚标记：${key}；第 ${attempt} 次尝试结束于 ${when}，退出码 ${code}。`,
          `- **这份不是${label} agent 写的**：agent 没走到归档退出，所以报告里没有机器可读的汇总行。`,
          `- 失败原因看 \`${logHint}\` 末尾几行（常见：模型或网络不可用、无头 CLI 起不来、被强杀/超时）。`,
          mode === 'night'
            ? '- 清单原样保留：`[待跑]` 条目没有被碰过。本晚后续触发时机会自动重试，到尝试上限为止；没跑成的留到下一晚。'
            : '- 早检没做成的收口，09:45 的补检时机还会再收一次。',
          '',
        ].join('\n'),
        'utf8',
      );
    } else {
      fs.appendFileSync(file, `\n> 编排器补记：第 ${attempt} 次尝试结束于 ${when}，退出码 ${code}，仍未走完归档。\n`, 'utf8');
    }
  } catch {}
}

/** 杀掉整棵进程树（无头 agent 会拉起 MCP 等子进程） */
function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

/* --------------------------- 用哪个 agent ---------------------------- */

/**
 * 这一次用哪个 agent CLI：`--agent <名字>` > 环境变量 `NIGHT_AGENT` > `agents.json` 的 default。
 * 命令怎么拼（含 ZCode 专属的 provider 环境变量）全在 `agent.mjs` + `agents.json` 里，
 * 本文件不再认识任何一家 CLI 的参数。
 */
let AGENT = null; // 启动时解析一次（见文件末尾入口）

function agentMissingMsg() {
  return AGENT?.error ?? '没有可用的 agent CLI';
}

/** 取这一次要执行的具体命令（惰性：只在真要起 agent 时算） */
function agentCommand(prompt) {
  return buildCommand(AGENT.agent, { prompt, root: ROOT, bin: AGENT.bin });
}

/** 清理过期的 runs\*.log（报告 .md 不动） */
function rotateLogs() {
  let entries;
  try {
    entries = fs.readdirSync(RUNS_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === '_scheduler.log') continue;
    if (!name.endsWith('.log') && !name.endsWith('.state.json')) continue;
    const file = path.join(RUNS_DIR, name);
    try {
      if (hoursSince(fs.statSync(file).mtime) > LOG_KEEP_DAYS * 24) {
        fs.unlinkSync(file);
        schedLog(`清理过期运行产物 ${name}`);
      }
    } catch {}
  }
}

/**
 * 这次运行属于"哪一晚"。07:00 之前算前一晚（夜间窗口 21:00–07:00 的收尾端）。
 * 用途有两个，都必须用同一个值：
 *  1. 运行日志/报告的文件名 —— 23:00 开工和 02:00 补跑都归到同一晚；
 *  2. 去重 —— 同一晚已经有日志了就不再跑，管住夜里的多个触发时机。
 */
function nightKey(now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < 7) d.setDate(d.getDate() - 1);
  return ymd(d);
}

/** 最近一次夜跑的日志日期标记，如 2026-10-14 */
function latestNightStamp() {
  let entries;
  try {
    entries = fs.readdirSync(RUNS_DIR);
  } catch {
    return null;
  }
  const nightLogs = entries
    .filter((n) => /^\d{4}-\d{2}-\d{2}-night\.log$/.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(RUNS_DIR, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return nightLogs.length ? nightLogs[0].n.slice(0, 10) : null;
}

/**
 * 顺手刷新看板（_night\board\index.html），让"跑完就能看"。
 * 纯确定性渲染、零模型；失败只记一行，绝不影响夜跑本体。
 */
function refreshBoard() {
  const script = path.join(NIGHT_DIR, 'board.mjs');
  if (!fs.existsSync(script)) return;
  try {
    const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', timeout: 60e3, windowsHide: true });
    schedLog(r.status === 0 ? '看板已刷新（_night\\board\\index.html）' : `看板刷新失败（退出码 ${r.status}），不影响夜跑`);
  } catch (e) {
    schedLog(`看板刷新异常：${e.message}（不影响夜跑）`);
  }
}

/**
 * 两级清单里还有没有 [待审]。
 * 用来决定"昨夜没跑（比如整夜关机）时要不要照样起早检"——有待审就得起，
 * 否则用户根本没机会点头，那两条会一直挂着。
 */
function hasPendingReview() {
  const re = /^\s*[-*]\s*\[待审\]/;
  const skip = new Set(['node_modules', 'Tools', '_template', '_night']);
  const walk = (dir, depth) => {
    try {
      const file = path.join(dir, 'NIGHT.md');
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').split(/\r?\n/).some((l) => re.test(l))) return true;
    } catch {}
    if (depth >= 3) return false;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || skip.has(e.name)) continue;
      if (walk(path.join(dir, e.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(ROOT, 0);
}

/* ------------------------------- 起 agent ------------------------------ */

/** 上一次 runAgent 是不是被编排器强杀的（被强杀 = 时间用尽，不该在"快速失败重试"里再给一整轮） */
let lastRunKilled = false;

function runAgent({ mode, promptFile, logFile, maxMinutes }) {
  if (!AGENT?.ok) {
    schedLog(`没有可用的 agent CLI，跳过本次 ${mode}（${agentMissingMsg()}）`);
    return 1;
  }
  const prompt =
    mode === 'night'
      ? `按 ${promptFile} 的指令执行今晚的夜间任务。先把那份指令完整读一遍再动手。全程无人值守，没有人会回答你的提问，严格守时间预算。`
      : `按 ${promptFile} 的指令做早间检查与收口。先把那份指令完整读一遍再动手。无人值守。`;

  const cmd = agentCommand(prompt);
  const out = fs.openSync(logFile, 'a');
  fs.appendFileSync(
    logFile,
    `\n===== ${mode} start ${stamp()} =====\nagent: ${AGENT.name}（${AGENT.label}）\ncmd: ${describeCommand(cmd)}\nprompt: ${prompt}\n\n`,
    'utf8',
  );

  schedLog(`${mode} 开始（agent=${AGENT.name}），日志 ${path.relative(ROOT, logFile)}`);
  for (const n of cmd.notes) schedLog(`警告：${n}`);
  const child = spawn(cmd.command, cmd.args, {
    cwd: ROOT,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: cmd.env,
  });

  let killed = false;
  const limitMs = Math.max(60e3, maxMinutes * 60e3);
  const hhmm = (t) => `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  schedLog(`${mode} 强杀时刻定为 ${hhmm(new Date(Date.now() + limitMs))}（编排器自己杀，早于计划任务的硬超时）`);
  const timer = setTimeout(() => {
    killed = true;
    schedLog(`${mode} 到点，强杀进程树 pid=${child.pid}`);
    killTree(child.pid);
  }, limitMs);

  return new Promise((resolve) => {
    const done = (code) => {
      clearTimeout(timer);
      try {
        fs.closeSync(out);
      } catch {}
      schedLog(`${mode} 结束（${killed ? '被强杀' : `退出码 ${code}`}）`);
      lastRunKilled = killed;
      resolve(killed ? 1 : code ?? 0);
    };
    child.on('error', (err) => {
      fs.appendFileSync(logFile, `\nspawn 失败：${err.message}\n`, 'utf8');
      done(-1);
    });
    child.on('exit', (code) => done(code));
  });
}

function msUntil(hour, minute = 0) {
  const now = new Date();
  const t = new Date(now);
  t.setHours(hour, minute, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}

/** 编排器自定强杀时刻转成毫秒 */
const selfKillMs = () => {
  const [h, m] = NIGHT_SELF_KILL.split(':').map(Number);
  return msUntil(h, m);
};

/**
 * 允许运行的时间窗。计划任务用 StartWhenAvailable，机器晚开机时会补跑，
 * 靠这个窗口把「补跑」挡在夜间，免得白天突然开工。
 */
function inWindow(startHour, endHour) {
  const d = new Date();
  const h = d.getHours() + d.getMinutes() / 60;
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

/* -------------------------------- 夜跑 -------------------------------- */

async function night(force) {
  if (!force && !inWindow(NIGHT_WINDOW.start, NIGHT_WINDOW.end)) {
    schedLog(`当前不在夜间窗口（${NIGHT_WINDOW.start}-${NIGHT_WINDOW.end}），跳过（机器晚开机补跑时会出现这种情况）`);
    return 0;
  }
  if (!force && fs.existsSync(PAUSE)) {
    schedLog('发现 PAUSE，今晚不跑（删掉 _night\\PAUSE 即恢复）');
    return 0;
  }
  if (fs.existsSync(STOP)) {
    schedLog('发现 STOP，今晚不跑（删掉 _night\\STOP 即恢复）');
    return 0;
  }

  const lock = readLock(LOCK);
  if (lock && pidAlive(lock.pid)) {
    schedLog(`已有夜跑在跑（pid=${lock.pid}，起于 ${lock.startedAt}），跳过`);
    return 0;
  }
  if (lock) schedLog(`接管过期锁（pid=${lock.pid} 已不在）`);

  const key = nightKey();
  const reportFile = path.join(RUNS_DIR, `${key}-night.md`);
  const logFile = path.join(RUNS_DIR, `${key}-night.log`);
  const stateF = stateFile(key, 'night');

  const st = readState(stateF);
  let attempts = st?.attempts ?? 0;
  let autoAttempts = st?.autoAttempts ?? 0;
  // 只有"自动的一轮跑完归档"（autoDone）才算这一晚跑过，尝试上限也只数自动的：
  // 手动 --force 跑成功不顶掉当晚的自动夜跑、测试跑几轮也不吃当晚的重试额度，
  // 否则白天一次手动跑会让夜里新加进清单的任务白等一晚。去重也不看"日志文件在不在"——
  // 一次失败（断网秒退）不该毒死本晚后面的补跑时机，失败会被后面的时机接着试。
  let autoDone = st?.autoDone === true;
  if (!force) {
    if (autoDone) {
      schedLog(`这一晚（${key}）的自动夜跑已完成归档，跳过——夜里的多个触发时机只跑一次`);
      return 0;
    }
    if (autoAttempts >= MAX_ATTEMPTS) {
      schedLog(`这一晚（${key}）自动尝试已 ${autoAttempts} 次仍未走完归档，达上限（${MAX_ATTEMPTS}）——本晚不再试，清单留到下一晚`);
      return 0;
    }
    if (attempts) {
      schedLog(`这一晚（${key}）上次没走完归档（第 ${attempts} 次尝试，退出码 ${st.lastExit ?? '?'}），继续第 ${attempts + 1} 次`);
    }
  }

  rotateLogs();

  // agent CLI 不在（或配置有问题），就不必按轮重试整晚：留一份兜底报告说清原因，直接收工。
  if (!AGENT?.ok) {
    attempts += 1;
    if (!force) autoAttempts += 1;
    schedLog(`没有可用的 agent CLI（${agentMissingMsg()}），本晚不跑`);
    writeFailureStub(reportFile, { key, mode: 'night', attempt: attempts, code: -1 });
    writeState(stateF, { key, mode: 'night', attempts, autoAttempts, lastExit: -1, lastEndedAt: new Date().toISOString(), ok: false, autoDone });
    return 1;
  }

  const t0 = Date.now();
  let code = 0;
  // 锁包住整轮（含"快速失败"后的等待重试），触发时机挤在一起时也不会两个 agent 同时跑。
  writeLock(LOCK, 'night');
  try {
    for (let i = 0; i < 2; i++) {
      attempts += 1;
      if (!force) autoAttempts += 1;
      code = await runAgent({
        mode: 'night',
        promptFile: path.join(PROMPTS, 'night.md'),
        logFile,
        maxMinutes: Math.min(NIGHT_MAX_MINUTES, selfKillMs() / 60000),
      });
      const ok = hasSummary(reportFile);
      if (ok && !force) autoDone = true;
      writeState(stateF, { key, mode: 'night', attempts, autoAttempts, lastExit: code, lastEndedAt: new Date().toISOString(), ok, autoDone });
      if (ok) {
        schedLog(`这一晚（${key}）第 ${attempts} 次尝试走完归档（退出码 ${code}）${force ? '——手动 --force 跑完，不顶掉今晚的自动夜跑' : ''}`);
        break;
      }
      writeFailureStub(reportFile, { key, mode: 'night', attempt: attempts, code });
      const tookMin = (Date.now() - t0) / 60000;
      const remainMin = selfKillMs() / 60000;
      if (i === 0 && !lastRunKilled && tookMin < FAST_FAIL_MIN && remainMin > SAME_RUN_RETRY_MIN_REMAIN && autoAttempts < MAX_ATTEMPTS) {
        schedLog(`第 ${attempts} 次尝试快速失败（用时 ${tookMin.toFixed(1)} 分钟，退出码 ${code}）——${RETRY_DELAY_SEC} 秒后同一轮内重试一次`);
        await sleep(RETRY_DELAY_SEC * 1000);
        continue;
      }
      schedLog(
        `第 ${attempts} 次尝试未走完归档（用时 ${tookMin.toFixed(1)} 分钟，退出码 ${code}）；` +
          (autoAttempts < MAX_ATTEMPTS ? '等本晚下一个触发时机自动重试' : `已达本晚自动尝试上限（${MAX_ATTEMPTS}），留到下一晚`),
      );
      break;
    }
  } finally {
    dropLock(LOCK);
  }
  refreshBoard();
  return code;
}

/* -------------------------------- 早检 -------------------------------- */

async function morning(force) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  if (!force && !inWindow(MORNING_WINDOW.start, MORNING_WINDOW.end)) {
    schedLog(`当前不在早检窗口（${MORNING_WINDOW.start}-${MORNING_WINDOW.end}），跳过`);
    return 0;
  }

  // 夜跑进程还活着 → 先杀掉，再让早检 agent 去收口
  const lock = readLock(LOCK);
  if (lock && pidAlive(lock.pid)) {
    schedLog(`夜跑进程仍在（pid=${lock.pid}），强杀后交给早检收口`);
    killTree(lock.pid);
    dropLock(LOCK);
  } else if (lock) {
    schedLog(`清理残留锁（pid=${lock.pid} 已不在）`);
    dropLock(LOCK);
  }

  const stampDate = latestNightStamp();
  const nightLog = stampDate ? path.join(RUNS_DIR, `${stampDate}-night.log`) : null;
  const nightReport = stampDate ? path.join(RUNS_DIR, `${stampDate}-night.md`) : null;
  const morningFile = stampDate ? path.join(RUNS_DIR, `${stampDate}-morning.md`) : null;
  const mStateF = stampDate ? stateFile(stampDate, 'morning') : null;
  const mState = mStateF ? readState(mStateF) : null;

  if (!force) {
    // 这一晚已经早检过就别再跑（08:30 和 09:45 两个触发时机只收一次口）。
    // 判据：状态记录里上次早检退出码是 0；没有状态记录（老版本留下的）才退回"摘要比报告新"的老判据。
    let done = mState ? mState.lastExit === 0 : false;
    if (!done && !mState && stampDate) {
      try {
        done = fs.statSync(morningFile).mtimeMs > fs.statSync(nightReport).mtimeMs;
      } catch {}
    }
    if (done) {
      schedLog(`这一晚（${stampDate}）已经早检过，跳过`);
      return 0;
    }

    const fresh = [];
    for (const f of [nightLog, nightReport]) {
      try {
        if (hoursSince(fs.statSync(f).mtime) <= MORNING_EVIDENCE_HOURS) fresh.push(path.basename(f));
      } catch {}
    }
    if (!fresh.length && !hasPendingReview()) {
      fs.appendFileSync(
        path.join(RUNS_DIR, `${ymd(new Date())}-morning.log`),
        `[${stamp()}] 最近 ${MORNING_EVIDENCE_HOURS} 小时没有夜跑痕迹，也没有待审任务，跳过早检。\n`,
        'utf8',
      );
      schedLog('最近没有夜跑痕迹，也没有待审任务，跳过早检');
      return 0;
    }
    if (!fresh.length) schedLog('没有夜跑痕迹，但清单里有 [待审]——照起早检，把待审摆到用户面前');
  }

  const mlock = readLock(LOCK_MORNING);
  if (mlock && pidAlive(mlock.pid)) {
    schedLog(`已有早检在跑（pid=${mlock.pid}），跳过`);
    return 0;
  }
  rotateLogs();
  const mAttempts = (mState?.attempts ?? 0) + 1;
  writeLock(LOCK_MORNING, 'morning');
  let code = 0;
  try {
    code = await runAgent({
      mode: 'morning',
      promptFile: path.join(PROMPTS, 'morning.md'),
      logFile: path.join(RUNS_DIR, `${stampDate ?? ymd(new Date())}-morning.log`),
      maxMinutes: Math.min(MORNING_MAX_MINUTES, msUntil(MORNING_SELF_KILL_HOUR) / 60000),
    });
  } finally {
    dropLock(LOCK_MORNING);
  }
  // 早检没有机器可读的成功标志，以"摘要留没留下"为准；失败也要留痕，别让视图层猜。
  const leftReport = Boolean(morningFile && fs.existsSync(morningFile));
  if (mStateF) {
    writeState(mStateF, {
      key: stampDate,
      mode: 'morning',
      attempts: mAttempts,
      lastExit: code,
      lastEndedAt: new Date().toISOString(),
      ok: code === 0,
    });
  }
  if (code !== 0 || !leftReport) {
    schedLog(`早检第 ${mAttempts} 次尝试没做干净（退出码 ${code}，摘要${leftReport ? '有但没走完' : '没留下'}）——之后还有 09:45 的补检时机兜底`);
    if (morningFile) writeFailureStub(morningFile, { key: stampDate, mode: 'morning', attempt: mAttempts, code });
  }
  refreshBoard();
  return code;
}

/* -------------------------------- 入口 -------------------------------- */

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--'));
const force = args.includes('--force');
const agentArg = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined;
const dryRun = args.includes('--dry-run');

fs.mkdirSync(RUNS_DIR, { recursive: true });

// 用哪个 agent：--agent > NIGHT_AGENT > agents.json 的 default。解析一次，全程用它。
AGENT = resolveAgent(agentArg);

if (args.includes('--list-agents')) {
  const cfg = loadAgents();
  if (cfg.warning) console.log(`⚠ ${cfg.warning}`);
  console.log(`默认 agent：${pickName(cfg)}（--agent <名字> / 环境变量 NIGHT_AGENT 可覆盖）\n`);
  for (const [name, a] of Object.entries(cfg.agents)) {
    const r = resolveAgent(name);
    console.log(`${name === AGENT.name ? '*' : ' '} ${name.padEnd(8)} ${r.ok ? `√ ${r.bin}` : `× ${r.error}`}`);
  }
  process.exit(0);
}

if (dryRun) {
  console.log(`agent：${AGENT.ok ? `${AGENT.name}（${AGENT.label}）` : `× ${AGENT.error}`}`);
  if (AGENT.ok) {
    const cmd = agentCommand('<这一次的指令文本>');
    console.log(`CLI ：${AGENT.bin}`);
    console.log(`命令：${describeCommand(cmd)}`);
    for (const n of cmd.notes) console.log(`⚠ ${n}`);
  }
  process.exit(AGENT.ok ? 0 : 1);
}

if (AGENT.warning) schedLog(`警告：${AGENT.warning}`);
if (!AGENT.ok && (mode === 'night' || mode === 'morning')) {
  schedLog(`没有可用的 agent CLI：${AGENT.error}（用 --list-agents 看有哪些、--agent 选一个）`);
}

if (mode === 'night') process.exit(await night(force));
else if (mode === 'morning') process.exit(await morning(force));
else {
  console.error('用法: node _night\\run.mjs <night|morning> [--force] [--agent <名字>] [--dry-run] [--list-agents]');
  console.error('  night    夜间执行（默认 23:00 由计划任务调用）');
  console.error('  morning  早间检查与收口（默认 08:30 由计划任务调用）');
  console.error('  --force  night 忽略 PAUSE/STOP；morning 即使没有夜跑痕迹也跑');
  console.error('  --agent <名字>  换一个 agent CLI（见 _night\\agents.json；默认 zcode）');
  console.error('  --dry-run       只打印将要执行的命令，不真跑');
  console.error('  --list-agents   列出可用的 agent 及其 CLI 路径');
  process.exit(2);
}
