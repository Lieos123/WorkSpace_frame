import assert from 'node:assert/strict';
import test from 'node:test';
import { itemRow, shortDate } from './lib.mjs';
import * as sections from './sections.mjs';

const task = (state, text, file = 'NIGHT.md') => ({ state, text, file, line: 12 });
const workspaceTodo = task('待跑', '工作区新任务');
const workspaceResume = task('未完成', '工作区接续');
const projectTodo = task('待跑', '项目新任务', '活跃项目/NIGHT.md');
const projectResume = task('未完成', '项目接续', '活跃项目/NIGHT.md');
const pausedTodo = task('待跑', '暂停项目任务', '暂停项目/NIGHT.md');
const pausedResume = task('未完成', '暂停项目接续', '暂停项目/NIGHT.md');
const held = task('搁置', '等待外部条件');
const pending = task('待审', '等待用户批准');
const status = {
  date: '2026-10-16',
  counts: { projects: 2, active: 1, needsFix: 0 },
  workspace: { night: { items: [workspaceTodo, pending, held, workspaceResume] } },
  projects: [
    { rel: '活跃项目', status: '活跃', night: { items: [projectTodo, projectResume] } },
    { rel: '暂停项目', status: '暂停', night: { items: [pausedTodo, pausedResume] } },
  ],
  nightSystem: { pause: false, stop: false, lock: null, history: [] },
};

test('可执行队列按工作区、活跃项目排列，每级未完成优先，不含待审和暂停项目', () => {
  assert.equal(typeof sections.runnableItems, 'function');
  assert.deepEqual(sections.runnableItems(status).map((item) => item.text), [
    '工作区接续', '工作区新任务', '项目接续', '项目新任务',
  ]);
});

test('队列卡片包含接续任务并说明顺延，不能把积压承诺成当晚全部执行', () => {
  const html = sections.tonightCard(status);
  assert.match(html, /工作区接续/);
  assert.match(html, /项目接续/);
  assert.match(html, /顺延/);
  assert.doesNotMatch(html, /暂停项目任务|等待用户批准|等待外部条件/);
  assert.match(sections.chipsBar(status), /可执行 4 条/);
});

test('补充清单保留搁置和暂停项目任务，不重复可执行队列', () => {
  const html = sections.queues(status);
  assert.match(html, /等待外部条件/);
  assert.match(html, /暂停项目任务/);
  assert.match(html, /暂停项目接续/);
  assert.doesNotMatch(html, /工作区接续|项目新任务/);
});

test('运行中同时收到暂停标志时仍显示执行事实，并说明后续暂停', () => {
  const html = sections.chipsBar({ ...status, nightSystem: {
    pause: true, stop: false, lock: { alive: true, lock: { startedAtLocal: '2026-10-16 09:00' } },
  } });
  assert.match(html, /正在执行/);
  assert.match(html, /后续夜跑已暂停/);
});

test('运行中收到 STOP 时清楚展示收尾，不能隐藏正在执行', () => {
  const html = sections.chipsBar({ ...status, nightSystem: {
    pause: false, stop: true, lock: { alive: true, lock: { startedAtLocal: '2026-10-16 09:00' } },
  } });
  assert.match(html, /正在执行/);
  assert.match(html, /收尾退出/);
});

test('无运行时残锁、PAUSE 与 STOP 分别展示，不能互相掩盖', () => {
  for (const lock of [null, { alive: false }]) {
    const html = sections.chipsBar({ ...status, nightSystem: { pause: true, stop: true, lock } });
    assert.match(html, /夜跑已暂停/);
    assert.match(html, /STOP 阻止启动/);
    assert.doesNotMatch(html, /收尾退出中/);
    if (lock) assert.match(html, /存在异常残锁/);
  }
});

test('失败记录即使没有汇总也保留报告入口', () => {
  const html = sections.history({ ...status, nightSystem: { history: [{
    date: '2026-10-15', summary: null, note: '执行失败，无汇总',
    report: '_night/runs/2026-10-15-night.md',
  }] } });
  assert.match(html, /执行失败，无汇总/);
  assert.match(html, /href="file:\/\/\/.*2026-10-15-night\.md"/);
});

test('任务正文提供原生展开入口，说明与来源保留在正文且进行 HTML 转义', () => {
  const html = itemRow(task('待审', '修正 `<按钮>` | 完整验收 <script>危险</script> | 用户 2026-10-16'));
  assert.match(html, /<details\b/);
  assert.match(html, /<summary\b/);
  assert.match(html, />[^<]*完整验收 &lt;script&gt;危险&lt;\/script&gt;/);
  assert.match(html, /NIGHT\.md:12/);
  assert.doesNotMatch(html, /<script>/);
});

test('长下一步的末尾在正文可读，不仅仅在 title 属性中', () => {
  const next = `${'检查显示逻辑；'.repeat(24)}最终验收入口`;
  const html = sections.projects({ ...status, projects: [{
    rel: '活跃项目', status: '活跃', next, desc: '示例', repo: true, commits: 3,
  }] });
  assert.match(html, /<details\b/);
  assert.match(html, />最终验收入口</);
});

test('非规范状态不应被截成活跃，与快照活跃统计保持一致', () => {
  const html = sections.projects({ ...status, projects: [{
    rel: 'Skills', status: '活跃（附加说明）', next: '检查状态值', repo: true, commits: 3,
  }] });
  assert.match(html, />待规范</);
  assert.match(html, /README 状态值不规范/);
  assert.doesNotMatch(html, /class="b b-go"[^>]*>活跃</);
  assert.match(sections.needsFix({ needsFix: [] }), /未发现文件或必填字段缺项/);
});

test('跨年日期保留年份，避免旧记录被误读为本年', () => {
  assert.equal(shortDate('2025-10-16 09:00', '2026-10-16'), '2025-10-16 09:00');
  assert.equal(shortDate('2026-10-15 09:00', '2026-10-16'), '昨天 09:00');
});

test('空工作区各分区均有可理解的空状态', () => {
  const empty = { date: status.date, counts: { active: 0, projects: 0, needsFix: 0 }, projects: [] };
  assert.match(sections.pendingCard(empty), /暂无待审/);
  assert.match(sections.tonightCard(empty), /暂无可执行/);
  assert.match(sections.history(empty), /还没有夜跑记录/);
  assert.match(sections.projects(empty), /还没有项目/);
});
