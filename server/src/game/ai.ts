import { Room, Player, Card } from './types';
import { GameEngine } from './engine';
import { DoubtManager } from './doubt';
import { validatePlayCards } from './validator';
import { StrategyEngine } from './strategy';
import * as ort from 'onnxruntime-node';
import path from 'path';


export class AIEngine {
  private static thinkingPlayers = new Set<string>();
  private static session: ort.InferenceSession | null = null;
  private static sessionPromise: Promise<ort.InferenceSession | null> | null = null;

  static clearThinkingPlayers(): void {
    console.log('[AI Engine] Clearing thinking players guard.');
    this.thinkingPlayers.clear();
    StrategyEngine.loadStrategyData();
    StrategyEngine.clearAll();
  }

  static initializeStrategy(room: Room): void {
    for (const player of room.players) {
      if (player.isAI) {
        StrategyEngine.resetPlayer(player.id);
        StrategyEngine.planPlaySequence(player.id, player.hand, room.rules);
        console.log(`[AI Engine] Strategy planned for ${player.name}`);
      }
    }
  }

  private static getModelPath(): string {
    const cwd = process.cwd();
    const modelNames = [
      'doubt_royale_v15_ep2000.onnx',
      'doubt_royale_v14_ep30000.onnx',
      'doubt_royale_v14_latest.onnx',
      'doubt_royale_v13_latest.onnx',
      'doubt_royale_v11_latest.onnx',
      'doubt_royale_v9_latest.onnx',
      'doubt_royale_v8_latest.onnx',
      'doubt_royale_v5_latest.onnx',
      'doubt_royale_deepnash_latest.onnx',
      'doubt_royale_model_latest.onnx'
    ];
    
    const pathsToTry: string[] = [];
    for (const name of modelNames) {
      pathsToTry.push(path.join(cwd, name));
      pathsToTry.push(path.join(cwd, 'server', name));
      pathsToTry.push(path.join(cwd, 'server', 'rl', name));
      pathsToTry.push(path.join(__dirname, '..', '..', name));
    }
    
    for (const p of pathsToTry) {
      if (require('fs').existsSync(p)) {
        console.log(`AI Engine: Found model at ${p}`);
        return p;
      }
    }
    return pathsToTry[0];
  }

  private static async getSession(): Promise<ort.InferenceSession | null> {
    if (this.session) return this.session;
    if (this.sessionPromise) return this.sessionPromise;

    this.sessionPromise = (async () => {
      try {
        const modelPath = this.getModelPath();
        console.log(`AI Logic: Loading RL Model from ${modelPath}...`);
        this.session = await ort.InferenceSession.create(modelPath);
        console.log('AI Logic: RL Model loaded successfully.');
        return this.session;
      } catch (e) {
        console.error('AI Logic: Failed to load RL Model, using heuristics.', e);
        return null;
      }
    })();

    return this.sessionPromise;
  }

  static async runPlayTurn(
    room: Room, 
    playerId: string, 
    onAction: (actionType: 'play' | 'pass', result?: { success: boolean; skipDoubt?: boolean; error?: string }) => void
  ): Promise<void> {
    const player = room.players.find(p => p.id === playerId);
    if (!player || player.isOut) return;
    
    if (this.thinkingPlayers.has(playerId)) return;
    this.thinkingPlayers.add(playerId);

    const wrappedOnAction = (actionType: 'play' | 'pass', result?: { success: boolean; skipDoubt?: boolean; error?: string }) => {
      this.thinkingPlayers.delete(playerId);
      onAction(actionType, result);
    };

    let session: ort.InferenceSession | null = null;
    try {
      session = await this.getSession();
    } catch (err) {}

    const stateVector = this.getStateVector(room, player);
    const thinkingTime = Math.floor(Math.random() * 2000) + 1000;
    
    setTimeout(async () => {
      try {
        if (room.phase !== 'playing' || room.turnOrder[room.currentPlayerIndex] !== playerId) {
          this.thinkingPlayers.delete(playerId);
          return;
        }
        
        let action: { type: 'play' | 'pass', cards?: Card[], declaredNumber?: number };

        if (StrategyEngine.hasData()) {
          try {
            action = StrategyEngine.decidePlay(playerId, room, player);
            if (action.type === 'play' && action.cards) {
              const validation = validatePlayCards(
                action.cards, 
                action.declaredNumber!, 
                { 
                  currentCardCount: room.field.currentCards.length, 
                  declaredNumber: room.field.declaredNumber,
                  lastPlayerId: room.field.lastPlayerId
                },
                room.rules
              );
              if (!validation.valid) action = this.decidePlayActionHeuristic(room, player);
            }
          } catch (e) {
            action = this.decidePlayActionHeuristic(room, player);
          }
        } else if (session) {
          try {
            const result = await this.predict(session, stateVector);
            action = this.mapActionToGame(room, player, result);
            
            if (action.type === 'play') {
              const validation = validatePlayCards(
                action.cards!, 
                action.declaredNumber!, 
                { 
                  currentCardCount: room.field.currentCards.length, 
                  declaredNumber: room.field.declaredNumber,
                  lastPlayerId: room.field.lastPlayerId
                },
                room.rules
              );
              if (!validation.valid) action = this.decidePlayActionHeuristic(room, player);
            }
          } catch (e) {
            action = this.decidePlayActionHeuristic(room, player);
          }
        } else {
          action = this.decidePlayActionHeuristic(room, player);
        }
        
        const isFieldEmpty = room.field.currentCards.length === 0 || room.field.lastPlayerId === null || room.field.lastPlayerId === player.id;
        if (action.type === 'pass' && isFieldEmpty && player.hand.length > 0) {
          action = this.decidePlayActionHeuristic(room, player);
        }

        if (action.type === 'pass') {
          const result = GameEngine.passTurn(room, playerId);
          wrappedOnAction('pass', result);
        } else if (action.type === 'play' && action.cards) {
          const result = GameEngine.playCards(room, playerId, action.cards.map(c => c.id), action.declaredNumber!);
          wrappedOnAction('play', result);
        } else {
          const result = GameEngine.passTurn(room, playerId);
          wrappedOnAction('pass', result);
        }
      } catch (err) {
        this.thinkingPlayers.delete(playerId);
        const result = GameEngine.passTurn(room, playerId);
        onAction('pass', result);
      }
    }, thinkingTime);
  }

