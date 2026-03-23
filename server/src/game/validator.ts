import { Card, RulesState } from './types';

/**
 * Get the strength of a card number for comparison.
 * Normal order: 3(weakest)→4→5→...→K→A→2(strongest), Joker=always strongest
 * Revolution: reversed (2=weakest, 3=strongest)
 */
export function getCardStrength(cardNumber: number, rules: RulesState): number {
  if (cardNumber === 0) return 100; // Joker always strongest

  // Map card numbers to strength: 3=0, 4=1, ..., K=10, A=11, 2=12
  const normalStrength = ((cardNumber - 3 + 13) % 13);

  const isReversed = rules.isRevolution !== rules.isElevenBack; // XOR
  return isReversed ? (12 - normalStrength) : normalStrength;
}

export function validatePlayCards(
  cards: Card[],
  declaredNumber: number,
  field: { currentCardCount: number; declaredNumber: number; lastPlayerId: string | null },
  rules: RulesState
): { valid: boolean; reason?: string } {
  if (cards.length === 0) {
    return { valid: false, reason: 'カードを選択してください' };
  }

  if (declaredNumber < 0 || declaredNumber > 13) {
    return { valid: false, reason: '無効な宣言数字です' };
  }

  // If there are cards on the field, we must match the count
  if (field.currentCardCount > 0) {
    if (cards.length !== field.currentCardCount) {
      return { valid: false, reason: `${field.currentCardCount}枚出してください` };
    }

    // Check strength
    const currentStrength = getCardStrength(declaredNumber, rules);
    const prevStrength = getCardStrength(field.declaredNumber, rules);

    // Joker cannot be played on Joker
    if (field.declaredNumber === 0 && declaredNumber === 0) {
      return { valid: false, reason: 'ジョーカーに対してジョーカーは出せません' };
    }

    if (currentStrength <= prevStrength) {
      return { valid: false, reason: '場より強いカードを出してください' };
    }
  }

  return { valid: true };
}

/**
 * Check if the finish is forbidden (禁止上がり).
 * Forbidden: finishing with 8, 2, or Joker (in normal)
 * Revolution: finishing with 8, 3, or Joker
 */
export function checkForbiddenFinish(
  declaredNumber: number,
  lastCards: Card[],
  isRevolution: boolean
): boolean {
  // Check joker
  if (lastCards.some(c => c.isJoker)) return true;

  // 8 is always forbidden
  if (declaredNumber === 8) return true;

  // 2 forbidden in normal, 3 forbidden in revolution
  if (!isRevolution && declaredNumber === 2) return true;
  if (isRevolution && declaredNumber === 3) return true;

  return false;
}

/**
 * Check if revolution should be triggered (4+ cards of same number).
 */
export function shouldRevolution(cards: Card[]): boolean {
  return cards.length >= 4;
}
