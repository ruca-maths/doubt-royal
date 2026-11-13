import React from 'react';
import { Card as CardType } from '../types/game';
import Card from './Card';
import { sortCards } from '../utils/cardUtils';

interface HandProps {
  cards: CardType[];
  selectedIds: string[];
  onToggleSelect: (cardId: string) => void;
  disabled?: boolean;
}

export default function Hand({ cards, selectedIds, onToggleSelect, disabled = false }: HandProps) {
  const sorted = sortCards(cards);

  return (
    <div className="w-full overflow-x-auto overscroll-x-contain custom-scrollbar">
      <div className="flex justify-start sm:justify-center items-end min-w-max px-2 py-2">
      <div
        className="flex items-end"
        style={{
          gap: 0,
        }}
      >
        {sorted.map((card, idx) => (
          <div
            key={card.id}
            style={{
              marginLeft: idx === 0 ? 0 : sorted.length > 12 ? -14 : sorted.length > 8 ? -8 : 4,
              zIndex: idx,
              transition: 'all 0.2s ease',
            }}
          >
            <Card
              card={card}
              selected={selectedIds.includes(card.id)}
              onClick={() => !disabled && onToggleSelect(card.id)}
            />
          </div>
        ))}
      </div>
    </div>
  </div>
  );
}
