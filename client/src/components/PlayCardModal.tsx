import React, { useState, useMemo } from 'react';
import { getDeclaredNumberDisplay, getValidDeclarations } from '../utils/cardUtils';
import { useGame } from '../contexts/GameContext';

interface PlayCardModalProps {
  selectedCount: number;
  onConfirm: (declaredNumber: number) => void;
  onCancel: () => void;
}

export default function PlayCardModal({ selectedCount, onConfirm, onCancel }: PlayCardModalProps) {
  const [declaredNumber, setDeclaredNumber] = useState<number | null>(null);
  const { gameState } = useGame();

  const validNumbers = useMemo(() => {
    if (!gameState) return Array.from({ length: 13 }, (_, i) => i + 1);
    const { declaredNumber: currentNum, currentCardCount } = gameState.field;
    const isReversed = gameState.rules.isRevolution !== gameState.rules.isElevenBack;
    return getValidDeclarations(currentNum, currentCardCount, isReversed);
  }, [gameState]);

  const numbers = Array.from({ length: 13 }, (_, i) => i + 1);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fade-in">
      <div className="glass rounded-2xl p-6 max-w-md w-full mx-4 animate-slide-up">
        <h3 className="text-xl font-bold text-center mb-1" style={{ fontFamily: 'Orbitron, sans-serif' }}>
          カードを出す
        </h3>
        <p className="text-sm text-gray-400 text-center mb-4">
          {selectedCount}枚選択中 — 宣言する数字を選んでください
        </p>

        {/* Number selector */}
        <div className="grid grid-cols-7 gap-2 mb-6">
          {numbers.map(num => {
            const isValid = validNumbers.includes(num);
            return (
              <button
                key={num}
                onClick={() => isValid && setDeclaredNumber(num)}
                disabled={!isValid}
                className={`py-2 px-1 rounded-lg text-sm font-bold transition-all duration-200 ${
                  !isValid ? 'bg-game-card/50 text-gray-700 cursor-not-allowed border border-gray-800/50' :
                  declaredNumber === num
                    ? 'bg-game-accent text-white glow-accent scale-110'
                    : 'bg-game-card hover:bg-game-border text-gray-300 hover:text-white'
                }`}
              >
                {getDeclaredNumberDisplay(num)}
              </button>
            );
          })}
          {validNumbers.includes(0) && (
            <div className="col-span-7 mt-2">
              <button
                onClick={() => setDeclaredNumber(0)}
                className={`w-full py-2 px-1 rounded-lg text-sm font-bold transition-all duration-200 ${
                  declaredNumber === 0
                    ? 'bg-game-accent text-white glow-accent scale-105'
                    : 'bg-game-card hover:bg-game-border text-gray-300 hover:text-white'
                }`}
              >
                {getDeclaredNumberDisplay(0)}
              </button>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-3 rounded-xl bg-game-card hover:bg-game-border text-gray-300 font-semibold transition-all duration-200"
          >
            キャンセル
          </button>
          <button
            onClick={() => declaredNumber !== null && onConfirm(declaredNumber)}
            disabled={declaredNumber === null}
            className={`flex-1 py-3 rounded-xl font-semibold transition-all duration-200 ${
              declaredNumber !== null
                ? 'bg-gradient-to-r from-game-accent to-purple-500 text-white hover:opacity-90 glow-accent'
                : 'bg-game-card text-gray-600 cursor-not-allowed'
            }`}
          >
            出す！
          </button>
        </div>
      </div>
    </div>
  );
}
