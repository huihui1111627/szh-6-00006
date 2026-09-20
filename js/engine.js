'use strict';

// 黑启动仿真引擎：拓扑带电分析 + 直流潮流 + 频率动态 + 保护动作
class Engine {
  constructor(scenario, limits) {
    this.scn = scenario;
    this.lim = limits;
    this.nodeIds = [
      ...scenario.plants.map((p) => p.id),
      ...scenario.substations.map((s) => s.id),
      ...scenario.loads.map((l) => l.id),
    ];
    this.lines = scenario.lines;
    this.lineMap = Object.fromEntries(this.lines.map((l) => [l.id, l]));
    this.plantMap = Object.fromEntries(scenario.plants.map((p) => [p.id, p]));
    this.loadMap = Object.fromEntries(scenario.loads.map((l) => [l.id, l]));
  }

  freshState() {
    const st = {
      simTime: 0,
      plants: {},
      loads: {},
      lines: {},
      compOf: {},
      zoneOf: {},
      zoneSeq: 0,
      comps: [],
      freq: {},
      mech: {},
      econ: {},
      overloadT: {},
      transient: null,
      failed: false,
      failReason: '',
      risk: 0,
      alarms: [],
      charts: {},
    };
    this.scn.plants.forEach((p) => {
      st.plants[p.id] = { status: 'off', remain: 0, pg: 0 };
      st.mech[p.id] = 0;
      st.econ[p.id] = 0;
    });
    this.scn.loads.forEach((l) => {
      st.loads[l.id] = { restoredMw: 0, shed: false };
    });
    this.lines.forEach((l) => {
      st.lines[l.id] = { closed: false, flow: 0, loading: 0 };
    });
    this.recompute(st);
    return st;
  }

  // ---- 拓扑带电分析：在“已闭合线路”图上找连通分量，含在线/启动中电源的分量带电 ----
  recompute(st) {
    const prevEnergized = new Set(
      (st.comps || []).filter((c) => c.energized).flatMap((c) => c.nodes));
    const adj = {};
    this.nodeIds.forEach((n) => { adj[n] = []; });
    this.lines.forEach((l) => {
      if (st.lines[l.id].closed) {
        adj[l.from].push(l.to);
        adj[l.to].push(l.from);
      }
    });
    const seen = new Set();
    const comps = [];
    this.nodeIds.forEach((start) => {
      if (seen.has(start)) return;
      const nodes = [];
      const queue = [start];
      seen.add(start);
      while (queue.length) {
        const n = queue.shift();
        nodes.push(n);
        adj[n].forEach((m) => {
          if (!seen.has(m)) { seen.add(m); queue.push(m); }
        });
      }
      const sources = nodes.filter((n) => this.plantMap[n] &&
        ['online', 'starting'].includes(st.plants[n]?.status));
      const energized = sources.length > 0;
      const comp = { id: comps.length, nodes, energized, sources: sources.map((n) => n) };
      nodes.forEach((n) => { st.compOf[n] = comp.id; });
      comps.push(comp);
    });
    st.comps = comps;
    this.updateZones(st, comps, prevEnergized);
    this.reconcileFreq(st, comps, prevEnergized);
  }

  // 原生控制区：节点首次带电（黑启动）或由带电侧对死区充电时获得；
  // 两个带电分区并列不改写原生归属——经济调度仍按原生控制区就地平衡，
  // 跨区功率支援只能通过机组爬坡逐步完成，因此联络线承载真实交换功率
  updateZones(st, comps, prevEnergized) {
    comps.forEach((comp) => {
      if (!comp.energized) return;
      const unzoned = comp.nodes.filter((n) => st.zoneOf[n] === undefined);
      if (!unzoned.length) return;
      const zoned = comp.nodes.map((n) => st.zoneOf[n]).filter((z) => z !== undefined);
      let zone;
      if (zoned.length) {
        zone = zoned.sort()[0]; // 死区被充入：继承供电侧控制区
      } else {
        zone = this._pendingZone;
        if (zone === undefined) {
          st.zoneSeq += 1;
          zone = 'Z' + st.zoneSeq;
        }
      }
      unzoned.forEach((n) => { st.zoneOf[n] = zone; });
    });
    this._pendingZone = undefined;
  }

  reconcileFreq(st, comps, prevEnergized) {
    const next = {};
    comps.forEach((c) => {
      if (!c.energized) {
        c.nodes.forEach((n) => { next[n] = 0; });
        return;
      }
      // 只对拓扑变化前就带电的节点取频率均值；新激活的死节点继承该值
      const liveVals = c.nodes
        .filter((n) => prevEnergized ? prevEnergized.has(n) : (st.freq[n] > 0))
        .map((n) => st.freq[n])
        .filter((v) => v !== undefined && v > 0);
      let f;
      if (liveVals.length) {
        f = liveVals.reduce((a, b) => a + b, 0) / liveVals.length;
      } else {
        f = this.scn.fBase; // 黑启动新建带电区
      }
      c.nodes.forEach((n) => { next[n] = f; });
    });
    st.freq = next;
  }

