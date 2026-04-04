import { Server, Socket } from 'socket.io';
import { RoomManager } from '../room/roomManager';
import { GameEngine } from '../game/engine';
import { DoubtManager, DoubtResult } from '../game/doubt';
import { AIEngine } from '../game/ai';

export function registerHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    console.log(`Player connected: ${socket.id}`);

    // ===== LOBBY =====

    socket.on('create-room', (data: { playerName: string; persistentId: string }, callback) => {
      const room = RoomManager.createRoom(socket.id, data.playerName, data.persistentId);
      socket.join(room.id);
      socket.join(socket.id); // For targeted emits via io.to(id)
      
      const payload = {
        players: room.players.map(p => ({ 
          id: p.id, 
          name: p.name,
          rankStats: p.rankStats,
          isAI: p.isAI
        })),
        hostId: room.hostId,
      };
      
      callback({ success: true, roomId: room.id, roomInfo: payload });
      io.to(room.id).emit('room-update', payload);
    });

    socket.on('add-ai-player', (callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }
      if (room.hostId !== socket.id) { callback?.({ success: false, error: 'ホストのみAIを追加できます' }); return; }
      if (room.phase !== 'waiting') { callback?.({ success: false, error: 'ゲームは既に開始されています' }); return; }
      if (room.players.length >= 6) { callback?.({ success: false, error: 'ルームが満員です' }); return; }

      const aiCount = room.players.filter(p => p.isAI).length;
      const aiPlayer = {
        id: `ai_${Math.random().toString(36).substring(2, 9)}`,
        name: `COM ${aiCount + 1}`,
        hand: [],
        lives: 3,
        rank: null,
        isSkipped: false,
        isOut: false,
        persistentId: `ai_persistent_${Math.random()}`,
        rankStats: {},
        isAI: true
      };

      room.players.push(aiPlayer);

      const payload = {
        players: room.players.map(p => ({ 
          id: p.id, 
          name: p.name,
          rankStats: p.rankStats,
          isAI: p.isAI
        })),
        hostId: room.hostId,
      };
      callback?.({ success: true, roomInfo: payload });
      io.to(room.id).emit('room-update', payload);
    });

    socket.on('join-room', (data: { roomId: string; playerName: string; persistentId: string }, callback) => {
      const result = RoomManager.joinRoom(data.roomId, socket.id, data.playerName, data.persistentId);
      if (result.error) {
        callback({ success: false, error: result.error });
        return;
      }
      
      const room = result.room!;
      socket.join(data.roomId);
      socket.join(socket.id); // For targeted emits via io.to(id)

      if (result.isRejoin && result.oldId) {
        GameEngine.reassignPlayerId(room, result.oldId, socket.id);
        
        const updatedPayload = {
          players: room.players.map(p => ({ 
            id: p.id, 
            name: p.name,
            rankStats: p.rankStats,
            isAI: p.isAI
          })),
          hostId: room.hostId,
        };
        callback({ success: true, roomId: data.roomId, isRejoin: true, roomInfo: updatedPayload });
        
        const state = GameEngine.getClientState(room, socket.id);
        socket.emit('game-state', state);

        io.to(data.roomId).emit('room-update', updatedPayload);
      } else {
        const payload = {
          players: room.players.map(p => ({ 
            id: p.id, 
            name: p.name,
            rankStats: p.rankStats,
            isAI: p.isAI
          })),
          hostId: room.hostId,
        };
        callback({ success: true, roomId: data.roomId, roomInfo: payload });
        io.to(data.roomId).emit('room-update', payload);
      }
    });

    socket.on('leave-room', () => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) return;

      const roomId = room.id;
      socket.leave(roomId);
      const result = RoomManager.leaveRoom(roomId, socket.id);

      if (result.deleted) {
        io.to(roomId).emit('room-deleted');
      } else if (result.room) {
        io.to(roomId).emit('room-update', {
          players: result.room.players.map(p => ({ 
            id: p.id, 
            name: p.name,
            rankStats: p.rankStats,
            isAI: p.isAI
          })),
          hostId: result.room.hostId,
        });
      }
    });

    // ===== GAME =====

    socket.on('start-game', (data: any, callback?: any) => {
      let settings;
      let cb = callback;

      if (typeof data === 'function') {
        cb = data;
      } else {
        settings = data?.settings;
      }

      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { cb?.({ success: false, error: 'ルームが見つかりません' }); return; }
      if (room.hostId !== socket.id) { cb?.({ success: false, error: 'ホストのみゲームを開始できます' }); return; }
      if (room.players.length < 2) { cb?.({ success: false, error: '最低2人のプレイヤーが必要です' }); return; }

      GameEngine.startGame(room, settings);

      broadcastGameState(io, room);

      cb?.({ success: true });
    });

    socket.on('play-again', (callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }
      if (room.hostId !== socket.id) { callback?.({ success: false, error: 'ホストのみ再戦を開始できます' }); return; }

      GameEngine.startGame(room, { doubtTime: room.rules.doubtTime });

      broadcastGameState(io, room);

      callback?.({ success: true });
    });

    socket.on('play-cards', (data: { cardIds: string[]; declaredNumber: number }, callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }

      const player = room.players.find(p => p.id === socket.id);
      if (!player || player.isOut || player.lives <= 0) { callback?.({ success: false, error: 'ゲームに参加できません' }); return; }

      const result = GameEngine.playCards(room, socket.id, data.cardIds, data.declaredNumber);
      if (!result.success) {
        callback?.({ success: false, error: result.error });
        return;
      }

      callback?.({ success: true });

      // If game ended
      if (room.phase === 'result') {
        broadcastGameState(io, room);
        return;
      }

      // Start doubt phase or counter phase
      if (!result.skipDoubt && room.phase === 'doubtPhase') {
        startDoubtTimer(io, room);
      } else if (room.phase === 'counterPhase') {
        startCounterTimer(io, room);
      } else {
        broadcastGameState(io, room);
      }
    });

    socket.on('declare-doubt', (callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }
      if (room.phase !== 'doubtPhase') { callback?.({ success: false, error: 'ダウトフェーズではありません' }); return; }
      
      const player = room.players.find(p => p.id === socket.id);
      if (!player || player.isOut || player.lives <= 0) { callback?.({ success: false, error: 'アクションできません' }); return; }

      const success = DoubtManager.registerDoubt(room, socket.id);
      callback?.({ success });

      if (success) {
        io.to(room.id).emit('doubt-declared', { playerId: socket.id });
      }
    });

    socket.on('skip-doubt', (callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }
      if (room.phase !== 'doubtPhase' && room.phase !== 'counterPhase') { callback?.({ success: false, error: 'スキップ可能なフェーズではありません' }); return; }
      
      const player = room.players.find(p => p.id === socket.id);
      if (!player || player.isOut || player.lives <= 0) { callback?.({ success: false, error: 'アクションできません' }); return; }

      if (room.phase === 'counterPhase') {
        const counterActorId = room.counterActorIndex !== null ? room.turnOrder[room.counterActorIndex] : null;
        if (socket.id !== counterActorId) { callback?.({ success: false, error: 'あなたの順番ではありません' }); return; }
        
        callback?.({ success: true });
        const hasNext = GameEngine.advanceCounterActor(room);
        if (hasNext) {
          startCounterTimer(io, room);
        } else {
          resolveAndBroadcastCounter(io, room);
        }
        return;
      }

      const isAllResolved = DoubtManager.registerSkip(room, socket.id);
      callback?.({ success: true });

      if (isAllResolved) {
        resolveAndBroadcastDoubt(io, room);
      }
    });

    socket.on('declare-counter', (data: { cardIds: string[] }, callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }
      if (room.phase !== 'doubtPhase' && room.phase !== 'counterPhase') { callback?.({ success: false, error: '現在はカウンターできません' }); return; }
      
      const player = room.players.find(p => p.id === socket.id);
      if (!player || player.isOut || player.lives <= 0) { callback?.({ success: false, error: 'カウンターできません' }); return; }
      
      if (room.phase === 'counterPhase') {
        const counterActorId = room.counterActorIndex !== null ? room.turnOrder[room.counterActorIndex] : null;
        if (socket.id !== counterActorId) { callback?.({ success: false, error: 'あなたの順番ではありません' }); return; }
      }
      
      const result = GameEngine.declareCounter(room, socket.id, data.cardIds);
      if (!result.success) {
        callback?.({ success: false, error: result.error });
        return;
      }

      callback?.({ success: true });
      io.to(room.id).emit('counter-declared', { playerId: socket.id });

      // Start timer to allow others to doubt the counter
      startDoubtTimer(io, room);
    });

    socket.on('pass-turn', (callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }

      const player = room.players.find(p => p.id === socket.id);
      if (!player || player.isOut || player.lives <= 0) { callback?.({ success: false, error: 'パスできません' }); return; }

      const result = GameEngine.passTurn(room, socket.id);
      if (!result.success) {
        callback?.({ success: false, error: result.error });
        return;
      }

      callback?.({ success: true });
      broadcastGameState(io, room);
    });

    socket.on('effect-action', (data: { cardIds: string[]; targetData?: { numbers?: number[] } }, callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }

      const player = room.players.find(p => p.id === socket.id);
      const isEffectActor = room.pendingEffect && room.pendingEffect.playerId === socket.id;
      if (!player || ((player.isOut || player.lives <= 0) && !isEffectActor)) { callback?.({ success: false, error: 'アクションできません' }); return; }

      const result = GameEngine.handleEffectAction(room, socket.id, data.cardIds, data.targetData);
      if (!result.success) {
        callback?.({ success: false, error: result.error });
        return;
      }

      callback?.({ success: true });

      // Start doubt phase or counter phase if needed
      if (room.phase === 'doubtPhase') {
        startDoubtTimer(io, room);
      } else if (room.phase === 'counterPhase') {
        startCounterTimer(io, room);
      } else {
        broadcastGameState(io, room);
      }
    });

    // ===== DISCONNECT =====

    socket.on('disconnect', () => {
      console.log(`Player disconnected: ${socket.id}`);
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (room) {
        const roomId = room.id;
        const result = RoomManager.leaveRoom(roomId, socket.id);
        if (result.deleted) {
          io.to(roomId).emit('room-deleted');
        } else if (result.room) {
          io.to(roomId).emit('room-update', {
            players: result.room.players.map(p => ({ 
              id: p.id, 
              name: p.name,
              rankStats: p.rankStats
            })),
            hostId: result.room.hostId,
          });
        }
      }
    });
  });
}

