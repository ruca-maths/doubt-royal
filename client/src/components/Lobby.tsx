import React, { useState } from 'react';
import { useGame } from '../contexts/GameContext';

export default function Lobby() {
  const { playerName, setPlayerName, roomId, roomInfo, myId, createRoom, joinRoom, leaveRoom, startGame, isConnected, error, clearError } = useGame();
  const [joinRoomId, setJoinRoomId] = useState('');
  const [doubtTime, setDoubtTime] = useState(5);

  // Not connected
  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="glass rounded-2xl p-8 text-center animate-pulse">
          <div className="text-4xl mb-4">🃏</div>
          <p className="text-lg text-gray-400">サーバーに接続中...</p>
        </div>
      </div>
    );
  }

  // In a room
  if (roomId && roomInfo) {
    const isHost = roomInfo.hostId === myId;

    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass rounded-3xl p-8 max-w-md w-full animate-slide-up">
          {/* Room header */}
          <div className="text-center mb-6">
            <h2 className="text-2xl font-black mb-1" style={{ fontFamily: 'Orbitron, sans-serif' }}>
              ROOM
            </h2>
            <div className="inline-block px-4 py-2 rounded-xl bg-game-accent/20 border border-game-accent/30">
              <span className="text-2xl font-mono font-bold tracking-widest text-game-accent-light">
                {roomId}
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-2">この ID を共有してください</p>
          </div>

          {/* Player list */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
              プレイヤー ({roomInfo.players.length}/6)
            </h3>
            <div className="space-y-2">
              {roomInfo.players.map((p, i) => (
                <div
                  key={p.id}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                    p.id === myId ? 'bg-game-accent/10 border border-game-accent/20' : 'bg-game-card/50'
                  }`}
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    p.id === roomInfo.hostId ? 'bg-game-gold text-black' : 'bg-game-card text-gray-400'
                  }`}>
                    {p.id === roomInfo.hostId ? '👑' : i + 1}
                  </div>
                  <span className="font-medium flex-1">{p.name}</span>
                  {p.id === myId && <span className="text-xs text-game-accent-light">あなた</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-3">
            {isHost && (
              <div className="mb-4">
                <label className="block text-sm font-semibold text-gray-400 mb-2">ダウト判定時間 (秒)</label>
                <input
                  type="number"
                  min="3"
                  max="15"
                  value={doubtTime}
                  onChange={e => setDoubtTime(Number(e.target.value))}
                  className="w-full px-4 py-3 rounded-xl bg-game-card/50 border border-game-border text-white
                             focus:outline-none focus:border-game-accent/50 focus:ring-1 focus:ring-game-accent/30 transition-all"
                />
              </div>
            )}
            {isHost && (
              <button
                onClick={() => startGame({ doubtTime })}
                disabled={roomInfo.players.length < 2}
                className={`w-full py-4 rounded-xl font-bold text-lg transition-all duration-200 ${
                  roomInfo.players.length >= 2
                    ? 'bg-gradient-to-r from-game-accent to-purple-500 text-white hover:opacity-90 glow-accent'
                    : 'bg-game-card text-gray-600 cursor-not-allowed'
                }`}
                style={{ fontFamily: 'Orbitron, sans-serif' }}
              >
                {roomInfo.players.length < 2 ? '2人以上で開始可能' : 'ゲーム開始'}
              </button>
            )}
            {!isHost && (
              <div className="text-center py-4 text-gray-400">
                ホストがゲームを開始するのを待っています...
              </div>
            )}
            <button
              onClick={leaveRoom}
              className="w-full py-3 rounded-xl bg-game-card hover:bg-game-border text-gray-400 hover:text-white font-medium transition-all"
            >
              ルームを退出
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Join / Create
  return (
    <div className="min-h-screen overflow-y-auto custom-scrollbar flex flex-col items-center py-12 p-4">
      <div className="max-w-md w-full flex flex-col">
        {/* Title */}
        <div className="text-center mb-10">
          <h1
            className="text-5xl font-black mb-2 bg-gradient-to-r from-game-accent via-purple-400 to-pink-400 bg-clip-text text-transparent"
            style={{ fontFamily: 'Orbitron, sans-serif' }}
          >
            DOUBT
          </h1>
          <h2
            className="text-2xl font-bold text-gray-400"
            style={{ fontFamily: 'Orbitron, sans-serif' }}
          >
            ROYALE
          </h2>
          <p className="text-sm text-gray-600 mt-2">大富豪 × ダウト オンラインカードゲーム</p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-game-danger/10 border border-game-danger/20 text-game-danger text-sm flex justify-between items-center animate-shake">
            <span>{error}</span>
            <button onClick={clearError} className="ml-2 opacity-60 hover:opacity-100">✕</button>
          </div>
        )}

        <div className="glass rounded-3xl p-8 animate-slide-up">
          {/* Name input */}
          <div className="mb-6">
            <label className="block text-sm font-semibold text-gray-400 mb-2">プレイヤー名</label>
            <input
              type="text"
              value={playerName}
              onChange={e => setPlayerName(e.target.value)}
              placeholder="名前を入力..."
              maxLength={12}
              className="w-full px-4 py-3 rounded-xl bg-game-card border border-game-border text-white placeholder-gray-600
                         focus:outline-none focus:border-game-accent/50 focus:ring-1 focus:ring-game-accent/30 transition-all"
            />
          </div>

          {/* Create room */}
          <button
            onClick={createRoom}
            disabled={!playerName.trim()}
            className={`w-full py-4 rounded-xl font-bold text-lg mb-4 transition-all duration-200 ${
              playerName.trim()
                ? 'bg-gradient-to-r from-game-accent to-purple-500 text-white hover:opacity-90 glow-accent'
                : 'bg-game-card text-gray-600 cursor-not-allowed'
            }`}
            style={{ fontFamily: 'Orbitron, sans-serif' }}
          >
            ルーム作成
          </button>

          {/* Divider */}
          <div className="flex items-center gap-4 mb-4">
            <div className="flex-1 h-px bg-game-border" />
            <span className="text-xs text-gray-600 uppercase tracking-wider">または</span>
            <div className="flex-1 h-px bg-game-border" />
          </div>

          {/* Join room */}
          <div className="flex gap-2">
            <input
              type="text"
              value={joinRoomId}
              onChange={e => setJoinRoomId(e.target.value.toUpperCase())}
              placeholder="ルーム ID"
              maxLength={6}
              className="flex-1 px-4 py-3 rounded-xl bg-game-card border border-game-border text-white placeholder-gray-600
                         focus:outline-none focus:border-game-accent/50 focus:ring-1 focus:ring-game-accent/30 transition-all
                         font-mono tracking-widest text-center uppercase"
            />
            <button
              onClick={() => joinRoom(joinRoomId)}
              disabled={!playerName.trim() || !joinRoomId.trim()}
              className={`px-6 py-3 rounded-xl font-bold transition-all duration-200 ${
                playerName.trim() && joinRoomId.trim()
                  ? 'bg-game-success text-white hover:opacity-90'
                  : 'bg-game-card text-gray-600 cursor-not-allowed'
              }`}
            >
              参加
            </button>
          </div>
        </div>

        {/* Rules Section */}
        <div className="mt-8 glass rounded-3xl p-6 lg:p-8 max-h-[50vh] md:max-h-[40vh] overflow-y-auto custom-scrollbar animate-slide-up border border-game-accent/20" style={{ animationDelay: '0.1s' }}>
          <h3 className="text-xl font-black mb-4 text-center bg-gradient-to-r from-game-accent to-purple-400 bg-clip-text text-transparent" style={{ fontFamily: 'Orbitron, sans-serif' }}>
            RULES
          </h3>
          
          <div className="space-y-6 text-sm text-gray-300">
            {/* Base Rules */}
            <div>
              <h4 className="font-bold text-white mb-2 border-b border-white/10 pb-1">🎴 基本ルール（大富豪ベース）</h4>
              <ul className="list-disc pl-5 space-y-1">
                <li>前の人が出したカードより強いカードを出します。</li>
                <li>パスは何回でも可能。全員がパスすると「場が流れ」、最後にカードを出した人から再開します。</li>
                <li>手札を最初に無くした人が勝者（あがり）となります。</li>
                <li>強さ： <span className="text-game-accent-light">3 ＜ 4 ＜ 5 ... J ＜ Q ＜ K ＜ A ＜ 2</span> ＜ ジョーカー（最強）</li>
              </ul>
            </div>

            {/* Special Effects */}
            <div>
              <h4 className="font-bold text-white mb-2 border-b border-white/10 pb-1">⚡ 特殊役・効果カード</h4>
              <div className="grid grid-cols-1 gap-2">
                <div className="bg-white/5 p-2 rounded-lg">
                  <span className="font-bold text-game-gold">8切り</span>: 場をリセットし、自分のターンから再開する（場が流れる）。
                </div>
                <div className="bg-white/5 p-2 rounded-lg">
                  <span className="font-bold text-game-gold">11バック</span>: J(11)を出すと、場が流れるまでカードの強さが逆転する（2が最弱、3が最強）。ジョーカーは常に最強。
                </div>
                <div className="bg-white/5 p-2 rounded-lg">
                  <span className="font-bold text-game-gold">革命</span>: 同じ数字を4枚以上同時に出すと、以降ずっとカードの強さが逆転する。
                </div>
                <div className="bg-white/5 p-2 rounded-lg">
                  <span className="font-bold text-purple-400">10捨て札</span>: 出した枚数分、手札から好きなカードを捨てられる（0枚も可）。
                </div>
                <div className="bg-white/5 p-2 rounded-lg">
                  <span className="font-bold text-purple-400">7渡し</span>: 次の順序のプレイヤーに、手札からカードを渡す（0枚も可）。
                </div>
                <div className="bg-white/5 p-2 rounded-lg">
                  <span className="font-bold text-purple-400">6回収</span>: 表向きの墓地から、好きなカードを回収して手札に加えられる。
                </div>
                <div className="bg-white/5 p-2 rounded-lg">
                  <span className="font-bold text-purple-400">5スキップ</span>: 次のターンを迎えるはずだったプレイヤーをスキップする。
                </div>
                <div className="bg-white/5 p-2 rounded-lg border border-game-danger/30">
                  <span className="font-bold text-game-danger">Qボンバー(12)</span>: 数字を指定し、全員の手札からその数字を強制的に破壊（破棄）させる。
                </div>
              </div>
            </div>

            {/* Counter System */}
            <div>
              <h4 className="font-bold text-white mb-2 border-b border-white/10 pb-1">⚔️ カウンターアクション</h4>
              <p className="mb-2 text-xs text-gray-400">相手の強力なカードに対して、専用の「カウンター！」ボタンから割り込みが可能です。</p>
              <div className="space-y-2">
                <div className="bg-white/5 p-2 rounded-lg">
                  <span className="font-bold text-blue-400">4カウンター (対8切り)</span><br />
                  8切りに対して、「出された8の枚数＋1枚の4」を出すとカウンター成功。場が流れ、4を出した人のターンから再開される。
                </div>
                <div className="bg-white/5 p-2 rounded-lg">
                  <span className="font-bold text-blue-400">スペ3返し (対ジョーカー単体)</span><br/>
                  単独で出されたジョーカーに対して、「スペードの3」を出すとカウンター成功。ジョーカーを打ち消して場が流れ、スペ3を出した人から再開。
                </div>
              </div>
            </div>

            {/* Doubt System */}
            <div>
              <h4 className="font-bold text-game-danger mb-2 border-b border-game-danger/20 pb-1">🕵️ ダウトシステム</h4>
              <ul className="list-disc pl-5 space-y-1">
                <li>通常のカード出しやカウンターアクション時、カードは一旦「裏向き」で場に出ます。</li>
                <li>他プレイヤーは、宣言された数字と実際のカードに嘘があると思えば「ダウト！」を宣言できます。</li>
                <li><span className="text-game-danger">ダウト成功（嘘発覚）</span>: 場のカードは手札に戻り、対象プレイヤーの番はスキップされます。</li>
                <li><span className="text-game-success">ダウト失敗（正直）</span>: ダウトしたプレイヤー（ダウター）はライフを1つ失い、正直者はダウターへ手札のカードを押し付ける報酬を得ます。</li>
                <li>※ 本作ではカードを出さずとも「嘘のカード（適当な他カード）」を出して乗り切ったり、強力なカウンターをブラフで発動することが可能です。</li>
              </ul>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
