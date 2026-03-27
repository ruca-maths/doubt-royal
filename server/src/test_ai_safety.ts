import { AIEngine } from './game/ai';
import { Room, Player, Card } from './game/types';

// Mock Room setup
const mockPlayer: Player = {
  id: 'ai-1',
  name: 'CPU-1',
  hand: [
    { id: 'card-1', suit: 'club', number: 3, isJoker: false }
  ],
  isAI: true,
  isOut: false,
  isSkipped: false,
  rank: null,
  rankStats: {},
  persistentId: 'ai-1'
};

const mockRoom: Room = {
  id: 'test-room',
  phase: 'playing',
  players: [mockPlayer],
  turnOrder: ['ai-1'],
  currentPlayerIndex: 0,
  field: {
    currentCards: [],
    declaredNumber: 0,
    lastPlayerId: null,
    doubtType: 'honest',
    faceUpPool: [],
    counteredBy: null
  },
  rules: {
    doubtTime: 5,
    isRevolution: false,
    isElevenBack: false,
    isShibari: false,
    direction: 1
  },
  passCount: 0,
  logs: [],
  hostId: 'ai-1',
  finishOrder: []
};

function testHeuristic() {
  console.log("Testing Lead Player Heuristic...");
  const action = AIEngine.decidePlayActionHeuristic(mockRoom, mockPlayer);
  console.log("Action on empty field:", action);
  if (action.type === 'play' && action.cards && action.cards.length > 0) {
    console.log("SUCCESS: Lead player played a card.");
  } else {
    console.log("FAILURE: Lead player passed on empty field!");
    process.exit(1);
  }
}

testHeuristic();
