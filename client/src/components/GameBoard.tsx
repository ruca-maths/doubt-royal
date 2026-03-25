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
    <div className="min-h-screen relative overflow-hidden">
      {/* Game info bar */}
      <div className="absolute top-0 left-0 right-0 z-20">
        <div className="flex items-center justify-between px-6 py-3 glass-light">
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

      {/* Other players - Scrollable horizontal list */}
      <div className="absolute top-14 left-0 right-0 z-10 px-4 max-w-full">
        <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide py-2 items-start justify-center md:justify-start">
          {otherPlayers.map((player) => (
            <PlayerInfo
              key={player.id}
              player={player}
              isMe={false}
            />
          ))}
        </div>
      </div>

      {/* Center field */}
      <div className="absolute top-[42%] left-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
        <div className="glass rounded-2xl px-8 py-6 min-w-[240px]">
          {gameState.field.lastPlayerId ? (
            <>
              <p className="text-xs text-gray-500 mb-1">
                {gameState.players.find(p => p.id === gameState.field.lastPlayerId)?.name} が出した
              </p>
              <div className="flex justify-center gap-1 mb-2">
                {gameState.field.revealedCards && gameState.field.revealedCards.length > 0 ? (
                  gameState.field.revealedCards.map((c, i) => (
                    <div key={c.id || i} className="w-10 h-14 rounded-md shadow-lg transform rotate-[-5deg]" style={{ marginLeft: i > 0 ? '-1rem' : '0' }}>
                      <Card card={c} small faceDown={false} />
                    </div>
                  ))
                ) : (
                  Array.from({ length: gameState.field.currentCardCount }).map((_, i) => (
                    <div key={i} className="w-10 h-14 rounded-md card-back shadow-lg transform rotate-[-5deg]" style={{ marginLeft: i > 0 ? '-1rem' : '0' }} />
                  ))
                )}
              </div>
              <div className="text-3xl font-black text-game-accent-light" style={{ fontFamily: 'Orbitron, sans-serif' }}>
                {getDeclaredNumberDisplay(gameState.field.declaredNumber)}
              </div>
              
              {/* Phase 13: Q-Bomber Target Numbers */}
              {gameState.field.pendingNumbers && gameState.field.pendingNumbers.length > 0 && (
                <div className="mt-2 animate-pulse">
                  <div className="text-[10px] text-game-danger font-bold uppercase tracking-wider">Targeting</div>
                  <div className="flex justify-center gap-1">
                    {gameState.field.pendingNumbers.map(num => (
                      <span key={num} className="bg-game-danger/20 text-game-danger px-2 py-0.5 rounded text-sm font-black border border-game-danger/30">
                        {num === 0 ? 'JOKER' : num}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-gray-600 py-4">
              <p className="text-lg font-bold mb-1">場にカードなし</p>
              <p className="text-xs">最初のカードを出してください</p>
            </div>
          )}

          {/* Grave info */}
          <div className="mt-4 pt-3 border-t border-white/5 flex justify-around">
            <div className="text-center">
              <div className="text-[10px] text-gray-500 uppercase mb-0.5">裏墓地</div>
              <div className="text-lg font-black text-gray-400">{gameState.field.cardHistoryCount}</div>
            </div>
            <div className="text-center cursor-pointer hover:scale-105 transition-transform" onClick={() => setShowFaceUpPool(true)}>
              <div className="text-[10px] text-game-accent-light uppercase mb-0.5">表墓地</div>
              <div className="text-lg font-black text-white glow-text-accent">{gameState.field.faceUpPool.length}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Spacer to prevent overlap between field and my hand area */}
      <div className="h-32" />

      {/* My hand area */}
      <div className="absolute bottom-0 left-0 right-0 z-20">
        {/* Action buttons */}
        <div className="flex justify-center gap-3 mb-3 px-4">
          {isMyTurn && gameState.phase === 'playing' && (
            <>
              <button
                onClick={() => setShowPlayModal(true)}
                disabled={selectedCardIds.length === 0}
                className={`px-6 py-2.5 rounded-xl font-bold transition-all duration-200 ${
                  selectedCardIds.length > 0
                    ? 'bg-gradient-to-r from-game-accent to-purple-500 text-white hover:opacity-90 glow-accent'
                    : 'bg-game-card/80 text-gray-600 cursor-not-allowed'
                }`}
              >
                出す ({selectedCardIds.length})
              </button>
              <button
                onClick={passTurn}
                className="px-6 py-2.5 rounded-xl font-bold bg-game-card/80 hover:bg-game-border text-gray-300 transition-all"
              >
                パス
              </button>
            </>
          )}

          {!isMyTurn && gameState.phase === 'playing' && (
            <div className="px-4 py-2 rounded-xl bg-game-card/50 text-gray-500 text-sm">
              {gameState.players.find(p => p.id === gameState.currentPlayerId)?.name} のターン...
            </div>
          )}

          {gameState.phase === 'counterPhase' && gameState.counterActorId === myId && (
            <button
               onClick={handleDeclareCounter}
               disabled={selectedCardIds.length === 0}
               className={`px-6 py-2.5 rounded-xl font-bold transition-all duration-200 ${
                 selectedCardIds.length > 0
                   ? 'bg-gradient-to-r from-game-accent to-purple-500 text-white hover:opacity-90 glow-accent shadow-glow'
                   : 'bg-game-card/80 text-gray-600 cursor-not-allowed'
               }`}
               style={{ fontFamily: 'Orbitron, sans-serif' }}
             >
               カウンター！ ({selectedCardIds.length})
             </button>
          )}
        </div>

        {/* Hand */}
        <div className="glass-light px-4 py-4">
          {myPlayer && (
            <div className="flex items-center gap-2 mb-2 px-2">
              <div className="flex gap-0.5">
                {Array.from({ length: 3 }).map((_, i) => (
                  <span key={i} className={`text-xs ${i < myPlayer.lives ? '' : 'opacity-20'}`}>❤️</span>
                ))}
              </div>
              <span className="text-xs text-gray-500">{gameState.myHand.length}枚</span>
            </div>
          )}
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

      {/* Game Logs (Timeline) */}
      <GameLog />

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
    </div>
  );
}
