import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeightSet, restrictToSample } from '../src/weights.js';
import {
  moranGlobal, globalPermutationTest, localPermutationTest,
  runLocalAnalysis, clusterType, benjaminiHochberg, bonferroni,
} from '../src/moran.js';

const squareIds = ['a', 'b', 'c', 'd'];
const squarePairs = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']];
const squareEdges = squarePairs.flatMap(([left, right]) => [
  { left, right, weight: 1 }, { left: right, right: left, weight: 1 },
]);
const buildSquare = (standardization = 'row') => {
  const set = buildWeightSet(squareEdges, squareIds, { standardization, radii: [1] });
  return restrictToSample(set.cellIds, set.radii[0], squareIds, 2);
};
const zFrom = (ids, values) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return new Map(ids.map((id, index) => [id, (values[index] - mean) / sd]));
};
const uniformDistricts = ids => new Map(ids.map(id => [id, 'd0']));

test('常数指标无法估计 Moran I，并给出明确原因', () => {
  const sample = buildSquare();
  const z = new Map(squareIds.map(id => [id, 0]));
  assert.equal(moranGlobal(z, sample.neighborRows, squareIds), null);
  const result = globalPermutationTest({
    zById: z, neighborRows: sample.neighborRows, ids: squareIds, permutations: 99, seed: 1, exact: false,
  });
  assert.equal(result.estimable, false);
  assert.ok(result.reason.includes('常数'));
});

test('精确枚举：2x2 棋盘值遍历全部 24 种排列，p 值与手工枚举一致', () => {
  const sample = buildSquare('raw');
  const z = zFrom(squareIds, [1, 2, 3, 4]);
  const result = globalPermutationTest({
    zById: z, neighborRows: sample.neighborRows, ids: squareIds, permutations: 99, seed: 1, exact: true,
  });
  assert.equal(result.pseudoCount, 24);
  assert.equal(result.exact, true);
  // 手工推导：该对称棋盘格局 I=0；24 个排列中 8 个 I>=0，+1 校正后 9/25=0.36
  assert.equal(result.observed, 0);
  assert.equal(result.pseudoPValue, 0.36);
  // 解析零假设期望 -1/(n-1)，与置换均值一致
  assert.equal(Math.abs(result.expectedAnalytic + 1 / 3) < 1e-12, true);
  assert.equal(Math.abs(result.permutationMean + 1 / 3) < 1e-12, true);
});

test('局部条件置换固定焦点：参考池不含焦点，逐焦点独立随机流且可复现', () => {
  const sample = buildSquare();
  const z = zFrom(squareIds, [1, 2, 3, 4]);
  const result = localPermutationTest({
    id: 'a', zById: z, neighborRows: sample.neighborRows, ids: squareIds,
    districtById: uniformDistricts(squareIds), scope: 'city', permutations: 99, seed: 71,
    exact: true, minPermutationPool: 2,
  });
  assert.equal(result.exact, true);
  assert.equal(result.permutationPoolSize, 3); // 焦点 a 固定，其余 3 个位置重排
  assert.equal(result.pseudoCount, 6);
  const other = localPermutationTest({
    id: 'b', zById: z, neighborRows: sample.neighborRows, ids: squareIds,
    districtById: uniformDistricts(squareIds), scope: 'city', permutations: 99, seed: 71,
    exact: false, minPermutationPool: 2,
  });
  const repeat = localPermutationTest({
    id: 'a', zById: z, neighborRows: sample.neighborRows, ids: squareIds,
    districtById: uniformDistricts(squareIds), scope: 'city', permutations: 99, seed: 71,
    exact: false, minPermutationPool: 2,
  });
  // 精确模式不使用随机流（streamSeed 为 null）；蒙特卡洛模式下逐焦点种子不同但同焦点可复现
  assert.equal(result.streamSeed, null);
  assert.notEqual(repeat.streamSeed, other.streamSeed);
  const exactRepeat = localPermutationTest({
    id: 'a', zById: z, neighborRows: sample.neighborRows, ids: squareIds,
    districtById: uniformDistricts(squareIds), scope: 'city', permutations: 99, seed: 71,
    exact: true, minPermutationPool: 2,
  });
  assert.equal(result.pseudoPValue, exactRepeat.pseudoPValue);
});

