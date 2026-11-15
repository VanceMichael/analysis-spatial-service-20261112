import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildWeightSet } from '../src/weights.js';
import { runSpatialAnalysis } from '../src/spatial.js';
import { buildChineseSummary } from '../src/report.js';
import { parseArguments } from '../src/cli.js';

// 线形小图：a-b-c-d 一条链，外加一个孤岛。
function linearEdges() {
  const pairs = [['a', 'b'], ['b', 'c'], ['c', 'd']];
  return pairs.flatMap(([left, right]) => [
    { left, right, weight: 1 }, { left: right, right: left, weight: 1 },
  ]);
}
const record = (cell, district, visitors, served, x, y) => ({
  id: `id-${cell}`, cell, district, visitors, served, x, y,
});
const linearRecords = [
  record('a', 'd0', 100, 10, 0, 0),
  record('b', 'd0', 100, 20, 1, 0),
  record('c', 'd1', 100, 30, 2, 0),
  record('d', 'd1', 100, 40, 3, 0),
  record('island', 'd1', 50, 5, 9, 9),
];
const config = (overrides = {}) => ({
  metric: 'rate', radii: [1], scopes: ['city', 'district'],
  standardization: 'row', permutations: 99, seed: 71, alpha: 0.05,
  exact: false, minNeighbors: 2, minPermutationPool: 2, weightsPath: 'inline',
  ...overrides,
});
const run = (records, edges, overrides = {}) => {
  const cfg = { ...config(), ...overrides };
  const cellIds = [...new Set(records.map(row => row.cell))];
  const weightSet = buildWeightSet(edges, cellIds, { standardization: cfg.standardization, radii: cfg.radii });
  return runSpatialAnalysis(records, weightSet, cfg);
};

test('线形小图：线性指标给出强正自相关，孤岛全程标记无法估计且样本去向完整', () => {
  const document = run(linearRecords, linearEdges(), { minNeighbors: 1 });
  const analysis = document.analyses[0];
  assert.equal(analysis.sample.totalCells, 5);
  assert.equal(analysis.sample.analysisCells, 4);
  assert.deepEqual(analysis.sample.islands, ['island']);
  assert.ok(analysis.sample.droppedByWeights.some(item => item.cell === 'island' && item.reason.includes('岛状格网')));
  assert.ok(analysis.global.observed > 0.3);
  const local = analysis.localScopes.find(scope => scope.scope === 'city');
  const island = local.cells.find(cell => cell.cell === 'island');
  assert.equal(island.estimable, false);
  assert.ok(island.reason.includes('岛状格网'));
  // 链端 a、d 只有 1 个邻居，在 minNeighbors=1 下仍可估计；内部 b、c 有 2 个
  const degree = Object.fromEntries(local.cells.filter(cell => cell.estimable)
    .map(cell => [cell.cell, cell.neighborCount]));
  assert.deepEqual(degree, { a: 1, b: 2, c: 2, d: 1 });
});

test('常数指标：全局无法估计，局部 I 恒为 0 且永不显著，不报错且样本完整登记', () => {
  const records = linearRecords.map(row => ({ ...row, visitors: 10, served: 5 }));
  // 精确枚举下零统计量的所有伪值同为 0，p 值确定性为 1，避免蒙特卡洛随机平局
  const document = run(records, linearEdges(), {
    metric: 'rate', minNeighbors: 1, minPermutationPool: 1, exact: true,
  });
  const analysis = document.analyses[0];
  assert.equal(analysis.moments.constant, true);
  assert.equal(analysis.global.estimable, false);
  assert.ok(analysis.global.reason.includes('常数'));
  for (const scope of analysis.localScopes) {
    for (const cell of scope.cells) {
      if (cell.cell === 'island') {
        assert.equal(cell.estimable, false);
      } else {
        assert.equal(cell.estimable, true);
        assert.equal(cell.standardValue, 0);
        assert.equal(cell.localI, 0);
        assert.equal(cell.pseudoPValue, 1);
        assert.equal(cell.reportedCluster, 'NS');
      }
    }
  }
  assert.equal(analysis.sample.analysisCells, 4);
});

test('零访问量格网：服务率分析排除且说明原因，计数分析仍保留该格网', () => {
  const records = [
    ...linearRecords,
    record('novisit', 'd0', 0, 0, 5, 0),
  ];
  const edges = [...linearEdges(),
    { left: 'd', right: 'novisit', weight: 1 }, { left: 'novisit', right: 'd', weight: 1 }];
  const rateDoc = run(records, edges, { metric: 'rate' });
  const excluded = rateDoc.analyses[0].sample.excludedByMetric;
  assert.ok(excluded.some(item => item.cell === 'novisit' && item.reason.includes('零访问量')));
  assert.equal(rateDoc.analyses[0].sample.estimableCells, 5);
  assert.equal(rateDoc.cellTable.find(row => row.cell === 'novisit').value, null);
  const countDoc = run(records, edges, { metric: 'count' });
  assert.equal(countDoc.analyses[0].sample.excludedByMetric.length, 0);
  assert.equal(countDoc.cellTable.find(row => row.cell === 'novisit').value, 0);
  assert.equal(countDoc.cellTable.find(row => row.cell === 'novisit').estimable, true);
});

