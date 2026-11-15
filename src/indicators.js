// 指标口径。分析前必须先声明指标类型，绝不把不同口径混作同一张图：
// - count：服务次数计数（served 合计）
// - rate ：服务率（served / visitors），零访问量格网无定义，按排除处理而非零服务率
// - gap  ：需求缺口计数（visitors - served），只对非负整数计数成立
import { validateRecords } from './dataset.js';
import { sortIds } from './weights.js';

export const METRIC_KINDS = ['count', 'rate', 'gap'];

export const METRIC_LABELS = {
  count: { name: '服务次数计数', numerator: 'served 合计', denominator: null },
  rate: { name: '服务率', numerator: 'served 合计', denominator: 'visitors 合计' },
  gap: { name: '需求缺口计数', numerator: 'visitors 合计 - served 合计', denominator: null },
};

export function aggregateCells(records) {
  validateRecords(records);
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.cell)) {
      grouped.set(record.cell, {
        cell: record.cell, district: record.district, x: record.x, y: record.y,
        visitors: 0, served: 0, recordCount: 0,
      });
    }
    const cell = grouped.get(record.cell);
    if (cell.district !== record.district || cell.x !== record.x || cell.y !== record.y) {
      throw new Error(`格网 ${record.cell} 的 district/x/y 在记录间不一致，无法唯一聚合`);
    }
    cell.visitors += record.visitors;
    cell.served += record.served;
    cell.recordCount += 1;
  }
  return sortIds([...grouped.keys()]).map(id => grouped.get(id));
}

function buildMetric(kind, cell) {
  if (kind === 'count') {
    return { value: cell.served, estimable: true, reason: null };
  }
  if (kind === 'gap') {
    const gap = cell.visitors - cell.served;
    if (gap < 0) {
      return { value: null, estimable: false, reason: '缺口为负（served 超过 visitors），口径不成立' };
    }
    return { value: gap, estimable: true, reason: null };
  }
  if (kind === 'rate') {
    if (cell.visitors === 0) {
      // 零访问量格网没有服务率分母，绝不当作零服务率纳入空间分析。
      return { value: null, estimable: false, reason: '零访问量格网，服务率无定义（不按零服务率纳入）' };
    }
    return { value: cell.served / cell.visitors, estimable: true, reason: null };
  }
  throw new Error(`未知指标类型：${kind}`);
}

// 生成格网级指标表，并清楚记录样本去向。
export function buildCellTable(records, kind) {
  if (!METRIC_KINDS.includes(kind)) throw new Error(`指标类型应为 ${METRIC_KINDS.join('/')}`);
  const cells = aggregateCells(records);
  const table = cells.map(cell => ({ ...cell, ...buildMetric(kind, cell) }));
  const included = table.filter(row => row.estimable).map(row => row.cell);
  const excluded = table.filter(row => !row.estimable)
    .map(row => ({ cell: row.cell, district: row.district, reason: row.reason, visitors: row.visitors, served: row.served }));
  return {
    kind,
    label: METRIC_LABELS[kind],
    totalCells: table.length,
    estimableCells: included.length,
    excludedCells: excluded,
    rows: table,
  };
}

// 总体均值与总体标准差（除以 n，与空间软件常用口径一致），基于可估计样本计算。
export function sampleMoments(valueById, ids) {
  const values = ids.map(id => valueById.get(id));
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, standardDeviation: Math.sqrt(variance), constant: variance === 0 };
}
