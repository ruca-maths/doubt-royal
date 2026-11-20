/**
 * ヘッドレス対局ドライバ
 *
 * socket / タイマーを使わずに GameEngine を直接回し、1ゲームを最後まで同期的に進める。
 * 進行手順は src/socket/handlers.ts と同じ (プレイ → ダウト受付 → カウンター → 効果処理)。
 * AI の自己対戦評価と、ルール実装の整合性チェック (カード枚数保存・進行不能検出) に使う。
 */
import { Room, Player, Card, PendingEffect } from '../src/game/types';
import { GameEngine } from '../src/game/engine';
import { DoubtManager } from '../src/game/doubt';
import { Brain } from '../src/game/brain/brain';

export interface PlayDecision {
  type: 'play' | 'pass';
  cards?: Card[];
  declaredNumber?: number;
}

export interface EffectDecision {
  cardIds: string[];
  targetData?: { numbers?: number[] };
}

/** 対局に参加する思考ルーチンの共通インターフェース */
export interface Policy {
  name: string;
  decidePlay(room: Room, player: Player): PlayDecision;
  shouldDoubt(room: Room, player: Player): boolean;
  chooseCounter(room: Room, player: Player): Card[];
  chooseEffect(room: Room, player: Player, effect: PendingEffect): EffectDecision;
}

export interface GameStats {
  plays: number;
  lies: number;
  passes: number;
  doubts: number;
  doubtSuccess: number;
  doubtFailure: number;
  counters: number;
}

export interface SeatResult {
  policy: string;
  /** 1 = 1位。脱落 (ライフ0 / 禁止上がり) は null */
  rank: number | null;
  eliminated: 'lives' | 'forbidden' | null;
  /** 0〜1 の順位点 (1位=1, 最下位=0, 脱落=0) */
  score: number;
  livesLeft: number;
  lies: number;
  liesCaught: number;
  doubts: number;
  doubtsCorrect: number;
}

export interface GameResult {
  seats: SeatResult[];
  steps: number;
  stats: GameStats;
  stuck: string | null;
  /** 致命的ではない不整合 (場のゾーン間でのカード重複など) の件数 */
  softIssues: Map<string, number>;
}

export interface RunOptions {
  /** 各ステップでカード54枚の保存則を検査する (遅い) */
  checkInvariants?: boolean;
  maxSteps?: number;
  /**
   * ダウト受付のたびに、ダウトできる各プレイヤーについて (そのプレイヤーが判断する直前に) 呼ばれる。
   * wasLie は場に出ているカードが実際に嘘かどうか (学習データのラベル)。
   */
  onDoubtWindow?: (room: Room, observer: Player, claimant: Player, wasLie: boolean, seatPolicy: string, claimantPolicy: string) => void;
  /** 宣言 (プレイ / カウンター) が盤面に反映される直前に呼ばれる */
  onClaim?: (room: Room, actor: Player, cards: Card[], declared: number, isCounter: boolean, actorPolicy: string) => void;
  /** ダウト受付が締め切られたとき (誰かがダウトしたか / 嘘だったか) */
  onDoubtResolved?: (room: Room, doubted: boolean, wasLie: boolean) => void;
}

export function createSimRoom(playerCount: number): Room {
  const players: Player[] = Array.from({ length: playerCount }, (_, i) => ({
    id: `sim_${i}`,
    name: `P${i + 1}`,
    hand: [],
    lives: 3,
    rank: null,
    isSkipped: false,
    isOut: false,
    persistentId: `sim_persistent_${i}`,
    rankStats: {},
    isAI: true,
  }));

  return {
    id: 'SIM',
    hostId: players[0].id,
    players,
    phase: 'waiting',
    field: {
      currentCards: [],
      declaredNumber: 0,
      cardHistory: [],
      faceUpPool: [],
      roundPile: [],
      lastPlayerId: null,
      doubtType: null,
      counteredBy: null,
      hasFieldCleared: false,
    },
    rules: { direction: 1, isRevolution: false, isElevenBack: false, doubtTime: 5 },
    currentPlayerIndex: 0,
    turnOrder: [],
    finishOrder: [],
    doubtDeclarers: [],
    doubtSkippers: [],
    pendingEffect: null,
    deferredEffect: null,
    doubtTimerId: null,
    logs: [],
    pendingFinishPlayerId: null,
    counterActorIndex: null,
    passCount: 0,
    winRates: {},
  };
}

