import {
  Room, Player, Card, FieldState, RulesState, GamePhase,
  ClientGameState, ClientPlayer, ClientFieldState, PendingEffect
} from './types';
import { createDeck, shuffleDeck, dealCards } from './deck';
import { validatePlayCards, checkForbiddenFinish } from './validator';
import { applyCardEffect, clearField } from './effects';
import { DoubtManager, DoubtResult } from './doubt';

export class GameEngine {
  /**
   * Initialize a new game in the room.
   */
  static startGame(room: Room, settings?: { doubtTime: number }): void {
    const deck = shuffleDeck(createDeck());
    const hands = dealCards(deck, room.players.length);

    room.players.forEach((player, i) => {
      player.hand = hands[i];
      player.lives = 3;
      player.rank = null;
      player.isSkipped = false;
      player.isOut = false;
    });

    room.phase = 'playing';
    room.field = {
      currentCards: [],
      declaredNumber: 0,
      cardHistory: [],
      faceUpPool: [],
      lastPlayerId: null,
      doubtType: null,
      counteredBy: null,
    };
    room.rules = {
      direction: 1,
      isRevolution: false,
      isElevenBack: false,
      doubtTime: settings?.doubtTime || room.rules?.doubtTime || 5,
    };
    room.currentPlayerIndex = Math.floor(Math.random() * room.players.length);
    room.turnOrder = room.players.map(p => p.id);
    room.finishOrder = [];
    room.doubtDeclarers = [];
    room.doubtSkippers = [];
    room.pendingEffect = null;
    room.deferredEffect = null;
    room.doubtTimerId = null;
    room.logs = []; // Initialize logs
  }

  /**
   * Play cards from a player's hand.
   */
  static playCards(
    room: Room,
    playerId: string,
    cardIds: string[],
    declaredNumber: number
  ): { success: boolean; error?: string; skipDoubt?: boolean } {
    const player = room.players.find(p => p.id === playerId);
    if (!player) return { success: false, error: 'プレイヤーが見つかりません' };

    // Must be this player's turn
    const currentPlayerId = room.turnOrder[room.currentPlayerIndex];
    if (playerId !== currentPlayerId) {
      return { success: false, error: 'あなたのターンではありません' };
    }

    if (room.phase !== 'playing') {
      return { success: false, error: '現在は通常のカード出しはできません（カウンターやダウトのフェーズ中です）' };
    }

    // Find cards in hand
    const cards: Card[] = [];
    for (const cid of cardIds) {
      const card = player.hand.find(c => c.id === cid);
      if (!card) return { success: false, error: '手札にないカードが指定されました' };
      cards.push(card);
    }

    // Validate
    const validation = validatePlayCards(
      cards, 
      declaredNumber, 
      { 
        currentCardCount: room.field.currentCards.length, 
        declaredNumber: room.field.declaredNumber,
        lastPlayerId: room.field.lastPlayerId
      },
      room.rules
    );
    if (!validation.valid) {
      return { success: false, error: validation.reason };
    }

    // Save previous state for rollback
    room.rollbackState = {
      currentCards: [...room.field.currentCards],
      declaredNumber: room.field.declaredNumber,
      lastPlayerId: room.field.lastPlayerId,
      doubtType: room.field.doubtType,
      rules: { ...room.rules },
      skippedPlayerIds: room.players.filter(p => p.isSkipped).map(p => p.id),
    };

    // Remove cards from hand
    player.hand = player.hand.filter(c => !cardIds.includes(c.id));

    room.field.currentCards = cards;
    room.field.declaredNumber = declaredNumber;
    room.field.lastPlayerId = playerId;
    room.field.doubtType = 'play';
    room.field.counteredBy = null;

    GameEngine.addLog(room, 'play', playerId, { declaredNumber, cardCount: cards.length });

    // Apply card effects
    const effectResult = applyCardEffect(room, cards, declaredNumber, playerId);

    // If it's Queen (12), move to Effect Phase BEFORE Doubt Phase
    // to ask for numbers first.
    if (declaredNumber === 12 && effectResult.pendingEffect) {
      room.pendingEffect = effectResult.pendingEffect;
      room.phase = 'effectPhase';
      return { success: true, skipDoubt: true };
    }

    if (room.rules.isRevolution !== (room.rules.isRevolution)) { // This is a bit tricky since applyCardEffect modifies it. 
      // Actually, applyCardEffect modifies room.rules directly.
    }
    // We should check if revolution status changed. 
    // For simplicity, let's just log if the played cards trigger a revolution.
    if (cards.length >= 4) {
      GameEngine.addLog(room, 'revolution', playerId);
    }

    if (effectResult.pendingEffect) {
      // Defer 7-pass and 10-discard effects until after doubt phase resolves
      // (so InteractionModal doesn't appear before doubt confirmation)
      room.deferredEffect = effectResult.pendingEffect;
    }

    // Check win condition
    if (player.hand.length === 0) {
      const isForbidden = checkForbiddenFinish(
        declaredNumber,
        cards,
        room.rules.isRevolution
      );

      if (isForbidden) {
        // Forbidden finish: player is eliminated
        player.isOut = true;
        player.rank = -1; // marked as last
      } else {
        // Legal finish
        room.finishOrder.push(playerId);
        player.rank = room.finishOrder.length;
        player.isOut = true; // out of the game (finished)
      }

      // Check if game is over
      const activePlayers = room.players.filter(p => !p.isOut);
      if (activePlayers.length <= 1) {
        if (activePlayers.length === 1) {
          // Last player remaining gets their rank
          const lastPlayer = activePlayers[0];
          room.finishOrder.push(lastPlayer.id);
          lastPlayer.rank = room.finishOrder.length;
        }
        room.phase = 'result';
        return { success: true, skipDoubt: true };
      }
    }

    // Check if doubt should be skipped based on effect (though updated to false for 8 now)
    if (effectResult.shouldClearField && effectResult.skipDoubt) {
      clearField(room);
      return { success: true, skipDoubt: true };
    }

    // Normal play, transitions to doubt phase in handlers
    room.phase = 'doubtPhase';
    return { success: true, skipDoubt: false };
  }