function broadcastGameState(io: Server, room: import('../game/types').Room): void {
  // Update win rates asynchronously for spectators
  const hasSpectators = room.players.some(p => p.isOut);
  if (hasSpectators && room.phase !== 'waiting' && room.phase !== 'result') {
    AIEngine.updateWinRates(room).then(() => {
      // Re-broadcast to EVERYTHING in the room so spectators get the new winRates
      // getClientState(room, id) automatically handles winRate visibility based on isSpectator
      for (const p of room.players) {
        const state = GameEngine.getClientState(room, p.id);
        io.to(p.id).emit('game-state', state);
      }
      console.log(`[Spectator Sync] Updated win rates broadcast to room ${room.id}`);
    }).catch((err) => {
      console.error(`[Spectator Sync] Error updating win rates:`, err);
    });
  }

  for (const player of room.players) {
    const state = GameEngine.getClientState(room, player.id);
    io.to(player.id).emit('game-state', state);
  }

  // Trigger AI effect decisions if applicable
  if (room.phase === 'effectPhase') {
    AIEngine.runEffectDecision(room, () => {
      console.log(`AI Effect decision made. Current phase: ${room.phase}`);
      if (room.phase === 'doubtPhase') {
        console.log(`[Phase Sync] AI effect (Q-Bomber?) triggered doubt. Starting timer.`);
        startDoubtTimer(io, room);
      } else if (room.phase === 'counterPhase') {
        console.log(`[Phase Sync] AI effect led to counter phase. Starting counter timer.`);
        startCounterTimer(io, room);
      } else {
        broadcastGameState(io, room);
      }
    });
  }

  // Trigger AI turn if it's an AI's turn
  if (room.phase === 'playing') {
    const currentPlayerId = room.turnOrder[room.currentPlayerIndex];
    const currentPlayer = room.players.find(p => p.id === currentPlayerId);
    if (currentPlayer && currentPlayer.isAI && !currentPlayer.isOut) {
      AIEngine.runPlayTurn(room, currentPlayerId, (actionType, result) => {
        console.log(`[AI Decision] ${currentPlayer.name} chose ${actionType.toUpperCase()}`);
        if (actionType === 'play' && result && result.success) {
          // If game ended
          if (room.phase === 'result') {
            console.log(`[Game End] AI finished game. Syncing...`);
            broadcastGameState(io, room);
            return;
          }

          // Start doubt phase or counter phase
          if (!result.skipDoubt && room.phase === 'doubtPhase') {
            console.log(`[Phase Sync] Starting doubt timer for AI play.`);
            startDoubtTimer(io, room);
          } else if (room.phase === 'counterPhase') {
            console.log(`[Phase Sync] Starting counter timer for AI play.`);
            startCounterTimer(io, room);
          } else {
            console.log(`[Phase Sync] Transitions finished. Syncing.`);
            broadcastGameState(io, room);
          }
        } else {
          // Pass or Error
          console.log(`[AI Pass/Error] Syncing state.`);
          broadcastGameState(io, room);
        }
      });
    }
  }
}

