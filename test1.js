global.window = undefined;
const D = require('./js/data.js');
require('./js/engine.js');
require('./js/sim.js');
const E = global.BS_ENGINE, S = global.BS_SIM;

function step(state, action, label){
  const r = S.runSim(state, action);
  console.log(`\n=== ${label} ===  ok=${r.ok} crash=${r.crashed} fMin=${r.minFreq} fMax=${r.maxFreq} shed=${r.shedLoads}`);
  r.events.forEach(e=>console.log(`  t=${e.t} [${e.level}] ${e.text}`));
  return r;
}

let s = E.initialState();
// 1. 启动黑启动水电
let r = step(s, {type:'startUnit', target:'U_H', unitOnline:true, minPower:0}, '启动白鹤滩水电机组');
s = r.finalState;
// 2. 合 L1 给东郊充电
r = step(s, {type:'closeLine', target:'L1', kind:'energize'}, '合白鹤-东郊线(充电)');
s = r.finalState;
console.log('S1 energized?', E.derive(s).energized.S1);
// 3. 恢复一批 36MW
r = step(s, {type:'restoreLoad', target:'S1_B1'}, '恢复东郊一批36MW');
s = r.finalState;
console.log('units gen:', JSON.stringify(s.units));
// 4. 恢复二、三批
r = step(s, {type:'restoreLoad', target:'S1_B2'}, '恢复东郊二批32MW'); s=r.finalState;
r = step(s, {type:'restoreLoad', target:'S1_B3'}, '恢复东郊三批22MW'); s=r.finalState;
console.log('S1 load=', E.derive(s).islands[0].load, 'gen=', E.derive(s).islands[0].gen);
// 5. 错误：在频率稳定的孤网上一次性恢复 S4 大负荷？需先充电 S4
r = step(s, {type:'closeLine', target:'L5', kind:'energize'}, '合东郊-江南(充电S4)'); s=r.finalState;
r = step(s, {type:'restoreLoad', target:'S4_B1'}, '恢复江南一批44MW'); s=r.finalState;
r = step(s, {type:'restoreLoad', target:'S4_B2'}, '恢复江南二批38MW'); s=r.finalState;
r = step(s, {type:'restoreLoad', target:'S4_B3'}, '恢复江南三批28MW'); s=r.finalState;
console.log('island load/gen/cap:', E.derive(s).islands.map(i=>({load:i.load,gen:Math.round(i.gen),cap:i.capacity})));
// 6. 启动火电（需要150MW备用：cap300 - load202 = 98 → 应被即时校验拒绝）
const chk = E.canStartUnit(s, E.derive(s), 'U_TC');
console.log('启动临港火电校验:', chk);
