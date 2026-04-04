import { Room, Player, FieldState, RulesState } from '../game/types';
import { v4 as uuidv4 } from 'uuid';

const rooms = new Map<string, Room>();

export class RoomManager {
  static createRoom(hostId: string, hostName: string, persistentId: string): Room {
    let roomId = '';
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars
    do {
      roomId = '';
      for (let i = 0; i < 6; i++) {
        roomId += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (rooms.has(roomId));

    const host: Player = {
      id: hostId,
      name: hostName,
      hand: [],
      lives: 3,
      rank: null,
      isSkipped: false,
      isOut: false,
      persistentId,
      rankStats: {},
    };

    const room: Room = {
      id: roomId,
      hostId,
      players: [host],
      phase: 'waiting',
      field: {
        currentCards: [],
        declaredNumber: 0,
        cardHistory: [],
        faceUpPool: [],
        lastPlayerId: null,
        doubtType: null,
        counteredBy: null,
        hasFieldCleared: false,
      },
      rules: {
        direction: 1,
        isRevolution: false,
        isElevenBack: false,
        doubtTime: 5,
      },
      currentPlayerIndex: 0,
      turnOrder: [],
      finishOrder: [],
      doubtDeclarers: [],
      doubtSkippers: [],
      pendingEffect: null,
      deferredEffect: null,
      doubtTimerId: null,
      logs: [],
      pendingFinishPlayerId: null,
      counterActorIndex: null,
      passCount: 0,
      winRates: {}, 
    };

    rooms.set(roomId, room);
    return room;
  }

  static joinRoom(roomId: string, playerId: string, playerName: string, persistentId: string): { room?: Room; error?: string; isRejoin?: boolean; oldId?: string } {
    const room = rooms.get(roomId);
    if (!room) return { error: 'ルームが見つかりません' };

    // Check for rejoin first (persistentId is the unique identifier for a session)
    // We do NOT require playerName to match, in case they re-entered a different name
    // but have the same session. This prevents creating duplicate 'phantom' players.
    const existingPlayer = room.players.find(p => p.persistentId === persistentId);
    if (existingPlayer) {
      if (existingPlayer.name !== playerName && playerName.trim() !== '') {
        existingPlayer.name = playerName.trim(); // Update to new name if provided
      }
      const oldId = existingPlayer.id;
      return { room, isRejoin: true, oldId };
    }

    if (room.phase !== 'waiting') return { error: 'ゲームは既に開始されています' };
    if (room.players.length >= 6) return { error: 'ルームが満員です' };

    const player: Player = {
      id: playerId,
      name: playerName,
      hand: [],
      lives: 3,
      rank: null,
      isSkipped: false,
      isOut: false,
      persistentId,
      rankStats: {},
    };

    room.players.push(player);
    return { room };
  }

  static leaveRoom(roomId: string, playerId: string): { room?: Room; deleted?: boolean } {
    const room = rooms.get(roomId);
    if (!room) return {};

    // If game has started, don't remove the player, just let them be disconnected.
    // They can rejoin using persistentId.
    if (room.phase !== 'waiting') {
      return { room };
    }

    room.players = room.players.filter(p => p.id !== playerId);

    if (room.players.length === 0) {
      rooms.delete(roomId);
      return { deleted: true };
    }

    // Transfer host if host left
    if (room.hostId === playerId) {
      room.hostId = room.players[0].id;
    }

    return { room };
  }

  static getRoom(roomId: string): Room | undefined {
    return rooms.get(roomId);
  }

  static getRoomByPlayerId(playerId: string): Room | undefined {
    for (const room of rooms.values()) {
      if (room.players.some(p => p.id === playerId)) return room;
    }
    return undefined;
  }

  static reassignPlayerId(room: Room, oldId: string, newId: string): void {
    if (oldId === newId) return;
    
    // 1. Update Room host
    if (room.hostId === oldId) room.hostId = newId;
    
    // 2. Update player objects
    for (const p of room.players) {
      if (p.id === oldId) p.id = newId;
    }
    
    // 3. Update turnOrder and finishOrder
    room.turnOrder = room.turnOrder.map(id => id === oldId ? newId : id);
    room.finishOrder = room.finishOrder.map(id => id === oldId ? newId : id);
    
    // 4. Update Field state
    if (room.field.lastPlayerId === oldId) room.field.lastPlayerId = newId;
    if (room.field.counteredBy === oldId) room.field.counteredBy = newId;
    
    // 5. Update Doubt systems
    room.doubtDeclarers = room.doubtDeclarers.map(id => id === oldId ? newId : id);
    room.doubtSkippers = room.doubtSkippers.map(id => id === oldId ? newId : id);
    
    // 6. Update Effects
    if (room.pendingEffect) {
      if (room.pendingEffect.playerId === oldId) room.pendingEffect.playerId = newId;
      if (room.pendingEffect.targetPlayerId === oldId) room.pendingEffect.targetPlayerId = newId;
    }
    if (room.deferredEffect) {
      if (room.deferredEffect.playerId === oldId) room.deferredEffect.playerId = newId;
      if (room.deferredEffect.targetPlayerId === oldId) room.deferredEffect.targetPlayerId = newId;
    }
    if (room.pendingFinishPlayerId === oldId) room.pendingFinishPlayerId = newId;

    // 7. Update WinRates keys
    if (room.winRates && room.winRates[oldId] !== undefined) {
      room.winRates[newId] = room.winRates[oldId];
      delete room.winRates[oldId];
    }
  }

  static deleteRoom(roomId: string): void {
    const room = rooms.get(roomId);
    if (room?.doubtTimerId) {
      clearTimeout(room.doubtTimerId);
    }
    rooms.delete(roomId);
  }
}
