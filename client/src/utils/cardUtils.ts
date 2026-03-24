import { Card, Suit } from '../types/game';

const SUIT_SYMBOLS: Record<Suit, string> = {
  spade: '♠',
  heart: '♥',
  diamond: '♦',
  club: '♣',
};

const NUMBER_DISPLAY: Record<number, string> = {
  1: 'A',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
};

export function getSuitSymbol(suit: Suit): string {
  return SUIT_SYMBOLS[suit];
}

export function getNumberDisplay(number: number): string {
  if (number === 0) return '🃏';
  return NUMBER_DISPLAY[number] || String(number);
}

export function getCardDisplayName(card: Card): string {
  if (card.isJoker) return 'JOKER';
  return `${getSuitSymbol(card.suit!)}${getNumberDisplay(card.number)}`;
}

export function getSuitColor(suit: Suit | null): 'red' | 'black' {
  if (suit === 'heart' || suit === 'diamond') return 'red';
  return 'black';
}

export function sortCards(cards: Card[]): Card[] {
  const getStrength = (num: number) => {
    if (num === 0) return 100; // Joker
    // Map 3->0, 4->1, ..., 13->10, 1(A)->11, 2->12
    return (num - 3 + 13) % 13;
  };

  return [...cards].sort((a, b) => {
    const strengthA = getStrength(a.isJoker ? 0 : a.number);
    const strengthB = getStrength(b.isJoker ? 0 : b.number);

    if (strengthA !== strengthB) {
      return strengthA - strengthB;
    }

    const suitOrder: Suit[] = ['spade', 'heart', 'diamond', 'club'];
    return suitOrder.indexOf(a.suit!) - suitOrder.indexOf(b.suit!);
  });
}

export function getDeclaredNumberDisplay(num: number): string {
  if (num === 0) return 'JOKER';
  return getNumberDisplay(num);
}

export function getCardEffectName(num: number, isRevolution: boolean): string | null {
  const effects: Record<number, string> = {
    4: '🛑 4カウンター 🛑',
    5: '⏭️ 5スキップ ⏭️',
    6: '♻️ 6回収 ♻️',
    7: '🎁 7渡し 🎁',
    8: '✂️ 8切り ✂️',
    9: '🔄 9リバース 🔄',
    10: '🗑️ 10捨て 🗑️',
    11: '🔙 11バック 🔙',
    12: '💣 Qボンバー 💣',
  };
  return effects[num] || null;
}

export function getStrength(num: number, isReversed: boolean = false): number {
  if (num === 0) return 100; // Joker is always strongest
  const baseStrength = (num - 3 + 13) % 13;
  return isReversed ? 12 - baseStrength : baseStrength;
}

export function getValidDeclarations(currentNum: number, currentCardCount: number, isReversed: boolean): number[] {
  const allNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 0];
  
  // If field is empty, any number is valid
  if (currentCardCount === 0) return allNumbers;
  
  // If a Joker was declared (and not in counter phase), nothing beats it
  if (currentNum === 0) return [];

  const currentStrength = getStrength(currentNum, isReversed);

  // Return numbers that are strictly stronger than current + Joker
  return allNumbers.filter(num => {
    if (num === 0) return true;
    return getStrength(num, isReversed) > currentStrength;
  });
}
