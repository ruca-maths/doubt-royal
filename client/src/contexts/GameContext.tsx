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
  addAiPlayer: () => void;

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
  const [playerName, setPlayerName] = useState(() => sessionStorage.getItem('playerName') || '');
  const [roomId, setRoomId] = useState<string | null>(() => sessionStorage.getItem('roomId') || null);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [gameState, setGameState] = useState<ClientGameState | null>(null);
  const [doubtResult, setDoubtResult] = useState<DoubtResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const myId = socket?.id || null;

  const [persistentId] = useState(() => {
    let id = sessionStorage.getItem('persistentId');
    if (!id) {
      id = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      sessionStorage.setItem('persistentId', id);
    }
    return id;
  });

  // Sync playerName and roomId to sessionStorage
  useEffect(() => {
    sessionStorage.setItem('playerName', playerName);
  }, [playerName]);

  useEffect(() => {
    if (roomId) {
      sessionStorage.setItem('roomId', roomId);
    } else {
      sessionStorage.removeItem('roomId');
    }
  }, [roomId]);

  useEffect(() => {
    if (!socket) return;

    socket.on('room-update', (data: RoomInfo) => {
      console.log('[DEBUG] room-update received:', JSON.stringify(data, null, 2));
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
    socket.emit('create-room', { 
      playerName: playerName.trim(),
      persistentId 
    }, (res: any) => {
      console.log('[DEBUG] create-room callback:', res);
      if (res.success) {
        if (res.roomInfo) setRoomInfo(res.roomInfo);
        setRoomId(res.roomId);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }, [socket, playerName, persistentId]);

  const addAiPlayer = useCallback(() => {
    if (!socket) return;
    socket.emit('add-ai-player', (res: any) => {
      console.log('[DEBUG] add-ai-player callback:', res);
      if (res.success) {
        if (res.roomInfo) setRoomInfo(res.roomInfo);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }, [socket]);

  const joinRoom = useCallback((targetRoomId: string) => {
    if (!socket || !playerName.trim()) return;
    socket.emit('join-room', { 
      roomId: targetRoomId, 
      playerName: playerName.trim(),
      persistentId
    }, (res: any) => {
      console.log('[DEBUG] join-room callback:', res);
      if (res.success) {
        if (res.roomInfo) setRoomInfo(res.roomInfo);
        setRoomId(res.roomId);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }, [socket, playerName, persistentId]);

  // Handle auto-rejoin on refresh
  useEffect(() => {
    if (isConnected && socket && roomId && playerName && !roomInfo && !error) {
      console.log('Attempting auto-rejoin to', roomId);
      joinRoom(roomId);
    }
  }, [isConnected, socket, roomId, playerName, roomInfo, joinRoom, error]);

  // If room not found during rejoin, clear roomId
  useEffect(() => {
    if (error === 'ルームが見つかりません' && roomId) {
      setRoomId(null);
      setRoomInfo(null);
    }
  }, [error, roomId]);

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
    createRoom, joinRoom, leaveRoom, startGame, addAiPlayer,
    gameState, doubtResult,
    playCards, passTurn, playAgain, declareDoubt, skipDoubt, declareCounter, effectAction,
    error, clearError,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}
