import { ClientGameState } from '../../types/game';
import PlayingCard from './PlayingCard';
import { describeLog, effectOf, rankLabel } from './rules';

interface TableCenterProps {
  state: ClientGameState;
  myId: string | null;
  onOpenGrave: () => void;
}

/** テーブル中央: 場に出ている宣言・捨て山・墓地・実況 */
export default function TableCenter({ state, myId, onOpenGrave }: TableCenterProps) {
  const { field } = state;
  const owner = state.players.find(p => p.id === field.lastPlayerId);
  const current = state.players.find(p => p.id === state.currentPlayerId);
  const hasClaim = !!owner && field.currentCardCount > 0;
  const isCounter = field.doubtType === 'counter';
  const live = state.phase === 'doubtPhase';
  const effect = hasClaim && !isCounter && field.isEffectActive ? effectOf(field.declaredNumber, state) : null;
  const revealed = (field.revealedCards ?? []).slice(0, field.currentCardCount);
  const shownCount = Math.min(field.currentCardCount, 6);
  const lastLog = state.logs.length > 0 ? state.logs[state.logs.length - 1] : null;
  const line = lastLog ? describeLog(lastLog) : null;

  const claimLabel = isCounter && field.declaredNumber === 3 ? '♠3' : rankLabel(field.declaredNumber);
  const ownerLabel = owner ? (owner.id === myId ? 'あなた' : owner.name) : '';

  return (
    <div className="field-center">
      <div className="field-stage">
        <div className="grave" title="裏向きのまま流れたカード">
          <span>裏向き墓地</span>
          <b className="field-num">{field.cardHistoryCount}</b>
        </div>

        <div className={`claim ${live ? 'is-live' : ''}`} aria-live="polite">
          {hasClaim ? (
            <>
              <div className="claim-owner">
                <b>{ownerLabel}</b> {isCounter ? 'のカウンター' : 'の宣言'}
              </div>
              <div className="pile pc-sm">
                {revealed.length > 0
                  ? revealed.map(card => <PlayingCard key={card.id} card={card} size="sm" enter />)
                  : Array.from({ length: shownCount }).map((_, i) => (
                      <PlayingCard key={`${state.logs.length}-${i}`} faceDown size="sm" enter />
                    ))}
              </div>
              <div className="claim-rank field-num">
                {claimLabel}
                <small>×{field.currentCardCount}</small>
              </div>
              {effect && <div className="claim-effect">{effect.name}</div>}
              {field.pendingNumbers && field.pendingNumbers.length > 0 && (
                <div className="claim-effect" style={{ color: '#fda4af' }}>
                  破壊予定: {field.pendingNumbers.map(rankLabel).join('・')}
                </div>
              )}
              {field.roundPileCount > 0 && <div className="pile-under">この下に {field.roundPileCount}枚</div>}
            </>
          ) : (
            <div className="claim-empty">
              場は空です
              {current && state.phase === 'playing' && (
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  {current.id === myId ? 'あなた' : current.name} が好きな枚数で出せます
                </div>
              )}
            </div>
          )}
        </div>

        <button type="button" className="grave" onClick={onOpenGrave} aria-label="表向き墓地を見る">
          <span>表向き墓地</span>
          <b className="field-num">{field.faceUpPool.length}</b>
        </button>
      </div>

      {line && <div className={`ticker tone-${line.tone}`}>{line.text}</div>}
    </div>
  );
}
