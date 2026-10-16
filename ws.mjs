#!/usr/bin/env node
/**
 * WorkSpace 工作区工具
 *
 *   node ws.mjs tree                        重新生成 TREE.md（项目树 + 更新时间 + 关键信息）
 *   node ws.mjs today [--date YYYY-MM-DD]   打印某天推进了什么（git 提交 + LOG 条目）
 *   node ws.mjs new <名称> [--desc "一句话"] 按模板新建项目并 git init
 *   node ws.mjs adopt <目录> [--desc "一句话"] [--status 活跃]   把已有/搬入的项目文件夹按规范接入
 *   node ws.mjs night                       看两级夜间清单现状 + 上次夜跑结果
 *   node ws.mjs review [--timeout 秒] [--preselect-all] [--selftest]
 *                       [--report 一页 HTML] [--title 窗口标题]
 *                                           弹窗审核 [待审] 的夜间任务，结果写回清单
 *                                           --report 会多一个「报告」页签（前日总结走这条），没有待审条目也能开窗纯展示
 *                                           默认**不倒计时**（留到用户自己关；关窗＝什么都没批），--timeout 秒 才自动关
 *                                           （调试用 --selftest：窗口自动点确定，不改清单以外的东西）
 *   node ws.mjs status [--json] [--date YYYY-MM-DD] [--history N]
 *                                           工作区 + 夜跑的全量状态；--json 供看板/简报/脚本消费
 *   node ws.mjs board [--open]              生成夜跑看板 HTML（转发 _night\board.mjs）
 *   node ws.mjs task add "标题" [--desc "说明或验收标准"] [--project <项目>] [--review] [--source 用户]
 *                                           往夜间清单加一条任务，累积成积压、夜里慢慢做
 *                                           （默认 [待跑] 加进工作区级；--review 记成 [待审]，agent 用这个）
 *
 * <名称> 可以带路径（如 `WorkFlows\某工作流`），项目就建在那个目录下。
 * README.md frontmatter 标了 `kind: 容器` 的目录是容器：本身不算项目，
 * 但会继续往下扫，把子项目列进 TREE.md（如 WorkFlows\）。
 *
 * 夜间清单（工作区级 NIGHT.md + 各项目 NIGHT.md）格式见 CONVENTIONS.md 第 5 节，
 * 夜跑行为规则见 AGENTS.md「夜间清单与夜跑」，执行器是 _night\run.mjs。
 *
 * 工作区根目录 = 本脚本所在目录。整个 WorkSpace 可以整体搬走，路径不用改。
 * 项目统一规范见 CONVENTIONS.md，本脚本按那份规范执行。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '_template', 'Tools', '_night']);
const MAX_DEPTH = 4;
const TREE_FILE = path.join(ROOT, 'TREE.md');

// 用途分组与仓库边界分开：Tools 是库，Skills/工作流/公共组件仍保留各自仓库生命周期。
const FUNCTIONAL_GROUPS = [
  { id: 'skills', name: 'Skills', rel: 'Skills', desc: '共享 Agent 技能与分发' },
  { id: 'tools', name: 'Tools', rel: 'Tools', desc: '共享开发工具、代码图谱与索引工具' },
  { id: 'workflows', name: 'WorkFlows', rel: 'WorkFlows', desc: '可复用工作流与自动化流程' },
  { id: 'shared', name: '公共组件', rel: '审批窗口', desc: '审批窗口等工作区共用能力' },
];
const projectGroup = (rel) => FUNCTIONAL_GROUPS.find((g) => rel === g.rel || rel.startsWith(`${g.rel}/`))?.id ?? 'business';

/* ------------------------------ 小工具 ------------------------------ */

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const isRepo = (dir) => git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hm = (d) => `${ymd(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

function argValue(args, name) {
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** 取出位置参数，跳过 `--flag 值` 里的值 */
function positional(args, flags = ['desc', 'date', 'status']) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (!a.includes('=') && flags.includes(a.slice(2))) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/* ------------------------------ 模板 ------------------------------- */

const templateText = (file) => fs.readFileSync(path.join(ROOT, '_template', file), 'utf8');

const fillTemplate = (text, vars) =>
  text
    .replaceAll('{{名称}}', vars.name)
    .replaceAll('{{描述}}', vars.desc)
    .replaceAll('{{状态}}', vars.status)
    .replaceAll('{{日期}}', vars.today);

/**
 * 保证 README 顶部有 frontmatter：完全没有就整块插到最前面，
 * 有但缺字段就只补缺的那些。正文一个字都不动。返回补齐的字段名。
 */
function ensureFrontmatter(file, defaults) {
  const text = fs.readFileSync(file, 'utf8');
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) {
    const fm = Object.entries(defaults).map(([k, v]) => `${k}: ${v}`).join('\n');
    fs.writeFileSync(file, `---\n${fm}\n---\n\n${text}`, 'utf8');
    return Object.keys(defaults);
  }
  const meta = {};
  for (const line of block[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const missing = Object.keys(defaults).filter((k) => !meta[k]);
  if (!missing.length) return [];
  const insertAt = block.index + block[0].length - 3; // 结尾那个 --- 的起点
  const insert = missing.map((k) => `${k}: ${defaults[k]}`).join('\n') + '\n';
  fs.writeFileSync(file, text.slice(0, insertAt) + insert + text.slice(insertAt), 'utf8');
  return missing;
}

/* ---------------------------- 项目元信息 ---------------------------- */

/** 读 README.md 顶部的 --- frontmatter ---（desc / status / next） */
function readMeta(dir) {
  const file = path.join(dir, 'README.md');
  if (!fs.existsSync(file)) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return {};
  const meta = {};
  for (const line of block[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return meta;
}

/** LOG.md 里所有 `## YYYY-MM-DD` 的日期 */
function logDates(dir) {
  const file = path.join(dir, 'LOG.md');
  if (!fs.existsSync(file)) return [];
  try {
    return [...fs.readFileSync(file, 'utf8').matchAll(/^##[ \t]*(\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}

/** LOG.md 里某一天那一节的内容 */
function logSection(dir, date) {
  const file = path.join(dir, 'LOG.md');
  if (!fs.existsSync(file)) return '';
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('##') && l.includes(date));
  if (start < 0) return '';
  const body = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('##'); i++) body.push(lines[i]);
  return body.join('\n').trim();
}

/* ------------------------------ 项目扫描 ---------------------------- */

function loadProject(dir, name, rel) {
  const meta = readMeta(dir);
  const repo = isRepo(dir);
  const commits = repo ? Number(git(dir, ['rev-list', '--count', 'HEAD']) ?? 0) : 0;
  const lastCommitIso = repo && commits > 0 ? git(dir, ['log', '-1', '--format=%cI']) : null;
  const dirtyText = repo ? git(dir, ['status', '--porcelain']) : null;
  const dirty = dirtyText ? dirtyText.split(/\r?\n/).filter(Boolean).length : 0;
  const dates = logDates(dir);

  const lastCommit = lastCommitIso
    ? `${lastCommitIso.slice(0, 10)} ${lastCommitIso.slice(11, 16)}`
    : null;
  const lastLog = dates.length ? [...dates].sort().at(-1) : null;

  let mtime = hm(new Date());
  try {
    mtime = hm(fs.statSync(dir).mtime);
  } catch {}

  // 取三者中最新，作为"最后更新"
  const candidates = [];
  if (lastCommit) candidates.push({ at: lastCommit, from: 'commit' });
  if (lastLog) candidates.push({ at: `${lastLog} 00:00`, from: 'log' });
  candidates.push({ at: mtime, from: 'fs' });
  candidates.sort((a, b) => (a.at < b.at ? 1 : -1));

  return {
    kind: 'project',
    name,
    rel,
    dir,
    meta: meta ?? {},
    hasReadme: fs.existsSync(path.join(dir, 'README.md')),
    repo,
    commits,
    dirty,
    lastCommit,
    lastLog,
    updated: lastCommit ?? (lastLog ? `${lastLog} 00:00` : mtime),
    updatedAt: candidates[0].at,
    updatedFrom: candidates[0].from,
  };
}

function scan(parentDir, depth, forceProject = false, parentIsContainer = false, ctx = { strays: [] }) {
  let entries;
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const dir = path.join(parentDir, entry.name);
    const rel = path.relative(ROOT, dir).replace(/\\/g, '/');
    const isArchive = entry.name === '_archive';
    const meta = readMeta(dir);
    // 容器（README 标了 `kind: 容器`）本身不是项目，但要继续往下扫出子项目
    const isContainer = meta?.kind === '容器';
    const isProject =
      !isArchive &&
      !isContainer &&
      (forceProject || fs.existsSync(path.join(dir, 'README.md')) || isRepo(dir));
    if (isProject) {
      nodes.push(loadProject(dir, entry.name, rel));
    } else if (depth < MAX_DEPTH) {
      const children = scan(dir, depth + 1, isArchive || forceProject, isContainer, ctx);
      if (children.length || isContainer) {
        nodes.push({ kind: 'group', name: entry.name, rel, meta: isContainer ? meta : {}, children });
      }
    }
    // 容器的规矩是"一个子文件夹一个项目"，不符合的点名
    if (parentIsContainer && !isProject && !isContainer) ctx.strays.push(rel);
  }
  return nodes;
}

/** 扫描全工作区：项目树节点 + 容器里不合规的子目录 */
function scanAll() {
  const ctx = { strays: [] };
  return { nodes: scan(ROOT, 0, false, false, ctx), strays: ctx.strays };
}

/* ---------------------------- 夜间清单 ------------------------------ */

/** NIGHT.md 一行一条：- [状态] 标题 | 说明 | 来源 日期（格式见 CONVENTIONS.md 第 5 节） */
const NIGHT_ITEM = /^\s*[-*]\s*\[(待跑|待审|未完成|搁置|完成(?:\s+\d{4}-\d{2}-\d{2})?)\]\s*(.*)$/;
const NIGHT_STATES = ['待跑', '待审', '未完成', '搁置', '完成'];

/** 读目录下的 NIGHT.md：没有文件返回 null，有文件返回任务数组 */
function readNight(dir) {
  const file = path.join(dir, 'NIGHT.md');
  if (!fs.existsSync(file)) return null;
  const tasks = [];
  try {
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        const m = NIGHT_ITEM.exec(line);
        if (!m) return;
        // line 是 1 起的行号：审核窗口把用户的决定写回清单时靠它定位
        tasks.push({ state: m[1].startsWith('完成') ? '完成' : m[1], raw: m[1], text: m[2].trim(), line: i + 1 });
      });
  } catch {
    return null;
  }
  return tasks;
}

