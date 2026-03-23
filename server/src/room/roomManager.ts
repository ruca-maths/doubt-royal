import { Room, Player, FieldState, RulesState } from '../game/types';
import { v4 as uuidv4 } from 'uuid';

const rooms = new Map<string, Room>();

export class RoomManager {
  static createRoom(hostId: string, hostName: string): Room {
    const roomId = uuidv4().slice(0, 6).toUpperCase();

    const host: Player = {
      id: hostId,
      name: hostName,
      hand: [],
      lives: 3,
      rank: null,
      isSkipped: false,
      isOut: false,
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
    };

    rooms.set(roomId, room);
    return room;
  }

  static joinRoom(roomId: string, playerId: string, playerName: string): { room?: Room; error?: string } {
    const room = rooms.get(roomId);
    if (!room) return { error: 'ルームが見つかりません' };
    if (room.phase !== 'waiting') return { error: 'ゲームは既に開始されています' };
    if (room.players.length >= 6) return { error: 'ルームが満員です' };
    if (room.players.some(p => p.id === playerId)) return { error: '既にルームに参加しています' };

    const player: Player = {
      id: playerId,
      name: playerName,
      hand: [],
      lives: 3,
      rank: null,
      isSkipped: false,
      isOut: false,
    };

    room.players.push(player);
    return { room };
  }

  static leaveRoom(roomId: string, playerId: string): { room?: Room; deleted?: boolean } {
    const room = rooms.get(roomId);
    if (!room) return {};

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

  static deleteRoom(roomId: string): void {
    const room = rooms.get(roomId);
    if (room?.doubtTimerId) {
      clearTimeout(room.doubtTimerId);
    }
    rooms.delete(roomId);
  }
}
