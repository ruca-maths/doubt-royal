import {
  Room, Player, Card, FieldState, RulesState, GamePhase,
  ClientGameState, ClientPlayer, ClientFieldState, PendingEffect
} from './types';
import { createDeck, shuffleDeck, dealCards } from './deck';
import { validatePlayCards, checkForbiddenFinish } from './validator';
import { applyCardEffect, clearField, moveCardsToGrave } from './effects';
import { DoubtManager, DoubtResult } from './doubt';
import { AIEngine } from './ai';

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

    AIEngine.clearThinkingPlayers();

    room.phase = 'playing';
    room.field = {
      currentCards: [],
      declaredNumber: 0,
      cardHistory: [],
      faceUpPool: [],
      lastPlayerId: null,
      doubtType: null,
      counteredBy: null,
      hasFieldCleared: false,
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
    room.pendingFinishPlayerId = null;
    room.passCount = 0;
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
    room.passCount = 0; // Reset pass count on play


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

    // Mark that this player MAY be finishing (hand is empty)
    // Actual win/forbidden-finish is resolved AFTER doubt phase
    // so that a liar can be caught before winning.
    if (player.hand.length === 0) {
      room.pendingFinishPlayerId = playerId;
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

    if (room.field.lastPlayerId === null) {
      return { success: false, error: '場が流れた後は必ずカードを出してください' };
    }

    room.passCount++;

    // Add pass turn log
    GameEngine.addLog(room, 'pass', playerId);
    
    // Safety check for next turn
    console.log(`[PassTurn] Player ${playerId} passed. Advance...`);
    this.advanceTurn(room);
    return { success: true };
  }

  /**
   * Advance to the next active player.
   */
  static advanceTurn(room: Room): void {
    const total = room.turnOrder.length;
    let attempts = 0;

    console.log(`[Turn Advance] CurrentIndex ${room.currentPlayerIndex} -> Looking for next...`);
    do {
      room.currentPlayerIndex = ((room.currentPlayerIndex + room.rules.direction) % total + total) % total;
      attempts++;
      if (attempts > total) break; // safety

      const nextPlayer = room.players.find(p => p.id === room.turnOrder[room.currentPlayerIndex]);
      if (!nextPlayer) continue;

      if (nextPlayer.isOut) {
        console.log(`[Turn Advance] Skip ${nextPlayer.name} (isOut)`);
        continue;
      }
      if (nextPlayer.isSkipped) {
        console.log(`[Turn Advance] Skip ${nextPlayer.name} (isSkipped)`);
        nextPlayer.isSkipped = false;
        continue;
      }

      console.log(`[Turn Advance] Next turn is ${nextPlayer.name} (ID: ${nextPlayer.id})`);
      break;
    } while (true);

    const activePlayers = room.players.filter(p => !p.isOut);
    const nextPlayerId = room.turnOrder[room.currentPlayerIndex];
    const isBackToLastPlayer = room.field.lastPlayerId && nextPlayerId === room.field.lastPlayerId;
    const isEveryonePassed = room.passCount >= activePlayers.length - 1 && room.field.lastPlayerId !== null;

    if (isBackToLastPlayer || isEveryonePassed) {
      console.log(`[Field Clear] Reason: ${isBackToLastPlayer ? 'BackToLead' : 'EveryonePassed'}`);
      clearField(room);
      room.passCount = 0;
    }
  }

  /**
   * Handle doubt resolution effects on game state.
   */
  static handleDoubtResult(room: Room, result: DoubtResult): void {
    if (result.type === 'counter') {
      room.passCount = 0;
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
          moveCardsToGrave(room, room.rollbackState.currentCards);
        }
        
        clearField(room);
        
        // Turn moves to counterer
        room.currentPlayerIndex = room.turnOrder.indexOf(result.countererId);

        // Phase 12: If doubt was attempted and failed, allow counter-player to give cards
        if (result.doubterId) {
          room.pendingEffect = {
            type: 'doubtCardSelect',
            playerId: result.countererId,
            count: result.count,
            targetPlayerId: result.doubterId,
            isCounterLead: true, // Tag to retain lead after penalty
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
        moveCardsToGrave(room, room.rollbackState.currentCards);
      }
      
      clearField(room);
      
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
          isCounterLead: true, // Tag to retain lead after penalty
        };
        room.phase = 'effectPhase';
      } else {
        room.phase = 'playing';
      }
      return;
    } else if (result.type === 'success') {
      GameEngine.addLog(room, 'doubtSuccess', result.doubterId, { revealedCards: result.revealedCards });
      
      // Move the liar's revealed cards to face-up graveyard (Standard + Req 4)
      room.field.faceUpPool.push(...result.revealedCards);

      // Phase 14: Liar's cards NOT returned to hand (Requirement 5)
      // (The block that returned them to hand has been removed)

      // Phase 14: Track that this player failed to play (lied and caught)
      room.passCount++;

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

        // If the rollback made the field empty (e.g., lied on the very first play),
        // we consider the field 'cleared' for Q-Bomber purposes.
        if (room.field.currentCards.length === 0) {
          room.field.hasFieldCleared = true;
        }
      }

      // Check for field clear if everyone else failed to play (Requirement 6)
      // Done AFTER rollback so that the restored cards are properly cleared!
      const activePlayers = room.players.filter(p => !p.isOut);
      if (room.passCount >= activePlayers.length - 1) {
        clearField(room);
        room.passCount = 0;
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

      // If the counter was a lie, check if the original card was an 8-cut or single Joker
      // so we can restore the effect after penalty
      if (wasCounterFail) {
        const restoredDeclared = room.field.declaredNumber;
        const restoredCards = room.field.currentCards;
        const is8Cut = restoredDeclared === 8;
        const isSingleJoker = restoredDeclared === 0 && restoredCards.length === 1;
        if (is8Cut || isSingleJoker) {
          (room.pendingEffect as any).restoreEightCutAfter = true;
        }
      }
      
      // Note: We do NOT set liar.isSkipped = true.
      // Setting isSkipped would penalize them by skipping their *next* turn as well.

      room.phase = 'effectPhase';
    } else if (result.type === 'failure') {
      GameEngine.addLog(room, 'doubtFailure', result.doubterId, { revealedCards: result.revealedCards });
      // Doubt failed (player was honest)
      
      // Face-up graveyard movement will be handled by clearField later (Requirement 4)
      
      const lastPlayer = room.players.find(p => p.id === result.honestPlayerId)!;

      // The cards were honestly played, so previous cards go to history
      if (room.rollbackState && room.rollbackState.currentCards.length > 0) {
        moveCardsToGrave(room, room.rollbackState.currentCards);
      }

      // Phase 14: Honest play is successful -> reset pass count
      room.passCount = 0;



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
          // Phase 13: 破壊されたカードは表墓地へ
          room.field.faceUpPool.push(...toDiscard);
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
        GameEngine.finalizeGame(room);
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
      room.passCount = 0;
      // The cards were accepted, so previous cards go to history
      if (room.rollbackState && room.rollbackState.currentCards.length > 0) {
        moveCardsToGrave(room, room.rollbackState.currentCards);
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
            // Phase 13: 破壊されたカードは表墓地へ
            room.field.faceUpPool.push(...toDiscard);
          }
          GameEngine.addLog(room, 'queenBomber', room.field.lastPlayerId!, { targetNumbers: numbers });

          GameEngine.checkBombVictories(room);
          if (room.phase === 'result') return;

          room.field.pendingNumbers = undefined;
          room.phase = 'playing';
          GameEngine.advanceTurn(room);
        } else if (room.field.declaredNumber === 5) {
          // 5-skip loop-back: check if all other active players are skipped
          const otherActive = room.players.filter(p => !p.isOut && p.id !== room.field.lastPlayerId);
          const allSkipped = otherActive.length > 0 && otherActive.every(p => p.isSkipped);
          if (allSkipped) {
            clearField(room);
            room.phase = 'playing';
            // Player who played 5 continues (no advanceTurn)
          } else {
            room.phase = 'playing';
            GameEngine.advanceTurn(room);
          }
        } else {
          room.phase = 'playing';
          GameEngine.advanceTurn(room);
        }
      }
    }

    // After all doubt resolution, resolve any pending finish
    GameEngine.resolvePendingFinish(room);

    // Safety check: If the turn remains on a player who is already out (e.g., 8-cut win),
    // force the turn to advance to the next active player.
    const currentPlayerId = room.turnOrder[room.currentPlayerIndex];
    if (currentPlayerId && room.phase === 'playing') {
      const currentPlayer = room.players.find(p => p.id === currentPlayerId);
      if (currentPlayer?.isOut) {
        GameEngine.advanceTurn(room);
      }
    }
  }

  /**
   * Resolve pending finish after doubt phase.
   * If the player's hand is still empty, apply win/forbidden-finish logic.
   * If doubt succeeded (cards returned to hand), the finish is canceled.
   */
  static resolvePendingFinish(room: Room): void {
    const finishPlayerId = room.pendingFinishPlayerId;
    if (!finishPlayerId) return;

    room.pendingFinishPlayerId = null;

    const player = room.players.find(p => p.id === finishPlayerId);
    if (!player || player.isOut) return;

    // If cards were returned to hand (doubt success), finish is canceled
    if (player.hand.length > 0) return;

    // Player's hand is still empty — resolve finish
    const isForbidden = checkForbiddenFinish(
      room.field.declaredNumber,
      room.field.currentCards,
      room.rules.isRevolution
    );

    if (isForbidden) {
      player.isOut = true;
      player.rank = -1;
    } else {
      room.finishOrder.push(finishPlayerId);
      player.rank = room.finishOrder.length;
      player.isOut = true;
    }

    // Check if game is over
    const activePlayers = room.players.filter(p => !p.isOut);
    if (activePlayers.length <= 1) {
      GameEngine.finalizeGame(room);
    }
  }

  static startCounterPhase(room: Room): void {
    room.phase = 'counterPhase';
    room.doubtDeclarers = [];
    room.doubtSkippers = [];
    room.field.counteredBy = null;

    // Start with the player immediately after the one who played the 8 or Joker
    const lastPlayerIdx = room.turnOrder.indexOf(room.field.lastPlayerId!);
    room.counterActorIndex = lastPlayerIdx;
    GameEngine.advanceCounterActor(room);
  }

  /**
   * Advance the counter actor to the next eligible player.
   * Returns true if there is a next player, false if it looped back to the original player (end of counter phase).
   */
  static advanceCounterActor(room: Room): boolean {
    if (room.counterActorIndex === null) return false;

    const total = room.turnOrder.length;
    let attempts = 0;

    do {
      room.counterActorIndex = ((room.counterActorIndex + room.rules.direction) % total + total) % total;
      attempts++;
      if (attempts > total) {
        room.counterActorIndex = null;
        room.pendingEffect = null;
        return false;
      }

      const nextPlayerId = room.turnOrder[room.counterActorIndex];
      const nextPlayer = room.players.find(p => p.id === nextPlayerId);
      
      // Stop if it looped back to the original player who played the card
      if (nextPlayerId === room.field.lastPlayerId) {
        room.counterActorIndex = null;
        room.pendingEffect = null;
        return false;
      }

      if (!nextPlayer || nextPlayer.isOut) continue;
      
      // Found the next active player to make a counter decision
      // Set pending effect to trigger UI (Requirement 2)
      const isEight = room.field.declaredNumber === 8;
      const count = isEight ? room.field.currentCards.length + 1 : 1;
      
      room.pendingEffect = {
        type: 'counterSelection',
        playerId: nextPlayerId,
        count: count,
      };

      return true;
    } while (true);
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
    // Counter against Joker (must be Spade 3 return)
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
    room.pendingEffect = null; // Fix: clear modal after counter


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
          GameEngine.sanitizeHand(nextPlayer);
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
        const collectedCards: Card[] = [];
        for (const cid of cardIds) {
          const idx = room.field.faceUpPool.findIndex(c => c.id === cid);
          if (idx === -1) return { success: false, error: '表向きカードにないカードです' };
          const card = room.field.faceUpPool[idx];
          player.hand.push(card);
          collectedCards.push(card);
          room.field.faceUpPool.splice(idx, 1);
        }
        GameEngine.sanitizeHand(player);
        GameEngine.addLog(room, 'sixCollect', playerId, { 
          cardCount: cardIds.length,
          collectedCards: collectedCards 
        });
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
        moveCardsToGrave(room, cardsToDiscard);
        
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
    
    // Check for deferred effect (e.g. 7-pass after doubt penalty)
    if (room.deferredEffect) {
      room.pendingEffect = room.deferredEffect;
      room.deferredEffect = null;
      room.phase = 'effectPhase';
      return { success: true };
    } else {
      room.phase = 'playing';
    }

    // Check if the player who used the effect just went out
    if (player.hand.length === 0 && !player.isOut) {
      room.finishOrder.push(player.id);
      player.rank = room.finishOrder.length;
      player.isOut = true;

      const activePlayersAfterEffect = room.players.filter(p => !p.isOut);
      if (activePlayersAfterEffect.length <= 1) {
        GameEngine.finalizeGame(room);
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

    // If counter was a lie and original card was 8-cut, restore the effect
    const restoreEightCut = (effect as any).restoreEightCutAfter;
    if (restoreEightCut) {
      GameEngine.addLog(room, 'eightCut', room.field.lastPlayerId || '');
      clearField(room);
      // Turn goes to the original 8-cut player (lastPlayerId was restored via rollback)
      room.phase = 'playing';
      return { success: true };
    }

    // Phase 7 fix: If this was a counter lead (e.g., honest counter was doubted),
    // do NOT advance turn. The counterer retains the lead.
    const isCounterLead = effect.isCounterLead;
    if (isCounterLead) {
      console.log(`[Turn Sync] Counter-leader ${playerId} retains lead. Skipping advanceTurn.`);
      return { success: true };
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
        rankStats: p.rankStats,
      })),
      field: {
        currentCardCount: room.field.currentCards.length,
        declaredNumber: room.field.declaredNumber,
        cardHistoryCount: room.field.cardHistory.length,
        faceUpPool: room.field.faceUpPool,
        lastPlayerId: room.field.lastPlayerId,
        doubtType: room.field.doubtType,
        counteredBy: room.field.counteredBy,
        pendingNumbers: room.field.pendingNumbers,
        revealedCards: room.field.currentCards.filter(c => c.isFaceUp),
        hasFieldCleared: room.field.hasFieldCleared,
        isEffectActive: (
          room.field.declaredNumber === 12 ? room.field.hasFieldCleared :
          room.field.declaredNumber === 6 ? room.field.faceUpPool.length > 0 :
          true
        ),
      },
      rules: { ...room.rules },
      currentPlayerId: room.turnOrder[room.currentPlayerIndex],
      myHand: player ? [...player.hand] : [],
      pendingEffect: room.pendingEffect,
      finishOrder: [...room.finishOrder],
      logs: room.logs || [],
      counterActorId: room.counterActorIndex !== null ? room.turnOrder[room.counterActorIndex] : null,
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
      collectedCards?: Card[];
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
      GameEngine.finalizeGame(room);
    }
  }

  /**
   * Helper to ensure hand integrity (no duplicate card IDs).
   */
  static sanitizeHand(player: Player): void {
    const seenIds = new Set<string>();
    player.hand = player.hand.filter(card => {
      if (seenIds.has(card.id)) return false;
      seenIds.add(card.id);
      return true;
    });
  }

  static finalizeGame(room: Room): void {
    const activePlayers = room.players.filter(p => !p.isOut);
    if (activePlayers.length === 1) {
      const lastPlayer = activePlayers[0];
      lastPlayer.isOut = true;
      room.finishOrder.push(lastPlayer.id);
      lastPlayer.rank = room.finishOrder.length;
    }
    
    room.phase = 'result';
    AIEngine.clearThinkingPlayers();
    
    // Update stats
    room.players.forEach(p => {
      if (p.rank !== null) {
        p.rankStats[p.rank] = (p.rankStats[p.rank] || 0) + 1;
      }
    });
  }

  static reassignPlayerId(room: Room, oldId: string, newId: string): void {
    if (room.hostId === oldId) room.hostId = newId;
    if (room.field.lastPlayerId === oldId) room.field.lastPlayerId = newId;
    if (room.field.counteredBy === oldId) room.field.counteredBy = newId;

    if (room.pendingFinishPlayerId === oldId) room.pendingFinishPlayerId = newId;

    room.players.forEach(p => {
      if (p.id === oldId) p.id = newId;
    });

    room.turnOrder = room.turnOrder.map(id => id === oldId ? newId : id);
    room.finishOrder = room.finishOrder.map(id => id === oldId ? newId : id);
    room.doubtDeclarers = room.doubtDeclarers.map(id => id === oldId ? newId : id);
    room.doubtSkippers = room.doubtSkippers.map(id => id === oldId ? newId : id);

    if (room.pendingEffect) {
      if (room.pendingEffect.playerId === oldId) room.pendingEffect.playerId = newId;
      if (room.pendingEffect.targetPlayerId === oldId) room.pendingEffect.targetPlayerId = newId;
    }

    if (room.deferredEffect) {
      if (room.deferredEffect.playerId === oldId) room.deferredEffect.playerId = newId;
      if (room.deferredEffect.targetPlayerId === oldId) room.deferredEffect.targetPlayerId = newId;
    }

    if (room.rollbackState) {
      if (room.rollbackState.lastPlayerId === oldId) room.rollbackState.lastPlayerId = newId;
      if (room.rollbackState.skippedPlayerIds) {
        room.rollbackState.skippedPlayerIds = room.rollbackState.skippedPlayerIds.map(id => id === oldId ? newId : id);
      }
    }

    // Update logs
    room.logs.forEach(log => {
      if (log.playerId === oldId) log.playerId = newId;
      // Note: we keep log.playerName as is
    });
  }
}
