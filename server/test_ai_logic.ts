import { AIEngine } from './src/game/ai';
import { Room, Player, Card } from './src/game/types';

function createMockCard(num: number, suit: string = 'spade'): Card {
  return { id: `card-${num}-${suit}`, number: num, suit: suit as any, isJoker: false };
}

console.log('--- AI Heuristic Test: Eleven Back ---');

const mockPlayer: any = {
  id: 'ai-1',
  name: 'COM 1',
  hand: [
    createMockCard(3),
    createMockCard(4),
    createMockCard(10),
    createMockCard(12),
  ],
  isAI: true
};

const mockRoom: any = {
  rules: { isRevolution: false, isElevenBack: true }, // Eleven Back is active
  field: { currentCards: [], declaredNumber: 0, lastPlayerId: null },
  players: [mockPlayer],
  turnOrder: ['ai-1'],
  currentPlayerIndex: 0
};

// On empty field with 11-back, 3 is strongest, so AI should lead with something weaker (like 12 or 10 if it wants to be conservative)
// Wait, the heuristic picks availableNumbers[0] after sorting.
// Rank in Rev/11-back: 2: -15, 1: -14, 13: -13, ..., 3: -3.
// So availableNumbers[0] will be 2, 1, 13, 12... 
// In this hand [3, 4, 10, 12], the order is 12, 10, 4, 3.
// So availableNumbers[0] should be 12.

const action = (AIEngine as any).decidePlayActionHeuristic(mockRoom, mockPlayer);
console.log('AI Lead Choice (11-back):', action.declaredNumber);
if (action.declaredNumber === 12) {
  console.log('SUCCESS: AI chose 12 (weakest card in 11-back)');
} else {
  console.log('FAILURE: AI chose', action.declaredNumber);
}

console.log('\n--- AI Heuristic Test: Normal ---');
mockRoom.rules.isElevenBack = false;
const actionNormal = (AIEngine as any).decidePlayActionHeuristic(mockRoom, mockPlayer);
console.log('AI Lead Choice (Normal):', actionNormal.declaredNumber);
if (actionNormal.declaredNumber === 3) {
  console.log('SUCCESS: AI chose 3 (weakest card in normal)');
} else {
  console.log('FAILURE: AI chose', actionNormal.declaredNumber);
}
