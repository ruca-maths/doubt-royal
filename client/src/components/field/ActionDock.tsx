import { useEffect, useMemo, useState } from 'react';
import { Card, ClientGameState } from '../../types/game';
import { useGame } from '../../contexts/GameContext';
import PlayingCard from './PlayingCard';
import { useCountdown } from './hooks';
import { Interaction } from './interaction';
import {
  JOKER, canDeclare, effectOf, honestDeclaration, isForbiddenFinish, isHonest, isReversed,
  rankLabel, rankOf, ranksByStrength, sortHand,
} from './rules';

interface ActionDockProps {
  state: ClientGameState;
  myId: string | null;
  interaction: Interaction;
  selected: Card[];
  clearSelection: () => void;
}

/** 数字キーの並び (弱い順)。ジョーカーは末尾。 */
function RankBar({
  state, value, isOn, isDisabled, marks, onPick,
}: {
  state: ClientGameState;
  value?: number | null;
  isOn?: (rank: number) => boolean;
  isDisabled?: (rank: number) => boolean;
  /** 緑の点を付けるランク (正直な宣言 / 自分が持っている数字) */
  marks?: (rank: number) => boolean;
  onPick: (rank: number) => void;
}) {
  const ranks = ranksByStrength(isReversed(state));
  return (
    <div className="rankbar" role="group" aria-label="数字を選ぶ">
      {ranks.map(rank => {
        const on = isOn ? isOn(rank) : value === rank;
        const classes = ['rankkey', 'field-num'];
        if (rank === JOKER) classes.push('is-joker');
        if (on) classes.push('is-on');
        if (marks?.(rank)) classes.push('is-honest');
        if (effectOf(rank, state)) classes.push('has-effect');
        return (
          <button
            key={rank}
            type="button"
            className={classes.join(' ')}
            disabled={isDisabled?.(rank) ?? false}
            aria-pressed={on}
            onClick={() => onPick(rank)}
          >
            {rankLabel(rank)}
          </button>
        );
      })}
    </div>
  );
}

function claimKeyOf(state: ClientGameState): string {
  for (let i = state.logs.length - 1; i >= 0; i--) {
    if (state.logs[i].action === 'play') return state.logs[i].id;
  }
  return 'none';
}

// ------------------------------------------------------------ 自分の番: 出す / パス

