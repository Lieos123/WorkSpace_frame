#!/usr/bin/env node
/**
 * 前日简报 —— 把「昨天」总结成一页离线 HTML，并能在 09:00 弹成系统窗口。
 *
 *   node _night\brief.mjs                 生成前日（昨天）简报：_night\brief\<日期>.html + latest.html + data-<日期>.json
 *   node _night\brief.mjs --date D        指定「前日」是哪天
 *   node _night\brief.mjs --show [--wait] [--timeout 秒] [--selftest]
 *                                         生成后弹窗（09:00 计划任务用）：同一窗口里连 [待审] 一起审
 *                                         **默认不自动关闭**（看完自己关；关窗＝什么都没批）；--wait 等窗口关掉再返回
 *   node _night\brief.mjs --selftest      内置假数据自检（不弹窗、不读工作区）
 *   node _night\brief.mjs --demo          假数据 + 真弹窗，试手感
 *   node _night\brief.mjs --force         --show 忽略时间窗（默认只有 08:00–12:00 才弹）
 *
 * 三段式设计（为「提前总结好 + 模型不在环」）：
 *   1) 早检（08:30，agent）跑到最后执行 `--build`：数据全部由脚本确定性生成，不花模型；
 *   2) 人话摘要槽 _night\brief\notes-<日期>.md 可选，谁都能填（弱模型照 prompts\brief-notes.md 填），
 *      填了就用，没填就只显示自动要点；
 *   3) 09:00 计划任务执行 `--show`：重建 + 弹窗。窗口不依赖模型、不联网，也绝不自动同意任何事
 *      （关窗/超时 = 全部保持 [待审]）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HERE,
  ROOT,
  addDays,
  allNightBlocks,
  clipLog,
  esc,
  fileUrl,
  humanDate,
  inWindow,
  itemRow,
  pendingItems,
  readNotes,
  readStatus,
  render,
  runsInfo,
  ymd,
} from './lib.mjs';
import { chipsBar, history, needsFix, pendingCard, projects, queues, tonightCard } from './sections.mjs';

const OUT_DIR = path.join(HERE, 'brief');
const TEMPLATE = path.join(OUT_DIR, 'template.html');
const LATEST = path.join(OUT_DIR, 'latest.html');

/* ------------------------------ 片段渲染 ---------------------------- */

const sumCommits = (f) => f.day.reduce((n, p) => n + (p.day?.commits?.length ?? 0), 0);

/** 顶部自动要点：只由数据拼，不猜、不编 */
function headlineLines(f) {
  const out = [];
  const commits = sumCommits(f);
  const touched = f.day.filter((p) => (p.day?.commits?.length ?? 0) > 0 || p.day?.log).map((p) => p.rel);
  out.push(commits ? `昨天 ${touched.length} 个项目有动作，共 ${commits} 次提交。` : '昨天各项目没有提交记录。');

  if (f.night?.summary) {
    const s = f.night.summary;
    out.push(`昨晚夜跑完成 ${s.done} 条、未完成 ${s.unfinished} 条${s.finish ? `，${s.finish} 收尾` : ''}。`);
  } else if (f.night) {
    out.push(`昨晚夜跑没有可读的汇总（${f.night.note ?? '未知原因'}）。`);
  } else {
    out.push('昨晚没有夜跑记录（没排任务 / 机器没开 / 夜跑被暂停都可能）。');
  }

  out.push(
    f.morning.exists
      ? `早检摘要已生成，工作树${f.dirty ? `还有 ${f.dirty} 个文件未提交` : '是干净的'}。`
      : '没有早检摘要（早检没跑或没触发）。',
  );
  out.push(f.pending.length ? `现在有 ${f.pending.length} 条 [待审]，等你点头——在窗口的「待审」页签里勾。` : '目前没有待审条目。');
  return out;
}

