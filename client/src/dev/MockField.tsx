/**
 * 開発用: サーバーなしでゲームフィールドの各状態を表示する。
 *   npm run dev → http://localhost:5173/?mock=play
 * mock の値: play / follow / doubt / mine / counter / give / collect / bomb / wait / spectate / result
 * 人数は &n=2〜6。本番ビルドには含まれない (App.tsx で import.meta.env.DEV のときだけ読み込む)。
 */
import { useMemo, useState } from 'react';
import GameBoard from '../components/GameBoard';
import { GameContext, GameContextValue } from '../contexts/GameContext';
import { Card, ClientGameState, ClientPlayer, DoubtResult, LogEntry, Suit } from '../types/game';

const SUITS: Suit[] = ['spade', 'heart', 'diamond', 'club'];
let serial = 0;
const card = (number: number, suit: Suit = SUITS[serial % 4]): Card => ({ id: `m${serial++}`, suit, number, isJoker: false });
const joker = (): Card => ({ id: `m${serial++}`, suit: null, number: 0, isJoker: true });

function build(scenario: string, count: number): { state: ClientGameState; doubtResult: DoubtResult | null; declarers: string[] } {
  serial = 0;
  const names = ['あなた', 'COM 1', 'みさき', 'COM 2', 'たろう', 'COM 3'].slice(0, count);
  const players: ClientPlayer[] = names.map((name, i) => ({
    id: `p${i}`,
    name,
    cardCount: [9, 7, 11, 2, 5, 8][i],
    lives: [3, 2, 3, 1, 3, 2][i],
    rank: null,
    isSkipped: false,
    isOut: false,
    isCurrentTurn: false,
    rankStats: {},
    isAI: name.startsWith('COM'),
  }));

  const hand: Card[] = [
    card(3, 'spade'), card(3, 'heart'), card(5, 'club'), card(7, 'diamond'), card(8, 'spade'),
    card(8, 'heart'), card(10, 'club'), card(12, 'diamond'), card(13, 'spade'), card(1, 'heart'), card(2, 'club'), joker(),
  ];
  const pool: Card[] = [card(9, 'spade'), card(9, 'heart'), card(4, 'club'), card(11, 'diamond'), card(6, 'spade'), joker()];
  const now = Date.now();
  const log = (action: LogEntry['action'], playerIndex: number, extra: Partial<LogEntry> = {}): LogEntry => ({
    id: `log${serial++}`, timestamp: now, action, playerId: `p${playerIndex % count}`, playerName: names[playerIndex % count], ...extra,
  });
  const logs: LogEntry[] = [
    log('play', 1, { declaredNumber: 4, cardCount: 2 }),
    log('pass', 2),
    log('play', 3, { declaredNumber: 9, cardCount: 2 }),
    log('doubtSuccess', 0, { targetPlayerName: names[3 % count], revealedCards: [pool[0], pool[2]] }),
    log('doubtCardSelect', 0, { cardCount: 2, targetPlayerName: names[3 % count] }),
    log('play', 1, { declaredNumber: 8, cardCount: 1 }),
    log('eightCut', 1),
  ];

  const state: ClientGameState = {
    roomId: 'MOCK42',
    hostId: 'p0',
    phase: 'playing',
    players,
    field: {
      currentCardCount: 0,
      declaredNumber: 0,
      cardHistoryCount: 14,
      roundPileCount: 0,
      faceUpPool: pool,
      lastPlayerId: null,
      doubtType: null,
      counteredBy: null,
      hasFieldCleared: true,
      isEffectActive: true,
    },
    rules: { direction: 1, isRevolution: false, isElevenBack: false, doubtTime: 60 },
    currentPlayerId: 'p0',
    myHand: hand,
    pendingEffect: null,
    finishOrder: [],
    logs,
    counterActorId: null,
  };
  players[0].cardCount = hand.length;
  let doubtResult: DoubtResult | null = null;
  let declarers: string[] = [];
  const claim = (owner: number, rank: number, n: number, under = 0) => {
    state.field.currentCardCount = n;
    state.field.declaredNumber = rank;
    state.field.lastPlayerId = `p${owner % count}`;
    state.field.doubtType = 'play';
    state.field.roundPileCount = under;
    logs.push(log('play', owner, { declaredNumber: rank, cardCount: n }));
  };
  const turn = (index: number) => {
    state.currentPlayerId = `p${index % count}`;
    players.forEach((p, i) => { p.isCurrentTurn = i === index % count; });
  };

  turn(0);
  switch (scenario) {
    case 'follow':
      claim(1, 9, 2, 2);
      break;
    case 'doubt':
      claim(1, 8, 2, 3);
      state.phase = 'doubtPhase';
      turn(1);
      declarers = count > 2 ? ['p2'] : [];
      break;
    case 'mine':
      claim(0, 7, 2);
      state.phase = 'doubtPhase';
      break;
    case 'counter':
      claim(1, 8, 1);
      state.phase = 'counterPhase';
      state.counterActorId = 'p0';
      state.pendingEffect = { type: 'counterSelection', playerId: 'p0', count: 2 };
      turn(1);
      break;
    case 'give':
      claim(0, 7, 2);
      state.phase = 'effectPhase';
      state.pendingEffect = { type: 'sevenPass', playerId: 'p0', count: 2 };
      break;
    case 'collect':
      claim(0, 6, 2);
      state.phase = 'effectPhase';
      state.pendingEffect = { type: 'sixCollect', playerId: 'p0', count: 2 };
      break;
    case 'bomb':
      claim(0, 12, 2);
      state.phase = 'effectPhase';
      state.pendingEffect = { type: 'queenBomber', playerId: 'p0', count: 2 };
      break;
    case 'wait':
      claim(1, 11, 1, 1);
      state.rules.isElevenBack = true;
      state.rules.isRevolution = true;
      state.rules.direction = -1;
      turn(2);
      break;
    case 'verdict':
      claim(1, 13, 2);
      turn(2);
      doubtResult = {
        type: 'failure', doubterId: 'p0', honestPlayerId: 'p1', penaltyCardCount: 0, count: 2, doubtType: 'play',
        revealedCards: [card(13, 'heart'), joker()],
      };
      state.field.revealedCards = doubtResult.revealedCards;
      break;
    case 'spectate':
      claim(1, 5, 1);
      turn(2);
      players[0].isOut = true;
      players[0].rank = 1;
      state.myHand = [];
      state.finishOrder = ['p0'];
      players.forEach((p, i) => { if (i > 0) p.winRate = [0, 48, 12, 30, 6, 4][i]; });
      break;
    case 'result':
      state.phase = 'result';
      players.forEach((p, i) => { p.isOut = true; p.rank = [2, 1, 3, null, -1, 4][i]; });
      if (players[3]) players[3].lives = 0;
      break;
    default:
      break;
  }
  return { state, doubtResult, declarers };
}

