/**
 * シミュレータで使える思考ルーチンの一覧 (名前 → Policy)。
 *   brain / brain:変種名  : src/game/brain (sim/brainPolicy.ts の variants を参照)
 *   legacy / random / sneaky : sim/policies.ts
 *   spam8 / spam10 / spamJoker / liar : sim/exploiters.ts (搾取テスト用)
 *   pro8 / pro10 : brain の打ち方 + 親番で毎回 8 / 10 を言い張る (上級者の付け込みの再現)
 */
import { Policy } from './driver';
import { legacyPolicy, randomPolicy, sneakyPolicy } from './policies';
import { liarPolicy, spam10Policy, spam8Policy, spamJokerPolicy, withLeadSpam } from './exploiters';
import { createBrainPolicy } from './brainPolicy';

const FIXED: Record<string, Policy> = {
  legacy: legacyPolicy,
  random: randomPolicy,
  sneaky: sneakyPolicy,
  spam8: spam8Policy,
  spam10: spam10Policy,
  spamJoker: spamJokerPolicy,
  liar: liarPolicy,
};

export const EXPLOITERS = ['pro8', 'pro10', 'spam8', 'spam10', 'spamJoker', 'liar', 'sneaky'];

export function loadPolicy(name: string): Policy {
  if (FIXED[name]) return FIXED[name];
  if (name === 'pro8') return withLeadSpam(createBrainPolicy('brain'), 8, 1, 'pro8');
  if (name === 'pro10') return withLeadSpam(createBrainPolicy('brain'), 10, 2, 'pro10');
  if (name === 'brain' || name.startsWith('brain:')) return createBrainPolicy(name);
  throw new Error(`unknown policy: ${name} (使えるもの: brain, brain:<variant>, ${Object.keys(FIXED).join(', ')})`);
}