  compFreq(st, compId) {
    const c = st.comps[compId];
    return st.freq[c.nodes[0]];
  }

  // ---- 分量需求：恢复且未减载的负荷 + 启动中火电辅机功率 + 暂态冲击（有符号，正=负荷） ----
  compDemand(st, compId) {
    const c = st.comps[compId];
    let d = 0;
    c.nodes.forEach((n) => {
      if (this.loadMap[n]) {
        const ls = st.loads[n];
        if (ls.restoredMw > 0 && !ls.shed) d += ls.restoredMw;
      }
      if (this.plantMap[n]) {
        const ps = st.plants[n];
        if (ps.status === 'starting' && !this.plantMap[n].blackstart) d += this.plantMap[n].cranking;
      }
    });
    if (st.transient) {
      st.transient.inrushes
        .filter((ir) => ir.compId === compId)
        .forEach((ir) => { d += ir.amp * Math.exp(-(st.simTime - ir.t0) / ir.tau); });
    }
    return Math.max(0, d);
  }

  compStats(st, compId) {
    const c = st.comps[compId];
    const online = c.sources.filter((n) => st.plants[n].status === 'online');
    const capOnline = online.reduce((a, n) => a + this.plantMap[n].cap, 0);
    const capAll = c.sources.reduce((a, n) => a + this.plantMap[n].cap, 0);
    const demand = this.compDemand(st, compId);
    const M = 2 * this.lim.H * capOnline / this.scn.fBase; // MW·s/Hz
    return { c, online, capOnline, capAll, demand, inertia: M };
  }

  // ---- 直流潮流：各带电分量独立计算，选容量最大在线机组为松弛节点 ----
  solveFlows(st) {
    this.lines.forEach((l) => { st.lines[l.id].flow = 0; });
    st.comps.forEach((comp) => {
      if (!comp.energized) return;
      const nodes = comp.nodes;
      const online = comp.sources.filter((n) => st.plants[n].status === 'online');
      if (!online.length) return;
      let slack = online[0];
      online.forEach((n) => {
        if (this.plantMap[n].cap > this.plantMap[slack].cap) slack = n;
      });
      const inj = {};
      nodes.forEach((n) => { inj[n] = 0; });
      // 稳态负荷与辅机功率（负注入）
      let steadyLoad = 0;
      nodes.forEach((n) => {
        if (this.loadMap[n] && st.loads[n].restoredMw > 0 && !st.loads[n].shed) {
          inj[n] -= st.loads[n].restoredMw;
          steadyLoad += st.loads[n].restoredMw;
        }
        if (this.plantMap[n] && st.plants[n].status === 'starting' && !this.plantMap[n].blackstart) {
          inj[n] -= this.plantMap[n].cranking;
          steadyLoad += this.plantMap[n].cranking;
        }
      });
      // 暂态冲击（正=负荷冲击）按容量比例由各机组瞬时承担，体现跨区功率支援
      let inrush = 0;
      if (st.transient) {
        st.transient.inrushes
          .filter((ir) => ir.compId === comp.id)
          .forEach((ir) => { inrush += ir.amp * Math.exp(-(st.simTime - ir.t0) / ir.tau); });
      }
      // 经济出力（潮流层）：控制区就地平衡 + 爬坡滞后，跨区差额体现为联络线交换功率
      online.forEach((n) => {
        inj[n] += st.econ[n] || 0;
      });
      // econ 目标总出力≈总负荷（含跨区支援），注入和天然≈0；
      // 仅把数值残差放到纯负荷参考节点（不选机组，避免掩盖机组外送功率）
      const imbalance = nodes.reduce((a, n) => a + inj[n], 0);
      if (Math.abs(imbalance) > 1e-6) {
        // 找一个非机组节点承载残差；否则退回 slack
        const pureLoad = nodes.find((n) => !this.plantMap[n]) || slack;
        inj[pureLoad] -= imbalance;
      }
      online.forEach((n) => { st.plants[n].pg = Math.max(0, st.econ[n] || 0); });

      const internal = this.lines.filter((l) =>
        st.lines[l.id].closed && nodes.includes(l.from) && nodes.includes(l.to));
      if (nodes.length <= 2 || internal.length < nodes.length - 1) {
        // 辐射网：按“线路下游净负荷”定向分配潮流
        this.radialFlows(st, nodes, internal, inj);
        return;
      }
      this.meshedFlows(st, nodes, internal, inj, slack);
    });
    this.lines.forEach((l) => {
      const ls = st.lines[l.id];
      ls.loading = l.cap > 0 ? Math.abs(ls.flow) / l.cap : 0;
    });
  }

