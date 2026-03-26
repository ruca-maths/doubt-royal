import { Room, Player, Card } from './types';
import { GameEngine } from './engine';
import { DoubtManager } from './doubt';
import { validatePlayCards } from './validator';
import * as ort from 'onnxruntime-node';
import path from 'path';

export class AIEngine {
  private static session: ort.InferenceSession | null = null;
  private static modelPath = path.join(process.cwd(), 'doubt_royale_model.onnx');

  private static async getSession(): Promise<ort.InferenceSession | null> {
    if (this.session) return this.session;
    try {
      this.session = await ort.InferenceSession.create(this.modelPath);
      console.log('AI Logic: RL Model loaded successfully.');
      return this.session;
    } catch (e) {
      console.error('AI Logic: Failed to load RL Model, using heuristics.', e);
      return null;
    }
  }

  static async runPlayTurn(
    room: Room, 
    playerId: string, 
    onAction: (actionType: 'play' | 'pass', result?: { success: boolean; skipDoubt?: boolean; error?: string }) => void
  ): Promise<void> {
    const player = room.players.find(p => p.id === playerId);
    if (!player || player.isOut) return;

    const session = await this.getSession();
    const stateVector = this.getStateVector(room, player);
    
    // Simulate thinking time (1-3 seconds)
    const thinkingTime = Math.floor(Math.random() * 2000) + 1000;
    
    setTimeout(async () => {
      // Re-check game state after timeout
      if (room.phase !== 'playing' || room.turnOrder[room.currentPlayerIndex] !== playerId) return;
      
      let action: { type: 'play' | 'pass', cards?: Card[], declaredNumber?: number };

      if (session) {
        const result = await this.predict(session, stateVector);
        action = this.mapActionToGame(room, player, result);
      } else {
        action = this.decidePlayActionHeuristic(room, player);
      }
      
      if (action.type === 'pass') {
        const result = GameEngine.passTurn(room, playerId);
        onAction('pass', result);
      } else if (action.type === 'play' && action.cards) {
        const result = GameEngine.playCards(room, playerId, action.cards.map(c => c.id), action.declaredNumber!);
        onAction('play', result);
      }
    }, thinkingTime);
  }

  private static async predict(session: ort.InferenceSession, state: number[]): Promise<number> {
    const input = new ort.Tensor('float32', new Float32Array(state), [1, 62]);
    const results = await session.run({ input });
    const output = results.output.data as Float32Array;
    // Get index of max value
    let maxIdx = 0;
    for (let i = 1; i < output.length; i++) {
        if (output[i] > output[maxIdx]) maxIdx = i;
    }
    return maxIdx;
  }

  private static mapActionToGame(room: Room, player: Player, modelAction: number): { type: 'play' | 'pass', cards?: Card[], declaredNumber?: number } {
    // 0: Pass, 1-13: Honest Play, 16-28: Lying Play (action-15)
    if (modelAction === 0) return { type: 'pass' };

    let declaredNum = 0;
    let isLie = false;

    if (modelAction >= 1 && modelAction <= 13) {
        declaredNum = modelAction;
    } else if (modelAction >= 16 && modelAction <= 28) {
        declaredNum = modelAction - 15;
        isLie = true;
    } else {
        return { type: 'pass' }; // Fallback for doubt/counter actions in playing phase
    }

    const fieldCardsCount = room.field.currentCards.length;
    const targetCount = fieldCardsCount === 0 || room.field.lastPlayerId === null || room.field.lastPlayerId === player.id ? 1 : fieldCardsCount;

    // Selection Logic
    const matchingCards = player.hand.filter(c => (c.isJoker ? 0 : c.number) === declaredNum);
    
    if (!isLie && matchingCards.length >= targetCount) {
        return { type: 'play', cards: matchingCards.slice(0, targetCount), declaredNumber: declaredNum };
    } else {
        // Lying or not enough cards: pick anything that's not declaredNum if possible
        const otherCards = player.hand.filter(c => (c.isJoker ? 0 : c.number) !== declaredNum);
        const available = otherCards.length >= targetCount ? otherCards : player.hand;
        if (available.length >= targetCount) {
            return { type: 'play', cards: available.slice(0, targetCount), declaredNumber: declaredNum };
        }
    }

    return { type: 'pass' };
  }