/**
 * カード54枚の保存則を検査する。
 *  - 手札同士 / 手札と場の重複、カードの消失は致命的エラーとして返す
 *  - 場のゾーン間の重複 (表示上の枚数がずれるだけ) は softIssues に数える
 * ダウト受付中は「ひとつ前の場札」が rollbackState にだけ存在するので、それも数える。
 */
function checkCardConservation(room: Room, softIssues: Map<string, number>): string | null {
  const seen = new Map<string, string>();
  for (const p of room.players) {
    for (const card of p.hand) {
      const prev = seen.get(card.id);
      if (prev) return `card ${card.id} duplicated in ${prev} and hand:${p.name}`;
      seen.set(card.id, `hand:${p.name}`);
    }
  }
  const zones: Array<[Card[], string]> = [
    [room.field.currentCards, 'currentCards'],
    [room.field.roundPile, 'roundPile'],
    [room.field.cardHistory, 'cardHistory'],
    [room.field.faceUpPool, 'faceUpPool'],
  ];
  for (const [cards, where] of zones) {
    for (const card of cards) {
      const prev = seen.get(card.id);
      if (prev && prev.startsWith('hand:')) return `card ${card.id} is in ${prev} and also in ${where}`;
      if (prev) {
        const key = prev === where ? `duplicate inside ${where}` : `duplicate across ${prev} / ${where}`;
        softIssues.set(key, (softIssues.get(key) || 0) + 1);
        continue;
      }
      seen.set(card.id, where);
    }
  }
  for (const card of room.rollbackState?.currentCards ?? []) {
    if (!seen.has(card.id)) seen.set(card.id, 'rollback');
  }
  if (seen.size !== 54) return `card count is ${seen.size}, expected 54`;
  return null;
}

/**
 * 1ゲームを最後まで進める。policies[i] が座席 i を担当する。
 */