  // 以松弛机为根做 BFS，每条边潮流 = 子树净注入的相反数
  radialFlows(st, nodes, internal, inj) {
    const adj = {};
    nodes.forEach((n) => { adj[n] = []; });
    internal.forEach((l) => {
      adj[l.from].push({ n: l.to, line: l });
      adj[l.to].push({ n: l.from, line: l });
    });
    let root = nodes[0];
    let bestPg = -1;
    nodes.forEach((n) => {
      if (this.plantMap[n] && st.plants[n].pg > bestPg) { bestPg = st.plants[n].pg; root = n; }
    });
    const parent = {};
    const parentLine = {};
    const order = [];
    const seen = new Set([root]);
    const queue = [root];
    while (queue.length) {
      const n = queue.shift();
      order.push(n);
      adj[n].forEach((e) => {
        if (!seen.has(e.n)) {
          seen.add(e.n);
          parent[e.n] = n;
          parentLine[e.n] = e.line;
          queue.push(e.n);
        }
      });
    }
    const subtree = {};
    nodes.forEach((n) => { subtree[n] = inj[n]; });
    for (let i = order.length - 1; i > 0; i--) {
      const n = order[i];
      const line = parentLine[n];
      st.lines[line.id].flow = -subtree[n];
      subtree[parent[n]] += subtree[n];
    }
  }

  // 网孔网：B 矩阵直流潮流（base=100 MVA），Gauss 消元
  // 直流潮流（MW 有名值）：B 元素 = 1/x，注入 P 为 MW，解得相角（标幺弧度的 MW 倍），
  // 线路潮流 = (theta_from - theta_to) / x ，直接得到 MW
  meshedFlows(st, nodes, internal, inj, slack) {
    const idx = {};
    nodes.forEach((n, i) => { idx[n] = i; });
    const N = nodes.length;
    const B = Array.from({ length: N }, () => new Array(N).fill(0));
    internal.forEach((l) => {
      const b = 1 / l.x;
      const i = idx[l.from], j = idx[l.to];
      B[i][i] += b; B[j][j] += b;
      B[i][j] -= b; B[j][i] -= b;
    });
    const keep = nodes.filter((n) => n !== slack).map((n) => idx[n]);
    const M = keep.length;
    const A = keep.map((i) => keep.map((j) => B[i][j]));
    const y = keep.map((i) => inj[nodes[i]]);
    for (let k = 0; k < M; k++) {
      let piv = k;
      for (let i = k + 1; i < M; i++) if (Math.abs(A[i][k]) > Math.abs(A[piv][k])) piv = i;
      if (Math.abs(A[piv][k]) < 1e-10) continue;
      [A[k], A[piv]] = [A[piv], A[k]];
      [y[k], y[piv]] = [y[piv], y[k]];
      for (let i = k + 1; i < M; i++) {
        const f = A[i][k] / A[k][k];
        for (let j = k; j < M; j++) A[i][j] -= f * A[k][j];
        y[i] -= f * y[k];
      }
    }
    const theta = new Array(N).fill(0);
    for (let i = M - 1; i >= 0; i--) {
      let rhs = y[i];
      for (let j = i + 1; j < M; j++) rhs -= A[i][j] * theta[keep[j]];
      theta[keep[i]] = Math.abs(A[i][i]) > 1e-12 ? rhs / A[i][i] : 0;
    }
    internal.forEach((l) => {
      st.lines[l.id].flow = (theta[idx[l.from]] - theta[idx[l.to]]) / l.x;
    });
  }
  // ============ 操作校核：返回 { ok, errors:[], warnings:[] }，不修改状态 ============
  precheck(st, action) {
    const errors = [];
    const warnings = [];
    if (st.failed) errors.push('系统处于失败闭锁状态，请先回退到失败前的步骤');
    if (st.transient) errors.push('上一步操作仍在波动稳定过程中，请等待结束');
    if (!errors.length && action.type === 'start') this.checkStart(st, action, errors, warnings);
    if (!errors.length && action.type === 'close') this.checkClose(st, action, errors, warnings);
    if (!errors.length && action.type === 'restore') this.checkRestore(st, action, errors, warnings);
    return { ok: errors.length === 0, errors, warnings };
  }

