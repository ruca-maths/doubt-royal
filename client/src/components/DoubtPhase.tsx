import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useGame } from '../contexts/GameContext';
import { DoubtResult } from '../types/game';
import { getDeclaredNumberDisplay, getCardEffectName } from '../utils/cardUtils';

interface DoubtPhaseProps {
  doubtResult: DoubtResult | null;
}

export default function DoubtPhase({ doubtResult }: DoubtPhaseProps) {
  const { gameState, myId, declareDoubt, skipDoubt } = useGame();
  
  const isCounterPhase = gameState?.phase === 'counterPhase';
  const doubtTimeMs = (gameState?.rules.doubtTime || 5) * 1000 * (isCounterPhase ? 1.5 : 1.0);

  const [timeLeft, setTimeLeft] = useState(doubtTimeMs);
  const [hasActed, setHasActed] = useState(false);

  const isMyCards = gameState?.field.lastPlayerId === myId;

  useEffect(() => {
    if (gameState?.phase !== 'doubtPhase' && gameState?.phase !== 'counterPhase') {
      setTimeLeft(doubtTimeMs);
      setHasActed(false);
      return;
    }

    // Reset hasActed when the card player changes (e.g. play → counter transition)
    setHasActed(false);
    setTimeLeft(doubtTimeMs);

    const interval = setInterval(() => {
      setTimeLeft(prev => {
        const next = prev - 100;
        return next < 0 ? 0 : next;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [gameState?.phase, gameState?.field.lastPlayerId]);

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
  const { clearDoubtResult } = useGame();

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
      <div 
        className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 cursor-pointer p-4"
        onClick={clearDoubtResult}
      >
        <div className={`animate-bounce-in rounded-2xl p-4 text-center glass shadow-2xl w-full max-w-sm max-h-[90vh] overflow-y-auto ${
          isSuccess || isCounter ? 'border-game-accent/50' : 'border-game-danger/50'
        }`}>
          <div className="text-4xl mb-2">
            {isCounter ? '🛡️' : (isSuccess ? '🎯' : '💥')}
          </div>
          <h2 className="text-xl font-black mb-1" style={{ fontFamily: 'Orbitron, sans-serif' }}>
            {title}
          </h2>
          <p className="text-sm text-white mb-3">
            {description}
          </p>
          <div className="bg-game-accent/20 border border-game-accent/30 rounded-lg p-2 mb-3">
            <p className="text-game-accent-light text-xs font-bold leading-tight">
              {isCounter 
                ? `${winnerName} から再開！` 
                : `${winnerName} は手札を ${doubtResult.count} 枚渡せます！`}
            </p>
          </div>
          
          {/* Revealed cards */}
          <div className="flex justify-center gap-1.5 mt-1">
            {doubtResult.revealedCards?.map((card, i) => (
              <div key={i} className="bg-white rounded-md px-2 py-1 text-black font-black text-[10px] shadow-sm">
                {card.isJoker ? '🃏' : `${card.suit === 'heart' || card.suit === 'diamond' ? '🔴' : '⚫'}${getDeclaredNumberDisplay(card.number)}`}
              </div>
            ))}
          </div>
          <p className="mt-4 text-[10px] text-gray-500 animate-pulse">
            タップで閉じる
          </p>
        </div>
      </div>
    );
  }

  // Only show during doubt phase or counter phase
  if (gameState?.phase !== 'doubtPhase' && gameState?.phase !== 'counterPhase') return null;

  const progress = (timeLeft / doubtTimeMs) * 100;

  const declaredNum = gameState.field.declaredNumber;
  const lastPlayerName = gameState.players.find(
    p => p.id === gameState.field.lastPlayerId
  )?.name || '?';
  const isDiscard = gameState.field.doubtType === 'discard';
  const isCounterDoubt = gameState.field.doubtType === 'counter';
  const pendingNumbers = gameState.field.pendingNumbers;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 animate-fade-in pointer-events-none">
      <div className="glass rounded-xl p-3 max-w-sm w-full text-center pointer-events-auto shadow-2xl border border-white/10 max-h-[100dvh] overflow-y-auto">
        {/* Info */}
        <p className="text-gray-400 text-[10px] mb-1 font-bold uppercase tracking-tight">
          {isCounterPhase 
            ? 'カウンター確認中' 
            : (isCounterDoubt 
                ? `${lastPlayerName} のカウンターへダウト？` 
                : `${lastPlayerName}: ${gameState.field.currentCardCount}枚 ${isDiscard ? '捨' : '出'}`)}
        </p>
        
        <div className="text-2xl font-black mb-1 text-game-accent-light leading-none" style={{ fontFamily: 'Orbitron, sans-serif' }}>
          {isCounterPhase ? '待機中' : `宣言: ${getDeclaredNumberDisplay(declaredNum)} (${gameState.field.currentCardCount}枚)`}
        </div>
        {pendingNumbers && (
          <div className="bg-game-danger/20 border border-game-danger/30 rounded-md p-1 mb-2">
            <p className="text-game-danger text-[10px] font-black">
              対象: {pendingNumbers.map(n => getDeclaredNumberDisplay(n)).join(', ')}
            </p>
          </div>
        )}
        {/* Effect status */}
        {getCardEffectName(declaredNum, gameState.rules.isRevolution) && gameState.field.isEffectActive && (declaredNum !== 4 || isCounterDoubt) && (
          <div className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-500 animate-pulse-glow mb-2">
            {getCardEffectName(declaredNum, gameState.rules.isRevolution)}
          </div>
        )}

        {/* Timer bar */}
        {!isCounterPhase && (
          <div className="w-full h-1.5 bg-game-card rounded-full mb-3 overflow-hidden">
            <div
              className="doubt-timer-bar h-full"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {/* Buttons */}
        {isCounterPhase ? (
          gameState.pendingEffect?.playerId === myId ? (
            <div className="py-2 text-game-accent-light text-sm font-bold animate-pulse">
              🛡️ 待機中...
            </div>
          ) : gameState.counterActorId === myId && !hasActed ? (
            <button
              onClick={handleSkip}
              className="w-full py-2 rounded-lg bg-game-card text-gray-400 text-sm font-bold"
            >
              スルー
            </button>
          ) : isMyCards ? (
            <div className="py-2 text-gray-500 text-sm">判定待ち...</div>
          ) : hasActed ? (
            <div className="py-2 text-game-accent-light text-sm font-bold animate-pulse font-black">WAITING...</div>
          ) : (
            <div className="py-2 text-gray-400 text-[10px]">
              {gameState.players.find(p => p.id === (gameState.pendingEffect?.playerId || gameState.counterActorId))?.name || '他者'} の判断待ち
            </div>
          )
        ) : (
          /* Normal doubt logic */
          gameState.pendingEffect?.playerId === myId ? null : (
            !isMyCards && !hasActed ? (
              <div className="space-y-2">
                <button
                  onClick={handleDoubt}
                  className="w-full py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-rose-500 text-white text-xl font-black shadow-lg shadow-red-900/20 active:scale-95 transition-all"
                  style={{ fontFamily: 'Orbitron, sans-serif' }}
                >
                  ダウト！
                </button>
                <button
                  onClick={handleSkip}
                  className="w-full py-2 rounded-lg bg-white/5 text-gray-400 text-xs font-bold"
                >
                  スルー
                </button>
              </div>
            ) : isMyCards ? (
              <div className="py-2 text-gray-500 text-sm">判定待ち...</div>
            ) : (
            <div className="py-2 text-game-accent-light text-sm font-black animate-pulse">完了</div>
            )
          )
        )}
      </div>
    </div>
  );
}