function resolveAndBroadcastDoubt(io: Server, room: import('../game/types').Room): void {
  // Prevent race condition (timer expiring exactly when clients click skip)
  if (room.phase !== 'doubtPhase' && room.phase !== 'counterPhase') {
    return;
  }

  if (room.doubtTimerId) {
    clearTimeout(room.doubtTimerId);
    room.doubtTimerId = null;
  }

  const originalDoubtType = room.field.doubtType;
  const doubtResult = DoubtManager.resolveDoubt(room);
  GameEngine.handleDoubtResult(room, doubtResult);

  const payload: any = {
    type: doubtResult.type,
  };

  if (doubtResult.type !== 'noDoubt') {
    payload.revealedCards = doubtResult.revealedCards;
    payload.count = doubtResult.count;
    payload.doubtType = originalDoubtType;
  }

  if (doubtResult.type === 'counter') {
    payload.countererId = doubtResult.countererId;
    payload.lastPlayerId = doubtResult.lastPlayerId;
    if (doubtResult.doubterId) {
      payload.doubterId = doubtResult.doubterId;
    }
  } else if (doubtResult.type === 'success') {
    payload.doubterId = doubtResult.doubterId;
    payload.liarId = doubtResult.liarId;
    payload.penaltyCardCount = doubtResult.penaltyCardCount;
  } else if (doubtResult.type === 'failure') {
    payload.doubterId = doubtResult.doubterId;
    payload.honestPlayerId = doubtResult.honestPlayerId;
    payload.penaltyCardCount = doubtResult.penaltyCardCount;
  }

  io.to(room.id).emit('doubt-result', payload);

  // Broadcast updated state after short delay for animation
  setTimeout(() => {
    if (room.phase === 'counterPhase') {
      startCounterTimer(io, room);
    } else {
      broadcastGameState(io, room);
    }
  }, 1500);
}

