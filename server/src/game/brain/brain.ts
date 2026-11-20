/**
 * Brain — DOUBT ROYALE の CPU 思考ルーチン
 *
 * 設計の骨子
 *  1. 情報の制限     : 必ず PlayerView (自分の手札 + 公開情報) だけを見る。他人の手札は見ない。
 *  2. カウンティング : 自分の手札・表向き墓地・自分が沈めた札・通った宣言から、
 *                      各ランクが「まだ相手の手札にありそうな枚数」を推定する (memory.ts)。
 *  3. 嘘確率の推定   : 嘘つきは「疑われにくい宣言」を選ぶので、宣言のもっともらしさだけでは嘘を見抜けない。
 *                      そこで (a) 状況別の基準嘘率 (親番か / 上がりか / 効果札か / 枚数) を出発点に、
 *                      (b) 自分の手札を知っているぶんだけ変わる尤度比
 *                          [(1-h自)/(1-h公)] × [h公/h自]   (h = 相手が正直に出せる確率, 超幾何分布)
 *                      (c) 相手ごとの嘘つき傾向 (過去のダウト結果) を掛けてオッズを更新する。
 *  4. ダウト判断     : 当たったときの得 G と外したときの損 L から損益分岐点 τ = L/(G+L) を出し、
 *                      P(嘘) > τ のときだけダウトする。ライフが減るほど τ は上がる。
 *  5. 出し方         : 正直な手・嘘の手・パスを列挙し、
 *                      期待値 = (1-q)×通ったときの手札評価 + q×ダウトされたときの手札評価
 *                      が最大の手を選ぶ。q は「相手も同じ考え方でダウトしてくる」と仮定して計算する。
 *  6. 手札評価       : 「あと何手番で上がれるか」(evaluate.ts)。7渡し・10捨て・Qボンバー・8切りを織り込む。
 */
import { Card, PendingEffect, Player, Room } from '../types';
import { BrainMemory, isSpadeThree, plausibilityBucket, publicPossibility, publicRemaining } from './memory';
import { BrainParams, DEFAULT_PARAMS } from './params';
import { clamp, hyperPmf, hyperTail, sigmoid, sum } from './prob';
import { DoubtAnalysis, doubtFeatures } from './doubtFeatures';
import { LearnedDoubt, LearnedRisk } from './learnedDoubt';
import { riskFeatures } from './riskFeatures';
import { EvalContext, handValue, isForbiddenFinish, pickRemovals, removeCounts, turnsToFinish } from './evaluate';
import {
  JOKER, RANKS, PlayerView, SeatView, buildView, copiesInDeck, countRanks, nextActiveSeat, rankOf, strengthOf,
} from './view';

export interface PlayDecision {
  type: 'play' | 'pass';
  cards?: Card[];
  declaredNumber?: number;
}

export interface EffectDecision {
  cardIds: string[];
  targetData?: { numbers?: number[] };
}

// ===== カウンティング =====

interface Counting {
  /** 自分の手札のランク別枚数 */
  my: number[];
  /** 公開されているランク別枚数 */
  faceUp: number[];
  /** 自分から見て所在不明なランク別枚数 (厳密) */
  unknown: number[];
  /** そのうち「誰の手札にあってもおかしくない」ランク別期待枚数 */
  free: number[];
  /** free なカードが入りうる場所の総数 (相手の手札 + 中身不明の捨て札) */
  population: number;
}

function buildCounting(view: PlayerView, mem: BrainMemory): Counting {
  const my = countRanks(view.hand);
  const faceUp = countRanks(view.faceUp);
  const pendingMine = mem.myPendingCounts();
  const unknown = new Array(14).fill(0);
  const free = new Array(14).fill(0);
  let population = 0;

  for (let rank = 0; rank < 14; rank++) {
    unknown[rank] = Math.max(0, copiesInDeck(rank) - my[rank] - faceUp[rank] - mem.myBuried[rank] - pendingMine[rank]);
    const buried = Math.min(unknown[rank], mem.buriedTrue[rank]);
    let heldKnown = 0;
    for (const seat of view.opponents) heldKnown += mem.knownHeld.get(seat.id)?.[rank] ?? 0;
    heldKnown = Math.min(heldKnown, unknown[rank] - buried);
    free[rank] = Math.max(0, unknown[rank] - buried - heldKnown);
    population += free[rank];
  }
  return { my, faceUp, unknown, free, population: Math.max(1, population) };
}

// ===== 嘘確率モデル =====

interface ClaimContext {
  rank: number;
  count: number;
  isCounter: boolean;
  /** この宣言で手札が無くなる (上がり) */
  finishing: boolean;
  /** 場が空の状態で出した */
  wasLead: boolean;
  /** 宣言前の手札枚数 */
  handBefore: number;
}

/** 状況別の基準嘘率 (その状況の宣言のうち嘘である割合。自己対戦で較正した値) */
function baseLieRate(params: BrainParams, view: PlayerView, claim: ClaimContext): number {
  const slot = Math.min(claim.count, 3) - 1;
  if (claim.isCounter) return params.baseCounter;
  if (claim.finishing) return params.baseFinal[slot];
  const special = claim.rank === 7 || claim.rank === 8 || claim.rank === 10 || (claim.rank === 12 && view.bombActive);
  if (claim.wasLead) return (special ? params.baseLeadSpecial : params.baseLeadPlain)[slot];
  return (special ? params.baseFollowSpecial : params.baseFollowPlain)[slot];
}

