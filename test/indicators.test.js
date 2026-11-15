import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCellTable, sampleMoments, aggregateCells } from '../src/indicators.js';

const base = (overrides, index) => ({
  id: `r${index}`, cell: `c${index}`, district: 'd0',
  visitors: 10, served: 2, x: index, y: 0, ...overrides,
});

test('服务率为 served/visitors，零访问量格网被排除而非按零服务率纳入', () => {
  const records = [
    base({ cell: 'c1', visitors: 0, served: 0 }, 1),
    base({ cell: 'c2', visitors: 10, served: 5 }, 2),
    base({ cell: 'c3', visitors: 20, served: 5 }, 3),
  ];
  const table = buildCellTable(records, 'rate');
  assert.equal(table.kind, 'rate');
  assert.equal(table.estimableCells, 2);
  const excluded = table.excludedCells.find(entry => entry.cell === 'c1');
  assert.ok(excluded.reason.includes('零访问量'));
  const c2 = table.rows.find(row => row.cell === 'c2');
  assert.equal(c2.value, 0.5);
  assert.equal(c2.estimable, true);
  // 关键约束：零访问量格网没有数值，绝不是 0
  const c1 = table.rows.find(row => row.cell === 'c1');
  assert.equal(c1.value, null);
  assert.equal(c1.estimable, false);
});

test('计数指标包含零服务格网；缺口指标为 visitors-served 且拒绝负值', () => {
  const countTable = buildCellTable([base({ cell: 'c1', served: 0 }, 1)], 'count');
  assert.equal(countTable.rows[0].value, 0);
  assert.equal(countTable.rows[0].estimable, true);
  const gapTable = buildCellTable([base({ cell: 'c1', visitors: 10, served: 4 }, 1)], 'gap');
  assert.equal(gapTable.rows[0].value, 6);
  const bad = buildCellTable([base({ cell: 'c1', visitors: 1, served: 2 }, 1)], 'gap');
  assert.equal(bad.rows[0].estimable, false);
  assert.ok(bad.rows[0].reason.includes('缺口为负'));
  assert.equal(bad.estimableCells, 0);
});

test('同格网多行先聚合再算指标，并校验标签一致性', () => {
  const records = [
    base({ cell: 'c1', visitors: 30, served: 3, x: 1, y: 0 }, 1),
    base({ cell: 'c1', visitors: 70, served: 7, id: 'r2', x: 1, y: 0 }, 2),
  ];
  const aggregated = aggregateCells(records);
  assert.equal(aggregated[0].visitors, 100);
  assert.equal(aggregated[0].served, 10);
  const table = buildCellTable(records, 'rate');
  assert.equal(table.rows[0].value, 0.1);
  assert.throws(() => buildCellTable([
    base({ cell: 'c1', district: 'd0' }, 1),
    base({ cell: 'c1', district: 'd1', id: 'r2' }, 2),
  ], 'count'), /不一致/);
});

test('总体矩用 n 做分母，常数序列被标记', () => {
  const values = new Map([['a', 1], ['b', 3]]);
  const moments = sampleMoments(values, ['a', 'b']);
  assert.equal(moments.mean, 2);
  assert.equal(moments.standardDeviation, 1);
  assert.equal(moments.constant, false);
  const constant = sampleMoments(new Map([['a', 5], ['b', 5]]), ['a', 'b']);
  assert.equal(constant.standardDeviation, 0);
  assert.equal(constant.constant, true);
});

test('未知指标类型被拒绝', () => {
  assert.throws(() => buildCellTable([base({}, 1)], 'unknown'), /count\/rate\/gap/);
});