  private static getPhaseIndex(phase: string): number {
    switch (phase) {
      case 'playing': return 0;
      case 'doubtPhase': return 1;
      case 'counterPhase': return 2;
      case 'effectPhase': return 4;
      default: return 0;
    }
  }

  private static async predict(session: ort.InferenceSession, state: number[]): Promise<number> {
    const input = new ort.Tensor('float32', new Float32Array(state), [1, 114]);
    const results = await session.run({ input });
    let outputData: Float32Array;
    if (results.output) {
      outputData = results.output.data as Float32Array;
    } else if (results.action_probs) {
      outputData = results.action_probs.data as Float32Array;
    } else {
      const firstKey = Object.keys(results)[0];
      outputData = results[firstKey].data as Float32Array;
    }
    let maxIdx = 0;
    for (let i = 1; i < outputData.length; i++) {
        if (outputData[i] > outputData[maxIdx]) maxIdx = i;
    }
    return maxIdx;
  }

  private static mapActionToGame(room: Room, player: Player, modelAction: number): { type: 'play' | 'pass', cards?: Card[], declaredNumber?: number } {
    if (modelAction === 0) return { type: 'pass' };
    
    let declaredNum = 0;
    let isLie = false;
    let computedTargetCount = 1;

    // Honest Play (1~52)
    if (modelAction >= 1 && modelAction <= 52) {
      declaredNum = ((modelAction - 1) % 13) + 1;
      computedTargetCount = Math.floor((modelAction - 1) / 13) + 1;
      isLie = false;
    } 
    // Bluff Play (53~104)
    else if (modelAction >= 53 && modelAction <= 104) {
      declaredNum = ((modelAction - 53) % 13) + 1;
      computedTargetCount = Math.floor((modelAction - 53) / 13) + 1;
      isLie = true;
    } else {
      return { type: 'pass' };
    }

    const fieldCardsCount = room.field.currentCards.length;
    // 場に出ている枚数があれば、その枚数に合わせる必要がある
    const targetCount = fieldCardsCount > 0 ? fieldCardsCount : computedTargetCount;

    const matchingCards = player.hand.filter(c => (c.isJoker ? 0 : c.number) === declaredNum);
    if (!isLie && matchingCards.length >= targetCount) {
        return { type: 'play', cards: matchingCards.slice(0, targetCount), declaredNumber: declaredNum };
    } else {
        const otherCards = player.hand.filter(c => (c.isJoker ? 0 : c.number) !== declaredNum);
        const available = otherCards.length >= targetCount ? otherCards : player.hand;
        if (available.length >= targetCount) {
            return { type: 'play', cards: available.slice(0, targetCount), declaredNumber: declaredNum };
        }
    }
    return { type: 'pass' };
  }

