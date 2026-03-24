import { Room, Card, Player } from './types';

export class DoubtManager {
  /**
   * Start the doubt phase: set timer, allow declarations.
   * Returns the timeout handle.
   */
  static startDoubtPhase(
    room: Room,
    onTimeout: (room: Room) => void
  ): NodeJS.Timeout {
    room.phase = 'doubtPhase';
    room.doubtDeclarers = [];
    room.doubtSkippers = [];
    room.field.counteredBy = null;

    const factor = room.field.doubtType === 'counter' ? 1.5 : 1.0;
    const timer = setTimeout(() => {
      onTimeout(room);
    }, (room.rules.doubtTime || 5) * 1000 * factor);

    room.doubtTimerId = timer;
    return timer;
  }

  /**
   * Register a doubt declaration from a player.
   */
  static registerDoubt(room: Room, playerId: string): boolean {
    // Can't doubt your own cards
    if (playerId === room.field.lastPlayerId) return false;

    // Can't doubt if already declared
    if (room.doubtDeclarers.includes(playerId)) return false;

    // Can't doubt if out
    const player = room.players.find(p => p.id === playerId);
    if (!player || player.isOut) return false;

    room.doubtDeclarers.push(playerId);
    return true;
  }

  /**
   * Register a skip declaration from a player.
   */
  static registerSkip(room: Room, playerId: string): boolean {
    if (playerId === room.field.lastPlayerId) return false;

    const player = room.players.find(p => p.id === playerId);
    if (!player || player.isOut) return false;

    if (!room.doubtSkippers.includes(playerId)) {
      room.doubtSkippers.push(playerId);
    }

    const eligiblePlayersCount = room.players.filter(p => !p.isOut && p.id !== room.field.lastPlayerId).length;
    
    // If everyone who can doubt or skip has done so, return true to resolve early
    if (room.doubtSkippers.length + room.doubtDeclarers.length >= eligiblePlayersCount) {
      return true;
    }

    return false;
  }

  /**
   * Register a counter action (4-stop or Spade 3).
   */
  static registerCounter(room: Room, playerId: string): boolean {
    if (playerId === room.field.lastPlayerId) return false;
    
    room.field.counteredBy = playerId;
    return true;
  }