  checkStart(st, action, errors, warnings) {
    const p = this.plantMap[action.plantId];
    if (!p) { errors.push('未知电站'); return; }
    const ps = st.plants[p.id];
    if (ps.status === 'online') { errors.push(`${p.name}已并网运行`); return; }
    if (ps.status === 'starting') { errors.push(`${p.name}正在启动中`); return; }
    const compId = st.compOf[p.id];
    const comp = st.comps[compId];
    if (p.blackstart) {
      if (comp.energized) errors.push(`${p.name}所在区域已带电，应直接并网而非黑启动`);
      return;
    }
    if (!comp.energized) {
      errors.push(`${p.name}无自启动能力，必须先通过带电线路获取厂用启动电源`);
      return;
    }
    const stats = this.compStats(st, compId);
    const f = this.compFreq(st, compId);
    if (f < this.lim.fLow || f > this.lim.fHigh) errors.push(`区域频率 ${f.toFixed(2)}Hz 越限，禁止启动`);
    const spare = stats.capOnline - stats.demand;
    if (spare < p.cranking) errors.push(`旋转备用 ${spare.toFixed(0)}MW 不足，无法提供 ${p.cranking}MW 启动电源`);
    if (spare < p.cranking + 8) warnings.push('启动备用裕度较小，频率可能明显波动');
  }

  checkClose(st, action, errors, warnings) {
    const l = this.lineMap[action.lineId];
    if (!l) { errors.push('未知线路'); return; }
    if (st.lines[l.id].closed) { errors.push(`${l.name}已在合位`); return; }
    const a = st.comps[st.compOf[l.from]];
    const b = st.comps[st.compOf[l.to]];
    if (a.id === b.id) {
      warnings.push('合环操作，将产生环流冲击');
      return;
    }
    if (!a.energized && !b.energized) {
      errors.push('线路两侧均无电，无法对线路充电（需先有一侧带电）');
      return;
    }
    if (a.energized && b.energized) {
      const fa = this.compFreq(st, a.id);
      const fb = this.compFreq(st, b.id);
      const df = Math.abs(fa - fb);
      if (df > this.lim.fSyncMax) {
        errors.push(`同期并网失败：两侧频差 ${df.toFixed(2)}Hz 超过 ${this.lim.fSyncMax}Hz 定值`);
        return;
      }
      warnings.push(`分区并列，频差 ${df.toFixed(2)}Hz，将产生功率冲击`);
      this.checkFlowAfter(st, action, errors, warnings);
      return;
    }
    this.checkFlowAfter(st, action, errors, warnings);
  }

  // 干跑拓扑变化后的潮流，检查线路过载与发电容量
  checkFlowAfter(st, action, errors, warnings) {
    const trial = this.snapshot(st);
    this.applyTopology(trial, action);
    this.solveFlows(trial);
    trial.comps.forEach((comp) => {
      if (!comp.energized) return;
      const demand = this.compDemand(trial, comp.id);
      const cap = comp.sources
        .filter((n) => trial.plants[n].status === 'online' || trial.plants[n].status === 'starting')
        .reduce((a, n) => a + this.plantMap[n].cap, 0);
      if (demand > cap) errors.push(`该分区发电容量 ${cap}MW 小于需求 ${demand.toFixed(0)}MW，并入后必然低频`);
    });
    this.lines.forEach((l) => {
      const ls = trial.lines[l.id];
      if (ls.closed && ls.loading > this.lim.overloadTrip) {
        const tag = l.id === action.lineId ? '（拟合线路）' : '';
        warnings.push(`${l.name}${tag}潮流 ${Math.abs(ls.flow).toFixed(0)}MW，负载率 ${(ls.loading * 100).toFixed(0)}%，将过载`);
      }
    });
  }

  checkRestore(st, action, errors, warnings) {
    const items = action.items || [];
    if (!items.length) { errors.push('未选择恢复负荷批次'); return; }
    let compId = null;
    let mw = 0;
    items.forEach((it) => {
      const l = this.loadMap[it.loadId];
      const ls = st.loads[it.loadId];
      if (!l) { errors.push('未知负荷'); return; }
      if (it.mw <= 0) { errors.push(`${l.name}批次容量必须大于 0`); return; }
      const remain = l.mw - ls.restoredMw;
      if (remain <= 0.5) { errors.push(`${l.name}已全部恢复`); return; }
      if (it.mw > remain + 0.5) { errors.push(`${l.name}剩余可恢复仅 ${remain.toFixed(0)}MW`); return; }
      const cId = st.compOf[it.loadId];
      if (!st.comps[cId].energized) { errors.push(`${l.name}所在区域尚未带电`); return; }
      if (compId !== null && compId !== cId) errors.push('一批负荷必须属于同一带电分区');
      compId = cId;
      mw += it.mw;
    });
    if (compId === null || errors.length) return;
    const f = this.compFreq(st, compId);
    if (f < this.lim.fLow || f > this.lim.fHigh) errors.push(`分区频率 ${f.toFixed(2)}Hz 越限，禁止带负荷`);
    const stats = this.compStats(st, compId);
    const spare = stats.capOnline - stats.demand;
    if (spare < mw) errors.push(`旋转备用仅 ${spare.toFixed(0)}MW，不足以一次投入 ${mw.toFixed(0)}MW 负荷`);
    if (spare < mw * 1.6) warnings.push(`投入 ${mw.toFixed(0)}MW 占备用比例较大，频率可能跌至告警区`);
  }

