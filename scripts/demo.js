import { main } from '../src/cli.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const started = performance.now();
console.log('读取本地演练记录并核对输入指纹');
console.log(JSON.stringify((await main(['inspect'])).document, null, 2));
console.log('现有领域核算');
console.log(JSON.stringify((await main(['summary', '--out', 'var/summary.json'])).document, null, 2));
console.log('业务配置');
console.log(JSON.stringify(JSON.parse(await readFile('data/policy.json', 'utf8')), null, 2));

// 空间集聚分析：演示用小置换次数，正式分析以 data/cluster.config.json 的 999 次为准。
await mkdir('var', { recursive: true });
const demoConfigPath = 'var/demo-cluster.config.json';
const demoConfig = {
  ...JSON.parse(await readFile('data/cluster.config.json', 'utf8')),
  permutations: 199,
};
await writeFile(demoConfigPath, JSON.stringify(demoConfig, null, 2) + '\n');
console.log('空间集聚分析（Moran I，条件置换；JSON 走 stdout，中文摘要见下）');
const cluster = await main(['cluster', '--config', demoConfigPath, '--out', 'var/cluster.json']);
console.log(JSON.stringify({
  analysis: cluster.document.analysis,
  sensitivity: cluster.document.sensitivity.globalTable,
}, null, 2));
console.log(cluster.summary);
console.log(`完成，用时 ${Math.ceil(performance.now() - started)} 毫秒`);