function daySection(f) {
  const rows = [];
  for (const p of f.day) {
    const commits = p.day?.commits ?? [];
    const log = p.day?.log ?? '';
    if (!commits.length && !log && !p.day?.dirty) continue;
    const head = commits[0] ? commits[0].replace(/^\S+\s+\S+\s+/, '') : (log.split(/\r?\n/)[0] ?? '').replace(/^[-·\s]+/, '');
    rows.push(
      `<tr><td><b>${esc(p.rel)}</b></td>` +
        `<td class="num">${commits.length ? `${commits.length} 次` : '—'}${p.day?.dirty ? ` <span class="warn">未提交 ${p.day.dirty}</span>` : ''}</td>` +
        `<td>${esc(clipLog(head, 1, 60))}` +
        (log ? `<div class="log">${esc(clipLog(log, 3, 180)).replace(/\n/g, '<br>')}</div>` : '') +
        `</td></tr>`,
    );
  }
  return rows.length
    ? `<table><colgroup><col style="width:26%"><col style="width:14%"><col style="width:60%"></colgroup>` +
        `<thead><tr><th>项目</th><th>提交</th><th>摘要</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<div class="muted">${esc(f.date)} 各项目没有提交、未提交改动或日志条目。</div>`;
}

function nightSection(f) {
  const rows = [];
  if (f.night?.summary) {
    const s = f.night.summary;
    rows.push(
      `<div style="margin-bottom:6px">` +
        `<span class="chip done"><span class="d"></span>完成 ${esc(s.done)}</span>` +
        `<span class="chip half"><span class="d"></span>未完成 ${esc(s.unfinished)}</span>` +
        `<span class="chip"><span class="d"></span>搁置 ${esc(s.blocked)}</span>` +
        `${s.finish ? `<span class="chip"><span class="d"></span>收尾 ${esc(s.finish)}</span>` : ''}</div>`,
    );
  } else {
    rows.push(`<div class="muted">${f.night ? esc(f.night.note ?? '没有汇总行') : '没有这一晚的夜跑报告。'}</div>`);
  }
  if (f.doneItems.length) {
    rows.push(`<div class="small muted" style="margin-top:6px">这一晚完成的条目：</div><ul class="items">${f.doneItems.map(itemRow).join('')}</ul>`);
  }
  if (f.stuck.length) {
    rows.push(`<div class="small muted" style="margin-top:6px">没做完 / 搁置（清单里带接续点）：</div><ul class="items">${f.stuck.map(itemRow).join('')}</ul>`);
  }
  if (f.nightReportExists) rows.push(`<div class="small" style="margin-top:6px">完整报告：<a href="${esc(fileUrl(f.nightReport))}">${esc(f.nightReport)}</a></div>`);
  return rows.join('\n');
}

function morningSection(f) {
  const bits = [];
  if (f.morning.exists) {
    bits.push(`早检摘要：<a href="${esc(fileUrl(f.morning.report))}">${esc(f.morning.report)}</a>`);
    bits.push(f.dirty ? `<span class="warn">工作树还有 ${f.dirty} 个文件未提交</span>` : '<span class="ok">工作树干净</span>');
  } else {
    bits.push('<span class="muted">没有早检摘要：08:30 的早检没跑，或最近没有夜跑痕迹时会被跳过（正常）。</span>');
  }
  return bits.map((b) => `<div style="margin:2px 0">${b}</div>`).join('\n');
}

/** 「需要你处理」：左右两栏（待审 / 待跑），同一批数据也出现在窗口的「待审」页签里 */
function actionsSection(status) {
  return (
    '<table class="plain"><colgroup><col style="width:50%"><col style="width:50%"></colgroup><tbody><tr>' +
    `<td class="plaincell"><div class="card"><div class="card-h"><b>等你点头</b><span class="muted small">[待审]</span></div>${pendingCard(status)}</div></td>` +
    `<td class="plaincell"><div class="card"><div class="card-h"><b>可执行队列</b><span class="muted small">未完成 / 待跑</span></div>${tonightCard(status)}</div></td>` +
    '</tr></tbody></table>'
  );
}

