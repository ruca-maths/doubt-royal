// ===== Suit & Card =====
export type Suit = 'spade' | 'heart' | 'diamond' | 'club';

export interface Card {
  id: string;
  suit: Suit | null; // null for joker
  number: number;    // 1-13 for normal, 0 for joker
  isJoker: boolean;
}

// ===== Player =====
export interface Player {
  id: string;
  name: string;
  hand: Card[];
  lives: number;
  rank: number | null; // finishing order (1 = first out)
  isSkipped: boolean;
  isOut: boolean;      // eliminated (lives=0 or forbidden finish)
}

// ===== Game State =====
export type GamePhase = 'waiting' | 'playing' | 'doubtPhase' | 'counterPhase' | 'effectPhase' | 'result';

// ===== Field =====
export interface FieldState {
  currentCards: Card[];       // cards just played or discarded (face-down)
  declaredNumber: number;     // number the player declared (1-13, 0=joker)
  cardHistory: Card[];        // accumulated face-down cards on field (Grave)
  faceUpPool: Card[];         // revealed cards (Face-up Grave, for effect 6)
  lastPlayerId: string | null;
  doubtType: 'play' | 'discard' | 'counter' | null;
  counteredBy: string | null;
  pendingNumbers?: number[];
}

// ===== Rules =====
export interface RulesState {
  direction: 1 | -1;          // 1=clockwise, -1=counter
  isRevolution: boolean;
  isElevenBack: boolean;
  doubtTime: number;
}

// ===== Effect Action =====
export type EffectType =
  | 'sevenPass'       // 7: pass cards to next player
  | 'sixCollect'      // 6: collect face-up cards
  | 'tenDiscard'      // 10: discard from hand
  | 'queenBomber'     // Q: specify numbers to bomb
  | 'doubtCardSelect' // doubt success: pick card from liar
  | 'fourCounter'     // 4: counter 8-cut
  | 'spadeThree';     // spade 3: counter single joker

export interface PendingEffect {
  type: EffectType;
  playerId: string;    // who needs to act
  count: number;       // how many cards to select/discard
  targetPlayerId?: string; // who receives the cards (for doubt success/failure or 7-pass)
  isFromDoubtSuccess?: boolean;
}

// ===== Timeline Logs =====
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

// ===== Room =====
export interface Room {
  id: string;
  hostId: string;
  players: Player[];
  phase: GamePhase;
  field: FieldState;
  rules: RulesState;
  currentPlayerIndex: number;
  turnOrder: string[];       // player IDs in seating order
  finishOrder: string[];     // player IDs in finish order
  doubtDeclarers: string[];  // player IDs who declared doubt this phase
  doubtSkippers: string[];   // player IDs who skipped doubt
  pendingEffect: PendingEffect | null;
  deferredEffect: PendingEffect | null;
  doubtTimerId: NodeJS.Timeout | null;
  rollbackState?: {
    currentCards: Card[];
    declaredNumber: number;
    lastPlayerId: string | null;
    doubtType: 'play' | 'discard' | 'counter' | null;
    rules: RulesState;
    skippedPlayerIds: string[];
  };
  logs: LogEntry[];
}

// ===== Client-visible state (sanitized) =====
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
}

export interface ClientFieldState {
  currentCardCount: number;  // how many cards were just played (face-down)
  declaredNumber: number;
  cardHistoryCount: number;
  faceUpPool: Card[];
  lastPlayerId: string | null;
  doubtType: 'play' | 'discard' | 'counter' | null;
  counteredBy: string | null;
  revealedCards?: Card[];    // shown after doubt
}