function countStates(tasks) {
  const counts = Object.fromEntries(NIGHT_STATES.map((s) => [s, 0]));
  for (const t of tasks) counts[t.state] += 1;
  return counts;
}

/** 一行简报：待跑 2 · 待审 1（有未完成/搁置才带出来） */
function nightBrief(tasks) {
  const c = countStates(tasks);
  const bits = [`待跑 ${c['待跑']}`, `待审 ${c['待审']}`];
  if (c['未完成']) bits.push(`未完成 ${c['未完成']}`);
  if (c['搁置']) bits.push(`搁置 ${c['搁置']}`);
  return bits.join(' · ');
}

/** _night\runs 里最新一份夜跑报告；读不到报告就退回看日志 */
function lastNightRun() {
  const runs = path.join(ROOT, '_night', 'runs');
  let entries;
  try {
    entries = fs.readdirSync(runs);
  } catch {
    return null;
  }
  const pick = (re) =>
    entries
      .filter((n) => re.test(n))
      .map((n) => ({ n, t: fs.statSync(path.join(runs, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];

  const report = pick(/^\d{4}-\d{2}-\d{2}-night\.md$/);
  const log = pick(/^\d{4}-\d{2}-\d{2}-night\.log$/);
  if (!report) {
    return log ? { date: log.n.slice(0, 10), summary: null, note: '只有日志没有报告，夜跑可能异常退出' } : null;
  }
  const date = report.n.slice(0, 10);
  let text = '';
  try {
    text = fs.readFileSync(path.join(runs, report.n), 'utf8');
  } catch {}
  // 同一份报告可能有不止一行汇总（白天手动跑过、当晚自动夜跑又接着写同一份）——取最后一行，才是最终结果
  const summaryLines = [...text.matchAll(/NIGHT-SUMMARY:\s*([^>]*?)\s*-->/g)];
  const m = summaryLines.at(-1);
  if (!m) return { date, summary: null, note: '报告里没有汇总行，可能没走到归档退出' };
  const summary = {};
  for (const kv of m[1].split(/\s+/)) {
    const i = kv.indexOf('=');
    if (i > 0) summary[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return { date, summary, note: null };
}

/** 夜跑运行锁的现状（正常结束会删锁，残留说明上一轮异常退出） */
function nightLockState() {
  const file = path.join(ROOT, '_night', '.lock');
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    let alive = false;
    try {
      process.kill(lock.pid, 0);
      alive = true;
    } catch {}
    lock.startedAtLocal = lock.startedAt ? hm(new Date(lock.startedAt)) : '?';
    return { lock, alive };
  } catch {
    return null;
  }
}

/** 把「正在跑 / 有残留锁 / 上一轮结果」压成一行 */
function nightStatusLines() {
  const lock = nightLockState();
  if (lock?.alive) return [`夜跑正在跑（pid=${lock.lock.pid}，起于 ${lock.lock.startedAtLocal}），结果要等它收尾后才有`];
  const lines = [];
  const last = lastNightRun();
  if (last) {
    const s = last.summary;
    lines.push(
      s
        ? `上次夜跑 ${last.date}：完成 ${s.done ?? '?'} · 未完成 ${s.unfinished ?? '?'} · 搁置 ${s.blocked ?? '?'}${s.finish ? `（收尾 ${s.finish}）` : ''}`
        : `上次夜跑 ${last.date}：${last.note ?? '读不到结果'}`,
    );
  } else {
    lines.push('还没跑过夜跑');
  }
  if (lock) lines.push(`⚠ 有残留锁（pid=${lock.lock.pid} 已不在进程），上一轮没正常收尾——下次夜跑会自动接管`);
  return lines;
}

/* ------------------------------ TREE.md ----------------------------- */

function projectLines(p) {
  const status = p.meta.status || '?';
  const bits = [`[${status}]`, `更新 ${p.updated}`];
  if (p.repo) {
    if (p.commits === 0) bits.push('无提交');
    else bits.push(`${p.commits} 次提交`);
    if (p.dirty > 0) bits.push(`未提交 ${p.dirty}`);
  } else {
    bits.push('无 git');
  }
  const lines = [bits.join(' · ')];
  if (p.meta.desc) lines.push(p.meta.desc);
  if (p.meta.next) lines.push(`下一步：${p.meta.next}`);
  return lines;
}

function draw(nodes, prefix, out, projectSink) {
  nodes.forEach((node, i) => {
    const last = i === nodes.length - 1;
    const branch = last ? '└─ ' : '├─ ';
    const childPrefix = prefix + (last ? '   ' : '│  ');
    if (node.kind === 'group') {
      const inner = childPrefix + '   ';
      out.push(`${prefix}${branch}${node.name}\\`);
      if (node.meta?.desc) out.push(`${inner}${node.meta.desc}`);
      if (!node.children.length) {
        out.push(`${inner}（容器还是空的。建第一个：node ws.mjs new ${node.rel}\\<名称> --desc "一句话"）`);
      }
      draw(node.children, inner, out, projectSink);
    } else {
      out.push(`${prefix}${branch}${node.name}\\`);
      for (const line of projectLines(node)) out.push(`${childPrefix}   ${line}`);
      projectSink.push(node);
    }
  });
}

/** 需要补齐的地方（TREE.md 与 status 共用同一份判据，避免两处漂移） */
function needsFix(projects, strays) {
  const out = [];
  for (const p of projects) {
    const miss = ['desc', 'status', 'next'].filter((k) => !p.meta[k]);
    if (miss.length) out.push({ rel: p.rel, what: `README.md 顶部 frontmatter 缺 ${miss.join(' / ')}` });
    if (!p.repo) out.push({ rel: p.rel, what: '还没有本地 git，`git init` 后才能自动统计改动' });
  }
  for (const rel of strays) {
    out.push({ rel, what: '在容器里但不是项目（缺 README.md）', fix: `node ws.mjs adopt ${rel} --desc "一句话"` });
  }
  return out;
}

const needFixLine = (f) => `- \`${f.rel}\`：${f.what}${f.fix ? `。接入：\`${f.fix}\`，或移走` : ''}`;

function cmdTree() {
  const { nodes, strays } = scanAll();
  const projects = [];
  const out = [];
  draw(nodes, '', out, projects);

  const active = projects.filter((p) => p.meta.status === '活跃');
  const fixes = needsFix(projects, strays);

  const text = [
    '# WorkSpace 项目树',
    '',
    `> 自动生成，请勿手改 · 刷新于 ${hm(new Date())} · 由 \`node ws.mjs tree\` 生成`,
    `> 工具库（不是项目）：\`D:\\WorkSpace\\Tools\` ｜ 规范见 \`CONVENTIONS.md\` ｜ 今日推进：\`node ws.mjs today\` ｜ 夜间清单：\`node ws.mjs night\``,
    `> 共 ${projects.length} 个项目，其中活跃 ${active.length} 个`,
    '',
    '## 项目树',
    '',
    '```text',
    `${ROOT}\\`,
    ...(out.length ? out : ['└─ (还没有项目。建第一个：node ws.mjs new <名称> --desc "一句话")']),
    '```',
    '',
    ...(active.length
      ? [
          '## 活跃项目的下一步',
          '',
          ...[...active]
            .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
            .map((p) => `- **${p.rel}**（更新 ${p.updated}）→ ${p.meta.next}`),
          '',
        ]
      : []),
    ...(nightTreeLines(projects).length
      ? ['## 夜间清单', '', ...nightTreeLines(projects), '']
      : []),
    ...(fixes.length
      ? [
          '## 需要补齐',
          '',
          ...fixes.map(needFixLine),
          '',
        ]
      : []),
  ].join('\n');

  fs.writeFileSync(TREE_FILE, text + '\n', 'utf8');
  console.log(`已刷新 ${TREE_FILE}`);
  console.log(`共 ${projects.length} 个项目（活跃 ${active.length}），需补齐 ${fixes.length} 处。`);
  console.log(text.split('## 项目树')[1]?.split('## 活跃')[0]?.trim() ?? '');
}

/* ------------------------------- night ------------------------------ */

/** TREE.md 的「夜间清单」一节：两级队列概况 + 上次夜跑结果 + 锁状态 */
function nightTreeLines(projects) {
  const lines = [];
  const wsNight = readNight(ROOT);
  if (wsNight) lines.push(`- 工作区级（\`NIGHT.md\`）：${nightBrief(wsNight)}`);
  for (const p of projects) {
    const tasks = readNight(p.dir);
    if (tasks) lines.push(`- **${p.rel}**：${nightBrief(tasks)}`);
  }
  for (const l of nightStatusLines()) lines.push(`- ${l}`);
  return lines;
}

function cmdNight() {
  const { nodes } = scanAll();
  const projects = [];
  draw(nodes, '', [], projects);

  const levels = [{ label: '工作区级', rel: 'NIGHT.md', dir: ROOT }];
  for (const p of projects) levels.push({ label: p.rel, rel: `${p.rel}/NIGHT.md`, dir: p.dir });

  console.log('夜间清单 · 两级现状\n');
  const reviewing = [];
  let shown = 0;
  for (const lv of levels) {
    const tasks = readNight(lv.dir);
    if (!tasks) continue;
    shown++;
    const c = countStates(tasks);
    console.log(`■ ${lv.label}  ${lv.rel.replace(/\\/g, '/')}`);
    console.log(`  待跑 ${c['待跑']} · 待审 ${c['待审']} · 未完成 ${c['未完成']} · 搁置 ${c['搁置']} · 已完成 ${c['完成']}`);
    for (const t of tasks) {
      if (t.state === '完成') continue;
      const mark = t.state === '待跑' ? '●' : t.state === '待审' ? '○' : '×';
      console.log(`   ${mark} [${t.raw}] ${t.text}`);
      if (t.state === '待审') reviewing.push(`${lv.label} · ${t.text}`);
    }
    console.log('');
  }
  if (!shown) console.log('（工作区和各项目都还没有 NIGHT.md）\n');

  console.log(`节奏：每晚最多开工 ${nightQuota()} 条（工作区级 NIGHT.md 的「每晚条数」，可改）；没轮到/没做完的自动顺延到下一晚。\n`);

  for (const l of nightStatusLines()) console.log(l);

  if (reviewing.length) {
    console.log(`\n等你点头（待审 ${reviewing.length} 条）——认可就把 [待审] 改成 [待跑]：`);
    for (const r of reviewing) console.log(`   · ${r}`);
  }
}

/* ------------------------------- review ----------------------------- */

const APPROVE_CLI = path.join(ROOT, '审批窗口', 'approve.mjs');

/** 两级清单里所有 [待审] 条目，带定位信息（够用来改回文件） */
function pendingReviews() {
  const { nodes } = scanAll();
  const projects = [];
  draw(nodes, '', [], projects);

  const levels = [{ label: '工作区级', dir: ROOT }];
  for (const p of projects) levels.push({ label: p.rel, dir: p.dir });

  const found = [];
  for (const lv of levels) {
    const file = path.join(lv.dir, 'NIGHT.md');
    if (!fs.existsSync(file)) continue;
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        const m = NIGHT_ITEM.exec(line);
        if (m && m[1] === '待审') found.push({ level: lv.label, dir: lv.dir, file, lineIndex: i, body: m[2].trim() });
      });
  }
  return found;
}

