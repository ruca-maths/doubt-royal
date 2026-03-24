import { Server, Socket } from 'socket.io';
import { RoomManager } from '../room/roomManager';
import { GameEngine } from '../game/engine';
import { DoubtManager, DoubtResult } from '../game/doubt';

export function registerHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    console.log(`Player connected: ${socket.id}`);

    // ===== LOBBY =====

    socket.on('create-room', (data: { playerName: string; persistentId: string }, callback) => {
      const room = RoomManager.createRoom(socket.id, data.playerName, data.persistentId);
      socket.join(room.id);
      
      const payload = {
        players: room.players.map(p => ({ id: p.id, name: p.name })),
        hostId: room.hostId,
      };
      
      callback({ success: true, roomId: room.id, roomInfo: payload });
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

      if (result.isRejoin && result.oldId) {
        GameEngine.reassignPlayerId(room, result.oldId, socket.id);
        
        const updatedPayload = {
          players: room.players.map(p => ({ id: p.id, name: p.name })),
          hostId: room.hostId,
        };
        callback({ success: true, roomId: data.roomId, isRejoin: true, roomInfo: updatedPayload });
        
        const state = GameEngine.getClientState(room, socket.id);
        socket.emit('game-state', state);

        io.to(data.roomId).emit('room-update', updatedPayload);
      } else {
        const payload = {
          players: room.players.map(p => ({ id: p.id, name: p.name })),
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
          players: result.room.players.map(p => ({ id: p.id, name: p.name })),
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

      // Send personalized game state to each player
      for (const player of room.players) {
        const state = GameEngine.getClientState(room, player.id);
        io.to(player.id).emit('game-state', state);
      }

      cb?.({ success: true });
    });

    socket.on('play-again', (callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }
      if (room.hostId !== socket.id) { callback?.({ success: false, error: 'ホストのみ再戦を開始できます' }); return; }

      GameEngine.startGame(room, { doubtTime: room.rules.doubtTime });

      // Send personalized game state to each player
      for (const player of room.players) {
        const state = GameEngine.getClientState(room, player.id);
        io.to(player.id).emit('game-state', state);
      }

      callback?.({ success: true });
    });

    socket.on('play-cards', (data: { cardIds: string[]; declaredNumber: number }, callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }

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

      // Start doubt phase (unless explicitly skipped)
      if (!result.skipDoubt && room.phase === 'doubtPhase') {
        startDoubtTimer(io, room);
      } else {
        broadcastGameState(io, room);
      }
    });

    socket.on('declare-doubt', (callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }
      if (room.phase !== 'doubtPhase') { callback?.({ success: false, error: 'ダウトフェーズではありません' }); return; }

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

      const isAllResolved = DoubtManager.registerSkip(room, socket.id);
      callback?.({ success: true });

      if (isAllResolved) {
        if (room.phase === 'doubtPhase') {
          resolveAndBroadcastDoubt(io, room);
        } else {
          resolveAndBroadcastCounter(io, room);
        }
      }
    });

    socket.on('declare-counter', (data: { cardIds: string[] }, callback) => {
      const room = RoomManager.getRoomByPlayerId(socket.id);
      if (!room) { callback?.({ success: false, error: 'ルームが見つかりません' }); return; }
      if (room.phase !== 'doubtPhase' && room.phase !== 'counterPhase') { callback?.({ success: false, error: '現在はカウンターできません' }); return; }
      
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

      const result = GameEngine.handleEffectAction(room, socket.id, data.cardIds, data.targetData);
      if (!result.success) {
        callback?.({ success: false, error: result.error });
        return;
      }

      callback?.({ success: true });

      if (room.phase === 'doubtPhase') {
        startDoubtTimer(io, room);
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
            players: result.room.players.map(p => ({ id: p.id, name: p.name })),
            hostId: result.room.hostId,
          });
        }
      }
    });
  });
}

function broadcastGameState(io: Server, room: import('../game/types').Room): void {
  for (const player of room.players) {
    const state = GameEngine.getClientState(room, player.id);
    io.to(player.id).emit('game-state', state);
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
    io.to(room.id).emit('doubt-result', {
      type: 'counter',
      countererId: result.countererId,
      lastPlayerId: result.lastPlayerId,
      revealedCards: result.revealedCards,
      count: result.count,
    });
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
  
  broadcastGameState(io, room);
}

function startCounterTimer(io: Server, room: import('../game/types').Room): void {
  // Use same mechanism as doubt phase for simplicity, same duration
  DoubtManager.startDoubtPhase(room, (r) => {
    resolveAndBroadcastCounter(io, r);
  });
  room.phase = 'counterPhase'; // Override back to counterPhase
  
  broadcastGameState(io, room);
}