export default function MockField() {
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get('mock') || 'play';
  const count = Math.min(6, Math.max(2, parseInt(params.get('n') || '4', 10)));
  const built = useMemo(() => build(scenario, count), [scenario, count]);
  const [message, setMessage] = useState<string | null>(null);

  const say = (text: string) => () => setMessage(text);
  const value: GameContextValue = {
    socket: null,
    isConnected: true,
    myId: 'p0',
    playerName: 'あなた',
    setPlayerName: () => {},
    roomId: built.state.roomId,
    roomInfo: null,
    createRoom: () => {},
    joinRoom: () => {},
    leaveRoom: say('退出'),
    startGame: () => {},
    addAiPlayer: () => {},
    gameState: built.state,
    doubtResult: built.doubtResult,
    clearDoubtResult: () => {},
    doubtDeclarers: built.declarers,
    playCards: (ids, declared) => setMessage(`(mock) play ${ids.length}枚 declared=${declared}`),
    passTurn: say('(mock) pass'),
    playAgain: say('(mock) play again'),
    declareDoubt: say('(mock) doubt'),
    skipDoubt: say('(mock) skip'),
    declareCounter: ids => setMessage(`(mock) counter ${ids.length}枚`),
    effectAction: (ids, data) => setMessage(`(mock) effect ${ids.length}枚 ${JSON.stringify(data ?? {})}`),
    error: message,
    clearError: () => setMessage(null),
  };

  return (
    <GameContext.Provider value={value}>
      <GameBoard />
    </GameContext.Provider>
  );
}
