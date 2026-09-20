/* 暂态推演：聚合频率模型 + 直流潮流校核 + 保护动作 */
(function (global) {
  'use strict';
  var D = global.BS_DATA;
  var E = global.BS_ENGINE;
  var R = D.RULES;
  var DT = 0.1;

  function unitById(id) { return E.unitById(id); }

  // 在工作态上应用操作的"即时拓扑效果"（暂态开始前的拓扑快照）
  function applyTopology(ws, action) {
    if (action.type === 'closeLine') {
      ws.lines[action.target] = true;
    } else if (action.type === 'restoreLoad') {
      ws.loads[action.target] = true;
    } else if (action.type === 'startUnit' && action.unitOnline) {
      ws.units[action.target].state = 'online';
      ws.units[action.target].power = action.minPower || 0;
    }
  }

  // 构造各岛动态状态
  function makeIslandDyn(dv, ws, opts) {
    opts = opts || {};
    var islands = {};
    dv.islands.forEach(function (isl) {
      var agcGain = isl.unitIds.reduce(function (s, uid) {
        var u = unitById(uid);
        return s + u.capacity * 0.002; // MW/Hz/s（二次调频积分增益）
      }, 0);
      var govGain = isl.unitIds.reduce(function (s, uid) {
        var u = unitById(uid);
        return s + u.capacity / (D.F_NOMINAL * u.droop); // MW/Hz（调差系数）
      }, 0);
      islands[isl.id] = {
        members: isl.members.slice(),
        lines: isl.lines.slice(),
        unitIds: isl.unitIds.slice(),
        loadIds: isl.loadIds.slice(),
        ref: isl.ref,
        freq: D.F_NOMINAL + (opts.freqOffset && opts.freqOffset[isl.id] || 0),
        inertia: isl.inertia,
        govGain: govGain,
        damping: isl.load * 0.015,
        agcGain: agcGain,
        govPower: 0,
        agcIntegral: 0,
        extraLoad: {},      // bus -> MW（冲击/充电）
        overload: {},       // lineId -> 持续过载秒数
        shed: {},           // loadId -> true 低频减载切除
        crashed: false,
        crashReason: null,
        crashAt: null,
        syncPower: 0,
        powerNow: {}
      };
      var dynIsl = islands[isl.id];
      isl.unitIds.forEach(function (uid) {
        dynIsl.powerNow[uid] = ws.units[uid].power || 0;
      });
    });
    return islands;
  }

  // 计算岛内机组出力分配：调度目标 + 调速器附加
  function dispatch(isld, ws) {
    var load = 0;
    isld.loadIds.forEach(function (lid) {
      if (!isld.shed[lid]) {
        var lb = E.loadById(lid);
        load += lb.mw;
      }
    });
    Object.keys(isld.extraLoad).forEach(function (b) { load += isld.extraLoad[b]; });
    var capSum = 0, minSum = 0;
    isld.unitIds.forEach(function (uid) {
      var u = unitById(uid);
      capSum += u.capacity;
      minSum += u.minLoad;
    });
    var targetTotal = load; // 二次调频目标：出力跟踪负荷
    var gov = isld.govPower;
    var target = Math.max(minSum, Math.min(capSum, targetTotal + gov + isld.agcIntegral));
    var dispatchMap = {}, alloc = 0;
    if (capSum > 0) {
      isld.unitIds.forEach(function (uid) {
        var u = unitById(uid);
        var p = target * u.capacity / capSum;
        p = Math.max(u.minLoad, Math.min(u.capacity, p));
        dispatchMap[uid] = p;
        alloc += p;
      });
      // 简单再平衡
      if (alloc < load - 0.5 && capSum > minSum) {
        var room = 0;
        isld.unitIds.forEach(function (uid) {
          var u = unitById(uid);
          room += Math.max(0, u.capacity - dispatchMap[uid]);
        });
        if (room > 0) {
          var add = Math.min(room, load - alloc);
          isld.unitIds.forEach(function (uid) {
            var u = unitById(uid);
            var r = Math.max(0, u.capacity - dispatchMap[uid]);
            dispatchMap[uid] += add * r / room;
          });
        }
      }
    }
    return { targetMap: dispatchMap, load: load };
  }

  // 从动态岛构造供 derive/潮流使用的临时 state 视图
  function islandView(isld) {
    var unitIds = isld.unitIds, loadIds = [];
    isld.loadIds.forEach(function (lid) { if (!isld.shed[lid]) loadIds.push(lid); });
    return {
      id: isld.id, members: isld.members, lines: isld.lines,
      unitIds: unitIds, loadIds: loadIds, ref: isld.ref
    };
  }

  // 主仿真：state 为操作前稳定态；返回过程帧、事件与结果（不修改原 state）
  function runSim(state, action) {
    var ws = E.clone(state);
    applyTopology(ws, action);
    var dv = E.derive(ws);
    var dyn = makeIslandDyn(dv, ws, action.freqOffset);

    var events = [];
    function ev(t, type, text, level) {
      events.push({ t: +t.toFixed(1), type: type, text: text, level: level || 'warn' });
    }

    // 初始扰动配置
    var cfg = {
      loadApplyAt: action.type === 'restoreLoad' ? 2.0 : 0,
      loadBus: null, loadMw: 0, loadId: null,
      inrushBus: null, inrushMw: 0,
      surgeBus: null, surgeMw: 0
    };
    if (action.type === 'closeLine') {
      var line = E.lineById(action.target);
      if (action.kind === 'energize') {
        var deadSide = dv.energized[line.from] ? line.to : line.from;
        // 合闸前判断的死侧（在原 state 上）
        deadSide = state.lines[line.id] ? deadSide : (E.derive(state).energized[line.from] ? line.to : line.from);
        cfg.inrushBus = deadSide; cfg.inrushMw = R.energizeInrush;
        ev(0, 'info', line.name + ' 合闸，对停电侧变压器/线路充电（励磁冲击 ' + R.energizeInrush + 'MW）', 'info');
      } else if (action.kind === 'sync') {
        var deg = action.syncAngle || 0;
        cfg.surgeBus = line.from;
        cfg.surgeMw = deg * 4;
        ev(0, 'info', '同期并列：角差 ' + deg.toFixed(1) + '°，联络线产生功率冲击', 'info');
      }
    } else if (action.type === 'restoreLoad') {
      var lb = E.loadById(action.target);
      cfg.loadBus = lb.bus; cfg.loadMw = lb.mw; cfg.loadId = lb.id;
      ev(2, 'info', '合环接入 ' + lb.name + ' +' + lb.mw + 'MW', 'info');
    } else if (action.type === 'startUnit' && action.unitOnline) {
      var u = E.unitById(action.target);
      ev(0, 'info', u.name + ' 并网，初始出力 ' + (action.minPower || 0) + 'MW', 'info');
    }

    var frames = [];
    var horizon = R.simHorizon;
    var steps = Math.round(horizon / DT);
    var crashedInfo = null;

    function islandByBus(busId) {
      var ids = Object.keys(dyn);
      for (var i = 0; i < ids.length; i++) {
        if (dyn[ids[i]].members.indexOf(busId) >= 0 && !dyn[ids[i]].crashed) return dyn[ids[i]];
      }
      return null;
    }

    function pseudoState(isld) {
      var ps = { units: {}, lines: {}, loads: {} };
      isld.unitIds.forEach(function (uid) {
        ps.units[uid] = { state: 'online', power: ws.units[uid].power };
      });
      D.LOAD_BATCHES.forEach(function (b) {
        ps.loads[b.id] = ws.loads[b.id] && !isld.shed[b.id];
      });
      isld.lines.forEach(function (lid) { ps.lines[lid] = true; });
      return ps;
    }

    for (var step = 0; step <= steps; step++) {
      var t = +(step * DT).toFixed(2);

      // 扰动投入
      if (action.type === 'closeLine' && action.kind === 'energize' && cfg.inrushBus) {
        var isE = islandByBus(cfg.inrushBus);
        if (isE) {
          isE.extraLoad[cfg.inrushBus] = (isE.extraLoad[cfg.inrushBus] || 0) + cfg.inrushMw;
          cfg.inrushBus = null;
        }
      }
      if (action.type === 'closeLine' && action.kind === 'sync' && cfg.surgeBus !== null && t >= 0) {
        var isS = islandByBus(cfg.surgeBus);
        if (isS) { isS.extraLoad['__surge'] = (isS.extraLoad['__surge'] || 0) + cfg.surgeMw; cfg.surgeBus = null; }
      }
      if (action.type === 'restoreLoad' && t >= cfg.loadApplyAt && cfg.loadBus !== null) {
        var isL = islandByBus(cfg.loadBus);
        if (isL) {
          isL.extraLoad['__newload'] = (isL.extraLoad['__newload'] || 0) + cfg.loadMw;
          cfg.loadBus = null;
        }
      }

      // 冲击衰减
      Object.keys(dyn).forEach(function (id) {
        var isl = dyn[id];
        if (isl.crashed) return;
        ['__surge'].forEach(function (k) {
          if (isl.extraLoad[k]) {
            isl.extraLoad[k] *= Math.exp(-DT / 2.5);
            if (isl.extraLoad[k] < 0.5) delete isl.extraLoad[k];
          }
        });
        // 励磁充电冲击按指数渐退（避免突卸引发高频）
        if (action.type === 'closeLine' && action.kind === 'energize') {
          Object.keys(isl.extraLoad).forEach(function (b) {
            if (b.indexOf('__') !== 0) {
              isl.extraLoad[b] *= Math.exp(-DT / 1.8);
              if (isl.extraLoad[b] < 0.5) delete isl.extraLoad[b];
            }
          });
        }
      });

      var maxFlow = {}, frameFreq = {};
      Object.keys(dyn).forEach(function (id) {
        var isl = dyn[id];
        if (isl.crashed) { frameFreq[id] = 0; return; }
        var inf = inertiaFactor(isl);
        var df = isl.freq - D.F_NOMINAL;
        // 一次调频：调速器（一阶惯性），上限为可增发空间
        var govTarget = Math.max(-300, Math.min(inf.govLimit, -isl.govGain * df));
        isl.govPower += (govTarget - isl.govPower) * DT / 1.2;
        // 二次调频：抗积分饱和（受 minLoad/容量限幅时停止同向积分）
        var wanted = inf.load + isl.govPower + isl.agcIntegral;
        var hiSat = wanted > inf.capTotal, loSat = wanted < inf.minTotal;
        if (!((hiSat && df < 0) || (loSat && df > 0))) {
          isl.agcIntegral += -isl.agcGain * df * DT;
        }
        isl.agcIntegral = Math.max(-inf.load, Math.min(inf.capTotal - inf.minTotal, isl.agcIntegral));

        var disp = dispatch(isl, ws);
        var totalGen = 0;
        Object.keys(disp.targetMap).forEach(function (uid) {
          var u = unitById(uid);
          var target = disp.targetMap[uid];
          var now = isl.powerNow[uid];
          var stepMax = u.ramp * DT;
          var next = Math.max(u.minLoad, Math.min(u.capacity,
            now + Math.max(-stepMax, Math.min(stepMax, target - now))));
          // 并网瞬间从 minLoad 起步（已由初始 power 给出）
          isl.powerNow[uid] = next;
          ws.units[uid].power = next;
          totalGen += next;
        });
        var net = totalGen - disp.load;
        var M = Math.max(1, isl.inertia * 4.5);
        var dampt = isl.damping + isl.unitIds.length * 3; // 机组固有阻尼
        isl.freq += (net - dampt * (isl.freq - D.F_NOMINAL)) / M * DT;
        frameFreq[id] = isl.freq;

        // 潮流与过载
        var ps = pseudoState(isl);
        var dc = E.dcPowerFlow(islandView(isl), ps, { dispatch: isl.powerNow, loadAt: isl.extraLoad });
        Object.keys(dc.flows).forEach(function (lid) {
          var l = E.lineById(lid);
          var ratio = Math.abs(dc.flows[lid]) / l.capacity;
          maxFlow[lid] = ratio;
          if (ratio > R.overloadTrip) {
            isl.overload[lid] = (isl.overload[lid] || 0) + DT;
          } else {
            isl.overload[lid] = 0;
          }
        });
      });

      // 保护判断
      Object.keys(dyn).forEach(function (id) {
        var isl = dyn[id];
        if (isl.crashed) return;
        var f = isl.freq;

        // 低频减载：49.0Hz 切除 1 批可中断负荷（每 0.8s 一轮，最多切到恢复负荷）
        if (f < R.freqLowUFLS && !isl._uflsCooldown) {
          var cand = isl.loadIds.filter(function (lid) { return !isl.shed[lid]; })
            .sort(function (a, b) {
              return (E.loadById(b).batch) - (E.loadById(a).batch);
            })[0];
          if (cand) {
            isl.shed[cand] = true;
            var lb = E.loadById(cand);
            ev(t, 'ufls', '低频减载动作：切除 ' + E.busMap ? '' : '', 'danger');
            events[events.length - 1].text = '低频减载动作（' + f.toFixed(2) + 'Hz）：切除 ' +
              busName(lb.bus) + ' ' + lb.name + ' ' + lb.mw + 'MW';
            isl._uflsCooldown = 0.8;
          }
        }
        if (isl._uflsCooldown !== undefined) {
          isl._uflsCooldown -= DT;
          if (isl._uflsCooldown <= 0) delete isl._uflsCooldown;
        }

        if (f < R.freqLowTrip) {
          isl.lowCount = (isl.lowCount || 0) + DT;
          if (isl.lowCount > 0.5) {
            crashIsland(isl, t, '频率低至 ' + f.toFixed(2) + 'Hz，机组低频保护解列，分区崩溃');
          }
        } else isl.lowCount = 0;

        if (f > R.freqHighTrip) {
          isl.highCount = (isl.highCount || 0) + DT;
          if (isl.highCount > 0.3) {
            crashIsland(isl, t, '频率高至 ' + f.toFixed(2) + 'Hz，机组超速保护动作，分区崩溃');
          }
        } else isl.highCount = 0;

        Object.keys(isl.overload).forEach(function (lid) {
          if (isl.overload[lid] > R.overloadHold && !isl._trippedLines) {
            isl._trippedLines = isl._trippedLines || {};
          }
          if (isl.overload[lid] > R.overloadHold && !(isl._trippedLines && isl._trippedLines[lid])) {
            isl._trippedLines = isl._trippedLines || {};
            isl._trippedLines[lid] = true;
            var l = E.lineById(lid);
            ev(t, 'trip', l.name + ' 持续过载 ' + R.overloadHold + 's，保护跳闸', 'danger');
            crashIsland(isl, t, l.name + ' 过载跳闸后分区失稳崩溃');
          }
        });
      });

      if (step % 5 === 0) {
        frames.push({ t: +t.toFixed(1), f: frameFreq, flow: E.clone(maxFlow) });
      }

      var anyLive = Object.keys(dyn).some(function (id2) { return !dyn[id2].crashed; });
      if (!anyLive) { crashedInfo = 'all'; break; }
    }

    function inertiaFactor(isl) {
      var capTotal = 0, minTotal = 0, load = 0;
      isl.unitIds.forEach(function (uid) { capTotal += unitById(uid).capacity; minTotal += unitById(uid).minLoad; });
      isl.loadIds.forEach(function (lid) { if (!isl.shed[lid]) load += E.loadById(lid).mw; });
      Object.keys(isl.extraLoad).forEach(function (b) { load += isl.extraLoad[b]; });
      return {
        capTotal: capTotal, minTotal: minTotal, load: load,
        govLimit: Math.max(0, capTotal - minTotal - load),
        agcHi: capTotal - minTotal, agcLo: load
      };
    }
    function busName(b) { var m = E.busMap(); return m[b] ? m[b].name : b; }
    function crashIsland(isl, t, reason) {
      if (isl.crashed) return;
      isl.crashed = true; isl.crashReason = reason; isl.crashAt = t;
      ev(t, 'crash', reason, 'danger');
    }

    // 汇总结果
    var crashedList = Object.keys(dyn).filter(function (id) { return dyn[id].crashed; });
    var shedList = [];
    Object.keys(dyn).forEach(function (id) {
      Object.keys(dyn[id].shed).forEach(function (lid) { shedList.push(lid); });
    });

    // 最终稳态：以最后帧状态构造
    var finalState = E.clone(state);
    applyTopology(finalState, action);
    var settleOk = true;
    Object.keys(dyn).forEach(function (id) {
      var isl = dyn[id];
      if (isl.crashed) {
        settleOk = false;
        isl.unitIds.forEach(function (uid) { finalState.units[uid] = { state: 'offline', power: 0, crankStart: null }; });
        isl.lines.forEach(function (lid) { finalState.lines[lid] = false; });
        isl.loadIds.forEach(function (lid) { finalState.loads[lid] = false; });
      } else {
        // 更新机组实际出力
        isl.unitIds.forEach(function (uid) {
          finalState.units[uid].power = ws.units[uid].power;
        });
        // 低频减载切除的负荷回退
        isl.loadIds.forEach(function (lid) {
          if (isl.shed[lid]) { finalState.loads[lid] = false; settleOk = false; }
        });
        var lastF = frames.length ? lastFreq(frames, id) : isl.freq;
        if (Math.abs(lastF - D.F_NOMINAL) > R.settleBand) settleOk = false;
      }
    });
    if (crashedList.length) settleOk = false;

    function lastFreq(fr, id) {
      for (var i = fr.length - 1; i >= 0; i--) {
        if (fr[i].f[id] !== undefined && fr[i].f[id] > 0) return fr[i].f[id];
      }
      return 0;
    }

    return {
      ok: settleOk,
      frames: frames,
      events: events,
      finalState: finalState,
      crashed: crashedList.length > 0,
      crashReasons: crashedList.map(function (id) { return { island: id, reason: dyn[id].crashReason, at: dyn[id].crashAt }; }),
      shedLoads: shedList,
      minFreq: minMax(frames, 'min'),
      maxFreq: minMax(frames, 'max')
    };
  }

  function minMax(frames, kind) {
    var v = null;
    frames.forEach(function (fr) {
      Object.keys(fr.f).forEach(function (id) {
        var val = fr.f[id];
        if (val <= 0) return;
        if (v === null) v = val;
        v = kind === 'min' ? Math.min(v, val) : Math.max(v, val);
      });
    });
    return v === null ? D.F_NOMINAL : +v.toFixed(2);
  }

  global.BS_SIM = { runSim: runSim, DT: DT };
})(typeof window !== 'undefined' ? window : globalThis);