function PlayDock({ state, interaction, selected, clearSelection }: ActionDockProps & { interaction: Extract<Interaction, { kind: 'play' }> }) {
  const { playCards, passTurn } = useGame();
  const [declared, setDeclared] = useState<number | null>(null);
  const selectionKey = selected.map(card => card.id).sort().join(',');

  // 選んだカードが 1 種類なら、その数字を宣言の初期値にする
  useEffect(() => {
    const honest = honestDeclaration(selected);
    setDeclared(prev => {
      if (honest !== null && canDeclare(honest, state)) return honest;
      if (prev !== null && canDeclare(prev, state) && selected.length > 0) return prev;
      return null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  const need = interaction.need;
  const countOk = selected.length > 0 && (need === 0 || selected.length === need);
  const ready = countOk && declared !== null && canDeclare(declared, state);
  const honest = declared !== null && selected.length > 0 && isHonest(selected, declared);
  const effect = declared !== null ? effectOf(declared, state) : null;
  const revolutionAfter = selected.length >= 4 ? !state.rules.isRevolution : state.rules.isRevolution;
  const finishing = selected.length > 0 && selected.length === state.myHand.length;
  const forbidden = finishing && declared !== null && isForbiddenFinish(declared, revolutionAfter);
  const honestRank = honestDeclaration(selected);

  let guide: string;
  if (selected.length === 0) {
    guide = need === 0
      ? '出すカードを選んでください (同じ数字なら何枚でも)'
      : `「${rankLabel(state.field.declaredNumber)}」より強い数字を ${need}枚 で`;
  } else if (!countOk) {
    guide = `場は ${need}枚 です (いま ${selected.length}枚)`;
  } else if (declared === null) {
    guide = '宣言する数字を選んでください';
  } else if (effect) {
    guide = `${effect.name}: ${effect.summary}`;
  } else {
    guide = selected.length >= 4 ? '4枚以上なので革命が起きます' : '特殊効果なし';
  }

  const submit = () => {
    if (!ready || declared === null) return;
    playCards(selected.map(card => card.id), declared);
    clearSelection();
  };

  return (
    <div className="dock">
      <div className="dock-head">
        <span className="dock-title is-turn">あなたの番</span>
        <span className={forbidden ? 'dock-warn' : 'dock-sub'}>
          {forbidden ? `「${rankLabel(declared!)}」で上がると禁止上がり (脱落) です` : guide}
        </span>
      </div>
      {selected.length > 0 && (
        <RankBar
          state={state}
          value={declared}
          isDisabled={rank => !canDeclare(rank, state)}
          marks={rank => honestRank !== null && (rank === honestRank || (honestRank === JOKER && rank !== JOKER))}
          onPick={setDeclared}
        />
      )}
      <div className="dock-actions">
        {interaction.canPass && (
          <button type="button" className="btn btn-ghost" onClick={() => { clearSelection(); passTurn(); }}>
            パス
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={!ready} onClick={submit}>
          {ready && declared !== null ? `「${rankLabel(declared)}」を ${selected.length}枚 出す` : '出す'}
        </button>
        {ready && (
          <span className={`pill ${honest ? 'pill-honest' : 'pill-bluff'}`} style={{ alignSelf: 'center' }}>
            {honest ? '正直' : 'ブラフ'}
          </span>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ ダウト受付

function DoubtDock({ state, interaction }: ActionDockProps & { interaction: Extract<Interaction, { kind: 'doubt' }> }) {
  const { declareDoubt, skipDoubt } = useGame();
  const claimKey = claimKeyOf(state);
  const [actedKey, setActedKey] = useState<string | null>(null);
  const acted = actedKey === claimKey;
  const isCounter = state.field.doubtType === 'counter';
  const duration = (state.rules.doubtTime || 5) * 1000 * (isCounter ? 1.5 : 1);
  const ratio = useCountdown(claimKey, duration, true);

  const { declaredNumber, currentCardCount } = state.field;
  const owner = state.players.find(p => p.id === state.field.lastPlayerId);
  const label = isCounter && declaredNumber === 3 ? 'スペードの3' : `「${rankLabel(declaredNumber)}」`;

  // 自分から見えている枚数 (手札 + 公開済み)
  const visible = useMemo(() => {
    const publicCards = [...state.field.faceUpPool];
    for (const card of state.field.revealedCards ?? []) {
      if (!publicCards.some(c => c.id === card.id)) publicCards.push(card);
    }
    const target = isCounter && declaredNumber === 3 ? 3 : declaredNumber;
    const count = (cards: Card[], rank: number) => cards.filter(card => rankOf(card) === rank).length;
    return {
      hand: count(state.myHand, target),
      open: count(publicCards, target),
      jokers: count(state.myHand, JOKER) + count(publicCards, JOKER),
      total: target === JOKER ? 2 : 4,
    };
  }, [state.myHand, state.field.faceUpPool, state.field.revealedCards, declaredNumber, isCounter]);

  const timer = (
    <div className="timer" aria-hidden="true">
      <span style={{ width: `${ratio * 100}%` }} />
    </div>
  );

  if (interaction.own) {
    return (
      <div className="dock">
        <div className="dock-head">
          <span className="dock-title">ダウト受付中…</span>
          <span className="dock-sub">あなたの宣言 {label} ×{currentCardCount}</span>
        </div>
        {timer}
      </div>
    );
  }

  return (
    <div className="dock">
      <div className="dock-head">
        <span className="dock-title">
          {owner?.name ?? '相手'} の{isCounter ? 'カウンター ' : '宣言 '}{label} ×{currentCardCount}
        </span>
        <span className="dock-sub">
          見えている{declaredNumber === JOKER ? 'ジョーカー' : label}: 手札{visible.hand} + 公開{visible.open} / {visible.total}枚
          {declaredNumber !== JOKER && visible.jokers > 0 ? ` ・ジョーカー ${visible.jokers}/2` : ''}
        </span>
      </div>
      {timer}
      {acted ? (
        <div className="dock-sub" style={{ textAlign: 'center', padding: '10px 0' }}>判定を待っています…</div>
      ) : (
        <div className="dock-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => { setActedKey(claimKey); skipDoubt(); }}
          >
            スルー
          </button>
          <button
            type="button"
            className="btn btn-doubt"
            onClick={() => { setActedKey(claimKey); declareDoubt(); }}
          >
            ダウト！
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ カウンター

function CounterDock({ interaction, selected, clearSelection }: ActionDockProps & { interaction: Extract<Interaction, { kind: 'counter' }> }) {
  const { declareCounter, skipDoubt } = useGame();
  const ready = selected.length === interaction.need;
  const targetLabel = interaction.target === 'four' ? `「4」を ${interaction.need}枚` : 'スペードの3 を 1枚';
  return (
    <div className="dock">
      <div className="dock-head">
        <span className="dock-title is-turn">カウンターできます</span>
        <span className="dock-sub">
          {interaction.target === 'four' ? `${targetLabel} 出すと 8切りを止めて親になれる` : `${targetLabel} 出すとジョーカーを返して親になれる`}
          {' '}(嘘でも出せます)
        </span>
      </div>
      <div className="dock-actions">
        <button type="button" className="btn btn-ghost" onClick={() => { clearSelection(); skipDoubt(); }}>
          しない
        </button>
        <button
          type="button"
          className="btn btn-gold"
          disabled={!ready}
          onClick={() => { declareCounter(selected.map(card => card.id)); clearSelection(); }}
        >
          カウンター ({selected.length}/{interaction.need})
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ 手札から渡す / 捨てる

function GiveDock({ state, myId, interaction, selected, clearSelection }: ActionDockProps & { interaction: Extract<Interaction, { kind: 'give' }> }) {
  const { effectAction } = useGame();
  const target = state.players.find(p => p.id === interaction.targetId);
  let next = '次の人';
  if (interaction.effect === 'sevenPass') {
    // 7渡しの相手 = 席順で次の、まだ残っているプレイヤー
    const me = Math.max(0, state.players.findIndex(p => p.id === myId));
    const total = state.players.length;
    for (let step = 1; step < total; step++) {
      const seat = state.players[((me + state.rules.direction * step) % total + total) % total];
      if (!seat.isOut) { next = seat.name; break; }
    }
  }

  const titles = {
    sevenPass: `7渡し — ${next} に渡す`,
    tenDiscard: '10捨て — 手札を捨てる',
    doubtCardSelect: `${target?.name ?? '相手'} に押し付ける`,
  } as const;
  const verbs = { sevenPass: '渡す', tenDiscard: '捨てる', doubtCardSelect: '押し付ける' } as const;
  const skips = { sevenPass: '渡さずに進む', tenDiscard: '捨てずに進む', doubtCardSelect: '押し付けずに進む' } as const;
  const count = selected.length;
  const targetEmpty = interaction.effect === 'doubtCardSelect' && target && !target.isOut && target.cardCount === 0;

  return (
    <div className="dock">
      <div className="dock-head">
        <span className="dock-title is-turn">{titles[interaction.effect]}</span>
        <span className={targetEmpty && count === 0 ? 'dock-warn' : 'dock-sub'}>
          {targetEmpty && count === 0
            ? '相手は手札 0枚。1枚も渡さないと相手が上がりになります'
            : `手札から最大 ${interaction.max}枚 (0枚でも可)`}
        </span>
      </div>
      <div className="dock-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => { effectAction(selected.map(card => card.id)); clearSelection(); }}
        >
          {count === 0 ? skips[interaction.effect] : `${count}枚 ${verbs[interaction.effect]}`}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ 6回収

function CollectDock({ state, interaction }: ActionDockProps & { interaction: Extract<Interaction, { kind: 'collect' }> }) {
  const { effectAction } = useGame();
  const [picked, setPicked] = useState<string[]>([]);
  const pool = useMemo(() => sortHand(state.field.faceUpPool, isReversed(state)), [state]);
  const toggle = (id: string) => {
    setPicked(prev => (prev.includes(id) ? prev.filter(x => x !== id) : prev.length < interaction.max ? [...prev, id] : prev));
  };
  return (
    <div className="dock">
      <div className="dock-head">
        <span className="dock-title is-turn">6回収 — 表向き墓地から拾う</span>
        <span className="dock-sub">最大 {interaction.max}枚 (拾わなくてもよい)</span>
      </div>
      <div className="tray">
        {pool.map(card => (
          <PlayingCard key={card.id} card={card} size="sm" selected={picked.includes(card.id)} onClick={() => toggle(card.id)} />
        ))}
      </div>
      <div className="dock-actions">
        <button type="button" className="btn btn-primary" onClick={() => { effectAction(picked); setPicked([]); }}>
          {picked.length === 0 ? '拾わずに進む' : `${picked.length}枚 拾う`}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ Qボンバー

function BombDock({ state, interaction }: ActionDockProps & { interaction: Extract<Interaction, { kind: 'bomb' }> }) {
  const { effectAction } = useGame();
  const [numbers, setNumbers] = useState<number[]>([]);
  const toggle = (rank: number) => {
    setNumbers(prev => (prev.includes(rank) ? prev.filter(n => n !== rank) : prev.length < interaction.max ? [...prev, rank] : prev));
  };
  const mine = (rank: number) => state.myHand.some(card => rankOf(card) === rank);
  return (
    <div className="dock">
      <div className="dock-head">
        <span className="dock-title is-turn">Qボンバー — 破壊する数字</span>
        <span className="dock-sub">最大 {interaction.max}個。全員の手札から消えます (緑の点 = 自分も持っている)</span>
      </div>
      <RankBar state={state} isOn={rank => numbers.includes(rank)} marks={mine} onPick={toggle} />
      <div className="dock-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => { effectAction([], { numbers }); setNumbers([]); }}
        >
          {numbers.length === 0 ? '指定せずに進む' : `${numbers.map(rankLabel).join('・')} を破壊`}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ 入口

/** 画面下の操作エリア。いま求められている操作に合わせて中身が切り替わる。 */
export default function ActionDock(props: ActionDockProps) {
  const { interaction, state, myId } = props;
  switch (interaction.kind) {
    case 'play':
      return <PlayDock {...props} interaction={interaction} />;
    case 'doubt':
      return <DoubtDock {...props} interaction={interaction} />;
    case 'counter':
      return <CounterDock {...props} interaction={interaction} />;
    case 'give':
      return <GiveDock {...props} interaction={interaction} />;
    case 'collect':
      return <CollectDock {...props} interaction={interaction} />;
    case 'bomb':
      return <BombDock {...props} interaction={interaction} />;
    case 'spectate': {
      const me = state.players.find(p => p.id === myId);
      const finished = me && me.rank !== null && me.rank > 0;
      return (
        <div className="dock">
          <div className="dock-head">
            <span className="dock-title">{finished ? `${me!.rank}位で上がりました` : me?.rank === -1 ? '禁止上がりで脱落' : 'ライフが尽きて脱落'}</span>
            <span className="dock-sub">観戦中 — 席のバーは各プレイヤーの形勢です</span>
          </div>
        </div>
      );
    }
    default:
      return (
        <div className="dock">
          <div className="dock-head">
            <span className="dock-sub" style={{ fontSize: 13 }}>{interaction.text}</span>
          </div>
        </div>
      );
  }
}