/** 只提交指定文件，不把别人未提交的改动卷进同一个提交 */
function commitOneFile(dir, relPath, message) {
  if (!isRepo(dir)) return null;
  git(dir, ['add', '--', relPath]);
  const r = git(dir, ['commit', '-m', message, '--', relPath]);
  return r === null ? null : (r.split(/\r?\n/)[0] || '已提交');
}

function cmdReview(args) {
  // 默认不倒计时：窗口留到用户看完自己关（用户明确要求）。要倒计时就显式 --timeout 秒。
  const timeout = Math.max(0, Math.trunc(Number(argValue(args, 'timeout') ?? 0)) || 0);
  const preselectAll = args.includes('--preselect-all');
  const selfTest = args.includes('--selftest');
  const title = argValue(args, 'title');
  // --report <html>：窗口里多一个「报告」页签（前日总结用它），没有待审条目时也能开窗纯展示
  const reportArg = argValue(args, 'report');
  const reportPath = reportArg ? path.resolve(reportArg) : null;
  if (reportPath && !fs.existsSync(reportPath)) {
    console.error(`--report 指向的文件不存在：${reportPath}`);
    process.exit(1);
  }

  const pending = pendingReviews();
  if (!pending.length && !reportPath) {
    console.log('两级清单里没有 [待审] 的任务，不用开窗口。');
    return;
  }
  if (!fs.existsSync(APPROVE_CLI)) {
    console.error(`缺少审批窗口：${APPROVE_CLI}\n见 审批窗口\\README.md`);
    process.exit(1);
  }

  console.log(
    `${pending.length ? `待审 ${pending.length} 条` : '没有待审条目'}${reportPath ? ' + 一页报告' : ''}，打开审核窗口…` +
      `${timeout ? `（${timeout} 秒不操作自动关闭）` : '（不自动关闭——看完自己关；关窗＝什么都没批）'}`,
  );
  const closeHint = timeout ? '关窗口或超时都等于什么都没批。' : '关掉窗口＝什么都没批。';
  const spec = {
    title: title ?? `夜间任务审核 · 待审 ${pending.length} 条`,
    message: reportPath
      ? pending.length
        ? `「前日总结」页签是昨天到今早的简报；到「待审」页签勾选＝同意排进今晚夜跑，没勾的保持待审。${closeHint}`
        : `这是前日总结。今天没有 [待审] 条目——看完把窗口关掉即可，什么都不会被改动。`
      : '下面这些是 agent 提出、等你点头的夜间任务。勾上＝同意（排进今晚夜跑），没勾的保持待审；' +
        `要明确否掉，勾上「未勾选的标为搁置」。${closeHint}`,
    topMost: true,
    countdownFormat: '还有 {0} 秒自动关闭（超时＝全部保持待审）',
    buttons: {
      ok: pending.length ? '同意勾选' : '知道了',
      rejectAll: '全部不要',
      later: '稍后再说',
      rejectUnchecked: '未勾选的标为搁置',
    },
    items: pending.map((p, i) => ({
      id: String(i),
      tag: p.level,
      title: p.body.split('|')[0].trim() || p.body,
      detail: `${p.body}\n\n——来自 ${path.relative(ROOT, p.file).replace(/\\/g, '/') || 'NIGHT.md'}`,
      checked: preselectAll,
    })),
  };
  if (reportPath) {
    spec.report = { title: '前日总结', itemsTitle: `待审 ${pending.length} 条`, file: reportPath };
    const board = path.join(ROOT, '_night', 'board', 'index.html');
    if (fs.existsSync(board)) {
      spec.report.openPath = board;
      spec.report.openLabel = '打开看板';
    }
  }

  const tag = `${Date.now()}-${process.pid}`;
  const specFile = path.join(os.tmpdir(), `ws-review-${tag}.json`);
  const outFile = path.join(os.tmpdir(), `ws-review-out-${tag}.json`);
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf8');
  const cliArgs = [APPROVE_CLI, '--spec', specFile, '--out', outFile, '--timeout', String(timeout)];
  if (selfTest) cliArgs.push('--selftest');
  const r = spawnSync(process.execPath, cliArgs, { encoding: 'utf8' });
  for (const f of [specFile]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
  if (r.error || !fs.existsSync(outFile)) {
    const why = r.error?.message || (r.stderr ?? '').trim() || '没有结果文件';
    console.error(`审核窗口没跑起来：${why}`);
    console.error('（非交互环境／没有桌面会话时窗口起不来，此时清单不会被改动）');
    try {
      fs.unlinkSync(outFile);
    } catch {}
    process.exit(1);
  }

  let result;
  try {
    result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch (e) {
    try {
      fs.unlinkSync(outFile);
    } catch {}
    console.error(`结果不是合法 JSON：${e.message}`);
    process.exit(1);
  }
  try {
    fs.unlinkSync(outFile);
  } catch {}

  // 按文件分组写回
  const edits = new Map();
  pending.forEach((p, i) => {
    const d = result.decisions?.[String(i)] ?? 'later';
    if (d === 'later') return;
    if (!edits.has(p.file)) edits.set(p.file, []);
    edits.get(p.file).push({ lineIndex: p.lineIndex, decision: d, body: p.body });
  });

  const today = ymd(new Date());
  const approved = [];
  const rejected = [];
  for (const [file, list] of edits) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const e of list) {
      const line = lines[e.lineIndex];
      if (e.decision === 'approve') {
        lines[e.lineIndex] = line.replace('[待审]', '[待跑]');
        approved.push(`${path.relative(ROOT, file).replace(/\\/g, '/')} · ${e.body.split('|')[0].trim()}`);
      } else {
        lines[e.lineIndex] = `${line.replace('[待审]', '[搁置]')} ｜ 用户 ${today} 未批准`;
        rejected.push(`${path.relative(ROOT, file).replace(/\\/g, '/')} · ${e.body.split('|')[0].trim()}`);
      }
    }
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
  }

  console.log(`\n窗口结果：${result.action}`);
  if (!pending.length) {
    console.log('窗口已关闭（没有待审条目，清单未改动）。');
    return;
  }
  if (!approved.length && !rejected.length) {
    console.log('什么都没批（保持待审）。');
    return;
  }
  if (approved.length) {
    console.log(`\n已批准 ${approved.length} 条 → [待跑]，今晚夜跑会做：`);
    for (const a of approved) console.log(`  · ${a}`);
  }
  if (rejected.length) {
    console.log(`\n已否掉 ${rejected.length} 条 → [搁置]：`);
    for (const a of rejected) console.log(`  · ${a}`);
  }

  // 清单文件跟着项目走（根 NIGHT.md 走根仓库），顺手提交，别给白天留个脏树
  const touched = [...edits.keys()];
  for (const file of touched) {
    const dir = path.dirname(file);
    const rel = path.relative(dir, file).replace(/\\/g, '/');
    const where = path.relative(ROOT, dir).replace(/\\/g, '/') || '工作区根';
    const msg = `夜间清单：用户审核通过 ${approved.length} 条、否掉 ${rejected.length} 条`;
    const ok = commitOneFile(dir, rel, msg);
    console.log(ok ? `\n${where}：${ok}` : `\n${where}：提交失败，记得手动提交 ${rel}`);
  }
}

