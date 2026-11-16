import { ClientGameState, DoubtResult } from '../../types/game';
import PlayingCard from './PlayingCard';

/** ダウト / カウンターの判定結果。テーブルの上に数秒だけ重ねて見せる (操作は妨げない)。 */
export function Verdict({ result, state }: { result: DoubtResult | null; state: ClientGameState }) {
  if (!result || result.type === 'noDoubt') return null;
  const nameOf = (id: string | undefined) => state.players.find(p => p.id === id)?.name ?? '?';

  let title: string;
  let text: string;
  let tone: 'good' | 'bad' | 'gold';
  if (result.type === 'success') {
    title = 'ダウト成功！';
    tone = 'good';
    text = `${nameOf(result.doubterId)} が ${nameOf(result.liarId)} の嘘を見破った。最大 ${result.count}枚 押し付けられます`;
  } else if (result.type === 'failure') {
    title = 'ダウト失敗…';
    tone = 'bad';
    text = `${nameOf(result.honestPlayerId)} は本当のことを言っていた。${nameOf(result.doubterId)} はライフ -1`;
  } else {
    title = 'カウンター成立！';
    tone = 'gold';
    text = result.doubterId
      ? `${nameOf(result.doubterId)} のダウトは外れ (ライフ -1)。${nameOf(result.countererId)} が親になります`
      : `${nameOf(result.countererId)} が場を流して親になります`;
  }

  const cards = result.revealedCards ?? [];
  return (
    <div className="verdict" role="status" aria-live="assertive">
      <div className={`verdict-card is-${tone}`}>
        <div className="verdict-title">{title}</div>
        {cards.length > 0 && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'center' }}>
            {cards.map(card => <PlayingCard key={card.id} card={card} size="sm" />)}
          </div>
        )}
        <div className="verdict-text">{text}</div>
      </div>
    </div>
  );
}

/** ゲーム終了後の順位表 */
export function ResultScreen({
  state, myId, onPlayAgain, onLeave,
}: {
  state: ClientGameState;
  myId: string | null;
  onPlayAgain: () => void;
  onLeave: () => void;
}) {
  const ranked = state.players
    .filter(p => p.rank !== null && p.rank > 0)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const eliminated = state.players.filter(p => p.rank === null || p.rank <= 0);
  const isHost = state.hostId === myId;
  const me = state.players.find(p => p.id === myId);
  const headline = me?.rank === 1 ? 'あなたの勝ち！' : me && me.rank !== null && me.rank > 0 ? `${me.rank}位でした` : me ? '脱落…' : 'ゲーム終了';

  return (
    <div className="result-root">
      <div className="result-card">
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.2em', color: '#9aa6bd' }}>GAME SET</div>
          <div style={{ fontSize: 26, fontWeight: 900, marginTop: 4 }}>{headline}</div>
        </div>

        {ranked.map(p => (
          <div key={p.id} className={`result-row ${p.rank === 1 ? 'is-first' : ''} ${p.id === myId ? 'is-me' : ''}`}>
            <div className="result-rank field-num" style={{ color: p.rank === 1 ? '#fbbf24' : undefined }}>{p.rank}</div>
            <div style={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.name}
              {p.isAI && <span style={{ marginLeft: 6, fontSize: 10, color: '#6ee7b7' }}>COM</span>}
            </div>
            <div style={{ fontSize: 11, color: '#9aa6bd', fontWeight: 700 }}>{p.rank === 1 ? '1位上がり' : '上がり'}</div>
          </div>
        ))}
        {eliminated.map(p => (
          <div key={p.id} className={`result-row is-out ${p.id === myId ? 'is-me' : ''}`}>
            <div className="result-rank" style={{ fontSize: 13 }}>脱落</div>
            <div style={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.name}
              {p.isAI && <span style={{ marginLeft: 6, fontSize: 10, color: '#6ee7b7' }}>COM</span>}
            </div>
            <div style={{ fontSize: 11, color: '#fda4af', fontWeight: 700 }}>{p.rank === -1 ? '禁止上がり' : 'ライフ0'}</div>
          </div>
        ))}

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button type="button" className="btn btn-ghost" onClick={onLeave}>退出</button>
          {isHost ? (
            <button type="button" className="btn btn-primary" onClick={onPlayAgain}>もう一度遊ぶ</button>
          ) : (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', fontSize: 12, color: '#9aa6bd', fontWeight: 700 }}>
              ホストが次のゲームを始めるのを待っています…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
