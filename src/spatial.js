// 空间集聚分析编排：指标样本 -> 样本权重裁剪 -> 全局/局部 Moran's I ->
// 多半径敏感性比较。每个（半径 × 指标 × 置换范围）组合都是独立分析并完整登记。
import { buildCellTable, sampleMoments } from './indicators.js';
import { restrictToSample, sortIds } from './weights.js';
import { globalPermutationTest, runLocalAnalysis } from './moran.js';
import { streamSeed } from './random.js';
import { fingerprint } from './dataset.js';

function buildValueLookup(cellTable) {
  const valueById = new Map();
  const districtById = new Map();
  for (const row of cellTable.rows) {
    districtById.set(row.cell, row.district);
    if (row.estimable) valueById.set(row.cell, row.value);
  }
  return { valueById, districtById };
}

function standardize(valueById, ids, moments) {
  if (moments.constant) return new Map(ids.map(id => [id, 0]));
  return new Map(ids.map(id => [id, (valueById.get(id) - moments.mean) / moments.standardDeviation || 0]));
}

function analysisId(radius, kind, scope) {
  return `r${radius}-${kind}-${scope}`;
}

export function runSpatialAnalysis(records, weightSet, config) {
  const {
    metric, radii, scopes, permutations, seed, alpha,
    exact, minNeighbors, minPermutationPool, weightsPath,
  } = config;
  const cellTable = buildCellTable(records, metric);
  const { valueById, districtById } = buildValueLookup(cellTable);
  const estimableIds = cellTable.rows.filter(row => row.estimable).map(row => row.cell);

  const analyses = [];
  for (const weight of weightSet.radii) {
    const sample = restrictToSample(weightSet.cellIds, weight, estimableIds, minNeighbors);
    const islandSet = new Set(sample.islands);
    const insufficientSet = new Set(sample.insufficient);
    // 孤岛与邻居不足单元不进入全局/局部统计，只保留在无法估计清单中。
    const includedIds = sortIds([...sample.neighborRows.keys()]
      .filter(id => !islandSet.has(id) && !insufficientSet.has(id)));
    const droppedAfterSample = estimableIds
      .filter(id => islandSet.has(id) || insufficientSet.has(id))
      .map(id => ({
        cell: id,
        reason: islandSet.has(id)
          ? '岛状格网：样本内无有效邻居，无法估计'
          : `有效邻居 ${sample.neighborRows.get(id).length} 个，低于最小要求 ${minNeighbors} 个`,
      }));
    const moments = sampleMoments(valueById, includedIds);
    const zById = standardize(valueById, includedIds, moments);
    const global = globalPermutationTest({
      zById,
      neighborRows: sample.neighborRows,
      ids: includedIds,
      permutations,
      seed: streamSeed(seed, 'global', weight.radius, metric),
      exact,
    });
    const locals = scopes.map(scope => runLocalAnalysis({
      ids: includedIds,
      zById,
      neighborRows: sample.neighborRows,
      districtById,
      scope,
      permutations,
      seed: streamSeed(seed, 'local', weight.radius, metric),
      exact,
      alpha,
      minNeighbors,
      minPermutationPool,
    }));
    const unestimableCells = droppedAfterSample.map(({ cell, reason }) => ({ cell, estimable: false, reason }));
    for (const local of locals) {
      local.unestimableCells = unestimableCells;
      local.cells.push(...unestimableCells.map(entry => ({ ...entry })));
      local.cells.sort((left, right) => left.cell.localeCompare(right.cell, 'en'));
    }
    analyses.push({
      analysisId: analysisId(weight.radius, metric, scopes.join('+')),
      metric,
      metricLabel: cellTable.label,
      radius: weight.radius,
      weightStandardization: weight.standardization,
      weightDiagnostics: weight.diagnostics,
      sample: {
        totalCells: cellTable.totalCells,
        estimableCells: cellTable.estimableCells,
        analysisCells: includedIds.length,
        excludedByMetric: cellTable.excludedCells,
        droppedByWeights: droppedAfterSample,
        islands: sample.islands,
        insufficientNeighbors: sample.insufficient,
      },
      moments: {
        mean: moments.mean,
        standardDeviation: moments.standardDeviation,
        constant: moments.constant,
        standardization: '总体标准差（除以 n）',
      },
      global: global,
      localScopes: locals,
    });
  }

  const sensitivity = buildSensitivity(analyses, districtById);
  return {
    schemaVersion: 1,
    analysis: {
      metric,
      metricLabel: cellTable.label,
      radii: [...radii],
      scopes: [...scopes],
      permutations: exact ? null : permutations,
      exact,
      seed,
      alpha,
      minNeighbors,
      minPermutationPool,
      weightsPath,
      weightsFingerprint: fingerprint(weightSet.radii.map(weight => [
        weight.radius,
        [...weight.neighborRows.entries()].map(([id, row]) => [id, row.map(entry => [entry.cell, entry.rawWeight])]),
      ])),
      familyNote: '每个半径为一个探索配置；每个半径内按置换范围分别形成局部检验家族，家族大小等于该范围内可估计单元数；所有半径与全部单元的检验均完整登记，不挑选地图。',
    },
    cellTable: cellTable.rows,
    analyses,
    sensitivity,
    caution: '空间集聚只反映指标取值的空间自相关，不构成资源不足的因果结论；低值连片可能由访客偏少导致，热点/冷点仅用于提示值得实地走访的片区。',
  };
}

function clusterCounts(local) {
  const counts = { HH: 0, LL: 0, HL: 0, LH: 0, NS: 0 };
  for (const cell of local.cells) {
    if (cell.estimable) counts[cell.reportedCluster] += 1;
  }
  return counts;
}

function buildSensitivity(analyses, districtById) {
  const globalTable = analyses.map(entry => ({
    radius: entry.radius,
    analysisCells: entry.sample.analysisCells,
    islands: entry.sample.islands.length,
    insufficientNeighbors: entry.sample.insufficientNeighbors.length,
    minDegree: entry.weightDiagnostics.minDegree,
    maxDegree: entry.weightDiagnostics.maxDegree,
    moransI: entry.global.estimable ? entry.global.observed : null,
    globalPValue: entry.global.estimable ? entry.global.pseudoPValue : null,
  }));
  // 以首个半径的分类为基准，跟踪每个可估计单元在邻接半径变化下的分类稳定性。
  const baseline = analyses[0];
  const stability = [];
  for (const local of baseline.localScopes) {
    for (const cell of local.cells) {
      if (!cell.estimable || cell.reportedCluster === 'NS') continue;
      const trajectory = analyses.map(entry => {
        const match = entry.localScopes.find(scope => scope.scope === local.scope);
        const target = match.cells.find(item => item.cell === cell.cell);
        return {
          radius: entry.radius,
          cluster: target && target.estimable ? target.reportedCluster : 'NA',
          pValue: target && target.estimable ? target.pseudoPValue : null,
        };
      });
      stability.push({ cell: cell.cell, district: districtById.get(cell.cell), scope: local.scope, baselineCluster: cell.reportedCluster, trajectory });
    }
  }
  const countTable = analyses.map(entry => ({
    radius: entry.radius,
    scopes: entry.localScopes.map(scope => ({ scope: scope.scope, familySize: scope.familySize, clusters: clusterCounts(scope) })),
  }));
  return {
    globalTable,
    localClusterCounts: countTable,
    classificationStability: stability,
    note: '邻接半径扩大通常提高邻居数并平滑局部滞后；若热点随半径改变分类，应视为对邻接定义敏感而非稳健结论。',
  };
}
