import React, { Suspense, lazy } from 'react';
import { useSocket } from './hooks/useSocket';
import { GameProvider, useGame } from './contexts/GameContext';
import Lobby from './components/Lobby';
import GameBoard from './components/GameBoard';

// 開発時のみ: ?mock=... でサーバーなしのフィールド表示 (src/dev/MockField.tsx)
const MockField = import.meta.env.DEV ? lazy(() => import('./dev/MockField')) : null;
const useMock = import.meta.env.DEV && new URLSearchParams(window.location.search).has('mock');

function AppContent() {
  const { gameState } = useGame();

  if (gameState) {
    return <GameBoard />;
  }

  return <Lobby />;
}

export default function App() {
  if (useMock && MockField) {
    return (
      <Suspense fallback={null}>
        <MockField />
      </Suspense>
    );
  }
  return <LiveApp />;
}

function LiveApp() {
  const { socket, isConnected } = useSocket();

  return (
    <GameProvider socket={socket} isConnected={isConnected}>
      <AppContent />
    </GameProvider>
  );
}
