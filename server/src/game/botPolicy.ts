import { Card, PendingEffect, Player, Room } from './types';
import { checkForbiddenFinish, getCardStrength, validatePlayCards } from './validator';

export interface BotPlayAction {
  type: 'play' | 'pass';
  cards?: Card[];
  declaredNumber?: number;
}

export interface BotEffectAction {
  cardIds: string[];
  targetData?: { numbers?: number[] };
}

/** A self-contained policy used when no trained policy is explicitly enabled. */
export class BotPolicy {
  static decidePlay(room: Room, player: Player): BotPlayAction {
    const isLead = room.field.currentCards.length === 0 || room.field.lastPlayerId === null;
    const countToPlay = isLead ? undefined : room.field.currentCards.length;
    const declarations = Array.from({ length: 14 }, (_, index) => index === 13 ? 0 : index + 1);
    const candidates: Array<{ action: BotPlayAction; score: number }> = [];

    for (const declaredNumber of declarations) {
      const maxCount = Math.min(6, countToPlay ?? player.hand.length);
      const truthfulCards = this.getTruthfulCards(player.hand, declaredNumber);

      for (let count = countToPlay ?? 1; count <= maxCount; count++) {
        const honestSelection = this.selectTruthfulCards(player.hand, declaredNumber, count);
        if (honestSelection) {
          this.addCandidate(candidates, room, player, honestSelection, declaredNumber, isLead, false);
        }

        const mayBluff = !isLead || count === player.hand.length;
        if (mayBluff && truthfulCards.length < count) {
          const bluffSelection = this.selectBluffCards(player.hand, declaredNumber, count);
          if (bluffSelection) {
            this.addCandidate(candidates, room, player, bluffSelection, declaredNumber, false, true);
          }
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best && (isLead || best.score >= 4.0)) return best.action;
    return { type: 'pass' };
  }

  static shouldDoubt(room: Room, observer: Player): boolean {
    const target = room.players.find(p => p.id === room.field.lastPlayerId);
    if (!target || target.id === observer.id || target.isOut || observer.isOut) return false;

    if (this.isProvableLie(room, observer)) return true;

    const pileCount = room.field.currentCards.length;
    const targetHandBeforePlay = target.hand.length + pileCount;
    const totalHands = room.players
      .filter(p => !p.isOut && p.lives > 0)
      .reduce((sum, p) => sum + p.hand.length, 0);
    const unknownCount = Math.max(1, totalHands - observer.hand.length + pileCount);
    const lieProbability = this.estimateLieProbability(
      room,
      observer,
      room.field.declaredNumber,
      pileCount,
      targetHandBeforePlay,
      unknownCount,
      room.field.doubtType === 'counter',
    );

    if (lieProbability >= 0.995) return true;

    let threshold = target.hand.length <= 2 ? 0.34 : target.hand.length <= 5 ? 0.48 : 0.62;
    if (observer.lives <= 1) threshold += 0.12;
    if (target.hand.length === 0 && checkForbiddenFinish(
      room.field.declaredNumber,
      room.field.currentCards,
      room.rules.isRevolution,
    )) threshold += 0.08;

    const callChance = Math.max(0, Math.min(0.9, (lieProbability - threshold + 0.12) / 0.22));
    return Math.random() < callChance;
  }

  static isProvableLie(room: Room, observer: Player): boolean {
    const declaredNumber = room.field.declaredNumber;
    const playCount = room.field.currentCards.length;
    const faceUp = room.field.faceUpPool;
    let truthSupply: number;

    if (room.field.doubtType === 'counter' && declaredNumber === 3) {
      const holdsSpadeThree = observer.hand.some(card => !card.isJoker && card.suit === 'spade' && card.number === 3);
      const visibleSpadeThree = faceUp.some(card => !card.isJoker && card.suit === 'spade' && card.number === 3);
      truthSupply = playCount === 1 && !holdsSpadeThree && !visibleSpadeThree ? 1 : 0;
    } else if (declaredNumber === 0) {
      const knownJokers = observer.hand.filter(card => card.isJoker).length
        + faceUp.filter(card => card.isJoker).length;
      truthSupply = Math.max(0, 2 - knownJokers);
    } else {
      const knownRank = observer.hand.filter(card => !card.isJoker && card.number === declaredNumber).length
        + faceUp.filter(card => !card.isJoker && card.number === declaredNumber).length;
      const knownJokers = observer.hand.filter(card => card.isJoker).length
        + faceUp.filter(card => card.isJoker).length;
      truthSupply = Math.max(0, 4 - knownRank) + Math.max(0, 2 - knownJokers);
    }
    return playCount > truthSupply;
  }

  static chooseCounter(room: Room, player: Player): Card[] {
    if (room.field.declaredNumber === 8) {
      const required = room.field.currentCards.length + 1;
      const fours = player.hand
        .filter(card => !card.isJoker && card.number === 4)
        .slice(0, required);
      return fours.length === required && fours.length < player.hand.length ? fours : [];
    }

    if (room.field.declaredNumber === 0 && room.field.currentCards.length === 1) {
      const spadeThree = player.hand.find(card => !card.isJoker && card.suit === 'spade' && card.number === 3);
      return spadeThree && player.hand.length > 1 ? [spadeThree] : [];
    }
    return [];
  }

  static chooseEffect(room: Room, player: Player, effect: PendingEffect): BotEffectAction {
    const count = Math.max(0, effect.count);

    switch (effect.type) {
      case 'sevenPass':
      case 'tenDiscard': {
        const available = this.excludeRestrictedCards(player.hand, effect);
        return {
          cardIds: [...available]
            .sort((a, b) => this.cardCost(a, room) - this.cardCost(b, room))
            .slice(0, Math.min(count, available.length))
            .map(card => card.id),
        };
      }

      case 'sixCollect': {
        const chosen = [...room.field.faceUpPool]
          .sort((a, b) => getCardStrength(b.isJoker ? 0 : b.number, room.rules) - getCardStrength(a.isJoker ? 0 : a.number, room.rules))
          .filter(card => card.isJoker || getCardStrength(card.number, room.rules) >= 8)
          .slice(0, Math.min(count, room.field.faceUpPool.length));
        return { cardIds: chosen.map(card => card.id) };
      }

      case 'doubtCardSelect':
        // The implemented rule makes the effect owner give cards to the target.
        // Giving none preserves the AI's hand and avoids helping an opponent.
        return { cardIds: [] };

      case 'queenBomber':
        return { cardIds: [], targetData: { numbers: this.chooseBombNumbers(room, player, count) } };

      default:
        return { cardIds: [] };
    }
  }

  private static addCandidate(
    candidates: Array<{ action: BotPlayAction; score: number }>,
    room: Room,
    player: Player,
    cards: Card[],
    declaredNumber: number,
    isLead: boolean,
    isBluff: boolean,
  ): void {
    const validation = validatePlayCards(
      cards,
      declaredNumber,
      {
        currentCardCount: room.field.currentCards.length,
        declaredNumber: room.field.declaredNumber,
        lastPlayerId: room.field.lastPlayerId,
      },
      room.rules,
    );
    if (!validation.valid) return;

    const revolutionAfterPlay = cards.length >= 4 ? !room.rules.isRevolution : room.rules.isRevolution;
    const finishes = cards.length === player.hand.length;
    const forbiddenFinish = finishes && checkForbiddenFinish(declaredNumber, cards, revolutionAfterPlay);

    let score = cards.length * 3.1;
    score -= cards.reduce((sum, card) => sum + this.cardCost(card, room), 0);
    score += isLead ? 2.4 : 2.8;

    if (!isLead) {
      const fieldOwner = room.players.find(p => p.id === room.field.lastPlayerId);
      if (fieldOwner && fieldOwner.hand.length <= 2) score += 5.0;
      else if (fieldOwner && fieldOwner.hand.length <= 5) score += 2.0;
    }

    score += this.effectValue(room, declaredNumber);
    if (cards.length >= 4) score += room.rules.isRevolution ? -1.0 : 2.5;
    if (finishes) score += 40;
    if (forbiddenFinish) score -= 45;

    if (isBluff) {
      score -= 3.5 + this.estimateCatchChance(room, player, declaredNumber, cards.length) * 9;
    }

    candidates.push({
      action: { type: 'play', cards, declaredNumber },
      score,
    });
  }

  private static effectValue(room: Room, declaredNumber: number): number {
    switch (declaredNumber) {
      case 5: return 1.5;
      case 6: return room.field.faceUpPool.length > 0 ? 2.0 : 0;
      case 7: return 1.8;
      case 8: return 5.0;
      case 9: return 1.2;
      case 10: return 2.6;
      case 11: return 0.8;
      case 12: return room.field.hasFieldCleared ? 2.8 : 0;
      default: return 0;
    }
  }

  private static getTruthfulCards(hand: Card[], declaredNumber: number): Card[] {
    return hand.filter(card => card.isJoker || card.number === declaredNumber);
  }

  private static selectTruthfulCards(hand: Card[], declaredNumber: number, count: number): Card[] | null {
    const exact = hand
      .filter(card => !card.isJoker && card.number === declaredNumber)
      .sort((a, b) => this.cardCost(a) - this.cardCost(b));
    const jokers = hand
      .filter(card => card.isJoker)
      .sort((a, b) => this.cardCost(a) - this.cardCost(b));
    const selected = [...exact.slice(0, count)];
    if (selected.length < count) selected.push(...jokers.slice(0, count - selected.length));
    return selected.length === count ? selected : null;
  }

  private static selectBluffCards(hand: Card[], declaredNumber: number, count: number): Card[] | null {
    const truthful = this.getTruthfulCards(hand, declaredNumber)
      .sort((a, b) => this.cardCost(a) - this.cardCost(b));
    const mismatched = hand
      .filter(card => !card.isJoker && card.number !== declaredNumber)
      .sort((a, b) => this.cardCost(a) - this.cardCost(b));

    let best: Card[] | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let mismatchCount = 1; mismatchCount <= count; mismatchCount++) {
      const truthfulCount = count - mismatchCount;
      if (truthfulCount > truthful.length || mismatchCount > mismatched.length) continue;
      const selection = [
        ...truthful.slice(0, truthfulCount),
        ...mismatched.slice(0, mismatchCount),
      ];
      const cost = selection.reduce((sum, card) => sum + this.cardCost(card), 0);
      if (cost < bestCost) {
        best = selection;
        bestCost = cost;
      }
    }
    return best;
  }

  private static cardCost(card: Card, room?: Room): number {
    if (card.isJoker) return 8.0;
    const strength = room ? getCardStrength(card.number, room.rules) : card.number === 2 ? 12 : card.number === 1 ? 11 : card.number - 3;
    let cost = strength * 0.4;
    if (card.number === 2) cost += 0.9;
    if (card.number === 1) cost += 0.5;
    if (card.suit === 'spade' && card.number === 3) cost += 1.4;
    return Math.max(0.2, cost);
  }

  private static estimateCatchChance(room: Room, actor: Player, declaredNumber: number, playCount: number): number {
    const observers = room.players.filter(p => !p.isOut && p.lives > 0 && p.id !== actor.id);
    if (observers.length === 0) return 0;
    const totalHands = room.players
      .filter(p => !p.isOut && p.lives > 0)
      .reduce((sum, p) => sum + p.hand.length, 0);
    const chances = observers.map(observer => {
      const unknownCount = Math.max(1, totalHands - observer.hand.length);
      const remainingCards = actor.hand.length - playCount;
      const lieProbability = this.estimateLieProbability(
        room,
        observer,
        declaredNumber,
        playCount,
        actor.hand.length,
        unknownCount,
      );
      const threshold = observer.lives <= 1 ? 0.62 : remainingCards <= 2 ? 0.34 : remainingCards <= 5 ? 0.48 : 0.62;
      const willingness = Math.max(0.05, Math.min(1, (lieProbability - threshold + 0.12) / 0.22));
      return lieProbability * willingness;
    });
    return chances.reduce((sum, chance) => sum + chance, 0) / chances.length;
  }

  private static estimateLieProbability(
    room: Room,
    observer: Player,
    declaredNumber: number,
    playCount: number,
    targetHandSize: number,
    unknownCount: number,
    isCounter = false,
  ): number {
    const faceUp = room.field.faceUpPool;
    let truthSupply: number;

    if (isCounter && declaredNumber === 3) {
      const holdsSpadeThree = observer.hand.some(card => !card.isJoker && card.suit === 'spade' && card.number === 3);
      const visibleSpadeThree = faceUp.some(card => !card.isJoker && card.suit === 'spade' && card.number === 3);
      truthSupply = playCount === 1 && !holdsSpadeThree && !visibleSpadeThree ? 1 : 0;
    } else if (declaredNumber === 0) {
      const ownJokers = observer.hand.filter(card => card.isJoker).length;
      const visibleJokers = faceUp.filter(card => card.isJoker).length;
      truthSupply = Math.max(0, 2 - ownJokers - visibleJokers);
    } else {
      const ownRank = observer.hand.filter(card => !card.isJoker && card.number === declaredNumber).length;
      const visibleRank = faceUp.filter(card => !card.isJoker && card.number === declaredNumber).length;
      const ownJokers = observer.hand.filter(card => card.isJoker).length;
      const visibleJokers = faceUp.filter(card => card.isJoker).length;
      truthSupply = Math.max(0, 4 - ownRank - visibleRank) + Math.max(0, 2 - ownJokers - visibleJokers);
    }

    if (playCount > truthSupply || playCount > targetHandSize) return 1;
    const population = Math.max(1, unknownCount);
    const goodCards = Math.min(population, truthSupply);
    const handSize = Math.min(population, Math.max(0, targetHandSize));
    const chanceHasEnough = this.hypergeometricAtLeast(population, goodCards, handSize, playCount);
    // A player can still bluff while holding truthful cards, so retain a small base rate.
    return Math.max(0.03, Math.min(0.97, 0.08 + (1 - chanceHasEnough) * 0.82));
  }

  private static hypergeometricAtLeast(population: number, goodCards: number, draws: number, needed: number): number {
    if (needed <= 0) return 1;
    if (goodCards < needed || draws < needed || population < needed) return 0;
    const denominator = this.logCombination(population, draws);
    let probability = 0;
    for (let goodDraws = needed; goodDraws <= Math.min(goodCards, draws); goodDraws++) {
      const badDraws = draws - goodDraws;
      if (badDraws > population - goodCards) continue;
      probability += Math.exp(
        this.logCombination(goodCards, goodDraws)
        + this.logCombination(population - goodCards, badDraws)
        - denominator,
      );
    }
    return Math.max(0, Math.min(1, probability));
  }

  private static logCombination(n: number, k: number): number {
    if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
    const reduced = Math.min(k, n - k);
    let result = 0;
    for (let index = 1; index <= reduced; index++) {
      result += Math.log(n - reduced + index) - Math.log(index);
    }
    return result;
  }

  private static chooseBombNumbers(room: Room, player: Player, count: number): number[] {
    const activeOpponents = room.players.filter(p => !p.isOut && p.id !== player.id);
    const opponentWeight = activeOpponents.reduce((sum, opponent) => {
      const urgency = opponent.hand.length <= 3 ? 1.8 : opponent.hand.length <= 6 ? 1.3 : 1;
      return sum + opponent.hand.length * urgency;
    }, 0);
    const unknownCards = Math.max(1, activeOpponents.reduce((sum, opponent) => sum + opponent.hand.length, 0));

    return Array.from({ length: 14 }, (_, index) => index === 13 ? 0 : index + 1)
      .map(number => {
        const maximum = number === 0 ? 2 : 4;
        const ownCount = player.hand.filter(card => number === 0 ? card.isJoker : !card.isJoker && card.number === number).length;
        const visibleCount = room.field.faceUpPool.filter(card => number === 0 ? card.isJoker : !card.isJoker && card.number === number).length;
        const remaining = Math.max(0, maximum - ownCount - visibleCount);
        const expectedOpponentHits = (remaining * opponentWeight) / unknownCards;
        const lostOwnValue = player.hand
          .filter(card => number === 0 ? card.isJoker : !card.isJoker && card.number === number)
          .reduce((sum, card) => sum + 1.5 + this.cardCost(card, room) * 0.35, 0);
        return { number, score: expectedOpponentHits * 2 - lostOwnValue };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(count, 14))
      .map(item => item.number);
  }

  private static excludeRestrictedCards(cards: Card[], effect: PendingEffect): Card[] {
    const excluded = (effect as any).excludedNumbers as number[] | undefined;
    if (!excluded) return cards;
    return cards.filter(card => !excluded.includes(card.number) && !(excluded.includes(0) && card.isJoker));
  }
}
