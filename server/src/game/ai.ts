import { Room, Player, Card } from './types';
import { GameEngine } from './engine';
import { DoubtManager } from './doubt';
import { getCardStrength, validatePlayCards } from './validator';
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
    const configuredModel = process.env.DOUBT_ROYALE_MODEL;
    if (configuredModel) {
      const configuredPath = path.isAbsolute(configuredModel)
        ? configuredModel
        : path.resolve(cwd, configuredModel);
      if (require('fs').existsSync(configuredPath)) {
        console.log(`AI Engine: Using configured model at ${configuredPath}`);
        return configuredPath;
      }
      console.warn(`AI Engine: Configured model not found at ${configuredPath}; falling back to default model search.`);
    }

    const modelNames = [
      'doubt_royale_latest.onnx',
      'doubt_royale_v15_ep267000.onnx',
      'doubt_royale_v15_ep91000.onnx',
      'doubt_royale_v15_ep27000.onnx',
      'doubt_royale_v15_ep19000.onnx',
      'doubt_royale_v15_ep25000.onnx',
      'doubt_royale_v15_ep6000.onnx',
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
    const thinkingTime = Math.floor(Math.random() * 2000) + 1500;
    
    setTimeout(async () => {
      try {
        if (room.phase !== 'playing' || room.turnOrder[room.currentPlayerIndex] !== playerId) {
          this.thinkingPlayers.delete(playerId);
          return;
        }
        
        let action: { type: 'play' | 'pass', cards?: Card[], declaredNumber?: number };

        if (session) {
          try {
            const result = await this.predict(session, stateVector, this.getAllowedModelActions(room, player));
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
              if (!validation.valid) {
                 if (StrategyEngine.hasData()) {
                    action = StrategyEngine.decidePlay(playerId, room, player);
                 } else {
                    action = this.decidePlayActionHeuristic(room, player);
                 }
              }
            }
          } catch (e) {
             if (StrategyEngine.hasData()) {
                action = StrategyEngine.decidePlay(playerId, room, player);
             } else {
                action = this.decidePlayActionHeuristic(room, player);
             }
          }
        } else if (StrategyEngine.hasData()) {
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
        } else {
          action = this.decidePlayActionHeuristic(room, player);
        }
        
        const isFieldEmpty = room.field.currentCards.length === 0 || room.field.lastPlayerId === null || room.field.lastPlayerId === player.id;
        if (action.type === 'pass' && isFieldEmpty && player.hand.length > 0) {
          console.warn(`[AI Guard] AI tried to PASS on empty field. Forcing play.`);
          if (StrategyEngine.hasData()) {
             action = StrategyEngine.decidePlay(playerId, room, player);
             if (action.type === 'pass') action = this.decidePlayActionHeuristic(room, player);
          } else {
             action = this.decidePlayActionHeuristic(room, player);
          }
          // Final sanity check: if still pass, force first card
          if (action.type === 'pass' && player.hand.length > 0) {
            action = { type: 'play', cards: [player.hand[0]], declaredNumber: player.hand[0].isJoker ? 0 : player.hand[0].number };
          }
        }

        // Strategic pass: if AI can only bluff (no honest play), sometimes pass instead
        if (action.type === 'play' && action.cards && !isFieldEmpty) {
          const declaredNum = action.declaredNumber!;
          const isHonest = action.cards.every(c => (c.isJoker ? 0 : c.number) === declaredNum);
          const isJokerPlay = declaredNum === 0;
          if (!isHonest || isJokerPlay) {
            // Pass ~40% of the time when bluffing, ~60% when playing Joker
            const passChance = isJokerPlay ? 0.6 : 0.4;
            if (Math.random() < passChance) {
              action = { type: 'pass' };
            }
          }
        }

        if (action.type === 'pass') {
          const result = GameEngine.passTurn(room, playerId);
          if (!result.success) {
            console.error(`[AI Error] Pass failed for ${playerId}: ${result.error}. Forcing sync.`);
          }
          wrappedOnAction('pass', result);
        } else if (action.type === 'play' && action.cards) {
          const result = GameEngine.playCards(room, playerId, action.cards.map(c => c.id), action.declaredNumber!);
          wrappedOnAction('play', result);
        } else {
          const result = GameEngine.passTurn(room, playerId);
          wrappedOnAction('pass', result);
        }
      } catch (err) {
        console.error(`[AI Crash] ${playerId}:`, err);
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
      case 'q_bomb': return 3;
      case 'effectPhase': return 4;
      case 'card_sel': return 4;
      case 'six_absorb': return 5;
      default: return 0;
    }
  }

  private static async predict(session: ort.InferenceSession, state: number[], allowedActions?: number[]): Promise<number> {
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
    const candidates = allowedActions
      ? allowedActions.filter(action => Number.isInteger(action) && action >= 0 && action < outputData.length)
      : Array.from({ length: outputData.length }, (_, action) => action);
    if (candidates.length === 0) {
      throw new Error('No legal model actions are available for this game state.');
    }
    let maxIdx = candidates[0];
    for (const action of candidates.slice(1)) {
      if (outputData[action] > outputData[maxIdx]) maxIdx = action;
    }
    return maxIdx;
  }

  /**
   * Get the Critic (Value) output from the model for a given state.
   * Returns the raw value estimate (expected cumulative reward).
   */
  private static async getCriticValue(session: ort.InferenceSession, state: number[]): Promise<number> {
    const input = new ort.Tensor('float32', new Float32Array(state), [1, 114]);
    const results = await session.run({ input });
    
    // The ActorCriticNet outputs: [action_probs, critic_value]
    // In ONNX, these become output names like 'output' and 'output_1',
    // or numbered outputs depending on export settings.
    const outputKeys = Object.keys(results);
    
    // Try to find the critic output (second output, scalar value)
    for (const key of outputKeys) {
      const data = results[key].data as Float32Array;
      // Critic output is a single scalar value (shape [1,1])
      if (data.length === 1) {
        return data[0];
      }
    }
    
    // Fallback: if we can't find a scalar output, try the last key
    if (outputKeys.length >= 2) {
      const lastKey = outputKeys[outputKeys.length - 1];
      return (results[lastKey].data as Float32Array)[0];
    }
    
    return 0; // No critic value available
  }

  /**
   * Convert raw critic value to a win rate percentage (0-100).
   * Based on normalized reward range: win=+1.0, lose=-1.0
   */
  private static criticToWinRate(value: number): number {
    // Clamp to expected range and normalize to 0-100%
    const clamped = Math.max(-1.0, Math.min(1.0, value));
    return Math.round(((clamped + 1.0) / 2.0) * 100);
  }

  /**
   * Update win rates for all active players in the room.
  /**
   * Synchronous heuristic-based win rate calculation for immediate UI feedback.
   */
  static calculateSnapshotWinRates(room: Room): Record<string, number> {
    const activePlayers = room.players.filter(p => !p.isOut && p.lives > 0);
    if (activePlayers.length === 0) return {};

    let totalScore = 0;
    const scores: Record<string, number> = {};

    for (const p of activePlayers) {
      // Score based on hand size (fewer cards = better)
      const handScore = Math.pow(Math.max(1, 20 - p.hand.length), 1.5) * 5;
      // Score based on lives
      const lifeScore = p.lives * 40;
      // Score based on card quality
      const cardQuality = p.hand.reduce((acc, c) => {
        if (c.isJoker) return acc + 50;
        if (c.number === 2) return acc + 30; // 2 is strong
        if (c.number === 1) return acc + 20; // 1 is strong
        if (c.number === 8 || c.number === 11 || c.number === 3 || c.number === 7) return acc + 10;
        return acc + 5;
      }, 0);

      const score = handScore + lifeScore + cardQuality;
      scores[p.id] = score;
      totalScore += score;
    }

    const rates: Record<string, number> = {};
    for (const p of activePlayers) {
      rates[p.id] = Math.max(1, Math.min(99, Math.round((scores[p.id] / totalScore) * 100)));
    }
    return rates;
  }

  /**
   * Deep Nash RL-based win rate calculation.
   * Called asynchronously after state changes; results are cached in room.winRates.
   */
  static async updateWinRates(room: Room): Promise<void> {
    if (!room.winRates) room.winRates = {};
    
    let session: ort.InferenceSession | null = null;
    try {
      session = await this.getSession();
    } catch (e) {}

    const activePlayers = room.players.filter(p => !p.isOut);
    if (activePlayers.length === 0) return;

    if (!session) {
      room.winRates = this.calculateSnapshotWinRates(room);
      return;
    }

    try {
      const rates: Record<string, number> = {};
      for (const player of activePlayers) {
        const stateVector = this.getStateVector(room, player);
        const criticValue = await this.getCriticValue(session, stateVector);
        rates[player.id] = this.criticToWinRate(criticValue);
      }
      room.winRates = rates;
      console.log(`[AI WinRate] Calculated room ${room.id} (${activePlayers.length} active)`);
    } catch (e) {
      console.error('[AI] Failed to update model-based win rates:', e);
    }
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

    // Q-Bomber awareness & impossible play prevention
    if (this.isNumberExposedInFaceUp(room, player, declaredNum)) {
      return { type: 'pass' };
    }
    
    // Logic Guard: Prevent physically impossible declarations (Always 100% lie)
    const maxAvailableInDeck = (declaredNum === 0 ? 2 : 4);
    if (computedTargetCount > maxAvailableInDeck) {
        // AI model tried to play impossible count (like 3 Jokers). Force into 1 or 2.
        computedTargetCount = maxAvailableInDeck;
    }

    const fieldCardsCount = room.field.currentCards.length;
    // The training action encodes both the declared rank and card count.
    // Keep that count valid on the field as well as on an empty lead.
    if (fieldCardsCount > 0 && computedTargetCount !== fieldCardsCount) return { type: 'pass' };
    const targetCount = computedTargetCount;

    let selectedCards: Card[] = [];
    if (!isLie) {
      const matchingCards = player.hand.filter(c => !c.isJoker && c.number === declaredNum);
      const jokers = player.hand.filter(c => c.isJoker);
      if (matchingCards.length >= targetCount) {
        selectedCards = matchingCards.slice(0, targetCount);
      } else if (matchingCards.length + jokers.length >= targetCount) {
        selectedCards = [...matchingCards, ...jokers.slice(0, targetCount - matchingCards.length)];
      }
    } else {
      const byStrength = (a: Card, b: Card) =>
        getCardStrength(a.isJoker ? 0 : a.number, room.rules) - getCardStrength(b.isJoker ? 0 : b.number, room.rules);
      const otherCards = player.hand
        .filter(c => (c.isJoker ? 0 : c.number) !== declaredNum)
        .sort(byStrength);
      const available = otherCards.length >= targetCount ? otherCards : [...player.hand].sort(byStrength);
      if (available.length >= targetCount) selectedCards = available.slice(0, targetCount);
    }
    if (selectedCards.length === targetCount) {
      return { type: 'play', cards: selectedCards, declaredNumber: declaredNum };
    }
    return { type: 'pass' };
  }

  /**
   * Check if a declared number would be an obvious lie because too many of that number
   * are already visible in the face-up pool + the player's own hand.
   */
  private static isNumberExposedInFaceUp(room: Room, player: Player, declaredNum: number): boolean {
    const maxCards = declaredNum === 0 ? 2 : 4; // Joker: 2, others: 4
    const faceUpCount = room.field.faceUpPool.filter(c => (c.isJoker ? 0 : c.number) === declaredNum).length;
    const myCount = player.hand.filter(c => (c.isJoker ? 0 : c.number) === declaredNum).length;
    // If all copies are accounted for between faceUp and our hand, declaring more would be obvious
    return (faceUpCount + myCount >= maxCards) && myCount === 0;
  }

  private static getStateVector(room: Room, player: Player, phaseOverride?: string): number[] {
    const vec = new Array(114).fill(0);
    player.hand.forEach(c => {
        let idx = -1;
        const cardMatch = c.id.match(/card-(\d+)/);
        if (cardMatch) idx = parseInt(cardMatch[1]);
        if (idx >= 0 && idx < 54) vec[idx] = 1;
    });
    vec[54] = room.field.declaredNumber / 13;
    vec[55] = room.field.currentCards.length / 4;
    if (room.field.lastPlayerId) {
        const lastIdx = room.turnOrder.indexOf(room.field.lastPlayerId);
        vec[56] = (lastIdx + 1) / 4;
    } else {
        vec[56] = 0;
    }
    let j = 0;
    room.players.forEach(p => {
        if (p.id !== player.id && j < 3) {
            vec[57 + j] = p.hand.length / 54;
            j++;
        }
    });
    vec[60] = room.rules.isRevolution ? 1 : 0;
    vec[61] = room.rules.isElevenBack ? 1 : 0;
    vec[62] = this.getPhaseIndex(phaseOverride || room.phase) / 5;

    // faceUpPool information (14 dimensions: idx 63-76)
    room.field.faceUpPool.forEach(c => {
        const num = c.isJoker ? 0 : c.number;
        vec[63 + num] += 0.25;
    });

    const reversed = room.rules.isRevolution !== room.rules.isElevenBack;
    vec[77] = player.hand.length === 0
      ? 1
      : player.hand.reduce((sum, card) => {
          if (card.isJoker) return sum + 14;
          const value = card.number < 3 ? card.number - 3 + 13 : card.number - 3;
          return sum + (reversed ? 13 - value : value);
        }, 0) / (player.hand.length * 14);

    const declared = room.field.declaredNumber;
    if (declared > 0) {
      const maxCopies = 4;
      const visible = room.field.faceUpPool.filter(c => !c.isJoker && c.number === declared).length;
      const held = player.hand.filter(c => !c.isJoker && c.number === declared).length;
      vec[78] = visible + held + room.field.currentCards.length > maxCopies ? 1 : 0;
    }

    const handCounts = new Array(14).fill(0);
    player.hand.forEach(card => { handCounts[card.isJoker ? 0 : card.number] += 1; });
    for (let n = 0; n < 14; n++) vec[82 + n] = handCounts[n] / 4;
    vec[96] = room.rules.direction === -1 ? 1 : 0;

    return vec;
  }

  private static getAllowedModelActions(room: Room, player: Player, effectType?: string): number[] {
    if (room.phase === 'playing') {
      const allowed: number[] = [];
      const fieldIsActive = room.field.currentCards.length > 0 && room.field.lastPlayerId !== player.id;
      if (fieldIsActive) allowed.push(0);

      for (let action = 1; action <= 104; action++) {
        const mapped = this.mapActionToGame(room, player, action);
        if (mapped.type !== 'play' || !mapped.cards || mapped.cards.length === 0) continue;
        const validation = validatePlayCards(
          mapped.cards,
          mapped.declaredNumber!,
          {
            currentCardCount: room.field.currentCards.length,
            declaredNumber: room.field.declaredNumber,
            lastPlayerId: room.field.lastPlayerId,
          },
          room.rules
        );
        if (validation.valid) allowed.push(action);
      }
      return allowed;
    }

    if (room.phase === 'doubtPhase') return [0, 105];

    if (room.phase === 'counterPhase') {
      const allowed = [0];
      if (room.field.declaredNumber === 8) {
        const requiredCount = room.field.currentCards.length + 1;
        const fours = player.hand.filter(card => !card.isJoker && card.number === 4).length;
        if (fours >= requiredCount) allowed.push(106);
      } else if (room.field.declaredNumber === 0 && room.field.currentCards.length === 1) {
        if (player.hand.some(card => card.suit === 'spade' && card.number === 3 && !card.isJoker)) allowed.push(107);
      }
      return allowed;
    }

    if (room.phase === 'effectPhase') {
      if (effectType === 'queenBomber') return Array.from({ length: 14 }, (_, index) => 108 + index);
      if (effectType === 'sixCollect') {
        const allowed = Array.from({ length: Math.min(room.field.faceUpPool.length, 54) }, (_, index) => 122 + index);
        if (room.field.faceUpPool.length < 54) allowed.push(175);
        return allowed.length > 0 ? allowed : [175];
      }
      if (effectType === 'sevenPass' || effectType === 'tenDiscard') {
        const count = Math.min(player.hand.length, 54);
        const allowed = count > 0 ? Array.from({ length: count }, (_, index) => 122 + index) : [];
        if (count < 54) allowed.push(175);
        return allowed;
      }
    }

    return [0];
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
      const thinkingTime = Math.floor(Math.random() * (room.rules.doubtTime * 1000 * 0.4)) + 1200;
      const stateVector = this.getStateVector(room, ai);
      setTimeout(async () => {
        try {
          if (room.phase !== 'doubtPhase' || ai.isOut) {
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
                const action = await this.predict(session, stateVector, [0, 105]);
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
        if (room.phase !== 'counterPhase' || room.counterActorIndex === null || room.turnOrder[room.counterActorIndex] !== actorId || player.isOut) {
          this.thinkingPlayers.delete(actorId);
          return;
        }
        let willCounter = false;
        let counterAction = 0;
        if (session) {
          try {
            counterAction = await this.predict(session, stateVector, this.getAllowedModelActions(room, player));
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

    // Filter out numbers that are fully exposed in faceUpPool (Q-Bomber destroyed)
    const safeNumbers = (nums: number[]) => nums.filter(n => !this.isNumberExposedInFaceUp(room, player, n));

    if (isFieldEmpty) {
      let availableNumbers = Array.from(handByNumber.keys()).filter(n => n !== 0);
      availableNumbers = safeNumbers(availableNumbers);
      if (availableNumbers.length === 0) {
        // Fall back to all non-joker numbers, then joker
        availableNumbers = Array.from(handByNumber.keys()).filter(n => n !== 0);
        if (availableNumbers.length === 0) availableNumbers = [0];
      }
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
      return { type: 'play', cards: cards, declaredNumber: numToPlay };
    } else {
      const targetCount = fieldCardsCount;
      const currentDeclared = room.field.declaredNumber;
      for (const [num, cards] of Array.from(handByNumber.entries())) {
        if (num === 0) continue; // Skip Jokers in normal iteration
        if (this.isNumberExposedInFaceUp(room, player, num)) continue;
        if (cards.length >= targetCount) {
          const selectedCards = cards.slice(0, targetCount);
          const validation = validatePlayCards(selectedCards, num, { currentCardCount: targetCount, declaredNumber: currentDeclared, lastPlayerId: room.field.lastPlayerId }, room.rules);
          if (validation.valid) return { type: 'play', cards: selectedCards, declaredNumber: num };
        }
      }
      if (isFieldEmpty && player.hand.length > 0) {
        const numToPlay = player.hand[0].isJoker ? 0 : player.hand[0].number;
        const cardsToPlay = handByNumber.get(numToPlay) || [player.hand[0]];
        return { type: 'play', cards: cardsToPlay, declaredNumber: numToPlay };
      }
      return { type: 'pass' };
    }
  }

  static runEffectDecision(room: Room, onAction: () => void): void {
    if (room.phase !== 'effectPhase' || !room.pendingEffect) return;
    const effect = room.pendingEffect;
    const player = room.players.find(p => p.id === effect.playerId);
    if (!player || !player.isAI) return;
    // Allow isOut player to process if they are the target of the effect (e.g. giving cards after winning)
    if (player.isOut && room.pendingEffect.playerId !== player.id) return;
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
        const modelPhase = effect.type === 'queenBomber'
          ? 'q_bomb'
          : effect.type === 'sixCollect'
            ? 'six_absorb'
            : 'card_sel';
        if (session && effect.type !== 'doubtCardSelect' && effect.type !== 'queenBomber') {
            const stateVector = this.getStateVector(room, player, modelPhase);
            try {
              modelAction = await this.predict(session, stateVector, this.getAllowedModelActions(room, player, effect.type));
            } catch (e) {}
        }
        switch (effect.type) {
          case 'sevenPass':
          case 'doubtCardSelect':
          case 'tenDiscard': {
            const count = Math.min(effect.count, player.hand.length);
            if (count > 0) {
              if (modelAction >= 122 && modelAction <= 175) {
                if (!(modelAction === 175 && player.hand.length < 54)) {
                  const cardIdx = Math.min(modelAction - 122, player.hand.length - 1);
                  cardIds.push(player.hand[cardIdx].id);
                }
              }
              const modelPassed = modelAction === 175 && player.hand.length < 54;
              if (!modelPassed) {
                const sortedHand = [...player.hand].sort((a, b) => {
                  const getStrength = (c: Card) => {
                    if (c.isJoker) return 100;
                    if (c.suit === 'spade' && c.number === 3) return 90;
                    if (c.number === 2) return 80;
                    if (c.number === 1) return 70;
                    if (c.number === 8 || c.number === 11) return 60;
                    return c.number;
                  };
                  return getStrength(a) - getStrength(b);
                });
                const excludedNumbers = (effect as any).excludedNumbers as number[] | undefined;
                const availableCards = excludedNumbers
                  ? sortedHand.filter(c => !excludedNumbers.includes(c.number) && !(excludedNumbers.includes(0) && c.isJoker))
                  : sortedHand;
                for (const card of availableCards) {
                  if (cardIds.length >= count) break;
                  if (!cardIds.includes(card.id)) cardIds.push(card.id);
                }
              }
            }
            break;
          }
          case 'sixCollect': {
            const count = Math.min(effect.count, room.field.faceUpPool.length);
            if (count > 0) {
              if (modelAction >= 122 && modelAction <= 175 && modelAction - 122 < room.field.faceUpPool.length) {
                cardIds.push(room.field.faceUpPool[modelAction - 122].id);
              }
              const modelPassed = modelAction === 175 && room.field.faceUpPool.length < 54;
              const sortedPool = [...room.field.faceUpPool].sort((a, b) => {
                let rankA = (a.number === 2) ? 15 : (a.number === 1 ? 14 : (a.isJoker ? 16 : a.number));
                let rankB = (b.number === 2) ? 15 : (b.number === 1 ? 14 : (b.isJoker ? 16 : b.number));
                if (room.rules.isRevolution) {
                  rankA = (a.number === 2) ? -15 : (a.number === 1 ? -14 : (a.isJoker ? 16 : -a.number));
                  rankB = (b.number === 2) ? -15 : (b.number === 1 ? -14 : (b.isJoker ? 16 : -b.number));
                }
                return rankB - rankA;
              });
              
              // Only pick decent cards (rank logic: 8 or above in normal strength)
              for (let i = 0; i < count; i++) {
                const c = sortedPool[i];
                if (cardIds.includes(c.id)) continue;
                let rank = (c.number === 2) ? 15 : (c.number === 1 ? 14 : (c.isJoker ? 16 : c.number));
                if (room.rules.isRevolution) {
                  rank = (c.number === 2) ? -15 : (c.number === 1 ? -14 : (c.isJoker ? 16 : -c.number));
                }
                
                // If it's a weak card, do not pick it up (unless it's revolution where negatives are stronger but we check rank size)
                // Simplified decent logic: the cards are already sorted strongest first.
                // If the strongest available isn't that great, we stop collecting.
                if (!modelPassed && cardIds.length < count && ((!room.rules.isRevolution && rank >= 8) || (room.rules.isRevolution && rank >= -8) || c.isJoker)) {
                   cardIds.push(c.id);
                }
              }
            }
            break;
          }
          case 'queenBomber': {
            const numCount = effect.count;
            const targetNumbers: number[] = [];

            // Q-bomb training chooses one distinct rank at a time, with the
            // observation updated after each simulated removal. Mirror that here.
            const simulatedRoom = session ? {
              ...room,
              players: room.players.map(p => ({ ...p, hand: [...p.hand] })),
              field: { ...room.field, faceUpPool: [...room.field.faceUpPool] },
            } as Room : null;
            const selectedNumbers = new Set<number>();
            while (targetNumbers.length < numCount && selectedNumbers.size < 14) {
              let chosenNum: number | undefined;
              if (session && simulatedRoom) {
                const simulatedPlayer = simulatedRoom.players.find(p => p.id === player.id);
                if (simulatedPlayer) {
                  const allowed = this.getAllowedModelActions(simulatedRoom, simulatedPlayer, effect.type)
                    .filter(action => !selectedNumbers.has(action === 121 ? 0 : action - 107));
                  try {
                    const state = this.getStateVector(simulatedRoom, simulatedPlayer, 'q_bomb');
                    const action = await this.predict(session, state, allowed);
                    chosenNum = action === 121 ? 0 : action - 107;
                  } catch (e) {}
                }
              }
              if (chosenNum === undefined || chosenNum < 0 || chosenNum > 13 || selectedNumbers.has(chosenNum)) {
                const available = Array.from({ length: 14 }, (_, n) => n).filter(n => !selectedNumbers.has(n));
                if (available.length === 0) break;
                chosenNum = available[Math.floor(Math.random() * available.length)];
              }
              const targetNum = chosenNum;
              selectedNumbers.add(targetNum);
              targetNumbers.push(targetNum);

              if (simulatedRoom) {
                for (const simulatedPlayer of simulatedRoom.players) {
                  if (simulatedPlayer.isOut) continue;
                  const removed = simulatedPlayer.hand.filter(card =>
                    targetNum === 0 ? card.isJoker : !card.isJoker && card.number === targetNum
                  );
                  simulatedPlayer.hand = simulatedPlayer.hand.filter(card => !removed.some(drop => drop.id === card.id));
                  simulatedRoom.field.faceUpPool.push(...removed);
                }
              }
            }
            
            targetData = { numbers: targetNumbers };
            break;
          }
        }
        
        // If hand is empty (already out), we send empty card list to proceed
        if (player.hand.length === 0 && effect.type === 'doubtCardSelect') {
          console.log(`[AI Guard] Empty hand AI completing doubt penalty.`);
          GameEngine.handleEffectAction(room, effect.playerId, [], targetData);
        } else {
          GameEngine.handleEffectAction(room, effect.playerId, cardIds, targetData);
        }
        
        this.thinkingPlayers.delete(player.id);
        onAction();
      } catch (err) {
        this.thinkingPlayers.delete(player.id);
        onAction();
      }
    }, thinkingTime);
  }
}
