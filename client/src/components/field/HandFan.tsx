import { useMemo, useRef } from 'react';
import { Card } from '../../types/game';
import PlayingCard from './PlayingCard';
import { useElementWidth } from './hooks';
import { rankOf, sortHand } from './rules';

interface HandFanProps {
  cards: Card[];
  reversed: boolean;
  selectedIds: string[];
  /** いま手札を選べる状況か */
  selectable: boolean;
  /** 自分の出番ではないので控えめに表示する */
  dim?: boolean;
  /** 選べないカード (Qボンバーで破壊された数字など) */
  isBlocked?: (card: Card) => boolean;
  onToggle: (cardId: string) => void;
}

function cardWidth(): number {
  if (typeof window === 'undefined') return 60;
  const fluid = Math.min(window.innerWidth * 0.115, window.innerHeight * 0.15);
  return Math.max(46, Math.min(76, fluid));
}

/**
 * 自分の手札。弱い順に並べ、同じ数字どうしをまとめて見せる。
 * 画面幅に収まるよう重なり幅を自動で詰め、それでも入らなければ横スクロールする。
 */
export default function HandFan({ cards, reversed, selectedIds, selectable, dim = false, isBlocked, onToggle }: HandFanProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef);

  const groups = useMemo(() => {
    const sorted = sortHand(cards, reversed);
    const result: Card[][] = [];
    for (const card of sorted) {
      const last = result[result.length - 1];
      if (last && rankOf(last[0]) === rankOf(card)) last.push(card);
      else result.push([card]);
    }
    return result;
  }, [cards, reversed]);

  const cw = cardWidth();
  const n = cards.length;
  const g = groups.length;
  const available = Math.max(0, width - 20);
  let step = cw * 0.62; // 同じ数字どうしの見せ幅
  let gap = 6;          // 数字の違うまとまりどうしの間隔
  const total = (s: number, gp: number) => g * cw + (n - g) * s + Math.max(0, g - 1) * gp;
  if (available > 0 && n > 1 && total(step, gap) > available) {
    // 入りきらないときは全カードを均等に重ねる (数字の境目だけ少し広く見せる)。
    // どのカードも左上の数字とスートが読める幅 (22px) は確保し、それでも足りなければ横スクロール。
    const extra = Math.min(6, Math.max(0, (available - cw - (n - 1) * 22) / Math.max(1, g - 1)));
    step = Math.max(22, (available - cw - Math.max(0, g - 1) * extra) / (n - 1));
    gap = step + extra - cw;
  }

  if (n === 0) {
    return (
      <div className="hand-wrap" ref={wrapRef}>
        <div className="hand-row" style={{ color: 'var(--ink-faint)', fontSize: 13, fontWeight: 700, padding: '10px 0 14px' }}>
          手札はありません
        </div>
      </div>
    );
  }

  return (
    <div className="hand-wrap" ref={wrapRef}>
      <div
        className="hand-row"
        style={{ ['--step' as string]: `${step - cw}px`, ['--group-gap' as string]: `${gap}px` }}
        role="group"
        aria-label="あなたの手札"
      >
        {groups.map(group => (
          <div className="hand-group" key={rankOf(group[0])}>
            {group.map(card => {
              const blocked = isBlocked?.(card) ?? false;
              return (
                <PlayingCard
                  key={card.id}
                  card={card}
                  size="hand"
                  selected={selectedIds.includes(card.id)}
                  dim={dim && !blocked}
                  blocked={blocked}
                  onClick={selectable ? () => onToggle(card.id) : undefined}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
