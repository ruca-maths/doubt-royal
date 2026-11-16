import type { KeyboardEvent } from 'react';
import { Card } from '../../types/game';
import { SUIT_SYMBOL, cardText, rankLabel } from './rules';

interface PlayingCardProps {
  card?: Card;
  faceDown?: boolean;
  size?: 'hand' | 'sm' | 'xs';
  selected?: boolean;
  dim?: boolean;
  blocked?: boolean;
  enter?: boolean;
  onClick?: () => void;
}

/** トランプ 1 枚。card を渡さない / faceDown のときは裏向き。 */
export default function PlayingCard({
  card, faceDown = false, size = 'hand', selected = false, dim = false, blocked = false, enter = false, onClick,
}: PlayingCardProps) {
  const clickable = !!onClick && !blocked;
  const classes = [
    'pc',
    `pc-${size}`,
    clickable ? 'is-clickable' : '',
    selected ? 'is-selected' : '',
    dim ? 'is-dim' : '',
    blocked ? 'is-blocked' : '',
    enter ? 'is-enter' : '',
  ];

  if (!card || faceDown) {
    return <div className={[...classes, 'pc-back'].join(' ')} aria-label="裏向きのカード" />;
  }

  const interactive = onClick
    ? {
        role: 'button' as const,
        tabIndex: blocked ? -1 : 0,
        'aria-pressed': selected,
        'aria-disabled': blocked,
        onClick: clickable ? onClick : undefined,
        onKeyDown: (event: KeyboardEvent) => {
          if (clickable && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            onClick();
          }
        },
      }
    : {};

  if (card.isJoker) {
    return (
      <div className={[...classes, 'pc-joker'].join(' ')} aria-label="ジョーカー" {...interactive}>
        <b>★</b>
        <i>JOKER</i>
      </div>
    );
  }

  const red = card.suit === 'heart' || card.suit === 'diamond';
  const suit = SUIT_SYMBOL[card.suit ?? 'spade'];
  return (
    <div className={[...classes, 'pc-face', red ? 'is-red' : ''].join(' ')} aria-label={cardText(card)} {...interactive}>
      <div className="pc-index">
        {rankLabel(card.number)}
        <span>{suit}</span>
      </div>
      <div className="pc-pip" aria-hidden="true">{suit}</div>
    </div>
  );
}

/** ログなどに使う小さなカード表記 */
export function MiniCard({ card }: { card: Card }) {
  const red = card.suit === 'heart' || card.suit === 'diamond';
  return (
    <span className={`minicard ${card.isJoker ? 'is-joker' : red ? 'is-red' : ''}`}>{cardText(card)}</span>
  );
}