  // ============ 快照 / 拓扑应用 ============
  snapshot(st) {
    return JSON.parse(JSON.stringify(st));
  }

  applyTopology(st, action) {
    if (action.type === 'start') {
      const p = this.plantMap[action.plantId];
      const ps = st.plants[p.id];
      ps.status = 'starting';
      ps.remain = p.start;
      if (p.blackstart) {
        // 自启动电源建立新控制区
        st.zoneSeq += 1;
        const zid = 'Z' + st.zoneSeq;
        st.zoneOf[p.id] = zid;
        this._pendingZone = zid;
      } else if (this._pendingZone === undefined) {
        this._pendingZone = st.zoneOf[p.id];
      }
    } else if (action.type === 'close') {
      st.lines[action.lineId].closed = true;
    } else if (action.type === 'restore') {
      action.items.forEach((it) => {
        st.loads[it.loadId].restoredMw = Math.min(
          this.loadMap[it.loadId].mw, st.loads[it.loadId].restoredMw + it.mw);
        st.loads[it.loadId].shed = false;
      });
    }
    this.recompute(st);
  }

  // ============ 操作生效：校验已通过，构造暂态过程 ============
  beginAction(st, action, label) {
    const before = this.snapshot(st);
    const oldComps = st.comps.map((c) => ({ id: c.id, nodes: [...c.nodes], energized: c.energized }));
    st.simTime += 2; // 操作票执行时间（拓扑变化前计时）
    this.applyTopology(st, action);
    const t0 = st.simTime;
    const inrushes = [];

    if (action.type === 'close') {
      const l = this.lineMap[action.lineId];
      const a = before.comps[before.compOf[l.from]];
      const b = before.comps[before.compOf[l.to]];
      const newId = st.compOf[l.from];
      if (a.energized && b.energized && a.id !== b.id) {
        const df = Math.abs(this.compFreq(before, a.id) - this.compFreq(before, b.id));
        const amp = this.lim.mergeInrushMW * (0.3 + df / this.lim.fSyncMax);
        // 冲击由较小分区承担（按调度视角计入合并后分区一次）
        inrushes.push({ compId: newId, amp, tau: 6, t0 });
      } else if (a.energized !== b.energized) {
        const dead = a.energized ? b : a;
        let cold = 0;
        dead.nodes.forEach((n) => {
          if (this.loadMap[n] && st.loads[n].restoredMw > 0) cold += st.loads[n].restoredMw * 0.3;
        });
        inrushes.push({ compId: newId, amp: 1 + cold, tau: 8, t0 });
      } else {
        inrushes.push({ compId: newId, amp: 1, tau: 3, t0 }); // 合环/充电励磁涌流
      }
    }
    if (action.type === 'restore') {
      const cId = st.compOf[action.items[0].loadId] !== undefined
        ? st.compOf[action.items[0].loadId] : null;
      const mw = action.items.reduce((a, it) => a + it.mw, 0);
      inrushes.push({ compId: cId, amp: mw * 0.25, tau: 10, t0 }); // 冷负荷启动涌流
    }

    const tr = {
      kind: action.type,
      action,
      label,
      t0,
      inrushes,
      charts: {},
      settled: false,
      risk: 0,
      riskMWs: 0,
      events: [],
    };
    st.transient = tr;
    return before;
  }

