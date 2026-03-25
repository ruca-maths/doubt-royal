import React, { useEffect, useRef, useState } from 'react';
import { useGame } from '../contexts/GameContext';
import { getDeclaredNumberDisplay } from '../utils/cardUtils';

export default function GameLog() {
  const { gameState } = useGame();
  const [isOpen, setIsOpen] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll to bottom when new logs arrive
    if (isOpen) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [gameState?.logs, isOpen]);

  if (!gameState || !gameState.logs) return null;

  return (
    <div 
      className={`absolute right-4 top-20 bottom-32 glass rounded-2xl flex flex-col overflow-hidden z-20 border border-white/10 shadow-xl transition-all duration-300 ${
        isOpen ? 'w-64 opacity-100' : 'w-12 h-12 opacity-80 overflow-hidden'
      }`}
    >
      <div className="bg-black/60 p-3 border-b border-white/10 shrink-0 flex items-center justify-between">
        {isOpen && (
          <h3 className="text-white text-xs font-bold flex items-center gap-2" style={{ fontFamily: 'Orbitron, sans-serif' }}>
            <span className="text-game-accent">📜</span> TIMELINE
          </h3>
        )}
        <button 
          onClick={() => setIsOpen(!isOpen)}
          className={`p-1 hover:bg-white/10 rounded transition-colors ${!isOpen ? 'w-full h-full' : ''}`}
          title={isOpen ? "隠す" : "履歴を表示"}
        >
          {isOpen ? '◀' : '📜'}
        </button>
      </div>
      
      {isOpen && (
        <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
          {gameState.logs.map(log => {
            let content = null;

            switch (log.action) {
              case 'play':
                content = (
                  <div className="text-sm">
                    <span className="font-bold text-game-accent-light">{log.playerName}</span> が
                    {log.declaredNumber !== undefined && (
                      <span className="mx-1 px-1.5 py-0.5 rounded bg-white/10 text-white font-black border border-white/20">
                        {getDeclaredNumberDisplay(log.declaredNumber)}
                      </span>
                    )}
                    を {log.cardCount}枚 出しました。
                  </div>
                );
                break;
              case 'pass':
                content = (
                  <div className="text-sm text-gray-400 italic">
                    <span className="font-normal text-gray-300">{log.playerName}</span> がパスしました。
                  </div>
                );
                break;
              case 'discard':
                content = (
                  <div className="text-sm text-gray-300">
                    <span className="font-bold">{log.playerName}</span> が {log.cardCount}枚 の手札を捨てました。
                  </div>
                );
                break;
              case 'doubtSuccess':
                content = (
                  <div className="text-sm">
                    <span className="font-bold text-green-400">🚨 ダウト成功！</span>
                    <div className="mt-1 text-xs text-gray-300 bg-white/5 p-1.5 rounded">
                      <span className="font-bold text-game-accent-light">{log.playerName}</span> の指摘正解。
                      実際のカード: 
                      <span className="mx-1 font-bold text-white">
                        {log.revealedCards?.map(c => c.isJoker ? '🃏' : c.number).join(', ')}
                      </span>
                    </div>
                  </div>
                );
                break;
              case 'doubtFailure':
                content = (
                  <div className="text-sm">
                    <span className="font-bold text-red-400">❌ ダウト失敗...</span>
                    <div className="mt-1 text-xs text-gray-300 bg-white/5 p-1.5 rounded">
                      <span className="font-bold text-game-accent-light">{log.playerName}</span> の指摘外れ。
                      正直に出していました: 
                      <span className="mx-1 font-bold text-white">
                        {log.revealedCards?.map(c => c.isJoker ? '🃏' : c.number).join(', ')}
                      </span>
                    </div>
                  </div>
                );
                break;
              case 'counter':
                content = (
                  <div className="text-sm">
                    <span className="font-bold text-yellow-400">🛡️ カウンター！</span>
                    <div className="mt-1 text-xs">
                      <span className="font-bold text-game-accent-light">{log.playerName}</span> が 
                      カウンターを発動！
                    </div>
                  </div>
                );
                break;
              case 'revenge':
                content = (
                  <div className="text-sm">
                    <span className="font-black text-game-accent-light">🔮 スペ3返し！</span>
                    <div className="mt-1 text-xs text-game-gold font-bold italic">
                      {log.playerName} が場と手札を逆転させた！
                    </div>
                  </div>
                );
                break;
              case 'sevenPass':
                content = (
                  <div className="text-sm text-blue-300">
                    <span className="font-bold">{log.playerName}</span> が 
                    <span className="text-white font-bold mx-1">{log.cardCount}枚</span> を
                    <span className="font-bold text-game-accent-light"> {log.targetPlayerName}</span> へ渡しました。
                  </div>
                );
                break;
              case 'sixCollect':
                content = (
                  <div className="text-sm text-purple-300">
                    <span className="font-bold">{log.playerName}</span> が
                    表向き墓地から <span className="text-white font-bold">{log.cardCount}枚</span> を回収しました。
                    {log.collectedCards && log.collectedCards.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {log.collectedCards.map((c, i) => (
                          <span key={i} className="text-[10px] bg-white/10 px-1 rounded text-white">
                            {c.isJoker ? '🃏' : `${getDeclaredNumberDisplay(c.number)}`}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
                break;
              case 'queenBomber':
                content = (
                  <div className="text-sm text-pink-400">
                    <span className="font-bold">💣 Qボンバー！</span>
                    <div className="text-xs text-gray-300 mt-1">
                      {log.playerName} が数字 
                      <span className="text-white font-bold mx-1">
                         {log.targetNumbers?.map(n => getDeclaredNumberDisplay(n)).join(', ')}
                      </span>
                      を爆破しました。
                    </div>
                  </div>
                );
                break;
              case 'doubtCardSelect':
                content = (
                  <div className="text-sm text-orange-300">
                    <span className="font-bold">{log.playerName}</span> が
                    <span className="text-white font-bold mx-1">{log.cardCount}枚</span> を
                    <span className="font-bold text-game-accent-light"> {log.targetPlayerName}</span> へ押し付けました。
                  </div>
                );
                break;
              case 'eightCut':
                content = (
                  <div className="text-sm text-cyan-400 text-center font-bold">
                    ✂️ {log.playerName} の 8切り！
                  </div>
                );
                break;
              case 'revolution':
                content = (
                  <div className="text-sm text-game-gold text-center font-black animate-pulse">
                    🔥 革命発生！ 🔥
                  </div>
                );
                break;
            }

            return (
              <div key={log.id} className="bg-black/20 rounded-lg p-2 border border-white/5 animate-fade-in hover:bg-white/5 transition-colors">
                {content}
                <div className="text-[10px] text-gray-500 mt-1 text-right">
                  {new Date(log.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second:'2-digit' })}
                </div>
              </div>
            );
          })}
          <div ref={logsEndRef} />
        </div>
      )}
    </div>
  );
}
