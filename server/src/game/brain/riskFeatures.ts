/**
 * ダウト予測モデルの特徴量: 「自分がこれから出す宣言が、誰かにダウトされる確率」を見積もる入力。
 *
 * brain は出し方を決めるとき、候補手ごとに「ダウトされる確率 q」を使って期待値を比べる
 * (q が高すぎる嘘はつかない / 正直な手でダウトを誘う)。手作りの q は相手が手作りの判定で
 * ダウトしてくる前提だったので、相手が学習モデルでダウトするようになると外れる。
 * それを自己対戦のデータ (実際にダウトされたか) から学習し直すための入力。
 *
 * 学習 (sim/gen-doubt-data.ts → learn/train_doubt.py --kind risk) と推論の両方がこの関数を使う。
 * ここを変えたら RISK_FEATURE_VERSION を上げること。
 */
import { BrainMemory, plausibilityBucket } from './memory';
import { JOKER, PlayerView, nextActiveSeat, strengthOf } from './view';

export const RISK_FEATURE_VERSION = 1;

export interface RiskClaim {
  rank: number;
  count: number;
  isCounter: boolean;
  wasLead: boolean;
  finishing: boolean;
  forbiddenFinish: boolean;
  /** 宣言前の手札枚数 */
  handBefore: number;
  /** 出すカードが宣言どおりか */
  honest: boolean;
  /** 公開情報だけで見た「この宣言を正直にできる確率」 */
  publicPossibility: number;
  /** 手作りのダウト予測 */
  heuristicRisk: number;
}

export interface RiskFeatureInput {
  view: PlayerView;
  mem: BrainMemory;
  /** 自分の手札 (出す前) のランク別枚数 */
  my: number[];
  /** 公開されている札のランク別枚数 */
  faceUp: number[];
  claim: RiskClaim;
}

const RANK_NAMES = ['JOKER', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export const RISK_FEATURE_NAMES: string[] = [
  ...RANK_NAMES.map(name => `claim_rank_${name}`),
  'claim_count_1', 'claim_count_2', 'claim_count_3', 'claim_count_4plus',
  'is_counter', 'is_spade3_counter', 'was_lead', 'finishing', 'special', 'forbidden_finish', 'honest',
  'hand_before', 'hand_after', 'my_lives',
  'prev_count', 'prev_strength', 'claim_strength',
  'reversed', 'revolution', 'eleven_back', 'bomb_active',
  'opponents', 'opp_min_cards', 'opp_mean_cards', 'opp_min_lives', 'opp_mean_lives', 'opp_last_life', 'next_cards', 'next_lives',
  'my_rank_held', 'my_jokers_held', 'faceup_rank', 'faceup_jokers', 'passed_rank_all', 'passed_jokers_all',
  'h_public', 'heuristic_risk',
  'me_claims', 'me_claimed_rank', 'me_streak', 'me_special_claims', 'me_caught', 'me_proven',
  'table_doubt_rate', 'table_lie_rate', 'opp_doubt_rate_mean', 'opp_doubt_rate_max',
  'total_claims', 'cards_in_hands',
];

export const RISK_FEATURE_DIM = RISK_FEATURE_NAMES.length;

export function riskFeatures(input: RiskFeatureInput): Float32Array {
  const { view, mem, my, faceUp, claim: c } = input;
  const x = new Float32Array(RISK_FEATURE_DIM);
  let i = 0;
  const put = (value: number) => { x[i++] = Number.isFinite(value) ? value : 0; };

  const rank = c.rank;
  const isJoker = rank === JOKER;
  const special = rank === 7 || rank === 8 || rank === 10 || (rank === 12 && view.bombActive);

  // ---- 宣言 ----
  for (let r = 0; r < 14; r++) put(r === rank ? 1 : 0);
  put(c.count === 1 ? 1 : 0);
  put(c.count === 2 ? 1 : 0);
  put(c.count === 3 ? 1 : 0);
  put(c.count >= 4 ? 1 : 0);
  put(c.isCounter ? 1 : 0);
  put(c.isCounter && rank === 3 ? 1 : 0);
  put(c.wasLead ? 1 : 0);
  put(c.finishing ? 1 : 0);
  put(special ? 1 : 0);
  put(c.forbiddenFinish ? 1 : 0);
  put(c.honest ? 1 : 0);
  put(c.handBefore / 20);
  put((c.handBefore - c.count) / 20);
  put(view.lives / 3);
  put(view.fieldCount / 6);
  put(view.fieldCount === 0 ? 0 : Math.min(1.2, strengthOf(view.fieldRank, view.reversed) / 12));
  put(isJoker ? 1.2 : strengthOf(rank, view.reversed) / 12);
  put(view.reversed ? 1 : 0);
  put(view.isRevolution ? 1 : 0);
  put(view.isElevenBack ? 1 : 0);
  put(view.bombActive ? 1 : 0);

  // ---- 相手 (ダウトする側) ----
  const opps = view.opponents;
  const cards = opps.map(o => o.cardCount);
  const lives = opps.map(o => o.lives);
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const next = nextActiveSeat(view, view.myId);
  put(opps.length / 5);
  put((cards.length ? Math.min(...cards) : 0) / 20);
  put(mean(cards) / 20);
  put((lives.length ? Math.min(...lives) : 0) / 3);
  put(mean(lives) / 3);
  put(lives.filter(l => l === 1).length / 5);
  put((next?.cardCount ?? 0) / 20);
  put((next?.lives ?? 0) / 3);

  // ---- 枚数の情報 ----
  put(isJoker ? my[JOKER] / 2 : my[rank] / 4);
  put(my[JOKER] / 2);
  put(isJoker ? faceUp[JOKER] / 2 : faceUp[rank] / 4);
  put(faceUp[JOKER] / 2);
  put(isJoker ? mem.publicClaimed[JOKER] / 2 : mem.publicClaimed[rank] / 4);
  put(mem.publicClaimed[JOKER] / 2);
  put(c.publicPossibility);
  put(c.heuristicRisk);

  // ---- 自分の公開された履歴 (相手から見た自分) ----
  const history = mem.history(view.myId);
  const profile = mem.profile(view.myId);
  let specialClaims = 0;
  for (const r of [7, 8, 10, 12]) specialClaims += history.claimedCards[r];
  put(profile.claims / 20);
  put(history.claimedCards[rank] / 4);
  put(history.streakRank === rank ? Math.min(6, history.streak) / 5 : 0);
  put(specialClaims / 10);
  put(profile.caughtLies / 5);
  put(profile.provenHonest / 5);

  // ---- 卓と相手のダウトの傾向 ----
  const bucket = mem.table[plausibilityBucket(c.publicPossibility)];
  put((bucket.doubted + 1) / (bucket.claims + 4));
  put((bucket.lies + 1) / (bucket.lies + bucket.truths + 2));
  const rates = opps.map(o => {
    const p = mem.profile(o.id);
    return (p.doubtsMade + 0.5) / (p.doubtChances + 4);
  });
  put(mean(rates));
  put(rates.length ? Math.max(...rates) : 0);

  // ---- 進行度 ----
  put(mem.totalClaims / 60);
  put((view.hand.length + cards.reduce((s, v) => s + v, 0)) / 54);

  if (i !== RISK_FEATURE_DIM) throw new Error(`risk feature size mismatch: ${i} != ${RISK_FEATURE_DIM}`);
  return x;
}
