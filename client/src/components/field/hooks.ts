import { RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LogEntry } from '../../types/game';
import { rankLabel } from './rules';

/** 要素の幅を追いかける (手札の重なり幅の計算に使う) */
export function useElementWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * key が変わるたびに durationMs のカウントダウンをやり直し、残り割合 (1 → 0) を返す。
 * active が false の間は 1 のまま。
 */
export function useCountdown(key: string, durationMs: number, active: boolean): number {
  const [ratio, setRatio] = useState(1);
  useEffect(() => {
    if (!active) {
      setRatio(1);
      return;
    }
    const started = Date.now();
    setRatio(1);
    const timer = setInterval(() => {
      const left = Math.max(0, 1 - (Date.now() - started) / durationMs);
      setRatio(left);
      if (left === 0) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [key, durationMs, active]);
  return ratio;
}

export interface Bubble {
  text: string;
  tone: 'plain' | 'doubt' | 'muted' | 'good' | 'gold';
  serial: number;
}

function bubbleFor(log: LogEntry): Omit<Bubble, 'serial'> | null {
  switch (log.action) {
    case 'play':
      return { text: `${rankLabel(log.declaredNumber ?? 0)} ×${log.cardCount}`, tone: 'plain' };
    case 'pass':
      return { text: 'パス', tone: 'muted' };
    case 'doubtSuccess':
      return { text: 'ダウト成功！', tone: 'good' };
    case 'doubtFailure':
      return { text: 'ダウト失敗…', tone: 'doubt' };
    case 'counter':
      return { text: 'カウンター！', tone: 'gold' };
    case 'eightCut':
      return { text: '8切り', tone: 'gold' };
    case 'sevenPass':
      return { text: `${log.cardCount}枚 渡した`, tone: 'plain' };
    case 'doubtCardSelect':
      return { text: `${log.cardCount}枚 押し付け`, tone: 'plain' };
    case 'discard':
      return { text: `${log.cardCount}枚 捨てた`, tone: 'plain' };
    case 'sixCollect':
      return { text: `${log.cardCount}枚 回収`, tone: 'plain' };
    case 'queenBomber':
      return { text: 'ボンバー！', tone: 'doubt' };
    default:
      return null;
  }
}

/** 新しく届いたログを、プレイヤーごとの「吹き出し」として数秒だけ表示する */
export function useBubbles(logs: LogEntry[]): Record<string, Bubble> {
  const [bubbles, setBubbles] = useState<Record<string, Bubble>>({});
  const lastId = useRef<string | null>(null);
  const serial = useRef(0);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (logs.length === 0) {
      lastId.current = null;
      return;
    }
    const newest = logs[logs.length - 1].id;
    if (lastId.current === null) {
      // 初回 (途中参加・再読み込み) は過去ログを吹き出しにしない
      lastId.current = newest;
      return;
    }
    const index = logs.findIndex(log => log.id === lastId.current);
    const fresh = index === -1 ? logs.slice(-1) : logs.slice(index + 1);
    lastId.current = newest;
    if (fresh.length === 0) return;

    const updates: Record<string, Bubble> = {};
    for (const log of fresh) {
      const bubble = bubbleFor(log);
      if (bubble) updates[log.playerId] = { ...bubble, serial: ++serial.current };
    }
    if (Object.keys(updates).length === 0) return;
    setBubbles(prev => ({ ...prev, ...updates }));
    for (const [playerId, bubble] of Object.entries(updates)) {
      clearTimeout(timers.current[playerId]);
      timers.current[playerId] = setTimeout(() => {
        setBubbles(prev => {
          if (prev[playerId]?.serial !== bubble.serial) return prev;
          const next = { ...prev };
          delete next[playerId];
          return next;
        });
      }, 2800);
    }
  }, [logs]);

  useEffect(() => () => {
    for (const timer of Object.values(timers.current)) clearTimeout(timer);
  }, []);

  return bubbles;
}