  /**
   * Pass the current turn.
   */
  static passTurn(room: Room, playerId: string): { success: boolean; error?: string } {
    const currentPlayerId = room.turnOrder[room.currentPlayerIndex];
    if (playerId !== currentPlayerId) {
      return { success: false, error: 'あなたのターンではありません' };
    }

    if (room.phase !== 'playing') {
      return { success: false, error: '現在パスできません' };
    }

    if (room.field.currentCards.length === 0) {
      return { success: false, error: '場が流れた後は必ずカードを出してください' };
    }

    GameEngine.addLog(room, 'pass', playerId);

    const oldIndex = room.currentPlayerIndex;
    const dir = room.rules.direction;
    const total = room.turnOrder.length;

    this.advanceTurn(room);
    
    const newIndex = room.currentPlayerIndex;
    const lastPlayerIdx = room.turnOrder.indexOf(room.field.lastPlayerId!);

    // Calculate distance in direction of play
    const getDist = (from: number, to: number) => {
      if (from === to) return 0;
      let dist = 0;
      let curr = from;
      while (curr !== to) {
        curr = ((curr + dir) % total + total) % total;
        dist++;
        if (dist > total) break; // safety
      }
      return dist;
    };

    const distToLast = getDist(oldIndex, lastPlayerIdx);
    const distToNew = getDist(oldIndex, newIndex);

    // If we reached or crossed the lastPlayerId during advanceTurn, the field clears!
    // This elegantly handles when lastPlayerId is 'out' or 'skipped' and their turn is bypassed.
    if (distToLast > 0 && distToLast <= distToNew) {
      clearField(room);
    }

    return { success: true };
  }

  /**
   * Advance to the next active player.
   */
  static advanceTurn(room: Room): void {
    const total = room.turnOrder.length;
    let attempts = 0;

    do {
      room.currentPlayerIndex = ((room.currentPlayerIndex + room.rules.direction) % total + total) % total;
      attempts++;
      if (attempts > total) break; // safety

      const nextPlayer = room.players.find(p => p.id === room.turnOrder[room.currentPlayerIndex]);
      if (!nextPlayer) continue;

      // Skip eliminated players
      if (nextPlayer.isOut) continue;

      // Skip players marked as skipped
      if (nextPlayer.isSkipped) {
        nextPlayer.isSkipped = false;
        continue;
      }

      break;
    } while (true);
  }

