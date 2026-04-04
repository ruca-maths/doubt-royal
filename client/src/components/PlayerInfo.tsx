import React from 'react';
import { ClientPlayer } from '../types/game';

interface PlayerInfoProps {
  player: ClientPlayer;
  isMe: boolean;
}

export default function PlayerInfo({ player, isMe }: PlayerInfoProps) {
  return (
    <div className="flex-none z-10">
      <div
        className={`glass rounded-xl px-2 py-1.5 min-w-[100px] transition-all duration-300 ${
          player.isCurrentTurn
            ? 'glow-accent border-game-accent/50 bg-game-accent/10'
            : player.isOut
            ? 'opacity-50 grayscale'
            : ''
        }`}
      >
        {/* Name and Card Count */}
        <div className="flex items-center justify-between gap-1 border-b border-white/5 pb-1">
          <p className={`text-[11px] font-bold truncate max-w-[65px] ${isMe ? 'text-game-accent-light' : 'text-white'}`}>
            {player.name}
          </p>
          <p className="text-[10px] text-gray-400 font-bold">
            {player.cardCount}
          </p>
        </div>

        {/* Lives and Status */}
        <div className="flex items-center justify-between mt-1">
          <div className="flex gap-0 px-0.5">
            {Array.from({ length: 3 }).map((_, i) => (
              <span
                key={i}
                className={`text-[9px] ${
                  i < player.lives ? 'opacity-100' : 'opacity-20'
                }`}
              >
                ❤️
              </span>
            ))}
          </div>
          {player.isCurrentTurn && !player.isOut && (
            <span className="text-[8px] text-game-accent-light font-black animate-pulse">
              TURN
            </span>
          )}
          {player.isOut && (
            <span className={`text-[8px] font-black ${player.rank && player.rank > 0 ? 'text-game-gold' : 'text-game-danger'}`}>
              {player.rank && player.rank > 0 ? 'WIN' : 'OUT'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
