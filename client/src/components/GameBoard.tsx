import React, { useState, useMemo } from 'react';
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

  // Result screen
  if (gameState.phase === 'result') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass rounded-3xl p-8 max-w-md w-full text-center animate-bounce-in">
          <div className="text-6xl mb-4">🏆</div>
          <h2 className="text-3xl font-black mb-6" style={{ fontFamily: 'Orbitron, sans-serif' }}>
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
            {/* Players who were eliminated */}
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
                className="w-full px-8 py-3 rounded-xl font-bold bg-gradient-to-r from-game-accent to-purple-500 text-white hover:opacity-90 glow-accent shadow-glow transition-all"
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

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-[#0a0e1a]">
      {/* Portrait Blocker */}
      <div className="hidden portrait:flex fixed inset-0 z-[100] bg-black items-center justify-center p-8 text-center flex-col">
        <div className="text-6xl mb-6">📱🔄</div>
        <h2 className="text-2xl font-black mb-4 text-white" style={{ fontFamily: 'Orbitron, sans-serif' }}>端末を横向きに<br/>してください</h2>
        <p className="text-gray-400 text-sm font-bold">このゲームは横画面でプレイするよう設計されています。<br/>画面の向きのロックを解除して横に傾けてください。</p>
      </div>

      {/* Main Game Area */}
      <div className="flex-1 flex flex-col relative overflow-hidden">
        
        {/* Game info bar (HEADER) */}
        <div className="shrink-0 z-20">
          <div className="flex items-center justify-between px-4 py-2 glass-light border-b border-white/5">
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500 font-mono">ROOM: {gameState.roomId}</span>
              {gameState.rules.isRevolution && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-game-gold/20 text-game-gold font-semibold animate-pulse">
                  🔄 革命中
                </span>
              )}
              {gameState.rules.isElevenBack && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 font-semibold">
                  ↩️ 11バック
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">
                方向: {gameState.rules.direction === 1 ? '→ 時計回り' : '← 反時計回り'}
              </span>
            </div>
          </div>
        </div>

        {/* Other players (TOP) */}
        <div className="shrink-0 z-10 px-2 w-full pt-1">
          <div className="flex gap-4 overflow-x-auto pb-1 scrollbar-hide items-start justify-center md:justify-start">
            {otherPlayers.map((player) => (
              <PlayerInfo
                key={player.id}
                player={player}
                isMe={false}
              />
            ))}
          </div>
        </div>

        {/* Center field (MIDDLE) */}
        <div className="flex-1 flex flex-col items-center justify-center px-4 overflow-hidden relative">
          <div className="glass rounded-2xl px-6 py-4 min-w-[200px] w-auto max-w-md my-auto">
            {gameState.field.lastPlayerId ? (
              <>
                <p className="text-[10px] text-gray-500 mb-1">
                  {gameState.players.find(p => p.id === gameState.field.lastPlayerId)?.name} が出した
                </p>
                <div className="flex justify-center gap-1 mb-2">
                  {gameState.field.revealedCards && gameState.field.revealedCards.length > 0 ? (
                    gameState.field.revealedCards.map((c, i) => (
                      <div key={c.id || i} className="w-8 h-12 rounded-md shadow-lg transform rotate-[-5deg]" style={{ marginLeft: i > 0 ? '-0.75rem' : '0' }}>
                        <Card card={c} small faceDown={false} />
                      </div>
                    ))
                  ) : (
                    Array.from({ length: gameState.field.currentCardCount }).map((_, i) => (
                      <div key={i} className="w-8 h-12 rounded-md card-back shadow-lg transform rotate-[-5deg]" style={{ marginLeft: i > 0 ? '-0.75rem' : '0' }} />
                    ))
                  )}
                </div>
                <div className="text-3xl font-black text-game-accent-light leading-none" style={{ fontFamily: 'Orbitron, sans-serif' }}>
                  {getDeclaredNumberDisplay(gameState.field.declaredNumber)}
                </div>
                
                {/* Phase 13: Q-Bomber Target Numbers */}
                {gameState.field.pendingNumbers && gameState.field.pendingNumbers.length > 0 && (
                  <div className="mt-1 animate-pulse">
                    <div className="text-[9px] text-game-danger font-bold uppercase tracking-wider">Targeting</div>
                    <div className="flex justify-center gap-1">
                      {gameState.field.pendingNumbers.map(num => (
                        <span key={num} className="bg-game-danger/20 text-game-danger px-1 py-0.5 rounded text-xs font-black border border-game-danger/30">
                          {num === 0 ? 'JOKER' : num}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-gray-600 py-2">
                <p className="text-sm font-bold mb-1">場にカードなし</p>
              </div>
            )}

            {/* Grave info */}
            <div className="mt-2 pt-2 border-t border-white/5 flex justify-around">
              <div className="text-center">
                <div className="text-[9px] text-gray-500 uppercase">裏墓地</div>
                <div className="text-sm font-black text-gray-400">{gameState.field.cardHistoryCount}</div>
              </div>
              <div className="text-center cursor-pointer hover:scale-105 transition-transform" onClick={() => setShowFaceUpPool(true)}>
                <div className="text-[9px] text-game-accent-light uppercase">表墓地</div>
                <div className="text-sm font-black text-white glow-text-accent">{gameState.field.faceUpPool.length}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Action buttons and My hand area (BOTTOM) */}
        <div className="shrink-0 z-20 flex flex-col w-full">
          {/* Action buttons */}
          <div className="flex justify-center flex-wrap gap-2 mb-1 px-2 pt-2 bg-black/20 border-t border-white/5">
            {isMyTurn && gameState.phase === 'playing' && (
              <>
                <button
                  onClick={() => setShowPlayModal(true)}
                  disabled={selectedCardIds.length === 0}
                  className={`px-4 py-1.5 rounded-lg font-bold text-sm transition-all duration-200 ${
                    selectedCardIds.length > 0
                      ? 'bg-gradient-to-r from-game-accent to-purple-500 text-white shadow-glow'
                      : 'bg-game-card/80 text-gray-600 cursor-not-allowed'
                  }`}
                >
                  出す ({selectedCardIds.length})
                </button>
                <button
                  onClick={passTurn}
                  className="px-4 py-1.5 rounded-lg font-bold text-sm bg-game-card/80 hover:bg-game-border text-gray-300 transition-all"
                >
                  パス
                </button>
              </>
            )}

            {!isMyTurn && gameState.phase === 'playing' && (
              <div className="px-3 py-1 rounded-lg bg-game-card/50 text-gray-500 text-xs">
                {gameState.players.find(p => p.id === gameState.currentPlayerId)?.name} のターン...
              </div>
            )}

            {gameState.phase === 'counterPhase' && gameState.counterActorId === myId && (
              <button
                 onClick={handleDeclareCounter}
                 disabled={selectedCardIds.length === 0}
                 className={`px-4 py-1.5 rounded-lg font-bold text-sm transition-all duration-200 ${
                   selectedCardIds.length > 0
                     ? 'bg-gradient-to-r from-game-accent to-purple-500 text-white shadow-glow'
                     : 'bg-game-card/80 text-gray-600 cursor-not-allowed'
                 }`}
               >
                 カウンター！ ({selectedCardIds.length})
               </button>
            )}
          </div>

          {/* Hand */}
          <div className="glass-light px-2 py-1 flex flex-col w-full h-[150px] overflow-hidden">
            {myPlayer && (
              <div className="flex items-center gap-2 mb-1 px-2 shrink-0">
                <div className="flex gap-0.5">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <span key={i} className={`text-[10px] ${i < myPlayer.lives ? '' : 'opacity-20'}`}>❤️</span>
                  ))}
                </div>
                <span className="text-[10px] text-gray-500">{gameState.myHand.length}枚</span>
              </div>
            )}
            <div className="w-full flex-1">
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
          </div>
        </div>
      </div>

      {/* Play card modal */}
      {showPlayModal && (
        <PlayCardModal
          selectedCount={selectedCardIds.length}
          onConfirm={handlePlayCards}
          onCancel={() => setShowPlayModal(false)}
        />
      )}

      {/* Doubt phase overlay */}
      <DoubtPhase doubtResult={doubtResult} />

      {/* Effect interaction modal */}
      <InteractionModal />

      {/* Game Logs (Timeline) is now rendered in the right pane */}

      {/* FaceUp pool modal */}
      {showFaceUpPool && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fade-in" onClick={() => setShowFaceUpPool(false)}>
          <div className="glass rounded-2xl p-6 max-w-lg w-full mx-4 animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-bold text-center flex-1 ml-6" style={{ fontFamily: 'Orbitron, sans-serif' }}>
                表向き墓地 ({gameState.field.faceUpPool.length}枚)
              </h3>
              <button onClick={() => setShowFaceUpPool(false)} className="text-gray-400 hover:text-white text-2xl">&times;</button>
            </div>
            
            <div className="flex flex-wrap gap-2 max-h-[60vh] overflow-y-auto p-2 justify-center">
              {sortCards(gameState.field.faceUpPool).map(card => (
                <div key={card.id}>
                  <Card card={card} selected={false} small />
                </div>
              ))}
              {gameState.field.faceUpPool.length === 0 && (
                <p className="text-gray-500 py-8">カードがありません</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Right Pane: Timeline */}
      <div className="w-48 sm:w-56 md:w-64 shrink-0 border-l border-white/10 relative bg-black/40 z-30">
        <GameLog />
      </div>
    </div>
  );
}
