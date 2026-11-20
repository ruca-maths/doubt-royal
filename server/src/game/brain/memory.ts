/**
 * BrainMemory — CPU 1人ぶんの記憶 (カードカウンティングと相手の傾向)。
 *
 * 入力は「全員に公開されるゲームログ」と「自分が実際に触ったカード」だけ。
 *  - 自分が裏向きで出して通ったカード / 10捨てで捨てたカード … 中身を知っている
 *  - 自分が相手に渡したカード (7渡し・ダウト報酬) … 相手が持っていると知っている
 *  - 相手が6回収で拾ったカード … 公開情報
 *  - ダウトされずに通った宣言 … 「本当ならそのランクが墓地に沈んだ」と期待値で数える
 *  - ダウトの結果 … 相手ごとの嘘つき度 / ダウト頻度の推定に使う
 */
import { Card, LogEntry } from '../types';
import { JOKER, PlayerView, copiesInDeck, countRanks, rankOf } from './view';
import { clamp, hyperTail } from './prob';

export interface Claim {
  logId: string;
  playerId: string;
  rank: number;
  count: number;
  /** この宣言が嘘である確率の見積もり (自分が観察者だったときに記録) */
  lieProbability: number | null;
}

export interface OpponentProfile {
  /** 宣言 (プレイ) の回数 */
  claims: number;
  /** ダウトされて嘘だった回数 */
  caughtLies: number;
  /** ダウトされて本当だった回数 */
  provenHonest: number;
  /** ダウトした回数 (選ばれたダウト者として) */
  doubtsMade: number;
  /** 他人の宣言を見た回数 (= ダウトできた機会) */
  doubtChances: number;
}

/** 卓全体の傾向 (宣言のもっともらしさ別) */
export interface BucketStats {
  /** 観察した宣言の数 */
  claims: number;
  /** そのうち (自分以外の誰かに) ダウトされた数 */
  doubted: number;
  /** ダウトされて嘘だった数 / 本当だった数 (他人の宣言のみ) */
  lies: number;
  truths: number;
}

/** 公開情報だけで見た「正直に出せる確率」で宣言を 3 段階に分ける (0 = 怪しい, 2 = もっともらしい) */
export function plausibilityBucket(possibility: number): number {
  return possibility < 0.3 ? 0 : possibility < 0.7 ? 1 : 2;
}

/** 公開情報 (表向きの札と、通った宣言) だけから見た各ランクの残り期待枚数 */
export function publicRemaining(faceUpCounts: number[], publicClaimed: number[]): number[] {
  const remaining = new Array(14).fill(0);
  for (let rank = 0; rank < 14; rank++) {
    remaining[rank] = Math.max(0, copiesInDeck(rank) - faceUpCounts[rank] - 0.7 * publicClaimed[rank]);
  }
  return remaining;
}

/** 公開情報だけで見た「handBefore 枚の手札から rank を count 枚正直に出せる確率」 */
export function publicPossibility(
  remaining: number[],
  rank: number,
  count: number,
  handBefore: number,
  isSpadeThreeCounter: boolean,
): number {
  let total = 0;
  for (const value of remaining) total += value;
  if (isSpadeThreeCounter) return clamp(handBefore / Math.max(1, total), 0.01, 1);
  const supply = rank === JOKER ? remaining[JOKER] : remaining[rank] + remaining[JOKER];
  return hyperTail(total, supply, handBefore, count);
}

/** 1人のプレイヤーの宣言の履歴 (全員に公開されている情報だけから作る) */
export interface ClaimHistory {
  /** ランク別に、宣言した延べ枚数 (判定待ちの宣言を含む) */
  claimedCards: number[];
  /** ランク別に、ダウトされずに通った延べ枚数 */
  passedCards: number[];
  /** 同じランクを連続して宣言している回数 (判定待ちの宣言を含む) */
  streakRank: number;
  streak: number;
}

function emptyHistory(): ClaimHistory {
  return { claimedCards: new Array(14).fill(0), passedCards: new Array(14).fill(0), streakRank: -1, streak: 0 };
}

export function isSpadeThree(card: Card): boolean {
  return !card.isJoker && card.suit === 'spade' && card.number === 3;
}

function emptyProfile(): OpponentProfile {
  return { claims: 0, caughtLies: 0, provenHonest: 0, doubtsMade: 0, doubtChances: 0 };
}

