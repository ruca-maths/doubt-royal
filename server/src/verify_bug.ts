import { GameEngine } from './game/engine';
import { DoubtManager } from './game/doubt';
import { Room, Card, Player } from './game/types';

// Mock Room setup
function createMockRoom(): Room {
  const players: Player[] = [
    { id: 'p1', name: 'Player 1', hand: [], lives: 3, rank: null, isSkipped: false, isOut: false, persistentId: 'p1', rankStats: {} },
    { id: 'p2', name: 'Player 2', hand: [], lives: 3, rank: null, isSkipped: false, isOut: false, persistentId: 'p2', rankStats: {} },
    { id: 'p3', name: 'Player 3', hand: [], lives: 3, rank: null, isSkipped: false, isOut: false, persistentId: 'p3', rankStats: {} },
  ];

  const room: Room = {
    id: 'room1',
    hostId: 'p1',
    players,
    phase: 'playing',
    field: {
      currentCards: [],
      declaredNumber: 0,
      cardHistory: [],
      faceUpPool: [],
      lastPlayerId: null,
      doubtType: null,
      counteredBy: null,
      hasFieldCleared: false,
    },
    rules: {
      direction: 1,
      isRevolution: false,
      isElevenBack: false,
      doubtTime: 5,
    },
    currentPlayerIndex: 0,
    turnOrder: ['p1', 'p2', 'p3'],
    finishOrder: [],
    doubtDeclarers: [],
    doubtSkippers: [],
    pendingEffect: null,
    deferredEffect: null,
    doubtTimerId: null,
    pendingFinishPlayerId: null,
    passCount: 0,
    logs: [],
    counterActorIndex: null,
  };

  return room;
}

async function runTest() {
  console.log('Starting verification test...');
  const room = createMockRoom();
  const p1 = room.players[0];
  const p2 = room.players[1];
  const p3 = room.players[2];

  // 1. P1 plays a card (e.g., 3)
  const card1: Card = { id: 'c1', suit: 'heart', number: 3, isJoker: false };
  p1.hand.push(card1);
  GameEngine.playCards(room, 'p1', ['c1'], 3);
  console.log('P1 played 3.');

  // 2. P2 doubts
  DoubtManager.startDoubtPhase(room, () => {}); // Reset doubt state
  DoubtManager.registerDoubt(room, 'p2');
  const result = DoubtManager.resolveDoubt(room);
  console.log('P2 doubted P1. Result:', result.type);
  
  if (result.type !== 'failure') {
    throw new Error('Doubt should have failed (P1 was honest)');
  }

  // Handle doubt result
  GameEngine.handleDoubtResult(room, result);
  console.log('Handled doubt result. P1 cards on field:', room.field.currentCards.map(c => `${c.number} (FaceUp: ${c.isFaceUp})`));

  if (!room.field.currentCards[0].isFaceUp) {
    throw new Error('P1 card should be face-up after doubt failure');
  }

  // 3. P3 plays another card on top (e.g., 4)
  const card2: Card = { id: 'c2', suit: 'club', number: 4, isJoker: false };
  p3.hand.push(card2);
  room.currentPlayerIndex = 2; // Move to P3
  room.phase = 'playing'; // Reset phase
  GameEngine.playCards(room, 'p3', ['c2'], 4);
  console.log('P3 played 4 on top of face-up 3.');

  // 4. No doubt for P3
  DoubtManager.startDoubtPhase(room, () => {}); // Reset doubt state for P3
  const result2 = DoubtManager.resolveDoubt(room);
  console.log('No doubt for P3. Result:', result2.type);
  GameEngine.handleDoubtResult(room, result2);

  // 5. Verification: c1 (P1's Card) should be in faceUpPool, not cardHistory
  console.log('--- Graveyard Check ---');
  console.log('cardHistory IDs:', JSON.stringify(room.field.cardHistory.map(c => c.id)));
  console.log('faceUpPool IDs:', JSON.stringify(room.field.faceUpPool.map(c => c.id)));

  const isInFaceUpPool = room.field.faceUpPool.some(c => c.id === 'c1');
  const isInCardHistory = room.field.cardHistory.some(c => c.id === 'c1');

  if (isInFaceUpPool && !isInCardHistory) {
    console.log('RESULT: P1 card correctly moved to faceUpPool.');
  } else if (isInCardHistory) {
    console.log('RESULT: FAILURE - P1 card incorrectly moved to cardHistory (Regular Grave).');
  } else {
    console.log('RESULT: FAILURE - P1 card lost?', room.field.currentCards.map(c => c.id));
  }

  // 6. Test clearing field
  console.log('--- Clearing Field ---');
  // P3's card should be on field
  console.log('Cards on field before final clear:', room.field.currentCards.map(c => c.id));
  
  // Everyone passes to clear field
  room.passCount = 2; // Simulated: P1 and P2 passed
  GameEngine.advanceTurn(room); // Logic: isBackToLastPlayer or isEveryonePassed -> clearField
  
  console.log('Final graveyards after clearField:');
  console.log('cardHistory IDs:', JSON.stringify(room.field.cardHistory.map(c => c.id)));
  console.log('faceUpPool IDs:', JSON.stringify(room.field.faceUpPool.map(c => c.id)));

  const isC2InCardHistory = room.field.cardHistory.some(c => c.id === 'c2');
  if (isC2InCardHistory) {
    console.log('RESULT: P3 card (face-down) moved to cardHistory.');
  } else {
    console.log('RESULT: FAILURE - P3 card not in cardHistory.');
  }

  console.log('Verification finished.');
}

runTest().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
