import React, { useState } from 'react';
import { useGame } from '../contexts/GameContext';
import Card from './Card';
import { getDeclaredNumberDisplay, sortCards } from '../utils/cardUtils';

export default function InteractionModal() {
  const { gameState, myId, effectAction, skipDoubt, declareCounter } = useGame();
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([]);

  const effect = gameState?.pendingEffect;
  if (!effect || effect.playerId !== myId) return null;

  const toggleCard = (cardId: string) => {
    // Phase 4: Prevent selecting excluded cards (destroyed by Q-Bomber)
    const card = allMyCards.find(c => c.id === cardId);
    const excludedNumbers = (effect as any).excludedNumbers as number[] | undefined;
    if (card && excludedNumbers) {
      if (excludedNumbers.includes(card.number) || (excludedNumbers.includes(0) && card.isJoker)) {
        return; // Restricted
      }
    }

    setSelectedCardIds(prev =>
      prev.includes(cardId)
        ? prev.filter(id => id !== cardId)
        : prev.length < effect.count ? [...prev, cardId] : prev
    );
  };

  const toggleNumber = (num: number) => {
    setSelectedNumbers(prev =>
      prev.includes(num)
        ? prev.filter(n => n !== num)
        : prev.length < effect.count ? [...prev, num] : prev
    );
  };

  const handleConfirm = () => {
    if (effect.type === 'queenBomber') {
      effectAction([], { numbers: selectedNumbers });
    } else if (effect.type === 'counterSelection') {
      declareCounter(selectedCardIds);
    } else {
      effectAction(selectedCardIds);
    }
    setSelectedCardIds([]);
    setSelectedNumbers([]);
  };

  const titles: Record<string, string> = {
    sevenPass: '7渡し — カードを送る',
    sixCollect: '6回収 — カードを回収',
    tenDiscard: '10捨て札 — カードを捨てる',
    queenBomber: 'Qボンバー — 数字を指定',
    doubtCardSelect: 'ダウト報酬 — カードを渡す',
    counterSelection: 'カウンター形式 — カードを選択',
  };

  const descriptions: Record<string, string> = {
    sevenPass: `手札から${effect.count}枚以下のカードを選んで次のプレイヤーに渡してください（0枚でも可）`,
    sixCollect: `表向き墓地から${effect.count}枚以下のカードを選んで手札に加えてください（0枚でも可）`,
    tenDiscard: `手札から${effect.count}枚以下のカードを選んで捨ててください（0枚でも可）`,
    queenBomber: `最大${effect.count}個の数字を指定してください（全員がその数字を強制捨て。0個でも可）`,
    doubtCardSelect: `自分の手札から${effect.count}枚以下のカードを選んで、相手に渡してください（0枚でも可）`,
    counterSelection: `${getDeclaredNumberDisplay(gameState?.field.declaredNumber === 8 ? 4 : 3)}を${effect.count}枚選んでカウンターしてください`,
  };

  // Cards to pick from
  const allMyCards = gameState?.myHand || [];
  let pickableCards = allMyCards;
  if (effect.type === 'sixCollect') {
    pickableCards = gameState?.field.faceUpPool || [];
  }
  pickableCards = sortCards(pickableCards);

  const excludedNumbers = (effect as any).excludedNumbers as number[] | undefined;

  const isReady =
    effect.type === 'counterSelection'
      ? selectedCardIds.length === effect.count
      : (effect.type === 'queenBomber' ? selectedNumbers.length <= effect.count : selectedCardIds.length <= effect.count);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fade-in">
      <div className="glass rounded-2xl p-6 max-w-lg w-full mx-4 animate-slide-up">
        <h3 className="text-xl font-bold text-center mb-1" style={{ fontFamily: 'Orbitron, sans-serif' }}>
          {titles[effect.type] || '特殊効果'}
        </h3>
        <p className="text-sm text-gray-400 text-center mb-4">
          {descriptions[effect.type] || ''}
        </p>

        {/* Number selector for Queen Bomber (N numbers) */}
        {effect.type === 'queenBomber' && (
          <div className="mb-4">
            <p className="text-xs text-game-accent uppercase mb-2 text-center">数字を選択</p>
            <div className="grid grid-cols-7 gap-2">
              {Array.from({ length: 13 }, (_, i) => i + 1).map(num => (
                <button
                  key={num}
                  onClick={() => toggleNumber(num)}
                  className={`py-2 px-1 rounded-lg text-sm font-bold transition-all ${
                    selectedNumbers.includes(num)
                      ? 'bg-game-accent text-white scale-110 shadow-glow'
                      : 'bg-game-card hover:bg-game-border text-gray-300'
                  }`}
                >
                  {getDeclaredNumberDisplay(num)}
                </button>
              ))}
              <button
                onClick={() => toggleNumber(0)}
                className={`py-2 px-1 rounded-lg text-sm font-bold transition-all ${
                  selectedNumbers.includes(0)
                    ? 'bg-game-accent text-white scale-110 shadow-glow'
                    : 'bg-game-card hover:bg-game-border text-gray-300'
                }`}
              >
                🃏
              </button>
            </div>
          </div>
        )}

        {/* Card picker (for everything except Queen Bomber) */}
        {effect.type !== 'queenBomber' && (
          <div className="flex flex-wrap justify-center gap-2 mb-6 max-h-60 overflow-y-auto p-2">
            {pickableCards.map(card => {
              const isExcluded = excludedNumbers && (excludedNumbers.includes(card.number) || (excludedNumbers.includes(0) && card.isJoker));
              return (
                <div key={card.id} className={isExcluded ? 'opacity-30 grayscale cursor-not-allowed' : ''}>
                  <Card
                    card={card}
                    selected={selectedCardIds.includes(card.id)}
                    onClick={() => !isExcluded && toggleCard(card.id)}
                    small
                  />
                  {isExcluded && <div className="text-[10px] text-game-danger font-bold text-center mt-[-4px]">破壊済</div>}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-3">
          {effect.type === 'counterSelection' && (
            <button
               onClick={() => {
                 skipDoubt();
                 setSelectedCardIds([]);
               }}
               className="flex-1 py-3 rounded-xl bg-game-card hover:bg-game-border text-gray-400 font-semibold transition-all"
            >
              パス
            </button>
          )}
          <button
            onClick={handleConfirm}
            disabled={!isReady}
            className={`flex-1 py-3 rounded-xl font-bold transition-all ${
              isReady
                ? 'bg-gradient-to-r from-game-accent to-purple-500 text-white glow-accent'
                : 'bg-game-card text-gray-600 cursor-not-allowed'
            }`}
          >
            {isReady ? '確定して実行' : '選択してください'}
          </button>
        </div>
      </div>
    </div>
  );
}