export class BrainMemory {
  private lastLogId: string | null = null;

  /** 判定待ちの直近の宣言 */
  pending: Claim | null = null;
  /** 自分が直近に出した実カード (pending が自分の宣言のとき) */
  private myPendingCards: Card[] = [];

  /** 自分が中身を知っている「裏向きで沈んだ」カードのランク別枚数 */
  myBuried: number[] = new Array(14).fill(0);
  /** 他人の通った宣言から推定した、沈んだ本物カードのランク別期待枚数 */
  buriedTrue: number[] = new Array(14).fill(0);
  /** 他人が裏向きで沈めたカードの総数 (中身は不明) */
  buriedByOthers = 0;
  /** ダウトされずに通った宣言のランク別延べ枚数 (全員ぶん。全員が知っている情報) */
  publicClaimed: number[] = new Array(14).fill(0);
  /** スペードの3の所在を知っている場合: 持ち主の id / 'buried' */
  spadeThreeAt: string | null = null;
  /** 卓全体の傾向 (もっともらしさ別) */
  table: BucketStats[] = [0, 1, 2].map(() => ({ claims: 0, doubted: 0, lies: 0, truths: 0 }));
  private pendingBucket: number | null = null;
  /** 相手ごとの「持っていると分かっているカード」ランク別期待枚数 */
  knownHeld = new Map<string, number[]>();
  /** プレイヤーごとの宣言履歴 */
  histories = new Map<string, ClaimHistory>();
  /** これまでの宣言の総数 */
  totalClaims = 0;
  profiles = new Map<string, OpponentProfile>();

  /** 個性 (CPU ごとに少しだけ判断基準をずらす) */
  readonly boldness: number;
  readonly suspicion: number;

  constructor() {
    this.boldness = 0.85 + Math.random() * 0.3;
    this.suspicion = 0.85 + Math.random() * 0.3;
  }

  profile(playerId: string): OpponentProfile {
    let profile = this.profiles.get(playerId);
    if (!profile) {
      profile = emptyProfile();
      this.profiles.set(playerId, profile);
    }
    return profile;
  }

  history(playerId: string): ClaimHistory {
    let history = this.histories.get(playerId);
    if (!history) {
      history = emptyHistory();
      this.histories.set(playerId, history);
    }
    return history;
  }

  held(playerId: string): number[] {
    let counts = this.knownHeld.get(playerId);
    if (!counts) {
      counts = new Array(14).fill(0);
      this.knownHeld.set(playerId, counts);
    }
    return counts;
  }

  /** 自分がカードを出した (宣言した) ことを記録する */
  noteMyPlay(cards: Card[]): void {
    this.myPendingCards = [...cards];
  }

  /** 判定待ちで場に出ている自分のカードのランク別枚数 */
  myPendingCounts(): number[] {
    const counts = new Array(14).fill(0);
    for (const card of this.myPendingCards) counts[rankOf(card)]++;
    return counts;
  }

  /** 自分が相手にカードを渡した (7渡し / ダウト報酬) */
  noteGiven(targetId: string, cards: Card[]): void {
    const held = this.held(targetId);
    for (const card of cards) {
      held[rankOf(card)] += 1;
      if (isSpadeThree(card)) this.spadeThreeAt = targetId;
    }
  }

  /** 自分が裏向きで捨てた (10捨て) */
  noteDiscarded(cards: Card[]): void {
    for (const card of cards) {
      this.myBuried[rankOf(card)] += 1;
      if (isSpadeThree(card)) this.spadeThreeAt = 'buried';
    }
  }

  /** 観察中の宣言に対する自分の「嘘確率」見積もりを残す */
  notePendingEstimate(lieProbability: number): void {
    if (this.pending) this.pending.lieProbability = lieProbability;
  }

