/**
 * 嘘判定モデルの学習データを自己対戦で作る。
 *
 *   npx ts-node -T sim/gen-doubt-data.ts --games 20000 --out ../learn/data/gen0/w0
 *   (Colab ではコンパイル済みの node dist-sim/sim/gen-doubt-data.js を並列に起動する)
 *
 * 2 種類のデータを numpy の .npy 形式で書き出す。
 *   <out>/doubt/ : ダウト受付が開くたびに、ダウトできる全員について
 *                  X = その人から見た特徴量 (src/game/brain/doubtFeatures.ts)、y = 本当に嘘だったか
 *   <out>/risk/  : 宣言のたびに、宣言した本人について
 *                  X = 本人から見た特徴量 (src/game/brain/riskFeatures.ts)、y = 誰かにダウトされたか
 *
 * 卓のメンバーは「リーグ」から毎局ランダムに選ぶ。素直な打ち手だけでなく、同じ嘘を
 * 繰り返す搾取型 (sim/exploiters.ts) も混ぜておくことで、モデルが
 * 「この人はさっきから 8 ばかり言っている」といった履歴の手がかりを学べるようにする。
 *
 * オプション
 *   --games N        対局数 (既定 2000)
 *   --out DIR        出力先ディレクトリ
 *   --shard N        1 ファイルあたりの行数 (既定 200000)
 *   --league NAME    卓の組み方 (default / exploit / self)。下の LEAGUES を参照
 *   --model PATH     brain 席が使う嘘判定モデル (省略時は server/models/doubt-model.json があれば使う)
 *   --no-model       学習済みモデルを使わない (第 0 世代)
 */
import * as fs from 'fs';
import * as path from 'path';
import { runGame } from './driver';
import { loadPolicy } from './registry';
import { Brain } from '../src/game/brain/brain';
import { DOUBT_FEATURE_DIM, DOUBT_FEATURE_NAMES, DOUBT_FEATURE_VERSION } from '../src/game/brain/doubtFeatures';
import { RISK_FEATURE_DIM, RISK_FEATURE_NAMES, RISK_FEATURE_VERSION } from '../src/game/brain/riskFeatures';
import { LearnedDoubt, LearnedRisk } from '../src/game/brain/learnedDoubt';

const realLog = console.log.bind(console);

/** 卓に座る打ち手の出現比率 */
const LEAGUES: Record<string, Record<string, number>> = {
  default: {
    brain: 30,
    'brain:heuristic': 10,
    'brain:bold': 8,
    'brain:timid': 5,
    pro8: 8,
    pro10: 5,
    spam8: 4,
    spam10: 3,
    spamJoker: 4,
    liar: 5,
    sneaky: 4,
    legacy: 8,
    random: 6,
  },
  // 搾取型を多めに (付け込みへの耐性を重点的に鍛える)
  exploit: {
    brain: 30,
    'brain:bold': 10,
    pro8: 15,
    pro10: 10,
    spam8: 8,
    spam10: 5,
    spamJoker: 8,
    liar: 8,
    sneaky: 6,
  },
  // 学習済み brain 同士 (本番に近い分布)
  self: {
    brain: 70,
    'brain:bold': 15,
    'brain:timid': 15,
  },
};

const PLAYER_COUNTS: Array<[number, number]> = [[2, 15], [3, 20], [4, 35], [5, 15], [6, 15]];

/** 補助列 (学習には使わず、評価・分析に使う) — 嘘判定データ */
const AUX_NAMES = [
  'game',            // 対局番号 (検証データを対局単位で分けるため)
  'claimant_policy', // 宣言した人の打ち手 (POLICY_IDS の番号)
  'observer_policy', // 観察者の打ち手
  'heuristic_lie',   // 手作りモデルの嘘確率
  'threshold',       // ダウトの損益分岐点
  'possibility',     // 相手が正直に出せる確率 (0 なら証明可能な嘘)
  'players',         // 卓の人数
  'count',           // 宣言枚数
  'rank',            // 宣言ランク
];

