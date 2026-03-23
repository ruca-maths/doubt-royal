import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { Socket } from 'socket.io-client';
import { ClientGameState, RoomInfo, DoubtResult } from '../types/game';

interface GameContextValue {
  // Connection
  socket: Socket | null;
  isConnected: boolean;
  myId: string | null;

  // Lobby
  playerName: string;
  setPlayerName: (name: string) => void;
  roomId: string | null;
  roomInfo: RoomInfo | null;
  createRoom: () => void;
  joinRoom: (roomId: string) => void;
  leaveRoom: () => void;
  startGame: (settings?: { doubtTime: number }) => void;

  // Game
  gameState: ClientGameState | null;
  doubtResult: DoubtResult | null;
  playCards: (cardIds: string[], declaredNumber: number) => void;
  passTurn: () => void;
  playAgain: () => void;
  declareDoubt: () => void;
  skipDoubt: () => void;
  declareCounter: (cardIds: string[]) => void;
  effectAction: (cardIds: string[], targetData?: { numbers?: number[] }) => void;

  // UI state
  error: string | null;
  clearError: () => void;
}

const GameContext = createContext<GameContextValue | null>(null);

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used within GameProvider');
  return ctx;
}

interface GameProviderProps {
  children: ReactNode;
  socket: Socket | null;
  isConnected: boolean;
}

export function GameProvider({ children, socket, isConnected }: GameProviderProps) {
  const [playerName, setPlayerName] = useState('');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [gameState, setGameState] = useState<ClientGameState | null>(null);
  const [doubtResult, setDoubtResult] = useState<DoubtResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const myId = socket?.id || null;

  useEffect(() => {
    if (!socket) return;

    socket.on('room-update', (data: RoomInfo) => {
      setRoomInfo(data);
    });

    socket.on('room-deleted', () => {
      setRoomId(null);
      setRoomInfo(null);
      setGameState(null);
    });

    socket.on('game-state', (state: ClientGameState) => {
      setGameState(state);
    });

    socket.on('doubt-result', (data: DoubtResult) => {
      setDoubtResult(data);
      // Show result for 4 seconds to allow animations to complete
      setTimeout(() => setDoubtResult(null), 4000);
    });

    socket.on('doubt-declared', (data: { playerId: string }) => {
      // Notification handled in UI or effect
    });

    socket.on('counter-declared', (data: { playerId: string }) => {
      // Notification handled in UI
    });

    return () => {
      socket.off('room-update');
      socket.off('room-deleted');
      socket.off('game-state');
      socket.off('doubt-result');
      socket.off('doubt-declared');
      socket.off('counter-declared');
    };
  }, [socket]);

  const createRoom = useCallback(() => {
    if (!socket || !playerName.trim()) return;
    socket.emit('create-room', { playerName: playerName.trim() }, (res: any) => {
      if (res.success) {
        setRoomId(res.roomId);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }, [socket, playerName]);

  const joinRoom = useCallback((targetRoomId: string) => {
    if (!socket || !playerName.trim()) return;
    socket.emit('join-room', { roomId: targetRoomId, playerName: playerName.trim() }, (res: any) => {
      if (res.success) {
        setRoomId(res.roomId);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }, [socket, playerName]);

  const leaveRoom = useCallback(() => {
    if (!socket) return;
    socket.emit('leave-room');
    setRoomId(null);
    setRoomInfo(null);
    setGameState(null);
  }, [socket]);

  const startGame = useCallback((settings?: { doubtTime: number }) => {
    if (!socket) return;
    socket.emit('start-game', { settings }, (res: any) => {
      if (!res.success) setError(res.error);
    });
  }, [socket]);

  const playAgain = useCallback(() => {
    if (!socket) return;
    socket.emit('play-again', (res: any) => {
      if (!res.success) setError(res.error);
    });
  }, [socket]);

  const playCards = useCallback((cardIds: string[], declaredNumber: number) => {
    if (!socket) return;
    socket.emit('play-cards', { cardIds, declaredNumber }, (res: any) => {
      if (!res.success) setError(res.error);
    });
  }, [socket]);

  const passTurn = useCallback(() => {
    if (!socket) return;
    socket.emit('pass-turn', (res: any) => {
      if (!res.success) setError(res.error);
    });
  }, [socket]);

  const declareDoubt = useCallback(() => {
    if (!socket) return;
    socket.emit('declare-doubt', (res: any) => {
      if (!res.success) setError(res.error);
    });
  }, [socket]);

  const declareCounter = useCallback((cardIds: string[]) => {
    if (!socket) return;
    socket.emit('declare-counter', { cardIds }, (res: any) => {
      if (!res.success) setError(res.error);
    });
  }, [socket]);

  const skipDoubt = useCallback(() => {
    if (!socket) return;
    socket.emit('skip-doubt', (res: any) => {
      if (!res.success) setError(res.error);
    });
  }, [socket]);

  const effectAction = useCallback((cardIds: string[], targetData?: { numbers?: number[] }) => {
    if (!socket) return;
    socket.emit('effect-action', { cardIds, targetData }, (res: any) => {
      if (!res.success) setError(res.error);
    });
  }, [socket]);

  const clearError = useCallback(() => setError(null), []);

  const value: GameContextValue = {
    socket, isConnected, myId,
    playerName, setPlayerName,
    roomId, roomInfo,
    createRoom, joinRoom, leaveRoom, startGame,
    gameState, doubtResult,
    playCards, passTurn, playAgain, declareDoubt, skipDoubt, declareCounter, effectAction,
    error, clearError,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}
