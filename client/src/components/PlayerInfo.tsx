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
        className={`glass rounded-xl px-4 py-3 min-w-[140px] transition-all duration-300 ${
          player.isCurrentTurn
            ? 'glow-accent border-game-accent/50'
            : player.isOut
            ? 'opacity-50'
            : ''
        }`}
      >
        {/* Name */}
        <div className="flex items-center gap-2 mb-1">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
              player.isCurrentTurn
                ? 'bg-game-accent text-white'
                : 'bg-game-card text-gray-400'
            }`}
          >
            {player.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <p className={`text-sm font-semibold truncate max-w-[80px] ${isMe ? 'text-game-accent-light' : ''}`}>
              {player.name}
              {isMe && <span className="text-xs ml-1 opacity-60">(自分)</span>}
            </p>
            <p className="text-xs text-gray-500">
              {player.cardCount}枚
            </p>
          </div>
        </div>

        {/* Lives */}
        <div className="flex gap-0.5 mt-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <span
              key={i}
              className={`text-sm transition-all duration-300 ${
                i < player.lives ? 'opacity-100' : 'opacity-20 grayscale'
              }`}
            >
              ❤️
            </span>
          ))}
        </div>

        {/* Status */}
        {player.isOut && player.rank && player.rank > 0 && (
          <div className="mt-1">
            <span className="text-xs px-2 py-0.5 rounded-full bg-game-gold/20 text-game-gold font-semibold">
              {player.rank}位 上がり
            </span>
          </div>
        )}
        {player.isOut && (!player.rank || player.rank < 0) && (
          <div className="mt-1">
            <span className="text-xs px-2 py-0.5 rounded-full bg-game-danger/20 text-game-danger font-semibold">
              脱落
            </span>
          </div>
        )}
        {player.isCurrentTurn && !player.isOut && (
          <div className="mt-1">
            <span className="text-xs px-2 py-0.5 rounded-full bg-game-accent/20 text-game-accent-light font-semibold animate-pulse">
              ターン中
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