/* ------------------------------- status ----------------------------- */

/** 某项目某天的推进：提交 + LOG 小节 + 未提交改动（cmdToday 与 status 共用） */
function projectDay(p, date) {
  const out = { date, commits: [], log: '', dirty: 0 };
  if (p.repo && p.commits > 0) {
    const log = git(p.dir, [
      'log',
      `--since=${date} 00:00:00`,
      `--until=${date} 23:59:59`,
      '--format=%h %ad %s',
      '--date=format:%H:%M',
    ]);
    out.commits = log ? log.split(/\r?\n/).filter(Boolean) : [];
  }
  if (p.dirty > 0 && date === ymd(new Date())) out.dirty = p.dirty;
  out.log = logSection(p.dir, date);
  return out;
}

/** runs\ 里最近 N 次夜跑的汇总（报告里的 NIGHT-SUMMARY + 有没有对应早检摘要） */
function nightHistory(limit = 14) {
  const runs = path.join(ROOT, '_night', 'runs');
  let entries;
  try {
    entries = fs.readdirSync(runs);
  } catch {
    return [];
  }
  const have = new Set(entries);
  return entries
    .filter((n) => /^\d{4}-\d{2}-\d{2}-night\.md$/.test(n))
    .map((n) => n.slice(0, 10))
    .sort()
    .reverse()
    .slice(0, Math.max(0, Math.trunc(limit)))
    .map((date) => {
      let summary = null;
      let note = null;
      try {
        const text = fs.readFileSync(path.join(runs, `${date}-night.md`), 'utf8');
        const m = [...text.matchAll(/NIGHT-SUMMARY:\s*([^>]*?)\s*-->/g)].at(-1); // 取最后一行汇总（同 reportSummary 的约定）
        if (m) {
          summary = {};
          for (const kv of m[1].split(/\s+/)) {
            const i = kv.indexOf('=');
            if (i > 0) summary[kv.slice(0, i)] = kv.slice(i + 1);
          }
        } else note = '报告里没有汇总行，可能没走到归档退出';
      } catch {
        note = '读不到报告';
      }
      return { date, summary, note, morning: have.has(`${date}-morning.md`), report: `_night/runs/${date}-night.md` };
    });
}

