// 简洁中文区域摘要：面向规划人员，只描述集聚现象与复核入口，
// 不输出“资源不足”的因果判断。机器可读明细全部在 JSON 正文。
import { CLUSTER_LABELS } from './moran.js';

const SCOPE_EXPLANATION = {
  city: '全市置换：回答“相对全市分布，该单元与其邻居是否异常相似”，参考池是全市其余可估计格网。',
  district: '区县内置换：回答“在本区县内部比较，该单元与其邻居是否异常相似”，只在同区县格网间重排；跨区县邻居保持观测值，区县间整体水平差异不进入该检验。',
};

function rounded(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '无法估计';
  return Number(value.toFixed(digits));
}

function lineForCluster(local, cluster, limit) {
  const rows = local.cells
    .filter(cell => cell.estimable && cell.reportedCluster === cluster)
    .sort((left, right) => left.pseudoPValue - right.pseudoPValue)
    .slice(0, limit)
    .map(cell => `${cell.cell}(I=${rounded(cell.localI)}, z=${rounded(cell.standardValue)}, p=${rounded(cell.pseudoPValue)}, FDR p=${rounded(cell.fdrPValue)}, 邻居${cell.neighborCount}个)`);
  return rows;
}

export function buildChineseSummary(document, options = {}) {
  const { hotspotsPerType = 5 } = options;
  const lines = [];
  const { analysis, analyses, sensitivity, caution } = document;
  lines.push('===== 空间集聚分析区域摘要（探索性，不作因果结论）=====');
  lines.push(`指标口径：${analysis.metric}（${analysis.metricLabel.name}）；邻接半径：${analysis.radii.join('、')}；权重：${analyses[0].weightStandardization === 'row' ? '行标准化' : '原始边权'}；显著性水平 α=${analysis.alpha}；${analysis.exact ? '精确枚举置换' : `蒙特卡洛置换 ${analysis.permutations} 次`}；种子 ${analysis.seed}。`);

  const weight = analyses[0].weightDiagnostics;
  lines.push(`权重质检：边行 ${weight.edgeRows} 条，保留有向边 ${weight.directedEdgesKept} 条；自邻接 ${weight.selfLoops.length} 条、重复边 ${weight.duplicateEdges.length} 条、不对称边 ${weight.asymmetricPairs.length} 条、悬空引用 ${weight.danglingEdges.length} 条；孤岛 ${weight.islands.length} 个（${weight.islands.length ? weight.islands.join('、') : '无'}）。`);

  for (const entry of analyses) {
    const sample = entry.sample;
    lines.push(`—— 半径 r=${entry.radius} ——`);
    lines.push(`样本去向：格网 ${sample.totalCells} 个；指标可估计 ${sample.estimableCells} 个，指标排除 ${sample.excludedByMetric.length} 个${sample.excludedByMetric.length ? `（${sample.excludedByMetric.map(item => `${item.cell}:${item.reason}`).join('；')}）` : ''}；权重剔除 ${sample.droppedByWeights.length} 个${sample.droppedByWeights.length ? `（${sample.droppedByWeights.map(item => `${item.cell}:${item.reason}`).join('；')}）` : ''}；实际进入分析 ${sample.analysisCells} 个。`);
    if (!entry.global.estimable) {
      lines.push(`全局 Moran's I：无法估计（${entry.global.reason}）。`);
    } else {
      const g = entry.global;
      lines.push(`全局 Moran's I=${rounded(g.observed)}，置换均值=${rounded(g.permutationMean)}（解析期望 ${rounded(g.expectedAnalytic)}），双侧置换 p=${rounded(g.pseudoPValue)}（${g.exact ? '精确枚举' : `${g.pseudoCount} 次置换`}）。I>0 提示空间正自相关（相似值连片），I<0 提示空间相异，均不直接等同于资源不足。`);
    }
    for (const local of entry.localScopes) {
      lines.push(SCOPE_EXPLANATION[local.scope]);
      const unestimable = local.cells.filter(cell => !cell.estimable);
      lines.push(`局部检验家族（${local.scope}）：可估计 ${local.familySize} 个，无法估计 ${unestimable.length} 个${unestimable.length ? `（${unestimable.map(cell => `${cell.cell}:${cell.reason}`).join('；')}）` : ''}；Bonferroni 与 BH-FDR 校正已随 JSON 给出。`);
      for (const cluster of ['HH', 'LL', 'HL', 'LH']) {
        const rows = lineForCluster(local, cluster, hotspotsPerType);
        const total = local.cells.filter(cell => cell.estimable && cell.reportedCluster === cluster).length;
        if (total > 0) {
          lines.push(`  ${CLUSTER_LABELS[cluster]}：${total} 个，按 p 值列前 ${rows.length} 个 -> ${rows.join('；')}（每个热点的邻居清单、标准化值与置换设置见 JSON）`);
        }
      }
    }
  }
  lines.push('敏感性：');
  for (const row of sensitivity.globalTable) {
    lines.push(`  r=${row.radius}：分析单元 ${row.analysisCells}，孤岛 ${row.islands}，邻居不足 ${row.insufficientNeighbors}，度范围 ${row.minDegree}-${row.maxDegree}，Moran's I=${rounded(row.moransI)}，p=${rounded(row.globalPValue)}。`);
  }
  const stableIds = sensitivity.classificationStability
    .filter(item => new Set(item.trajectory.map(step => step.cluster)).size === 1)
    .map(item => `${item.cell}(${item.scope}:${item.baselineCluster})`);
  lines.push(`跨半径分类保持一致的显著单元：${stableIds.length ? stableIds.join('、') : '无'}；其余显著单元对邻接定义敏感，走访排序时应下调权重。`);
  lines.push(`口径提醒：${caution}`);
  return lines.join('\n');
}
