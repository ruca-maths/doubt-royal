import React from 'react';
import { useSocket } from './hooks/useSocket';
import { GameProvider, useGame } from './contexts/GameContext';
import Lobby from './components/Lobby';
import GameBoard from './components/GameBoard';

function AppContent() {
  const { gameState } = useGame();

  if (gameState) {
    return <GameBoard />;
  }

  return <Lobby />;
}

export default function App() {
  const { socket, isConnected } = useSocket();

  return (
    <GameProvider socket={socket} isConnected={isConnected}>
      <AppContent />
    </GameProvider>
  );
}