  /**
   * Handle doubt resolution effects on game state.
   */
  static handleDoubtResult(room: Room, result: DoubtResult): void {
    if (result.type === 'counter') {
      GameEngine.addLog(room, 'counter', result.countererId, { revealedCards: result.revealedCards });

      if (result.doubterId) {
        GameEngine.addLog(room, 'doubtFailure', result.doubterId, { revealedCards: result.revealedCards });
      }
      
      // Special Rule: Spade 3 Reversal
      // Note: doubt.ts already clears currentCards, so we use rollbackState + revealedCards
      const isSpade3Revenge = 
        room.rollbackState &&
        room.rollbackState.declaredNumber === 0 && 
        room.rollbackState.currentCards.length === 1 &&
        result.revealedCards.some(c => c.suit === 'spade' && c.number === 3);

      if (isSpade3Revenge) {
        GameEngine.addLog(room, 'revenge', result.countererId);

        // Phase 7: Route rollback cards (Joker) to appropriate graveyard
        // Joker was played face-down initially, so it goes to regular grave
        if (room.rollbackState) {
          room.field.cardHistory.push(...room.rollbackState.currentCards);
        }
        
        // Reset field manually (clearField would try to move empty currentCards)
        room.field.currentCards = [];
        room.field.declaredNumber = 0;
        room.field.lastPlayerId = null;
        room.field.doubtType = null;
        room.rules.isElevenBack = false;
        room.players.forEach(p => { p.isSkipped = false; });
        
        // Turn moves to counterer
        room.currentPlayerIndex = room.turnOrder.indexOf(result.countererId);

        // Phase 12: If doubt was attempted and failed, allow counter-player to give cards
        if (result.doubterId) {
          room.pendingEffect = {
            type: 'doubtCardSelect',
            playerId: result.countererId,
            count: result.count,
            targetPlayerId: result.doubterId,
          };
          room.phase = 'effectPhase';
        } else {
          room.phase = 'playing';
        }
        return;
      }

      // Default Counter Effect (e.g. 4-stop)
      // Phase 7: Route rollback cards (the original 8s) to appropriate graveyard
      // Original 8s were played face-down and never revealed -> regular grave
      if (room.rollbackState) {
        room.field.cardHistory.push(...room.rollbackState.currentCards);
      }
      
      // Reset field manually
      room.field.currentCards = [];
      room.field.declaredNumber = 0;
      room.field.lastPlayerId = null;
      room.field.doubtType = null;
      room.rules.isElevenBack = false;
      room.players.forEach(p => { p.isSkipped = false; });
      
      // Set current player to the one who countered
      const countererIdx = room.turnOrder.indexOf(result.countererId);
      if (countererIdx !== -1) {
        room.currentPlayerIndex = countererIdx;
      }

      // Phase 12: If doubt was attempted and failed, allow counter-player to give cards
      if (result.doubterId) {
        room.pendingEffect = {
          type: 'doubtCardSelect',
          playerId: result.countererId,
          count: result.count,
          targetPlayerId: result.doubterId,
        };
        room.phase = 'effectPhase';
      } else {
        room.phase = 'playing';
      }
      return;
    } else if (result.type === 'success') {
      GameEngine.addLog(room, 'doubtSuccess', result.doubterId, { revealedCards: result.revealedCards });
      
      // Move the liar's revealed cards to face-up graveyard (NOT back to hand)
      room.field.faceUpPool.push(...result.revealedCards);

      // Rollback: return previous field state
      let wasCounterFail = false;
      if (room.rollbackState) {
        if (room.field.doubtType === 'counter') {
          wasCounterFail = true;
        }
        room.field.currentCards = room.rollbackState.currentCards;
        room.field.declaredNumber = room.rollbackState.declaredNumber;
        room.field.lastPlayerId = room.rollbackState.lastPlayerId;
        room.field.doubtType = room.rollbackState.doubtType || null; 
        
        if (room.rollbackState.rules) {
          room.rules = { ...room.rollbackState.rules };
        }
        if (room.rollbackState.skippedPlayerIds) {
          room.players.forEach(p => {
            p.isSkipped = room.rollbackState!.skippedPlayerIds.includes(p.id);
          });
        }

        // Phase 4: Q-Bomber lied -> Do NOT destroy cards
        if (room.rollbackState.declaredNumber === 12) {
          room.field.pendingNumbers = undefined;
        }
      }

      // Cancel any deferred effect (the play was a lie, so no effect should occur)
      room.deferredEffect = null;

      // Reward: Doubter (winner) gives 0-N cards to Liar (loser)
      room.pendingEffect = {
        type: 'doubtCardSelect',
        playerId: result.doubterId,
        count: result.count,
        targetPlayerId: result.liarId,
        isFromDoubtSuccess: true,
      };
      
      // Note: We do NOT set liar.isSkipped = true.
      // Setting isSkipped would penalize them by skipping their *next* turn as well.

      room.phase = 'effectPhase';
    } else if (result.type === 'failure') {
      GameEngine.addLog(room, 'doubtFailure', result.doubterId, { revealedCards: result.revealedCards });
      // Doubt failed (player was honest)
      
      const lastPlayer = room.players.find(p => p.id === result.honestPlayerId)!;

      // The cards were honestly played, so previous cards go to history
      if (room.rollbackState && room.rollbackState.currentCards.length > 0) {
        room.field.cardHistory.push(...room.rollbackState.currentCards);
      }

      // Reward: Honest player (winner) gives N cards to Doubter (loser)
      room.pendingEffect = {
        type: 'doubtCardSelect',
        playerId: result.honestPlayerId,
        count: result.count,
        targetPlayerId: result.doubterId,
      };

        // Phase 6: Q-Bomber honest -> Execute bomb destruction NOW, before card select
      if (room.field.declaredNumber === 12 && room.field.pendingNumbers) {
        const numbers = room.field.pendingNumbers;
        for (const p of room.players) {
          if (p.isOut) continue;
          const toDiscard = p.hand.filter(c =>
            numbers.includes(c.number) || (numbers.includes(0) && c.isJoker)
          );
          p.hand = p.hand.filter(c => !toDiscard.some(d => d.id === c.id));
          room.field.cardHistory.push(...toDiscard);
        }
        GameEngine.addLog(room, 'queenBomber', result.honestPlayerId, { targetNumbers: numbers });
        
        GameEngine.checkBombVictories(room);
        if (room.phase === 'result') return;

        // Can only give "non-destroyed" cards
        (room.pendingEffect as any).excludedNumbers = [...numbers];
        room.field.pendingNumbers = undefined;
      }

      // Check if game should end (doubter might be out due to life loss)
      const activePlayers = room.players.filter(p => !p.isOut);
      if (activePlayers.length <= 1) {
        room.phase = 'result';
        if (activePlayers.length === 1) {
          room.finishOrder.push(activePlayers[0].id);
          activePlayers[0].rank = room.finishOrder.length;
        }
      } else {
        // Tag pendingEffect to check if we should enter counterPhase AFTER penalty
        const shouldEnterCounterPhase = 
          ((room.field.declaredNumber === 8) || 
           (room.field.declaredNumber === 0 && room.field.currentCards.length === 1));
        
        if (shouldEnterCounterPhase) {
          (room.pendingEffect as any).startCounterPhaseAfter = true;
        }
        
        room.phase = 'effectPhase';
      }
    } else {
      // No doubt
      // The cards were accepted, so previous cards go to history
      if (room.rollbackState && room.rollbackState.currentCards.length > 0) {
        room.field.cardHistory.push(...room.rollbackState.currentCards);
      }

      // Check for 4-stop (8-cut survived) or Spade 3 (single Joker survived)
      // Only enter counter phase if we are not ALREADY finishing the counter phase!
      // (If room.phase is 'counterPhase', it means the counter phase itself just finished with no counters declared)
      const shouldEnterCounterPhase = 
        room.phase !== 'counterPhase' &&
        ((room.field.declaredNumber === 8) || 
         (room.field.declaredNumber === 0 && room.field.currentCards.length === 1));

      if (shouldEnterCounterPhase) {
        GameEngine.startCounterPhase(room);
        return;
      }

      // Promote deferred effect (7-pass, 10-discard) now that doubt resolved with no doubt
      if (room.deferredEffect) {
        room.pendingEffect = room.deferredEffect;
        room.deferredEffect = null;
        room.phase = 'effectPhase';
      } else if (room.pendingEffect) {
        room.phase = 'effectPhase';
      } else {
        // If it was a 10-discard without doubt, cards go to regular grave
        if (room.field.doubtType === 'discard') {
          room.field.cardHistory.push(...room.field.currentCards);
          room.field.currentCards = [];
        }
        
        // Handle normal 8-cut if it didn't enter counter phase
        if (room.field.declaredNumber === 8) {
          GameEngine.addLog(room, 'eightCut', room.field.lastPlayerId!);
          clearField(room);
          room.phase = 'playing';
          // (advanceTurn is NOT called, person who played 8 plays again)
        } else if (room.field.declaredNumber === 12 && room.field.pendingNumbers) {
          // Q-bomber survive doubt -> apply bomb
          const numbers = room.field.pendingNumbers;
          for (const p of room.players) {
            if (p.isOut) continue;
            const toDiscard = p.hand.filter(c =>
              numbers.includes(c.number) || (numbers.includes(0) && c.isJoker)
            );
            p.hand = p.hand.filter(c => !toDiscard.some(d => d.id === c.id));
            room.field.cardHistory.push(...toDiscard);
          }
          GameEngine.addLog(room, 'queenBomber', room.field.lastPlayerId!, { targetNumbers: numbers });

          GameEngine.checkBombVictories(room);
          if (room.phase === 'result') return;

          room.field.pendingNumbers = undefined;
          room.phase = 'playing';
          GameEngine.advanceTurn(room);
        } else {
          room.phase = 'playing';
          GameEngine.advanceTurn(room);
        }
      }
    }
  }

