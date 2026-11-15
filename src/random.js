// 确定性随机数与置换流：所有分析仅依赖显式种子，输出可逐位复算。

export function fnv1aHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function streamSeed(...parts) {
  return fnv1aHash(parts.map(part => String(part)).join('|'));
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates 洗牌，返回新数组，不改动入参。
export function shuffledCopy(items, rng) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

// 枚举索引的全部排列（小规模精确置换用），按字典序生成。
export function enumeratePermutations(size) {
  if (size > 7) throw new Error('精确置换最多支持 7 个位置，更大样本请使用蒙特卡洛置换');
  const permutations = [];
  const current = [...Array(size).keys()];
  const visit = () => {
    permutations.push([...current]);
    let index = current.length - 2;
    while (index >= 0 && current[index] >= current[index + 1]) index -= 1;
    if (index < 0) return;
    let pivot = current.length - 1;
    while (current[pivot] <= current[index]) pivot -= 1;
    [current[index], current[pivot]] = [current[pivot], current[index]];
    const tail = current.splice(index + 1).reverse();
    current.push(...tail);
    visit();
  };
  visit();
  return permutations;
}
