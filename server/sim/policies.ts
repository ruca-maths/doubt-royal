/**
 * シミュレータ用の思考ルーチン一覧。
 *  - legacy : 従来のルールベース CPU (src/game/botPolicy.ts)
 *  - random : 合法手をほぼランダムに選ぶベースライン
 */
import { Card, Player, PendingEffect, Room } from '../src/game/types';
import { BotPolicy } from '../src/game/botPolicy';
import { getCardStrength } from '../src/game/validator';
import { Policy, PlayDecision, EffectDecision } from './driver';

export const legacyPolicy: Policy = {
  name: 'legacy',
  decidePlay: (room, player) => BotPolicy.decidePlay(room, player),
  shouldDoubt: (room, player) => BotPolicy.shouldDoubt(room, player),
  chooseCounter: (room, player) => BotPolicy.chooseCounter(room, player),
  chooseEffect: (room, player, effect) => BotPolicy.chooseEffect(room, player, effect),
};

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** 合法手からランダムに選ぶ。嘘は 25% 程度、ダウトは 8% 程度。 */
export const randomPolicy: Policy = {
  name: 'random',

  decidePlay(room: Room, player: Player): PlayDecision {
    const fieldCount = room.field.currentCards.length;
    const isLead = fieldCount === 0;
    const fieldStrength = isLead ? -1 : getCardStrength(room.field.declaredNumber, room.rules);
    const fieldIsJoker = !isLead && room.field.declaredNumber === 0;

    const groups = new Map<number, Card[]>();
    for (const card of player.hand) {
      const key = card.isJoker ? 0 : card.number;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(card);
    }

    const honest: PlayDecision[] = [];
    for (const [num, cards] of groups) {
      if (!isLead) {
        if (cards.length < fieldCount) continue;
        if (fieldIsJoker && num === 0) continue;
        if (getCardStrength(num, room.rules) <= fieldStrength) continue;
        honest.push({ type: 'play', cards: cards.slice(0, fieldCount), declaredNumber: num });
      } else {
        honest.push({ type: 'play', cards: cards.slice(0, Math.min(cards.length, 6)), declaredNumber: num });
      }
    }

    const wantsBluff = Math.random() < 0.25;
    if (!wantsBluff && honest.length > 0) return pick(honest);

    const count = isLead ? 1 : fieldCount;
    if (player.hand.length >= count) {
      const declarations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].filter(n =>
        isLead || (!fieldIsJoker && getCardStrength(n, room.rules) > fieldStrength)
      );
      if (declarations.length > 0 && (wantsBluff || isLead)) {
        return { type: 'play', cards: shuffled(player.hand).slice(0, count), declaredNumber: pick(declarations) };
      }
    }
    if (honest.length > 0) return pick(honest);
    return { type: 'pass' };
  },

  shouldDoubt(): boolean {
    return Math.random() < 0.08;
  },

  chooseCounter(): Card[] {
    return [];
  },

  chooseEffect(room: Room, player: Player, effect: PendingEffect): EffectDecision {
    switch (effect.type) {
      case 'sevenPass':
      case 'tenDiscard':
      case 'doubtCardSelect': {
        const excluded = (effect as any).excludedNumbers as number[] | undefined;
        const pool = player.hand.filter(c => !excluded || !(excluded.includes(c.number) || (excluded.includes(0) && c.isJoker)));
        return { cardIds: shuffled(pool).slice(0, Math.min(effect.count, pool.length)).map(c => c.id) };
      }
      case 'queenBomber': {
        const numbers = shuffled([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).slice(0, effect.count);
        return { cardIds: [], targetData: { numbers } };
      }
      default:
        return { cardIds: [] };
    }
  },
};

/**
 * sneaky: 「親番ではいつも、いらない2枚を適当なペアだと言い張る」だけの相手。
 * brain がこういう単純な嘘の常習犯を対局中に見抜けるか (付け込まれないか) を確かめるための検査用。
 * それ以外の判断は legacy と同じ。
 */
export const sneakyPolicy: Policy = {
  ...legacyPolicy,
  name: 'sneaky',
  decidePlay(room: Room, player: Player): PlayDecision {
    const isLead = room.field.currentCards.length === 0;
    if (isLead && player.hand.length >= 3 && Math.random() < 0.7) {
      const junk = [...player.hand]
        .filter(card => !card.isJoker && ![7, 8, 10, 12].includes(card.number))
        .sort((a, b) => getCardStrength(a.number, room.rules) - getCardStrength(b.number, room.rules))
        .slice(0, 2);
      if (junk.length === 2 && junk[0].number !== junk[1].number) {
        const declared = pick([3, 4, 5, 6, 9, 11, 13]);
        return { type: 'play', cards: junk, declaredNumber: declared };
      }
    }
    return legacyPolicy.decidePlay(room, player);
  },
};