/** 一级夜间清单 + 定位信息（file/line 用来把用户的决定写回清单） */
function nightBlock(dir, relFile) {
  const tasks = readNight(dir);
  if (!tasks) return null;
  return {
    file: relFile,
    counts: countStates(tasks),
    items: tasks.map((t) => ({ state: t.state, raw: t.raw, text: t.text, file: relFile, line: t.line })),
  };
}

/**
 * 工作区 + 夜跑系统的全量状态快照。
 * 机器可读契约（schema: workspace-status/1）：看板、前日简报、以及将来接内网的
 * 弱模型都只读这一份，不用各自去解析 markdown（解析口径只有这里一处，才不会漂移）。
 */
function snapshot(args) {
  const date = argValue(args, 'date');
  const limit = Math.max(1, Math.trunc(Number(argValue(args, 'history') ?? 14)) || 14);
  const { nodes, strays } = scanAll();
  const projects = [];
  draw(nodes, '', [], projects);
  const fixes = needsFix(projects, strays);
  const functionalGroups = FUNCTIONAL_GROUPS
    .filter((g) => fs.existsSync(path.join(ROOT, g.rel)))
    .map((g) => ({ ...g, desc: readMeta(path.join(ROOT, g.rel))?.desc || g.desc }));
  const business = projects.filter((p) => projectGroup(p.rel) === 'business');

  return {
    schema: 'workspace-status/1',
    generatedAt: hm(new Date()),
    date: ymd(new Date()),
    root: ROOT,
    counts: {
      projects: projects.length,
      active: projects.filter((p) => p.meta.status === '活跃').length,
      needsFix: fixes.length,
      businessProjects: business.length,
      activeBusinessProjects: business.filter((p) => p.meta.status === '活跃').length,
      functionalGroups: functionalGroups.length,
    },
    functionalGroups,
    workspace: { night: nightBlock(ROOT, 'NIGHT.md') },
    projects: [...projects]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((p) => {
        const entry = {
          name: p.name,
          rel: p.rel,
          group: projectGroup(p.rel),
          dir: p.dir,
          status: p.meta.status ?? null,
          desc: p.meta.desc ?? null,
          next: p.meta.next ?? null,
          updated: p.updated,
          updatedFrom: p.updatedFrom,
          repo: p.repo,
          commits: p.commits,
          dirty: p.dirty,
          night: nightBlock(p.dir, `${p.rel}/NIGHT.md`),
        };
        if (date) entry.day = projectDay(p, date);
        return entry;
      }),
    nightSystem: {
      pause: fs.existsSync(path.join(ROOT, '_night', 'PAUSE')),
      stop: fs.existsSync(path.join(ROOT, '_night', 'STOP')),
      lock: nightLockState(),
      last: lastNightRun(),
      history: nightHistory(limit),
    },
    needsFix: fixes,
  };
}

