/**
 * 自己対戦アリーナ
 *
 * 使い方 (server ディレクトリで):
 *   npx ts-node -T sim/arena.ts --games 2000 --seats brain,legacy,legacy,legacy
 *   npx ts-node -T sim/arena.ts --games 2000 --seats brain,brain,legacy,legacy --check
 *
 * --seats   座席ごとの思考ルーチン (brain / legacy / random)。人数 = 要素数 (2〜6)
 * --games   対局数 (席順は毎回ローテーションして先手番の偏りを消す)
 * --check   毎ステップ、カード54枚の保存則を検査する
 */
import { runGame, Policy, GameResult } from './driver';
import { loadPolicy } from './registry';

const realLog = console.log.bind(console);

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true';
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

interface Tally {
  games: number;
  scoreSum: number;
  scoreSqSum: number;
  wins: number;
  rankSum: number;
  ranked: number;
  outLives: number;
  outForbidden: number;
  lies: number;
  liesCaught: number;
  doubts: number;
  doubtsCorrect: number;
}

function emptyTally(): Tally {
  return {
    games: 0, scoreSum: 0, scoreSqSum: 0, wins: 0, rankSum: 0, ranked: 0,
    outLives: 0, outForbidden: 0, lies: 0, liesCaught: 0, doubts: 0, doubtsCorrect: 0,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const seatNames = (args.seats || 'legacy,legacy,legacy,legacy').split(',').map(s => s.trim()).filter(Boolean);
  const games = parseInt(args.games || '1000', 10);
  const check = args.check === 'true';
  const verbose = args.verbose === 'true';

  const basePolicies = seatNames.map(loadPolicy);
  const tallies = new Map<string, Tally>();
  for (const p of basePolicies) if (!tallies.has(p.name)) tallies.set(p.name, emptyTally());

  let stuckCount = 0;
  const stuckReasons = new Map<string, number>();
  const softIssues = new Map<string, number>();
  let totalSteps = 0;
  const totals = { plays: 0, lies: 0, passes: 0, doubts: 0, doubtSuccess: 0, doubtFailure: 0, counters: 0 };

  if (!verbose) {
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
  }

  const started = Date.now();
  for (let g = 0; g < games; g++) {
    // 席順ローテーション
    const shift = g % basePolicies.length;
    const policies = basePolicies.map((_, i) => basePolicies[(i + shift) % basePolicies.length]);
    let result: GameResult;
    try {
      result = runGame(policies, { checkInvariants: check });
    } catch (err) {
      stuckCount++;
      const reason = `exception: ${(err as Error).message}`;
      stuckReasons.set(reason, (stuckReasons.get(reason) || 0) + 1);
      if (stuckReasons.get(reason) === 1) realLog((err as Error).stack);
      continue;
    }
    for (const [issue, count] of result.softIssues) {
      softIssues.set(issue, (softIssues.get(issue) || 0) + count);
    }
    if (result.stuck) {
      stuckCount++;
      stuckReasons.set(result.stuck, (stuckReasons.get(result.stuck) || 0) + 1);
      continue;
    }
    totalSteps += result.steps;
    (Object.keys(totals) as Array<keyof typeof totals>).forEach(k => { totals[k] += result.stats[k]; });
    for (const seat of result.seats) {
      const t = tallies.get(seat.policy)!;
      t.games++;
      t.scoreSum += seat.score;
      t.scoreSqSum += seat.score * seat.score;
      if (seat.rank === 1) t.wins++;
      if (seat.rank !== null) { t.rankSum += seat.rank; t.ranked++; }
      if (seat.eliminated === 'lives') t.outLives++;
      if (seat.eliminated === 'forbidden') t.outForbidden++;
      t.lies += seat.lies;
      t.liesCaught += seat.liesCaught;
      t.doubts += seat.doubts;
      t.doubtsCorrect += seat.doubtsCorrect;
    }
  }
  const elapsed = (Date.now() - started) / 1000;

  const completed = games - stuckCount;
  realLog(`\n=== ${seatNames.join(' vs ')} | ${games} games (${completed} completed) in ${elapsed.toFixed(1)}s ===`);
  if (completed > 0) {
    realLog(
      `avg steps/game ${(totalSteps / completed).toFixed(1)} | plays ${(totals.plays / completed).toFixed(1)} ` +
      `(lies ${(100 * totals.lies / Math.max(1, totals.plays + totals.counters)).toFixed(1)}%) | passes ${(totals.passes / completed).toFixed(1)} | ` +
      `doubts ${(totals.doubts / completed).toFixed(2)} (hit ${(100 * totals.doubtSuccess / Math.max(1, totals.doubts)).toFixed(1)}%) | counters ${(totals.counters / completed).toFixed(2)}`
    );
  }
  const header = ['policy', 'seats', 'score', '±95%', 'win%', 'avgRank', 'out(life)%', 'out(禁止)%', 'lie/g', 'caught%', 'doubt/g', 'hit%'];
  const rows: string[][] = [header];
  for (const [name, t] of tallies) {
    if (t.games === 0) continue;
    const mean = t.scoreSum / t.games;
    const variance = Math.max(0, t.scoreSqSum / t.games - mean * mean);
    const ci = 1.96 * Math.sqrt(variance / t.games);
    rows.push([
      name,
      String(t.games),
      mean.toFixed(3),
      ci.toFixed(3),
      (100 * t.wins / t.games).toFixed(1),
      t.ranked > 0 ? (t.rankSum / t.ranked).toFixed(2) : '-',
      (100 * t.outLives / t.games).toFixed(1),
      (100 * t.outForbidden / t.games).toFixed(1),
      (t.lies / t.games).toFixed(2),
      t.lies > 0 ? (100 * t.liesCaught / t.lies).toFixed(1) : '-',
      (t.doubts / t.games).toFixed(2),
      t.doubts > 0 ? (100 * t.doubtsCorrect / t.doubts).toFixed(1) : '-',
    ]);
  }
  const widths = header.map((_, c) => Math.max(...rows.map(r => r[c].length)));
  for (const row of rows) realLog(row.map((cell, c) => cell.padEnd(widths[c])).join('  '));

  if (stuckCount > 0) {
    realLog(`\n進行不能 / 異常終了: ${stuckCount} games`);
    for (const [reason, count] of [...stuckReasons.entries()].sort((a, b) => b[1] - a[1])) {
      realLog(`  ${count}x ${reason}`);
    }
  }
  if (softIssues.size > 0) {
    realLog(`\n軽微な不整合 (延べステップ数):`);
    for (const [issue, count] of [...softIssues.entries()].sort((a, b) => b[1] - a[1])) {
      realLog(`  ${count}x ${issue}`);
    }
  }
}

main();