/** 補助列 — ダウト予測データ */
const RISK_AUX_NAMES = [
  'game',            // 対局番号
  'claimant_policy', // 宣言した人の打ち手 (評価スクリプトと列名をそろえる)
  'heuristic',       // 手作りのダウト予測
  'honest',          // 正直な宣言だったか
  'lie',             // 嘘だったか (= 1 - honest。評価用)
  'players',
  'count',
  'rank',
];

function weightedPick<T>(entries: Array<[T, number]>): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

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

/** numpy .npy (v1.0) を書く */
function writeNpy(file: string, data: Float32Array | Uint8Array, shape: number[]): void {
  const descr = data instanceof Float32Array ? '<f4' : '|u1';
  const shapeText = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shapeText}, }`;
  const preamble = 10;
  const pad = 64 - ((preamble + header.length + 1) % 64);
  header = header + ' '.repeat(pad % 64) + '\n';
  const head = Buffer.alloc(preamble);
  head.write('\x93NUMPY', 0, 'latin1');
  head.writeUInt8(1, 6);
  head.writeUInt8(0, 7);
  head.writeUInt16LE(header.length, 8);
  const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  fs.writeFileSync(file, Buffer.concat([head, Buffer.from(header, 'latin1'), body]));
}

class ShardWriter {
  private x: Float32Array;
  private y: Uint8Array;
  private aux: Float32Array;
  private rows = 0;
  private shard = 0;
  total = 0;

  constructor(
    private readonly dir: string,
    private readonly capacity: number,
    private readonly dim: number,
    private readonly auxNames: string[],
  ) {
    this.x = new Float32Array(capacity * dim);
    this.y = new Uint8Array(capacity);
    this.aux = new Float32Array(capacity * auxNames.length);
    fs.mkdirSync(dir, { recursive: true });
  }

  add(features: Float32Array, label: number, aux: number[]): void {
    this.x.set(features, this.rows * this.dim);
    this.y[this.rows] = label;
    this.aux.set(aux, this.rows * this.auxNames.length);
    this.rows++;
    this.total++;
    if (this.rows === this.capacity) this.flush();
  }

  flush(): void {
    if (this.rows === 0) return;
    const name = `shard${String(this.shard).padStart(3, '0')}`;
    writeNpy(path.join(this.dir, `${name}_X.npy`), this.x.subarray(0, this.rows * this.dim), [this.rows, this.dim]);
    writeNpy(path.join(this.dir, `${name}_y.npy`), this.y.subarray(0, this.rows), [this.rows]);
    writeNpy(path.join(this.dir, `${name}_aux.npy`), this.aux.subarray(0, this.rows * this.auxNames.length), [this.rows, this.auxNames.length]);
    this.shard++;
    this.rows = 0;
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const games = parseInt(args.games || '2000', 10);
  const outDir = path.resolve(args.out || path.join('learn', 'data', 'local'));
  const shardSize = parseInt(args.shard || '200000', 10);
  const leagueName = args.league || 'default';
  const league = LEAGUES[leagueName];
  if (!league) throw new Error(`unknown league: ${leagueName} (${Object.keys(LEAGUES).join(', ')})`);
  const gameOffset = parseInt(args['game-offset'] || '0', 10);

  if (args['no-model'] === 'true') {
    LearnedDoubt.set(null);
    LearnedRisk.set(null);
  } else {
    if (args.model) LearnedDoubt.set(LearnedDoubt.loadFile(path.resolve(args.model)));
    if (args['risk-model']) LearnedRisk.set(LearnedRisk.loadFile(path.resolve(args['risk-model'])));
  }
  const model = LearnedDoubt.current();
  const riskModel = LearnedRisk.current();

  const policyNames = Object.keys(league);
  const policyIds = new Map(policyNames.map((name, i) => [name, i]));
  const policies = new Map(policyNames.map(name => [name, loadPolicy(name)]));
  const entries = policyNames.map(name => [name, league[name]] as [string, number]);

  console.log = () => {};
  console.warn = () => {};

  const writer = new ShardWriter(path.join(outDir, 'doubt'), shardSize, DOUBT_FEATURE_DIM, AUX_NAMES);
  const riskWriter = new ShardWriter(path.join(outDir, 'risk'), shardSize, RISK_FEATURE_DIM, RISK_AUX_NAMES);
  let riskDoubted = 0;
  const started = Date.now();
  let stuck = 0;
  let lies = 0;

  for (let g = 0; g < games; g++) {
    const players = weightedPick(PLAYER_COUNTS);
    const seats = Array.from({ length: players }, () => weightedPick(entries));
    const gameId = gameOffset + g;
    let pendingRisk: { features: Float32Array; aux: number[] } | null = null;
    const result = runGame(seats.map(name => policies.get(name)!), {
      onClaim(room, actor, cards, declared, isCounter, actorPolicy) {
        const sample = Brain.riskSample(room, actor, cards, declared, isCounter);
        pendingRisk = sample
          ? {
              features: sample.features,
              aux: [gameId, policyIds.get(actorPolicy) ?? -1, sample.heuristic, sample.honest ? 1 : 0, sample.honest ? 0 : 1, players, cards.length, declared],
            }
          : null;
      },
      onDoubtResolved(_room, doubted) {
        if (!pendingRisk) return;
        riskWriter.add(pendingRisk.features, doubted ? 1 : 0, pendingRisk.aux);
        if (doubted) riskDoubted++;
        pendingRisk = null;
      },
      onDoubtWindow(room, observer, _claimant, wasLie, seatPolicy, claimantPolicy) {
        const sample = Brain.analyzeDoubt(room, observer);
        if (!sample) return;
        const a = sample.analysis;
        writer.add(sample.features, wasLie ? 1 : 0, [
          gameId,
          policyIds.get(claimantPolicy) ?? -1,
          policyIds.get(seatPolicy) ?? -1,
          a.heuristicLie,
          a.threshold,
          a.possibility,
          players,
          a.count,
          a.rank,
        ]);
        if (wasLie) lies++;
      },
    });
    if (result.stuck) stuck++;
    if ((g + 1) % 1000 === 0) {
      realLog(`  ${g + 1}/${games} games, ${writer.total} rows (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    }
  }
  writer.flush();
  riskWriter.flush();

  const riskMeta = {
    kind: 'risk',
    featureVersion: RISK_FEATURE_VERSION,
    featureNames: RISK_FEATURE_NAMES,
    auxNames: RISK_AUX_NAMES,
    policies: policyNames,
    league: leagueName,
    games,
    gameOffset,
    rows: riskWriter.total,
    doubtedRate: riskWriter.total > 0 ? riskDoubted / riskWriter.total : 0,
    usedModel: model ? (model.meta.name ?? 'doubt-model.json') : null,
    usedRiskModel: riskModel ? (riskModel.meta.name ?? 'risk-model.json') : null,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'risk', 'meta.json'), JSON.stringify(riskMeta, null, 2));

  const meta = {
    kind: 'doubt',
    featureVersion: DOUBT_FEATURE_VERSION,
    featureNames: DOUBT_FEATURE_NAMES,
    auxNames: AUX_NAMES,
    policies: policyNames,
    league: leagueName,
    leagueWeights: league,
    games,
    gameOffset,
    rows: writer.total,
    lieRate: writer.total > 0 ? lies / writer.total : 0,
    stuckGames: stuck,
    usedModel: model ? (model.meta.name ?? 'doubt-model.json') : null,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'doubt', 'meta.json'), JSON.stringify(meta, null, 2));
  realLog(
    `wrote ${writer.total} rows from ${games} games to ${outDir} ` +
    `+ ${riskWriter.total} risk rows (lie rate ${(100 * meta.lieRate).toFixed(1)}%, doubted ${(100 * riskMeta.doubtedRate).toFixed(1)}%, ${((Date.now() - started) / 1000).toFixed(0)}s, stuck ${stuck}, model ${meta.usedModel ?? 'none'} / ${riskMeta.usedRiskModel ?? 'none'})`
  );
}

main();
