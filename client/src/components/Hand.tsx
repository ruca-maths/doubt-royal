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
    <div className="w-full overflow-x-auto custom-scrollbar">
      <div className="flex justify-center items-end min-w-max px-2">
      <div
        className="flex items-end"
        style={{
          gap: sorted.length > 12 ? -20 : sorted.length > 8 ? -10 : 4,
        }}
      >
        {sorted.map((card, idx) => (
          <div
            key={card.id}
            style={{
              marginLeft: idx === 0 ? 0 : sorted.length > 12 ? -20 : sorted.length > 8 ? -10 : 4,
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
