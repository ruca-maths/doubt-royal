/**
 * Doubt Royale - データ蓄積型戦略立案エンジン
 * 
 * 学習スクリプト(colab_strategy_training.py)で生成された統計データを基に、
 * カード配布時に最適戦略を推考し、ダウト/ブラフの確率的判断を行う。
 */

import { Card, Room, Player, FieldState, RulesState } from './types';
import { getCardStrength, validatePlayCards, checkForbiddenFinish } from './validator';
import * as fs from 'fs';
import * as path from 'path';

// ===== 型定義 =====

/** 1ステップの出し順計画 */
export interface PlayStep {
  cards: Card[];          // 出すカードのリスト
  declaredNumber: number; // 宣言する数字
  isBluff: boolean;       // ブラフかどうか
  priority: number;       // 優先度 (高いほど優先)
}

/** 手札全体の出し順計画 */
export interface PlayPlan {
  steps: PlayStep[];        // 出すカードの順序
  currentStepIndex: number; // 現在のステップ
  isValid: boolean;         // まだ計画が有効か
}

/** 統計データの型 */
interface StrategyData {
  version: number;
  doubt_threshold: number;
  bluff_threshold: number;
  lie_probability: Record<string, number>;
  bluff_success_rate: Record<string, number>;
  play_sequence_weights: Record<string, number>;
  hand_pattern_win_rate: Record<string, number>;
  counter_stats: {
    opportunities: number;
    counter_count: number;
    success_after: number;
  };
}

/** カードの追跡情報（他プレイヤーが確実に持っているカード） */
interface CardTracker {
  /** プレイヤーID → 確実に持っている数字のリスト */
  knownCards: Map<string, number[]>;
  /** 表墓地にある各数字の枚数 */
  faceUpCounts: Map<number, number>;
}

// ===== 戦略エンジン本体 =====

export class StrategyEngine {
  private static data: StrategyData | null = null;
  private static dataLoaded = false;
  /** 各AIプレイヤーの現在の出し順計画 */
  private static plans = new Map<string, PlayPlan>();
  /** 各AIプレイヤーのカード追跡情報 */
  private static trackers = new Map<string, CardTracker>();

  // ===== データ読み込み =====

  static loadStrategyData(): boolean {
    if (this.dataLoaded) return this.data !== null;

    const cwd = process.cwd();
    const pathsToTry = [
      path.join(cwd, 'strategy_data_v1.json'),
      path.join(cwd, 'server', 'strategy_data_v1.json'),
      path.join(cwd, 'server', 'rl', 'strategy_data_v1.json'),
      path.join(__dirname, '..', '..', 'strategy_data_v1.json'),
      path.join(__dirname, '..', '..', 'rl', 'strategy_data_v1.json'),
    ];

    for (const p of pathsToTry) {
      try {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf-8');
          this.data = JSON.parse(raw) as StrategyData;
          this.dataLoaded = true;
          console.log(`[Strategy] Loaded strategy data from ${p}`);
          console.log(`[Strategy]   doubt_threshold=${this.data.doubt_threshold}, bluff_threshold=${this.data.bluff_threshold}`);
          console.log(`[Strategy]   lie_probability entries: ${Object.keys(this.data.lie_probability).length}`);
          return true;
        }
      } catch (e) {
        console.error(`[Strategy] Failed to load from ${p}:`, e);
      }
    }

