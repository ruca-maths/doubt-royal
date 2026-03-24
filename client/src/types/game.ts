// Client-side type definitions (mirror server types)

export type Suit = 'spade' | 'heart' | 'diamond' | 'club';

export interface Card {
  id: string;
  suit: Suit | null;
  number: number;
  isJoker: boolean;
}

export type GamePhase = 'waiting' | 'playing' | 'doubtPhase' | 'counterPhase' | 'effectPhase' | 'result';

export type LogAction = 
  | 'play' | 'pass' | 'discard' | 'doubtSuccess' | 'doubtFailure' | 'counter' | 'revenge'
  | 'sevenPass' | 'sixCollect' | 'queenBomber' | 'doubtCardSelect' | 'eightCut' | 'revolution';

export interface LogEntry {
  id: string;
  timestamp: number;
  action: LogAction;
  playerId: string;
  playerName: string;
  declaredNumber?: number;
  cardCount?: number;
  revealedCards?: Card[];
  targetPlayerName?: string;
  targetNumbers?: number[];
}

export type EffectType =
  | 'sevenPass'
  | 'sixCollect'
  | 'tenDiscard'
  | 'queenBomber'
  | 'doubtCardSelect'
  | 'fourCounter'
  | 'spadeThree';

export interface PendingEffect {
  type: EffectType;
  playerId: string;
  count: number;
  targetPlayerId?: string;
}

export interface RulesState {
  direction: 1 | -1;
  isRevolution: boolean;
  isElevenBack: boolean;
  doubtTime: number;
}

export interface ClientPlayer {
  id: string;
  name: string;
  cardCount: number;
  lives: number;
  rank: number | null;
  isSkipped: boolean;
  isOut: boolean;
  isCurrentTurn: boolean;
  rankStats: Record<number, number>;
}

export interface ClientFieldState {
  currentCardCount: number;
  declaredNumber: number;
  cardHistoryCount: number;
  faceUpPool: Card[];
  lastPlayerId: string | null;
  doubtType: 'play' | 'discard' | 'counter' | null;
  counteredBy: string | null;
  pendingNumbers?: number[];
  revealedCards?: Card[];
  hasFieldCleared: boolean;
  isEffectActive: boolean;
}

export interface ClientGameState {
  roomId: string;
  hostId: string;
  phase: GamePhase;
  players: ClientPlayer[];
  field: ClientFieldState;
  rules: RulesState;
  currentPlayerId: string;
  myHand: Card[];
  pendingEffect: PendingEffect | null;
  finishOrder: string[];
  logs: LogEntry[];
  counterActorId: string | null;
}

export interface RoomInfo {
  players: { id: string; name: string }[];
  hostId: string;
}

export type DoubtResult =
  | { type: 'noDoubt' }
    | {
      type: 'counter';
      countererId: string;
      lastPlayerId: string;
      revealedCards?: Card[];
      count: number;
    }
  | {
      type: 'success';
      doubterId: string;
      liarId: string;
      revealedCards?: Card[];
      penaltyCardCount: number;
      count: number;
      doubtType: 'play' | 'discard';
    }
  | {
      type: 'failure';
      doubterId: string;
      honestPlayerId: string;
      revealedCards?: Card[];
      penaltyCardCount: number;
      count: number;
      doubtType: 'play' | 'discard';
    };