export function runGame(policies: Policy[], options: RunOptions = {}): GameResult {
  const room = createSimRoom(policies.length);
  const policyOf = new Map<string, Policy>();
  room.players.forEach((p, i) => policyOf.set(p.id, policies[i]));

  const stats: GameStats = { plays: 0, lies: 0, passes: 0, doubts: 0, doubtSuccess: 0, doubtFailure: 0, counters: 0 };
  const perSeat = new Map<string, { lies: number; liesCaught: number; doubts: number; doubtsCorrect: number }>();
  room.players.forEach(p => perSeat.set(p.id, { lies: 0, liesCaught: 0, doubts: 0, doubtsCorrect: 0 }));

  GameEngine.startGame(room, { doubtTime: 5 });

  const maxSteps = options.maxSteps ?? 5000;
  let steps = 0;
  let stuck: string | null = null;
  const softIssues = new Map<string, number>();

  const isLie = (cards: Card[], declared: number, doubtType: string | null): boolean => {
    if (doubtType === 'counter' && declared === 3) {
      return cards.length !== 1 || cards[0].suit !== 'spade' || cards[0].number !== 3;
    }
    return cards.some(c => !c.isJoker && c.number !== declared);
  };

  const resolveDoubtPhase = () => {
    // DoubtManager.startDoubtPhase 相当 (タイマーなし)
    room.doubtDeclarers = [];
    room.doubtSkippers = [];
    room.field.counteredBy = null;

    const actorId = room.field.lastPlayerId!;
    const lying = isLie(room.field.currentCards, room.field.declaredNumber, room.field.doubtType);
    if (lying) {
      stats.lies++;
      perSeat.get(actorId)!.lies++;
    }

    const claimant = room.players.find(p => p.id === actorId)!;
    for (const p of room.players) {
      if (p.id === actorId || p.isOut || p.lives <= 0) continue;
      options.onDoubtWindow?.(room, p, claimant, lying, policyOf.get(p.id)!.name, policyOf.get(actorId)!.name);
      if (policyOf.get(p.id)!.shouldDoubt(room, p)) {
        DoubtManager.registerDoubt(room, p.id);
      } else {
        DoubtManager.registerSkip(room, p.id);
      }
    }

    options.onDoubtResolved?.(room, room.doubtDeclarers.length > 0, lying);
    const result = DoubtManager.resolveDoubt(room);
    if (result.type === 'success') {
      stats.doubts++;
      stats.doubtSuccess++;
      perSeat.get(result.doubterId)!.doubts++;
      perSeat.get(result.doubterId)!.doubtsCorrect++;
      perSeat.get(result.liarId)!.liesCaught++;
    } else if (result.type === 'failure') {
      stats.doubts++;
      stats.doubtFailure++;
      perSeat.get(result.doubterId)!.doubts++;
    } else if (result.type === 'counter' && result.doubterId) {
      stats.doubts++;
      stats.doubtFailure++;
      perSeat.get(result.doubterId)!.doubts++;
    }
    GameEngine.handleDoubtResult(room, result);
  };

  while (room.phase !== 'result') {
    if (++steps > maxSteps) {
      stuck = `step limit exceeded in phase ${room.phase}`;
      break;
    }
    if (options.checkInvariants) {
      const err = checkCardConservation(room, softIssues);
      if (err) {
        stuck = `invariant: ${err}`;
        break;
      }
    }

    if (room.phase === 'playing') {
      const playerId = room.turnOrder[room.currentPlayerIndex];
      const player = room.players.find(p => p.id === playerId)!;
      if (player.isOut || player.lives <= 0) {
        stuck = `turn is on a player who is out (${player.name})`;
        break;
      }
      let decision = policyOf.get(playerId)!.decidePlay(room, player);
      if (decision.type === 'pass') {
        const result = GameEngine.passTurn(room, playerId);
        if (result.success) {
          stats.passes++;
          continue;
        }
        // 場が空なのにパスしようとした: 手札があれば強制的に1枚出す
        if (player.hand.length === 0) {
          stuck = `player ${player.name} must lead with an empty hand`;
          break;
        }
        const card = player.hand[0];
        decision = { type: 'play', cards: [card], declaredNumber: card.isJoker ? 0 : card.number };
      }
      options.onClaim?.(room, player, decision.cards!, decision.declaredNumber!, false, policyOf.get(playerId)!.name);
      const result = GameEngine.playCards(room, playerId, decision.cards!.map(c => c.id), decision.declaredNumber!);
      if (!result.success) {
        stuck = `illegal play by ${policyOf.get(playerId)!.name}: ${result.error}`;
        break;
      }
      Brain.observeOwnPlay(room, playerId, decision.cards!);
      stats.plays++;
      continue;
    }

    if (room.phase === 'doubtPhase') {
      resolveDoubtPhase();
      continue;
    }

    if (room.phase === 'counterPhase') {
      if (room.counterActorIndex === null) {
        stuck = 'counterPhase without actor';
        break;
      }
      const actorId = room.turnOrder[room.counterActorIndex];
      const actor = room.players.find(p => p.id === actorId)!;
      const cards = actor.isOut || actor.lives <= 0 ? [] : policyOf.get(actorId)!.chooseCounter(room, actor);
      if (cards.length > 0) {
        options.onClaim?.(room, actor, cards, room.field.declaredNumber === 8 ? 4 : 3, true, policyOf.get(actorId)!.name);
        const result = GameEngine.declareCounter(room, actorId, cards.map(c => c.id));
        if (result.success) {
          Brain.observeOwnPlay(room, actorId, cards);
          stats.counters++;
          continue; // -> doubtPhase
        }
      }
      const hasNext = GameEngine.advanceCounterActor(room);
      if (!hasNext) {
        // resolveAndBroadcastCounter 相当
        const result = DoubtManager.resolveDoubt(room);
        GameEngine.handleDoubtResult(room, result);
      }
      continue;
    }

    if (room.phase === 'effectPhase') {
      const effect = room.pendingEffect;
      if (!effect) {
        stuck = 'effectPhase without pendingEffect';
        break;
      }
      const actor = room.players.find(p => p.id === effect.playerId)!;
      const decision = policyOf.get(actor.id)!.chooseEffect(room, actor, effect);
      let result = GameEngine.handleEffectAction(room, actor.id, decision.cardIds, decision.targetData);
      if (!result.success) {
        // 不正な選択は「何もしない」にフォールバック
        result = GameEngine.handleEffectAction(room, actor.id, [], undefined);
        if (!result.success) {
          stuck = `effect ${effect.type} could not be resolved: ${result.error}`;
          break;
        }
      }
      continue;
    }

    stuck = `unexpected phase ${room.phase}`;
    break;
  }

  const n = room.players.length;
  const seats: SeatResult[] = room.players.map((p, i) => {
    const validRank = p.rank !== null && p.rank > 0 ? p.rank : null;
    const eliminated: SeatResult['eliminated'] = validRank !== null ? null : p.rank === -1 ? 'forbidden' : 'lives';
    const tally = perSeat.get(p.id)!;
    return {
      policy: policies[i].name,
      rank: validRank,
      eliminated: stuck ? null : eliminated,
      score: validRank !== null && n > 1 ? (n - validRank) / (n - 1) : 0,
      livesLeft: p.lives,
      ...tally,
    };
  });

  return { seats, steps, stats, stuck, softIssues };
}