test('蒙特卡洛置换次数与 +1 校正：任何 p 值不小于 1/(R+1)', () => {
  const sample = buildSquare();
  const z = zFrom(squareIds, [1, 2, 3, 4]);
  const result = globalPermutationTest({
    zById: z, neighborRows: sample.neighborRows, ids: squareIds, permutations: 99, seed: 1, exact: false,
  });
  assert.equal(result.pseudoCount, 99);
  assert.ok(result.pseudoPValue >= 1 / 100 && result.pseudoPValue <= 1);
  const local = runLocalAnalysis({
    ids: squareIds, zById: z, neighborRows: sample.neighborRows,
    districtById: uniformDistricts(squareIds), scope: 'city',
    permutations: 99, seed: 1, exact: false, alpha: 0.05,
    minNeighbors: 2, minPermutationPool: 2,
  });
  for (const cell of local.cells) assert.ok(cell.pseudoPValue >= 1 / 100);
});

test('强空间趋势在 5 格链上给出正的全局 I，置换显著而常数格局不显著', () => {
  const chainIds = ['a', 'b', 'c', 'd', 'e'];
  const chainPairs = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']];
  const chainEdges = chainPairs.flatMap(([left, right]) => [
    { left, right, weight: 1 }, { left: right, right: left, weight: 1 },
  ]);
  const set = buildWeightSet(chainEdges, chainIds, { radii: [1] });
  const sample = restrictToSample(set.cellIds, set.radii[0], chainIds, 1);
  const trend = zFrom(chainIds, [1, 2, 3, 4, 5]);
  const observed = moranGlobal(trend, sample.neighborRows, chainIds);
  assert.ok(observed > 0.5);
  const tested = globalPermutationTest({
    zById: trend, neighborRows: sample.neighborRows, ids: chainIds,
    permutations: 99, seed: 1, exact: false,
  });
  assert.ok(tested.pseudoPValue < 0.05);
  // 同数据精确枚举 5!=120 个排列，结论方向一致
  const exact = globalPermutationTest({
    zById: trend, neighborRows: sample.neighborRows, ids: chainIds,
    permutations: 9, seed: 1, exact: true,
  });
  assert.equal(exact.pseudoCount, 120);
  assert.equal(exact.observed, observed);
});

test('岛状格网与有效邻居不足显示无法估计，不产出伪指标', () => {
  const allIds = ['a', 'b', 'c', 'd', 'island'];
  const set = buildWeightSet(squareEdges, allIds, { radii: [1] });
  const sample = restrictToSample(set.cellIds, set.radii[0], allIds, 2);
  assert.deepEqual(sample.islands, ['island']);
  const z = new Map(allIds.map((id, index) => [id, index * 0.1 - 0.2]));
  const local = runLocalAnalysis({
    ids: allIds, zById: z, neighborRows: sample.neighborRows,
    districtById: new Map(allIds.map(id => [id, 'd0'])),
    scope: 'city', permutations: 99, seed: 1, exact: false, alpha: 0.05,
    minNeighbors: 2, minPermutationPool: 2,
  });
  const island = local.cells.find(cell => cell.cell === 'island');
  assert.equal(island.estimable, false);
  assert.ok(island.reason.includes('岛状格网'));
  assert.equal(island.localI, undefined);
});