/**
 * 「夜跑看板」一节：前日总结里内嵌的看板内容（与 `node ws.mjs board` 同源同规则）。
 * 用户每天早上在一块看——所以摘要在前、看板明细在后，都在同一个窗口里。
 * （推进那一节不重复：上面的「昨天白天做了什么」已经带了日志摘录。）
 */
function boardSection(status, date) {
  return [
    chipsBar(status),
    `<div class="sub">搁置与未排入</div>`,
    queues(status),
    `<div class="sub">项目一览</div>`,
    projects(status),
    `<div class="sub">夜跑历史</div>`,
    history(status, 7),
    `<div class="sub">需要补齐</div>`,
    needsFix(status),
  ].join('\n');
}

function linksSection() {
  return [
    `<span>看板：<a href="${esc(fileUrl('_night/board/index.html'))}">_night\\board\\index.html</a></span>`,
    `<span>工作区清单：<a href="${esc(fileUrl('NIGHT.md'))}">NIGHT.md</a></span>`,
    `<span>项目树：<a href="${esc(fileUrl('TREE.md'))}">TREE.md</a></span>`,
    `<span>夜跑报告：<a href="${esc(fileUrl('_night/runs'))}">_night\\runs\\</a></span>`,
  ].join('\n');
}

/* ------------------------------- 取数 ------------------------------- */

/** 从快照汇总出简报要的全部事实（--build / --selftest 共用） */
function collectFacts(status, date) {
  const blocks = allNightBlocks(status);
  const runs = runsInfo(date);
  const pending = pendingItems(status);
  const doneItems = [];
  const stuck = [];
  for (const b of blocks) {
    for (const it of b.night.items) {
      if (it.state === '完成' && String(it.raw).includes(date)) doneItems.push({ ...it, label: b.label });
      if (it.state === '未完成' || it.state === '搁置') stuck.push({ ...it, label: b.label });
    }
  }
  return {
    date,
    counts: status.counts,
    day: (status.projects ?? []).filter((p) => p.day),
    focus: (status.projects ?? []).filter((p) => p.status === '活跃').map((p) => ({ rel: p.rel, next: p.next })),
    pending,
    doneItems,
    stuck,
    night: status.nightSystem.history.find((h) => h.date === date) ?? null,
    nightReport: `_night/runs/${date}-night.md`,
    nightReportExists: runs.nightExists,
    morning: { exists: runs.morningExists, report: `_night/runs/${date}-morning.md` },
    dirty: (status.projects ?? []).reduce((n, p) => n + (p.dirty ?? 0), 0),
  };
}

/* ------------------------------- 渲染 ------------------------------- */

function buildHtml(f, status) {
  const notes = f.notes
    ? `<div class="notes">${esc(f.notes).replace(/\n/g, '<br>')}</div>`
    : '<div class="muted small">（本期没有人话摘要——自动要点见顶部。想写的话：把 3–5 句总结写进 <code>_night\\brief\\notes-' +
      esc(f.date) +
      '.md</code>，下次生成就会带上，格式见 <code>_night\\prompts\\brief-notes.md</code>。）</div>';
  return render(fs.readFileSync(TEMPLATE, 'utf8'), {
    dateHuman: humanDate(f.date),
    generatedAt: f.generatedAt,
    headline: headlineLines(f).map((l) => `<div>· ${esc(l)}</div>`).join('\n'),
    notes,
    actionsBlock: actionsSection(status),
    nightBlock: nightSection(f),
    dayBlock: daySection(f),
    morningBlock: morningSection(f),
    boardBlock: boardSection(status, f.date),
    linksBlock: linksSection(),
  });
}