  /** 公開ログの未処理ぶんを取り込む */
  sync(view: PlayerView): void {
    const logs = view.logs;
    let start = 0;
    if (this.lastLogId !== null) {
      const index = logs.findIndex(log => log.id === this.lastLogId);
      // ログは直近100件しか残らない。見失った場合は二重計上を避けて読み飛ばす
      start = index === -1 ? logs.length : index + 1;
    }
    for (let i = start; i < logs.length; i++) {
      this.consume(logs[i], view);
    }
    if (logs.length > 0) this.lastLogId = logs[logs.length - 1].id;

    // 最新の宣言がダウトされずに確定しているか (ログにはまだ現れていない場合)
    if (this.pending) {
      const waitingForDoubt =
        view.phase === 'doubtPhase' ||
        (view.phase === 'effectPhase' && view.pendingEffect?.type === 'queenBomber');
      if (!waitingForDoubt) this.commitPending(view);
    }
  }

  private consume(log: LogEntry, view: PlayerView): void {
    switch (log.action) {
      case 'play': {
        this.commitPending(view);
        const rank = log.declaredNumber ?? 0;
        const count = log.cardCount ?? 0;
        this.pending = { logId: log.id, playerId: log.playerId, rank, count, lieProbability: null };
        this.profile(log.playerId).claims++;
        this.totalClaims++;
        {
          const history = this.history(log.playerId);
          history.claimedCards[rank] += count;
          if (history.streakRank === rank) history.streak++;
          else {
            history.streakRank = rank;
            history.streak = 1;
          }
        }
        {
          const claimant = view.seats.find(seat => seat.id === log.playerId);
          const remaining = publicRemaining(countRanks(view.faceUp), this.publicClaimed);
          // カウンター (4止め / スペ3返し) かどうかはログからは分からないので通常の宣言として扱う
          const possibility = publicPossibility(remaining, rank, count, (claimant?.cardCount ?? 0) + count, false);
          this.pendingBucket = plausibilityBucket(possibility);
          this.table[this.pendingBucket].claims++;
        }
        for (const seat of view.seats) {
          if (seat.id !== log.playerId && !seat.isOut) this.profile(seat.id).doubtChances++;
        }
        // 宣言したランクは手札から出ていったはず
        const held = this.knownHeld.get(log.playerId);
        if (held) {
          held[rank] = Math.max(0, held[rank] - count);
          this.decayHeld(log.playerId, count * 0.35, view);
        }
        break;
      }

      case 'doubtSuccess': {
        this.noteDoubtOutcome(log.playerId, true, view);
        if (this.pending) {
          this.profile(this.pending.playerId).caughtLies++;
          this.pending = null;
          this.myPendingCards = [];
        }
        this.profile(log.playerId).doubtsMade++;
        break;
      }

      case 'doubtFailure': {
        this.noteDoubtOutcome(log.playerId, false, view);
        if (this.pending) {
          this.profile(this.pending.playerId).provenHonest++;
          this.pending = null;
          this.myPendingCards = [];
        }
        this.profile(log.playerId).doubtsMade++;
        break;
      }

      case 'queenBomber': {
        this.commitPending(view);
        for (const rank of log.targetNumbers ?? []) {
          for (const held of this.knownHeld.values()) held[rank] = 0;
        }
        break;
      }

      case 'sixCollect': {
        this.commitPending(view);
        if (log.playerId !== view.myId) {
          const held = this.held(log.playerId);
          for (const card of log.collectedCards ?? []) held[rankOf(card)] += 1;
        }
        break;
      }

      case 'discard': {
        this.commitPending(view);
        if (log.playerId !== view.myId) {
          this.buriedByOthers += log.cardCount ?? 0;
          this.decayHeld(log.playerId, log.cardCount ?? 0, view);
        }
        break;
      }

      case 'sevenPass':
      case 'doubtCardSelect': {
        this.commitPending(view);
        if (log.playerId !== view.myId) this.decayHeld(log.playerId, log.cardCount ?? 0, view);
        break;
      }

      case 'pass':
      case 'eightCut':
        this.commitPending(view);
        break;

      // 'revolution' はプレイ直後 (ダウト判定前) に、'counter' / 'revenge' は
      // ダウト失敗ログの直前に出るので、ここでは宣言を確定させない
      default:
        break;
    }
  }

  /** ダウトの結果を卓全体の傾向に反映する */
  private noteDoubtOutcome(doubterId: string, wasLie: boolean, view: PlayerView): void {
    if (!this.pending || this.pendingBucket === null) return;
    const stats = this.table[this.pendingBucket];
    if (doubterId === view.myId) {
      // 自分がダウトした宣言は「他人がダウトしたか」の標本にならない
      stats.claims = Math.max(0, stats.claims - 1);
    } else {
      stats.doubted++;
    }
    if (this.pending.playerId !== view.myId) {
      if (wasLie) stats.lies++;
      else stats.truths++;
    }
    this.pendingBucket = null;
  }