function cmdStatus(args) {
  const snap = snapshot(args);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
    return;
  }
  const lines = [
    `工作区状态 · ${snap.generatedAt}（${snap.root}）`,
    `项目 ${snap.counts.projects} 个（活跃 ${snap.counts.active}）· 需补齐 ${snap.counts.needsFix} 处`,
    '',
    '■ 夜间清单',
  ];
  const levels = [{ label: '工作区级', night: snap.workspace.night }];
  for (const p of snap.projects) levels.push({ label: p.rel, night: p.night });
  let shown = 0;
  for (const lv of levels) {
    if (!lv.night) continue;
    shown++;
    lines.push(`  ${lv.label}：${nightBrief(lv.night.items)}`);
  }
  if (!shown) lines.push('  （还没有 NIGHT.md）');

  lines.push('', '■ 夜跑');
  lines.push(
    `  开关：${snap.nightSystem.pause ? 'PAUSE（已停用）' : '启用'}` +
      `${snap.nightSystem.stop ? ' · STOP（收尾退出中）' : ''} ｜ 锁：` +
      `${snap.nightSystem.lock ? `有（pid=${snap.nightSystem.lock.lock?.pid}${snap.nightSystem.lock.alive ? '，在跑' : '，残留'}）` : '无'}`,
  );
  for (const l of nightStatusLines()) lines.push(`  ${l}`);
  const hist = snap.nightSystem.history.slice(0, 7);
  if (hist.length > 1) {
    lines.push(
      `  最近：${hist.map((h) => `${h.date}${h.summary ? ` 完成${h.summary.done}/未完成${h.summary.unfinished}` : ' 无汇总'}`).join(' · ')}`,
    );
  }

  if (snap.needsFix.length) {
    lines.push('', '■ 需要补齐');
    for (const f of snap.needsFix) lines.push(`  · ${needFixLine(f).slice(2)}`);
  }

  const date = argValue(args, 'date');
  if (date) {
    lines.push('', `■ ${date} 推进`);
    let any = false;
    for (const p of snap.projects) {
      if (!p.day) continue;
      const bits = [];
      if (p.day.commits.length) bits.push(`${p.day.commits.length} 次提交`);
      if (p.day.dirty) bits.push(`未提交 ${p.day.dirty} 个文件`);
      if (p.day.log) bits.push('有日志条目');
      if (!bits.length) continue;
      any = true;
      lines.push(`  ${p.rel}：${bits.join(' · ')}`);
    }
    if (!any) lines.push('  （没有提交、未提交改动或日志条目）');
  }
  console.log(lines.join('\n'));
}

/** node ws.mjs board [--open] —— 转交 _night\board.mjs（看板逻辑只有那一份） */
function cmdBoard(args) {
  const script = path.join(ROOT, '_night', 'board.mjs');
  if (!fs.existsSync(script)) {
    console.error(`缺少看板脚本：${script}`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  process.exit(r.status ?? 1);
}

/* -------------------------------- task ------------------------------- */

/** 工作区级 NIGHT.md frontmatter 里的「每晚条数」（没写按 3；夜跑读同一个字段控制节奏） */
function nightQuota() {
  try {
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(ROOT, 'NIGHT.md'), 'utf8'));
    const m = block && /每晚条数\s*:\s*(\d+)/.exec(block[1]);
    return m ? Number(m[1]) : 3;
  } catch {
    return 3;
  }
}

