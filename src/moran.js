// Moran's I 全局与局部集聚分析。
// 显著性只用与零假设一致的条件置换估计：
//   全局：固定指标多重集，在全部位置间重排；
//   局部：每个焦点单元固定自身取值，仅在其余位置重排，逐焦点独立置换，
//         不能把全局打乱的结果直接复用为局部检验。
import { mulberry32, shuffledCopy, enumeratePermutations, streamSeed } from './random.js';
import { sortIds } from './weights.js';

export function spatialLag(id, neighborRows, valueById) {
  let lag = 0;
  for (const { cell, weight } of neighborRows.get(id)) lag += weight * valueById.get(cell);
  return lag;
}

// 行标准化权重下 S0 等于可估计单元数；raw 模式下按权重求和。
export function moranGlobal(zById, neighborRows, ids) {
  const denominator = ids.reduce((sum, id) => sum + zById.get(id) ** 2, 0);
  if (denominator === 0) return null;
  let s0 = 0;
  let cross = 0;
  for (const id of ids) {
    for (const { cell, weight } of neighborRows.get(id)) {
      s0 += weight;
      cross += weight * zById.get(id) * zById.get(cell);
    }
  }
  return (ids.length / s0) * (cross / denominator);
}

export function moranLocal(id, zById, neighborRows) {
  const zi = zById.get(id);
  const lag = spatialLag(id, neighborRows, zById);
  return { localI: zi * lag, lagStandard: lag };
}

function twoSidedP(observed, pseudoValues) {
  const hits = pseudoValues.filter(value => value >= observed).length;
  return (hits + 1) / (pseudoValues.length + 1);
}

// 全局条件置换：固定多重集，位置整体重排，权重结构不动。
export function globalPermutationTest({ zById, neighborRows, ids, permutations, seed, exact }) {
  const n = ids.length;
  const observed = moranGlobal(zById, neighborRows, ids);
  if (observed === null) {
    return { estimable: false, reason: '指标在样本内为常数（标准差为 0），Moran I 无定义', observed: null };
  }
  const expected = -1 / (n - 1);
  const baseValues = ids.map(id => zById.get(id));
  const pseudo = [];
  if (exact) {
    for (const permutation of enumeratePermutations(n)) {
      const shuffled = permutation.map(position => baseValues[position]);
      const candidate = new Map(ids.map((id, index) => [id, shuffled[index]]));
      pseudo.push(moranGlobal(candidate, neighborRows, ids));
    }
  } else {
    const rng = mulberry32(seed);
    for (let round = 0; round < permutations; round += 1) {
      const shuffled = shuffledCopy(baseValues, rng);
      const candidate = new Map(ids.map((id, index) => [id, shuffled[index]]));
      pseudo.push(moranGlobal(candidate, neighborRows, ids));
    }
  }
  const mean = pseudo.reduce((sum, value) => sum + value, 0) / pseudo.length;
  const variance = pseudo.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pseudo.length;
  return {
    estimable: true,
    observed,
    expectedAnalytic: expected,
    permutationMean: mean,
    permutationStandardDeviation: Math.sqrt(variance),
    pseudoPValue: twoSidedP(observed, pseudo),
    pseudoCount: pseudo.length,
    exact,
  };
}

// 局部条件置换：焦点固定，仅重排其余位置；每个焦点独立随机流。
// scope=city 在全市可估计样本中重排；scope=district 仅在同区县内重排。
export function localPermutationTest({
  id, zById, neighborRows, ids, districtById, scope,
  permutations, seed, exact, minPermutationPool,
}) {
  const neighbors = neighborRows.get(id) ?? [];
  if (neighbors.length === 0) {
    return { estimable: false, reason: '岛状格网：样本内无有效邻居，空间滞后无定义' };
  }
  const pool = scope === 'district'
    ? ids.filter(candidate => candidate !== id && districtById.get(candidate) === districtById.get(id))
    : ids.filter(candidate => candidate !== id);
  if (pool.length < minPermutationPool) {
    return { estimable: false, reason: `有效置换位置不足（${scope === 'district' ? '本区县' : '全市'}参考池 ${pool.length} 个）` };
  }
  const zi = zById.get(id);
  if (!Number.isFinite(zi)) {
    return { estimable: false, reason: '焦点标准化值缺失' };
  }
  const neighborPositions = neighbors.map(({ cell, weight }) => ({ position: pool.indexOf(cell), weight, cell }));
  const lagFrom = values => neighborPositions.reduce((sum, entry) => {
    // 邻居不在参考池（区县内置换时的跨区邻居）时保持其观测值不动。
    const value = entry.position === -1 ? zById.get(entry.cell) : values[entry.position];
    return sum + entry.weight * value;
  }, 0);
  const poolValues = pool.map(candidate => zById.get(candidate));
  const observedLag = lagFrom(poolValues);
  const observedLocalI = zi * observedLag;
  const pseudo = [];
  if (exact) {
    for (const permutation of enumeratePermutations(pool.length)) {
      const values = permutation.map(position => poolValues[position]);
      pseudo.push(zi * lagFrom(values));
    }
  } else {
    const rng = mulberry32(streamSeed(seed, scope, id));
    for (let round = 0; round < permutations; round += 1) {
      const values = shuffledCopy(poolValues, rng);
      pseudo.push(zi * lagFrom(values));
    }
  }
  return {
    estimable: true,
    observedLocalI,
    lagStandard: observedLag,
    pseudoPValue: twoSidedP(observedLocalI, pseudo),
    pseudoCount: pseudo.length,
    permutationPoolSize: pool.length,
    streamSeed: exact ? null : streamSeed(seed, scope, id),
    exact,
  };
}