  // ============ 单步物理推进 dt 秒 ============
  step(st, dt) {
    if (st.failed) return;
    const tr = st.transient;
    st.simTime += dt;

    // 1) 启动倒计时
    if (tr && tr.kind === 'start') {
      const p = this.plantMap[tr.action.plantId];
      const ps = st.plants[p.id];
      if (ps.status === 'starting') {
        ps.remain -= dt;
        if (ps.remain <= 0) {
          ps.status = 'online';
          ps.remain = 0;
          tr.events.push(`t=${st.simTime.toFixed(0)}s ${p.name}并网，调速器投入`);
          this.recompute(st);
        }
      }
    }

    // 2) 每个带电分量：频率动态 + 机组爬升
    st.comps.forEach((comp) => {
      if (!comp.energized) return;
      const stats = this.compStats(st, comp.id);
      if (!stats.online.length) {
        // 仅含启动中黑启动电源的新建分区：维持额定频率，机组并网后再参与动态
        comp.nodes.forEach((n) => { st.freq[n] = this.scn.fBase; });
        return;
      }
      const f = this.compFreq(st, comp.id);
      const df = f - this.scn.fBase;
      const governorGain = stats.capOnline / (this.lim.droop * this.scn.fBase); // MW/Hz
      // 经济调度基线 + 调速器一次调频目标，按容量比例分配到各机组
      const dispatchTarget = stats.demand;
      const totalTarget = Math.max(0, Math.min(stats.capOnline, dispatchTarget - df * governorGain));
      let totalMech = 0;
      stats.online.forEach((n) => {
        const p = this.plantMap[n];
        const share = p.cap / stats.capOnline;
        const targetMech = totalTarget * share;
        const cur = st.mech[n] || 0;
        const mv = p.ramp * dt;
        const next = Math.abs(targetMech - cur) <= mv ? targetMech : cur + Math.sign(targetMech - cur) * mv;
        st.mech[n] = Math.max(0, Math.min(p.cap, next));
        totalMech += st.mech[n];
      });
      // 潮流层经济出力：按控制区就地平衡，AGC 跨区再分配较慢（爬坡约束）
      let compInrush = 0;
      if (st.transient) {
        st.transient.inrushes.filter((ir) => ir.compId === comp.id).forEach((ir) => {
          compInrush += ir.amp * Math.exp(-(st.simTime - ir.t0) / ir.tau);
        });
      }
      const econTargets = this.dispatchTargets(st, comp, stats.online,
        Math.max(0, stats.demand - compInrush), compInrush);
      stats.online.forEach((n) => {
        const pl = this.plantMap[n];
        const target = econTargets[n] || 0;
        const cur = st.econ[n] || 0;
        const mv = pl.ramp * dt; // 与物理爬坡一致：跨区支援不能瞬时完成
        const next = Math.abs(target - cur) <= mv ? target : cur + Math.sign(target - cur) * mv;
        st.econ[n] = Math.max(0, Math.min(pl.cap, next));
      });
      // Pe 含负荷频率阻尼效应；高频时负荷略增，抑制超速
      const Pe = stats.demand + this.lim.damp * df;
      if (stats.inertia > 0) {
        const dF = ((totalMech - Pe) / stats.inertia) * dt;
        let nf = f + dF;
        nf = Math.max(45, Math.min(55, nf)); // 数值钳位，保护按真实越限触发
        comp.nodes.forEach((n) => { st.freq[n] = nf; });
      }
    });

    // 3) 潮流
    this.solveFlows(st);

    // 4) 保护：低频减载 / 崩溃 / 线路过载
    if (!st.failed) this.protections(st, dt);

    // 5) 风险积分 & 曲线
    if (tr && !st.failed) this.accumulateRisk(st, dt);
    this.recordCharts(st);

    // 6) 暂态结束判定
    if (tr && !st.failed) {
      const activeInrush = tr.inrushes.reduce((a, ir) =>
        a + ir.amp * Math.exp(-(st.simTime - ir.t0) / ir.tau), 0);
      const starting = this.scn.plants.some((p) => st.plants[p.id].status === 'starting');
      const stable = st.comps.every((c) => {
        if (!c.energized) return true;
        const f = this.compFreq(st, c.id);
        return Math.abs(f - this.scn.fBase) < 0.03;
      });
      const elapsed = st.simTime - tr.t0;
      if (!starting && activeInrush < 1 && stable) {
        tr.settled = true;
        st.transient = null;
      } else if (elapsed > 600) {
        tr.events.push('稳定时间过长，调度员中止本步');
        tr.settled = true;
        st.transient = null;
      }
    }
  }