test('区县内置换只在同区县参考池重排；参考池不足时显示无法估计', () => {
  const sample = buildSquare();
  const z = zFrom(squareIds, [1, 2, 3, 4]);
  const split = new Map([['a', 'd0'], ['b', 'd0'], ['c', 'd1'], ['d', 'd1']]);
  const city = localPermutationTest({
    id: 'a', zById: z, neighborRows: sample.neighborRows, ids: squareIds,
    districtById: split, scope: 'city', permutations: 99, seed: 1, exact: true, minPermutationPool: 2,
  });
  const within = localPermutationTest({
    id: 'a', zById: z, neighborRows: sample.neighborRows, ids: squareIds,
    districtById: split, scope: 'district', permutations: 99, seed: 1, exact: true, minPermutationPool: 1,
  });
  assert.equal(city.permutationPoolSize, 3);
  assert.equal(within.estimable, true);
  assert.equal(within.permutationPoolSize, 1); // 同区县仅 b 一个候选
  const blocked = localPermutationTest({
    id: 'a', zById: z, neighborRows: sample.neighborRows, ids: squareIds,
    districtById: split, scope: 'district', permutations: 99, seed: 1, exact: true, minPermutationPool: 2,
  });
  assert.equal(blocked.estimable, false);
  assert.ok(blocked.reason.includes('置换位置不足'));
});

test('集聚四分类与符号规则一致', () => {
  assert.equal(clusterType(1, 1), 'HH');
  assert.equal(clusterType(-1, -1), 'LL');
  assert.equal(clusterType(1, -1), 'HL');
  assert.equal(clusterType(-1, 1), 'LH');
  assert.equal(clusterType(0, 1), 'NS');
});

test('Bonferroni 与 BH-FDR 校正家族大小完整且取值合法', () => {
  const pairs = squareIds.map((id, index) => ({ id, p: [0.01, 0.04, 0.03, 0.9][index] }));
  const bonf = bonferroni(pairs);
  assert.equal(bonf.get('a'), 0.04);
  assert.equal(bonf.get('d'), 1);
  const bh = benjaminiHochberg(pairs);
  for (const { id, p } of pairs) {
    assert.ok(bh.get(id) >= p - 1e-12 && bh.get(id) <= 1);
  }
});

test('局部 I 之和除以 n 等于全局 I（行标准化恒等式）', () => {
  const sample = buildSquare();
  const z = zFrom(squareIds, [1, 2, 3, 4]);
  const globalI = moranGlobal(z, sample.neighborRows, squareIds);
  const local = runLocalAnalysis({
    ids: squareIds, zById: z, neighborRows: sample.neighborRows,
    districtById: uniformDistricts(squareIds), scope: 'city',
    permutations: 99, seed: 1, exact: true, alpha: 0.05,
    minNeighbors: 2, minPermutationPool: 2,
  });
  const meanLocal = local.cells.reduce((sum, cell) => sum + cell.localI, 0) / squareIds.length;
  assert.equal(Math.abs(meanLocal - globalI) < 1e-12, true);
});

test('每个单元都输出邻居、标准化值与焦点固定的置换设置供复核', () => {
  const sample = buildSquare();
  const z = zFrom(squareIds, [1, 2, 3, 4]);
  const local = runLocalAnalysis({
    ids: squareIds, zById: z, neighborRows: sample.neighborRows,
    districtById: uniformDistricts(squareIds), scope: 'city',
    permutations: 99, seed: 1, exact: false, alpha: 0.05,
    minNeighbors: 2, minPermutationPool: 2,
  });
  for (const cell of local.cells) {
    assert.equal(cell.neighbors.length, 2);
    assert.ok(cell.neighbors.every(entry => typeof entry.standardValue === 'number' && entry.weight > 0));
    assert.equal(cell.permutation.focalFixed, true);
    assert.equal(cell.permutation.focal, cell.cell);
    assert.ok(!cell.permutation.referencePool.includes(cell.cell));
    assert.equal(cell.permutation.scope, 'city');
    assert.equal(typeof cell.permutation.seed, 'number');
  }
});
