/**
 * PlayerView — 1人のプレイヤーが「ルール上知ってよい情報」だけを切り出したもの。
 *
 * サーバー上の Room には全員の手札が載っているが、思考ルーチン (brain) は必ずこの
 * PlayerView 経由で盤面を見る。こうしておくと CPU が他人の手札を覗く余地がなくなる。
 */
import { Card, GamePhase, LogEntry, PendingEffect, Room } from '../types';

/** ランク表現: 1〜13 = A〜K, 0 = ジョーカー */
export const JOKER = 0;
export const RANKS: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

export function rankOf(card: Card): number {
  return card.isJoker ? JOKER : card.number;
}

/** 山札に含まれる枚数 */
export function copiesInDeck(rank: number): number {
  return rank === JOKER ? 2 : 4;
}

/** 強さ (0 = 最弱 … 12 = 最強, ジョーカーは常に 100) */
export function strengthOf(rank: number, reversed: boolean): number {
  if (rank === JOKER) return 100;
  const normal = (rank - 3 + 13) % 13;
  return reversed ? 12 - normal : normal;
}

export function countRanks(cards: Card[]): number[] {
  const counts = new Array(14).fill(0);
  for (const card of cards) counts[rankOf(card)]++;
  return counts;
}

export interface SeatView {
  id: string;
  name: string;
  cardCount: number;
  lives: number;
  isOut: boolean;
  isSkipped: boolean;
}

export interface PlayerView {
  roomId: string;
  myId: string;
  hand: Card[];
  lives: number;
  /** 席順 (turnOrder) 通りの全プレイヤー */
  seats: SeatView[];
  /** まだ勝負に残っている自分以外のプレイヤー */
  opponents: SeatView[];
  /** 自分を含む、勝負に残っている人数 */
  activeCount: number;
  phase: GamePhase;
  direction: 1 | -1;
  isRevolution: boolean;
  isElevenBack: boolean;
  /** 現在の強さ順が逆転しているか (革命 XOR 11バック) */
  reversed: boolean;
  /** 場に出ている (ダウト対象の) カード枚数 */
  fieldCount: number;
  /** 場の宣言ランク */
  fieldRank: number;
  fieldOwnerId: string | null;
  doubtType: 'play' | 'discard' | 'counter' | null;
  /** 直前のプレイが出される前、場にあった枚数 (0 なら親として出した) */
  previousFieldCount: number;
  /** 直前のプレイが出される前の場の宣言ランク */
  previousFieldRank: number;
  pendingNumbers: number[] | undefined;
  /** Qボンバーが有効か (一度でも場が流れたか) */
  bombActive: boolean;
  /** 公開されたカード (表向き墓地 + 場や捨て山で表になっているもの) */
  faceUp: Card[];
  /** 6回収の対象になる表向き墓地 */
  faceUpPool: Card[];
  /** 裏向きのまま手札の外にあるカード枚数 (場・捨て山・墓地) */
  faceDownCount: number;
  pendingEffect: PendingEffect | null;
  logs: LogEntry[];
}

export function buildView(room: Room, playerId: string): PlayerView {
  const me = room.players.find(p => p.id === playerId);
  if (!me) throw new Error(`player ${playerId} is not in room ${room.id}`);

  const order = room.turnOrder.length > 0 ? room.turnOrder : room.players.map(p => p.id);
  const seats: SeatView[] = [];
  for (const id of order) {
    const p = room.players.find(player => player.id === id);
    if (!p) continue;
    seats.push({
      id: p.id,
      name: p.name,
      cardCount: p.hand.length,
      lives: p.lives,
      isOut: p.isOut || p.lives <= 0,
      isSkipped: p.isSkipped,
    });
  }

  const opponents = seats.filter(s => s.id !== playerId && !s.isOut);
  const meActive = !me.isOut && me.lives > 0;

  const zones = [room.field.currentCards, room.field.roundPile, room.field.cardHistory];
  const faceUp: Card[] = [...room.field.faceUpPool];
  const seen = new Set(faceUp.map(c => c.id));
  let faceDownCount = 0;
  const counted = new Set<string>();
  for (const zone of zones) {
    for (const card of zone) {
      if (counted.has(card.id)) continue;
      counted.add(card.id);
      if (card.isFaceUp) {
        if (!seen.has(card.id)) {
          seen.add(card.id);
          faceUp.push(card);
        }
      } else if (!seen.has(card.id)) {
        faceDownCount++;
      }
    }
  }

  const previous = room.rollbackState;
  const inResolution = room.phase === 'doubtPhase' || room.phase === 'counterPhase' || room.phase === 'effectPhase';

  return {
    roomId: room.id,
    myId: playerId,
    hand: [...me.hand],
    lives: me.lives,
    seats,
    opponents,
    activeCount: opponents.length + (meActive ? 1 : 0),
    phase: room.phase,
    direction: room.rules.direction,
    isRevolution: room.rules.isRevolution,
    isElevenBack: room.rules.isElevenBack,
    reversed: room.rules.isRevolution !== room.rules.isElevenBack,
    fieldCount: room.field.currentCards.length,
    fieldRank: room.field.declaredNumber,
    fieldOwnerId: room.field.lastPlayerId,
    doubtType: room.field.doubtType,
    previousFieldCount: inResolution && previous ? previous.currentCards.length : 0,
    previousFieldRank: inResolution && previous ? previous.declaredNumber : 0,
    pendingNumbers: room.field.pendingNumbers,
    bombActive: room.field.hasFieldCleared,
    faceUp,
    faceUpPool: [...room.field.faceUpPool],
    faceDownCount,
    pendingEffect: room.pendingEffect,
    logs: room.logs || [],
  };
}

/** 席順で id の次に手番が回る、勝負に残っているプレイヤー */
export function nextActiveSeat(view: PlayerView, fromId: string): SeatView | null {
  const total = view.seats.length;
  const start = view.seats.findIndex(s => s.id === fromId);
  if (start === -1) return null;
  for (let step = 1; step <= total; step++) {
    const index = ((start + view.direction * step) % total + total) % total;
    const seat = view.seats[index];
    if (seat.id === fromId) return null;
    if (!seat.isOut) return seat;
  }
  return null;
}
