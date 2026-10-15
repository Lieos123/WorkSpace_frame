#!/usr/bin/env node
/**
 * 夜跑看板 —— 把工作区 + 夜跑系统的状态渲染成一张离线 HTML。
 *
 *   node _night\board.mjs              生成 _night\board\index.html（+ data.json 快照）
 *   node _night\board.mjs --open       生成后用默认浏览器打开
 *   node _night\board.mjs --date D     推进那一节看哪一天（默认今天）
 *   node _night\board.mjs --selftest   用内置假数据自检渲染（不联网、不读工作区）
 *
 * 分区渲染在 `_night\sections.mjs`（前日简报里的「夜跑看板」一节用的是同一份，避免两处漂移）。
 * 数据全部来自 `node ws.mjs status --json`（_night\lib.mjs 是唯一取数处），
 * 本脚本不解析任何 markdown、不调模型；文案与样式都在 board\template.html 里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HERE, ROOT, esc, fileUrl, humanDate, openWithSystem, readStatus, render, ymd } from './lib.mjs';
import { chipsBar, history, needsFix, pendingCard, projects, progress, queues, tonightCard } from './sections.mjs';

const OUT_DIR = path.join(HERE, 'board');
const TEMPLATE = path.join(OUT_DIR, 'template.html');
const OUT_HTML = path.join(OUT_DIR, 'index.html');
const OUT_JSON = path.join(OUT_DIR, 'data.json');

/* ------------------------------- 主流程 ----------------------------- */

function buildSlots(status) {
  return {
    generatedAt: status.generatedAt,
    dateHuman: humanDate(status.dayDate ?? status.date),
    statusBar: chipsBar(status),
    pending: pendingCard(status),
    tonight: tonightCard(status),
    queues: queues(status),
    projects: projects(status),
    day: progress(status),
    history: history(status, 7),
    needsFix: needsFix(status),
    links:
      `<span>前日简报：<a href="${esc(fileUrl('_night/brief/latest.html'))}">latest.html</a></span>` +
      `<span>项目树：<a href="${esc(fileUrl('TREE.md'))}">TREE.md</a></span>` +
      `<span>工作区清单：<a href="${esc(fileUrl('NIGHT.md'))}">NIGHT.md</a></span>` +
      `<span>夜跑报告：<a href="${esc(fileUrl('_night/runs'))}">_night\\runs\\</a></span>` +
      `<span>机制说明：<a href="${esc(fileUrl('_night/README.md'))}">_night\\README.md</a></span>`,
  };
}

function build(status, outHtml, { writeData = true } = {}) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const html = render(template, buildSlots(status));
  fs.mkdirSync(path.dirname(outHtml), { recursive: true });
  fs.writeFileSync(outHtml, html, 'utf8');
  if (writeData) fs.writeFileSync(OUT_JSON, JSON.stringify(status, null, 2), 'utf8');
  return html.length;
}

/** 内置假数据：不读工作区也能验证模板 + 渲染逻辑 */
const FIXTURE = {
  schema: 'workspace-status/1',
  generatedAt: '2026-10-15 09:00',
  date: '2026-10-15',
  dayDate: '2026-10-15',
  root: ROOT,
  counts: { projects: 2, active: 2, needsFix: 1 },
  workspace: {
    night: {
      file: 'NIGHT.md',
      counts: { 待跑: 1, 待审: 1, 未完成: 0, 搁置: 0, 完成: 2 },
      items: [
        { state: '待跑', raw: '待跑', text: '示例任务 | 验收：跑通即可 | 用户 2026-10-15', file: 'NIGHT.md', line: 14 },
        { state: '待审', raw: '待审', text: '示例待审 | 等用户点头 | agent 2026-10-15', file: 'NIGHT.md', line: 15 },
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
      updated: '2026-10-15 09:00',
      repo: true,
      commits: 3,
      dirty: 1,
      night: {
        file: '示例项目/NIGHT.md',
        counts: { 待跑: 0, 待审: 0, 未完成: 1, 搁置: 0, 完成: 0 },
        items: [{ state: '未完成', raw: '未完成', text: '示例半途任务 | 下一步：从第 3 步接着做 | agent', file: '示例项目/NIGHT.md', line: 8 }],
      },
      day: { date: '2026-10-15', commits: ['abc1234 09:00 自检假提交'], log: '· 自检：假日志一行。', dirty: 1 },
    },
  ],
  nightSystem: {
    pause: false,
    stop: false,
    lock: null,
    last: { date: '2026-10-14', summary: { done: '1', unfinished: '0', blocked: '0', finish: '18:25' }, note: null },
    history: [
      { date: '2026-10-14', summary: { done: '1', unfinished: '0', blocked: '0', finish: '18:25' }, note: null, morning: true, report: '_night/runs/2026-10-14-night.md' },
    ],
  },
  needsFix: [{ rel: '示例项目', what: 'README.md 顶部 frontmatter 缺 next' }],
};

/* -------------------------------- 入口 ------------------------------ */

const args = process.argv.slice(2);
const selftest = args.includes('--selftest');
const open = args.includes('--open');
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : undefined;

try {
  if (selftest) {
    const status = { ...FIXTURE, dayDate: ymd(new Date()) };
    // 自检产物写系统临时目录：不碰 board\ 里的真快照（免得自检数据覆盖真实看板）
    const out = path.join(os.tmpdir(), 'ws-board-selftest.html');
    const size = build(status, out, { writeData: false });
    console.log(`√ 自检通过：模板占位符全部替换，生成 ${out}（${size} 字节）`);
    process.exit(0);
  }

  const date = dateArg ?? ymd(new Date());
  const status = readStatus(['--date', date, '--history', '14']);
  status.dayDate = date;
  const size = build(status, OUT_HTML);
  console.log(`已生成看板：${OUT_HTML}（${size} 字节）`);
  console.log(`数据快照：${OUT_JSON}`);
  if (open) {
    openWithSystem(OUT_HTML);
    console.log('已用默认浏览器打开。');
  }
} catch (e) {
  console.error(`看板生成失败：${e.message}`);
  process.exit(1);
}