/** `## 队列` 一节的起止行号（插新条目用） */
function queueBounds(lines) {
  const start = lines.findIndex((l) => /^##\s+队列/.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return { start, end };
}

/** 把条目插进「队列」节：有 `（暂无）` 占位就替换，否则接在节内最后一行后面（先来的先做） */
function insertQueueItem(lines, item) {
  const b = queueBounds(lines);
  if (!b) return false;
  const ph = lines.findIndex((l, i) => i > b.start && i < b.end && /^\s*（暂无）\s*$/.test(l));
  if (ph >= 0) {
    lines[ph] = item;
    return true;
  }
  let last = b.start;
  for (let i = b.start + 1; i < b.end; i++) if (lines[i].trim()) last = i;
  lines.splice(last + 1, 0, item);
  return true;
}

/** 顺手把 frontmatter 的 updated 改成今天（没有 frontmatter 就跳过） */
function touchNightUpdated(lines, date) {
  if (lines[0]?.trim() !== '---') return;
  const endFm = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (endFm < 0) return;
  for (let i = 1; i < endFm; i++) {
    if (/^updated\s*:/.test(lines[i])) {
      lines[i] = `updated: ${date}`;
      return;
    }
  }
  lines.splice(endFm, 0, `updated: ${date}`);
}

/** 按名称或相对路径找一个项目（含容器下的子项目）；容器单独认出来，好给出准确提示 */
function findProject(name) {
  const { nodes } = scanAll();
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const want = norm(name);
  const containers = [];
  const walk = (list) => {
    for (const n of list) {
      if (n.kind === 'group') {
        containers.push(n);
        walk(n.children ?? []);
      }
    }
  };
  walk(nodes);
  const projects = [];
  draw(nodes, '', [], projects);
  return {
    hit: projects.find((p) => norm(p.rel) === want || norm(p.name) === want) ?? null,
    containerHit: containers.find((c) => norm(c.rel) === want || norm(c.name) === want) ?? null,
    all: projects,
    containers,
  };
}

function cmdTask(args) {
  const pos = positional(args, ['desc', 'project', 'source']);
  const [sub, title] = pos;
  if (sub !== 'add' || !title) {
    console.error('用法: node ws.mjs task add "标题" [--desc "说明或验收标准"] [--project <项目>] [--review] [--source 用户]');
    console.error('  --project <项目>  加进那个项目的 NIGHT.md（默认加进工作区级 NIGHT.md）');
    console.error('  --review          记成 [待审]（等用户点头才执行；agent 想到的夜间任务必须用它）');
    process.exit(1);
  }
  const review = args.includes('--review');
  const desc = (argValue(args, 'desc') ?? '').trim();
  const source = (argValue(args, 'source') ?? (review ? '模型' : '用户')).trim();
  const projectArg = argValue(args, 'project');
  // 竖线是条目格式的分隔符，标题/说明里出现就换成全角，别把格式弄坏
  const clean = (s) => String(s).replace(/\|/g, '｜').replace(/\s+/g, ' ').trim();

  let dir = ROOT;
  let label = '工作区级';
  if (projectArg) {
    const { hit, containerHit, all, containers } = findProject(projectArg);
    if (!hit) {
      if (containerHit) {
        console.error(`${containerHit.rel || containerHit.name} 是容器，不是项目——请点名容器下的某个项目。`);
        process.exit(1);
      }
      const hint = containers.length ? `（容器：${containers.map((c) => c.rel).join(' / ')}）` : '';
      console.error(`没找到项目「${projectArg}」。现有项目：${all.map((p) => p.rel).join(' / ') || '（无）'}${hint}`);
      process.exit(1);
    }
    dir = hit.dir;
    label = hit.rel;
  }

  const file = path.join(dir, 'NIGHT.md');
  const date = ymd(new Date());
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      fillTemplate(templateText('NIGHT.md'), { name: path.basename(dir), desc: '', status: '', today: date }),
      'utf8',
    );
    console.log(`这个项目还没有 NIGHT.md，已从模板新建。`);
  }

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const state = review ? '待审' : '待跑';
  const item = `- [${state}] ${clean(title)}${desc ? ` | ${clean(desc)}` : ''} | ${clean(source)} ${date}`;
  if (!insertQueueItem(lines, item)) {
    console.error(`${file} 里没有「## 队列」一节，没动它。请先补上（格式见 CONVENTIONS.md 第 5 节）。`);
    process.exit(1);
  }
  touchNightUpdated(lines, date);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');

  const c = countStates(readNight(dir) ?? []);
  console.log(`已加入 ${path.relative(ROOT, file).replace(/\\/g, '/')}（${label}）`);
  console.log(`  ${item}`);
  console.log(`当前：待跑 ${c['待跑']} · 待审 ${c['待审']}${c['未完成'] ? ` · 未完成 ${c['未完成']}` : ''}${c['搁置'] ? ` · 搁置 ${c['搁置']}` : ''}`);
  console.log(
    review
      ? '这是 [待审]：等用户点头才算数（node ws.mjs review 可弹审批窗口）。'
      : `任务会攒着：夜跑每晚按「每晚条数 ${nightQuota()}」的节奏慢慢做（写在 NIGHT.md 顶部 frontmatter，可改）。`,
  );
}

/* ------------------------------- today ------------------------------ */

function cmdToday(args) {
  const date = argValue(args, 'date') ?? ymd(new Date());
  const { nodes } = scanAll();
  const projects = [];
  draw(nodes, '', [], projects);

  const blocks = [];
  for (const p of [...projects].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))) {
    const d = projectDay(p, date);
    const lines = [];
    if (d.commits.length) {
      lines.push(`提交 ${d.commits.length} 次`);
      for (const c of d.commits) lines.push(`  · ${c}`);
    }
    if (d.dirty > 0) lines.push(`有 ${d.dirty} 个文件未提交`);
    if (d.log) {
      lines.push('日志：');
      for (const l of d.log.split(/\r?\n/)) lines.push(`  ${l}`);
    }
    if (lines.length) blocks.push([`■ ${p.rel}`, ...lines].join('\n'));
  }

  console.log(`今日推进 · ${date}\n`);
  if (!blocks.length) {
    console.log('各项目都没有这一天的提交、未提交改动或日志条目。');
    return;
  }
  console.log(blocks.join('\n\n'));
}

/* -------------------------------- new ------------------------------- */

