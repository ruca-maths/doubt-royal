// ゲームフィールド用のルール知識 (表示・入力補助のためのもの。判定そのものはサーバーが行う)
import { Card, ClientGameState, LogEntry } from '../../types/game';

export const JOKER = 0;

const RANK_LABEL: Record<number, string> = {
  0: 'JOKER', 1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K',
};

export function rankLabel(rank: number): string {
  return RANK_LABEL[rank] ?? String(rank);
}

export function rankOf(card: Card): number {
  return card.isJoker ? JOKER : card.number;
}

/** 強さ (0 = 最弱 … 12 = 最強、ジョーカーは常に最強) */
export function strengthOf(rank: number, reversed: boolean): number {
  if (rank === JOKER) return 100;
  const normal = (rank - 3 + 13) % 13;
  return reversed ? 12 - normal : normal;
}

/** いまの強さ順 (革命 XOR 11バック で逆転) */
export function isReversed(state: ClientGameState): boolean {
  return state.rules.isRevolution !== state.rules.isElevenBack;
}

/** 弱い順に並べた 13 ランク + ジョーカー */
export function ranksByStrength(reversed: boolean): number[] {
  const ranks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  ranks.sort((a, b) => strengthOf(a, reversed) - strengthOf(b, reversed));
  return [...ranks, JOKER];
}

/** 場に対してその数字を宣言できるか */
export function canDeclare(rank: number, state: ClientGameState): boolean {
  const { currentCardCount, declaredNumber } = state.field;
  if (currentCardCount === 0) return true;
  if (declaredNumber === JOKER) return false;
  const reversed = isReversed(state);
  return strengthOf(rank, reversed) > strengthOf(declaredNumber, reversed);
}

/** 選んだカードがその宣言どおりか (ジョーカーは何にでもなれる) */
export function isHonest(cards: Card[], declared: number): boolean {
  if (declared === JOKER) return cards.every(card => card.isJoker);
  return cards.every(card => card.isJoker || card.number === declared);
}

/** 選んだカードを正直に出すならこの数字、という候補 (混ざっていれば null) */
export function honestDeclaration(cards: Card[]): number | null {
  if (cards.length === 0) return null;
  const ranks = new Set(cards.filter(card => !card.isJoker).map(card => card.number));
  if (ranks.size === 0) return JOKER;
  if (ranks.size === 1) return [...ranks][0];
  return null;
}

/** 禁止上がり: 8 / ジョーカー / 2 (革命中は 3) を宣言して手札を無くすと脱落 */
export function isForbiddenFinish(rank: number, isRevolution: boolean): boolean {
  if (rank === JOKER || rank === 8) return true;
  return rank === (isRevolution ? 3 : 2);
}

export interface EffectInfo {
  name: string;
  summary: string;
}

const EFFECTS: Record<number, EffectInfo> = {
  5: { name: '5スキップ', summary: '出した枚数ぶん、次の人を飛ばす' },
  6: { name: '6回収', summary: '出した枚数まで、表向き墓地から拾える' },
  7: { name: '7渡し', summary: '出した枚数まで、次の人に手札を渡せる' },
  8: { name: '8切り', summary: '場を流して、もう一度自分の番' },
  9: { name: '9リバース', summary: '順番が逆回りになる' },
  10: { name: '10捨て', summary: '出した枚数まで、手札を捨てられる' },
  11: { name: '11バック', summary: '場が流れるまで強さが逆転' },
  12: { name: 'Qボンバー', summary: '出した枚数ぶん数字を指定し、全員の手札から破壊' },
};

/** その宣言で発動する効果 (いま効果が出ない状況なら null) */
export function effectOf(rank: number, state: ClientGameState): EffectInfo | null {
  const info = EFFECTS[rank];
  if (!info) return null;
  if (rank === 12 && !state.field.hasFieldCleared) return null;
  if (rank === 6 && state.field.faceUpPool.length === 0) return null;
  return info;
}

export function effectName(rank: number): string | null {
  return EFFECTS[rank]?.name ?? null;
}

export const SUIT_SYMBOL: Record<string, string> = { spade: '♠', heart: '♥', diamond: '♦', club: '♣' };

export function cardText(card: Card): string {
  if (card.isJoker) return 'JOKER';
  return `${SUIT_SYMBOL[card.suit ?? 'spade']}${rankLabel(card.number)}`;
}

/** 手札の並び: 弱い順 → スート順 */
export function sortHand(cards: Card[], reversed: boolean): Card[] {
  const suits = ['spade', 'heart', 'diamond', 'club'];
  return [...cards].sort((a, b) => {
    const diff = strengthOf(rankOf(a), reversed) - strengthOf(rankOf(b), reversed);
    if (diff !== 0) return diff;
    return suits.indexOf(a.suit ?? '') - suits.indexOf(b.suit ?? '');
  });
}

export type LogTone = 'plain' | 'muted' | 'good' | 'bad' | 'accent' | 'gold';

export interface LogLine {
  tone: LogTone;
  text: string;
  cards?: Card[];
}

/** ログ 1 件を 1 行の文章にする (タイムラインと実況ティッカーで共用) */
export function describeLog(log: LogEntry): LogLine {
  const who = log.playerName;
  switch (log.action) {
    case 'play':
      return { tone: 'plain', text: `${who} が「${rankLabel(log.declaredNumber ?? 0)}」を ${log.cardCount}枚` };
    case 'pass':
      return { tone: 'muted', text: `${who} はパス` };
    case 'discard':
      return { tone: 'plain', text: `${who} が 10捨てで ${log.cardCount}枚 捨てた` };
    case 'doubtSuccess':
      return {
        tone: 'good',
        text: `ダウト成功！ ${who} が ${log.targetPlayerName ?? '相手'} の嘘を見破った`,
        cards: log.revealedCards,
      };
    case 'doubtFailure':
      return { tone: 'bad', text: `ダウト失敗… ${who} はライフ -1 (本当だった)`, cards: log.revealedCards };
    case 'counter':
      return { tone: 'gold', text: `${who} のカウンター成立` };
    case 'revenge':
      return { tone: 'gold', text: `${who} のスペ3返し！` };
    case 'sevenPass':
      return { tone: 'accent', text: `${who} が ${log.targetPlayerName} へ ${log.cardCount}枚 渡した (7渡し)` };
    case 'sixCollect':
      return { tone: 'accent', text: `${who} が表向き墓地から ${log.cardCount}枚 回収`, cards: log.collectedCards };
    case 'queenBomber':
      return {
        tone: 'bad',
        text: `${who} の Qボンバー: ${(log.targetNumbers ?? []).map(rankLabel).join('・')} を破壊`,
      };
    case 'doubtCardSelect':
      return { tone: 'accent', text: `${who} が ${log.targetPlayerName} へ ${log.cardCount}枚 押し付けた` };
    case 'eightCut':
      return { tone: 'gold', text: `${who} の 8切り — 場が流れた` };
    case 'revolution':
      return { tone: 'gold', text: '革命！ 強さが逆転' };
    default:
      return { tone: 'plain', text: `${who}` };
  }
}
