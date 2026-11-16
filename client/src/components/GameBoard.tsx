import { useCallback, useEffect, useMemo, useState } from 'react';
import { useGame } from '../contexts/GameContext';
import { Card } from '../types/game';
import ActionDock from './field/ActionDock';
import HandFan from './field/HandFan';
import { ResultScreen, Verdict } from './field/Overlays';
import Seat, { Lives } from './field/Seat';
import { GraveSheet, LogList, RulesSheet, Sheet } from './field/Sheets';
import TableCenter from './field/TableCenter';
import { useBubbles } from './field/hooks';
import { deriveInteraction, interactionKey, selectionLimit } from './field/interaction';
import { JOKER, isReversed, rankOf } from './field/rules';
import './field/field.css';

type OpenSheet = 'log' | 'rules' | 'grave' | null;

/**
 * ゲームフィールド。
 *  上: ルーム情報と現在のルール状態 / 中: 対戦相手の席とテーブル中央 / 下: 操作ドックと自分の手札
 * 出す・宣言・ダウト・カウンター・各効果の入力はすべて下の操作ドックで行い、
 * テーブルと手札は常に見えたままにする (モーダルで隠さない)。
 */
export default function GameBoard() {
  const { gameState, myId, doubtResult, doubtDeclarers, playAgain, leaveRoom, error, clearError } = useGame();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const bubbles = useBubbles(gameState?.logs ?? []);

  const interaction = useMemo(
    () => (gameState ? deriveInteraction(gameState, myId) : { kind: 'wait' as const, text: '' }),
    [gameState, myId],
  );
  const limit = selectionLimit(interaction);
  const key = gameState ? interactionKey(interaction, gameState) : '';

  // 求められる操作が変わったら、手札の選択をやり直す
  useEffect(() => {
    setSelectedIds([]);
  }, [key]);

  // エラー表示は数秒で消す
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clearError, 3500);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  const toggleCard = useCallback((cardId: string) => {
    setSelectedIds(prev => {
      if (prev.includes(cardId)) return prev.filter(id => id !== cardId);
      if (limit === 1) return [cardId];
      if (prev.length >= limit) return prev;
      return [...prev, cardId];
    });
  }, [limit]);
  const clearSelection = useCallback(() => setSelectedIds([]), []);
  const closeSheet = useCallback(() => setSheet(null), []);

  if (!gameState) return null;

  if (gameState.phase === 'result') {
    return <ResultScreen state={gameState} myId={myId} onPlayAgain={playAgain} onLeave={leaveRoom} />;
  }

  const me = gameState.players.find(p => p.id === myId);
  const myIndex = gameState.players.findIndex(p => p.id === myId);
  const opponents = myIndex === -1
    ? gameState.players
    : [...gameState.players.slice(myIndex + 1), ...gameState.players.slice(0, myIndex)];

  const reversed = isReversed(gameState);
  const selected: Card[] = gameState.myHand.filter(card => selectedIds.includes(card.id));
  const excluded = interaction.kind === 'give' ? interaction.excluded : [];
  const isBlocked = (card: Card) => excluded.includes(rankOf(card)) || (excluded.includes(JOKER) && card.isJoker);
  const isMyTurn = interaction.kind === 'play' || interaction.kind === 'counter' || interaction.kind === 'give'
    || interaction.kind === 'collect' || interaction.kind === 'bomb';

  return (
    <div className="field-root">
      <div className="field-main">
        <header className="field-topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
            <span className="field-chip field-num" title="ルームID">{gameState.roomId}</span>
            <span className="field-chip" title="手番の回る向き">
              {gameState.rules.direction === 1 ? '↻ 時計回り' : '↺ 反時計回り'}
            </span>
            <span className={`field-chip ${reversed ? 'is-gold' : ''}`} title="いまの強さの順">
              {reversed ? '強さ逆転中 2→3' : '強さ 3→2'}
            </span>
            {gameState.rules.isRevolution && <span className="field-chip is-gold">革命</span>}
            {gameState.rules.isElevenBack && <span className="field-chip is-accent">11バック</span>}
          </div>
          <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
            <button type="button" className="field-iconbtn only-narrow" onClick={() => setSheet('log')}>履歴</button>
            <button type="button" className="field-iconbtn" onClick={() => setSheet('rules')}>ルール</button>
          </div>
        </header>

        <section className="field-table" aria-label="テーブル">
          <div className="field-seats">
            {opponents.map(player => (
              <Seat
                key={player.id}
                player={player}
                isFieldOwner={gameState.field.lastPlayerId === player.id && gameState.field.currentCardCount > 0}
                isDoubting={gameState.phase === 'doubtPhase' && doubtDeclarers.includes(player.id)}
                isCounterActor={gameState.phase === 'counterPhase' && gameState.counterActorId === player.id}
                bubble={bubbles[player.id]}
              />
            ))}
          </div>
          <TableCenter state={gameState} myId={myId} onOpenGrave={() => setSheet('grave')} />
          <Verdict result={doubtResult} state={gameState} />
        </section>

        <footer className="field-bottom" style={isMyTurn ? { boxShadow: '0 -1px 0 rgba(251, 191, 36, 0.55)' } : undefined}>
          {error && (
            <div role="alert" style={{ padding: '6px 12px 0', fontSize: 12, fontWeight: 800, color: '#fda4af' }}>{error}</div>
          )}
          <ActionDock
            state={gameState}
            myId={myId}
            interaction={interaction}
            selected={selected}
            clearSelection={clearSelection}
          />
          {me && (
            <div className="mybar">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--ink)', fontWeight: 800 }}>{me.name}</span>
                <Lives lives={me.lives} />
                {bubbles[me.id] && <span className="tone-accent">{bubbles[me.id].text}</span>}
              </span>
              <span>
                手札 <b className="field-num" style={{ color: 'var(--ink)' }}>{gameState.myHand.length}</b>枚
                {limit > 0 && selectedIds.length > 0 && <> ・選択 {selectedIds.length}</>}
              </span>
            </div>
          )}
          <HandFan
            cards={gameState.myHand}
            reversed={reversed}
            selectedIds={selectedIds}
            selectable={limit > 0}
            dim={interaction.kind === 'wait' || interaction.kind === 'spectate'}
            isBlocked={excluded.length > 0 ? isBlocked : undefined}
            onToggle={toggleCard}
          />
        </footer>
      </div>

      <aside className="logpanel" aria-label="履歴">
        <div className="sheet-head" style={{ fontSize: 13 }}>履歴</div>
        <LogList logs={gameState.logs} />
      </aside>

      {sheet === 'log' && (
        <Sheet title="履歴" onClose={closeSheet}>
          <LogList logs={gameState.logs} />
        </Sheet>
      )}
      {sheet === 'rules' && <RulesSheet state={gameState} onClose={closeSheet} />}
      {sheet === 'grave' && <GraveSheet state={gameState} onClose={closeSheet} />}
    </div>
  );
}
