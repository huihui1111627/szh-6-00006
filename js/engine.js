/* 黑启动推演引擎：拓扑计算、操作校核、暂态频率/潮流仿真、回退快照 */
(function (global) {
  'use strict';

  var D = global.BS_DATA;
  var R = D.RULES;

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  // ---------- 初始状态 ----------
  function initialState() {
    var s = {
      clock: 0,
      units: {},
      lines: {},
      loads: {},
      checkpoints: [],
      log: [],
      risk: 0,
      failCount: 0,
      restoredCount: 0
    };
    D.UNITS.forEach(function (u) {
      s.units[u.id] = { state: 'offline', power: 0, crankStart: null };
    });
    D.LINES.forEach(function (l) { s.lines[l.id] = false; });
    D.LOAD_BATCHES.forEach(function (b) { s.loads[b.id] = false; });
    return s;
  }

  // ---------- 拓扑派生 ----------
  function busMap() {
    var m = {};
    D.BUSES.forEach(function (b) { m[b.id] = b; });
    return m;
  }

  function derive(s) {
    var online = {}, genBus = {};
    D.UNITS.forEach(function (u) {
      var us = s.units[u.id];
      online[u.id] = us.state === 'online';
      if (online[u.id]) genBus[u.bus] = true;
    });

    // 邻接（仅合闸线路）
    var adj = {};
    D.BUSES.forEach(function (b) { adj[b.id] = []; });
    D.LINES.forEach(function (l) {
      if (s.lines[l.id]) {
        adj[l.from].push({ to: l.to, line: l.id });
        adj[l.to].push({ to: l.from, line: l.id });
      }
    });

    // BFS 求带电母线（电源母线出发）
    var energized = {};
    Object.keys(genBus).forEach(function (b) {
      if (!energized[b]) {
        var q = [b];
        energized[b] = true;
        while (q.length) {
          var cur = q.shift();
          adj[cur].forEach(function (e) {
            if (!energized[e.to]) { energized[e.to] = true; q.push(e.to); }
          });
        }
      }
    });

    // 电气岛（连通分量；只有带电母线组成的岛才有电源）
    var islands = [], seen = {};
    D.BUSES.forEach(function (b) {
      if (seen[b.id] || !energized[b.id]) return;
      var st = [b.id], members = [], lines = {};
      seen[b.id] = true;
      while (st.length) {
        var cur = st.pop();
        members.push(cur);
        adj[cur].forEach(function (e) {
          if (energized[e.to]) lines[e.line] = true;
          if (!seen[e.to] && energized[e.to]) { seen[e.to] = true; st.push(e.to); }
        });
      }
      var unitIds = [], gen = 0, cap = 0, inertia = 0, load = 0, loadIds = [];
      members.forEach(function (bid) {
        D.UNITS.forEach(function (u) {
          if (u.bus === bid && online[u.id]) {
            unitIds.push(u.id);
            gen += s.units[u.id].power;
            cap += u.capacity;
            inertia += u.inertia;
          }
        });
        D.LOAD_BATCHES.forEach(function (lb) {
          if (lb.bus === bid && s.loads[lb.id]) { load += lb.mw; loadIds.push(lb.id); }
        });
      });
      islands.push({
        id: 'I' + (islands.length + 1),
        members: members, lines: Object.keys(lines),
        unitIds: unitIds, gen: gen, capacity: cap, inertia: inertia,
        load: load, loadIds: loadIds,
        hasGen: unitIds.length > 0,
        ref: members[0]
      });
    });

    var lineStatus = {};
    D.LINES.forEach(function (l) {
      lineStatus[l.id] = s.lines[l.id] && energized[l.from] && energized[l.to];
    });

    return { online: online, energized: energized, islands: islands, lineEnergized: lineStatus };
  }

  // ---------- 直流潮流（每岛独立，参考节点角=0） ----------
  function dcPowerFlow(island, s, extra) {
    extra = extra || {};
    var memb = island.members;
    var idx = {};
    memb.forEach(function (b, i) { idx[b] = i; });
    var n = memb.length;
    var P = new Array(n).fill(0);

    island.unitIds.forEach(function (uid) {
      var u = unitById(uid);
      P[idx[u.bus]] += extra.dispatch ? (extra.dispatch[uid] || s.units[uid].power) : s.units[uid].power;
    });
    D.LOAD_BATCHES.forEach(function (lb) {
      if (idx[lb.bus] !== undefined && s.loads[lb.id]) P[idx[lb.bus]] -= lb.mw;
    });
    if (extra.loadAt) {
      Object.keys(extra.loadAt).forEach(function (bid) {
        if (idx[bid] !== undefined) P[idx[bid]] -= extra.loadAt[bid];
      });
    }

    var ref = 0;
    // B 矩阵
    var B = [];
    for (var i = 0; i < n; i++) B.push(new Array(n).fill(0));
    var islLines = [];
    island.lines.forEach(function (lid) {
      var l = lineById(lid);
      var a = idx[l.from], b = idx[l.to];
      if (a === undefined || b === undefined) return;
      var bval = 1 / l.x;
      B[a][a] += bval; B[b][b] += bval; B[a][b] -= bval; B[b][a] -= bval;
      islLines.push({ l: l, a: a, b: b, bval: bval });
    });

    // 消去参考节点，解线性方程（高斯迭代，规模小）
    var keep = [];
    for (var k = 0; k < n; k++) if (k !== ref) keep.push(k);
    var m = keep.length;
    var theta = new Array(n).fill(0);
    var th = new Array(m).fill(0);
    for (var iter = 0; iter < 400; iter++) {
      var maxD = 0;
      for (var ii = 0; ii < m; ii++) {
        var kk = keep[ii], row = B[kk];
        var rhs = P[kk];
        for (var j = 0; j < n; j++) {
          if (j === kk || j === ref) continue;
          rhs -= row[j] * theta[j];
        }
        var nv = rhs / row[kk];
        maxD = Math.max(maxD, Math.abs(nv - th[ii]));
        th[ii] = nv;
      }
      for (var t = 0; t < m; t++) theta[keep[t]] = th[t];
      if (maxD < 1e-9) break;
    }

    var flows = {};
    islLines.forEach(function (e) {
      var mw = e.bval * (theta[e.a] - theta[e.b]);
      flows[e.l.id] = mw;
    });
    var anglesRad = {};
    memb.forEach(function (bid) { anglesRad[bid] = theta[idx[bid]]; });
    return { flows: flows, anglesRad: anglesRad };
  }

  function angleDegAt(dc, busId) {
    var a = dc.anglesRad[busId];
    return a === undefined ? null : a * 180 / Math.PI;
  }

  // ---------- 查找辅助 ----------
  function unitById(id) { return D.UNITS.filter(function (u) { return u.id === id; })[0]; }
  function lineById(id) { return D.LINES.filter(function (l) { return l.id === id; })[0]; }
  function loadById(id) { return D.LOAD_BATCHES.filter(function (b) { return b.id === id; })[0]; }
  function islandOf(dv, busId) {
    return dv.islands.filter(function (i) { return i.members.indexOf(busId) >= 0; })[0] || null;
  }

  // ---------- 操作可行性（即时校验，返回 {ok, reason}） ----------
  function canStartUnit(s, dv, uid) {
    var u = unitById(uid), us = s.units[uid];
    if (us.state === 'cranking') return { ok: false, reason: u.name + ' 正在启动中' };
    if (us.state === 'online') return { ok: false, reason: u.name + ' 已并网运行' };
    if (u.blackstart) return { ok: true };
    var isl = islandOf(dv, u.bus);
    if (!isl || !isl.hasGen) return { ok: false, reason: u.name + ' 厂用电未恢复：需先用黑启动电源给本厂母线送电' };
    var need = u.type === 'thermal' ? R.crankNeedThermal : R.crankNeedGas;
    var reserve = isl.capacity - isl.load;
    if (reserve < need) return { ok: false, reason: '岛备用容量不足：需 ' + need + 'MW，当前仅 ' + Math.max(0, Math.round(reserve)) + 'MW（先恢复少量负荷以增加出力裕度）' };
    return { ok: true };
  }

  function canCloseLine(s, dv, lid) {
    if (s.lines[lid]) return { ok: false, reason: '线路已在合位' };
    var l = lineById(lid);
    var aLive = dv.energized[l.from], bLive = dv.energized[l.to];
    if (!aLive && !bLive) return { ok: false, reason: '两侧均无电：需先恢复其中一侧电源' };
    if (aLive && bLive) {
      var ia = islandOf(dv, l.from), ib = islandOf(dv, l.to);
      if (ia === ib) return { ok: false, reason: '两侧已在同一电气岛' };
      return { ok: true, kind: 'sync', ia: ia, ib: ib };
    }
    return { ok: true, kind: 'energize' };
  }

  function canRestoreLoad(s, dv, lid) {
    if (s.loads[lid]) return { ok: false, reason: '该批负荷已恢复' };
    var lb = loadById(lid);
    var isl = islandOf(dv, lb.bus);
    if (!isl || !isl.hasGen) return { ok: false, reason: '该站未带电，无法恢复负荷' };
    return { ok: true, isl: isl };
  }

  // 同期并列角差校核（基于各岛直流潮流相角）
  function syncCheck(s, ia, ib, line) {
    var dca = dcPowerFlow(ia, s), dcb = dcPowerFlow(ib, s);
    var angA = angleDegAt(dca, line.from);
    var angB = angleDegAt(dcb, line.to);
    var diff = Math.abs((angA || 0) - (angB || 0));
    return { angle: diff, allow: diff < R.syncMergeAngle, crash: diff > R.syncCrashAngle };
  }

  module.exports_check = null;

  global.BS_ENGINE = {
    clone: clone,
    initialState: initialState,
    derive: derive,
    busMap: busMap,
    dcPowerFlow: dcPowerFlow,
    angleDegAt: angleDegAt,
    unitById: unitById,
    lineById: lineById,
    loadById: loadById,
    islandOf: islandOf,
    canStartUnit: canStartUnit,
    canCloseLine: canCloseLine,
    canRestoreLoad: canRestoreLoad,
    syncCheck: syncCheck
  };
})(typeof window !== 'undefined' ? window : globalThis);
