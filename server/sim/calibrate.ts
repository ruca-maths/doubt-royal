/**
 * 嘘確率モデルの較正
 *
 *   npx ts-node -T sim/calibrate.ts --games 3000 --seats brain,brain,brain,brain
 *   npx ts-node -T sim/calibrate.ts --games 2000 --fit 10 --damping 0.25
 *
 * 1) 較正チェック: brain が見積もった「嘘確率」と、実際に嘘だった割合を状況別・確率帯別に突き合わせる。
 *    見積もりが実測より高ければダウトしすぎ、低ければ見逃しすぎ。
 *    あわせて、宣言のもっともらしさ別に「誰かにダウトされた割合」と「ダウトの的中率」を出す
 *    (params.baselineDoubt / expectedHit の根拠)。
 * 2) --fit N: brain 同士の自己対戦で状況別の嘘率を測り、基準嘘率 (params.base*) を実測に近づける操作を
 *    N 回繰り返す。嘘をつく側もダウトする側も同じ基準率を使うので、繰り返すと「お互いに相手の
 *    出方を正しく見積もっている」状態 (均衡に近い点) に寄っていく。最後に出た値を params.ts に写す。
 */
import { runGame, Policy } from './driver';
import { legacyPolicy, randomPolicy } from './policies';
import { createBrainPolicy } from './brainPolicy';
import { Brain, DoubtProbe } from '../src/game/brain/brain';
import { BrainParams, DEFAULT_PARAMS } from '../src/game/brain/params';
import { Room } from '../src/game/types';

const realLog = console.log.bind(console);

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[argv[i].slice(2)] = 'true';
    else { args[argv[i].slice(2)] = next; i++; }
  }
  return args;
}

interface Bucket { n: number; predicted: number; lies: number; doubts: number; doubtHits: number }
type Table = Map<string, Bucket[]>;

/** 宣言 1 件ごとの集計 (もっともらしさ別に、誰かにダウトされた割合と的中率を見る) */
interface ClaimRecord { bucket: number; doubted: boolean; lie: boolean }

interface Measurement {
  table: Table;
  claims: ClaimRecord[];
}

const bandOf = (p: number) => Math.min(9, Math.floor(p * 10));
const plausibilityBucket = (h: number) => (h < 0.3 ? 0 : h < 0.7 ? 1 : 2);

function contextOf(probe: DoubtProbe): string {
  if (probe.isCounter) return 'counter';
  const slot = Math.min(probe.count, 3);
  if (probe.finishing) return `final x${slot}`;
  return `${probe.wasLead ? 'lead' : 'follow'} ${probe.special ? 'special' : 'plain'} x${slot}`;
}

function measure(seatNames: string[], games: number, overrides?: Partial<BrainParams>): Measurement {
  const table: Table = new Map();
  const claims = new Map<number, ClaimRecord>();

  const record = (context: string, probe: DoubtProbe, wasLie: boolean): void => {
    if (!table.has(context)) {
      table.set(context, Array.from({ length: 10 }, () => ({ n: 0, predicted: 0, lies: 0, doubts: 0, doubtHits: 0 })));
    }
    const bucket = table.get(context)![bandOf(probe.lieProbability)];
    bucket.n++;
    bucket.predicted += probe.lieProbability;
    if (wasLie) bucket.lies++;
    if (probe.decided) {
      bucket.doubts++;
      if (wasLie) bucket.doubtHits++;
    }
  };

  // 宣言ごとの通し番号 (同じ宣言を複数の観察者が見る)
  let currentRoom: Room | null = null;
  let claimSerial = 0;
  let lastClaimLogId = '';
  const claimKey = (room: Room): number => {
    let id = '';
    for (let i = room.logs.length - 1; i >= 0; i--) {
      if (room.logs[i].action === 'play') { id = room.logs[i].id; break; }
    }
    if (id !== lastClaimLogId) { lastClaimLogId = id; claimSerial++; }
    return claimSerial;
  };

  const base = seatNames.map(name =>
    name === 'legacy' ? legacyPolicy : name === 'random' ? randomPolicy : createBrainPolicy(name, overrides)
  );
  const policies: Policy[] = base.map(p => ({
    ...p,
    shouldDoubt: (room, player) => {
      currentRoom = room;
      const key = claimKey(room);
      const decided = p.shouldDoubt(room, player);
      if (decided) {
        const entry = claims.get(key);
        if (entry) entry.doubted = true;
        else claims.set(key, { bucket: -1, doubted: true, lie: false });
      }
      return decided;
    },
  }));

  Brain.probe = probe => {
    const room = currentRoom;
    if (!room) return;
    const cards = room.field.currentCards;
    const declared = room.field.declaredNumber;
    const wasLie = probe.isCounter && declared === 3
      ? cards.length !== 1 || cards[0].suit !== 'spade' || cards[0].number !== 3
      : cards.some(card => !card.isJoker && card.number !== declared);
    record(contextOf(probe), probe, wasLie);
    record('ALL', probe, wasLie);

    const key = claimKey(room);
    const bucket = plausibilityBucket(probe.publicPossibility);
    const entry = claims.get(key);
    if (entry) {
      entry.bucket = bucket;
      entry.lie = wasLie;
    } else {
      claims.set(key, { bucket, doubted: false, lie: wasLie });
    }
  };

  for (let g = 0; g < games; g++) {
    const shift = g % policies.length;
    runGame(policies.map((_, i) => policies[(i + shift) % policies.length]));
  }
  Brain.probe = null;
  return { table, claims: [...claims.values()] };
}

