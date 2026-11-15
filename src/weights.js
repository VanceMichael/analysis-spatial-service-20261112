// 本地格网邻接表 -> 空间权重矩阵。
// 只消费本地边表，不读取坐标；先做结构质检，再按需行标准化或保留原始边权。

export function sortIds(ids) {
  return [...ids].sort((left, right) => left.localeCompare(right, 'en'));
}

function sortedNeighborMap(mapValue) {
  return new Map(sortIds([...mapValue.keys()]).map(id => [id, mapValue.get(id)]));
}

// 解析边表并完成结构质检。质检结果全部保留，不静默改写业务语义：
// 自邻接与重复边会被剔除并计数；悬空引用直接拒绝；不对称只报告不补边。
export function inspectEdges(edges, cellIds) {
  if (!Array.isArray(edges)) throw new Error('邻接表必须是边数组');
  const known = new Set(cellIds);
  const seen = new Set();
  const directed = new Map();
  const selfLoops = [];
  const duplicateEdges = [];
  const danglingEdges = [];
  for (const [index, edge] of edges.entries()) {
    if (edge === null || typeof edge !== 'object' || Array.isArray(edge)) {
      throw new Error(`第 ${index + 1} 条边不是对象`);
    }
    const { left, right, weight } = edge;
    if (typeof left !== 'string' || typeof right !== 'string') {
      throw new Error(`第 ${index + 1} 条边的端点必须是格网字符串编号`);
    }
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      throw new Error(`第 ${index + 1} 条边的权重必须为正数`);
    }
    if (!known.has(left) || !known.has(right)) {
      danglingEdges.push({ left, right });
      continue;
    }
    if (left === right) {
      selfLoops.push(left);
      continue;
    }
    const key = `${left}->${right}`;
    if (seen.has(key)) {
      duplicateEdges.push({ left, right });
      continue;
    }
    seen.add(key);
    directed.set(key, weight);
  }
  if (danglingEdges.length > 0) {
    throw new Error(`邻接表引用了不在数据中的格网：${JSON.stringify(danglingEdges.slice(0, 5))}`);
  }
  const outgoing = new Map(cellIds.map(id => [id, new Map()]));
  for (const [key, weight] of directed) {
    const [left, right] = key.split('->');
    outgoing.get(left).set(right, weight);
  }
  // 每条无向不对称只报告一次：只统计“正向存在、反向缺失”的边，避免重复计数。
  const undirectedSeen = new Set();
  const asymmetricPairs = [];
  for (const [key] of directed) {
    const [left, right] = key.split('->');
    const undirectedKey = [left, right].sort((a, b) => a.localeCompare(b, 'en')).join('|');
    if (undirectedSeen.has(undirectedKey)) continue;
    undirectedSeen.add(undirectedKey);
    if (!directed.has(`${right}->${left}`)) asymmetricPairs.push({ left, right });
  }
  const islands = cellIds.filter(id => outgoing.get(id).size === 0);
  const weights = [...directed.values()];
  const binary = weights.every(weight => weight === 1);
  return {
    diagnostics: {
      edgeRows: edges.length,
      directedEdgesKept: directed.size,
      selfLoops: sortIds(selfLoops),
      duplicateEdges,
      asymmetricPairs,
      danglingEdges,
      islands: sortIds(islands),
      binaryWeights: binary,
    },
    outgoing,
  };
}

// 在无向化基础图上做 BFS，得到图距离不超过 radius 的邻居集合。
function neighborsWithinRadius(outgoing, seed, radius) {
  const reached = new Map([[seed, 0]]);
  let frontier = [seed];
  for (let step = 1; step <= radius; step += 1) {
    const nextFrontier = [];
    for (const node of frontier) {
      for (const neighbor of outgoing.get(node).keys()) {
        if (!reached.has(neighbor)) {
          reached.set(neighbor, step);
          nextFrontier.push(neighbor);
        }
      }
    }
    frontier = nextFrontier;
  }
  reached.delete(seed);
  return reached;
}

function degreeStats(neighborRows) {
  const degrees = [...neighborRows.values()].map(row => row.length);
  return {
    minDegree: degrees.length ? Math.min(...degrees) : 0,
    maxDegree: degrees.length ? Math.max(...degrees) : 0,
    meanDegree: degrees.length ? degrees.reduce((sum, value) => sum + value, 0) / degrees.length : 0,
  };
}