/**
 * 嘘確率。基準嘘率のオッズに、相手の傾向と「自分だけが知っている枚数情報」の尤度比を掛ける。
 *  hPrivate : 自分の情報込みで、相手がこの宣言を正直にできる確率
 *  hPublic  : 公開情報だけで見た同じ確率
 */
function lieProbability(base: number, tendency: number, hPrivate: number, hPublic: number, params: BrainParams): number {
  if (hPrivate <= 0) return 1;
  const b = clamp(base, 0.01, 0.97);
  const hp = clamp(hPrivate, 0.002, 0.998);
  const hq = clamp(hPublic, 0.002, 0.998);
  const evidence = clamp(((1 - hp) / (1 - hq)) * (hq / hp), 0.04, 40);
  const odds = (b / (1 - b)) * tendency * Math.pow(evidence, params.evidencePower);
  return clamp(odds / (1 + odds), 0.005, 0.995);
}

/**
 * 相手 claimant が「rank を count 枚」を正直に出せる確率 h。0 なら証明可能な嘘。
 */
function claimPossibility(
  view: PlayerView,
  mem: BrainMemory,
  c: Counting,
  claimantId: string,
  handBefore: number,
  rank: number,
  count: number,
  isCounter: boolean,
): number {
  if (isCounter && rank === 3) {
    // スペ3返し: スペードの3そのもの1枚でなければ嘘
    if (count !== 1) return 0;
    if (view.hand.some(isSpadeThree) || view.faceUp.some(isSpadeThree)) return 0;
    if (mem.spadeThreeAt === 'buried') return 0;
    if (mem.spadeThreeAt === claimantId) return 0.8;
    if (mem.spadeThreeAt) return 0.05;
    return clamp(handBefore / Math.max(1, sum(c.unknown)), 0, 1);
  }

  const ranks = rank === JOKER ? [JOKER] : [rank, JOKER];
  const held = mem.knownHeld.get(claimantId);
  let exactSupply = 0;
  let supply = 0;
  let known = 0;
  for (const r of ranks) {
    exactSupply += c.unknown[r];
    supply += c.free[r];
    known += held?.[r] ?? 0;
  }
  if (count > exactSupply) return 0;

  const heldTotal = held ? sum(held) : 0;
  const freeSlots = Math.max(0, handBefore - heldTotal);
  const lo = Math.floor(known);
  const hi = Math.ceil(known);
  const tail = (alreadyHeld: number) => hyperTail(c.population, supply, freeSlots, count - alreadyHeld);
  const h = lo === hi ? tail(lo) : (1 - (known - lo)) * tail(lo) + (known - lo) * tail(hi);
  return clamp(h, 0.0005, 1);
}

// ===== ダウトの損益分岐点 =====

interface ThresholdArgs {
  observerLives: number;
  observerCards: number;
  count: number;
  claimantCardsAfter: number;
  finishing: boolean;
  forbiddenFinish: boolean;
  activeCount: number;
  effectStake: number;
}

function doubtThreshold(params: BrainParams, a: ThresholdArgs): number {
  // 禁止上がりの宣言は放っておけば相手が脱落する。止める理由がない
  if (a.forbiddenFinish) return 2;
  // 1対1で上がられたら負け。外しても失うものがないので必ずダウトする
  if (a.finishing && a.activeCount <= 2) return 0.02;

  const shed = Math.min(a.count, a.observerCards);
  let gain = shed * params.shedValue + a.effectStake;
  if (shed >= a.observerCards) gain += params.finishBonus * 2; // 全部押し付ければ自分が上がれる
  if (a.finishing) gain += params.finishThreat;
  gain = Math.max(0.2, gain);

  const lifeCost = a.observerLives >= 3 ? params.lifeCost3 : a.observerLives === 2 ? params.lifeCost2 : params.eliminationCost;
  const loss = lifeCost + Math.min(a.count, a.claimantCardsAfter) * params.receivePenalty;
  return loss / (gain + loss);
}

/** その宣言の効果を止めることの価値 (観察者 observerId から見て) */
function effectStake(
  params: BrainParams,
  view: PlayerView,
  rank: number,
  count: number,
  claimantId: string,
  observerId: string,
  observerCounts: number[] | null,
): number {
  switch (rank) {
    case 8:
      return params.leadValue + 0.3;
    case 7: {
      const next = nextActiveSeat(view, claimantId);
      return next?.id === observerId ? count * 1.0 : count * 0.3;
    }
    case 10:
      return count * 0.35;
    case 12: {
      if (!view.bombActive) return 0.15;
      if (observerCounts) {
        let hits = 0;
        for (const n of view.pendingNumbers ?? []) hits += observerCounts[n] ?? 0;
        return 0.3 * count - 0.8 * hits; // 自分の札が消えるなら、むしろ通したほうが得
      }
      return 0.3 * count;
    }
    case 5:
      return 0.25;
    default:
      return 0.15;
  }
}

// ===== 自分の宣言がダウトされる確率 =====

interface MyClaim extends ClaimContext {
  forbiddenFinish: boolean;
  /** 自分が本当にスペードの3を出しているか (スペ3返しのとき) */
  holdsSpadeThree?: boolean;
}

/**
 * 相手も同じモデルで考えると仮定して、自分の宣言が誰かにダウトされる確率 q を求める。
 * 相手が宣言ランクを何枚握っているか (j) は分からないので、その分布で平均する。
 */
