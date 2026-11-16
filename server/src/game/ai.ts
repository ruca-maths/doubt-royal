import { Room, Player, Card } from './types';
import { GameEngine } from './engine';
import { DoubtManager } from './doubt';
import { getCardStrength, validatePlayCards } from './validator';
import { BotPolicy } from './botPolicy';
import { Brain } from './brain/brain';
import type * as ort from 'onnxruntime-node';
import path from 'path';

type PlayAction = { type: 'play' | 'pass'; cards?: Card[]; declaredNumber?: number };


export class AIEngine {
  private static thinkingPlayers = new Set<string>();
  private static session: ort.InferenceSession | null = null;
  private static sessionPromise: Promise<ort.InferenceSession | null> | null = null;

  private static ortRuntime: typeof ort | null = null;

  // The built-in policy works without a model; trained models are opt-in.
  private static shouldUseTrainedModel(): boolean {
    return process.env.DOUBT_ROYALE_USE_MODEL === 'true';
  }

  /** onnxruntime is only loaded when a trained model is actually requested. */
  private static runtime(): typeof ort {
    if (!this.ortRuntime) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.ortRuntime = require('onnxruntime-node') as typeof ort;
    }
    return this.ortRuntime;
  }

  // ===== Default CPU policy: Brain (card counting + expected value). =====
  // BotPolicy (the previous rule-based CPU) is kept as a safety net if Brain ever throws.

  private static policyPlay(room: Room, player: Player): PlayAction {
    try {
      return Brain.decidePlay(room, player);
    } catch (err) {
      console.error('[AI Brain] decidePlay failed, falling back:', err);
      return BotPolicy.decidePlay(room, player);
    }
  }

  private static policyDoubt(room: Room, player: Player): boolean {
    try {
      return Brain.shouldDoubt(room, player);
    } catch (err) {
      console.error('[AI Brain] shouldDoubt failed, falling back:', err);
      return BotPolicy.shouldDoubt(room, player);
    }
  }

  private static policyCounter(room: Room, player: Player): Card[] {
    try {
      return Brain.chooseCounter(room, player);
    } catch (err) {
      console.error('[AI Brain] chooseCounter failed, falling back:', err);
      return BotPolicy.chooseCounter(room, player);
    }
  }

  static clearThinkingPlayers(): void {
    console.log('[AI Engine] Clearing thinking players guard.');
    this.thinkingPlayers.clear();
  }

  static initializeStrategy(room: Room): void {
    Brain.resetRoom(room.id);
    const count = room.players.filter(player => player.isAI).length;
    console.log(`[AI Engine] Initialized Brain policy for ${count} CPU player(s).`);
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
        this.session = await this.runtime().InferenceSession.create(modelPath);
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
    if (this.shouldUseTrainedModel()) {
      try {
        session = await this.getSession();
      } catch (err) {}
    }

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
              if (!validation.valid) action = this.policyPlay(room, player);
            }
          } catch (e) {
             action = this.policyPlay(room, player);
          }
        } else {
          action = this.policyPlay(room, player);
        }
        
        const isFieldEmpty = room.field.currentCards.length === 0 || room.field.lastPlayerId === null || room.field.lastPlayerId === player.id;
        if (action.type === 'pass' && isFieldEmpty && player.hand.length > 0) {
          console.warn(`[AI Guard] AI tried to PASS on empty field. Forcing play.`);
          action = this.policyPlay(room, player);
          // Final sanity check: if still pass, force first card
          if (action.type === 'pass' && player.hand.length > 0) {
            action = { type: 'play', cards: [player.hand[0]], declaredNumber: player.hand[0].isJoker ? 0 : player.hand[0].number };
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
    const input = new (this.runtime().Tensor)('float32', new Float32Array(state), [1, 114]);
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
    const input = new (this.runtime().Tensor)('float32', new Float32Array(state), [1, 114]);
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
    // "Turns needed to go out" based estimate (see brain/evaluate.ts). Spectators only.
    return Brain.estimateWinRates(room);
  }

  /**
   * Deep Nash RL-based win rate calculation.
   * Called asynchronously after state changes; results are cached in room.winRates.
   */
  static async updateWinRates(room: Room): Promise<void> {
    if (!room.winRates) room.winRates = {};
    
    let session: ort.InferenceSession | null = null;
    if (this.shouldUseTrainedModel()) {
      try {
        session = await this.getSession();
      } catch (e) {}
    }

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
    if (this.shouldUseTrainedModel()) {
      try { session = await this.getSession(); } catch (e) {}
    }
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
          
          if (session) {
            if (BotPolicy.isProvableLie(room, ai)) {
              willDoubt = true;
            } else {
              try {
                const action = await this.predict(session, stateVector, [0, 105]);
                willDoubt = (action === 105);
              } catch (e) {
                willDoubt = this.policyDoubt(room, ai);
              }
            }
          } else {
            willDoubt = this.policyDoubt(room, ai);
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
    if (this.shouldUseTrainedModel()) {
      try { session = await this.getSession(); } catch (e) {}
    }
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
        if (counterCards.length === 0) counterCards = this.policyCounter(room, player);
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

  static decidePlayActionHeuristic(room: Room, player: Player): { type: 'play' | 'pass', cards?: Card[], declaredNumber?: number } {
    return this.policyPlay(room, player);
  }

  static runEffectDecision(room: Room, onAction: () => void): void {
    if (room.phase !== 'effectPhase' || !room.pendingEffect) return;
    const effect = room.pendingEffect;
    const player = room.players.find(p => p.id === effect.playerId);
    if (!player || !player.isAI || this.thinkingPlayers.has(player.id)) return;

    this.thinkingPlayers.add(player.id);
    const thinkingTime = Math.floor(Math.random() * 1000) + 700;
    setTimeout(() => {
      try {
        if (room.phase !== 'effectPhase' || room.pendingEffect !== effect) return;
        let action: { cardIds: string[]; targetData?: { numbers?: number[] } };
        try {
          action = Brain.chooseEffect(room, player, effect);
        } catch (err) {
          console.error('[AI Brain] chooseEffect failed, falling back:', err);
          action = BotPolicy.chooseEffect(room, player, effect);
        }
        const result = GameEngine.handleEffectAction(room, effect.playerId, action.cardIds, action.targetData);
        if (!result.success) console.error(`[AI Effect] ${player.name}: ${result.error}`);
        onAction();
      } catch (err) {
        console.error(`[AI Effect] ${player.name}:`, err);
        onAction();
      } finally {
        this.thinkingPlayers.delete(player.id);
      }
    }, thinkingTime);
  }


}