test('需求量相差很大的格网：计数与服务率给出不同排序，口径差异显式可查', () => {
  const records = [
    record('small', 'd0', 2, 1, 0, 0),    // 服务率 0.5，计数 1
    record('big', 'd0', 10000, 1000, 1, 0), // 服务率 0.1，计数 1000
    record('x1', 'd1', 100, 10, 2, 0),
    record('x2', 'd1', 100, 10, 3, 0),
  ];
  const edges = [['small', 'big'], ['big', 'x1'], ['x1', 'x2']].flatMap(([left, right]) => [
    { left, right, weight: 1 }, { left: right, right: left, weight: 1 }]);
  const rateDoc = run(records, edges, { metric: 'rate', minNeighbors: 1 });
  const countDoc = run(records, edges, { metric: 'count', minNeighbors: 1 });
  const rateRank = rateDoc.cellTable.map(row => [row.cell, row.value]);
  const countRank = countDoc.cellTable.map(row => [row.cell, row.value]);
  assert.ok(rateRank.find(([cell]) => cell === 'small')[1] > rateRank.find(([cell]) => cell === 'big')[1]);
  assert.ok(countRank.find(([cell]) => cell === 'big')[1] > countRank.find(([cell]) => cell === 'small')[1]);
  assert.equal(rateDoc.analysis.metricLabel.denominator, 'visitors 合计');
  assert.equal(countDoc.analysis.metricLabel.denominator, null);
});

test('多半径与双置换范围完整登记：每个组合独立成节，敏感性表覆盖全部半径', () => {
  const document = run(linearRecords, linearEdges(), { radii: [1, 2], scopes: ['city', 'district'] });
  assert.equal(document.analyses.length, 2);
  for (const analysis of document.analyses) {
    assert.equal(analysis.localScopes.length, 2);
    assert.deepEqual(analysis.localScopes.map(scope => scope.scope), ['city', 'district']);
  }
  assert.deepEqual(document.sensitivity.globalTable.map(row => row.radius), [1, 2]);
  // 半径 2 时链端也获得更多邻居
  const r2 = document.analyses.find(entry => entry.radius === 2);
  assert.ok(r2.weightDiagnostics.minDegree >= document.analyses[0].weightDiagnostics.minDegree);
});

test('全市置换与区县内置换回答不同问题：参考池规模与 p 值均独立计算', () => {
  // 6 格链，每个区县 3 格，保证两种置换范围都有足够参考池。
  const six = ['a', 'b', 'c', 'd', 'e', 'f'];
  const sixEdges = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f']]
    .flatMap(([left, right]) => [
      { left, right, weight: 1 }, { left: right, right: left, weight: 1 }]);
  const sixRecords = six.map((cell, index) => record(cell, index < 3 ? 'd0' : 'd1',
    100, 10 + index * 7, index, 0));
  const document = run(sixRecords, sixEdges, { scopes: ['city', 'district'], minNeighbors: 1 });
  const [city, district] = document.analyses[0].localScopes;
  const cityCell = city.cells.find(item => item.cell === 'a');
  const districtCell = district.cells.find(item => item.cell === 'a');
  assert.equal(cityCell.estimable, true);
  assert.equal(districtCell.estimable, true);
  assert.equal(cityCell.permutation.scope, 'city');
  assert.equal(districtCell.permutation.scope, 'district');
  assert.ok(cityCell.permutationPoolSize > districtCell.permutationPoolSize);
  assert.equal(cityCell.permutationPoolSize, 5);
  assert.equal(districtCell.permutationPoolSize, 2);
  assert.notEqual(cityCell.permutation.seed, districtCell.permutation.seed);
});

test('区县内置换参考池不足时显示无法估计，而不是复用全市置换', () => {
  const document = run(linearRecords, linearEdges(), { scopes: ['district'], minNeighbors: 1 });
  const district = document.analyses[0].localScopes[0];
  const cellA = district.cells.find(item => item.cell === 'a');
  assert.equal(cellA.estimable, false);
  assert.ok(cellA.reason.includes('置换位置不足'));
});

test('同种子结果逐位可复现，不同种子允许改变置换 p 值', () => {
  const options = { seed: 71, minNeighbors: 1 };
  const first = run(linearRecords, linearEdges(), options);
  const second = run(linearRecords, linearEdges(), options);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const other = run(linearRecords, linearEdges(), { seed: 999, minNeighbors: 1 });
  const p1 = first.analyses[0].localScopes[0].cells.find(cell => cell.cell === 'b').pseudoPValue;
  const p2 = other.analyses[0].localScopes[0].cells.find(cell => cell.cell === 'b').pseudoPValue;
  assert.ok(typeof p1 === 'number' && typeof p2 === 'number');
});