function finalizeRows(rawRows, standardization, cellIds) {
  const neighborRows = new Map();
  const rowSums = new Map();
  for (const id of cellIds) {
    const entries = sortIds([...rawRows.get(id).keys()])
      .map(neighbor => ({ cell: neighbor, rawWeight: rawRows.get(id).get(neighbor) }));
    const rowSum = entries.reduce((sum, entry) => sum + entry.rawWeight, 0);
    rowSums.set(id, rowSum);
    neighborRows.set(id, entries.map(entry => ({
      cell: entry.cell,
      weight: standardization === 'row' && rowSum > 0 ? entry.rawWeight / rowSum : entry.rawWeight,
      rawWeight: entry.rawWeight,
    })));
  }
  return { neighborRows: sortedNeighborMap(neighborRows), rowSums };
}

// 构建一个或多个邻接半径的权重集合。半径 >1 仅支持单位边权（二值图），
// 多半径边由基础图 BFS 派生，避免对非单位权重擅自赋予距离衰减函数。
export function buildWeightSet(edges, cellIds, options = {}) {
  const standardization = options.standardization ?? 'row';
  if (!['row', 'raw'].includes(standardization)) throw new Error('标准化方式应为 row 或 raw');
  const radii = options.radii ?? [1];
  if (!Array.isArray(radii) || radii.length === 0 || radii.some(value => !Number.isInteger(value) || value < 1)) {
    throw new Error('邻接半径应为正整数数组');
  }
  const ids = sortIds(cellIds);
  const { diagnostics, outgoing } = inspectEdges(edges, ids);
  if (radii.some(radius => radius > 1) && !diagnostics.binaryWeights) {
    throw new Error('多邻接半径仅支持单位边权图；非单位边权请分别提供各半径的邻接表');
  }
  const sets = radii.map(radius => {
    const rawRows = new Map(ids.map(id => [id, new Map()]));
    if (radius === 1) {
      for (const id of ids) {
        for (const [neighbor, weight] of outgoing.get(id)) rawRows.get(id).set(neighbor, weight);
      }
    } else {
      for (const id of ids) {
        const reached = neighborsWithinRadius(outgoing, id, radius);
        for (const neighbor of reached.keys()) rawRows.get(id).set(neighbor, 1);
      }
    }
    const { neighborRows, rowSums } = finalizeRows(rawRows, standardization, ids);
    const islands = ids.filter(id => neighborRows.get(id).length === 0);
    const undirectedPairs = new Set();
    for (const id of ids) {
      for (const { cell } of neighborRows.get(id)) {
        undirectedPairs.add([id, cell].sort((a, b) => a.localeCompare(b, 'en')).join('|'));
      }
    }
    return {
      radius,
      standardization,
      diagnostics: {
        ...diagnostics,
        radius,
        islands: sortIds(islands),
        directedEdgesKept: [...neighborRows.values()].reduce((sum, row) => sum + row.length, 0),
        undirectedPairCount: undirectedPairs.size,
        ...degreeStats(neighborRows),
      },
      neighborRows,
      rowSums,
    };
  });
  return { cellIds: ids, standardization, baseDiagnostics: diagnostics, radii: sets };
}

// 在可估计样本上裁剪权重：剔除样本外邻居，并在行标准化模式下重新归一。
// 返回孤岛（样本内无有效邻居）清单，供上层标记“无法估计”。
export function restrictToSample(cellIds, weightSet, includedIds, minNeighbors) {
  const included = new Set(includedIds);
  const neighborRows = new Map();
  for (const id of cellIds) {
    if (!included.has(id)) continue;
    const kept = weightSet.neighborRows.get(id).filter(entry => included.has(entry.cell));
    const rowSum = kept.reduce((sum, entry) => sum + entry.rawWeight, 0);
    neighborRows.set(id, kept.map(entry => ({
      cell: entry.cell,
      rawWeight: entry.rawWeight,
      weight: weightSet.standardization === 'row' && rowSum > 0 ? entry.rawWeight / rowSum : entry.rawWeight,
    })));
  }
  const islands = [...neighborRows.keys()]
    .filter(id => neighborRows.get(id).length === 0)
    .sort((a, b) => a.localeCompare(b, 'en'));
  const insufficient = [...neighborRows.keys()]
    .filter(id => neighborRows.get(id).length > 0 && neighborRows.get(id).length < minNeighbors)
    .sort((a, b) => a.localeCompare(b, 'en'));
  return { neighborRows: sortedNeighborMap(neighborRows), islands, insufficient };
}
