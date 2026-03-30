import { validatePlayCards, getCardStrength } from './src/game/validator';

console.log('--- Strength Test ---');
const rules: any = { isRevolution: false, isElevenBack: false };
console.log('Strength of 10:', getCardStrength(10, rules));
console.log('Strength of 4:', getCardStrength(4, rules));
console.log('Strength of Ace(1):', getCardStrength(1, rules));
console.log('Strength of 2:', getCardStrength(2, rules));

console.log('\n--- Validation Test (Normal) ---');
const field = { currentCardCount: 1, declaredNumber: 10, lastPlayerId: 'p1' };
const validation4 = validatePlayCards([{ id: 'c', number: 4, suit: 'heart', isJoker: false }] as any, 4, field, rules);
console.log('Can play 4 on 10?', validation4.valid, validation4.reason || '');

const validationAce = validatePlayCards([{ id: 'c', number: 1, suit: 'heart', isJoker: false }] as any, 1, field, rules);
console.log('Can play Ace on 10?', validationAce.valid, validationAce.reason || '');

console.log('\n--- Validation Test (Revolution) ---');
const rulesRev: any = { isRevolution: true, isElevenBack: false };
const validation4Rev = validatePlayCards([{ id: 'c', number: 4, suit: 'heart', isJoker: false }] as any, 4, field, rulesRev);
console.log('Can play 4 on 10 in Revolution?', validation4Rev.valid, validation4Rev.reason || '');

console.log('\n--- Validation Test (Eleven Back) ---');
const rules11B: any = { isRevolution: false, isElevenBack: true };
const validation411B = validatePlayCards([{ id: 'c', number: 4, suit: 'heart', isJoker: false }] as any, 4, field, rules11B);
console.log('Can play 4 on 10 in Eleven Back?', validation411B.valid, validation411B.reason || '');
