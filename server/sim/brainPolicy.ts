/**
 * 新しい思考ルーチン (src/game/brain) をシミュレータに載せるアダプタ。
 * "brain:名前" の形で、パラメータを変えた派生版を対戦させられる (variants を参照)。
 */
import { Brain } from '../src/game/brain/brain';
import { BrainParams, DEFAULT_PARAMS } from '../src/game/brain/params';
import { Policy } from './driver';

/** 調整実験用のパラメータ差分。例: --seats brain,brain:timid,legacy,legacy */
export const variants: Record<string, Partial<BrainParams>> = {
  // 嘘をほとんどつかない
  timid: { bluffMargin: 5 },
  // ダウトをほとんどしない
  trusting: { lifeCost3: 8, lifeCost2: 12 },
};

export function createBrainPolicy(name: string, overrides?: Partial<BrainParams>): Policy {
  const variant = name.includes(':') ? name.split(':')[1] : '';
  let fromEnv: Partial<BrainParams> = {};
  if (variant === 'env' && process.env.BRAIN_PARAMS) {
    fromEnv = JSON.parse(process.env.BRAIN_PARAMS);
  }
  const params: BrainParams = { ...DEFAULT_PARAMS, ...(variants[variant] ?? {}), ...fromEnv, ...overrides };
  return {
    name,
    decidePlay: (room, player) => Brain.decidePlay(room, player, params),
    shouldDoubt: (room, player) => Brain.shouldDoubt(room, player, params),
    chooseCounter: (room, player) => Brain.chooseCounter(room, player, params),
    chooseEffect: (room, player, effect) => Brain.chooseEffect(room, player, effect, params),
  };
}