  protections(st, dt) {
    // 频率保护
    st.comps.forEach((comp) => {
      if (!comp.energized || !comp.sources.some((n) => st.plants[n].status === 'online')) return;
      const f = this.compFreq(st, comp.id);
      if (f <= this.lim.fCollapse || f >= 55) {
        this.collapse(st, comp.id, `频率 ${f.toFixed(2)}Hz 超出崩溃定值，全分区解列掉电`);
        return;
      }
      if (f <= this.lim.fUFLS) {
        // 低频减载：切除该分区最大的一个未减载已恢复负荷
        const cand = comp.nodes
          .filter((n) => this.loadMap[n] && st.loads[n].restoredMw > 0 && !st.loads[n].shed)
          .sort((a, b) => st.loads[b].restoredMw - st.loads[a].restoredMw);
        if (cand.length) {
          const id = cand[0];
          const shedMw = st.loads[id].restoredMw;
          st.loads[id].shed = true;
          st.loads[id].restoredMw = 0;
          st.alarms.push(`⚠ 低频减载动作：${this.loadMap[id].name} ${shedMw.toFixed(0)}MW 被切除（f=${f.toFixed(2)}Hz）`);
          this.fail(st, `低频减载动作（${this.loadMap[id].name} ${shedMw.toFixed(0)}MW 被切除），恢复策略失败`);
          return;
        }
        if (!cand.length) {
          this.collapse(st, comp.id, `频率 ${f.toFixed(2)}Hz 持续下跌且无负荷可切`);
          return;
        }
      }
    });
    if (st.failed) return;

    // 线路过载保护
    this.lines.forEach((l) => {
      const ls = st.lines[l.id];
      if (!ls.closed) return;
      if (ls.loading >= this.lim.severeTrip) {
        this.tripLine(st, l.id, `严重过载 ${(ls.loading * 100).toFixed(0)}%，保护瞬时跳闸`);
      } else if (ls.loading > this.lim.overloadTrip) {
        st.overloadT[l.id] = (st.overloadT[l.id] || 0) + dt;
        if (st.overloadT[l.id] >= this.lim.overloadHold) {
          this.tripLine(st, l.id, `持续过载 ${this.lim.overloadHold}s（${(ls.loading * 100).toFixed(0)}%），线路跳闸`);
        }
      } else {
        st.overloadT[l.id] = 0;
      }
    });
  }

  tripLine(st, lineId, reason) {
    const l = this.lineMap[lineId];
    st.lines[lineId].closed = false;
    st.lines[lineId].flow = 0;
    st.alarms.push(`⚠ ${l.name}跳闸：${reason}`);
    this.recompute(st);
    this.solveFlows(st);
    const reDead = st.comps.filter((c) => !c.energized);
    const deadLoads = reDead.reduce((a, c) =>
      a + c.nodes.reduce((x, n) => x + (this.loadMap[n] ? st.loads[n].restoredMw : 0), 0), 0);
    this.fail(st, deadLoads > 0
      ? `${l.name}跳闸导致 ${deadLoads}MW 已恢复区域再次掉电`
      : `${l.name}跳闸，网架结构被破坏`);
  }

  collapse(st, compId, reason) {
    const comp = st.comps[compId];
    comp.nodes.forEach((n) => {
      if (this.plantMap[n]) {
        st.plants[n].status = 'off';
        st.plants[n].remain = 0;
        st.plants[n].pg = 0;
        st.mech[n] = 0;
        st.econ[n] = 0;
      }
      st.freq[n] = 0;
    });
    st.alarms.push(`⚠ ${reason}`);
    this.recompute(st);
    this.solveFlows(st);
    this.fail(st, reason);
  }

  fail(st, reason) {
    st.failed = true;
    st.failReason = reason;
    if (st.transient) {
      st.transient.settled = true;
      st.transient.events.push(`✗ ${reason}`);
      st.transient = null;
    }
  }

  accumulateRisk(st, dt) {
    const tr = st.transient;
    if (!tr) return;
    let add = 0;
    st.comps.forEach((c) => {
      if (!c.energized) return;
      const f = this.compFreq(st, c.id);
      const dev = Math.abs(f - this.scn.fBase);
      // 仅对进入告警区（|Δf|>0.2）计分；越限(>0.5)权重更高
      if (dev > this.lim.fHigh - this.scn.fBase) {
        const excess = dev - (this.lim.fHigh - this.scn.fBase);
        add += (0.4 + excess * 2) * dt;
      }
    });
    this.lines.forEach((l) => {
      const loading = st.lines[l.id].loading;
      if (loading > 1) add += (loading - 1) * 20 * dt;
      else if (loading > 0.95) add += (loading - 0.95) * 6 * dt;
    });
    tr.riskMWs += add;
    tr.risk = Math.round(tr.riskMWs);
    st.risk += add;
  }

  recordCharts(st) {
    const tr = st.transient;
    st.comps.forEach((c, i) => {
      if (!c.energized) return;
      const key = `island${i}`;
      const t = +(st.simTime - (tr ? tr.t0 : 0)).toFixed(1);
      const f = +this.compFreq(st, c.id).toFixed(3);
      if (tr) {
        if (!tr.charts[key]) tr.charts[key] = [];
        const arr = tr.charts[key];
        if (!arr.length || t - arr[arr.length - 1][0] >= 0.4) arr.push([t, f]);
      }
    });
  }

