/**
 * ダウト判断用の特徴量 (学習モデルの入力)。
 *
 * 学習 (server/sim/gen-doubt-data.ts → server/learn/train_doubt.py) と
 * 本番の推論 (learnedDoubt.ts) の両方がこの関数を使う。ここを変えたら
 * DOUBT_FEATURE_VERSION を上げること (古いモデルは自動的に使われなくなる)。
 *
 * 入力に使ってよいのは「その観察者がルール上知っている情報」だけ:
 *   自分の手札 / 公開された札 / 公開ログから作った履歴 (BrainMemory)。
 */
import { BrainMemory, plausibilityBucket } from './memory';
import { JOKER, PlayerView, SeatView, nextActiveSeat, strengthOf } from './view';

export const DOUBT_FEATURE_VERSION = 1;

/** Brain がダウト判断の途中で計算した値 (特徴量にも使う) */
export interface DoubtAnalysis {
  rank: number;
  count: number;
  isCounter: boolean;
  wasLead: boolean;
  finishing: boolean;
  finishingByEffect: boolean;
  forbiddenFinish: boolean;
  handBefore: number;
  /** 自分の情報込みで、相手が正直に出せる確率 */
  possibility: number;
  /** 公開情報だけで見た同じ確率 */
  publicPossibility: number;
  /** 手作りモデルによる嘘確率 */
  heuristicLie: number;
  /** ダウトの損益分岐点 */
  threshold: number;
}

export interface DoubtFeatureInput {
  view: PlayerView;
  mem: BrainMemory;
  claimant: SeatView;
  /** 自分の手札のランク別枚数 */
  my: number[];
  /** 公開されている札のランク別枚数 */
  faceUp: number[];
  /** 自分から見て所在不明な札のランク別枚数 */
  unknown: number[];
  analysis: DoubtAnalysis;
}

