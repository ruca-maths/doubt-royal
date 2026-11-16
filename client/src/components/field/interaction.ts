import { ClientGameState } from '../../types/game';

/** いまこのプレイヤーに求められている操作 */
export type Interaction =
  | { kind: 'spectate' }
  | { kind: 'wait'; text: string }
  | { kind: 'play'; canPass: boolean; need: number }
  | { kind: 'doubt'; own: boolean }
  | { kind: 'counter'; need: number; target: 'four' | 'spadeThree' }
  | { kind: 'give'; effect: 'sevenPass' | 'tenDiscard' | 'doubtCardSelect'; max: number; targetId?: string; excluded: number[] }
  | { kind: 'collect'; max: number }
  | { kind: 'bomb'; max: number };

const EFFECT_LABEL: Record<string, string> = {
  sevenPass: '7渡しで渡すカード',
  sixCollect: '6回収で拾うカード',
  tenDiscard: '10捨てで捨てるカード',
  queenBomber: 'Qボンバーで破壊する数字',
  doubtCardSelect: '押し付けるカード',
};

export function deriveInteraction(state: ClientGameState, myId: string | null): Interaction {
  const me = state.players.find(p => p.id === myId);
  const nameOf = (id: string | null | undefined) => state.players.find(p => p.id === id)?.name ?? '相手';
  const out = !me || me.isOut || me.lives <= 0;

  if (state.phase === 'effectPhase' && state.pendingEffect) {
    const effect = state.pendingEffect;
    if (effect.playerId !== myId) {
      return { kind: 'wait', text: `${nameOf(effect.playerId)} が${EFFECT_LABEL[effect.type] ?? '効果'}を選んでいます` };
    }
    switch (effect.type) {
      case 'sevenPass':
      case 'tenDiscard':
      case 'doubtCardSelect':
        return {
          kind: 'give',
          effect: effect.type,
          max: Math.min(effect.count, state.myHand.length),
          targetId: effect.targetPlayerId,
          excluded: effect.excludedNumbers ?? [],
        };
      case 'sixCollect':
        return { kind: 'collect', max: Math.min(effect.count, state.field.faceUpPool.length) };
      case 'queenBomber':
        return { kind: 'bomb', max: effect.count };
      default:
        return { kind: 'wait', text: '効果を処理しています' };
    }
  }

  if (state.phase === 'counterPhase') {
    if (state.counterActorId === myId && !out) {
      const againstEight = state.field.declaredNumber === 8;
      return {
        kind: 'counter',
        need: againstEight ? state.field.currentCardCount + 1 : 1,
        target: againstEight ? 'four' : 'spadeThree',
      };
    }
    return { kind: 'wait', text: `${nameOf(state.counterActorId)} がカウンターするか考えています` };
  }

  if (state.phase === 'doubtPhase') {
    if (out) return { kind: 'wait', text: 'ダウト受付中…' };
    return { kind: 'doubt', own: state.field.lastPlayerId === myId };
  }

  if (out) return { kind: 'spectate' };

  if (state.phase === 'playing') {
    if (state.currentPlayerId === myId) {
      return {
        kind: 'play',
        canPass: state.field.lastPlayerId !== null,
        need: state.field.currentCardCount,
      };
    }
    return { kind: 'wait', text: `${nameOf(state.currentPlayerId)} の番です` };
  }

  return { kind: 'wait', text: '' };
}

/** 手札を何枚まで選べるか (0 = 手札は選べない) */
export function selectionLimit(interaction: Interaction): number {
  switch (interaction.kind) {
    case 'play':
      return interaction.need > 0 ? interaction.need : 6;
    case 'counter':
      return interaction.need;
    case 'give':
      return interaction.max;
    default:
      return 0;
  }
}

/** 操作の切り替わりを表すキー (変わったら手札の選択をリセットする) */
export function interactionKey(interaction: Interaction, state: ClientGameState): string {
  const lastLogId = state.logs.length > 0 ? state.logs[state.logs.length - 1].id : '';
  const base = `${interaction.kind}:${lastLogId}:${state.phase}`;
  if (interaction.kind === 'give') return `${base}:${interaction.effect}`;
  return base;
}