  private static getStateVector(room: Room, player: Player): number[] {
    const vec = new Array(114).fill(0);
    player.hand.forEach(c => {
        let idx = -1;
        const cardMatch = c.id.match(/card-(\d+)/);
        if (cardMatch) idx = parseInt(cardMatch[1]);
        if (idx >= 0 && idx < 54) vec[idx] = 1;
    });
    vec[54] = room.field.declaredNumber;
    vec[55] = room.field.currentCards.length;
    if (room.field.lastPlayerId) {
        const lastIdx = room.turnOrder.indexOf(room.field.lastPlayerId);
        const myIdx = room.turnOrder.indexOf(player.id);
        vec[56] = (lastIdx - myIdx + room.players.length) % room.players.length;
    } else {
        vec[56] = -1;
    }
    let j = 0;
    room.players.forEach(p => {
        if (p.id !== player.id) {
            vec[57 + j] = p.hand.length;
            j++;
        }
    });
    vec[60] = room.rules.isRevolution ? 1 : 0;
    vec[61] = room.rules.isElevenBack ? 1 : 0;
    vec[62] = this.getPhaseIndex(room.phase);

    // faceUpPool information (14 dimensions: idx 63-76)
    room.field.faceUpPool.forEach(c => {
        const num = c.isJoker ? 0 : c.number;
        vec[63 + num] += 1;
    });

    return vec;
  }

  static async runDoubtDecision(room: Room, onDoubtDeclared: (playerId: string) => void, onDoubtResolved: () => void): Promise<void> {
    if (room.phase !== 'doubtPhase') return;
    let session: ort.InferenceSession | null = null;
    try { session = await this.getSession(); } catch (e) {}
    const activeAIs = room.players.filter(p => p.isAI && !p.isOut && p.id !== room.field.lastPlayerId);
    activeAIs.forEach(async ai => {
      if (room.doubtSkippers.includes(ai.id) || room.doubtDeclarers.includes(ai.id)) return;
      if (this.thinkingPlayers.has(ai.id)) return;
      this.thinkingPlayers.add(ai.id);
      const thinkingTime = Math.floor(Math.random() * (room.rules.doubtTime * 1000 * 0.5)) + 1000;
      const stateVector = this.getStateVector(room, ai);
      setTimeout(async () => {
        try {
          if (room.phase !== 'doubtPhase') {
            this.thinkingPlayers.delete(ai.id);
            return;
          }
          let willDoubt = false;
          
          // 1. 確定ダウト（100%証拠に基づく防波堤ロジック）
          const decNum = room.field.declaredNumber;
          const maxCards = decNum === 0 ? 2 : 4;
          const faceUpCount = room.field.faceUpPool.filter(c => (c.isJoker ? 0 : c.number) === decNum).length;
          const myCount = ai.hand.filter(c => (c.isJoker ? 0 : c.number) === decNum).length;
          const playedCount = room.field.currentCards.length;
          
          let isObviousLie = (faceUpCount + myCount + playedCount > maxCards);
          
          // 1-2. スペ3カウンターに対する確実なダウト
          if (room.field.doubtType === 'counter' && decNum === 3 && room.field.currentCards.length === 1) {
            if (ai.hand.some(c => c.suit === 'spade' && c.number === 3)) {
              isObviousLie = true;
            }
          }

          if (isObviousLie) {
            willDoubt = true; // モデルの推論を無視して絶対ダウト
          } else {
            // 2. 確定ではない場合、ルールベース or AIモデルを使用
            if (StrategyEngine.hasData()) {
              try {
                const result = StrategyEngine.shouldDoubt(ai.id, room.field.declaredNumber, room.field.currentCards.length, room.field.faceUpPool, ai.hand, room);
                willDoubt = result.doubt;
              } catch (e) {
                willDoubt = Math.random() < 0.1;
              }
            } else if (session) {
              try {
                const action = await this.predict(session, stateVector);
                willDoubt = (action === 105);
              } catch (e) {
                willDoubt = Math.random() < 0.1;
              }
            } else {
              willDoubt = Math.random() < 0.1;
            }
          }
          if (willDoubt) {
            const success = DoubtManager.registerDoubt(room, ai.id);
            this.thinkingPlayers.delete(ai.id);
            if (success) onDoubtDeclared(ai.id);
          } else {
            const isAllResolved = DoubtManager.registerSkip(room, ai.id);
            this.thinkingPlayers.delete(ai.id);
            if (isAllResolved) onDoubtResolved();
          }
        } catch (err) {
          this.thinkingPlayers.delete(ai.id);
          const isAllResolved = DoubtManager.registerSkip(room, ai.id);
          if (isAllResolved) onDoubtResolved();
        }
      }, thinkingTime);
    });
  }

