/**
 * 夜跑/早检用哪个 agent CLI —— 解析 `_night\agents.json` 并拼出可执行命令。
 *
 * 为什么单独一份：换模型/换 CLI 是**配置**，不是代码。`run.mjs` 只调用这里拿
 * 「起什么、带什么参数、补什么环境变量」，加一个新 CLI 只要往 agents.json 里加一段。
 *
 * 占位符（写在 agents.json 的 argv 里）：
 *   {bin}     CLI 可执行文件（`.cjs` 这类 node 脚本也行，配合 {node} 起）
 *   {node}    当前 node（process.execPath）
 *   {prompt}  这一次的指令文本
 *   {root}    工作区根
 *   {extra}   agents.json 里 "extra" 数组，展开成零个或多个参数（比如 ["--profile","intranet"]）
 *
 * 环境变量里的 %VAR% 会被替换；`bin` / `scan` 支持 `*` 通配（取最新改动的那个，
 * 因为 Codex 升级会换 bin\<hash>\ 目录、ZCode 升级会换 resources\<版本>\ 目录）。
 *
 * 命令行自检：
 *   node _night\agent.mjs --list                         看有哪些 agent、能不能找到
 *   node _night\agent.mjs --dry-run --agent codex        只打印将要执行的命令，不真跑
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NIGHT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(NIGHT_DIR);

const AGENTS_FILE = path.join(NIGHT_DIR, 'agents.json');

/** agents.json 读不了时的兜底：保持原来的行为（无头 ZCode） */
const FALLBACK = {
  default: 'zcode',
  agents: {
    zcode: {
      label: '无头 ZCode CLI（兜底定义）',
      bin: ['%ZCODE_CLI%', 'D:\\Zcode\\resources\\glm\\zcode.cjs'],
      scan: ['D:\\Zcode\\resources\\*\\zcode.cjs'],
      argv: ['{node}', '{bin}', '-p', '{prompt}', '--cwd', '{root}', '--mode', 'yolo'],
      env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '@zcode-provider' },
    },
  },
};

/* ------------------------------ 小工具 ------------------------------ */

/** 环境变量取值：Windows 上大小写不敏感，这里两种都试 */
function envGet(name) {
  if (!name) return undefined;
  if (name in process.env) return process.env[name];
  const up = name.toUpperCase();
  if (up in process.env) return process.env[up];
  const low = name.toLowerCase();
  if (low in process.env) return process.env[low];
  return undefined;
}

/** 展开 %VAR% 与环境变量引用；展不开就返回 null（当作"这个候选不可用"） */
function expandVars(s) {
  let missing = false;
  const out = String(s).replace(/%([A-Za-z_][A-Za-z0-9_]*)%|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, a, b) => {
    const v = envGet(a ?? b);
    if (v === undefined) {
      missing = true;
      return '';
    }
    return v;
  });
  return missing ? null : out;
}

const isGlob = (s) => s.includes('*');

/** 把 "…\bin\*\codex.exe" 这类通配展开成候选文件，取 mtime 最新的排前面 */
function globCandidates(pattern) {
  const parts = pattern.split(/[\\/]+/);
  const file = parts.pop();
  let dirs = [parts[0] + (parts[0].endsWith(':') ? '\\' : '')];
  if (!parts[0].endsWith(':') || parts.length > 1) {
    // 处理 "D:" 这类盘符开头
    if (parts[0].endsWith(':')) dirs = [`${parts[0]}\\`];
  }
  dirs = [parts.join(path.sep)];
  for (let i = 1; i < parts.length; i++) {
    if (!parts[i].includes('*')) continue;
    const parent = parts.slice(0, i).join(path.sep);
    const kids = [];
    try {
      for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
        if (e.isDirectory() && (!e.name.startsWith('.') || parts[i].startsWith('.'))) kids.push(e.name);
      }
    } catch {
      return [];
    }
    dirs = kids.flatMap((k) => {
      const rest = parts.slice(i + 1);
      return rest.some((p) => p.includes('*'))
        ? [path.join(parent, k, ...rest.slice(0, rest.findIndex((p) => p.includes('*'))))]
        : [path.join(parent, k)];
    });
  }
  const found = [];
  for (const dir of dirs) {
    try {
      if (file.includes('*')) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isFile()) continue;
          const re = new RegExp(`^${file.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
          if (re.test(e.name)) found.push(path.join(dir, e.name));
        }
      } else {
        const p = path.join(dir, file);
        if (fs.existsSync(p)) found.push(p);
      }
    } catch {}
  }
  return found
    .map((p) => ({ p, t: (() => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.t - a.t)
    .map((x) => x.p);
}

/** ZCode 专属：内置 provider 配置路径（别的 CLI 不需要，也不会因此告警） */
function zcodeProviderConfig() {
  const fromEnv = envGet('ZCODE_BUILTIN_PROVIDER_CONFIG_FILE');
  if (fromEnv) return fromEnv;
  const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`;
  const root = path.join(os.homedir(), '.zcode', 'v2', 'runtime', 'provider', platform);
  let best = null;
  try {
    for (const ver of fs.readdirSync(root).sort()) {
      const verDir = path.join(root, ver);
      for (const ep of fs.readdirSync(verDir)) {
        const f = path.join(verDir, ep, 'zcode-builtin.json');
        if (fs.existsSync(f)) best = f;
      }
    }
  } catch {}
  return best;
}

/* ------------------------------ 读配置 ------------------------------ */

export function loadAgents(file = AGENTS_FILE) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ...FALLBACK, warning: `读不了 ${file}（${e.message}），用兜底的 zcode 定义` };
  }
  if (!data?.agents || typeof data.agents !== 'object') {
    return { ...FALLBACK, warning: `${file} 里没有 agents 表，用兜底的 zcode 定义` };
  }
  return data;
}

