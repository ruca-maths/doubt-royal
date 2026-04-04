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

        {/* Win Rate (visible only to spectators) */}
        {typeof player.winRate === 'number' && !player.isOut && (
          <div className="mt-1 pt-1 border-t border-white/5">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[8px] text-gray-500 font-bold">勝率</span>
              <span className={`text-[9px] font-black ${
                player.winRate >= 60 ? 'text-green-400' :
                player.winRate >= 40 ? 'text-yellow-400' :
                'text-red-400'
              }`}>
                {player.winRate}%
              </span>
            </div>
            <div className="w-full h-[3px] bg-white/10 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  player.winRate >= 60 ? 'bg-gradient-to-r from-green-500 to-emerald-400' :
                  player.winRate >= 40 ? 'bg-gradient-to-r from-yellow-500 to-amber-400' :
                  'bg-gradient-to-r from-red-500 to-rose-400'
                }`}
                style={{ width: `${player.winRate}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
