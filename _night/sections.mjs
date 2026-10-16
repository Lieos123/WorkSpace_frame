/**
 * 视图片段（看板与简报共用）：把 `ws.mjs status --json` 的快照渲染成一段段 HTML。
 *
 * 为什么单独一份：`board.mjs`（整页看板）和 `brief.mjs`（前日总结里的"夜跑看板"一节）
 * 用的是同一批分区，规则必须一致——不然两处必然漂移。
 *
 * 排版约定：摘要优先，长说明可展开；简报的旧内核直接展示全文。
 * 两个模板分别提供现代看板样式与 WinForms IE 兼容样式。
 */
import { esc, fileUrl, fmtInline, itemRow, shortDate } from './lib.mjs';

/** 收集两级清单里某状态的条目 */
export function pickItems(status, states) {
  const out = [];
  const push = (night) => {
    if (!night) return;
    for (const it of night.items) if (states.includes(it.state)) out.push(it);
  };
  push(status.workspace?.night);
  for (const p of status.projects ?? []) push(p.night);
  return out;
}

/** 沿用夜跑规则：工作区先于活跃项目，每级未完成优先；这是积压队列而非当晚执行承诺。 */
export function runnableItems(status) {
  const blocks = [status.workspace?.night, ...(status.projects ?? [])
    .filter((p) => p.status === '活跃').map((p) => p.night)];
  return blocks.flatMap((night) => ['未完成', '待跑']
    .flatMap((state) => (night?.items ?? []).filter((it) => it.state === state)));
}

const itemList = (items, emptyText) =>
  items.length
    ? `<ul class="items">${items.map(itemRow).join('')}</ul>`
    : `<div class="empty-hint">${emptyText}</div>`;

/** 顶部状态条：执行事实优先于控制标志，统计与下方卡片同源。 */
export function chipsBar(status) {
  const ns = status.nightSystem ?? {};
  const ref = status.date;
  const chips = [];

  if (ns.lock?.alive) {
    chips.push(`<span class="chip go"><span class="d"></span>正在执行（起于 ${esc(ns.lock.lock?.startedAtLocal ?? '时间未知')}）</span>`);
  } else if (ns.lock) {
    chips.push('<span class="chip half"><span class="d"></span>存在异常残锁</span>');
  } else if (!ns.pause && !ns.stop) {
    chips.push('<span class="chip go"><span class="d"></span>夜跑就绪 · 23:00 自动执行</span>');
  }
  if (ns.pause) chips.push(`<span class="chip hold"><span class="d"></span>${ns.lock?.alive ? '后续夜跑已暂停' : '夜跑已暂停'}</span>`);
  if (ns.stop) chips.push(`<span class="chip wait"><span class="d"></span>${ns.lock?.alive ? '收尾退出中' : 'STOP 阻止启动'}</span>`);

  const last = ns.last;
  if (last?.summary) {
    const s = last.summary;
    const dStr = shortDate(last.date, ref);
    const total = Number(s.done || 0) + Number(s.unfinished || 0) + Number(s.blocked || 0);
    if (total === 0) {
      chips.push(`<span class="chip"><span class="d"></span>上次（${esc(dStr)}）：无待跑任务</span>`);
    } else {
      const parts = [`完成 ${s.done}`];
      if (Number(s.unfinished)) parts.push(`未完成 ${s.unfinished}`);
      if (Number(s.blocked)) parts.push(`搁置 ${s.blocked}`);
      chips.push(`<span class="chip done"><span class="d"></span>上次（${esc(dStr)}）：${esc(parts.join(' · '))}</span>`);
    }
  } else {
    chips.push(`<span class="chip"><span class="d"></span>${last ? `上次（${esc(shortDate(last.date, ref))}）：${esc(last.note ?? '无记录')}` : '尚无夜跑记录'}</span>`);
  }

  const todo = runnableItems(status).length;
  const pending = pickItems(status, ['待审']).length;
  if (pending) chips.push(`<span class="chip wait"><span class="d"></span>待审 ${pending} 条</span>`);
  if (todo) chips.push(`<span class="chip go"><span class="d"></span>可执行 ${todo} 条</span>`);

  chips.push(`<span class="chip"><span class="d"></span>活跃项目 ${status.counts.active} / ${status.counts.projects}</span>`);
  if (status.counts.needsFix) chips.push(`<span class="chip half"><span class="d"></span>需补齐 ${status.counts.needsFix} 处</span>`);
  return `<div class="chips">${chips.join('')}</div>`;
}

export function pendingCard(status) {
  const items = pickItems(status, ['待审']);
  return `<div class="card-summary"><strong>${items.length}</strong> 条待审<span class="card-help">在审批窗口勾选后才会执行</span></div>` +
    itemList(items, '暂无待审任务，无需审批。');
}

