import { ClientPlayer } from '../../types/game';
import { Bubble } from './hooks';

interface SeatProps {
  player: ClientPlayer;
  /** いま場に出ているカードの持ち主か */
  isFieldOwner: boolean;
  /** ダウト受付中に「ダウト！」を宣言したか */
  isDoubting: boolean;
  /** カウンターを検討中か */
  isCounterActor: boolean;
  bubble?: Bubble;
}

export function Lives({ lives }: { lives: number }) {
  return (
    <span className="lives" aria-label={`ライフ ${lives}`}>
      {[0, 1, 2].map(i => (
        <span key={i} className={`life ${i < lives ? '' : 'is-lost'}`} />
      ))}
    </span>
  );
}

/** 対戦相手 1 人ぶんの席 */
export default function Seat({ player, isFieldOwner, isDoubting, isCounterActor, bubble }: SeatProps) {
  const finished = player.isOut && player.rank !== null && player.rank > 0;
  const eliminated = player.isOut && !finished;
  const isTurn = player.isCurrentTurn && !player.isOut;

  const classes = ['seat'];
  if (isTurn) classes.push('is-turn');
  else if (isFieldOwner) classes.push('is-owner');
  if (player.isOut) classes.push('is-out');

  let tag: { text: string; className: string } | null = null;
  if (finished) tag = { text: `${player.rank}位`, className: 'is-win' };
  else if (eliminated) tag = { text: player.rank === -1 ? '禁止上がり' : '脱落', className: 'is-out' };
  else if (isTurn) tag = { text: '手番', className: '' };
  else if (isCounterActor) tag = { text: '検討中', className: '' };
  else if (player.isSkipped) tag = { text: 'スキップ', className: 'is-skip' };

  const shown: Bubble | undefined = isDoubting ? { text: 'ダウト！', tone: 'doubt', serial: -1 } : bubble;

  return (
    <div className={classes.join(' ')}>
      {tag && <span className={`seat-tag ${tag.className}`}>{tag.text}</span>}
      <div className={`seat-avatar ${player.isAI ? 'is-ai' : ''}`} aria-hidden="true">
        {player.isAI ? 'COM' : player.name.slice(0, 1)}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="seat-name">{player.name}</div>
        <div className="seat-meta">
          {!player.isOut && (
            <span className={`seat-cards field-num ${player.cardCount <= 2 ? 'is-low' : ''}`}>{player.cardCount}</span>
          )}
          <Lives lives={player.lives} />
        </div>
      </div>
      {typeof player.winRate === 'number' && !player.isOut && (
        <div className="seat-rate" title={`形勢 ${player.winRate}%`}>
          <span style={{ width: `${player.winRate}%` }} />
        </div>
      )}
      {shown && (
        <span key={shown.serial} className={`seat-bubble ${shown.tone === 'plain' ? '' : `is-${shown.tone}`}`}>
          {shown.text}
        </span>
      )}
    </div>
  );
}
