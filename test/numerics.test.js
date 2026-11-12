import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('服务率按访客总量计算，零访客不报告零服务率', () => {

  assert.equal(probe([{served: 5, visitors: 10}, {served: 15, visitors: 90}]).rate, 0.2);
  assert.equal(probe([{served: 0, visitors: 0}]).rate, null);
});