function cmdNew(args) {
  const name = positional(args)[0];
  if (!name) {
    console.error('用法: node ws.mjs new <名称> [--desc "一句话说明"]');
    process.exit(1);
  }
  const target = path.join(ROOT, name);
  if (fs.existsSync(target)) {
    console.error(`已存在，未改动：${target}\n已有内容的文件夹请用 adopt：node ws.mjs adopt "${name}"`);
    process.exit(1);
  }
  const template = path.join(ROOT, '_template');
  if (!fs.existsSync(template)) {
    console.error(`缺少模板目录：${template}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true }); // <名称> 可带路径，父目录可能还不存在
  fs.cpSync(template, target, { recursive: true });
  const vars = {
    name: path.basename(target),
    desc: argValue(args, 'desc') ?? '（一句话说明待补）',
    status: '活跃',
    today: ymd(new Date()),
  };
  for (const f of fs.readdirSync(target)) {
    const file = path.join(target, f);
    if (!fs.statSync(file).isFile()) continue;
    fs.writeFileSync(file, fillTemplate(fs.readFileSync(file, 'utf8'), vars), 'utf8');
  }

  git(target, ['init']);
  git(target, ['add', '-A']);
  const committed = git(target, ['commit', '-m', '初始化项目骨架']);
  console.log(`已创建 ${target}`);
  console.log(committed ? '已 git init 并完成首次提交。' : '已 git init（首次提交失败，检查 git 的 user.name / user.email 后手动提交）。');
  console.log(`接着填 ${path.join(target, 'README.md')} 的 frontmatter，然后跑 node ws.mjs tree`);
}

/* ------------------------------- adopt ------------------------------ */

function cmdAdopt(args) {
  const raw = positional(args)[0];
  if (!raw) {
    console.error('用法: node ws.mjs adopt <目录> [--desc "一句话说明"] [--status 活跃|暂停|已完成|归档]');
    process.exit(1);
  }
  const target = path.isAbsolute(raw) ? path.resolve(raw) : path.join(ROOT, raw);
  const base = path.basename(target);

  if (target === ROOT) {
    console.error('工作区根本身不是项目，不接入。');
    process.exit(1);
  }
  if (base === '_template' || SKIP_DIRS.has(base)) {
    console.error(`${base} 是模板或库，不是项目，不接入。判据见 CONVENTIONS.md 第 0 节。`);
    process.exit(1);
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    console.error(`不是有效的项目目录：${target}`);
    process.exit(1);
  }
  if (readMeta(target)?.kind === '容器') {
    const rel = path.relative(ROOT, target).replace(/\\/g, '/');
    console.error(`${rel || target} 是容器，不是项目，不接入。往里建项目：node ws.mjs new ${rel}\\<名称> --desc "一句话"`);
    process.exit(1);
  }

  const inside = !path.relative(ROOT, target).startsWith('..');
  const vars = {
    name: base,
    desc: argValue(args, 'desc') ?? '（一句话说明待补）',
    status: argValue(args, 'status') ?? '活跃',
    today: ymd(new Date()),
  };
  const did = [];
  const kept = [];

  // README.md：缺则新建；有内容只补 frontmatter，正文不动
  const readme = path.join(target, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, fillTemplate(templateText('README.md'), vars), 'utf8');
    did.push('新建 README.md');
  } else {
    const filled = ensureFrontmatter(readme, {
      desc: vars.desc,
      status: vars.status,
      next: '写下要做的第一件事',
    });
    if (filled.length) did.push(`README.md 顶部补 frontmatter 字段：${filled.join(' / ')}（原有正文未动）`);
    else kept.push('README.md 已有完整 frontmatter');
  }

  // LOG.md
  const log = path.join(target, 'LOG.md');
  if (!fs.existsSync(log)) {
    fs.writeFileSync(log, fillTemplate(templateText('LOG.md'), vars), 'utf8');
    did.push('新建 LOG.md');
  } else if (!logDates(target).length) {
    kept.push('LOG.md 已存在但没有 `## YYYY-MM-DD` 小节，需自行整理');
  } else {
    kept.push('LOG.md 已存在');
  }

  // AGENTS.md / .gitignore
  for (const file of ['AGENTS.md', 'NIGHT.md', '.gitignore']) {
    const dest = path.join(target, file);
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, fillTemplate(templateText(file), vars), 'utf8');
      did.push(`新建 ${file}`);
    } else {
      kept.push(`${file} 已存在，未改动`);
    }
  }

  // git
  let gitNote;
  if (!isRepo(target)) {
    git(target, ['init']);
    git(target, ['add', '-A']);
    gitNote = git(target, ['commit', '-m', '接入工作区：补齐规范文件'])
      ? '不是仓库，已 git init 并首次提交'
      : '不是仓库，已 git init（首次提交失败，检查 git 的 user.name / user.email）';
  } else {
    const dirtyText = git(target, ['status', '--porcelain']) ?? '';
    const n = dirtyText.split(/\r?\n/).filter(Boolean).length;
    gitNote = `已是 git 仓库（${n} 个文件未提交）。没有替你提交，避免把半成品混进一个提交里`;
  }

  console.log(`接入 ${target}`);
  if (did.length) console.log(`\n补齐：\n${did.map((d) => `  + ${d}`).join('\n')}`);
  if (kept.length) console.log(`\n保留不动：\n${kept.map((k) => `  · ${k}`).join('\n')}`);
  console.log(`\ngit：${gitNote}`);
  if (vars.desc.startsWith('（')) console.log('\n注意：desc 还是占位符，填 README.md frontmatter 第一行。');
  if (!inside) {
    console.log(`\n注意：${target} 不在工作区内，不会出现在 TREE.md。搬进 ${ROOT} 后跑 node ws.mjs tree 即可。`);
    return;
  }
  console.log('');
  cmdTree();
}

/* ------------------------------- 入口 ------------------------------- */

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'tree') cmdTree();
else if (cmd === 'today' || cmd === undefined) cmdToday(args);
else if (cmd === 'new') cmdNew(args);
else if (cmd === 'adopt') cmdAdopt(args);
else if (cmd === 'night') cmdNight();
else if (cmd === 'review') cmdReview(args);
else if (cmd === 'status') cmdStatus(args);
else if (cmd === 'board') cmdBoard(args);
else if (cmd === 'task') cmdTask(args);
else {
  console.error(`未知命令：${cmd}\n可用：tree | today | new | adopt | night | review | status | board | task`);
  process.exit(1);
}
