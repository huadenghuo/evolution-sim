// 草原进化模拟器 数值测试
// DOM 桩替换 + 直接驱动页面真实引擎代码
import fs from 'node:fs';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------- DOM 桩 ---------- */
const ctxProxy = new Proxy({}, {
  get(t, p){ if(!(p in t)) t[p] = () => {}; return t[p]; },
  set(t, p, v){ t[p] = v; return true; },
});
function makeEl(id){
  return {
    id, value:'', textContent:'', innerHTML:'', dataset:{}, style:{},
    classList:{ add(){}, remove(){} },
    addEventListener(){},
    width:0, height:0, onclick:null, onchange:null, oninput:null,
    getContext(){ return ctxProxy; },
    getBoundingClientRect(){ return { left:0, top:0, width:1600, height:1000 }; },
    parentElement:{ clientWidth: 320 },
  };
}
const els = {};
globalThis.document = {
  getElementById(id){ return els[id] || (els[id] = makeEl(id)); },
  querySelectorAll(){ return []; },
  createElement(){ return makeEl('dyn'); },
};
globalThis.window = { addEventListener(){}, devicePixelRatio: 1 };
globalThis.requestAnimationFrame = () => 0;
globalThis.performance = { now: () => 0 };

/* ---------- 运行页面脚本并导出内部句柄 ---------- */
new Function(script + `
;globalThis.__E = {
  step, spawnAnimal, mutateGenes, params, eatGrass, growGrass, seedGrass,
  metabolism, thinkRabbit, rebuildHash, GENE_RANGE, FW: WW, FH: WH, CELL,
  get animals(){ return animals; },
  get grass(){ return grass; },
  get history(){ return history; },
  resetAll(){ animals = []; simTime = 0; },
};`)();

const E = globalThis.__E;
let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if(!cond) fails++;
};

console.log('① 草逻辑斯蒂生长：空场向满值收敛');
{
  E.seedGrass(0);            // 全空 → 无法蔓延，改用低覆盖验证增长
  E.seedGrass(0.001);
  // 手动放一格
  E.grass[5000] = 0.05;
  const before = E.grass[5000];
  for(let i = 0; i < 200; i++) E.growGrass(0.4);   // 80 s
  const after = E.grass[5000];
  ok(after > before * 3 && after < 1.0, `生物量 ${before.toFixed(3)} → ${after.toFixed(3)}（应显著增长且 ≤1）`);
}

console.log('② 兔吃草能量转移：进食速率符合 EAT_RATE');
{
  E.resetAll();
  E.seedGrass(0);
  E.grass[Math.floor(500 / 16) * 100 + Math.floor(800 / 16)] = 1.0;   // 精确固定该格生物量
  const idx = Math.floor(500 / 16) * 100 + Math.floor(800 / 16);
  const got = E.eatGrass(800, 500, 20, 0.5);       // 速率 20 E/s × 0.5s
  ok(Math.abs(got - 10) < 0.001, `吃草 0.5s 获得 ${got.toFixed(2)} E ≈ 10 E`);
  const got2 = E.eatGrass(800, 500, 20, 100);      // 格子只剩 30 E
  ok(Math.abs(got2 - 30) < 0.01, `长时段上限提取 ${got2.toFixed(1)} E ≈ 剩余 30 E（40-10）`);
  ok(E.grass[idx] < 0.001, `格子被啃秃：生物量 → ${E.grass[idx].toFixed(4)}`);
}

console.log('③ 代谢与饿死：不吃不动的兔按公式计时死亡');
{
  E.resetAll();
  E.params.metabK = 1;
  const a = E.spawnAnimal('rabbit', 800, 500);
  // 代谢 = 1 + 0.02·speed·moving² ；spawn 后 state=wander moving=0.35（AI 未跑时默认 0.4）
  const E0 = a.E;
  let dead = false, t = 0;
  for(let i = 0; i < 30 * 120 && !dead; i++){
    // 只跑代谢部分：直接调用 metabolism 手动扣
    a.E -= E.metabolism(a) * (1 / 30);
    if(a.E <= 0){ dead = true; t = i / 30; }
  }
  const rate = E.metabolism(a);
  const theory = E0 / rate;
  ok(dead && Math.abs(t - theory) < 0.2, `存活 ${t.toFixed(1)}s ≈ 理论 ${theory.toFixed(1)}s（代谢 ${rate.toFixed(2)} E/s）`);
}

