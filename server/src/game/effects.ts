import { Card, Room, PendingEffect } from './types';

/**
 * Apply card effects after cards are played.
 * Phase B: 8-cut, 9-reverse, revolution
 * Phase C: all other effects
 */
export function applyCardEffect(
  room: Room,
  playedCards: Card[],
  declaredNumber: number,
  playerId: string
): { shouldClearField: boolean; pendingEffect: PendingEffect | null; skipDoubt: boolean } {
  let shouldClearField = false;
  let pendingEffect: PendingEffect | null = null;
  let skipDoubt = false;

  // Revolution: 4+ cards of same number
  if (playedCards.length >= 4) {
    room.rules.isRevolution = !room.rules.isRevolution;
  }

  switch (declaredNumber) {
    case 8:
      // 8切り: normally clears field, but we allow doubt/counter phase
      shouldClearField = true;
      skipDoubt = false; // Allow a window for "4-counter"
      break;

    case 9:
      // 9リバース: reverse direction
      room.rules.direction = (room.rules.direction === 1 ? -1 : 1) as 1 | -1;
      break;

    case 5:
      // 5スキ: skip next N players
      // If all other active players are skipped (loop back to self), clear field
      if (applySkipAndCheckLoop(room, playerId, playedCards.length)) {
        shouldClearField = true;
        skipDoubt = false;
      }
      break;

    case 11:
      // 11バック: enable eleven-back until field is cleared
      room.rules.isElevenBack = true;
      break;

    case 7:
      // 7渡し: player must pass N cards to next player
      pendingEffect = {
        type: 'sevenPass',
        playerId: playerId,
        count: playedCards.length,
      };
      break;

    case 6:
      // 回収: player collects N cards from faceUpPool (Face-up Grave)
      // But NOT if this is the player's last play (finishing move)
      if (room.field.faceUpPool.length > 0) {
        const sixPlayer = room.players.find(p => p.id === playerId);
        if (sixPlayer && sixPlayer.hand.length > 0) {
          pendingEffect = {
            type: 'sixCollect',
            playerId: playerId,
            count: Math.min(playedCards.length, room.field.faceUpPool.length),
          };
        }
      }
      break;

    case 10:
      // 10捨て札: player chooses cards to discard (can be doubted)
      pendingEffect = {
        type: 'tenDiscard',
        playerId: playerId,
        count: playedCards.length,
      };
      break;

    case 12:
      // Qボンバー: specify N numbers (only if field has been cleared at least once)
      if (room.field.hasFieldCleared) {
        pendingEffect = {
          type: 'queenBomber',
          playerId: playerId,
          count: playedCards.length,
        };
      }
      break;
  }

  return { shouldClearField, pendingEffect, skipDoubt };
}

/**
 * Apply skip and check if all other active players are skipped (loop back).
 * Returns true if the skip loops back to the player who played 5.
 */
function applySkipAndCheckLoop(room: Room, playerId: string, count: number): boolean {
  const playerIdx = room.turnOrder.indexOf(playerId);
  const dir = room.rules.direction;
  const total = room.turnOrder.length;
  let currentIdx = playerIdx;
  let skippedCount = 0;
  
  while (skippedCount < count) {
    currentIdx = ((currentIdx + dir) % total + total) % total;
    const skipPlayerId = room.turnOrder[currentIdx];
    
    // Stop if we looped back to the original player (safety)
    if (skipPlayerId === playerId) break;

    const player = room.players.find(p => p.id === skipPlayerId);
    if (player && !player.isOut) {
      player.isSkipped = true;
      skippedCount++;
    }
  }

  // Check if all other active players are now skipped
  const otherActivePlayers = room.players.filter(p => !p.isOut && p.id !== playerId);
  const allSkipped = otherActivePlayers.length > 0 && otherActivePlayers.every(p => p.isSkipped);
  return allSkipped;
}

/**
 * Move cards to the appropriate graveyard based on their isFaceUp status.
 * Ensures that card IDs are unique and removed from other field arrays first.
 */
export function moveCardsToGrave(room: Room, cards: Card[]): void {
  for (const card of cards) {
    // Remove from existing field/grave arrays to prevent duplication
    room.field.currentCards = room.field.currentCards.filter(c => c.id !== card.id);
    room.field.cardHistory = room.field.cardHistory.filter(c => c.id !== card.id);
    room.field.faceUpPool = room.field.faceUpPool.filter(c => c.id !== card.id);

    if (card.isFaceUp) {
      room.field.faceUpPool.push(card);
    } else {
      room.field.cardHistory.push(card);
    }
  }
}

/**
 * Clear field and reset eleven-back.
 * Cards go to appropriate grave based on their revealed status.
 */
export function clearField(room: Room): void {
  // Move current cards to appropriate grave
  const cardsToClear = [...room.field.currentCards];
  room.field.currentCards = []; // Clear field first
  moveCardsToGrave(room, cardsToClear);

  // Also move any revealed cards in history to face-up pool (Phase 14 fix)
  // Ensure we don't duplicate them in faceUpPool
  const revealedInHistory = room.field.cardHistory.filter(c => c.isFaceUp);
  for (const card of revealedInHistory) {
    if (!room.field.faceUpPool.some(c => c.id === card.id)) {
      room.field.faceUpPool.push(card);
    }
  }
  room.field.cardHistory = room.field.cardHistory.filter(c => !c.isFaceUp);
  
  room.field.declaredNumber = 0;
  room.field.lastPlayerId = null;
  room.field.doubtType = null;
  room.field.hasFieldCleared = true;
  room.passCount = 0;

  // Reset eleven-back when field is cleared
  room.rules.isElevenBack = false;

  // Reset skip flags
  room.players.forEach(p => { p.isSkipped = false; });
}