  static async runCounterDecision(room: Room, onCounterDeclared: (playerId: string) => void, onSkipCounter: () => void): Promise<void> {
    if (room.phase !== 'counterPhase' || room.counterActorIndex === null) return;
    const actorId = room.turnOrder[room.counterActorIndex];
    const player = room.players.find(p => p.id === actorId);
    if (!player || !player.isAI || player.isOut) return;
    if (this.thinkingPlayers.has(actorId)) return;
    this.thinkingPlayers.add(actorId);
    let session: ort.InferenceSession | null = null;
    try { session = await this.getSession(); } catch (e) {}
    const stateVector = this.getStateVector(room, player);
    const thinkingTime = Math.floor(Math.random() * 2000) + 1000;
    setTimeout(async () => {
      try {
        if (room.phase !== 'counterPhase' || room.counterActorIndex === null || room.turnOrder[room.counterActorIndex] !== actorId) {
          this.thinkingPlayers.delete(actorId);
          return;
        }
        let willCounter = false;
        let counterAction = 0;
        if (session) {
          try {
            counterAction = await this.predict(session, stateVector);
            willCounter = (counterAction === 106 || counterAction === 107);
          } catch (e) {}
        }
        let counterCards: Card[] = [];
        if (willCounter) {
          if (counterAction === 106 && room.field.declaredNumber === 8) {
            const fours = player.hand.filter(c => c.number === 4);
            const requiredCount = room.field.currentCards.length + 1;
            if (fours.length >= requiredCount) counterCards = fours.slice(0, requiredCount);
          } else if (counterAction === 107 && room.field.declaredNumber === 0 && room.field.currentCards.length === 1) {
            const spade3 = player.hand.find(c => c.suit === 'spade' && c.number === 3);
            if (spade3) counterCards = [spade3];
          }
        }
        if (!willCounter || counterCards.length === 0) {
          if (this.canCounterHeuristic(room, player) && Math.random() < 0.8) {
            if (room.field.declaredNumber === 8) {
              counterCards = player.hand.filter(c => c.number === 4).slice(0, room.field.currentCards.length + 1);
            } else {
              const s3 = player.hand.find(c => c.suit === 'spade' && c.number === 3);
              if (s3) counterCards = [s3];
            }
          }
        }
        if (counterCards.length > 0) {
          const result = GameEngine.declareCounter(room, actorId, counterCards.map(c => c.id));
          this.thinkingPlayers.delete(actorId);
          if (result.success) onCounterDeclared(actorId);
          else onSkipCounter();
        } else {
          this.thinkingPlayers.delete(actorId);
          onSkipCounter();
        }
      } catch (err) {
        this.thinkingPlayers.delete(actorId);
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
      const isReversed = room.rules.isRevolution !== room.rules.isElevenBack;
      availableNumbers.sort((a, b) => {
        let rankA = (a === 2) ? 15 : (a === 1 ? 14 : a);
        let rankB = (b === 2) ? 15 : (b === 1 ? 14 : b);
        if (isReversed) {
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
      if (isFieldEmpty && player.hand.length > 0) {
        const firstCard = player.hand[0];
        return { type: 'play', cards: [firstCard], declaredNumber: firstCard.isJoker ? 0 : firstCard.number };
      }
      return { type: 'pass' };
    }
  }

  static runEffectDecision(room: Room, onAction: () => void): void {
    if (room.phase !== 'effectPhase' || !room.pendingEffect) return;
    const effect = room.pendingEffect;
    const player = room.players.find(p => p.id === effect.playerId);
    if (!player || !player.isAI || player.isOut) return;
    if (this.thinkingPlayers.has(player.id)) return;
    this.thinkingPlayers.add(player.id);
    const thinkingTime = Math.floor(Math.random() * 2000) + 1000;
    setTimeout(async () => {
      try {
        if (room.phase !== 'effectPhase' || room.pendingEffect !== effect) {
          this.thinkingPlayers.delete(player.id);
          return;
        }
        let session: ort.InferenceSession | null = null;
        try { session = await this.getSession(); } catch (e) {}
        const cardIds: string[] = [];
        let targetData: { numbers?: number[] } | undefined;
        let modelAction = -1;
        if (session) {
            const stateVector = this.getStateVector(room, player);
            try { modelAction = await this.predict(session, stateVector); } catch (e) {}
        }
        switch (effect.type) {
          case 'sevenPass':
          case 'doubtCardSelect':
          case 'tenDiscard': {
            const count = Math.min(effect.count, player.hand.length);
            if (count > 0) {
              if (modelAction >= 122 && modelAction <= 175) {
                const cardIdx = Math.min(modelAction - 122, player.hand.length - 1);
                cardIds.push(player.hand[cardIdx].id);
              } else {
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
            if (modelAction >= 108 && modelAction <= 121) {
               targetData = { numbers: [modelAction - 107 === 14 ? 0 : modelAction - 107] };
            } else {
               targetData = { numbers: [Math.floor(Math.random() * 13) + 1] };
            }
            break;
          }
        }
        GameEngine.handleEffectAction(room, effect.playerId, cardIds, targetData);
        this.thinkingPlayers.delete(player.id);
        onAction();
      } catch (err) {
        this.thinkingPlayers.delete(player.id);
        onAction();
      }
    }, thinkingTime);
  }
}