export function tonightCard(status) {
  const items = runnableItems(status);
  const paused = status.nightSystem?.pause;
  return `<div class="card-summary"><strong>${items.length}</strong> 条可执行<span class="card-help">${paused ? '夜跑已暂停；队列保留' : '未完成优先接续；按每晚限额执行，剩余顺延'}</span></div>` +
    itemList(items, '暂无可执行任务；待审条目获批后才会进入队列。');
}

/**
 * 补充视图：显示搁置及非活跃项目的待跑/未完成，避免与可执行队列重复。
 */
export function queues(status) {
  const runnable = new Set(runnableItems(status));
  const rest = pickItems(status, ['未完成', '搁置', '待跑']).filter((it) => !runnable.has(it));
  if (!rest.length) {
    return '<div class="quiet-bar">暂无搁置或非活跃项目的排队任务</div>';
  }
  return (
    `<div class="card sub-card"><div class="card-h"><b>暂未进入可执行队列</b>` +
    `<span class="muted small num">共 ${rest.length} 条 · 搁置或项目非活跃，展开查看详情</span></div>` +
    `<ul class="items">${rest.map(itemRow).join('')}</ul></div>`
  );
}

/** 把项目的下一步（可能用分号分隔多件事）渲染成清晰的条目 */
function renderNext(nextText) {
  const raw = String(nextText ?? '').trim();
  if (!raw) return '<span class="muted">（未写下一步）</span>';
  const parts = raw
    .split(/[；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1 && raw.length <= 96) {
    return `<div class="next-single">${fmtInline(raw)}</div>`;
  }
  return (
    `<details class="next-detail"><summary>${fmtInline(clip(parts[0], 78))}` +
    `<span class="detail-hint">${parts.length > 1 ? `共 ${parts.length} 项，展开查看` : '展开全文'}</span></summary>` +
    `<ul class="next-list">${parts.map((p) => `<li>${fmtInline(p)}</li>`).join('')}</ul></details>`
  );
}

/** 项目一览：三列结构（项目与状态 / 下一步计划 / 最近更新），零值不占版面 */
export function projects(status) {
  const ref = status.date;
  const rows = (status.projects ?? []).map((p) => {
    const rawStatus = String(p.status ?? '?');
    const badge = ['活跃', '暂停', '已完成', '归档'].includes(rawStatus) ? rawStatus : '待规范';
    const statusCls = badge === '活跃' ? 'b-go' : badge === '已完成' ? 'b-done' : badge === '待规范' ? 'b-wait' : 'b-muted';

    const c = p.night?.counts ?? {};
    const nightBadges = [];
    if (c['待审']) nightBadges.push(`<span class="b b-wait">待审 ${c['待审']}</span>`);
    if (c['待跑']) nightBadges.push(`<span class="b b-go">待跑 ${c['待跑']}</span>`);
    if (c['未完成']) nightBadges.push(`<span class="b b-half">未完成 ${c['未完成']}</span>`);
    if (c['搁置']) nightBadges.push(`<span class="b b-hold">搁置 ${c['搁置']}</span>`);
    if (p.dirty) nightBadges.push(`<span class="b b-half">未提交 ${p.dirty}</span>`);

    const upd = shortDate(p.updated ?? '', ref);
    const repoInfo = p.repo ? `${p.commits} 次提交` : '无 git';

    return (
      `<tr>` +
      `<td title="${esc(p.desc ?? '')}">` +
      `<div class="proj-head"><a href="${esc(fileUrl(`${p.rel}/README.md`))}"><b>${esc(p.rel.replace(/^WorkFlows\//, ''))}</b></a>` +
      `<span class="b ${statusCls}" title="${esc(rawStatus)}">${esc(badge)}</span>` +
      `${nightBadges.join('')}</div>` +
      `<div class="proj-desc">${fmtInline(clip(p.desc ?? '', 52))}</div>` +
      (badge === '待规范' ? '<div class="warn small">README 状态值不规范</div>' : '') +
      `</td>` +
      `<td>${renderNext(p.next)}</td>` +
      `<td class="n" title="${esc(p.updated ?? '')}">` +
      `<div class="upd-time">${esc(upd)}</div>` +
      `<div class="muted small">${esc(repoInfo)}</div>` +
      `</td>` +
      `</tr>`
    );
  });
  return rows.length
    ? '<div class="table-scroll" role="region" aria-label="项目一览表" tabindex="0"><table><colgroup><col style="width:32%"><col style="width:52%"><col style="width:16%"></colgroup>' +
        '<thead><tr><th>项目</th><th>下一步重点</th><th>最近更新</th></tr></thead><tbody>' +
        rows.join('') +
        '</tbody></table></div>'
    : '<div class="empty-hint">还没有项目。</div>';
}

/** 今日推进：一行一项目，清爽展示提交次数与最新主题 */
export function progress(status) {
  const rows = [];
  for (const p of status.projects ?? []) {
    const commits = p.day?.commits ?? [];
    if (!commits.length && !p.day?.log && !p.day?.dirty) continue;
    const first = commits[0]
      ? commits[0].replace(/^\S+\s+\S+\s+/, '')
      : (p.day?.log?.split(/\r?\n/)[0]?.replace(/^[-·\s]+/, '') ?? '');
    const name = p.rel.replace(/^WorkFlows\//, '');
    rows.push(
      `<tr><td><b>${esc(name)}</b></td>` +
        `<td class="n">${commits.length ? `<span class="b b-done">${commits.length} 次提交</span>` : '<span class="muted">—</span>'}` +
        `${p.day?.dirty ? ` <span class="b b-half">未提交 ${p.day.dirty}</span>` : ''}</td>` +
        `<td title="${esc(first)}">${fmtInline(clip(first, 68))}</td></tr>`,
    );
  }
  return rows.length
    ? '<div class="table-scroll" role="region" aria-label="当日推进表" tabindex="0"><table><colgroup><col style="width:24%"><col style="width:20%"><col style="width:56%"></colgroup>' +
        '<thead><tr><th>项目</th><th>当日提交</th><th>最新进展</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>'
    : '<div class="quiet-bar">所选日期各项目暂无提交、日志或未提交改动</div>';
}

/** 夜跑历史：合并零值列，一眼看清每次夜跑结果 */
export function history(status, limit = 7) {
  const ref = status.date;
  const rows = (status.nightSystem?.history ?? []).slice(0, limit).map((h) => {
    const s = h.summary;
    let resHtml;
    if (!s) {
      resHtml = `<span class="b b-half">无汇总</span> <span class="small">${esc(h.note ?? '请查看报告排查')}</span>`;
    } else {
      const done = Number(s.done || 0);
      const unf = Number(s.unfinished || 0);
      const blk = Number(s.blocked || 0);
      if (done === 0 && unf === 0 && blk === 0) {
        resHtml = '<span class="muted small">无待跑任务</span>';
      } else {
        const badges = [];
        if (done) badges.push(`<span class="b b-go">完成 ${done}</span>`);
        if (unf) badges.push(`<span class="b b-half">未完成 ${unf}</span>`);
        if (blk) badges.push(`<span class="b b-muted">搁置 ${blk}</span>`);
        resHtml = badges.join(' ');
      }
    }
    const finishInfo = [s?.finish ? `${esc(s.finish)} 收尾` : null, h.morning ? '已早检' : null].filter(Boolean).join(' · ') || '—';
    return (
      `<tr><td class="n" title="${esc(h.date)}"><b>${esc(shortDate(h.date, ref))}</b></td>` +
      `<td>${resHtml}</td>` +
      `<td class="n muted small">${finishInfo}</td>` +
      `<td class="n">${h.report ? `<a href="${esc(fileUrl(h.report))}">查看报告</a>` : '—'}</td></tr>`
    );
  });
  if (!rows.length) return '<div class="quiet-bar">还没有夜跑记录</div>';
  return (
    '<div class="table-scroll" role="region" aria-label="夜跑历史表" tabindex="0"><table><colgroup><col style="width:22%"><col style="width:34%"><col style="width:28%"><col style="width:16%"></colgroup>' +
    '<thead><tr><th>日期</th><th>执行结果</th><th>收尾状态</th><th>详情</th></tr></thead><tbody>' +
    rows.join('') +
    '</tbody></table></div>'
  );
}

export function needsFix(status) {
  const list = status.needsFix ?? [];
  if (!list.length) return '<div class="quiet-bar ok-bar">✓ 未发现文件或必填字段缺项；项目状态值请见项目一览</div>';
  return (
    '<div class="card"><ul class="items">' +
    list
      .map((f) => `<li title="${esc(f.fix ?? '')}"><span class="dot half"></span><span class="st">待补齐</span><span class="ti"><code>${esc(f.rel)}</code> ${esc(f.what)}</span></li>`)
      .join('') +
    '</ul></div>'
  );
}

/** 单行截断（放这里统一口径：超长就加 …，全文交给 title 提示） */
function clip(text, maxChars) {
  const s = String(text ?? '').replace(/\s*\n+\s*/g, ' ').trim();
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}