function doubtRisk(params: BrainParams, view: PlayerView, mem: BrainMemory, c: Counting, claim: MyClaim): number {
  if (view.opponents.length === 0 || claim.forbiddenFinish) return 0;

  const ranks = claim.rank === JOKER ? [JOKER] : [claim.rank, JOKER];
  const remaining = publicRemaining(c.faceUp, mem.publicClaimed);
  const publicUnknownTotal = sum(remaining);
  let publicSupply = 0;
  let supplyAmongOpponents = 0;
  for (const r of ranks) {
    publicSupply += remaining[r];
    supplyAmongOpponents += c.free[r];
  }

  const base = baseLieRate(params, view, claim);
  const tendency = mem.lieTendency(view.myId);
  const cardsAfter = claim.handBefore - claim.count;
  const spadeCounter = claim.isCounter && claim.rank === 3;
  const hPublic = publicPossibility(remaining, claim.rank, claim.count, claim.handBefore, spadeCounter);

  let nobodyDoubts = 1;
  for (const seat of view.opponents) {
    const tau = doubtThreshold(params, {
      observerLives: seat.lives,
      observerCards: seat.cardCount,
      count: claim.count,
      claimantCardsAfter: cardsAfter,
      finishing: claim.finishing,
      forbiddenFinish: claim.forbiddenFinish,
      activeCount: view.activeCount,
      effectStake: effectStake(params, view, claim.rank, claim.count, view.myId, seat.id, null),
    });
    const populationSeat = Math.max(claim.handBefore, publicUnknownTotal - seat.cardCount);

    let q = 0;
    if (spadeCounter) {
      const seatHolds = claim.holdsSpadeThree ? 0 : clamp(seat.cardCount / c.population, 0, 1);
      const h = clamp(claim.handBefore / populationSeat, 0.01, 1);
      const pLie = lieProbability(base, tendency, h, hPublic, params);
      q = seatHolds + (1 - seatHolds) * sigmoid((pLie - tau) / params.doubtSoftness);
    } else {
      const maxHeld = Math.min(seat.cardCount, 6);
      for (let j = 0; j <= maxHeld; j++) {
        const pj = hyperPmf(c.population, supplyAmongOpponents, seat.cardCount, j);
        if (pj < 1e-4) continue;
        const h = hyperTail(populationSeat, Math.max(0, publicSupply - j), claim.handBefore, claim.count);
        const pLie = lieProbability(base, tendency, h, hPublic, params);
        q += pj * sigmoid((pLie - tau) / params.doubtSoftness);
      }
    }
    nobodyDoubts *= 1 - clamp(q, 0, 0.98);
  }
  // この卓の実際のダウト頻度に合わせて補正する:
  //  モデルの見積もりを卓の傾向で伸縮させ、さらに「この卓でその手の宣言がダウトされた割合」と半々で混ぜる
  const bucket = plausibilityBucket(hPublic);
  const factor = mem.doubtFactor(bucket, params.baselineDoubt[bucket]);
  const modelled = 1 - Math.pow(nobodyDoubts, factor);
  const observed = mem.doubtRate(bucket, params.baselineDoubt[bucket]);
  return clamp(0.5 * modelled + 0.5 * observed, 0, 0.99);
}

/**
 * 自分の宣言が誰かにダウトされる確率 q。
 * 学習済みのダウト予測モデル (models/risk-model.json) があればそれを使い、無ければ手作りの見積もり。
 */
function claimRisk(
  params: BrainParams,
  view: PlayerView,
  mem: BrainMemory,
  c: Counting,
  claim: MyClaim,
  honest: boolean,
  withFeatures = false,
): { q: number; heuristic: number; features: Float32Array | null } {
  const heuristic = doubtRisk(params, view, mem, c, claim);
  if (claim.forbiddenFinish || view.opponents.length === 0) return { q: 0, heuristic, features: null };
  const model = params.useLearnedRisk ? (params.riskModel ?? LearnedRisk.current()) : null;
  if (!model && !withFeatures) return { q: heuristic, heuristic, features: null };
  const remaining = publicRemaining(c.faceUp, mem.publicClaimed);
  const features = riskFeatures({
    view,
    mem,
    my: c.my,
    faceUp: c.faceUp,
    claim: {
      rank: claim.rank,
      count: claim.count,
      isCounter: claim.isCounter,
      wasLead: claim.wasLead,
      finishing: claim.finishing,
      forbiddenFinish: claim.forbiddenFinish,
      handBefore: claim.handBefore,
      honest,
      publicPossibility: publicPossibility(remaining, claim.rank, claim.count, claim.handBefore, claim.isCounter && claim.rank === 3),
      heuristicRisk: heuristic,
    },
  });
  return { q: model ? model.predict(features) : heuristic, heuristic, features };
}

// ===== Qボンバーの指定 =====