    this.dataLoaded = true;
    console.warn('[Strategy] No strategy_data_v1.json found. Using defaults.');
    return false;
  }

  static hasData(): boolean {
    if (!this.dataLoaded) this.loadStrategyData();
    return this.data !== null;
  }

  // ===== 計画管理 =====

  /** ゲーム開始時にプレイヤーの計画をリセット */
  static resetPlayer(playerId: string): void {
    this.plans.delete(playerId);
    this.trackers.set(playerId, {
      knownCards: new Map(),
      faceUpCounts: new Map(),
    });
  }

  /** 全プレイヤーの計画をクリア */
  static clearAll(): void {
    this.plans.clear();
    this.trackers.clear();
  }

  // ===== 1. 推考立案 (手札配布時 or 再立案時) =====

  /**
   * 手札から最適な出し順計画を立案する。
   * 蓄積データがある場合はそれを参照し、ない場合はヒューリスティックで判断。
   */
  static planPlaySequence(playerId: string, hand: Card[], rules: RulesState, fieldCount: number = 0): PlayPlan {
    const isReversed = rules.isRevolution !== rules.isElevenBack;

    // カードを数字ごとにグループ化
    const groups = new Map<number, Card[]>();
    for (const card of hand) {
      const num = card.isJoker ? 0 : card.number;
      if (!groups.has(num)) groups.set(num, []);
      groups.get(num)!.push(card);
    }

    // 出し順を決定
    const steps: PlayStep[] = [];
    const sortedNumbers = Array.from(groups.keys()).sort((a, b) => {
      const sa = getCardStrength(a, rules);
      const sb = getCardStrength(b, rules);
      return sa - sb; // 弱い順
    });

    // 戦略タイプを決定
    const strategyType = this.decideStrategyType(groups, rules);

    let orderedNumbers: number[];
    switch (strategyType) {
      case 'strong_first':
        orderedNumbers = sortedNumbers.reverse();
        break;
      case 'effect_first':
        // エフェクトカード(6,7,10,12)を先に、残りを弱い順
        const effectNums = [6, 7, 10, 12];
        const effects = sortedNumbers.filter(n => effectNums.includes(n));
        const nonEffects = sortedNumbers.filter(n => !effectNums.includes(n));
        orderedNumbers = [...effects, ...nonEffects];
        break;
      case 'save_strong':
        // 弱いカードから出して強いカード(1,2,0)を後半に
        const strongNums = [1, 2, 0];
        const weak = sortedNumbers.filter(n => !strongNums.includes(n));
        const strong = sortedNumbers.filter(n => strongNums.includes(n));
        orderedNumbers = [...weak, ...strong];
        break;
      default: // low_first
        orderedNumbers = sortedNumbers;
        break;
    }

    // 禁止上がりのチェック: 最後のステップが禁止カードにならないように調整
    const forbiddenNums = this.getForbiddenFinishNumbers(rules.isRevolution);

    // 最後のカードが禁止上がりの場合、順序を入れ替え
    if (orderedNumbers.length > 1) {
      const lastNum = orderedNumbers[orderedNumbers.length - 1];
      if (forbiddenNums.includes(lastNum)) {
        // 禁止でないカードを最後に移動
        for (let i = orderedNumbers.length - 2; i >= 0; i--) {
          if (!forbiddenNums.includes(orderedNumbers[i])) {
            const safe = orderedNumbers.splice(i, 1)[0];
            orderedNumbers.push(safe);
            break;
          }
        }
      }
    }

    // ステップ生成
    for (const num of orderedNumbers) {
      const cards = groups.get(num)!;
      const priority = this.getPlayPriority(num, cards.length, strategyType);

      steps.push({
        cards: [...cards],
        declaredNumber: num,
        isBluff: false,
        priority,
      });
    }

    const plan: PlayPlan = {
      steps,
      currentStepIndex: 0,
      isValid: true,
    };

    this.plans.set(playerId, plan);
    return plan;
  }

  /** 戦略タイプを統計データ or ヒューリスティックで決定 */
  private static decideStrategyType(
    groups: Map<number, Card[]>,
    rules: RulesState
  ): string {
    const hasJoker = groups.has(0);
    const hasEight = groups.has(8);
    const hasStrong = (groups.has(1) ? 1 : 0) + (groups.has(2) ? 1 : 0);
    const effectNums = [6, 7, 10, 12];
    const hasEffects = effectNums.filter(n => groups.has(n)).length;

    // 統計データがあれば勝率で判断
    if (this.data && Object.keys(this.data.play_sequence_weights).length > 0) {
      const weights = this.data.play_sequence_weights;
      const candidates: { type: string; score: number }[] = [];

      for (const [type, winRate] of Object.entries(weights)) {
        candidates.push({ type, score: winRate });
      }

      if (candidates.length > 0) {
        // 重み付きランダム選択（ある程度の探索を維持）
        const totalScore = candidates.reduce((s, c) => s + c.score, 0);
        let r = Math.random() * totalScore;
        for (const c of candidates) {
          r -= c.score;
          if (r <= 0) return c.type;
        }
        return candidates[candidates.length - 1].type;
      }
    }

    // フォールバック: ヒューリスティック
    if (rules.isRevolution) return 'strong_first';
    if (hasEight && hasEffects >= 2) return 'effect_first';
    if (hasStrong >= 2 || hasJoker) return 'save_strong';
    return 'low_first';
  }

  /** 禁止上がりになる数字のリスト */
  private static getForbiddenFinishNumbers(isRevolution: boolean): number[] {
    const forbidden = [0, 8]; // Joker, 8 は常に禁止
    if (isRevolution) {
      forbidden.push(3); // 革命時は3が禁止
    } else {
      forbidden.push(2); // 通常時は2が禁止
    }
    return forbidden;
  }

  /** プレイの優先度を計算 */
  private static getPlayPriority(number: number, count: number, strategy: string): number {
    let base = 50;
    // エフェクトカードの優先度
    if (number === 8) base += 20;   // 8切りは高優先度
    if (number === 10) base += 15;  // 10捨ては有用
    if (number === 7) base += 10;   // 7渡し
    if (number === 12) base += 10;  // Qボンバー
    // 複数枚は一気に出せると有利
    if (count >= 3) base += 15;
    if (count >= 4) base += 30; // 革命チャンス
    return base;
  }

  // ===== 2. ダウト判断 =====

  /**
   * 他プレイヤーの宣言に対してダウトすべきかを判断する。
   * 
   * 2-1. 表墓地に4枚すべてある場合 → 確定ダウト
   * 2-2. 確実に持っていない状況 → ダウト
   * 2-2-1. 確率的判断 → 蓄積データの lie_probability と doubt_threshold で判断
   */
  static shouldDoubt(
    playerId: string,
    declaredNumber: number,
    cardCount: number,
    faceUpPool: Card[],
    myHand: Card[],
    room: Room
  ): { doubt: boolean; confidence: number; reason: string } {
    // ===== 2-1. 表墓地チェック =====
    const faceUpCount = faceUpPool.filter(c =>
      (c.isJoker ? 0 : c.number) === declaredNumber
    ).length;
    const myCount = myHand.filter(c =>
      (c.isJoker ? 0 : c.number) === declaredNumber
    ).length;

    // Joker は2枚しかない
    const maxCards = declaredNumber === 0 ? 2 : 4;

    if (faceUpCount + myCount >= maxCards) {
      // 表墓地 + 自分の手札で全枚数が揃っている → 確定ダウト
      return {
        doubt: true,
        confidence: 1.0,
        reason: `確定ダウト: ${declaredNumber}は表墓地${faceUpCount}枚+自手札${myCount}枚で全${maxCards}枚を確認済み`
      };
    }

    // ===== 2-2. 確定非保持チェック =====
    const tracker = this.trackers.get(playerId);
    if (tracker) {
      const lastPlayerId = room.field.lastPlayerId;
      if (lastPlayerId) {
        const knownCards = tracker.knownCards.get(lastPlayerId);
        if (knownCards && knownCards.length > 0) {
          // そのプレイヤーが前のターンで特定のカードを持っていないことが分かっている
          // (例: 7渡しで受け取ったカードの情報)
          const knownCount = knownCards.filter(n => n === declaredNumber).length;
          const remainingPossible = maxCards - faceUpCount - myCount;
          if (remainingPossible <= 0) {
            return {
              doubt: true,
              confidence: 0.95,
              reason: `高確信ダウト: 残存カード数から保持不可能`
            };
          }
        }
      }
    }

    // ===== 2-2-1. 確率的判断 =====
    if (this.data) {
      const fieldEmpty = room.field.currentCards.length <= cardCount;
      const stateKey = `${declaredNumber}_${cardCount}_${fieldEmpty ? 'empty' : 'nonempty'}`;
      const lieProbability = this.data.lie_probability[stateKey];

      if (lieProbability !== undefined) {
        const threshold = this.data.doubt_threshold;
        if (lieProbability > (1 - threshold)) {
          // 嘘の確率が高い → ダウト
          return {
            doubt: true,
            confidence: lieProbability,
            reason: `確率的ダウト: P(嘘)=${(lieProbability * 100).toFixed(1)}% > 閾値${((1 - threshold) * 100).toFixed(1)}%`
          };
        } else {
          return {
            doubt: false,
            confidence: 1 - lieProbability,
            reason: `スキップ: P(嘘)=${(lieProbability * 100).toFixed(1)}% ≤ 閾値${((1 - threshold) * 100).toFixed(1)}%`
          };
        }
      }
    }

    // フォールバック: 基本的なヒューリスティック
    // 残りカード数が少ないほどダウトしやすい
    const suspicion = (faceUpCount + myCount) / maxCards;
    const baseThreshold = this.data?.doubt_threshold ?? 0.15;

    if (suspicion > 0.5) {
      // 半分以上が確認済み → やや疑わしい
      return {
        doubt: Math.random() < (suspicion * 0.6),
        confidence: suspicion,
        reason: `ヒューリスティック: 確認済み比率=${(suspicion * 100).toFixed(0)}%`
      };
    }

    return {
      doubt: Math.random() < baseThreshold,
      confidence: baseThreshold,
      reason: `ベースライン: 閾値=${(baseThreshold * 100).toFixed(0)}%`
    };
  }

  // ===== 3. 推考に基づくプレイ決定 =====

  /**
   * 自分のターンで推考に基づいてカードを出す。
   * - 計画通り続行可能 → 計画のカードを出す
   * - 続行不可能 → 再立案してブラフ or パス
   */
  static decidePlay(
    playerId: string,
    room: Room,
    player: Player
  ): { type: 'play' | 'pass'; cards?: Card[]; declaredNumber?: number } {
    const isFieldEmpty = room.field.currentCards.length === 0
      || room.field.lastPlayerId === null
      || room.field.lastPlayerId === player.id;
    const fieldCount = room.field.currentCards.length;

    // 計画がなければ立案
    let plan = this.plans.get(playerId);
    if (!plan || !plan.isValid) {
      plan = this.planPlaySequence(playerId, player.hand, room.rules, fieldCount);
    }

    // もし場が空ならターゲット枚数はプランのカード全枚数、そうでないなら場に出ている枚数
    const planTargetCount = (plan.currentStepIndex < plan.steps.length) ? plan.steps[plan.currentStepIndex].cards.length : 1;
    const targetCount = isFieldEmpty ? planTargetCount : fieldCount;

    // ===== 3.2.1 計画通り続行可能かチェック =====
    if (plan.currentStepIndex < plan.steps.length) {
      const step = plan.steps[plan.currentStepIndex];

      // 計画のカードがまだ手札にあるか確認
      const stillHasCards = step.cards.every(c =>
        player.hand.some(h => h.id === c.id)
      );

      if (stillHasCards) {
        // 場の状況に合うかバリデーション
        const cardsToPlay = isFieldEmpty ? step.cards : step.cards.slice(0, targetCount);
        if (cardsToPlay.length === targetCount || isFieldEmpty) {
          const playCards = cardsToPlay;

          if (!isFieldEmpty) {
            // 場より強いか確認
            const validation = validatePlayCards(
              playCards,
              step.declaredNumber,
              {
                currentCardCount: fieldCount,
                declaredNumber: room.field.declaredNumber,
                lastPlayerId: room.field.lastPlayerId
              },
              room.rules
            );
            if (validation.valid) {
              // 禁止上がりチェック
              const remainingAfter = player.hand.length - playCards.length;
              if (remainingAfter === 0 && checkForbiddenFinish(step.declaredNumber, playCards, room.rules.isRevolution)) {
                // 禁止上がり → 次のステップへ
              } else {
                plan.currentStepIndex++;
                return { type: 'play', cards: playCards, declaredNumber: step.declaredNumber };
              }
            }
          } else {
            // 場が空の場合
            const remainingAfter = player.hand.length - playCards.length;
            if (remainingAfter === 0 && checkForbiddenFinish(step.declaredNumber, playCards, room.rules.isRevolution)) {
              // 禁止上がり → 次のステップへ
            } else {
              plan.currentStepIndex++;
              return { type: 'play', cards: playCards, declaredNumber: step.declaredNumber };
            }
          }
        }
      }
    }

    // ===== 3.2.2 計画続行不可能 → 再立案 =====
    plan = this.planPlaySequence(playerId, player.hand, room.rules, fieldCount);

    // 再立案後、出せるステップを探す
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const cardsToPlay = isFieldEmpty ? step.cards : step.cards.slice(0, targetCount);

      if (!isFieldEmpty && cardsToPlay.length !== targetCount) continue;

      // バリデーション
      if (!isFieldEmpty) {
        const validation = validatePlayCards(
          cardsToPlay,
          step.declaredNumber,
          {
            currentCardCount: fieldCount,
            declaredNumber: room.field.declaredNumber,
            lastPlayerId: room.field.lastPlayerId
          },
          room.rules
        );
        if (!validation.valid) continue;
      }

      // 禁止上がりチェック
      const remainingAfter = player.hand.length - cardsToPlay.length;
      if (remainingAfter === 0 && checkForbiddenFinish(step.declaredNumber, cardsToPlay, room.rules.isRevolution)) {
        continue;
      }

      plan.currentStepIndex = i + 1;
      return { type: 'play', cards: cardsToPlay, declaredNumber: step.declaredNumber };
    }

    // ===== ブラフ判断 =====
    if (!isFieldEmpty && player.hand.length >= targetCount) {
      const bluffResult = this.shouldBluff(player.hand, room.field, targetCount, room.rules);
      if (bluffResult) {
        return {
          type: 'play',
          cards: bluffResult.cards,
          declaredNumber: bluffResult.declaredNumber
        };
      }
    }

    // パス（場が空の場合はパス不可 → 何でもいいから出す）
    if (isFieldEmpty && player.hand.length > 0) {
      // 揃っているなら複数枚まとめて出す
      const handByNumber = new Map<number, Card[]>();
      player.hand.forEach(c => {
        const num = c.isJoker ? 0 : c.number;
        if (!handByNumber.has(num)) handByNumber.set(num, []);
        handByNumber.get(num)!.push(c);
      });
      const numToPlay = player.hand[0].isJoker ? 0 : player.hand[0].number;
      const fallbackCards = handByNumber.get(numToPlay) || [player.hand[0]];
      
      // 禁止上がりでないか
      if (player.hand.length - fallbackCards.length > 0 || !checkForbiddenFinish(numToPlay, fallbackCards, room.rules.isRevolution)) {
        return { type: 'play', cards: fallbackCards, declaredNumber: numToPlay };
      }
      // 全部禁止上がり → 仕方なく出す
      return { type: 'play', cards: fallbackCards, declaredNumber: numToPlay };
    }

    return { type: 'pass' };
  }

  // ===== 4. ブラフ（デバフ）判断 =====

  /**
   * ブラフを仕掛けるかどうかを判断する。
   * 蓄積データの bluff_success_rate を参照し、一定以上の確率でブラフする。
   */
  static shouldBluff(
    hand: Card[],
    field: FieldState,
    requiredCount: number,
    rules: RulesState
  ): { cards: Card[]; declaredNumber: number } | null {
    // 場より強い数字でブラフ候補を列挙
    let candidates: number[] = [];
    for (let num = 1; num <= 13; num++) {
      const strength = getCardStrength(num, rules);
      const fieldStrength = getCardStrength(field.declaredNumber, rules);
      if (strength > fieldStrength && field.declaredNumber !== 0) {
        candidates.push(num);
      }
    }
    // Joker
    if (field.declaredNumber !== 0) {
      candidates.push(0);
    }

    // Filter out numbers fully exposed in faceUpPool (Q-Bomber destroyed)
    candidates = candidates.filter(num => {
      const maxCards = num === 0 ? 2 : 4;
      const faceUpCount = field.faceUpPool.filter(c => (c.isJoker ? 0 : c.number) === num).length;
      const myCount = hand.filter(c => (c.isJoker ? 0 : c.number) === num).length;
      return !((faceUpCount + myCount >= maxCards) && myCount === 0);
    });

    if (candidates.length === 0) return null;

    // 統計データでブラフ成功率を確認
    let bestCandidate = -1;
    let bestSuccessRate = 0;

    const handSizeBucket = hand.length <= 5 ? 'small' : hand.length <= 10 ? 'medium' : 'large';

    for (const num of candidates) {
      let successRate = 0.3; // デフォルト

      if (this.data) {
        const key = `${num}_${handSizeBucket}`;
        if (this.data.bluff_success_rate[key] !== undefined) {
          successRate = this.data.bluff_success_rate[key];
        }
      }

      if (successRate > bestSuccessRate) {
        bestSuccessRate = successRate;
        bestCandidate = num;
      }
    }

    // ブラフ閾値を確認
    const bluffThreshold = this.data?.bluff_threshold ?? 0.5;
    if (bestSuccessRate < bluffThreshold || bestCandidate === -1) {
      return null; // ブラフ成功率が低い → パス
    }

    // ブラフ用のカードを選択（宣言番号以外のカードを出す）
    const bluffCards: Card[] = [];
    for (const card of hand) {
      const cardNum = card.isJoker ? 0 : card.number;
      if (cardNum !== bestCandidate && bluffCards.length < requiredCount) {
        bluffCards.push(card);
      }
    }

    // 足りなければ何でも使う
    if (bluffCards.length < requiredCount) {
      for (const card of hand) {
        if (!bluffCards.includes(card) && bluffCards.length < requiredCount) {
          bluffCards.push(card);
        }
      }
    }

    if (bluffCards.length < requiredCount) return null;

    return {
      cards: bluffCards.slice(0, requiredCount),
      declaredNumber: bestCandidate
    };
  }

  // ===== 5. カード追跡の更新 =====

  /**
   * 他プレイヤーの行動を観察してトラッカーを更新する。
   * 7渡しで受け取ったカードなどの情報を記録。
   */
  static updateTracker(
    observerId: string,
    event: 'sevenPass' | 'sixCollect' | 'doubtReveal',
    targetPlayerId: string,
    cardNumbers: number[]
  ): void {
    const tracker = this.trackers.get(observerId);
    if (!tracker) return;

    if (event === 'sevenPass' || event === 'sixCollect') {
      // ターゲットプレイヤーがカードを受け取った
      const known = tracker.knownCards.get(targetPlayerId) ?? [];
      known.push(...cardNumbers);
      tracker.knownCards.set(targetPlayerId, known);
    } else if (event === 'doubtReveal') {
      // ダウトでカードが公開された → 表墓地カウントを更新
      for (const num of cardNumbers) {
        const current = tracker.faceUpCounts.get(num) ?? 0;
        tracker.faceUpCounts.set(num, current + 1);
      }
    }
  }

  /**
   * プレイヤーがカードを出した後にトラッカーからそのカード情報を削除
   */
  static removeFromTracker(observerId: string, playerId: string, cardNumbers: number[]): void {
    const tracker = this.trackers.get(observerId);
    if (!tracker) return;

    const known = tracker.knownCards.get(playerId);
    if (!known) return;

    for (const num of cardNumbers) {
      const idx = known.indexOf(num);
      if (idx !== -1) known.splice(idx, 1);
    }
  }
}
