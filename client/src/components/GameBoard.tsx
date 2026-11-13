import React, { useState } from 'react';
import { useGame } from '../contexts/GameContext';
import Hand from './Hand';
import Card from './Card';
import PlayerInfo from './PlayerInfo';
import PlayCardModal from './PlayCardModal';
import DoubtPhase from './DoubtPhase';
import InteractionModal from './InteractionModal';
import GameLog from './GameLog';
import { getDeclaredNumberDisplay, sortCards } from '../utils/cardUtils';

export default function GameBoard() {
  const { gameState, myId, playCards, passTurn, doubtResult, declareCounter, playAgain } = useGame();
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [showPlayModal, setShowPlayModal] = useState(false);
  const [showFaceUpPool, setShowFaceUpPool] = useState(false);
  const [isLogOpen, setIsLogOpen] = useState(false);

  if (!gameState) return null;

  const isMyTurn = gameState.currentPlayerId === myId;
  const myPlayer = gameState.players.find(p => p.id === myId);
  const otherPlayers = gameState.players.filter(p => p.id !== myId);

  const toggleCard = (cardId: string) => {
    setSelectedCardIds(prev =>
      prev.includes(cardId)
        ? prev.filter(id => id !== cardId)
        : [...prev, cardId]
    );
  };

  const handlePlayCards = (declaredNumber: number) => {
    playCards(selectedCardIds, declaredNumber);
    setSelectedCardIds([]);
    setShowPlayModal(false);
  };

  const handleDeclareCounter = () => {
    declareCounter(selectedCardIds);
    setSelectedCardIds([]);
  };

  if (gameState.phase === 'result') {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center overflow-y-auto p-3 sm:p-4">
        <div className="glass rounded-3xl p-5 sm:p-8 max-w-md w-full text-center animate-bounce-in">
          <div className="text-6xl mb-4">🏆</div>
          <h2 className="text-2xl sm:text-3xl font-black mb-6" style={{ fontFamily: 'Orbitron, sans-serif' }}>
            ゲーム終了
          </h2>
          <div className="space-y-3">
            {gameState.finishOrder.map((pId, i) => {
              const p = gameState.players.find(pl => pl.id === pId);
              if (!p) return null;
              return (
                <div
                  key={pId}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl ${
                    i === 0 ? 'bg-game-gold/10 border border-game-gold/30' :
                    i === 1 ? 'bg-gray-400/10 border border-gray-400/30' :
                    'bg-game-card/50'
                  }`}
                >
                  <span className="text-2xl">
                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`}
                  </span>
                  <span className={`font-bold flex-1 ${p.id === myId ? 'text-game-accent-light' : ''}`}>
                    {p.name}
                  </span>
                </div>
              );
            })}
            {gameState.players
              .filter(p => p.isOut && !gameState.finishOrder.includes(p.id))
              .map(p => (
                <div key={p.id} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-game-danger/5 opacity-60">
                  <span className="text-2xl">💀</span>
                  <span className="font-bold flex-1">{p.name}</span>
                  <span className="text-xs text-game-danger">脱落</span>
                </div>
              ))
            }
          </div>

          {gameState.hostId === myId ? (
            <div className="mt-8 text-center animate-fade-in" style={{ animationDelay: '0.6s' }}>
              <button
                onClick={playAgain}
                className="w-full min-h-12 px-6 py-3 rounded-xl font-bold bg-gradient-to-r from-game-accent to-purple-500 text-white hover:opacity-90 glow-accent shadow-glow transition-all"
                style={{ fontFamily: 'Orbitron, sans-serif' }}
              >
                次のゲームへ (もう一度遊ぶ)
              </button>
            </div>
          ) : (
            <div className="mt-8 text-center text-sm text-gray-500 animate-fade-in" style={{ animationDelay: '0.6s' }}>
              ホストの操作を待っています...
            </div>
          )}
        </div>
      </div>
    );
  }

  const currentPlayerName = gameState.players.find(p => p.id === gameState.currentPlayerId)?.name || '他のプレイヤー';

  return (
    <div className="flex h-[100dvh] w-full flex-col md:flex-row overflow-hidden bg-[#0a0e1a]">
      {/* Main game area */}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Compact header */}
        <header className="z-20 flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-white/5 glass-light px-3 py-2 sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <span className="shrink-0 font-mono text-[10px] text-gray-500 sm:text-xs">ROOM: {gameState.roomId}</span>
            {gameState.rules.isRevolution && (
              <span className="rounded-full bg-game-gold/20 px-2 py-1 text-[10px] font-semibold text-game-gold sm:text-xs">
                🔄 革命中
              </span>
            )}
            {gameState.rules.isElevenBack && (
              <span className="rounded-full bg-purple-500/20 px-2 py-1 text-[10px] font-semibold text-purple-400 sm:text-xs">
                ↩️ 11バック
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-xs text-gray-500 sm:inline">
              {gameState.rules.direction === 1 ? '→ 時計回り' : '← 反時計回り'}
            </span>
            <button
              type="button"
              onClick={() => setIsLogOpen(open => !open)}
              className="min-h-9 rounded-lg border border-white/10 bg-white/5 px-3 text-xs font-bold text-gray-300 transition-colors hover:bg-white/10 md:hidden"
              aria-expanded={isLogOpen}
              aria-label="対戦ログを切り替える"
            >
              📜 履歴
            </button>
          </div>
        </header>

        {/* Opponents: horizontally scrollable on narrow screens */}
        <section className="z-10 w-full shrink-0 px-2 pt-2 sm:px-3" aria-label="対戦相手">
          <div className="flex items-start gap-2 overflow-x-auto pb-2 scrollbar-hide sm:gap-3 md:justify-center">
            {otherPlayers.map(player => (
              <PlayerInfo key={player.id} player={player} isMe={false} />
            ))}
          </div>
        </section>

        {/* Table / current turn */}
        <section className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden px-3 py-3 sm:gap-4">
          {gameState.phase === 'playing' && (
            <div className={`rounded-full border px-4 py-2 text-center ${
              isMyTurn
                ? 'border-game-accent/40 bg-game-accent/15 text-game-accent-light'
                : 'border-white/10 bg-black/20 text-gray-300'
            }`}>
              <p className="text-[10px] font-black uppercase tracking-widest opacity-70">
                {isMyTurn ? 'YOUR TURN' : 'NOW PLAYING'}
              </p>
              <p className="max-w-[220px] truncate text-sm font-bold">
                {isMyTurn ? 'あなたの番です' : `${currentPlayerName} の番です`}
              </p>
            </div>
          )}

          <div className="glass relative w-full max-w-sm rounded-2xl border border-white/10 px-3 py-4 shadow-2xl sm:px-5 sm:py-5">
            {gameState.field.lastPlayerId ? (
              <>
                <div className="mb-3 flex min-h-14 items-center justify-center">
                  {gameState.field.revealedCards && gameState.field.revealedCards.length > 0 ? (
                    gameState.field.revealedCards.map((card, i) => (
                      <div
                        key={card.id || i}
                        className="relative h-12 w-8 shrink-0 rounded-md shadow-lg sm:h-14 sm:w-9"
                        style={{ marginLeft: i > 0 ? '-0.65rem' : '0', zIndex: i }}
                      >
                        <Card card={card} small faceDown={false} />
                      </div>
                    ))
                  ) : (
                    Array.from({ length: gameState.field.currentCardCount + (gameState.field.roundPileCount || 0) }).map((_, i) => (
                      <div
                        key={i}
                        className="relative h-12 w-8 shrink-0 rounded-md card-back shadow-lg sm:h-14 sm:w-9"
                        style={{ marginLeft: i > 0 ? '-0.65rem' : '0', zIndex: i }}
                      />
                    ))
                  )}
                </div>
                <div className="text-center text-2xl font-black leading-none text-game-accent-light sm:text-3xl" style={{ fontFamily: 'Orbitron, sans-serif' }}>
                  {getDeclaredNumberDisplay(gameState.field.declaredNumber)}
                  <span className="ml-2 text-sm font-semibold text-gray-400">({gameState.field.currentCardCount}枚)</span>
                </div>
                {gameState.field.pendingNumbers && gameState.field.pendingNumbers.length > 0 && (
                  <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                    {gameState.field.pendingNumbers.map(num => (
                      <span key={num} className="rounded-md border border-game-danger/30 bg-game-danger/20 px-2 py-1 text-[10px] font-black text-game-danger">
                        {num === 0 ? 'JOKER' : getDeclaredNumberDisplay(num)}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="py-4 text-center text-xs font-extrabold uppercase tracking-wider text-gray-500">
                まだカードは出ていません
              </div>
            )}
          </div>

          {/* Graveyard counters */}
          <div className="flex items-center justify-center gap-2">
            <div className="min-w-20 rounded-xl border border-white/10 bg-black/20 px-4 py-2 text-center">
              <p className="text-[10px] font-bold text-gray-500">裏向きの履歴</p>
              <p className="text-lg font-black leading-tight text-gray-200">{gameState.field.cardHistoryCount}</p>
            </div>
            <button
              type="button"
              onClick={() => setShowFaceUpPool(true)}
              className="min-w-20 rounded-xl border border-game-accent/20 bg-game-accent/10 px-4 py-2 text-center transition-colors hover:bg-game-accent/20"
              aria-label={`表向き墓地を表示、${gameState.field.faceUpPool.length}枚`}
            >
              <p className="text-[10px] font-bold text-game-accent-light">表向き墓地</p>
              <p className="text-lg font-black leading-tight text-white">{gameState.field.faceUpPool.length}</p>
            </button>
          </div>
        </section>

        {/* Player controls and hand */}
        <footer className="safe-area-bottom z-20 shrink-0 border-t border-white/10 bg-black/40">
          <div className="flex min-h-14 items-center justify-between gap-2 bg-black/20 px-3 py-2">
            <div className="flex min-w-[72px] items-center gap-1.5">
              {myPlayer && (
                <>
                  <div className="flex" aria-label={`残りライフ ${myPlayer.lives}`}>
                    {Array.from({ length: 3 }).map((_, i) => (
                      <span key={i} className={`text-xs ${i < myPlayer.lives ? '' : 'opacity-20'}`}>❤️</span>
                    ))}
                  </div>
                  <span className="text-xs font-bold text-gray-400">{gameState.myHand.length}枚</span>
                </>
              )}
            </div>

            <div className="flex flex-1 items-center justify-center gap-2">
              {isMyTurn && gameState.phase === 'playing' && myPlayer && !myPlayer.isOut && (
                <>
                  <button
                    onClick={() => setShowPlayModal(true)}
                    disabled={selectedCardIds.length === 0}
                    className={`min-h-11 min-w-24 rounded-xl px-4 py-2 text-sm font-bold transition-all ${
                      selectedCardIds.length > 0
                        ? 'bg-gradient-to-r from-game-accent to-purple-500 text-white shadow-glow'
                        : 'cursor-not-allowed bg-game-card/80 text-gray-600'
                    }`}
                  >
                    出す ({selectedCardIds.length})
                  </button>
                  <button
                    onClick={passTurn}
                    className="min-h-11 min-w-20 rounded-xl bg-game-card/80 px-4 py-2 text-sm font-bold text-gray-300 transition-all hover:bg-game-border"
                  >
                    パス
                  </button>
                </>
              )}

              {gameState.phase === 'counterPhase' && gameState.counterActorId === myId && (
                <button
                  onClick={handleDeclareCounter}
                  disabled={selectedCardIds.length === 0}
                  className={`min-h-11 min-w-32 rounded-xl px-4 py-2 text-sm font-bold transition-all ${
                    selectedCardIds.length > 0
                      ? 'bg-gradient-to-r from-game-accent to-purple-500 text-white shadow-glow'
                      : 'cursor-not-allowed bg-game-card/80 text-gray-600'
                  }`}
                >
                  カウンター！ ({selectedCardIds.length})
                </button>
              )}
              {!isMyTurn && gameState.phase === 'playing' && (
                <span className="text-xs text-gray-500">相手の手番です</span>
              )}
            </div>
            <div className="min-w-[72px] text-right">
              {myPlayer?.isOut && <span className="text-[10px] font-bold text-game-danger">観戦中</span>}
            </div>
          </div>

          <div className="w-full overflow-hidden pb-1">
            <Hand
              cards={gameState.myHand}
              selectedIds={selectedCardIds}
              onToggleSelect={toggleCard}
              disabled={
                !(isMyTurn && gameState.phase === 'playing') &&
                !(gameState.phase === 'counterPhase' && gameState.field.lastPlayerId !== myId)
              }
            />
          </div>
        </footer>
      </main>

      {/* Desktop timeline */}
      <aside
        className={`relative z-30 hidden shrink-0 flex-col border-l border-white/10 bg-black/40 transition-all duration-300 md:flex ${
          isLogOpen ? 'w-56 lg:w-64' : 'w-11'
        }`}
      >
        <GameLog isOpen={isLogOpen} onToggle={() => setIsLogOpen(open => !open)} />
      </aside>

      {/* Mobile timeline drawer */}
      {isLogOpen && (
        <div className="fixed inset-x-0 bottom-0 z-[70] h-[min(65dvh,460px)] rounded-t-2xl border-t border-game-accent/20 bg-[#0a0e1a] shadow-2xl md:hidden">
          <GameLog isOpen={true} onToggle={() => setIsLogOpen(false)} />
        </div>
      )}

      {showPlayModal && (
        <PlayCardModal
          selectedCount={selectedCardIds.length}
          onConfirm={handlePlayCards}
          onCancel={() => setShowPlayModal(false)}
        />
      )}

      <DoubtPhase doubtResult={doubtResult} />
      <InteractionModal />

      {showFaceUpPool && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 animate-fade-in"
          onClick={() => setShowFaceUpPool(false)}
        >
          <div className="glass max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-2xl p-4 sm:p-6 animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="flex-1 text-center text-base font-bold sm:text-xl" style={{ fontFamily: 'Orbitron, sans-serif' }}>
                表向き墓地 ({gameState.field.faceUpPool.length}枚)
              </h3>
              <button
                type="button"
                onClick={() => setShowFaceUpPool(false)}
                className="min-h-10 min-w-10 rounded-lg text-2xl text-gray-400 hover:bg-white/10 hover:text-white"
                aria-label="閉じる"
              >
                &times;
              </button>
            </div>
            <div className="flex max-h-[65dvh] flex-wrap justify-center gap-2 overflow-y-auto p-2">
              {sortCards(gameState.field.faceUpPool).map(card => (
                <div key={card.id}>
                  <Card card={card} selected={false} small />
                </div>
              ))}
              {gameState.field.faceUpPool.length === 0 && (
                <p className="py-8 text-gray-500">カードがありません</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
