// 集聚分析配置。边表默认复用现有 data/policy.json，也可指向独立邻接文件。
import { readFile } from 'node:fs/promises';

export const DEFAULT_CONFIG = {
  weightsPath: 'data/policy.json',
  metric: 'rate',
  radii: [1, 2],
  scopes: ['city', 'district'],
  standardization: 'row',
  permutations: 999,
  seed: 71,
  alpha: 0.05,
  exact: false,
  minNeighbors: 2,
  minPermutationPool: 2,
  hotspotsPerType: 5,
};

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`配置 ${name} 应为正整数`);
}

export async function loadClusterConfig(path) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  const config = { ...DEFAULT_CONFIG, ...document };
  if (!['count', 'rate', 'gap'].includes(config.metric)) throw new Error('配置 metric 应为 count/rate/gap');
  if (!['row', 'raw'].includes(config.standardization)) throw new Error('配置 standardization 应为 row/raw');
  if (!Array.isArray(config.radii) || config.radii.some(value => !Number.isInteger(value) || value < 1)) {
    throw new Error('配置 radii 应为正整数数组');
  }
  if (new Set(config.radii).size !== config.radii.length) throw new Error('配置 radii 不得重复');
  if (!Array.isArray(config.scopes) || config.scopes.length === 0
    || config.scopes.some(scope => !['city', 'district'].includes(scope))) {
    throw new Error('配置 scopes 应为 city/district 的非空数组');
  }
  assertPositiveInteger(config.permutations, 'permutations');
  assertPositiveInteger(config.seed, 'seed');
  assertPositiveInteger(config.minNeighbors, 'minNeighbors');
  assertPositiveInteger(config.minPermutationPool, 'minPermutationPool');
  if (typeof config.alpha !== 'number' || config.alpha <= 0 || config.alpha >= 1) {
    throw new Error('配置 alpha 应在 (0,1) 区间');
  }
  if (typeof config.exact !== 'boolean') throw new Error('配置 exact 应为布尔值');
  // 边表由 weightsPath 指向的文件提供（默认即 data/policy.json），与业务参数解耦。
  const weightsDocument = JSON.parse(await readFile(config.weightsPath, 'utf8'));
  if (!Array.isArray(weightsDocument.edges)) {
    throw new Error(`权重文件 ${config.weightsPath} 必须包含 edges 数组`);
  }
  return { config, edges: weightsDocument.edges };
}