  /** この卓では、その「もっともらしさ」の宣言がどれくらいダウトされやすいか (基準に対する倍率) */
  doubtFactor(bucket: number, baseline: number): number {
    const stats = this.table[bucket];
    const weight = 6;
    const rate = (stats.doubted + weight * baseline) / (stats.claims + weight);
    return clamp(rate / baseline, 0.4, 3);
  }

  /** この卓で、その「もっともらしさ」の宣言が誰かにダウトされた割合 (観測が少ないうちは基準値に寄せる) */
  doubtRate(bucket: number, baseline: number): number {
    const stats = this.table[bucket];
    const weight = 6;
    return (stats.doubted + weight * baseline) / (stats.claims + weight);
  }

  /** この卓では、その「もっともらしさ」の宣言がどれくらい嘘になりやすいか (基準オッズに対する倍率) */
  lieFactor(bucket: number, expectedHit: number): number {
    const stats = this.table[bucket];
    const weight = 5;
    const rate = (stats.lies + weight * expectedHit) / (stats.lies + stats.truths + weight);
    return clamp((rate / (1 - rate)) / (expectedHit / (1 - expectedHit)), 0.4, 2.5);
  }

  /** 判定待ちの宣言を「ダウトされずに通った」ものとして確定する */
  private commitPending(view: PlayerView): void {
    const claim = this.pending;
    if (!claim) return;
    this.pending = null;

    this.publicClaimed[claim.rank] += claim.count;
    this.history(claim.playerId).passedCards[claim.rank] += claim.count;

    if (claim.playerId === view.myId) {
      // まだ手札に残っているカードは「出していない」ので数えない (不正な手が弾かれた場合の保険)
      const inHand = new Set(view.hand.map(card => card.id));
      for (const card of this.myPendingCards) {
        if (inHand.has(card.id)) continue;
        this.myBuried[rankOf(card)] += 1;
        if (isSpadeThree(card)) this.spadeThreeAt = 'buried';
      }
      this.myPendingCards = [];
      return;
    }

    const trust = 1 - (claim.lieProbability ?? this.priorLieRate(claim.playerId));
    this.buriedTrue[claim.rank] += claim.count * trust;
    this.buriedByOthers += claim.count;
  }

  /** 相手が中身不明のカードを n 枚手放したとき、「持っているはず」の確度を下げる */
  private decayHeld(playerId: string, released: number, view: PlayerView): void {
    const held = this.knownHeld.get(playerId);
    if (!held || released <= 0) return;
    const seat = view.seats.find(s => s.id === playerId);
    const before = (seat?.cardCount ?? 0) + released;
    if (before <= 0) return;
    const keep = Math.max(0, 1 - released / before);
    for (let rank = 0; rank < 14; rank++) held[rank] *= keep;
  }

  /** 相手の嘘つき度の事前推定 (ダウト結果から更新。観測が無ければ 0.3) */
  priorLieRate(playerId: string): number {
    const profile = this.profile(playerId);
    // ダウトされる宣言は元々怪しいものに偏るので、弱めの事前分布で平滑化する
    return (profile.caughtLies + 1.5) / (profile.caughtLies + profile.provenHonest + 5);
  }

  /** 相手の嘘つき度を基準値に対する倍率で返す (1 = 標準) */
  lieTendency(playerId: string): number {
    const profile = this.profile(playerId);
    const observed = profile.caughtLies + profile.provenHonest;
    if (observed === 0) return 1;
    // 較正されたダウトの的中率はおよそ6割。それより当たる相手は嘘が多い
    const rate = (profile.caughtLies + 3) / (observed + 5);
    const odds = rate / (1 - rate);
    return Math.min(3, Math.max(0.35, odds / 1.5));
  }

  /** 自分から見て所在不明な、そのランクの枚数 */
  unknownCopies(rank: number, myCounts: number[], faceUpCounts: number[]): number {
    const total = rank === JOKER ? 2 : 4;
    return Math.max(0, total - myCounts[rank] - faceUpCounts[rank] - this.myBuried[rank]);
  }
}