function resolveAndBroadcastCounter(io: Server, room: import('../game/types').Room): void {
  // Clearing timer
  if (room.doubtTimerId) {
    clearTimeout(room.doubtTimerId);
    room.doubtTimerId = null;
  }

  // Reuse resolveDoubt for counter logic
  const result = DoubtManager.resolveDoubt(room);
  GameEngine.handleDoubtResult(room, result);

  if (result.type === 'counter') {
    const payload: any = {
      type: 'counter',
      countererId: result.countererId,
      lastPlayerId: result.lastPlayerId,
      count: result.count,
    };
    // Only send revealedCards if they were actually revealed (doubt failure/success or counter success)
    if (result.wasRevealed) {
      payload.revealedCards = result.revealedCards;
    }
    io.to(room.id).emit('doubt-result', payload);
  } else {
    // No counter
    // Handle the effect (8-cut etc) normally through handleDoubtResult 
    // Wait, handleDoubtResult was already called above.
  }

  broadcastGameState(io, room);
}

function startDoubtTimer(io: Server, room: import('../game/types').Room): void {
  DoubtManager.startDoubtPhase(room, (r) => {
    resolveAndBroadcastDoubt(io, r);
  });
  
  AIEngine.runDoubtDecision(
    room, 
    (playerId) => { 
      const name = room.players.find(p => p.id === playerId)?.name;
      console.log(`[AI Doubt] ${name} declared doubt.`);
      io.to(room.id).emit('doubt-declared', { playerId }); 
    },
    () => { 
      console.log(`[AI Doubt] All AI skipped/resolved. Syncing...`);
      resolveAndBroadcastDoubt(io, room); 
    }
  );
  
  broadcastGameState(io, room);
}

function startCounterTimer(io: Server, room: import('../game/types').Room): void {
  // Requirement 3: Counter phase decision time is now unlimited.
  // We do NOT call DoubtManager.startDoubtPhase which sets a timeout.
  // Instead, we just set the phase and broadcast to wait for user action.
  room.phase = 'counterPhase';
  
  // Clear any existing timer just in case
  if (room.doubtTimerId) {
    clearTimeout(room.doubtTimerId);
    room.doubtTimerId = null;
  }

  AIEngine.runCounterDecision(
    room,
    (playerId) => { io.to(room.id).emit('counter-declared', { playerId }); startDoubtTimer(io, room); },
    () => {
      const hasNext = GameEngine.advanceCounterActor(room);
      if (hasNext) {
        startCounterTimer(io, room);
      } else {
        resolveAndBroadcastCounter(io, room);
      }
    }
  );

  broadcastGameState(io, room);
}