function totals(buckets: Bucket[]): { n: number; lies: number; doubts: number; hits: number } {
  return buckets.reduce(
    (acc, b) => ({ n: acc.n + b.n, lies: acc.lies + b.lies, doubts: acc.doubts + b.doubts, hits: acc.hits + b.doubtHits }),
    { n: 0, lies: 0, doubts: 0, hits: 0 },
  );
}

function printTable(title: string, table: Table): void {
  realLog('');
  realLog(`=== ${title} ===`);
  realLog('context'.padEnd(20) + 'n'.padStart(8) + '  lie%  doubt%  hit%   | 見積もり帯ごとの 見積もり%→実測% (件数)');
  for (const [context, buckets] of [...table.entries()].sort()) {
    const t = totals(buckets);
    const bands = buckets
      .map(b => b.n >= 30 ? `${(100 * b.predicted / b.n).toFixed(0)}→${(100 * b.lies / b.n).toFixed(0)}(${b.n})` : '')
      .filter(Boolean)
      .join(' ');
    realLog(
      context.padEnd(20) + String(t.n).padStart(8) +
      `  ${(100 * t.lies / t.n).toFixed(1).padStart(4)}  ${(100 * t.doubts / t.n).toFixed(1).padStart(5)}  ${(t.doubts ? 100 * t.hits / t.doubts : 0).toFixed(1).padStart(5)}  | ${bands}`
    );
  }
}

function printBuckets(claims: ClaimRecord[]): void {
  const labels = ['怪しい (h<0.3)', '中間', 'もっともらしい (h>0.7)'];
  realLog('');
  realLog('もっともらしさ別 (宣言単位): 件数 / 嘘の割合 / 誰かにダウトされた割合 / ダウトの的中率');
  for (let bucket = 0; bucket < 3; bucket++) {
    let n = 0, lies = 0, doubted = 0, hits = 0;
    for (const entry of claims) {
      if (entry.bucket !== bucket) continue;
      n++;
      if (entry.lie) lies++;
      if (entry.doubted) {
        doubted++;
        if (entry.lie) hits++;
      }
    }
    if (n === 0) continue;
    realLog(
      `  ${labels[bucket].padEnd(22)} n=${String(n).padStart(6)}  lie ${(100 * lies / n).toFixed(1)}%  ` +
      `doubted ${(100 * doubted / n).toFixed(1)}%  hit ${(doubted ? 100 * hits / doubted : 0).toFixed(1)}%`
    );
  }
}

type BaseKey = 'baseLeadPlain' | 'baseLeadSpecial' | 'baseFollowPlain' | 'baseFollowSpecial' | 'baseFinal';
const ARRAY_KEYS: Array<[BaseKey, string]> = [
  ['baseLeadPlain', 'lead plain'],
  ['baseLeadSpecial', 'lead special'],
  ['baseFollowPlain', 'follow plain'],
  ['baseFollowSpecial', 'follow special'],
  ['baseFinal', 'final'],
];

function fit(games: number, iterations: number, damping: number): void {
  const current: Partial<BrainParams> = {};
  for (const [key] of ARRAY_KEYS) current[key] = [...DEFAULT_PARAMS[key]];
  current.baseCounter = DEFAULT_PARAMS.baseCounter;

  const rateOf = (table: Table, context: string, fallback: number): number => {
    const buckets = table.get(context);
    if (!buckets) return fallback;
    const t = totals(buckets);
    // 件数が少ない状況は現在値に寄せる
    return (t.lies + 20 * fallback) / (t.n + 20);
  };

  for (let iteration = 1; iteration <= iterations; iteration++) {
    const { table, claims } = measure(['brain', 'brain', 'brain', 'brain'], games, current);
    for (const [key, label] of ARRAY_KEYS) {
      const values = current[key] as number[];
      for (let slot = 0; slot < 3; slot++) {
        const measured = rateOf(table, `${label} x${slot + 1}`, values[slot]);
        values[slot] = Math.min(0.9, Math.max(0.02, values[slot] + damping * (measured - values[slot])));
      }
    }
    const measuredCounter = rateOf(table, 'counter', current.baseCounter!);
    current.baseCounter = Math.min(0.9, Math.max(0.02, current.baseCounter! + damping * (measuredCounter - current.baseCounter!)));

    const all = totals(table.get('ALL')!);
    const summary = ARRAY_KEYS
      .map(([key]) => `${key.replace('base', '')}=[${(current[key] as number[]).map(v => v.toFixed(2)).join(',')}]`)
      .join(' ');
    realLog(
      `iter ${String(iteration).padStart(2)}: lie ${(100 * all.lies / all.n).toFixed(1)}% doubt ${(100 * all.doubts / all.n).toFixed(1)}% ` +
      `hit ${(all.doubts ? 100 * all.hits / all.doubts : 0).toFixed(1)}% | ${summary} Counter=${current.baseCounter!.toFixed(2)}`
    );
    if (iteration === iterations) {
      printTable(`fit 後の較正 (${games} games)`, table);
      printBuckets(claims);
    }
  }

  const rounded: Record<string, unknown> = {};
  for (const [key] of ARRAY_KEYS) rounded[key] = (current[key] as number[]).map(v => Math.round(v * 100) / 100);
  rounded.baseCounter = Math.round(current.baseCounter! * 100) / 100;
  realLog('');
  realLog('params.ts に写す値:');
  realLog(JSON.stringify(rounded));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const games = parseInt(args.games || '2000', 10);
  console.log = () => {};
  console.warn = () => {};

  if (args.fit) {
    fit(games, parseInt(args.fit, 10) || 8, parseFloat(args.damping || '0.3'));
    return;
  }
  const seatNames = (args.seats || 'brain,brain,brain,brain').split(',');
  const { table, claims } = measure(seatNames, games);
  printTable(`calibration: ${seatNames.join(',')} (${games} games)`, table);
  printBuckets(claims);
}

main();