  // 当前统计
  metrics(st) {
    const total = this.scn.loads.reduce((a, l) => a + l.mw, 0);
    let restored = 0, energized = 0;
    this.scn.loads.forEach((l) => {
      restored += st.loads[l.id].restoredMw;
      if (st.comps[st.compOf[l.id]].energized) energized += l.mw;
    });
    const onlineCap = this.scn.plants
      .filter((p) => st.plants[p.id].status === 'online')
      .reduce((a, p) => a + p.cap, 0);
    const islands = st.comps.filter((c) => c.energized).length;
    return {
      total, restored, energized,
      gap: total - restored,
      restoredPct: restored / total,
      energizedPct: energized / total,
      onlineCap, islands,
      risk: Math.round(st.risk),
      time: st.simTime,
    };
  }

  // 就近经济调度：每个负荷按 机组容量/跳数² 就近分摊；机组出力受动态爬升上限约束；
  // 各机组承担本地负荷后的余量/缺额自然反映为联络线潮流，残余不平衡由松弛节点兜底
  // 基于控制区的经济调度（决定地理出力分布 -> 联络线潮流）：
  // 1) 每个在线机组的“调度出力目标” = 其控制区内负荷按容量比例分摊
  // 2) 控制区随并列合并而扩大，但目标按 AGC 速率缓慢再分配（爬坡约束）
  // 3) 暂态功率缺额由全区机组按容量瞬时共担（调速器），体现跨区紧急支援
  // 基于原生控制区的经济调度（决定地理出力 -> 联络线潮流）：
  // - 各控制区负荷优先由本区机组按容量比例承担（最多到容量上限）
  // - 本区出力不足时，缺额按“其余在线机组的剩余容量”比例跨区分摊，
  //   外区机组需抬升出力、经联络线送入 -> 联络线出现真实交换功率
  // - 暂态冲击按全区容量比例由调速器瞬时共担
  dispatchTargets(st, comp, online, steadyLoad, inrush) {
    const targets = {};
    online.forEach((g) => { targets[g] = 0; });
    const capOf = (g) => this.plantMap[g].cap;
    const totalCap = online.reduce((a, g) => a + capOf(g), 0);

    // 1) 区内负荷按机组归属分区
    const zoneLoad = {};
    const zoneGens = {};
    comp.nodes.forEach((n) => {
      const z = st.zoneOf[n];
      if (z === undefined) return;
      let ld = 0;
      if (this.loadMap[n] && st.loads[n].restoredMw > 0 && !st.loads[n].shed) {
        ld = st.loads[n].restoredMw;
      } else if (this.plantMap[n] && st.plants[n].status === 'starting' && !this.plantMap[n].blackstart) {
        ld = this.plantMap[n].cranking;
      }
      if (ld > 0) zoneLoad[z] = (zoneLoad[z] || 0) + ld;
    });
    online.forEach((g) => {
      const z = st.zoneOf[g];
      if (z !== undefined) {
        if (!zoneGens[z]) zoneGens[z] = [];
        zoneGens[z].push(g);
      }
    });

    // 2) 区内机组尽量就地承担（受容量上限）
    Object.keys(zoneLoad).forEach((z) => {
      const gens = (zoneGens[z] || []).filter((g) => online.includes(g));
      let remain = zoneLoad[z];
      if (gens.length) {
        const zcap = gens.reduce((a, g) => a + capOf(g), 0);
        gens.forEach((g) => {
          const share = Math.min(capOf(g), remain * capOf(g) / zcap);
          targets[g] += share;
          remain -= share;
        });
      }
      // 3) 区内承担不了的缺额：按外区机组剩余容量比例跨区支援
      if (remain > 0.01) {
        const helpers = online.filter((g) => st.zoneOf[g] !== z);
        let spareCap = helpers.reduce((a, g) => a + Math.max(0, capOf(g) - targets[g]), 0);
        if (spareCap <= 0.01) {
          // 全区都满发：平均摊（松弛节点潮流兜底，频率层会因备用不足而低频）
          online.forEach((g) => { targets[g] += remain / online.length; });
        } else {
          helpers.forEach((g) => {
            const spare = Math.max(0, capOf(g) - targets[g]);
            targets[g] += remain * spare / spareCap;
          });
        }
      }
    });

    // 4) 暂态冲击按容量比例共担
    if (inrush > 0.001) {
      online.forEach((g) => { targets[g] += inrush * capOf(g) / totalCap; });
    }
    return targets;
  }
}

if (typeof window !== 'undefined') window.Engine = Engine;
if (typeof module !== 'undefined' && module.exports) {
  const d = require('./data.js');
  module.exports = { Engine, SCENARIO: d.SCENARIO, LIMITS: d.LIMITS };
}
