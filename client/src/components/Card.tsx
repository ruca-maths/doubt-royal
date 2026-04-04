import React from 'react';
import { Card as CardType } from '../types/game';
import { getSuitSymbol, getNumberDisplay, getSuitColor } from '../utils/cardUtils';

interface CardProps {
  card: CardType;
  faceDown?: boolean;
  selected?: boolean;
  onClick?: () => void;
  small?: boolean;
}

export default function Card({ card, faceDown = false, selected = false, onClick, small = false }: CardProps) {
  if (faceDown) {
    return (
      <div
        className={`card-container ${small ? 'card-small' : ''} ${selected ? 'selected' : ''}`}
        onClick={onClick}
      >
        <div className="card-back" style={{ width: '100%', height: '100%' }} />
      </div>
    );
  }

  const isJoker = card.isJoker;
  const suitColor = isJoker ? '' : getSuitColor(card.suit);
  const textColor = suitColor === 'red' ? 'text-red-600' : 'text-gray-900';
  const suitClass = isJoker ? 'joker' : card.suit || '';

  return (
    <div
      className={`card-container ${small ? 'card-small' : ''} ${selected ? 'selected' : ''}`}
      onClick={onClick}
    >
      <div
        className={`card-face ${suitClass} ${selected ? 'ring-2 ring-game-accent ring-offset-2 ring-offset-game-bg' : ''}`}
        style={{ width: '100%', height: '100%' }}
      >
        {isJoker ? (
          <div className="flex flex-col items-center">
            <span className="text-2xl">🃏</span>
            <span className="text-xs font-bold mt-1">JOKER</span>
          </div>
        ) : (
          <>
            <span className={`text-xs font-bold absolute top-1 left-2 ${textColor}`}>
              {getNumberDisplay(card.number)}
            </span>
            <span className={`text-2xl ${small ? 'text-xl' : ''}`}>
              {getSuitSymbol(card.suit!)}
            </span>
            <span className={`text-lg font-bold ${textColor}`}>
              {getNumberDisplay(card.number)}
            </span>
            <span className={`text-xs font-bold absolute bottom-1 right-2 ${textColor} rotate-180`}>
              {getNumberDisplay(card.number)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
