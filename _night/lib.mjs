#!/usr/bin/env node
/**
 * _night 视图层的共用小库：看板（board.mjs）和前日简报（brief.mjs）都从这里取口径。
 *
 * 为什么单独一份：两个视图的数据来源（`node ws.mjs status --json`）、转义、模板替换、
 * 链接生成必须是同一套规则，否则两处必然漂移。这里只放"取数与拼装"，不放任何业务文案。
 *
 * 零依赖、不联网、不调模型。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url)); // _night\
export const ROOT = path.dirname(HERE); // 工作区根

/* ------------------------------ 小工具 ------------------------------ */

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const pad2 = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export const humanDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : `${iso}（周${WEEK[d.getDay()]}）`;
};
export const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

/** 允许运行的时间窗（同 run.mjs 的语义：跨零点写两段） */
export function inWindow(startHour, endHour) {
  const d = new Date();
  const h = d.getHours() + d.getMinutes() / 60;
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

/**
 * 只替换 {{name}}；模板里剩下的任何占位符都是错误。
 * 宁可报错也不要出半张看板/简报——弱模型接手时，报错比静默缺内容好排查得多。
 */
export function render(template, slots) {
  let out = template;
  for (const [k, v] of Object.entries(slots)) out = out.replaceAll(`{{${k}}}`, v ?? '');
  const missing = [...new Set([...out.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]))];
  if (missing.length) throw new Error(`模板里还有没替换的占位符：${missing.join(', ')}`);
  return out;
}

/** 工作区内的相对路径 → file:// 链接（离线可用，浏览器/资源管理器都能点开） */
export const fileUrl = (rel) => `file:///${path.join(ROOT, rel).replace(/\\/g, '/')}`;

/** 交给系统默认程序打开（浏览器打开 html、资源管理器打开目录） */
export function openWithSystem(target) {
  spawnSync('cmd', ['/c', 'start', '', target], { windowsHide: true, stdio: 'ignore' });
}

/* ---------------------------- 数据来源 ------------------------------ */

/**
 * 取 `node ws.mjs status --json` 的快照。
 * 这是唯一的取数口径：不在这里解析任何 markdown。
 */
export function readStatus(args = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'ws.mjs'), 'status', '--json', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`ws.mjs status 失败（退出码 ${r.status}）：${(r.stderr ?? '').trim() || '没有输出'}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`ws.mjs status 的输出不是合法 JSON：${e.message}`);
  }
}

/** 快照里所有层级的夜间清单（工作区级 + 各项目），带上来源标签 */
export function allNightBlocks(status) {
  const blocks = [];
  if (status.workspace?.night) blocks.push({ label: '工作区级', rel: 'NIGHT.md', night: status.workspace.night });
  for (const p of status.projects ?? []) {
    if (p.night) blocks.push({ label: p.rel, rel: p.night.file, night: p.night });
  }
  return blocks;
}

/** 所有 [待审] 条目（窗口拿它做勾选项） */
export function pendingItems(status) {
  const out = [];
  for (const b of allNightBlocks(status)) {
    for (const it of b.night.items) if (it.state === '待审') out.push({ ...it, label: b.label });
  }
  return out;
}

/* ---------------------------- 片段渲染 ------------------------------ */

export const STATE_CLASS = { 待跑: 'go', 待审: 'wait', 未完成: 'half', 搁置: 'hold', 完成: 'done' };

/** 把文本里的 `code` 转成 <code> 标签，其余正常 HTML 转义 */
export function fmtInline(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * 缩短日期显示：与 refDate 同日显示「今天」，前一日显示「昨天」，同年省去「YYYY-」。
 * 完整时间仍可放在 title 属性里供悬停查看。
 */
export function shortDate(isoOrHm, refDate) {
  const raw = String(isoOrHm ?? '').trim();
  if (!raw) return '—';
  const m = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/.exec(raw);
  if (!m) return raw;
  const [, d, t] = m;
  const suffix = t ? ` ${t}` : '';
  if (refDate) {
    if (d === refDate) return `今天${suffix}`;
    if (d === addDays(refDate, -1)) return `昨天${suffix}`;
    if (d.slice(0, 4) === refDate.slice(0, 4)) return `${d.slice(5)}${suffix}`;
  }
  return `${d}${suffix}`;
}

/** 把 NIGHT.md 路径简化成直观的层级/项目短名 */
export function shortSource(file) {
  const f = String(file ?? '').replace(/\\/g, '/').replace(/\/?NIGHT\.md$/i, '');
  if (!f) return '工作区';
  return f.replace(/^WorkFlows\//i, '');
}

/**
 * 清单默认只显示状态、来源和标题；原生 details 提供鼠标、触屏与键盘的全文入口。
 * 不支持 details 的简报内核直接显示正文，不依赖客户端脚本。
 */
export function itemRow(it) {
  const parts = String(it.text).split('|').map((s) => s.trim()).filter(Boolean);
  const title = parts[0] ?? '';
  const note = parts[1] ?? '';
  const meta = parts.slice(2).join(' · ');
  const fullTip = [note, meta, `${it.file}:${it.line}`].filter(Boolean).join(' ｜ ');
  const srcName = shortSource(it.file);
  return (
    `<li class="task-item"><details class="task-detail"><summary title="${esc(fullTip)}">` +
    `<span class="dot ${STATE_CLASS[it.state] ?? ''}"></span>` +
    `<span class="st">${esc(it.state)}</span>` +
    `<span class="tag">${esc(srcName)}</span>` +
    `<span class="ti">${fmtInline(title)}</span>` +
    `<span class="src">${esc(meta)}</span></summary>` +
    `<div class="task-note">${fmtInline(note || '未填写说明')}` +
    `<div class="task-origin">${esc(meta)}${meta ? ' · ' : ''}${esc(`${it.file}:${it.line}`)}</div>` +
    `</div></details></li>`
  );
}

/** 一条清单（旧的 inline 版，保留给需要整行文字的地方） */
export function itemLine(it) {
  const parts = String(it.text).split('|').map((s) => s.trim()).filter(Boolean);
  const title = parts[0] ?? '';
  const rest = parts.slice(1).join(' · ');
  return (
    `<li class="item"><span class="chip chip-${STATE_CLASS[it.state] ?? 'muted'}">${esc(it.state)}</span>` +
    `<span class="item-title">${esc(title)}</span>` +
    (rest ? `<span class="item-rest">${esc(rest)}</span>` : '') +
    `<span class="item-where">${esc(`${it.file}:${it.line}`)}</span></li>`
  );
}

/** 日志摘录：看板/简报只放个开头，整段留在 LOG.md 里（别让一段长文把整页糊住） */
export function clipLog(text, maxLines = 3, maxChars = 200) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  let out = lines.slice(0, maxLines).join('\n');
  let cut = lines.length > maxLines;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    cut = true;
  }
  return cut ? `${out} …` : out;
}

/** runs\ 目录下某天的产物路径与是否存在 */
export function runsInfo(date) {
  const runs = path.join(HERE, 'runs');
  const night = path.join(runs, `${date}-night.md`);
  const morning = path.join(runs, `${date}-morning.md`);
  return {
    night,
    morning,
    nightExists: fs.existsSync(night),
    morningExists: fs.existsSync(morning),
  };
}

/** 「人话摘要」槽：_night\brief\notes-<日期>.md（可选，谁都能填；没有就返回 null） */
export function readNotes(date) {
  const file = path.join(HERE, 'brief', `notes-${date}.md`);
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}
