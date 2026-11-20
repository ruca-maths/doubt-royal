/**
 * 思考ルーチンの調整パラメータ。
 * 値は自己対戦 (server/sim/arena.ts) で調整したもの。単位は基本的に「手番 1 回ぶんの価値」。
 */
export interface BrainParams {
  // ---- 手札評価 ----
  /** 手札1枚あたりの重さ (同じ手数なら枚数が少ないほうが良い) */
  cardWeight: number;
  /** ジョーカーを持っている価値 (どの宣言にも混ぜられる) */
  jokerValue: number;
  /** 8 を持っている価値 (場を切って親を取れる) */
  eightValue: number;
  /** 強い札を温存する価値 (最強ランク1枚あたり) */
  strengthValue: number;
  /** 上がりの価値 */
  finishBonus: number;

  // ---- 出し方の期待値 ----
  /** 次の親番を取れることの価値 */
  leadValue: number;
  /** パスして何も進まないことのコスト */
  passCost: number;
  /** 禁止上がりで脱落するコスト */
  forbiddenPenalty: number;
  /** 嘘がばれて相手から押し付けられるカード1枚のコスト */
  receivedCardCost: number;
  /** 嘘がばれて手番を失うコスト */
  caughtTempo: number;
  /** 正直な札をダウトされたときのおまけ (相手のライフ減) */
  honestDoubtBonus: number;
  /** 相手1人が1枚得をすることの、自分にとっての損 (人数で割る前) */
  opponentGainWeight: number;
  /** 行動選択のランダムさ (ソフトマックス温度)。0 に近いほど最善手だけを選ぶ */
  temperature: number;
  /** 嘘の手が正直な最善手をどれだけ上回れば採用するか */
  bluffMargin: number;

  // ---- 嘘確率モデル: 状況別の基準嘘率 (配列は [1枚, 2枚, 3枚以上]) ----
  /** 親番・ふつうのランク */
  baseLeadPlain: number[];
  /** 親番・効果札 (7 / 8 / 10 / 有効なQ) */
  baseLeadSpecial: number[];
  /** 場に重ねる・ふつうのランク */
  baseFollowPlain: number[];
  /** 場に重ねる・効果札 */
  baseFollowSpecial: number[];
  /** 上がりの宣言 */
  baseFinal: number[];
  /** カウンター (4止め / スペ3返し) */
  baseCounter: number;
  /** 自分の手札から得た枚数情報をどれだけ強く効かせるか (1 = ベイズ則どおり) */
  evidencePower: number;

  // ---- ダウトの損得 ----
  /** server/models/doubt-model.json (学習済みの嘘判定モデル) があれば使う */
  useLearnedDoubt: boolean;
  /** ダウト成功で押し付けられるカード1枚の価値 */
  shedValue: number;
  /** ライフを失うコスト (残り3 → 2) */
  lifeCost3: number;
  /** ライフを失うコスト (残り2 → 1) */
  lifeCost2: number;
  /** 最後のライフを失って脱落するコスト */
  eliminationCost: number;
  /** 相手の上がりを止める価値 */
  finishThreat: number;
  /** ダウト失敗で押し付けられるカード1枚のコスト */
  receivePenalty: number;
  /** ダウト判断の「ゆらぎ」(確率がしきい値付近のときの曖昧さ) */
  doubtSoftness: number;
  /** 宣言が誰かにダウトされる頻度の基準 [怪しい宣言, 中間, もっともらしい宣言] (卓の傾向を測る基準) */
  baselineDoubt: number[];
  /** ダウトが当たる割合の基準 [怪しい宣言, 中間, もっともらしい宣言] */
  expectedHit: number[];

  // ---- 効果の選択 ----
  /** 6回収で拾うのに必要な評価値の改善幅 */
  collectMargin: number;
  /** Qボンバーで相手の札を1枚消してしまうことのコスト */
  bombOpponentBenefit: number;
}

export const DEFAULT_PARAMS: BrainParams = {
  cardWeight: 0.12,
  jokerValue: 0.45,
  eightValue: 0.2,
  strengthValue: 0.22,
  finishBonus: 2.0,

  leadValue: 0.6,
  passCost: 0.1,
  forbiddenPenalty: 6,
  receivedCardCost: 0.9,
  caughtTempo: 0.3,
  honestDoubtBonus: 0.4,
  opponentGainWeight: 1.0,
  temperature: 0.15,
  bluffMargin: 0.0,

  baseLeadPlain: [0.1, 0.09, 0.12],
  baseLeadSpecial: [0.24, 0.36, 0.32],
  baseFollowPlain: [0.44, 0.47, 0.47],
  baseFollowSpecial: [0.45, 0.41, 0.44],
  baseFinal: [0.18, 0.18, 0.15],
  baseCounter: 0.54,
  evidencePower: 0.8,

  useLearnedDoubt: true,
  shedValue: 1.0,
  lifeCost3: 1.0,
  lifeCost2: 2.6,
  eliminationCost: 30,
  finishThreat: 5.0,
  receivePenalty: 1.3,
  doubtSoftness: 0.06,
  baselineDoubt: [0.6, 0.3, 0.15],
  expectedHit: [0.52, 0.35, 0.2],

  collectMargin: 0.15,
  bombOpponentBenefit: 0.9,
};