function chooseBomb(
  params: BrainParams,
  view: PlayerView,
  c: Counting,
  counts: number[],
  limit: number,
  ctx: EvalContext,
): { ranks: number[]; value: number } {
  const current = [...counts];
  const chosen: number[] = [];
  let value = handValue(current, ctx, params);
  const oppWeight = params.opponentGainWeight / Math.max(1, view.opponents.length);
  const opponentCards = sum(view.opponents.map(o => o.cardCount));
  const inHandsShare = clamp(opponentCards / c.population, 0, 1);
  let penalty = 0;

  for (let step = 0; step < limit; step++) {
    let bestRank = -1;
    let bestGain = 0;
    let bestValue = value;
    let bestPenalty = 0;
    for (let rank = 0; rank < 14; rank++) {
      if (chosen.includes(rank) || current[rank] === 0) continue;
      if (rank === JOKER) continue; // 自分のジョーカーは壊さない
      const saved = current[rank];
      current[rank] = 0;
      const nextValue = handValue(current, ctx, params);
      current[rank] = saved;

      // 相手の手札からも同じランクが消える = 相手も身軽になる
      const opponentCopies = c.free[rank] * inHandsShare;
      let cost = opponentCopies * params.bombOpponentBenefit * oppWeight;
      for (const seat of view.opponents) {
        // 残り1〜2枚の相手は、そのランクしか持っていなければ上がってしまう
        if (seat.cardCount <= 2) {
          const share = clamp(c.free[rank] / c.population, 0, 1);
          cost += Math.pow(share, seat.cardCount) * params.finishThreat;
        }
      }
      const gain = nextValue - value - cost;
      if (gain > bestGain) {
        bestGain = gain;
        bestRank = rank;
        bestValue = nextValue;
        bestPenalty = cost;
      }
    }
    if (bestRank === -1) break;
    current[bestRank] = 0;
    chosen.push(bestRank);
    value = bestValue;
    penalty += bestPenalty;
  }
  return { ranks: chosen, value: value - penalty };
}

// ===== 本体 =====

interface Candidate {
  cards: Card[];
  rank: number;
  honest: boolean;
  ev: number;
  q: number;
}

/** ダウト判断の内訳 (自己対戦での較正・デバッグ用) */
export interface DoubtProbe {
  playerId: string;
  rank: number;
  count: number;
  isCounter: boolean;
  finishing: boolean;
  wasLead: boolean;
  /** 効果札 (7 / 8 / 10 / 有効なQ) の宣言か */
  special: boolean;
  /** 相手が正直に出せる確率 */
  possibility: number;
  /** 公開情報だけで見た同じ確率 */
  publicPossibility: number;
  /** 推定した嘘確率 */
  lieProbability: number;
  /** ダウトの損益分岐点 */
  threshold: number;
  decided: boolean;
  /** 学習済みモデルで見積もったか */
  learned: boolean;
}

export class Brain {
  private static memories = new Map<string, BrainMemory>();

  /** 設定すると、ダウト判断のたびに内訳が渡される (シミュレータの較正用) */
  static probe: ((info: DoubtProbe) => void) | null = null;

  /** 新しいゲームの開始時に、その部屋の CPU の記憶を消す */
  static resetRoom(roomId: string): void {
    for (const key of [...Brain.memories.keys()]) {
      if (key.startsWith(`${roomId}:`)) Brain.memories.delete(key);
    }
  }

  private static memoryFor(view: PlayerView): BrainMemory {
    const key = `${view.roomId}:${view.myId}`;
    let memory = Brain.memories.get(key);
    if (!memory) {
      memory = new BrainMemory();
      Brain.memories.set(key, memory);
    }
    return memory;
  }

  // ---------------------------------------------------------------- 手番