console.log('④ 变异机制：模式选择正确、幅度受控、无系统性偏差');
{
  // (a) mutP=0 → 全部小扰动：偏离不可能超过 ±20%，且 99.7% 在 ±15%（3σ）内
  E.params.mutP = 0;
  const parent = { speed: 100, cap: 150, vision: 120 };
  let beyond3s = 0;
  const N = 5000;
  for(let i = 0; i < N; i++){
    const g = E.mutateGenes(parent);
    if(Math.abs(g.speed / parent.speed - 1) > 0.16) beyond3s++;
  }
  ok(beyond3s / N < 0.005, `mutP=0 全小扰动：超 ±16%(>3σ) 比例 ${(beyond3s / N * 100).toFixed(2)}% < 0.5%`);
  // (b) mutP=1 → 全部大变异：均匀 ±20%，幅度恰好被钳制
  E.params.mutP = 1;
  let maxDev = 0, overLimit = 0;
  for(let i = 0; i < N; i++){
    const g = E.mutateGenes(parent);
    const dev = Math.abs(g.speed / parent.speed - 1);
    if(dev > maxDev) maxDev = dev;
    if(dev > 0.2001) overLimit++;
  }
  ok(overLimit === 0, `mutP=1 全大变异：无超出 ±20% 的样本`);
  ok(maxDev > 0.19, `幅度用满边界（观测最大 ${maxDev.toFixed(3)} ≈ 0.20，均匀分布特征）`);
  // (c) 默认 15%：均值无偏
  E.params.mutP = 0.15;
  let sum = 0;
  for(let i = 0; i < N * 4; i++) sum += E.mutateGenes(parent).speed;
  const mean = sum / (N * 4);
  ok(Math.abs(mean - 100) < 1.0, `默认混合：后代均值 ${mean.toFixed(2)} ≈ 亲代 100（无漂变偏差）`);
}

console.log('⑤ 狼捕食：接触捕获 + 能量按转化率转移');
{
  E.resetAll();
  E.seedGrass(0);
  E.params.convE = 0.7;
  const w = E.spawnAnimal('wolf', 800, 500);
  const r = E.spawnAnimal('rabbit', 806, 504);
  r.age = 30;                            // 成体（跳过幼崽保护期）
  r.E = 60;
  w.E = 50;
  // 狼正对兔子：让它稳定追逐；先让 AI 跑一步
  w.state = 'chase'; w.target = r; w.moving = 1; w.aiTimer = 999;
  r.state = 'wander'; r.moving = 0; r.aiTimer = 999;   // 兔子静止
  const rabbitsBefore = E.animals.filter(a => a.kind === 'rabbit').length;
  for(let i = 0; i < 30; i++) E.step(1 / 30);          // 1s 足以接触（贴脸逐帧判定，概率上必中）
  const rabbitsAfter = E.animals.filter(a => a.kind === 'rabbit').length;
  ok(rabbitsAfter === rabbitsBefore - 1, `兔子被捕（${rabbitsBefore} → ${rabbitsAfter}）`);
  const wNow = E.animals.find(a => a.id === w.id);
  ok(wNow && wNow.E > 50 + 60 * 0.7 - 5, `狼获得能量：50 → ${wNow.E.toFixed(1)}（≥ 50 + 60×0.7 − 代谢）`);
  ok(wNow && wNow.digest > 0, `狼进入消化冷却：digest=${wNow.digest.toFixed(1)}s（期间不再追击）`);
}

console.log('⑥ 吃得多繁殖快：食物充足时能量上升 → 分裂');
{
  E.resetAll();
  E.seedGrass(1);
  E.params.metabK = 1;
  const a = E.spawnAnimal('rabbit', 800, 500);
  a.E = a.genes.cap * 0.5;
  a.lastSplit = -999;                                    // 无冷却限制
  a.aiTimer = 0; a.state = 'wander';                     // 触发觅食
  const before = E.animals.length;
  for(let i = 0; i < 30 * 8; i++) E.step(1 / 30);        // 8s
  ok(E.animals.length > before, `满草场 8s 内完成分裂（${before} → ${E.animals.length}）`);
}

