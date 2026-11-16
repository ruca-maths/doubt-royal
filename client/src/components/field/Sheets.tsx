import { ReactNode, useEffect, useRef } from 'react';
import { Card, ClientGameState, LogEntry } from '../../types/game';
import PlayingCard, { MiniCard } from './PlayingCard';
import { JOKER, describeLog, isReversed, rankLabel, rankOf, ranksByStrength, sortHand } from './rules';

/** 下からせり上がるシート (狭い画面) / 中央のダイアログ (広い画面) */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
        <div className="sheet-head">
          <span>{title}</span>
          <button type="button" className="field-iconbtn" onClick={onClose} aria-label="閉じる">閉じる</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ タイムライン

export function LogList({ logs }: { logs: LogEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [logs.length, logs[logs.length - 1]?.id]);

  if (logs.length === 0) {
    return <div className="loglist" style={{ color: 'var(--ink-faint)', fontSize: 12 }}>まだ何も起きていません</div>;
  }
  return (
    <div className="loglist">
      {logs.map(log => {
        const line = describeLog(log);
        return (
          <div key={log.id} className={`logitem tone-${line.tone}`}>
            {line.text}
            {line.cards && line.cards.length > 0 && (
              <div className="logcards">
                {line.cards.map((card: Card) => <MiniCard key={card.id} card={card} />)}
              </div>
            )}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

// ------------------------------------------------------------ 表向き墓地

export function GraveSheet({ state, onClose }: { state: ClientGameState; onClose: () => void }) {
  const pool = state.field.faceUpPool;
  const reversed = isReversed(state);
  const sorted = sortHand(pool, reversed);
  const countOf = (rank: number) => pool.filter(card => rankOf(card) === rank).length;

  return (
    <Sheet title={`表向き墓地 (${pool.length}枚)`} onClose={onClose}>
      <p style={{ color: 'var(--ink-dim)', marginBottom: 10 }}>
        ダウトで公開されたカードと、Qボンバーで破壊されたカードです。6回収で拾えます。
        枚数を数えると、相手の宣言が本当かどうかの手がかりになります。
      </p>
      <div className="countgrid">
        {ranksByStrength(reversed).map(rank => {
          const count = countOf(rank);
          const total = rank === JOKER ? 2 : 4;
          return (
            <div key={rank} className={`countcell ${count >= total ? 'is-all' : count > 0 ? 'is-some' : ''}`}>
              <span className="field-num" style={{ fontSize: rank === JOKER ? 9 : undefined }}>{rankLabel(rank)}</span>
              <small>{count}/{total}</small>
            </div>
          );
        })}
      </div>
      {sorted.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)', textAlign: 'center', padding: '14px 0' }}>まだ公開されたカードはありません</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {sorted.map(card => <PlayingCard key={card.id} card={card} size="sm" />)}
        </div>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------ ルール早見表

export function RulesSheet({ state, onClose }: { state: ClientGameState; onClose: () => void }) {
  const reversed = isReversed(state);
  const order = ranksByStrength(reversed).map(rankLabel).join(' ＜ ');
  return (
    <Sheet title="ルール早見表" onClose={onClose}>
      <h4>基本</h4>
      <ul>
        <li>カードは裏向きで出し、数字を宣言します。<b>嘘をついてもかまいません</b>。</li>
        <li>場にカードがあるときは、<b>同じ枚数</b>で<b>より強い数字</b>を宣言するか、パスします。</li>
        <li>全員がパスすると場が流れ、最後に出した人が好きな枚数で出せます。</li>
        <li>ジョーカーはどの数字としても「本当」になります (ワイルド)。</li>
        <li>手札を無くせば上がり。早く上がった順に順位が付きます。</li>
      </ul>

      <h4>いまの強さ{reversed ? ' (逆転中)' : ''}</h4>
      <p className="field-num" style={{ fontSize: 12, wordBreak: 'keep-all' }}>{order}</p>

      <h4>ダウト</h4>
      <ul>
        <li>誰かが出すたびに、他の人は「ダウト！」か「スルー」を選びます (複数人なら抽選で1人)。</li>
        <li><b>成功 (嘘だった)</b>: 出されたカードは表向き墓地へ行き、効果は不発。見破った人は出された枚数まで手札を嘘つきに押し付けられます。</li>
        <li><b>失敗 (本当だった)</b>: ダウトした人は<b>ライフ -1</b>。出した人が同じ枚数まで手札を押し付けられます。</li>
        <li>ライフは3つ。0になると脱落です。</li>
      </ul>

      <h4>宣言した数字の効果</h4>
      <table>
        <tbody>
          <tr><td>5 スキップ</td><td>出した枚数ぶん、次の人を飛ばす</td></tr>
          <tr><td>6 回収</td><td>出した枚数まで、表向き墓地から拾える</td></tr>
          <tr><td>7 渡し</td><td>出した枚数まで、次の人に手札を渡せる</td></tr>
          <tr><td>8 切り</td><td>場を流して、もう一度自分の番</td></tr>
          <tr><td>9 リバース</td><td>順番が逆回りになる</td></tr>
          <tr><td>10 捨て</td><td>出した枚数まで、手札を捨てられる</td></tr>
          <tr><td>J 11バック</td><td>場が流れるまで強さが逆転</td></tr>
          <tr><td>Q ボンバー</td><td>出した枚数ぶん数字を指定し、全員の手札から破壊 (一度でも場が流れた後のみ)</td></tr>
          <tr><td>4枚以上</td><td>革命: 強さがずっと逆転 (もう一度で戻る)</td></tr>
        </tbody>
      </table>
      <p style={{ color: 'var(--ink-dim)', marginTop: 6 }}>効果は「宣言した数字」で決まります。嘘でもダウトされなければ発動します。</p>

      <h4>カウンター</h4>
      <table>
        <tbody>
          <tr><td>4止め</td><td>8切りに対し「4」を (8の枚数+1) 枚出すと、8切りを止めて自分が親になる</td></tr>
          <tr><td>スペ3返し</td><td>ジョーカー1枚に対しスペードの3を出すと、打ち消して自分が親になる</td></tr>
        </tbody>
      </table>
      <p style={{ color: 'var(--ink-dim)', marginTop: 6 }}>カウンターも裏向きで出すので、ダウトの対象になります。</p>

      <h4>禁止上がり</h4>
      <p>
        最後の1手で <b>8</b>・<b>ジョーカー</b>・<b>{state.rules.isRevolution ? '3' : '2'}</b>
        {state.rules.isRevolution ? ' (革命中)' : ' (革命中は 3)'} を宣言して手札を無くすと、上がりではなく<b>脱落</b>になります。
      </p>
    </Sheet>
  );
}