test('原始边权与行标准化两种权重都可运行并在输出中标注', () => {
  const rowDoc = run(linearRecords, linearEdges(), { standardization: 'row', minNeighbors: 1 });
  const rawDoc = run(linearRecords, linearEdges(), { standardization: 'raw', minNeighbors: 1 });
  assert.equal(rowDoc.analyses[0].weightStandardization, 'row');
  assert.equal(rawDoc.analyses[0].weightStandardization, 'raw');
  const rowNeighbor = rowDoc.analyses[0].localScopes[0].cells.find(c => c.cell === 'b').neighbors;
  assert.equal(Math.abs(rowNeighbor.reduce((sum, entry) => sum + entry.weight, 0) - 1) < 1e-12, true);
  const rawNeighbor = rawDoc.analyses[0].localScopes[0].cells.find(c => c.cell === 'b').neighbors;
  assert.ok(rawNeighbor.every(entry => entry.weight === entry.rawWeight));
});

test('中文摘要包含口径、样本去向、置换解释与不作因果结论的提醒', () => {
  const document = run(linearRecords, linearEdges());
  const summary = buildChineseSummary(document);
  assert.ok(summary.includes('服务率'));
  assert.ok(summary.includes('岛状格网') || summary.includes('孤岛'));
  assert.ok(summary.includes('全市置换'));
  assert.ok(summary.includes('区县内置换'));
  assert.ok(summary.includes('不构成资源不足的因果结论'));
  assert.ok(summary.includes('Moran'));
});

test('CLI cluster：JSON 走 stdout、中文摘要走 stderr、落盘一致且参数受校验', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cluster-'));
  try {
    const inputPath = join(folder, 'records.json');
    const weightsPath = join(folder, 'weights.json');
    const configPath = join(folder, 'cluster.config.json');
    const outPath = join(folder, 'nested', 'cluster.json');
    await writeFile(inputPath, JSON.stringify({ version: 1, records: linearRecords }));
    await writeFile(weightsPath, JSON.stringify({ edges: linearEdges() }));
    await writeFile(configPath, JSON.stringify({
      weightsPath, metric: 'rate', radii: [1], scopes: ['city', 'district'],
      standardization: 'row', permutations: 99, seed: 71, alpha: 0.05,
      exact: false, minNeighbors: 2, minPermutationPool: 2, hotspotsPerType: 3,
    }));
    const result = spawnSync(process.execPath,
      ['src/cli.js', 'cluster', '--input', inputPath, '--config', configPath, '--out', outPath],
      { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const stdoutDoc = JSON.parse(result.stdout);
    const fileDoc = JSON.parse(await readFile(outPath, 'utf8'));
    assert.deepEqual(stdoutDoc, fileDoc);
    assert.ok(result.stderr.includes('空间集聚分析区域摘要'));
    assert.equal(stdoutDoc.inputFingerprint.length, 64);
    assert.ok(stdoutDoc.analyses[0].global);
    // 未知命令与悬空参数仍然被拒绝
    assert.equal(spawnSync(process.execPath, ['src/cli.js', 'frobnicate']).status, 1);
    assert.throws(() => parseArguments(['cluster', '--input']), /参数/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('CLI 兼容：summary 与 inspect 行为不回归', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'legacy-'));
  try {
    const outPath = join(folder, 'summary.json');
    const result = spawnSync(process.execPath, ['src/cli.js', 'summary', '--out', outPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const stdoutDoc = JSON.parse(result.stdout);
    const fileDoc = JSON.parse(await readFile(outPath, 'utf8'));
    assert.deepEqual(stdoutDoc, fileDoc);
    assert.equal(stdoutDoc.groupBy, 'district');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('权重缺陷进入 JSON 质检段：自邻接、重复、不对称、孤岛均可复核', () => {
  // a->b 重复；a->c 为只存在单向的不对称边；island 保持无任何边
  const defective = [
    ...linearEdges(),
    { left: 'a', right: 'a', weight: 1 },
    { left: 'a', right: 'b', weight: 1 },
    { left: 'a', right: 'c', weight: 1 },
  ];
  const document = run(linearRecords, defective, { minNeighbors: 1 });
  const diagnostics = document.analyses[0].weightDiagnostics;
  assert.deepEqual(diagnostics.selfLoops, ['a']);
  assert.equal(diagnostics.duplicateEdges.length, 1);
  assert.deepEqual(diagnostics.asymmetricPairs, [{ left: 'a', right: 'c' }]);
  assert.deepEqual(diagnostics.islands, ['island']);
});

test('分析登记包含完整探索范围与家族信息，防止只挑最漂亮的地图', () => {
  const document = run(linearRecords, linearEdges(), { radii: [1, 2] });
  assert.deepEqual(document.analysis.radii, [1, 2]);
  assert.deepEqual(document.analysis.scopes, ['city', 'district']);
  assert.ok(document.analysis.familyNote.includes('不挑选地图'));
  for (const analysis of document.analyses) {
    for (const local of analysis.localScopes) {
      assert.equal(typeof local.familySize, 'number');
      assert.ok(local.cells.every(cell => !cell.estimable || typeof cell.bonferroniPValue === 'number'));
    }
  }
});
