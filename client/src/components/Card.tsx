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
          <div className="flex flex-col items-center justify-center">
            <span className="text-3xl filter drop-shadow-sm">🃏</span>
            <span className="text-[10px] font-black mt-1 tracking-widest opacity-80 uppercase">Joker</span>
          </div>
        ) : (
          <div className="relative w-full h-full flex flex-col items-center justify-center">
            {!small && (
              <span className={`text-[10px] font-black absolute top-1.5 left-2 ${textColor} card-rank`}>
                {getNumberDisplay(card.number)}
              </span>
            )}
            <span className={`text-3xl leading-none ${small ? 'text-2xl mt-1' : 'mb-1'} flex items-center justify-center transition-transform`}>
              {getSuitSymbol(card.suit!)}
            </span>
            <span className={`text-xl font-black leading-none ${textColor} card-rank ${small ? 'mt-0.5 scale-90' : ''}`}>
              {getNumberDisplay(card.number)}
            </span>
            {!small && (
              <span className={`text-[10px] font-black absolute bottom-1.5 right-2 ${textColor} rotate-180 card-rank`}>
                {getNumberDisplay(card.number)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
