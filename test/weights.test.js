import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeightSet, inspectEdges, restrictToSample } from '../src/weights.js';

const cells = ['a', 'b', 'c', 'd'];
const bidirected = (pairs, weights = {}) => pairs.flatMap(([left, right]) => [
  { left, right, weight: weights[`${left}-${right}`] ?? 1 },
  { left: right, right: left, weight: weights[`${right}-${left}`] ?? 1 },
]);

test('干净 2x2 格网：无缺陷、行权重求和为 1、孤岛为空', () => {
  const edges = bidirected([['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
  const set = buildWeightSet(edges, cells, { standardization: 'row', radii: [1] });
  const diagnostics = set.radii[0].diagnostics;
  assert.equal(diagnostics.selfLoops.length, 0);
  assert.equal(diagnostics.duplicateEdges.length, 0);
  assert.equal(diagnostics.asymmetricPairs.length, 0);
  assert.deepEqual(diagnostics.islands, []);
  for (const id of cells) {
    const row = set.radii[0].neighborRows.get(id);
    assert.equal(row.length, 2);
    assert.equal(Math.abs(row.reduce((sum, entry) => sum + entry.weight, 0) - 1) < 1e-12, true);
  }
});

test('自邻接、重复边被剔除计数；悬空引用直接拒绝', () => {
  const edges = [
    ...bidirected([['a', 'b']]),
    { left: 'c', right: 'c', weight: 1 },
    { left: 'a', right: 'b', weight: 1 },
  ];
  const { diagnostics } = inspectEdges(edges, cells);
  assert.deepEqual(diagnostics.selfLoops, ['c']);
  assert.deepEqual(diagnostics.duplicateEdges, [{ left: 'a', right: 'b' }]);
  assert.throws(() => inspectEdges([{ left: 'a', right: 'zzz', weight: 1 }], cells), /不在数据中/);
});

test('不对称只报告不补边，且保留原始方向权重', () => {
  const edges = [{ left: 'a', right: 'b', weight: 1 }, { left: 'b', right: 'a', weight: 1 },
    { left: 'b', right: 'c', weight: 2 }];
  const { diagnostics, outgoing } = inspectEdges(edges, cells);
  assert.deepEqual(diagnostics.asymmetricPairs, [{ left: 'b', right: 'c' }]);
  assert.equal(outgoing.get('c').size, 0);
  assert.equal(outgoing.get('b').get('c'), 2);
});

test('孤岛被识别并在样本裁剪后标记无法估计', () => {
  const edges = bidirected([['a', 'b']]);
  const set = buildWeightSet(edges, cells, { radii: [1] });
  assert.deepEqual(set.radii[0].diagnostics.islands, ['c', 'd']);
  const sample = restrictToSample(set.cellIds, set.radii[0], cells, 2);
  assert.deepEqual(sample.islands, ['c', 'd']);
});

test('原始边权模式不归一化；半径 2 由 BFS 派生且二值', () => {
  const edges = bidirected([['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
  const raw = buildWeightSet(edges, cells, { standardization: 'raw', radii: [1] });
  assert.equal(raw.radii[0].neighborRows.get('a')[0].weight, 1);
  const wide = buildWeightSet(edges, cells, { radii: [1, 2] });
  const atTwo = wide.radii.find(entry => entry.radius === 2);
  // 2x2 图中任意两格距离不超过 2
  assert.equal(atTwo.neighborRows.get('a').length, 3);
  assert.ok(atTwo.neighborRows.get('a').every(entry => entry.weight === 1 / 3));
});

test('非单位边权拒绝多半径派生，避免擅自设定距离衰减', () => {
  const edges = bidirected([['a', 'b']], { 'a-b': 3 });
  assert.throws(() => buildWeightSet(edges, cells, { radii: [1, 2] }), /单位边权/);
});

test('样本裁剪会剔除样本外邻居并重新行标准化', () => {
  const edges = bidirected([['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
  const set = buildWeightSet(edges, cells, { radii: [1] });
  const sample = restrictToSample(set.cellIds, set.radii[0], ['a', 'b', 'c'], 2);
  const rowA = sample.neighborRows.get('a');
  assert.deepEqual(rowA.map(entry => entry.cell).sort(), ['b', 'c']);
  assert.equal(Math.abs(rowA.reduce((sum, entry) => sum + entry.weight, 0) - 1) < 1e-12, true);
  // d 被排除后，b 仅剩 a 一个邻居 -> 邻居不足
  assert.deepEqual(sample.insufficient, ['b', 'c']);
});

test('非法权重和参数被拒绝', () => {
  assert.throws(() => inspectEdges([{ left: 'a', right: 'b', weight: 0 }], cells), /正数/);
  assert.throws(() => inspectEdges([{ left: 'a', right: 'b', weight: -1 }], cells), /正数/);
  assert.throws(() => buildWeightSet([], cells, { radii: [0] }), /正整数/);
  assert.throws(() => buildWeightSet([], cells, { standardization: 'queen' }), /row 或 raw/);
});