  static startCounterPhase(room: Room): void {
    room.phase = 'counterPhase';
    room.doubtDeclarers = [];
    room.doubtSkippers = [];
    room.field.counteredBy = null;
  }

  /**
   * Handle counter action (4-stop or Spade 3).
   */
  static declareCounter(room: Room, playerId: string, cardIds: string[]): { success: boolean; error?: string } {
    if (room.phase !== 'counterPhase') return { success: false, error: '現在はカウンターできません' };
    
    const player = room.players.find(p => p.id === playerId);
    if (!player) return { success: false, error: 'プレイヤーが見つかりません' };

    const cards = player.hand.filter(c => cardIds.includes(c.id));
    if (cards.length !== cardIds.length || cards.length === 0) return { success: false, error: '無効なカードが含まれています' };

    let counterDeclaredNumber = 0;
    
    // 4-stop
    if (room.field.declaredNumber === 8) {
      if (cards.length !== room.field.currentCards.length + 1) {
        return { success: false, error: `4止めには ${room.field.currentCards.length + 1}枚のカードが必要です` };
      }
      counterDeclaredNumber = 4;
    }
    // Spade 3
    else if (room.field.declaredNumber === 0 && room.field.currentCards.length === 1) {
      if (cards.length !== 1) {
        return { success: false, error: 'スペ3返しには 1枚のカードが必要です' };
      }
      counterDeclaredNumber = 3;
    } else {
      return { success: false, error: 'カウンターの対象がありません' };
    }

    // Save previous state for doubt
    room.rollbackState = {
      currentCards: [...room.field.currentCards], // 8 or Joker
      declaredNumber: room.field.declaredNumber,  // 8 or 0
      lastPlayerId: room.field.lastPlayerId,
      doubtType: room.field.doubtType,
      rules: { ...room.rules },
      skippedPlayerIds: room.players.filter(p => p.isSkipped).map(p => p.id),
    };

    // Remove cards from player hand
    player.hand = player.hand.filter(c => !cardIds.includes(c.id));

    // The counter cards become the new current cards to be doubted
    room.field.currentCards = cards;
    room.field.declaredNumber = counterDeclaredNumber; // 4 or 3
    room.field.lastPlayerId = playerId;
    room.field.doubtType = 'counter';
    room.phase = 'doubtPhase';

    // Start doubt phase immediately handled by handlers.ts
    // We only log the play action. Note: 'counter' action will be logged upon successful resolve.
    GameEngine.addLog(room, 'play', playerId, { declaredNumber: counterDeclaredNumber, cardCount: cards.length });

    return { success: true };
  }