/** 选哪个 agent：参数 > 环境变量 NIGHT_AGENT > agents.json 的 default > zcode */
export function pickName(cfg, argName) {
  const name = argName || envGet('NIGHT_AGENT') || cfg.default || 'zcode';
  return String(name);
}

/** 找到 CLI 可执行文件：bin 列表按顺序 + 通配按 mtime 最新（bin/scan 里也支持 {root} {node} 占位符） */
export function findBin(agent, root = ROOT) {
  const pre = (raw) => String(raw).replaceAll('{root}', root).replaceAll('{node}', process.execPath);
  for (const raw of agent.bin ?? []) {
    const expanded = expandVars(pre(raw));
    if (!expanded) continue;
    if (isGlob(expanded)) {
      const hits = globCandidates(expanded);
      if (hits.length) return { file: hits[0], from: raw };
    } else if (fs.existsSync(expanded)) {
      return { file: expanded, from: raw };
    }
  }
  for (const raw of agent.scan ?? []) {
    const expanded = expandVars(pre(raw));
    if (!expanded) continue;
    const hits = globCandidates(expanded);
    if (hits.length) return { file: hits[0], from: raw };
  }
  return null;
}

/** 把 argv 模板 + 这次的实际值拼成 {command, args, env}：argv[0] 展开后就是"用什么起的" */
export function buildCommand(agent, { prompt, root, bin }) {
  const extra = Array.isArray(agent.extra) ? agent.extra.map(String) : [];
  const expanded = [];
  for (const raw of agent.argv ?? []) {
    const piece = String(raw);
    if (piece === '{extra}') {
      expanded.push(...extra);
      continue;
    }
    let v = piece
      .replaceAll('{bin}', bin)
      .replaceAll('{node}', process.execPath)
      .replaceAll('{prompt}', prompt)
      .replaceAll('{root}', root);
    v = expandVars(v) ?? v;
    expanded.push(v);
  }
  const [command, ...args] = expanded;

  const env = { ...process.env };
  const notes = [];
  for (const [k, v] of Object.entries(agent.env ?? {})) {
    if (v === '@zcode-provider') {
      const p = zcodeProviderConfig();
      if (p) env[k] = p;
      else notes.push(`没能推导出 ${k}（ZCode 的内置 provider 配置），这个 CLI 可能起不来`);
      continue;
    }
    env[k] = String(v).replaceAll('{root}', root).replaceAll('{bin}', bin);
  }
  return { command, args, env, notes };
}

/** 解析成一个"这一次要用的 agent" */
export function resolveAgent(name, { root = ROOT, file = AGENTS_FILE } = {}) {
  const cfg = loadAgents(file);
  const chosen = pickName(cfg, name);
  const agent = cfg.agents?.[chosen];
  if (!agent) {
    return { ok: false, name: chosen, warning: cfg.warning, error: `agents.json 里没有名为 ${chosen} 的 agent（有：${Object.keys(cfg.agents ?? {}).join(' / ')}）` };
  }
  const found = findBin(agent, root);
  if (!found) {
    return {
      ok: false,
      name: chosen,
      label: agent.label ?? chosen,
      warning: cfg.warning,
      error: `找不到 ${chosen} 的 CLI（找过：${[...(agent.bin ?? []), ...(agent.scan ?? [])].join(' / ')}）`,
    };
  }
  const promptPlaceholder = (agent.argv ?? []).some((a) => String(a).includes('{prompt}'));
  return { ok: true, name: chosen, label: agent.label ?? chosen, bin: found.file, binFrom: found.from, argv: agent.argv, extra: agent.extra, env: agent.env, promptPlaceholder, warning: cfg.warning, agent };
}

/** 一行可读的命令（写进日志、也是 --dry-run 的输出） */
export const describeCommand = (built) =>
  `"${built.command}" ${built.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;

/* ------------------------------- 自检 CLI ---------------------------- */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const list = args.includes('--list');
  const dryRun = args.includes('--dry-run');
  const nameArg = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined;
  const cfg = loadAgents();

  if (list) {
    if (cfg.warning) console.log(`⚠ ${cfg.warning}`);
    console.log(`默认 agent：${pickName(cfg)}（可用 --agent <名字> / 环境变量 NIGHT_AGENT 覆盖）\n`);
    for (const [name, a] of Object.entries(cfg.agents)) {
      const found = findBin(a);
      console.log(`${name === pickName(cfg) ? '*' : ' '} ${name.padEnd(8)} ${found ? `√ ${found.file}` : '× 找不到 CLI'}`);
      console.log(`           ${a.label ?? ''}`);
      console.log(`           找过：${[...(a.bin ?? []), ...(a.scan ?? [])].join(' / ')}`);
    }
    process.exit(0);
  }

  if (dryRun) {
    const r = resolveAgent(nameArg);
    if (!r.ok) {
      console.error(`✗ ${r.error}`);
      process.exit(1);
    }
    const built = buildCommand(r.agent, { prompt: '<这一次的指令文本>', root: ROOT, bin: r.bin });
    console.log(`agent：${r.name}（${r.label}）`);
    console.log(`CLI ：${r.bin}`);
    console.log(`命令：${describeCommand(built)}`);
    for (const n of built.notes) console.log(`⚠ ${n}`);
    process.exit(0);
  }

  console.log('用法：node _night\\agent.mjs --list | --dry-run [--agent codex]');
  process.exit(2);
}
