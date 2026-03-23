import { Card, Suit } from './types';

const SUITS: Suit[] = ['spade', 'heart', 'diamond', 'club'];

export function createDeck(): Card[] {
  const cards: Card[] = [];
  let id = 0;

  for (const suit of SUITS) {
    for (let num = 1; num <= 13; num++) {
      cards.push({
        id: `card-${id++}`,
        suit,
        number: num,
        isJoker: false,
      });
    }
  }

  // 2 Jokers
  cards.push({ id: `card-${id++}`, suit: null, number: 0, isJoker: true });
  cards.push({ id: `card-${id++}`, suit: null, number: 0, isJoker: true });

  return cards;
}

export function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function dealCards(deck: Card[], playerCount: number): Card[][] {
  const hands: Card[][] = Array.from({ length: playerCount }, () => []);
  for (let i = 0; i < deck.length; i++) {
    hands[i % playerCount].push(deck[i]);
  }
  return hands;
}