/** 生成简报三件套，返回 html 路径 */
function build(date, { quiet = false } = {}) {
  if (!fs.existsSync(TEMPLATE)) throw new Error(`缺少简报模板：${TEMPLATE}`);
  const status = readStatus(['--date', date, '--history', '14']);
  const f = collectFacts(status, date);
  f.notes = readNotes(date);
  f.generatedAt = status.generatedAt;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const htmlFile = path.join(OUT_DIR, `${date}.html`);
  const html = buildHtml(f, status);
  fs.writeFileSync(htmlFile, html, 'utf8');
  fs.writeFileSync(LATEST, html, 'utf8');
  const dataFile = path.join(OUT_DIR, `data-${date}.json`);
  fs.writeFileSync(
    dataFile,
    JSON.stringify({ schema: 'daily-brief/1', date, generatedAt: f.generatedAt, headline: headlineLines(f), notes: f.notes, facts: f }, null, 2),
    'utf8',
  );

  // 顺手刷新看板（一步命令，两个视图都是最新的；失败不影响简报）
  try {
    spawnSync(process.execPath, [path.join(HERE, 'board.mjs')], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  } catch {}

  if (!quiet) {
    console.log(`前日总结（${date}）：`);
    for (const l of headlineLines(f)) console.log(`  · ${l}`);
    console.log(`\nHTML：${htmlFile}`);
    console.log(`最新：${LATEST}（窗口用这个路径）`);
    console.log(`数据：${dataFile}（人话摘要写进 ${path.join(OUT_DIR, `notes-${date}.md`)}）`);
  }
  return { htmlFile, dataFile, facts: f };
}

/* ------------------------------ 弹窗 ------------------------------ */

/**
 * 起「前日总结 + 待审」窗口。
 * 默认**不自动关闭**（用户明确要求：窗口留到他看完自己关）——关窗＝什么都没批，勾选才算点头。
 * 计划任务走脱手起（wscript 隐藏启动器）：任务进程立刻退出，窗口不受任务超时限制。
 */
function launchWindow({ htmlFile, title, timeout, wait, selftest }) {
  const review = path.join(ROOT, 'ws.mjs');
  const args = [review, 'review', '--report', htmlFile, '--title', title, '--timeout', String(timeout)];
  if (selftest) args.push('--selftest');
  const how = `窗口：${title} · ${timeout > 0 ? `${timeout} 秒不操作自动关闭` : '不自动关闭（看完自己关）'}`;

  if (wait) {
    console.log(`打开窗口（等它关掉）：${how}`);
    const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) {
      console.error(`窗口没跑起来（退出码 ${r.status}）。简报还在：${htmlFile}`);
      return r.status ?? 1;
    }
    return 0;
  }

  const launcher = path.join(HERE, 'launch-hidden.vbs');
  if (fs.existsSync(launcher)) {
    spawnSync('wscript', [launcher, ...args], { cwd: ROOT, windowsHide: true });
    console.log(`已请求弹出${how}（脱手：本命令立刻返回，窗口自己留着）`);
    return 0;
  }
  // 没有启动器的环境（非 Windows）：脱手起，窗口寿命与本次命令无关
  const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  console.log(`已请求弹出${how}（脱手）`);
  return 0;
}

function show(date, { timeout, force, demo = false, wait = false, selftest = false }) {
  if (!force && !inWindow(8, 12)) {
    console.log('现在不在弹窗窗口（08:00–12:00），只生成不弹窗。要强制弹用 --force。');
    return 0;
  }
  const { htmlFile } = demo
    ? { htmlFile: path.join(OUT_DIR, '_demo.html') }
    : build(date, { quiet: true });
  const title = demo ? '前日总结 · 示例（假数据）' : `前日总结 · ${date}`;
  return launchWindow({ htmlFile, title, timeout, wait: wait || demo, selftest });
}

/* ------------------------------ 假数据 ------------------------------ */

