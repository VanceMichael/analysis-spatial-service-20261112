import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult } from './output.js';
import { loadClusterConfig, DEFAULT_CONFIG } from './clusterConfig.js';
import { buildWeightSet } from './weights.js';
import { runSpatialAnalysis } from './spatial.js';
import { buildChineseSummary } from './report.js';

const COMMANDS = ['summary', 'inspect', 'cluster'];
const OPTIONS = ['--input', '--out', '--config'];

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!COMMANDS.includes(command)) throw new Error(`命令应为 ${COMMANDS.join(' 或 ')}`);
  const result = { command, input: 'data/records.json' };
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!OPTIONS.includes(name) || !value || value.startsWith('--')) {
      throw new Error(`参数应为 ${OPTIONS.join(' ')} 加路径`);
    }
    if (result[name.slice(2)] && name !== '--input') throw new Error('参数不可重复');
    result[name.slice(2)] = value;
  }
  return result;
}

async function runCluster(options) {
  const configPath = options.config ?? DEFAULT_CONFIG.weightsPath;
  const { config, edges } = await loadClusterConfig(configPath);
  const dataset = await loadDataset(options.input);
  const cellIds = [...new Set(dataset.records.map(record => record.cell))];
  const weightSet = buildWeightSet(edges, cellIds, {
    standardization: config.standardization,
    radii: config.radii,
  });
  const document = runSpatialAnalysis(dataset.records, weightSet, {
    ...config,
    weightsPath: configPath,
  });
  const summary = buildChineseSummary(document, { hotspotsPerType: config.hotspotsPerType });
  const enriched = {
    ...document,
    inputFingerprint: dataset.fingerprint,
    chineseSummary: summary,
  };
  if (options.out) await writeResult(options.out, enriched);
  return { document: enriched, summary };
}

export async function main(args) {
  const options = parseArguments(args);
  if (options.command === 'cluster') {
    const { document, summary } = await runCluster(options);
    return { document, summary };
  }
  const dataset = await loadDataset(options.input);
  const result = options.command === 'summary' ? summarize(dataset.records)
    : { records: dataset.records.length, fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [] };
  const document = { ...result, inputFingerprint: dataset.fingerprint };
  if (options.out) await writeResult(options.out, document);
  return { document, summary: null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(({ document, summary }) => {
    process.stdout.write(JSON.stringify(document, null, 2) + '\n');
    if (summary) process.stderr.write(summary + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
