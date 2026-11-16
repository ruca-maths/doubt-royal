/**
 * 手札評価
 *
 * このゲームは「手札を早く無くす」競争なので、手札の良し悪しを
 *   「正直に出し続けたとして、あと何手番で上がれるか (turnsToFinish)」
 * で測る。7渡し・10捨て・Qボンバー・8切りはこの手数を縮める札として織り込む。
 */
import { Card } from '../types';
import { JOKER, RANKS, rankOf, strengthOf } from './view';
import { BrainParams } from './params';

export interface EvalContext {
  /** 革命中か (禁止上がりの判定と、札の長期的な強さに使う) */
  isRevolution: boolean;
  /** Qボンバーが有効か */
  bombActive: boolean;
}

export function isForbiddenFinish(rank: number, isRevolution: boolean): boolean {
  if (rank === JOKER || rank === 8) return true;
  return rank === (isRevolution ? 3 : 2);
}

/**
 * あと何手番で上がれるかの見積もり (小さいほど良い)。
 *  - 同じランクは1手で出せる (ジョーカーはどの組にも便乗できる)
 *  - 7 / 10 は出した枚数ぶん他の札を処理できる → 小さい組から消す
 *  - Q (ボンバー有効時) は出した枚数ぶんのランクを丸ごと消せる → 大きい組から消す
 *  - 8 は出しても手番が続くので手数に数えない
 *  - ジョーカーは「別のランク」として宣言すれば正直な上がり札になる
 *  - 最後の1手が禁止上がり (8 / 2) にしかならず、ジョーカーも無い場合は +1 (嘘が必要)
 */
export function turnsToFinish(counts: number[], ctx: EvalContext): number {
  let total = 0;
  for (let rank = 0; rank < 14; rank++) total += counts[rank];
  if (total === 0) return 0;

  const bombs = ctx.bombActive ? counts[12] : 0;
  let carriers = 0;      // 効果を運ぶ組 (7, 10, 有効なQ) と 8 の組数
  let cleanCarrier = false; // 禁止上がりにならない組が最後に残せるか
  const removable: number[] = [];
  let hasForbiddenOnly = true;

  for (const rank of RANKS) {
    const size = counts[rank];
    if (size === 0) continue;
    const isCarrier = rank === 7 || rank === 10 || rank === 8 || (bombs > 0 && rank === 12);
    if (isCarrier) {
      carriers++;
      if (rank !== 8) cleanCarrier = true;
      continue;
    }
    removable.push(size);
    if (!isForbiddenFinish(rank, ctx.isRevolution)) hasForbiddenOnly = false;
  }

  if (removable.length === 0 && carriers === 0) {
    // ジョーカーだけ: 別のランクとして宣言すれば正直に上がれる
    return 1;
  }

  // Q: 大きい組から丸ごと消す
  removable.sort((a, b) => b - a);
  const afterBomb = removable.slice(Math.min(bombs, removable.length));

  // 7 / 10: 小さい組から消す
  afterBomb.sort((a, b) => a - b);
  let budget = counts[7] + counts[10];
  let kept = 0;
  let keptClean = false;
  // 禁止ランク以外が1組でも残るかは「消さなかった組」に依存するので、消去は枚数だけで判断する
  for (const size of afterBomb) {
    if (size <= budget) {
      budget -= size;
    } else {
      kept++;
      keptClean = true;
    }
  }
  // 残った組がすべて禁止ランクかどうか (近似: 元の組がすべて禁止ランクだった場合のみ)
  if (hasForbiddenOnly) keptClean = false;

  let plays = kept + carriers;
  let penalty = 0;
  if (!keptClean && !cleanCarrier) {
    if (counts[JOKER] > 0) plays += 1; // ジョーカーを単独で (別ランクとして) 出して上がる
    else penalty = 1;                  // 嘘をつかないと上がれない
  }
  return Math.max(1, plays - (counts[8] > 0 ? 1 : 0)) + penalty;
}

/** 手札の評価値 (大きいほど良い)。空の手札 = 上がり。 */
export function handValue(counts: number[], ctx: EvalContext, params: BrainParams): number {
  let total = 0;
  for (let rank = 0; rank < 14; rank++) total += counts[rank];
  if (total === 0) return params.finishBonus;

  let value = -turnsToFinish(counts, ctx) - params.cardWeight * total;
  value += params.jokerValue * counts[JOKER];
  value += params.eightValue * counts[8];
  for (const rank of RANKS) {
    if (counts[rank] === 0) continue;
    value += params.strengthValue * (strengthOf(rank, ctx.isRevolution) / 12) * counts[rank];
  }
  return value;
}

/**
 * 手札から手放すカードを最大 n 枚選ぶ (7渡し・10捨て・ダウト報酬・嘘で出す札)。
 * 1枚ずつ「抜いたあとの手札評価が最も高くなる札」を貪欲に選ぶ。
 *  - exact = true  : 必ず n 枚選ぶ (嘘で出す札の選択)
 *  - exact = false : 抜くと損になる札しか残っていなければそこで止める
 */
export function pickRemovals(
  hand: Card[],
  n: number,
  ctx: EvalContext,
  params: BrainParams,
  options: { exact?: boolean; excludedRanks?: number[]; keepJokers?: boolean } = {},
): Card[] {
  const excluded = options.excludedRanks ?? [];
  const pool = hand.filter(card => !excluded.includes(rankOf(card)));
  const limit = Math.min(n, pool.length);
  if (limit <= 0) return [];

  // 全部手放せるなら、それが上がり
  if (limit >= hand.length) return [...hand];

  const counts = new Array(14).fill(0);
  for (const card of hand) counts[rankOf(card)]++;
  const available = new Array(14).fill(0);
  for (const card of pool) available[rankOf(card)]++;

  const pickedRanks: number[] = [];
  let current = handValue(counts, ctx, params);
  for (let step = 0; step < limit; step++) {
    let bestRank = -1;
    let bestValue = -Infinity;
    for (let rank = 0; rank < 14; rank++) {
      if (available[rank] === 0) continue;
      if (options.keepJokers && rank === JOKER) continue;
      counts[rank]--;
      const value = handValue(counts, ctx, params);
      counts[rank]++;
      if (value > bestValue) {
        bestValue = value;
        bestRank = rank;
      }
    }
    if (bestRank === -1) {
      if (!options.exact || !options.keepJokers || available[JOKER] === 0) break;
      bestRank = JOKER; // ジョーカーしか残っていない
      counts[JOKER]--;
      bestValue = handValue(counts, ctx, params);
      counts[JOKER]++;
    }
    if (!options.exact && bestValue <= current) break;
    counts[bestRank]--;
    available[bestRank]--;
    pickedRanks.push(bestRank);
    current = bestValue;
  }

  // ランク → 実カードへ。同ランク内ではスペードの3を最後まで残す
  const picked: Card[] = [];
  const used = new Set<string>();
  for (const rank of pickedRanks) {
    const candidates = pool
      .filter(card => rankOf(card) === rank && !used.has(card.id))
      .sort((a, b) => Number(a.suit === 'spade') - Number(b.suit === 'spade'));
    const card = candidates[0];
    if (!card) continue;
    used.add(card.id);
    picked.push(card);
  }
  return picked;
}

export function removeCounts(counts: number[], cards: Card[]): number[] {
  const next = [...counts];
  for (const card of cards) next[rankOf(card)]--;
  return next;
}
