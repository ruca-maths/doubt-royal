import { Room, Player, Card } from './types';
import { GameEngine } from './engine';
import { DoubtManager } from './doubt';
import { validatePlayCards } from './validator';

export class AIEngine {
  static runPlayTurn(
    room: Room, 
    playerId: string, 
    onAction: (actionType: 'play' | 'pass', result?: { success: boolean; skipDoubt?: boolean; error?: string }) => void
  ): void {
    const player = room.players.find(p => p.id === playerId);
    if (!player || player.isOut) return;

    // Simulate thinking time (1-3 seconds)
    const thinkingTime = Math.floor(Math.random() * 2000) + 1000;
    
    setTimeout(() => {
      // Re-check game state after timeout
      if (room.phase !== 'playing' || room.turnOrder[room.currentPlayerIndex] !== playerId) return;
      
      const action = this.decidePlayAction(room, player);
      
      if (action.type === 'pass') {
        const result = GameEngine.passTurn(room, playerId);
        onAction('pass', result);
      } else if (action.type === 'play' && action.cards) {
        // AI playing cards
        const result = GameEngine.playCards(room, playerId, action.cards.map(c => c.id), action.declaredNumber!);
        onAction('play', result);
      }
    }, thinkingTime);
  }

  /**
   * Decide what cards to play.
   * Simple logic: try honestly, if not possible -> pass.
   */
  static decidePlayAction(room: Room, player: Player): { type: 'play' | 'pass', cards?: Card[], declaredNumber?: number } {
    const fieldCardsCount = room.field.currentCards.length;
    const isFieldEmpty = fieldCardsCount === 0 || room.field.lastPlayerId === null || room.field.lastPlayerId === player.id;
    
    const handByNumber = new Map<number, Card[]>();
    player.hand.forEach(c => {
      const num = c.isJoker ? 0 : c.number;
      if (!handByNumber.has(num)) handByNumber.set(num, []);
      handByNumber.get(num)!.push(c);
    });

    if (isFieldEmpty) {
      // Pick lowest valid number (avoiding Joker if possible)
      let availableNumbers = Array.from(handByNumber.keys()).filter(n => n !== 0);
      if (availableNumbers.length === 0) availableNumbers = [0];

      availableNumbers.sort((a, b) => {
        let rankA = (a === 2) ? 15 : (a === 1 ? 14 : a);
        let rankB = (b === 2) ? 15 : (b === 1 ? 14 : b);
        if (room.rules.isRevolution) {
          rankA = (a === 2) ? -15 : (a === 1 ? -14 : -a);
          rankB = (b === 2) ? -15 : (b === 1 ? -14 : -b);
        }
        return rankA - rankB;
      });

      const numToPlay = availableNumbers[0];
      const cards = handByNumber.get(numToPlay)!;
      // Play 1 card if empty
      return { type: 'play', cards: [cards[0]], declaredNumber: numToPlay };
    } else {
      // Play matching length stronger cards
      const targetCount = fieldCardsCount;
      const currentDeclared = room.field.declaredNumber;
      
      for (const [num, cards] of Array.from(handByNumber.entries())) {
        if (cards.length >= targetCount) {
          const selectedCards = cards.slice(0, targetCount);
          const validation = validatePlayCards(
            selectedCards, 
            num, 
            {
               currentCardCount: targetCount,
               declaredNumber: currentDeclared,
               lastPlayerId: room.field.lastPlayerId
            }, 
            room.rules
          );

          if (validation.valid) {
            return { type: 'play', cards: selectedCards, declaredNumber: num };
          }
        }
      }

      // TODO: Add lying logic here (e.g., 20% chance to lie)

      return { type: 'pass' };
    }
  }

  /**
   * Called when the doubt phase starts to schedule AI doubt decisions.
   */
  static runDoubtDecision(room: Room, onDoubtDeclared: (playerId: string) => void, onDoubtResolved: () => void): void {
    if (room.phase !== 'doubtPhase') return;

    // AIs need to decide whether to doubt or skip.
    // They should wait a bit to simulate thinking, but not longer than doubtTime.
    const activeAIs = room.players.filter(p => p.isAI && !p.isOut && p.id !== room.field.lastPlayerId);
    
    activeAIs.forEach(ai => {
      // Don't act if already declared/skipped
      if (room.doubtSkippers.includes(ai.id) || room.doubtDeclarers.includes(ai.id)) return;

      const thinkingTime = Math.floor(Math.random() * (room.rules.doubtTime * 1000 * 0.5)) + 1000;
      
      setTimeout(() => {
        // Double check phase
        if (room.phase !== 'doubtPhase') return;
        
        // 10% chance to doubt, 90% chance to skip
        const willDoubt = Math.random() < 0.1;

        if (willDoubt) {
          const success = DoubtManager.registerDoubt(room, ai.id);
          if (success) {
            onDoubtDeclared(ai.id);
          }
        } else {
          const isAllResolved = DoubtManager.registerSkip(room, ai.id);
          if (isAllResolved) {
             onDoubtResolved();
          }
        }
      }, thinkingTime);
    });
  }

