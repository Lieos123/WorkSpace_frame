import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('真实 status CLI 统一分类：功能库及工作流不计入业务项目，原仓库列表仍完整保留', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-groups-'));
  t.after(() => {
    const rel = path.relative(os.tmpdir(), root);
    assert.ok(rel.startsWith('ws-groups-') && !rel.includes(path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.copyFileSync(new URL('../ws.mjs', import.meta.url), path.join(root, 'ws.mjs'));
  for (const rel of ['Skills', 'Tools', '审批窗口', '订单系统', 'WorkFlows/周报', 'WorkFlowsPlus']) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, rel, 'README.md'), `---\ndesc: ${rel}说明\nstatus: 活跃\nnext: 验证展示\n---\n`);
  }
  fs.writeFileSync(path.join(root, 'WorkFlows/README.md'), '---\nkind: 容器\ndesc: 工作流\n---\n');
  const result = spawnSync(process.execPath, [path.join(root, 'ws.mjs'), 'status', '--json'], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.schema, 'workspace-status/1');
  assert.equal(status.counts.projects, 5);
  assert.equal(status.counts.businessProjects, 2);
  assert.equal(status.counts.activeBusinessProjects, 2);
  assert.equal(status.counts.functionalGroups, 4);
  assert.deepEqual(status.functionalGroups.map((g) => g.id), ['skills', 'tools', 'workflows', 'shared']);
  assert.equal(status.projects.find((p) => p.rel === 'Skills').group, 'skills');
  assert.equal(status.projects.find((p) => p.rel === 'WorkFlows/周报').group, 'workflows');
  assert.equal(status.projects.find((p) => p.rel === '审批窗口').group, 'shared');
  assert.equal(status.projects.find((p) => p.rel === 'WorkFlowsPlus').group, 'business');
  assert.equal(status.projects.find((p) => p.rel === '订单系统').group, 'business');
  assert.ok(!status.projects.some((p) => p.rel === 'Tools'));
});