export function clusterType(zFocal, lag) {
  if (zFocal > 0 && lag > 0) return 'HH';
  if (zFocal < 0 && lag < 0) return 'LL';
  if (zFocal > 0 && lag < 0) return 'HL';
  if (zFocal < 0 && lag > 0) return 'LH';
  return 'NS';
}

export const CLUSTER_LABELS = {
  HH: '高-高集聚（热点，自身高且邻居高）',
  LL: '低-低集聚（冷点，自身低且邻居低）',
  HL: '高-低异常（自身高、邻居低）',
  LH: '低-高异常（自身低、邻居高）',
  NS: '不显著',
};

// Benjamini-Hochberg 错误发现率控制，返回与 ids 对齐的调整后 p 值。
export function benjaminiHochberg(pairs) {
  const ordered = [...pairs].sort((a, b) => a.p - b.p);
  const total = ordered.length;
  const adjusted = new Array(total);
  let running = 1;
  for (let index = total - 1; index >= 0; index -= 1) {
    const value = Math.min(running, ordered[index].p * total / (index + 1));
    adjusted[index] = value;
    running = value;
  }
  const result = new Map();
  ordered.forEach((entry, index) => result.set(entry.id, adjusted[index]));
  return result;
}

export function bonferroni(pairs) {
  const total = pairs.length;
  return new Map(pairs.map(({ id, p }) => [id, Math.min(1, p * total)]));
}

// 一次完整局部分析，返回与格网编号对齐的逐单元结果。
export function runLocalAnalysis({
  ids, zById, neighborRows, districtById, scope, permutations, seed,
  exact, alpha, minNeighbors, minPermutationPool,
}) {
  const estimableResults = [];
  const cells = ids.map(id => {
    const neighborCount = (neighborRows.get(id) ?? []).length;
    if (neighborCount === 0) {
      return { cell: id, estimable: false, reason: '岛状格网：样本内无有效邻居，空间滞后无定义' };
    }
    if (neighborCount < minNeighbors) {
      return { cell: id, estimable: false, reason: `有效邻居 ${neighborCount} 个，低于最小要求 ${minNeighbors} 个` };
    }
    const test = localPermutationTest({
      id, zById, neighborRows, ids, districtById, scope,
      permutations, seed, exact, minPermutationPool,
    });
    if (!test.estimable) return { cell: id, estimable: false, reason: test.reason };
    const type = clusterType(zById.get(id), test.lagStandard);
    estimableResults.push({ id, p: test.pseudoPValue });    return {
      cell: id,
      estimable: true,
      localI: test.observedLocalI,
      standardValue: zById.get(id),
      lagStandard: test.lagStandard,
      pseudoPValue: test.pseudoPValue,
      permutationCount: test.pseudoCount,
      permutationPoolSize: test.permutationPoolSize,
      exact: test.exact,
      cluster: type,
      clusterLabel: CLUSTER_LABELS[type],
      neighborCount,
      neighbors: neighborRows.get(id).map(entry => ({
        cell: entry.cell,
        weight: entry.weight,
        rawWeight: entry.rawWeight,
        standardValue: zById.get(entry.cell),
        district: districtById.get(entry.cell),
      })),
      permutation: {
        scope,
        focalFixed: true,
        focal: id,
        permutations: test.exact ? null : permutations,
        exact: test.exact,
        seed: test.exact ? null : streamSeed(seed, scope, id),
        referencePool: scope === 'district'
          ? sortIds(ids.filter(candidate => candidate !== id
            && districtById.get(candidate) === districtById.get(id)))
          : sortIds(ids.filter(candidate => candidate !== id)),
      },
    };
  });
  const bonferroniMap = bonferroni(estimableResults);
  const bhMap = benjaminiHochberg(estimableResults);
  for (const entry of cells) {
    if (!entry.estimable) continue;
    entry.bonferroniPValue = bonferroniMap.get(entry.cell);
    entry.fdrPValue = bhMap.get(entry.cell);
    entry.significantRaw = entry.pseudoPValue <= alpha;
    entry.significantBonferroni = entry.bonferroniPValue <= alpha;
    entry.significantFdr = entry.fdrPValue <= alpha;
    entry.reportedCluster = entry.significantRaw ? entry.cluster : 'NS';
  }
  return {
    scope,
    alpha,
    familySize: estimableResults.length,
    correction: { method: 'Bonferroni 与 Benjamini-Hochberg FDR', alpha },
    cells,
  };
}