/** 内置假数据：不读工作区也能验证模板 + 渲染逻辑（--selftest / --demo 用） */
function fixtureStatus(date) {
  return {
    schema: 'workspace-status/1',
    generatedAt: `${date} 08:55`,
    date,
    root: ROOT,
    counts: { projects: 2, active: 2, needsFix: 0 },
    workspace: {
      night: {
        file: 'NIGHT.md',
        counts: { 待跑: 1, 待审: 1, 未完成: 0, 搁置: 0, 完成: 1 },
        items: [
          { state: '完成', raw: `完成 ${date}`, text: '示例已完成任务 | 一句话结果 | 用户', file: 'NIGHT.md', line: 20 },
          { state: '待审', raw: '待审', text: '示例待审任务 | 等用户点头（假数据） | agent', file: 'NIGHT.md', line: 21 },
        ],
      },
    },
    projects: [
      {
        name: '示例项目',
        rel: '示例项目',
        dir: path.join(ROOT, '示例项目'),
        status: '活跃',
        desc: '一句话说明（自检假数据）',
        next: '把自检假数据换成真数据',
        updated: `${date} 18:00`,
        repo: true,
        commits: 2,
        dirty: 0,
        night: {
          file: '示例项目/NIGHT.md',
          counts: { 待跑: 0, 待审: 0, 未完成: 1, 搁置: 0, 完成: 0 },
          items: [{ state: '未完成', raw: '未完成', text: '示例半途任务 | 下一步：从第 3 步接着做 | agent', file: '示例项目/NIGHT.md', line: 8 }],
        },
        day: { date, commits: ['abc1234 10:00 自检假提交', 'def5678 15:30 另一条假提交'], log: '· 自检：假日志一行，说明做了什么／为什么。', dirty: 0 },
      },
    ],
    nightSystem: {
      pause: false,
      stop: false,
      lock: null,
      last: { date, summary: { done: '1', unfinished: '1', blocked: '0', finish: '07:40' }, note: null },
      history: [{ date, summary: { done: '1', unfinished: '1', blocked: '0', finish: '07:40' }, note: null, morning: true, report: `_night/runs/${date}-night.md` }],
    },
    needsFix: [],
  };
}

/** 假数据的一对：快照 + 事实（自检/示例用） */
function fixturePair(date) {
  const status = fixtureStatus(date);
  const f = collectFacts(status, date);
  f.notes = null;
  f.generatedAt = status.generatedAt;
  return { status, f };
}

/* -------------------------------- 入口 ------------------------------ */

const args = process.argv.slice(2);
const selftest = args.includes('--selftest');
const demo = args.includes('--demo');
const force = args.includes('--force');
const wait = args.includes('--wait');
const showWindow = args.includes('--show') || demo;
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : undefined;
const timeoutArg = args.includes('--timeout') ? Number(args[args.indexOf('--timeout') + 1]) : 0; // 0 = 不自动关闭

const date = dateArg ?? addDays(ymd(new Date()), -1);

try {
  if (selftest && !showWindow) {
    const { status, f } = fixturePair(ymd(new Date()));
    const html = buildHtml(f, status);
    const out = path.join(os.tmpdir(), 'ws-brief-selftest.html');
    fs.writeFileSync(out, html, 'utf8');
    for (const must of ['前日总结', '昨晚夜跑', '需要你处理', '夜跑看板']) {
      if (!html.includes(must)) throw new Error(`自检失败：渲染结果里缺少「${must}」`);
    }
    console.log(`√ 自检通过：模板占位符全部替换、要点/分区齐全，生成 ${out}（${html.length} 字节）`);
    process.exit(0);
  }

  if (demo) {
    const { status, f } = fixturePair(ymd(new Date()));
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, '_demo.html'), buildHtml(f, status), 'utf8');
    process.exit(show(date, { timeout: timeoutArg, force: true, demo: true, selftest }));
  }

  if (showWindow) process.exit(show(date, { timeout: timeoutArg, force, wait, selftest }));
  build(date);
} catch (e) {
  console.error(`前日简报失败：${e.message}`);
  process.exit(1);
}