  /**
   * Handle effect actions (7-pass, 6-collect, etc.)
   */
  static handleEffectAction(
    room: Room,
    playerId: string,
    cardIds: string[],
    targetData?: { numbers?: number[] }
  ): { success: boolean; error?: string } {
    const effect = room.pendingEffect;
    if (!effect) return { success: false, error: '保留中の効果がありません' };
    if (effect.playerId !== playerId) return { success: false, error: 'この効果のアクション権限がありません' };

    const player = room.players.find(p => p.id === playerId);
    if (!player) return { success: false, error: 'プレイヤーが見つかりません' };

    switch (effect.type) {
      case 'sevenPass': {
        // Pass selected cards to next player
        if (cardIds.length > effect.count) {
          return { success: false, error: `最大${effect.count}枚まで選択可能です` };
        }
        if (cardIds.length === 0) break;
        const cardsToPass: Card[] = [];
        for (const cid of cardIds) {
          const card = player.hand.find(c => c.id === cid);
          if (!card) return { success: false, error: '手札にないカードです' };
          cardsToPass.push(card);
        }
        player.hand = player.hand.filter(c => !cardIds.includes(c.id));

        // Find next ACTIVE player
        let nextIdx = room.turnOrder.indexOf(playerId);
        let nextPlayer;
        do {
          nextIdx = ((nextIdx + room.rules.direction) % room.turnOrder.length + room.turnOrder.length) % room.turnOrder.length;
          nextPlayer = room.players.find(p => p.id === room.turnOrder[nextIdx]);
          if (nextPlayer && !nextPlayer.isOut) break;
        } while (nextIdx !== room.turnOrder.indexOf(playerId));
        
        if (nextPlayer && !nextPlayer.isOut) {
          nextPlayer.hand.push(...cardsToPass);
          GameEngine.addLog(room, 'sevenPass', playerId, { 
            cardCount: cardsToPass.length, 
            targetPlayerName: nextPlayer.name 
          });
        }
        break;
      }

      case 'sixCollect': {
        // Collect cards from face-up pool
        if (cardIds.length > effect.count) {
          return { success: false, error: `最大${effect.count}枚まで選択可能です` };
        }
        if (cardIds.length === 0) break;
        for (const cid of cardIds) {
          const idx = room.field.faceUpPool.findIndex(c => c.id === cid);
          if (idx === -1) return { success: false, error: '表向きカードにないカードです' };
          player.hand.push(room.field.faceUpPool[idx]);
          room.field.faceUpPool.splice(idx, 1);
        }
        GameEngine.addLog(room, 'sixCollect', playerId, { cardCount: cardIds.length });
        break;
      }

      case 'tenDiscard': {
        if (cardIds.length > effect.count) {
          return { success: false, error: `最大${effect.count}枚まで選択可能です` };
        }
        if (cardIds.length === 0) break;

        const cardsToDiscard: Card[] = [];
        for (const cid of cardIds) {
          const card = player.hand.find(c => c.id === cid);
          if (!card) return { success: false, error: '手札にないカードです' };
          cardsToDiscard.push(card);
        }
        player.hand = player.hand.filter(c => !cardIds.includes(c.id));
        
        GameEngine.addLog(room, 'discard', playerId, { cardCount: cardsToDiscard.length });
        room.field.cardHistory.push(...cardsToDiscard);
        
        break;
      }

      case 'queenBomber': {
        // Just store numbers and move to doubt phase. The actual bomb happens after doubt.
        const numbers = targetData?.numbers || [];
        if (numbers.length > effect.count) {
          return { success: false, error: `最大${effect.count}個まで選択可能です` };
        }
        if (numbers.length === 0) break;
        
        room.field.pendingNumbers = numbers;
        room.pendingEffect = null;
        room.phase = 'doubtPhase'; // Start doubt window for Q-play

        return { success: true };
      }

      case 'doubtCardSelect': {
        // Winner gives cards to Loser
        if (cardIds.length > effect.count) {
          return { success: false, error: `最大${effect.count}枚まで選択可能です` };
        }
        if (cardIds.length === 0) break;
        const targetPlayer = room.players.find(p => p.id === effect.targetPlayerId);
        if (!targetPlayer) return { success: false, error: '対象プレイヤーが見つかりません' };

        for (const cid of cardIds) {
          const cardIdx = player.hand.findIndex(c => c.id === cid);
          if (cardIdx === -1) return { success: false, error: '自分の手札にないカードです' };
          const [card] = player.hand.splice(cardIdx, 1);
          targetPlayer.hand.push(card);
        }
        GameEngine.addLog(room, 'doubtCardSelect', playerId, { 
          cardCount: cardIds.length, 
          targetPlayerName: targetPlayer.name 
        });
        break;
      }

      default:
        return { success: false, error: '未対応の効果です' };
    }

    room.pendingEffect = null;
    room.phase = 'playing';

    // Check if the player who used the effect just went out
    if (player.hand.length === 0 && !player.isOut) {
      room.finishOrder.push(player.id);
      player.rank = room.finishOrder.length;
      player.isOut = true;

      const activePlayers = room.players.filter(p => !p.isOut);
      if (activePlayers.length <= 1) {
        if (activePlayers.length === 1) {
          const lastPlayer = activePlayers[0];
          lastPlayer.isOut = true;
          room.finishOrder.push(lastPlayer.id);
          lastPlayer.rank = room.finishOrder.length;
        }
        room.phase = 'result';
        return { success: true };
      }
    }
    
    // If tagged to start counter phase after penalty (e.g. honest 8-cut was doubted)
    const clearAfter = (effect as any).clearFieldAfter;
    const startCounter = (effect as any).startCounterPhaseAfter;

    if (startCounter) {
      GameEngine.startCounterPhase(room);
      return { success: true };
    }

    if (clearAfter) { // Legacy flag, just in case
        clearField(room);
    }
    
    // Phase 6 fix: Advance turn for all effect types EXCEPT queenBomber 
    // (which transitions to doubtPhase instead of ending the turn).
    // queenBomber returns early above, so this covers all remaining types.
    GameEngine.advanceTurn(room);
    
    return { success: true };
  }

