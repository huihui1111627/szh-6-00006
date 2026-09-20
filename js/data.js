/* 区域电网黑启动推演 —— 静态网络模型
 * 单位：容量/负荷 MW，电抗标幺值(简化)，频率 Hz，时间 s
 */
(function (global) {
  'use strict';

  // 母线（电站/变电节点）。x/y 为 SVG 坐标（viewBox 0 0 1000 620）
  var BUSES = [
    { id: 'BH', name: '白鹤滩水电站', x: 110, y: 150, type: 'plant', desc: '黑启动电源 · 水轮发电机组' },
    { id: 'BP', name: '蟠龙抽水蓄能', x: 110, y: 470, type: 'plant', desc: '黑启动电源 · 抽水蓄能机组' },
    { id: 'S1', name: '东郊变电站', x: 360, y: 120, type: 'sub', desc: '500kV 枢纽变电站' },
    { id: 'S4', name: '江南变电站', x: 360, y: 300, type: 'sub', desc: '500kV 枢纽变电站' },
    { id: 'S5', name: '西郊变电站', x: 360, y: 500, type: 'sub', desc: '220kV 变电站' },
    { id: 'TC', name: '临港火电厂', x: 620, y: 150, type: 'plant', desc: '600MW 燃煤机组（需外部启动电源）' },
    { id: 'TG', name: '东山燃气电厂', x: 620, y: 470, type: 'plant', desc: '200MW 燃气-蒸汽联合循环机组' },
    { id: 'S2', name: '城北变电站', x: 870, y: 260, type: 'sub', desc: '220kV 负荷中心变电站' },
    { id: 'S3', name: '临港工业区', x: 870, y: 470, type: 'sub', desc: '工业大负荷变电站' }
  ];

  // 发电机组
  // blackstart: 可否自启动；minLoad: 最小技术出力；ramp: MW/s 爬坡
  var UNITS = [
    { id: 'U_H',  bus: 'BH', name: '白鹤滩 #1', type: 'hydro',  blackstart: true,  capacity: 300, minLoad: 0,  ramp: 12, crank: 90,  inertia: 8,  droop: 0.05, desc: '水电机组，黑启动首选，可带负荷启动' },
    { id: 'U_P',  bus: 'BP', name: '蟠龙 #2',   type: 'pumped', blackstart: true,  capacity: 200, minLoad: 0,  ramp: 10, crank: 150, inertia: 7,  droop: 0.05, desc: '抽蓄机组，发电工况下可自启动' },
    { id: 'U_TC', bus: 'TC', name: '临港 #3',   type: 'thermal',blackstart: false, capacity: 600, minLoad: 260,ramp: 1.6,crank: 1200,inertia: 22, droop: 0.05, desc: '大惯量燃煤机组，启动需 ≥150MW 外部厂用电' },
    { id: 'U_TG', bus: 'TG', name: '东山 #4',   type: 'gas',    blackstart: false, capacity: 200, minLoad: 90, ramp: 4.5,crank: 480,inertia: 9,  droop: 0.05, desc: '燃气机组，启动较快，需 ≥50MW 外部电源' }
  ];

  // 线路（送电走廊）。两端均可由断路器合闸
  var LINES = [
    { id: 'L1', from: 'BH', to: 'S1', capacity: 360, x: 0.12, name: '白鹤—东郊 I 线' },
    { id: 'L2', from: 'BH', to: 'S4', capacity: 300, x: 0.18, name: '白鹤—江南 II 线' },
    { id: 'L3', from: 'BP', to: 'S5', capacity: 300, x: 0.13, name: '蟠龙—西郊线' },
    { id: 'L4', from: 'BP', to: 'S4', capacity: 300, x: 0.16, name: '蟠龙—江南线' },
    { id: 'L5', from: 'S1', to: 'S4', capacity: 420, x: 0.10, name: '东郊—江南联络线' },
    { id: 'L6', from: 'S4', to: 'S5', capacity: 300, x: 0.11, name: '江南—西郊线' },
    { id: 'L7', from: 'S1', to: 'TC', capacity: 480, x: 0.09, name: '东郊—临港厂线' },
    { id: 'L8', from: 'S4', to: 'TG', capacity: 300, x: 0.12, name: '江南—东山厂线' },
    { id: 'L9', from: 'TC', to: 'S2', capacity: 360, x: 0.14, name: '临港厂—城北线' },
    { id: 'L10', from: 'S1', to: 'S2', capacity: 300, x: 0.17, name: '东郊—城北线' },
    { id: 'L11', from: 'S5', to: 'S3', capacity: 300, x: 0.13, name: '西郊—临港工业线' },
    { id: 'L12', from: 'TG', to: 'S3', capacity: 300, x: 0.12, name: '东山厂—临港工业线' },
    { id: 'L13', from: 'S2', to: 'S3', capacity: 300, x: 0.15, name: '城北—临港工业联络线' }
  ];

  // 负荷：每个负荷站分 3 批恢复（比例约 40% / 35% / 25%）
  var LOAD_BATCHES = (function () {
    var defs = [
      { bus: 'S1', total: 90 },
      { bus: 'S4', total: 110 },
      { bus: 'S5', total: 80 },
      { bus: 'S2', total: 200 },
      { bus: 'S3', total: 200 }
    ];
    var ratios = [[0.40, '一批（重要负荷）'], [0.35, '二批（一般负荷）'], [0.25, '三批（可中断负荷）']];
    var out = [];
    defs.forEach(function (d) {
      ratios.forEach(function (r, i) {
        out.push({
          id: d.bus + '_B' + (i + 1),
          bus: d.bus,
          batch: i + 1,
          name: r[1],
          mw: Math.round(d.total * r[0])
        });
      });
    });
    return out;
  })();

  var F_NOMINAL = 50;

  var RULES = {
    freqLowTrip: 48.2,     // 严重低频：孤岛崩溃
    freqLowUFLS: 49.0,     // 低频减载动作
    freqHighTrip: 51.0,    // 严重高频：机组超速跳闸致孤岛崩溃
    overloadTrip: 1.0,     // 线路持续过载比例
    overloadHold: 3.0,     // 过载持续秒数 → 跳闸
    syncMergeAngle: 15,    // 角差 < 15° 允许同期并列
    syncCrashAngle: 30,    // 角差 > 30° 非同期合闸 → 两岛崩溃
    settleBand: 0.1,       // 频率稳定带 ±0.1Hz
    simHorizon: 90,        // 暂态推演秒数
    crankNeedThermal: 150, // 火电机组所需外部厂用电
    crankNeedGas: 50,      // 燃气机组所需外部厂用电
    energizeInrush: 20     // 充电合闸冲击负荷 MW（短时）
  };

  var data = {
    BUSES: BUSES,
    UNITS: UNITS,
    LINES: LINES,
    LOAD_BATCHES: LOAD_BATCHES,
    F_NOMINAL: F_NOMINAL,
    RULES: RULES,
    totalLoad: LOAD_BATCHES.reduce(function (s, b) { return s + b.mw; }, 0),
    totalCapacity: UNITS.reduce(function (s, u) { return s + u.capacity; }, 0)
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = data;
  global.BS_DATA = data;
})(typeof window !== 'undefined' ? window : globalThis);