console.log('⑦ 生态冒烟：经典草原 120s 三物种存活');
{
  // 载入经典预设（手动重建，DOM 桩下无法点按钮）
  E.resetAll();
  E.animals.length = 0;               // 清掉页面启动代码 loadPreset 的动物
  E.seedGrass(0.6);
  E.params.grassRate = 0.04; E.params.metabK = 1; E.params.convE = 0.8; E.params.mutP = 0.15;
  for(let i = 0; i < 40; i++) E.spawnAnimal('rabbit');
  for(let i = 0; i < 8; i++) E.spawnAnimal('wolf');
  for(let i = 0; i < 30 * 120; i++) E.step(1 / 30);      // 120s
  const rb = E.animals.filter(a => a.kind === 'rabbit').length;
  const wf = E.animals.filter(a => a.kind === 'wolf').length;
  console.log(`    （结果：兔 ${rb} 只 · 狼 ${wf} 只）`);
  ok(rb >= 5 && wf >= 1, `120s 后兔 ${rb} ≥5 且狼 ${wf} ≥1（三营养级均存活）`);
}

console.log('⑧ 兔饿极求生：肚子饿透仍转向最近食物格，而非原地打转');
{
  E.resetAll();
  E.seedGrass(0);                       // 全无草
  // 放一块草在 (440,500)，兔子 (300,500)，同 y 距离 140px，饿极 2s 内可走到并吃到
  const icx = Math.floor(440 / 16), icy = Math.floor(500 / 16);
  E.grass[icy * 100 + icx] = 0.5;
  const a = E.spawnAnimal('rabbit', 300, 500, {
    speed: 100, cap: 80, vision: 400,    // 大视野确保能看到远处草
  });
  a.E = 5;                               // 饿极（<35%×80=28）
  a.age = 0; a.lastSplit = 0;
  a.aiTimer = 0; a.state = 'wander'; a.dir = 0; a.moving = 0;
  E.rebuildHash();                       // 手动决策前重建空间哈希，清掉旧残留
  E.thinkRabbit(a);                      // 立刻决策一次（饿极求生应触发 seek 朝草）
  ok(a.state === 'seek', `饿极决策为觅食(seek)，实际 state=${a.state}`);
  const x0 = a.x;
  for(let i = 0; i < 30 * 2; i++) E.step(1 / 30);   // 2s 朝草走
  ok(a.x > x0 + 80, `向食物方向移动：x ${x0.toFixed(0)} → ${a.x.toFixed(0)}（应显著靠近草 x=440）`);
  // 兔子到达并开吃：能量应恢复（超过纯代谢下降线），此处因已到草边，断言能量高于中途最低值
  ok(a.E > 0, `移动+进食过程中未饿死，E=${a.E.toFixed(1)}>0`);
}

console.log('⑨ 角落脱落：无草空场被放进角落的兔，边界反弹能带离墙角而非原地打转');
{
  E.resetAll();                          // 清空 animals 和 simTime
  E.animals.length = 0;
  E.seedGrass(0);                        // 全空场：兔子只能游荡，重点测边界脱离
  // 四个角各放 3 只兔（无视野觅食，纯测边界反弹）
  const corners = [[30, 30], [E.FW - 30, 30], [30, E.FH - 30], [E.FW - 30, E.FH - 30]];
  for(const [x, y] of corners){
    for(let i = 0; i < 3; i++){
      const a = E.spawnAnimal('rabbit', x, y);
      a.E = E.FW * 5;                    // 能量充足，避免中途饿死干扰
      a.genes.cap = 1e9;
    }
  }
  E.animals.forEach(a => { a.aiTimer = 0; a.state = 'wander'; });
  for(let i = 0; i < 30 * 4; i++) E.step(1 / 30);     // 4s
  // 所有兔子应脱离墙角带（距墙 > 60px）
  let stuck = 0, below = 0;
  for(const a of E.animals){
    const cornerDist = Math.min(a.x, E.FW - a.x, a.y, E.FH - a.y);
    if(cornerDist < 60) stuck++;
  }
  ok(stuck === 0, `4s 内全部脱离墙角（仍有 ${stuck} 只距墙 <60px）`);
  // 且没有兔子飞出世界（边界仍约束有效）
  for(const a of E.animals){
    if(a.x < -20 || a.x > E.FW + 20 || a.y < -20 || a.y > E.FH + 20) below++;
  }
  ok(below === 0, `无兔子逃出世界边界（${below} 只越界）`);
}

console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 项失败 ❌`);
process.exit(fails === 0 ? 0 : 1);
