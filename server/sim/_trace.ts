import { runGame, Policy } from './driver';
import { legacyPolicy } from './policies';
import { createBrainPolicy } from './brainPolicy';
import { GameEngine } from '../src/game/engine';
const realLog = console.log.bind(console);
console.log = () => {}; console.warn = () => {};
const show = (c: any) => c.isJoker ? 'Jo' : `${c.number}${c.suit[0]}`;
const brain = createBrainPolicy('brain');
const wrap = (p: Policy, tag: string): Policy => ({
  name: p.name,
  decidePlay: (room, player) => {
    const d = p.decidePlay(room, player);
    const f = room.field;
    realLog(`${tag}${player.name} hand[${player.hand.map(show).join(' ')}] field=${f.currentCards.length ? f.declaredNumber + 'x' + f.currentCards.length : '-'} => ${d.type === 'pass' ? 'PASS' : `declare ${d.declaredNumber} with [${d.cards!.map(show).join(' ')}]`}`);
    return d;
  },
  shouldDoubt: (room, player) => {
    const r = p.shouldDoubt(room, player);
    if (r) realLog(`   ${tag}${player.name} DOUBTS (${room.field.declaredNumber}x${room.field.currentCards.length} actual [${room.field.currentCards.map(show).join(' ')}])`);
    return r;
  },
  chooseCounter: (room, player) => {
    const r = p.chooseCounter(room, player);
    if (r.length) realLog(`   ${tag}${player.name} COUNTERS with [${r.map(show).join(' ')}]`);
    return r;
  },
  chooseEffect: (room, player, effect) => {
    const r = p.chooseEffect(room, player, effect);
    const names = r.cardIds.map(id => { const c = [...player.hand, ...room.field.faceUpPool].find(x => x.id === id); return c ? show(c) : id; });
    realLog(`   ${tag}${player.name} effect ${effect.type}(${effect.count}) -> [${names.join(' ')}] ${r.targetData ? JSON.stringify(r.targetData) : ''}`);
    return r;
  },
});
const res = runGame([wrap(brain, 'B:'), wrap(legacyPolicy, 'L:'), wrap(legacyPolicy, 'L:'), wrap(legacyPolicy, 'L:')]);
realLog(JSON.stringify(res.seats.map(s => [s.policy, s.rank, s.eliminated])), res.stuck);
