import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useGame } from '../contexts/GameContext';
import { DoubtResult } from '../types/game';
import { getDeclaredNumberDisplay, getCardEffectName } from '../utils/cardUtils';

interface DoubtPhaseProps {
  doubtResult: DoubtResult | null;
}

export default function DoubtPhase({ doubtResult }: DoubtPhaseProps) {
  const { gameState, myId, declareDoubt, skipDoubt } = useGame();
  
  const doubtTimeMs = (gameState?.rules.doubtTime || 5) * 1000;
  const [timeLeft, setTimeLeft] = useState(doubtTimeMs);
  const [hasActed, setHasActed] = useState(false);

  const isMyCards = gameState?.field.lastPlayerId === myId;

  useEffect(() => {
    if (gameState?.phase !== 'doubtPhase' && gameState?.phase !== 'counterPhase') {
      setTimeLeft(doubtTimeMs);
      setHasActed(false);
      return;
    }

    const interval = setInterval(() => {
      setTimeLeft(prev => {
        const next = prev - 100;
        return next < 0 ? 0 : next;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [gameState?.phase]);

  const handleDoubt = useCallback(() => {
    if (hasActed || isMyCards) return;
    setHasActed(true);
    declareDoubt();
  }, [hasActed, isMyCards, declareDoubt]);

  const handleSkip = useCallback(() => {
    if (hasActed || isMyCards) return;
    setHasActed(true);
    skipDoubt();
  }, [hasActed, isMyCards, skipDoubt]);

  // Doubt/Counter result overlay
  if (doubtResult && doubtResult.type !== 'noDoubt') {
    const players = gameState?.players || [];
    const isSuccess = doubtResult.type === 'success';
    const isCounter = doubtResult.type === 'counter';
    
    let title = '';
    let description = '';
    let winnerId = '';
    let winnerName = '';

    if (isCounter) {
      if ((doubtResult as any).doubterId) {
        // Someone doubted the counter, and the counter was honest
        title = 'ダウト失敗… (カウンター成功)';
        winnerId = doubtResult.countererId;
        winnerName = players.find(p => p.id === winnerId)?.name || '?';
        const doubterName = players.find(p => p.id === (doubtResult as any).doubterId)?.name || '?';
        description = `${doubterName} のダウトは外れ！ ライフ -1`;
      } else {
        // No one doubted
        title = 'カウンター成功！';
        winnerId = doubtResult.countererId;
        winnerName = players.find(p => p.id === winnerId)?.name || '?';
        description = '特殊効果を無効化した！';
      }
    } else if (isSuccess) {
      title = 'ダウト成功！';
      winnerId = doubtResult.doubterId;
      winnerName = players.find(p => p.id === winnerId)?.name || '?';
      description = `${winnerName} が嘘を見破った！`;
    } else {
      title = 'ダウト失敗…';
      winnerId = (doubtResult as any).honestPlayerId;
      winnerName = players.find(p => p.id === winnerId)?.name || '?';
      const doubterName = players.find(p => p.id === (doubtResult as any).doubterId)?.name || '?';
      description = `${doubterName} のダウトは外れ！ ライフ -1`;
    }

    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className={`animate-bounce-in rounded-2xl p-8 text-center glass shadow-2xl ${
          isSuccess || isCounter ? 'border-game-accent/50' : 'border-game-danger/50'
        }`}>
          <div className="text-6xl mb-4">
            {isCounter ? '🛡️' : (isSuccess ? '🎯' : '💥')}
          </div>
          <h2 className="text-3xl font-black mb-2" style={{ fontFamily: 'Orbitron, sans-serif' }}>
            {title}
          </h2>
          <p className="text-lg text-white mb-4">
            {description}
          </p>
          <div className="bg-game-accent/20 border border-game-accent/30 rounded-xl p-4 mb-4">
            <p className="text-game-accent-light font-bold">
              {isCounter 
                ? `${winnerName} からターンが再開されます！` 
                : `報酬: ${winnerName} は手札を ${doubtResult.count} 枚渡せます！`}
            </p>
          </div>
          
          {/* Revealed cards */}
          <div className="flex justify-center gap-2 mt-2">
            {doubtResult.revealedCards?.map((card, i) => (
              <div key={i} className="bg-white rounded-lg px-3 py-2 text-black font-bold text-sm shadow-md">
                {card.isJoker ? '🃏 JOKER' : `${card.suit === 'heart' || card.suit === 'diamond' ? '🔴' : '⚫'} ${getDeclaredNumberDisplay(card.number)}`}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Only show during doubt phase or counter phase
  if (gameState?.phase !== 'doubtPhase' && gameState?.phase !== 'counterPhase') return null;

  const isCounterPhase = gameState.phase === 'counterPhase';
  const progress = (timeLeft / doubtTimeMs) * 100;
  const declaredNum = gameState.field.declaredNumber;
  const lastPlayerName = gameState.players.find(
    p => p.id === gameState.field.lastPlayerId
  )?.name || '?';
  const isDiscard = gameState.field.doubtType === 'discard';
  const isCounterDoubt = gameState.field.doubtType === 'counter';
  const pendingNumbers = gameState.field.pendingNumbers;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center pt-[-10vh] pb-[20vh] z-50 animate-fade-in pointer-events-none">
      <div className="glass rounded-2xl p-6 max-w-sm w-full mx-4 text-center pointer-events-auto shadow-2xl border border-white/10 mt-[-100px]">
        {/* Info */}
        <p className="text-gray-400 text-sm mb-2">
          {isCounterPhase 
            ? '特殊効果カウンター確認中...' 
            : (isCounterDoubt 
                ? `${lastPlayerName} のカウンターに対するダウト確認` 
                : `${lastPlayerName} が ${gameState.field.currentCardCount}枚${isDiscard ? '捨てた' : '出した'}`)}
        </p>
        <div className="text-4xl font-black mb-1 text-game-accent-light" style={{ fontFamily: 'Orbitron, sans-serif' }}>
          {isCounterPhase ? '確認中' : `宣言: ${getDeclaredNumberDisplay(declaredNum)}`}
        </div>
        {pendingNumbers && (
          <div className="bg-game-danger/20 border border-game-danger/30 rounded-lg p-2 mb-4">
            <p className="text-game-danger text-sm font-bold">
              破壊対象: {pendingNumbers.map(n => getDeclaredNumberDisplay(n)).join(', ')}
            </p>
          </div>
        )}
        {/* 4-counter effect only appears when it's a counter doubt phase */}
        {getCardEffectName(declaredNum, gameState.rules.isRevolution) && gameState.field.isEffectActive && (declaredNum !== 4 || isCounterDoubt) && (
          <div className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-500 animate-pulse-glow mb-4">
            {getCardEffectName(declaredNum, gameState.rules.isRevolution)}
          </div>
        )}
        {(!getCardEffectName(declaredNum, gameState.rules.isRevolution) || (declaredNum === 4 && !isCounterDoubt)) && <div className="mb-4" />}

        {/* Timer bar */}
        <div className="w-full h-2 bg-game-card rounded-full mb-6 overflow-hidden">
          <div
            className="doubt-timer-bar"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Buttons */}
        {!isMyCards && !hasActed ? (
          <div className="space-y-3">
            {!isCounterPhase && (
              <button
                onClick={handleDoubt}
                className="w-full py-5 rounded-2xl bg-gradient-to-r from-red-600 to-rose-500 text-white text-2xl font-black
                           hover:from-red-500 hover:to-rose-400 active:scale-95 transition-all duration-200
                           animate-pulse-glow shadow-2xl"
                style={{ fontFamily: 'Orbitron, sans-serif' }}
              >
                ダウト！
              </button>
            )}
            <button
              onClick={handleSkip}
              className="w-full py-3 rounded-xl bg-game-card hover:bg-game-border text-gray-400 hover:text-white font-medium transition-all"
            >
              {isCounterPhase ? 'スルー（カウンターしない）' : 'スルー（ダウトしない）'}
            </button>
            
            {/* Logic for manual counter moved to GameBoard.tsx, so we can remove it from here if we want or keep as shortcut for auto-selection */}
            {/* But since we need multiple card selection for N+1 cards, manual selection in GameBoard is better. */}
          </div>
        ) : isMyCards ? (
          <div className="py-5 text-gray-500 text-lg">
            相手の{isCounterPhase ? 'カウンター' : 'ダウト'}判定を待っています...
          </div>
        ) : (
          <div className="py-5 text-game-accent-light text-lg font-semibold animate-pulse">
            ✅ 宣言済み
          </div>
        )}
      </div>
    </div>
  );
}