  /**
   * Room to 62-dimensional vector:
   * [0-53]: My Hand (multi-hot)
   * [54-56]: Field [declaredNum, count, lastPlayerRelIdx]
   * [57-59]: Others' card counts
   * [60-61]: Rules [isRevolution, isElevenBack]
   */
  private static getStateVector(room: Room, player: Player): number[] {
    const vec = new Array(62).fill(0);
    
    // Hand
    player.hand.forEach(c => {
        let idx = 0;
        const cardMatch = c.id.match(/card-(\d+)/);
        if (cardMatch) {
            idx = parseInt(cardMatch[1]);
        }
        if (idx >= 0 && idx < 54) vec[idx] = 1;
    });

    // Field
    vec[54] = room.field.declaredNumber;
    vec[55] = room.field.currentCards.length;
    if (room.field.lastPlayerId) {
        const lastIdx = room.turnOrder.indexOf(room.field.lastPlayerId);
        const myIdx = room.turnOrder.indexOf(player.id);
        vec[56] = (lastIdx - myIdx + room.players.length) % room.players.length;
    } else {
        vec[56] = -1;
    }

    // Others
    let j = 0;
    room.players.forEach(p => {
        if (p.id !== player.id) {
            vec[57 + j] = p.hand.length;
            j++;
        }
    });

    // Status
    vec[60] = room.rules.isRevolution ? 1 : 0;
    vec[61] = room.rules.isElevenBack ? 1 : 0;

    return vec;
  }

  static async runDoubtDecision(room: Room, onDoubtDeclared: (playerId: string) => void, onDoubtResolved: () => void): Promise<void> {
    if (room.phase !== 'doubtPhase') return;

    const session = await this.getSession();
    const activeAIs = room.players.filter(p => p.isAI && !p.isOut && p.id !== room.field.lastPlayerId);
    
    activeAIs.forEach(async ai => {
      if (room.doubtSkippers.includes(ai.id) || room.doubtDeclarers.includes(ai.id)) return;

      const thinkingTime = Math.floor(Math.random() * (room.rules.doubtTime * 1000 * 0.5)) + 1000;
      const stateVector = this.getStateVector(room, ai);

      setTimeout(async () => {
        if (room.phase !== 'doubtPhase') return;

        let willDoubt = false;
        if (session) {
            const action = await this.predict(session, stateVector);
            willDoubt = (action === 14); // 14: Doubt
        } else {
            willDoubt = Math.random() < 0.1;
        }

        if (willDoubt) {
          const success = DoubtManager.registerDoubt(room, ai.id);
          if (success) onDoubtDeclared(ai.id);
        } else {
          const isAllResolved = DoubtManager.registerSkip(room, ai.id);
          if (isAllResolved) onDoubtResolved();
        }
      }, thinkingTime);
    });
  }

  static async runCounterDecision(
    room: Room,
    onCounterDeclared: (playerId: string) => void,
    onSkipCounter: () => void
  ): Promise<void> {
    if (room.phase !== 'counterPhase' || room.counterActorIndex === null) return;

    const actorId = room.turnOrder[room.counterActorIndex];
    const player = room.players.find(p => p.id === actorId);
    if (!player || !player.isAI || player.isOut) return;

    const session = await this.getSession();
    const stateVector = this.getStateVector(room, player);
    const thinkingTime = Math.floor(Math.random() * 2000) + 1000;

    setTimeout(async () => {
      if (room.phase !== 'counterPhase' || room.counterActorIndex === null || room.turnOrder[room.counterActorIndex] !== actorId) return;

      let willCounter = false;
      if (session) {
        const action = await this.predict(session, stateVector);
        willCounter = (action === 15); // 15: Counter
      } else {
        // Fallback heuristic: check if we have cards
        willCounter = this.canCounterHeuristic(room, player) && Math.random() < 0.8;
      }

      let counterCards: Card[] = [];
      if (willCounter) {
        if (room.field.declaredNumber === 8) {
            const fours = player.hand.filter(c => c.number === 4);
            const requiredCount = room.field.currentCards.length + 1;
            if (fours.length >= requiredCount) counterCards = fours.slice(0, requiredCount);
        } else if (room.field.declaredNumber === 0 && room.field.currentCards.length === 1) {
            const spade3 = player.hand.find(c => c.suit === 'spade' && c.number === 3);
            if (spade3) counterCards = [spade3];
        }
      }

      if (counterCards.length > 0) {
        const result = GameEngine.declareCounter(room, actorId, counterCards.map(c => c.id));
        if (result.success) {
          onCounterDeclared(actorId);
        } else {
          onSkipCounter();
        }
      } else {
        onSkipCounter();
      }
    }, thinkingTime);
  }

  private static canCounterHeuristic(room: Room, player: Player): boolean {
    if (room.field.declaredNumber === 8) {
        const fours = player.hand.filter(c => c.number === 4);
        return fours.length >= room.field.currentCards.length + 1;
    } else if (room.field.declaredNumber === 0 && room.field.currentCards.length === 1) {
        return !!player.hand.find(c => c.suit === 'spade' && c.number === 3);
    }
    return false;
  }