  static decidePlay(room: Room, player: Player, params: BrainParams = DEFAULT_PARAMS): PlayDecision {
    const view = buildView(room, player.id);
    const mem = Brain.memoryFor(view);
    mem.sync(view);
    const hand = view.hand;
    if (hand.length === 0) return { type: 'pass' };

    const c = buildCounting(view, mem);
    const isLead = view.fieldCount === 0;
    const canPass = view.fieldOwnerId !== null;
    const need = view.fieldCount;
    const fieldStrength = isLead ? -1 : strengthOf(view.fieldRank, view.reversed);
    const legal = (rank: number): boolean => {
      if (isLead) return true;
      if (view.fieldRank === JOKER) return false;
      return strengthOf(rank, view.reversed) > fieldStrength;
    };

    const ctxNow: EvalContext = { isRevolution: view.isRevolution, bombActive: view.bombActive };
    const baseValue = handValue(c.my, ctxNow, params);
    const oppWeight = params.opponentGainWeight / Math.max(1, view.opponents.length);
    const averageOpponentHand = view.opponents.length > 0
      ? sum(view.opponents.map(o => o.cardCount)) / view.opponents.length
      : 1;

    const byRank = new Map<number, Card[]>();
    for (const card of hand) {
      const rank = rankOf(card);
      if (!byRank.has(rank)) byRank.set(rank, []);
      byRank.get(rank)!.push(card);
    }
    // 同ランクを割るときはスペードの3を最後まで残す
    for (const group of byRank.values()) group.sort((a, b) => Number(isSpadeThree(a)) - Number(isSpadeThree(b)));
    const jokers = byRank.get(JOKER) ?? [];

    /** 効果が自分の思い通りに解決したあとの手札評価 */
    const settle = (rest: Card[], rank: number, count: number, ctx: EvalContext): number => {
      if (rest.length === 0) return params.finishBonus;
      const counts = countRanks(rest);
      switch (rank) {
        case 7:
        case 10: {
          const removed = pickRemovals(rest, count, ctx, params);
          const bonus = rank === 7 ? removed.length * oppWeight * 0.5 : 0;
          return handValue(removeCounts(counts, removed), ctx, params) + bonus;
        }
        case 12:
          return view.bombActive
            ? chooseBomb(params, view, c, counts, count, ctx).value
            : handValue(counts, ctx, params);
        case 8:
          return handValue(counts, ctx, params) + params.leadValue;
        case 5:
          return handValue(counts, ctx, params) + (view.opponents.length <= count ? params.leadValue : 0.1 * count);
        default:
          return handValue(counts, ctx, params);
      }
    };

    /** その宣言で場を取り切れる (全員パスで親が戻る) 見込み */
    const trickBonus = (rank: number, count: number, revolutionAfter: boolean): number => {
      if (rank === 8) return 0; // 8切りは settle 側で評価済み
      if (rank === 5 && view.opponents.length <= count) return 0;
      let chance: number;
      if (rank === JOKER) {
        chance = 0.9;
      } else {
        const reversedAfter = revolutionAfter !== (view.isElevenBack || rank === 11);
        const s = strengthOf(rank, reversedAfter) / 12;
        chance = Math.pow(s, 3) * 0.75 + (count >= 3 ? 0.35 : count === 2 ? 0.12 : 0);
        if (view.opponents.length <= 1) chance += 0.1;
      }
      return Math.min(0.92, chance) * params.leadValue;
    };

    const candidates: Candidate[] = [];
    const seenKeys = new Set<string>();
    const evaluate = (cards: Card[], rank: number, honest: boolean): void => {
      if (cards.length === 0 || cards.length > 6) return;
      const key = `${rank}|${cards.map(card => card.id).sort().join(',')}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      const count = cards.length;
      const ids = new Set(cards.map(card => card.id));
      const rest = hand.filter(card => !ids.has(card.id));
      const revolutionAfter = count >= 4 ? !view.isRevolution : view.isRevolution;
      const ctxAfter: EvalContext = { isRevolution: revolutionAfter, bombActive: view.bombActive };
      const finishing = rest.length === 0;
      const forbidden = finishing && isForbiddenFinish(rank, revolutionAfter);

      const q = claimRisk(params, view, mem, c, {
        rank, count, isCounter: false, finishing, wasLead: isLead, handBefore: hand.length, forbiddenFinish: forbidden,
      }, honest).q;

      let accepted: number;
      if (forbidden) accepted = -params.forbiddenPenalty;
      else if (finishing) accepted = params.finishBonus;
      else accepted = settle(rest, rank, count, ctxAfter) + trickBonus(rank, count, revolutionAfter);

      let doubted: number;
      if (honest) {
        if (forbidden) {
          doubted = -params.forbiddenPenalty;
        } else if (finishing) {
          doubted = params.finishBonus + params.honestDoubtBonus;
        } else {
          // ダウトした相手に最大 count 枚押し付けてから、効果を解決する
          const gift = pickRemovals(rest, count, ctxAfter, params);
          const giftIds = new Set(gift.map(card => card.id));
          const rest2 = rest.filter(card => !giftIds.has(card.id));
          doubted = settle(rest2, rank, count, ctxAfter) + trickBonus(rank, count, revolutionAfter) + params.honestDoubtBonus;
        }
      } else {
        // 嘘がばれる: 出した札は墓地へ、効果は不発、相手から最大 count 枚押し付けられる
        const received = Math.min(count, Math.max(1, averageOpponentHand));
        const afterCounts = removeCounts(c.my, cards);
        const kept = finishing ? -0.2 * received : handValue(afterCounts, ctxNow, params);
        doubted = kept - received * params.receivedCardCost - count * oppWeight - params.caughtTempo;
      }

      candidates.push({ cards, rank, honest, q, ev: (1 - q) * accepted + q * doubted });
    };

    // --- 正直な手 ---
    for (const rank of RANKS) {
      const group = byRank.get(rank);
      if (!group || !legal(rank)) continue;
      if (isLead) {
        evaluate(group.slice(0, 6), rank, true);
        if (rank === 8 && group.length > 1) evaluate([group[0]], rank, true);
        if (jokers.length > 0 && group.length + jokers.length === hand.length) {
          evaluate([...group, ...jokers], rank, true);
        }
      } else if (group.length >= need) {
        evaluate(group.slice(0, need), rank, true);
      } else if (group.length + jokers.length >= need) {
        evaluate([...group, ...jokers.slice(0, need - group.length)], rank, true);
      }
    }
    if (jokers.length > 0) {
      const jokerCount = isLead ? jokers.length : need;
      if (jokerCount <= jokers.length) {
        const jokerCards = jokers.slice(0, jokerCount);
        const finishing = jokerCount === hand.length;
        if (finishing) {
          // ジョーカーは何にでもなれる: 禁止上がりにならないランクとして宣言すれば正直な上がり
          const safe = RANKS.filter(rank => legal(rank) && !isForbiddenFinish(rank, view.isRevolution));
          if (safe.length > 0) evaluate(jokerCards, safe[Math.floor(Math.random() * safe.length)], true);
        }
        if (!isLead && legal(JOKER) && jokerCount <= 2) evaluate(jokerCards, JOKER, true);
        if (isLead && finishing && candidates.length === 0) evaluate(jokerCards, JOKER, true);
      }
    }

    // --- 嘘の手 ---
    const bluffCounts: number[] = [];
    if (isLead) {
      for (const count of [1, 2, 3]) if (count <= hand.length) bluffCounts.push(count);
      if (hand.length >= 4 && hand.length <= 6) bluffCounts.push(hand.length);
    } else if (hand.length >= need) {
      bluffCounts.push(need);
    }
    for (const count of bluffCounts) {
      const junk = count === hand.length
        ? [...hand]
        : pickRemovals(hand, count, ctxNow, params, { exact: true, keepJokers: true });
      if (junk.length !== count) continue;
      const junkCounts = countRanks(junk);
      for (const rank of [...RANKS, JOKER]) {
        if (!legal(rank)) continue;
        const publicMax = rank === JOKER
          ? 2 - c.faceUp[JOKER]
          : (4 - c.faceUp[rank]) + (2 - c.faceUp[JOKER]);
        if (count > publicMax) continue; // 誰が見ても嘘と分かる宣言はしない
        const truthful = rank === JOKER ? junkCounts[JOKER] : junkCounts[rank] + junkCounts[JOKER];
        if (truthful === count) continue; // 実は正直な手 (上で評価済み)
        evaluate(junk, rank, false);
      }
    }

    const passEv = canPass ? baseValue - params.passCost : -Infinity;

    if (candidates.length === 0) {
      if (canPass) return { type: 'pass' };
      // 親番で手が見つからないことは無いはずだが、保険として1枚出す
      const card = hand[0];
      mem.noteMyPlay([card]);
      return { type: 'play', cards: [card], declaredNumber: rankOf(card) };
    }

    // 嘘の手は、正直な最善手 (またはパス) を十分に上回るときだけ候補に残す
    let bestHonest = passEv;
    for (const cand of candidates) if (cand.honest && cand.ev > bestHonest) bestHonest = cand.ev;
    const margin = params.bluffMargin / mem.boldness;
    let pool = candidates.filter(cand => cand.honest || cand.ev > bestHonest + margin);
    if (pool.length === 0) {
      if (canPass) return { type: 'pass' };
      pool = candidates; // 親番なので何かは出さなければならない
    }

    let best = pool[0];
    for (const cand of pool) if (cand.ev > best.ev) best = cand;
    if (passEv > best.ev) return { type: 'pass' };

    // 最善手に近い手の中から確率的に選ぶ (読まれにくくするため)
    const temperature = Math.max(0.01, params.temperature);
    const near = pool.filter(cand => cand.ev >= best.ev - 3 * temperature);
    const weights = near.map(cand => Math.exp((cand.ev - best.ev) / temperature));
    let roll = Math.random() * sum(weights);
    let chosen = near[near.length - 1];
    for (let i = 0; i < near.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        chosen = near[i];
        break;
      }
    }

    mem.noteMyPlay(chosen.cards);
    return { type: 'play', cards: chosen.cards, declaredNumber: chosen.rank };
  }

  // ---------------------------------------------------------------- ダウト

  /**
   * ダウト判断の材料をそろえる (判断そのものはしない)。
   * 学習データの生成 (sim/gen-doubt-data.ts) からも、同じ特徴量を作るために呼ばれる。
   * 自分の宣言を見ている / 場が空 などでダウトできないときは null。
   */
  static analyzeDoubt(
    room: Room,
    player: Player,
    params: BrainParams = DEFAULT_PARAMS,
  ): { analysis: DoubtAnalysis; features: Float32Array; mem: BrainMemory } | null {
    const view = buildView(room, player.id);
    if (!view.fieldOwnerId || view.fieldOwnerId === view.myId || view.fieldCount === 0) return null;
    const claimant = view.seats.find(seat => seat.id === view.fieldOwnerId);
    if (!claimant) return null;

    const mem = Brain.memoryFor(view);
    mem.sync(view);
    const c = buildCounting(view, mem);

    const rank = view.fieldRank;
    const count = view.fieldCount;
    const isCounter = view.doubtType === 'counter';
    const handBefore = claimant.cardCount + count;
    const finishingNow = claimant.cardCount === 0;
    const finishingByEffect = !isCounter && (rank === 7 || rank === 10) && claimant.cardCount > 0 && claimant.cardCount <= count;
    const forbiddenFinish = finishingNow && !isCounter && isForbiddenFinish(rank, view.isRevolution);

    const wasLead = !isCounter && view.previousFieldCount === 0;
    const h = claimPossibility(view, mem, c, claimant.id, handBefore, rank, count, isCounter);
    const remaining = publicRemaining(c.faceUp, mem.publicClaimed);
    const hPublic = publicPossibility(remaining, rank, count, handBefore, isCounter && rank === 3);
    const bucket = plausibilityBucket(hPublic);
    const base = baseLieRate(params, view, { rank, count, isCounter, finishing: finishingNow, wasLead, handBefore });
    const tendency = mem.lieTendency(claimant.id) * mem.lieFactor(bucket, params.expectedHit[bucket]) * mem.suspicion;
    const heuristicLie = lieProbability(base, tendency, h, hPublic, params);

    const threshold = forbiddenFinish ? 2 : doubtThreshold(params, {
      observerLives: view.lives,
      observerCards: view.hand.length,
      count,
      claimantCardsAfter: claimant.cardCount,
      finishing: finishingNow || finishingByEffect,
      forbiddenFinish,
      activeCount: view.activeCount,
      effectStake: effectStake(params, view, rank, count, claimant.id, view.myId, c.my),
    });

    const analysis: DoubtAnalysis = {
      rank, count, isCounter, wasLead,
      finishing: finishingNow, finishingByEffect, forbiddenFinish, handBefore,
      possibility: h, publicPossibility: hPublic, heuristicLie, threshold,
    };
    const features = doubtFeatures({ view, mem, claimant, my: c.my, faceUp: c.faceUp, unknown: c.unknown, analysis });
    return { analysis, features, mem };
  }

  static shouldDoubt(room: Room, player: Player, params: BrainParams = DEFAULT_PARAMS): boolean {
    const result = Brain.analyzeDoubt(room, player, params);
    if (!result) return false;
    const { analysis: a, features, mem } = result;

    // 学習済みモデルがあればそれで嘘確率を見積もる (無ければ手作りの見積もり)
    const model = params.useLearnedDoubt ? (params.doubtModel ?? LearnedDoubt.current()) : null;
    const pLie = a.possibility <= 0 ? 1 : model ? model.predict(features) : a.heuristicLie;
    mem.notePendingEstimate(pLie);

    const report = (decided: boolean): boolean => {
      Brain.probe?.({
        playerId: player.id, rank: a.rank, count: a.count, isCounter: a.isCounter, finishing: a.finishing, wasLead: a.wasLead,
        special: a.rank === 7 || a.rank === 8 || a.rank === 10 || (a.rank === 12 && room.field.hasFieldCleared),
        possibility: a.possibility, publicPossibility: a.publicPossibility, lieProbability: pLie,
        threshold: a.threshold, decided, learned: !!model,
      });
      return decided;
    };

    if (a.forbiddenFinish) return report(false);
    if (a.possibility <= 0) return report(true); // 枚数が合わない: 証明可能な嘘
    return report(Math.random() < sigmoid((pLie - a.threshold) / params.doubtSoftness));
  }

  /**
   * 学習データ用: これから出す宣言について、ダウト予測モデルの特徴量と手作りの見積もりを返す。
   * プレイ (またはカウンター) を盤面に反映する前に呼ぶこと。
   */
  static riskSample(
    room: Room,
    player: Player,
    cards: Card[],
    declared: number,
    isCounter: boolean,
    params: BrainParams = DEFAULT_PARAMS,
  ): { features: Float32Array; heuristic: number; honest: boolean } | null {
    const view = buildView(room, player.id);
    if (view.opponents.length === 0 || cards.length === 0) return null;
    const mem = Brain.memoryFor(view);
    mem.sync(view);
    const c = buildCounting(view, mem);
    const finishing = cards.length === view.hand.length;
    const revolutionAfter = !isCounter && cards.length >= 4 ? !view.isRevolution : view.isRevolution;
    const forbiddenFinish = finishing && !isCounter && isForbiddenFinish(declared, revolutionAfter);
    const honest = isCounter && declared === 3
      ? cards.length === 1 && isSpadeThree(cards[0])
      : declared === JOKER
        ? cards.every(card => card.isJoker)
        : cards.every(card => card.isJoker || card.number === declared);
    const claim: MyClaim = {
      rank: declared,
      count: cards.length,
      isCounter,
      finishing,
      wasLead: !isCounter && view.fieldCount === 0,
      handBefore: view.hand.length,
      forbiddenFinish,
      holdsSpadeThree: isCounter && declared === 3 ? honest : undefined,
    };
    const risk = claimRisk({ ...params, useLearnedRisk: false }, view, mem, c, claim, honest, true);
    if (!risk.features) return null; // 禁止上がりなど、誰もダウトしない宣言は学習に使わない
    return { features: risk.features, heuristic: risk.heuristic, honest };
  }

  /** シミュレータ用: そのプレイヤーが実際に出したカードを記憶させる (Brain 以外の席でも数え上げを正しくする) */
  static observeOwnPlay(room: Room, playerId: string, cards: Card[]): void {
    const view = buildView(room, playerId);
    Brain.memoryFor(view).noteMyPlay(cards);
  }

  // ---------------------------------------------------------------- カウンター

  static chooseCounter(room: Room, player: Player, params: BrainParams = DEFAULT_PARAMS): Card[] {
    const view = buildView(room, player.id);
    const mem = Brain.memoryFor(view);
    mem.sync(view);
    const hand = view.hand;
    const againstEight = view.fieldRank === 8;
    const againstJoker = view.fieldRank === JOKER && view.fieldCount === 1;
    if (!againstEight && !againstJoker) return [];

    const need = againstEight ? view.fieldCount + 1 : 1;
    if (hand.length < need) return [];

    const c = buildCounting(view, mem);
    const ctx: EvalContext = { isRevolution: view.isRevolution, bombActive: view.bombActive };
    const baseValue = handValue(c.my, ctx, params);
    const oppWeight = params.opponentGainWeight / Math.max(1, view.opponents.length);

    const valueAfter = (cards: Card[]): number => {
      const ids = new Set(cards.map(card => card.id));
      const rest = hand.filter(card => !ids.has(card.id));
      if (rest.length === 0) return params.finishBonus;
      return handValue(countRanks(rest), ctx, params) + params.leadValue;
    };

    // --- 正直なカウンター ---
    let honest: Card[] | null = null;
    if (againstEight) {
      const fours = hand.filter(card => !card.isJoker && card.number === 4);
      const jokers = hand.filter(card => card.isJoker);
      if (fours.length >= need) honest = fours.slice(0, need);
      else if (fours.length > 0 && fours.length + jokers.length >= need) {
        honest = [...fours, ...jokers.slice(0, need - fours.length)];
      }
    } else {
      const spadeThree = hand.find(isSpadeThree);
      if (spadeThree) honest = [spadeThree];
    }
    if (honest) {
      // 正直なカウンターはダウトされても得しかしない。親を取れる価値と手札の進みで判断する
      if (valueAfter(honest) > baseValue - 0.05) {
        mem.noteMyPlay(honest);
        return honest;
      }
      return [];
    }

    // --- 嘘のカウンター ---
    const junk = pickRemovals(hand, need, ctx, params, { exact: true, keepJokers: true });
    if (junk.length !== need) return [];
    const finishing = need === hand.length;
    const q = claimRisk(params, view, mem, c, {
      rank: againstEight ? 4 : 3,
      count: need,
      isCounter: true,
      finishing,
      wasLead: false,
      handBefore: hand.length,
      forbiddenFinish: false,
      holdsSpadeThree: false,
    }, false).q;
    const averageOpponentHand = sum(view.opponents.map(o => o.cardCount)) / Math.max(1, view.opponents.length);
    const received = Math.min(need, Math.max(1, averageOpponentHand));
    const afterCounts = removeCounts(c.my, junk);
    const kept = finishing ? -0.2 * received : handValue(afterCounts, ctx, params);
    const caught = kept - received * params.receivedCardCost - need * oppWeight - params.caughtTempo;
    const ev = (1 - q) * valueAfter(junk) + q * caught;
    if (ev > baseValue + 0.35 / mem.boldness) {
      mem.noteMyPlay(junk);
      return junk;
    }
    return [];
  }

  // ---------------------------------------------------------------- 効果

  static chooseEffect(room: Room, player: Player, effect: PendingEffect, params: BrainParams = DEFAULT_PARAMS): EffectDecision {
    const view = buildView(room, player.id);
    const mem = Brain.memoryFor(view);
    mem.sync(view);
    const hand = view.hand;
    const ctx: EvalContext = { isRevolution: view.isRevolution, bombActive: view.bombActive };
    const count = Math.max(0, effect.count);

    switch (effect.type) {
      case 'sevenPass': {
        const cards = pickRemovals(hand, count, ctx, params);
        const target = nextActiveSeat(view, view.myId);
        if (target) mem.noteGiven(target.id, cards);
        return { cardIds: cards.map(card => card.id) };
      }

      case 'tenDiscard': {
        const cards = pickRemovals(hand, count, ctx, params);
        mem.noteDiscarded(cards);
        return { cardIds: cards.map(card => card.id) };
      }

      case 'doubtCardSelect': {
        const excluded = ((effect as any).excludedNumbers as number[] | undefined) ?? [];
        let cards = pickRemovals(hand, count, ctx, params, { excludedRanks: excluded });
        const target = view.seats.find(seat => seat.id === effect.targetPlayerId);
        // 相手の手札が 0 枚のまま終わると相手が上がってしまう。必ず1枚は渡す
        if (cards.length === 0 && target && !target.isOut && target.cardCount === 0 && hand.length > 0) {
          cards = pickRemovals(hand, 1, ctx, params, { exact: true, excludedRanks: excluded });
        }
        if (target) mem.noteGiven(target.id, cards);
        return { cardIds: cards.map(card => card.id) };
      }

      case 'sixCollect': {
        const counts = countRanks(hand);
        let value = handValue(counts, ctx, params);
        const pool = [...view.faceUpPool];
        const taken: Card[] = [];
        for (let step = 0; step < Math.min(count, pool.length); step++) {
          let bestIndex = -1;
          let bestValue = value + params.collectMargin;
          for (let i = 0; i < pool.length; i++) {
            const rank = rankOf(pool[i]);
            counts[rank]++;
            const next = handValue(counts, ctx, params);
            counts[rank]--;
            if (next > bestValue) {
              bestValue = next;
              bestIndex = i;
            }
          }
          if (bestIndex === -1) break;
          const [card] = pool.splice(bestIndex, 1);
          counts[rankOf(card)]++;
          value = bestValue;
          taken.push(card);
        }
        return { cardIds: taken.map(card => card.id) };
      }

      case 'queenBomber': {
        const c = buildCounting(view, mem);
        const bomb = chooseBomb(params, view, c, c.my, count, ctx);
        return { cardIds: [], targetData: { numbers: bomb.ranks } };
      }

      default:
        return { cardIds: [] };
    }
  }

  // ---------------------------------------------------------------- 観戦用の形勢表示

  /**
   * 観戦者向けの形勢 (次に上がれそうな度合い) を % で返す。
   * 全員の手札を見て計算するので、対局中のプレイヤーには配らないこと。
   */
  static estimateWinRates(room: Room): Record<string, number> {
    const active = room.players.filter(p => !p.isOut && p.lives > 0);
    if (active.length === 0) return {};
    const ctx: EvalContext = { isRevolution: room.rules.isRevolution, bombActive: room.field.hasFieldCleared };
    const currentId = room.turnOrder[room.currentPlayerIndex];
    const scores = active.map(p => {
      const turns = turnsToFinish(countRanks(p.hand), ctx);
      return -turns - 0.08 * p.hand.length + 0.15 * (p.lives - 1) + (p.id === currentId ? 0.3 : 0);
    });
    const top = Math.max(...scores);
    const weights = scores.map(score => Math.exp((score - top) / 1.1));
    const total = sum(weights);
    const rates: Record<string, number> = {};
    active.forEach((p, i) => {
      rates[p.id] = clamp(Math.round((weights[i] / total) * 100), 1, 99);
    });
    return rates;
  }
}