  /**
   * Resolve the doubt phase.
   * Returns the result of the doubt resolution.
   */
  static resolveDoubt(room: Room): DoubtResult {
    // Clear timer
    if (room.doubtTimerId) {
      clearTimeout(room.doubtTimerId);
      room.doubtTimerId = null;
    }

    // If it was countered, return counter result immediately
    if (room.field.counteredBy) {
      const countererId = room.field.counteredBy;
      const counterer = room.players.find(p => p.id === countererId)!;
      const lastPlayerId = room.field.lastPlayerId!;
      
      // counteredBy means counter was auto-accepted (used in some flows)
      // Cards were never revealed -> go to regular grave
      room.field.cardHistory.push(...room.field.currentCards);
      const revealedCards = [...room.field.currentCards];
      room.field.currentCards = [];

      return {
        type: 'counter',
        countererId,
        lastPlayerId,
        revealedCards,
        count: revealedCards.length,
      };
    }

    // No one doubted
    if (room.doubtDeclarers.length === 0) {
      if (room.field.doubtType === 'counter') {
        const countererId = room.field.lastPlayerId!;
        const lastPlayerId = room.rollbackState!.lastPlayerId!; // The one who played 8 or Joker
        
        // Phase 7: No doubt -> counter cards stay face-down -> regular grave
        room.field.cardHistory.push(...room.field.currentCards);
        const revealedCards = [...room.field.currentCards];
        room.field.currentCards = [];
        
        return {
          type: 'counter',
          countererId,
          lastPlayerId,
          revealedCards,
          count: revealedCards.length,
          wasRevealed: false, // Phase 7: track whether cards were revealed
        };
      }
      return { type: 'noDoubt' };
    }

    // Pick random doubter if multiple
    const doubterIdx = Math.floor(Math.random() * room.doubtDeclarers.length);
    const doubterId = room.doubtDeclarers[doubterIdx];
    const doubter = room.players.find(p => p.id === doubterId)!;

    const lastPlayerId = room.field.lastPlayerId!;
    const lastPlayer = room.players.find(p => p.id === lastPlayerId)!;

    // Check if the played cards match the declared number
    const declaredNumber = room.field.declaredNumber;
    const playedCards = room.field.currentCards;

    let wasLying = false;
    
    if (room.field.doubtType === 'counter') {
      if (declaredNumber === 4) {
        // Honest if all cards are 4
        wasLying = playedCards.some(c => c.number !== 4);
      } else if (declaredNumber === 3) {
        // Honest if exactly 1 Space 3
        wasLying = playedCards.length !== 1 || playedCards[0].suit !== 'spade' || playedCards[0].number !== 3;
      }
    } else {
      wasLying = playedCards.some(
        card => !card.isJoker && card.number !== declaredNumber
      );
    }

    if (wasLying) {
      // Doubt SUCCESS: the player was lying
      const revealedCards = [...room.field.currentCards];
      room.field.currentCards = [];
      
      // Phase 7/14: Doubted cards are revealed -> move to face-up graveyard (Requirement 4)
      // Liar's cards do NOT return to hand (Requirement 5)
      room.field.faceUpPool.push(...revealedCards);

      if (room.field.doubtType === 'counter') {
        // Phase 7: Counter was a lie -> cards handled by engine.ts (revealedCards -> faceUpPool)
        // Do NOT push here to avoid duplication.
      } else {
        // Normal doubt: cards will be returned to hand in GameEngine.handleDoubtResult
      }
      
      const penaltyCardCount = 0; // History is NOT taken
      // (The field rollback happens in GameEngine)

      // Reward: Doubter (winner) gives cards to Liar (loser)
      return {
        type: 'success',
        doubterId,
        liarId: lastPlayerId,
        revealedCards,
        penaltyCardCount,
        count: revealedCards.length,
      };
    } else {
      // Doubt FAILURE: the player was honest
      // Phase 14: Doubted cards are revealed -> move to face-up graveyard (Requirement 4)
      const revealedCards = [...room.field.currentCards];
      room.field.faceUpPool.push(...revealedCards);
      room.field.currentCards = []; // Remove from currentCards since they moved to grave


      // Penalty: Doubter (loser) loses a life. (Card history is no longer picked up).
      doubter.lives -= 1;
      const penaltyCardCount = 0;

      if (doubter.lives <= 0) {
        doubter.isOut = true;
      }

      // Reward: Honest Player (winner) gives cards to Doubter (loser)
      if (room.field.doubtType === 'counter') {
        const lastPlayerId = room.rollbackState!.lastPlayerId!; // the 8 or joker player
        return {
          type: 'counter',
          countererId: room.field.lastPlayerId!,
          lastPlayerId: lastPlayerId, // original player
          revealedCards,
          count: revealedCards.length,
          doubterId,
          wasRevealed: true, // Phase 7: cards were revealed by doubt
        };
      }

      return {
        type: 'failure',
        doubterId,
        honestPlayerId: room.field.lastPlayerId!,
        revealedCards,
        penaltyCardCount,
        count: revealedCards.length,
      };
    }
  }
}

export type DoubtResult =
  | { type: 'noDoubt' }
  | {
      type: 'counter';
      countererId: string;
      lastPlayerId: string; // original player who played 8 or joker
      revealedCards: Card[];
      count: number;
      doubterId?: string; // If it was doubted and was honest
      wasRevealed?: boolean; // Phase 7: whether the counter cards were revealed
    }
  | {
      type: 'success';
      doubterId: string;
      liarId: string;
      revealedCards: Card[];
      penaltyCardCount: number;
      count: number; // how many to give
    }
  | {
      type: 'failure';
      doubterId: string;
      honestPlayerId: string;
      revealedCards: Card[];
      penaltyCardCount: number;
      count: number; // how many to give
    };