  static decidePlayActionHeuristic(room: Room, player: Player): { type: 'play' | 'pass', cards?: Card[], declaredNumber?: number } {
    const fieldCardsCount = room.field.currentCards.length;
    const isFieldEmpty = fieldCardsCount === 0 || room.field.lastPlayerId === null || room.field.lastPlayerId === player.id;
    
    const handByNumber = new Map<number, Card[]>();
    player.hand.forEach(c => {
      const num = c.isJoker ? 0 : c.number;
      if (!handByNumber.has(num)) handByNumber.set(num, []);
      handByNumber.get(num)!.push(c);
    });

    if (isFieldEmpty) {
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
      return { type: 'play', cards: [cards[0]], declaredNumber: numToPlay };
    } else {
      const targetCount = fieldCardsCount;
      const currentDeclared = room.field.declaredNumber;
      
      for (const [num, cards] of Array.from(handByNumber.entries())) {
        if (cards.length >= targetCount) {
          const selectedCards = cards.slice(0, targetCount);
          const validation = validatePlayCards(selectedCards, num, { currentCardCount: targetCount, declaredNumber: currentDeclared, lastPlayerId: room.field.lastPlayerId }, room.rules);
          if (validation.valid) return { type: 'play', cards: selectedCards, declaredNumber: num };
        }
      }
      return { type: 'pass' };
    }
  }

  static runEffectDecision(room: Room, onAction: () => void): void {
    if (room.phase !== 'effectPhase' || !room.pendingEffect) return;
    const effect = room.pendingEffect;
    const player = room.players.find(p => p.id === effect.playerId);
    if (!player || !player.isAI || player.isOut) return;
    const thinkingTime = Math.floor(Math.random() * 2000) + 1000;
    setTimeout(() => {
      if (room.phase !== 'effectPhase' || room.pendingEffect !== effect) return;
      const cardIds: string[] = [];
      let targetData: { numbers?: number[] } | undefined;

      switch (effect.type) {
        case 'sevenPass':
        case 'doubtCardSelect':
        case 'tenDiscard': {
          const count = Math.min(effect.count, player.hand.length);
          if (count > 0) {
            const sortedHand = [...player.hand].sort((a, b) => {
              let rankA = (a.number === 2) ? 15 : (a.number === 1 ? 14 : (a.isJoker ? 16 : a.number));
              let rankB = (b.number === 2) ? 15 : (b.number === 1 ? 14 : (b.isJoker ? 16 : b.number));
              if (room.rules.isRevolution) {
                rankA = (a.number === 2) ? -15 : (a.number === 1 ? -14 : (a.isJoker ? 16 : -a.number));
                rankB = (b.number === 2) ? -15 : (b.number === 1 ? -14 : (b.isJoker ? 16 : -b.number));
              }
              return rankA - rankB;
            });
            const excludedNumbers = (effect as any).excludedNumbers as number[] | undefined;
            let availableCards = sortedHand;
            if (excludedNumbers) availableCards = availableCards.filter(c => !excludedNumbers.includes(c.number) && !(excludedNumbers.includes(0) && c.isJoker));
            for (let i = 0; i < Math.min(count, availableCards.length); i++) cardIds.push(availableCards[i].id);
          }
          break;
        }
        case 'sixCollect': {
          const count = Math.min(effect.count, room.field.faceUpPool.length);
          if (count > 0) {
            const sortedPool = [...room.field.faceUpPool].sort((a, b) => {
              let rankA = (a.number === 2) ? 15 : (a.number === 1 ? 14 : (a.isJoker ? 16 : a.number));
              let rankB = (b.number === 2) ? 15 : (b.number === 1 ? 14 : (b.isJoker ? 16 : b.number));
              if (room.rules.isRevolution) {
                rankA = (a.number === 2) ? -15 : (a.number === 1 ? -14 : (a.isJoker ? 16 : -a.number));
                rankB = (b.number === 2) ? -15 : (b.number === 1 ? -14 : (b.isJoker ? 16 : -b.number));
              }
              return rankB - rankA;
            });
            for (let i = 0; i < count; i++) cardIds.push(sortedPool[i].id);
          }
          break;
        }
        case 'queenBomber': {
          const randomNum = Math.floor(Math.random() * 13) + 1;
          targetData = { numbers: [randomNum] };
          break;
        }
      }
      GameEngine.handleEffectAction(room, effect.playerId, cardIds, targetData);
      onAction();
    }, thinkingTime);
  }
}
