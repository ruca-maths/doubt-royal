/**
 * 確率の道具 (超幾何分布)。
 * 「N 枚のうち K 枚が当たり。そこから n 枚持っている人が、当たりを need 枚以上持つ確率」を求める。
 */

const LOG_FACT: number[] = [0];
for (let i = 1; i <= 80; i++) LOG_FACT.push(LOG_FACT[i - 1] + Math.log(i));

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return LOG_FACT[n] - LOG_FACT[k] - LOG_FACT[n - k];
}

function pmfInt(N: number, K: number, n: number, j: number): number {
  if (j < 0 || j > K || j > n || n - j > N - K) return 0;
  return Math.exp(logChoose(K, j) + logChoose(N - K, n - j) - logChoose(N, n));
}

function tailInt(N: number, K: number, n: number, need: number): number {
  if (need <= 0) return 1;
  if (K < need || n < need) return 0;
  let total = 0;
  const top = Math.min(K, n);
  for (let j = need; j <= top; j++) total += pmfInt(N, K, n, j);
  return Math.min(1, Math.max(0, total));
}

function normalize(N: number, K: number, n: number): { N: number; K: number; n: number } {
  const Ni = Math.max(1, Math.min(80, Math.round(N)));
  return { N: Ni, K: Math.max(0, Math.min(Ni, K)), n: Math.max(0, Math.min(Ni, Math.round(n))) };
}

/** 当たりを need 枚以上持つ確率。K が期待値 (実数) のときは前後の整数で線形補間する */
export function hyperTail(N: number, K: number, n: number, need: number): number {
  const a = normalize(N, K, n);
  const lo = Math.floor(a.K);
  const hi = Math.ceil(a.K);
  if (lo === hi) return tailInt(a.N, lo, a.n, need);
  const w = a.K - lo;
  return (1 - w) * tailInt(a.N, lo, a.n, need) + w * tailInt(a.N, hi, a.n, need);
}

/** 当たりをちょうど j 枚持つ確率 */
export function hyperPmf(N: number, K: number, n: number, j: number): number {
  const a = normalize(N, K, n);
  const lo = Math.floor(a.K);
  const hi = Math.ceil(a.K);
  if (lo === hi) return pmfInt(a.N, lo, a.n, j);
  const w = a.K - lo;
  return (1 - w) * pmfInt(a.N, lo, a.n, j) + w * pmfInt(a.N, hi, a.n, j);
}

export function sigmoid(x: number): number {
  if (x > 30) return 1;
  if (x < -30) return 0;
  return 1 / (1 + Math.exp(-x));
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