  /**
   * Called when the counter phase moves to a specific player (can be AI).
   */
  static runCounterDecision(
    room: Room,
    onCounterDeclared: (playerId: string) => void,
    onSkipCounter: () => void
  ): void {
    if (room.phase !== 'counterPhase' || room.counterActorIndex === null) return;

    const actorId = room.turnOrder[room.counterActorIndex];
    const player = room.players.find(p => p.id === actorId);

    if (!player || !player.isAI || player.isOut) return;

    const thinkingTime = Math.floor(Math.random() * 2000) + 1000;

    setTimeout(() => {
      // Re-check state
      if (room.phase !== 'counterPhase' || room.counterActorIndex === null || room.turnOrder[room.counterActorIndex] !== actorId) return;

      // Decide whether to counter
      // AI will always try to counter if it has the required cards for now.
      let canCounter = false;
      let counterCards: Card[] = [];

      if (room.field.declaredNumber === 8) {
        // needs 4s matching currentCards.length + 1
        const fours = player.hand.filter(c => c.number === 4);
        const requiredCount = room.field.currentCards.length + 1;
        if (fours.length >= requiredCount) {
          canCounter = true;
          counterCards = fours.slice(0, requiredCount);
        }
      } else if (room.field.declaredNumber === 0 && room.field.currentCards.length === 1) {
        // needs Spade 3
        const spade3 = player.hand.find(c => c.suit === 'spade' && c.number === 3);
        if (spade3) {
          canCounter = true;
          counterCards = [spade3];
        }
      }

      // 80% chance to counter if possible, otherwise skip to keep cards
      if (canCounter && Math.random() < 0.8) {
        const result = GameEngine.declareCounter(room, actorId, counterCards.map(c => c.id));
        if (result.success) {
          onCounterDeclared(actorId);
          // startDoubtTimer is usually called by the handler.
        } else {
          onSkipCounter();
        }
      } else {
        // Skip
        onSkipCounter();
      }
    }, thinkingTime);
  }

  /**
   * Called when an AI needs to make a decision for a pending effect
   */
  static runEffectDecision(room: Room, onAction: () => void): void {
    if (room.phase !== 'effectPhase' || !room.pendingEffect) return;

    const effect = room.pendingEffect;
    const player = room.players.find(p => p.id === effect.playerId);

    if (!player || !player.isAI || player.isOut) return;

    const thinkingTime = Math.floor(Math.random() * 2000) + 1000;

    setTimeout(() => {
      // Re-check state
      if (room.phase !== 'effectPhase' || room.pendingEffect !== effect) return;

      const cardIds: string[] = [];
      let targetData: { numbers?: number[] } | undefined;

      // Make a decision based on effect type
      switch (effect.type) {
        case 'sevenPass':
        case 'doubtCardSelect':
        case 'tenDiscard': {
          // AI simply selects up to `count` lowest cards to give/discard
          const count = Math.min(effect.count, player.hand.length);
          if (count > 0) {
            // Sort hand by rank ascending
            const sortedHand = [...player.hand].sort((a, b) => {
              let rankA = (a.number === 2) ? 15 : (a.number === 1 ? 14 : (a.isJoker ? 16 : a.number));
              let rankB = (b.number === 2) ? 15 : (b.number === 1 ? 14 : (b.isJoker ? 16 : b.number));
              if (room.rules.isRevolution) {
                rankA = (a.number === 2) ? -15 : (a.number === 1 ? -14 : (a.isJoker ? 16 : -a.number));
                rankB = (b.number === 2) ? -15 : (b.number === 1 ? -14 : (b.isJoker ? 16 : -b.number));
              }
              return rankA - rankB;
            });

            // For Q-bomber destroyed cards restriction
            const excludedNumbers = (effect as any).excludedNumbers as number[] | undefined;
            let availableCards = sortedHand;
            if (excludedNumbers) {
               availableCards = availableCards.filter(c => !excludedNumbers.includes(c.number) && !(excludedNumbers.includes(0) && c.isJoker));
            }

            for (let i = 0; i < Math.min(count, availableCards.length); i++) {
              cardIds.push(availableCards[i].id);
            }
          }
          break;
        }

        case 'sixCollect': {
          // AI selects the strongest cards from the faceUpPool
          const count = Math.min(effect.count, room.field.faceUpPool.length);
          if (count > 0) {
            const sortedPool = [...room.field.faceUpPool].sort((a, b) => {
              let rankA = (a.number === 2) ? 15 : (a.number === 1 ? 14 : (a.isJoker ? 16 : a.number));
              let rankB = (b.number === 2) ? 15 : (b.number === 1 ? 14 : (b.isJoker ? 16 : b.number));
              if (room.rules.isRevolution) {
                rankA = (a.number === 2) ? -15 : (a.number === 1 ? -14 : (a.isJoker ? 16 : -a.number));
                rankB = (b.number === 2) ? -15 : (b.number === 1 ? -14 : (b.isJoker ? 16 : -b.number));
              }
              return rankB - rankA; // Descending for collection
            });
            for (let i = 0; i < count; i++) {
              cardIds.push(sortedPool[i].id);
            }
          }
          break;
        }

        case 'queenBomber': {
          // AI chooses the number it has the fewest/zero of, OR targets opponents' known cards
          // Simple heuristic: randomly pick a number between 1-13
          const randomNum = Math.floor(Math.random() * 13) + 1;
          targetData = { numbers: [randomNum] };
          break;
        }
      }

      // Execute action
      // Since effect actions typically respond via socket event `effect-action`,
      // we can call `GameEngine.handleEffectAction`.
      GameEngine.handleEffectAction(room, effect.playerId, cardIds, targetData);

      onAction();
    }, thinkingTime);
  }
}