const RANK_NAMES = ['JOKER', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** 特徴量の名前 (並び順 = ベクトルの添字)。学習スクリプトとモデルファイルにも書き出す */
export const DOUBT_FEATURE_NAMES: string[] = [
  ...RANK_NAMES.map(name => `claim_rank_${name}`),
  'claim_count_1', 'claim_count_2', 'claim_count_3', 'claim_count_4plus',
  'is_counter', 'is_spade3_counter', 'was_lead', 'finishing', 'finishing_by_effect', 'special', 'forbidden_finish',
  'claimant_cards_after', 'claimant_hand_before', 'claimant_lives',
  'prev_none', 'prev_count', 'prev_strength', 'claim_strength',
  'reversed', 'revolution', 'eleven_back', 'bomb_active', 'bomb_numbers',
  'active_players', 'seats', 'i_am_next',
  'my_rank', 'my_jokers', 'my_hand', 'my_lives',
  'faceup_rank', 'faceup_jokers', 'passed_rank_all', 'passed_jokers_all',
  'unknown_rank', 'unknown_jokers', 'overclaim',
  'h_private', 'h_public', 'log_evidence', 'heuristic_lie', 'threshold',
  'cl_claims', 'cl_claimed_rank', 'cl_passed_rank', 'cl_claimed_jokers', 'cl_streak', 'cl_special_claims',
  'cl_caught', 'cl_proven', 'cl_doubts_made', 'cl_known_held_rank', 'cl_prior_lie',
  'table_lie_rate', 'table_doubt_rate',
  'total_claims', 'cards_in_hands', 'face_down_cards',
  ...RANK_NAMES.map(name => `my_count_${name}`),
  ...RANK_NAMES.map(name => `faceup_${name}`),
  ...RANK_NAMES.map(name => `passed_${name}`),
];

export const DOUBT_FEATURE_DIM = DOUBT_FEATURE_NAMES.length;

const SPECIAL = new Set([7, 8, 10]);

function logit(p: number): number {
  const q = Math.min(0.999, Math.max(0.001, p));
  return Math.log(q / (1 - q));
}

export function doubtFeatures(input: DoubtFeatureInput): Float32Array {
  const { view, mem, claimant, my, faceUp, unknown, analysis: a } = input;
  const x = new Float32Array(DOUBT_FEATURE_DIM);
  let i = 0;
  const put = (value: number) => { x[i++] = Number.isFinite(value) ? value : 0; };

  const rank = a.rank;
  const isJokerClaim = rank === JOKER;
  const special = SPECIAL.has(rank) || (rank === 12 && view.bombActive);

  // ---- 宣言そのもの ----
  for (let r = 0; r < 14; r++) put(r === rank ? 1 : 0);
  put(a.count === 1 ? 1 : 0);
  put(a.count === 2 ? 1 : 0);
  put(a.count === 3 ? 1 : 0);
  put(a.count >= 4 ? 1 : 0);
  put(a.isCounter ? 1 : 0);
  put(a.isCounter && rank === 3 ? 1 : 0);
  put(a.wasLead ? 1 : 0);
  put(a.finishing ? 1 : 0);
  put(a.finishingByEffect ? 1 : 0);
  put(special ? 1 : 0);
  put(a.forbiddenFinish ? 1 : 0);
  put(claimant.cardCount / 20);
  put(a.handBefore / 20);
  put(claimant.lives / 3);
  put(view.previousFieldCount === 0 ? 1 : 0);
  put(view.previousFieldCount / 6);
  put(view.previousFieldCount === 0 ? 0 : Math.min(1.2, strengthOf(view.previousFieldRank, view.reversed) / 12));
  put(isJokerClaim ? 1.2 : strengthOf(rank, view.reversed) / 12);

  // ---- ルールの状態 ----
  put(view.reversed ? 1 : 0);
  put(view.isRevolution ? 1 : 0);
  put(view.isElevenBack ? 1 : 0);
  put(view.bombActive ? 1 : 0);
  put((view.pendingNumbers?.length ?? 0) / 4);
  put(view.activeCount / 6);
  put(view.seats.length / 6);
  put(nextActiveSeat(view, claimant.id)?.id === view.myId ? 1 : 0);

  // ---- 自分 ----
  put(isJokerClaim ? my[JOKER] / 2 : my[rank] / 4);
  put(my[JOKER] / 2);
  put(view.hand.length / 20);
  put(view.lives / 3);

  // ---- 公開情報 ----
  put(isJokerClaim ? faceUp[JOKER] / 2 : faceUp[rank] / 4);
  put(faceUp[JOKER] / 2);
  put(isJokerClaim ? mem.publicClaimed[JOKER] / 2 : mem.publicClaimed[rank] / 4);
  put(mem.publicClaimed[JOKER] / 2);
  put(isJokerClaim ? unknown[JOKER] / 2 : unknown[rank] / 4);
  put(unknown[JOKER] / 2);
  // これまでに通った宣言 + 今回の宣言が、所在不明な枚数をどれだけ超えているか (正なら誰かが嘘をついている)
  const supply = isJokerClaim ? unknown[JOKER] : unknown[rank] + unknown[JOKER];
  put((mem.publicClaimed[rank] + a.count - supply) / 4);

  // ---- 手作りモデルの見積もり (強い事前知識として渡す) ----
  put(a.possibility);
  put(a.publicPossibility);
  const hp = Math.min(0.998, Math.max(0.002, a.possibility));
  const hq = Math.min(0.998, Math.max(0.002, a.publicPossibility));
  put(Math.max(-4, Math.min(4, Math.log(((1 - hp) / (1 - hq)) * (hq / hp)))));
  put(logit(a.heuristicLie) / 4);
  put(Math.min(2, a.threshold));

  // ---- 宣言した人の履歴 (付け込みの検出用) ----
  const history = mem.history(claimant.id);
  const profile = mem.profile(claimant.id);
  let specialClaims = 0;
  for (const r of [7, 8, 10, 12]) specialClaims += history.claimedCards[r];
  put(profile.claims / 20);
  put(history.claimedCards[rank] / 4);
  put(history.passedCards[rank] / 4);
  put(history.claimedCards[JOKER] / 2);
  put(history.streakRank === rank ? Math.min(6, history.streak) / 5 : 0);
  put(specialClaims / 10);
  put(profile.caughtLies / 5);
  put(profile.provenHonest / 5);
  put(profile.doubtsMade / 5);
  put((mem.knownHeld.get(claimant.id)?.[rank] ?? 0) / 4);
  put(mem.priorLieRate(claimant.id));

  // ---- 卓全体の傾向 ----
  const bucket = mem.table[plausibilityBucket(a.publicPossibility)];
  put((bucket.lies + 1) / (bucket.lies + bucket.truths + 2));
  put((bucket.doubted + 1) / (bucket.claims + 4));

  // ---- 進行度 ----
  let cardsInHands = view.hand.length;
  for (const seat of view.opponents) cardsInHands += seat.cardCount;
  put(mem.totalClaims / 60);
  put(cardsInHands / 54);
  put(view.faceDownCount / 54);

  // ---- ランク別の全体像 ----
  for (let r = 0; r < 14; r++) put(my[r] / (r === JOKER ? 2 : 4));
  for (let r = 0; r < 14; r++) put(faceUp[r] / (r === JOKER ? 2 : 4));
  for (let r = 0; r < 14; r++) put(mem.publicClaimed[r] / (r === JOKER ? 2 : 4));

  if (i !== DOUBT_FEATURE_DIM) throw new Error(`doubt feature size mismatch: ${i} != ${DOUBT_FEATURE_DIM}`);
  return x;
}