  /**
   * Build sanitized game state for a specific player.
   */
  static getClientState(room: Room, playerId: string): ClientGameState {
    const player = room.players.find(p => p.id === playerId);

    return {
      roomId: room.id,
      hostId: room.hostId,
      phase: room.phase,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        lives: p.lives,
        rank: p.rank,
        isSkipped: p.isSkipped,
        isOut: p.isOut,
        isCurrentTurn: room.turnOrder[room.currentPlayerIndex] === p.id,
      })),
      field: {
        currentCardCount: room.field.currentCards.length,
        declaredNumber: room.field.declaredNumber,
        cardHistoryCount: room.field.cardHistory.length,
        faceUpPool: room.field.faceUpPool,
        lastPlayerId: room.field.lastPlayerId,
        doubtType: room.field.doubtType,
        counteredBy: room.field.counteredBy,
      },
      rules: { ...room.rules },
      currentPlayerId: room.turnOrder[room.currentPlayerIndex],
      myHand: player ? [...player.hand] : [],
      pendingEffect: room.pendingEffect,
      finishOrder: [...room.finishOrder],
      logs: room.logs || [],
    };
  }

  /**
   * Helper to append a game log entry.
   */
  static addLog(
    room: Room,
    action: import('./types').LogAction,
    playerId: string,
    details?: { 
      declaredNumber?: number; 
      cardCount?: number; 
      revealedCards?: Card[];
      targetPlayerName?: string;
      targetNumbers?: number[];
    }
  ): void {
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    
    if (!room.logs) room.logs = [];
    room.logs.push({
      id: Math.random().toString(36).substring(2, 9),
      timestamp: Date.now(),
      action,
      playerId,
      playerName: player.name,
      ...details,
    });
    
    if (room.logs.length > 100) {
      room.logs.shift();
    }
  }

  /**
   * Check for players who reached 0 cards due to Q-Bomber.
   * Assigns them the SAME rank if multiple players reach 0 at once.
   */
  static checkBombVictories(room: Room): void {
    const newlyFinished = room.players.filter(p => !p.isOut && p.hand.length === 0);
    if (newlyFinished.length === 0) return;

    const rankToAssign = room.finishOrder.length + 1;
    for (const player of newlyFinished) {
      player.isOut = true;
      player.rank = rankToAssign;
      room.finishOrder.push(player.id);
    }

    const activePlayers = room.players.filter(p => !p.isOut);
    if (activePlayers.length <= 1) {
      room.phase = 'result';
      if (activePlayers.length === 1) {
        // Last player gets remaining rank
        const lastPlayer = activePlayers[0];
        lastPlayer.isOut = true;
        room.finishOrder.push(lastPlayer.id);
        lastPlayer.rank = room.finishOrder.length;
      }
    }
  }
}
