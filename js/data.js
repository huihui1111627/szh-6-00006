'use strict';

// 区域电网黑启动推演场景：4 座电站、8 座变电站、5 个负荷中心、18 条线路
// 功率单位 MW；坐标为 SVG viewBox 坐标
const SCENARIO = {
  name: '华东某区域电网黑启动演练场景',
  fBase: 50,
  plants: [
    { id: 'P1', name: '白水河水电', type: 'hydro', cap: 180, ramp: 12, start: 40, blackstart: true,
      cranking: 0, x: 140, y: 150 },
    { id: 'P2', name: '云台山燃机', type: 'gas', cap: 120, ramp: 6, start: 240, blackstart: true,
      cranking: 0, x: 860, y: 150 },
    { id: 'P3', name: '北岭火电厂', type: 'thermal', cap: 300, ramp: 5, start: 480, blackstart: false,
      cranking: 12, x: 500, y: 90 },
    { id: 'P4', name: '东港火电厂', type: 'thermal', cap: 260, ramp: 5, start: 420, blackstart: false,
      cranking: 10, x: 770, y: 500 },
  ],
  substations: [
    { id: 'S1', name: '西郊变', x: 240, y: 280 },
    { id: 'S2', name: '北站变', x: 420, y: 260 },
    { id: 'S3', name: '中心变', x: 560, y: 290 },
    { id: 'S4', name: '东湖变', x: 730, y: 280 },
    { id: 'S5', name: '南岭变', x: 370, y: 450 },
    { id: 'S6', name: '南港变', x: 570, y: 460 },
    { id: 'S7', name: '东港变', x: 760, y: 390 },
    { id: 'S8', name: '临港变', x: 880, y: 360 },
  ],
  loads: [
    { id: 'L1', name: '城西负荷', mw: 120, x: 120, y: 400 },
    { id: 'L2', name: '城北负荷', mw: 90, x: 420, y: 560 },
    { id: 'L3', name: '中心城区', mw: 180, x: 560, y: 165 },
    { id: 'L4', name: '城东负荷', mw: 150, x: 910, y: 260 },
    { id: 'L5', name: '临港工业区', mw: 100, x: 920, y: 500 },
  ],
  lines: [
    { id: 'LN1', name: '白水河—西郊', from: 'P1', to: 'S1', cap: 240, x: 0.05, r: 0.02 },
    { id: 'LN2', name: '西郊—中心', from: 'S1', to: 'S3', cap: 240, x: 0.10, r: 0.04 },
    { id: 'LN3', name: '中心—北站', from: 'S3', to: 'S2', cap: 220, x: 0.08, r: 0.03 },
    { id: 'LN4', name: '北站—北岭', from: 'S2', to: 'P3', cap: 320, x: 0.06, r: 0.02 },
    { id: 'LN5', name: '中心—城东(东湖)', from: 'S3', to: 'S4', cap: 120, x: 0.12, r: 0.04 },
    { id: 'LN6', name: '云台山—东湖', from: 'P2', to: 'S4', cap: 200, x: 0.05, r: 0.02 },
    { id: 'LN7', name: '西郊—南岭', from: 'S1', to: 'S5', cap: 180, x: 0.15, r: 0.05 },
    { id: 'LN8', name: '南岭—南港', from: 'S5', to: 'S6', cap: 200, x: 0.09, r: 0.03 },
    { id: 'LN9', name: '中心—南港', from: 'S3', to: 'S6', cap: 220, x: 0.10, r: 0.04 },
    { id: 'LN10', name: '南港—东港变', from: 'S6', to: 'S7', cap: 200, x: 0.08, r: 0.03 },
    { id: 'LN11', name: '东湖—临港', from: 'S4', to: 'S8', cap: 170, x: 0.10, r: 0.04 },
    { id: 'LN12', name: '临港—东港变', from: 'S8', to: 'S7', cap: 170, x: 0.10, r: 0.04 },
    { id: 'LN13', name: '东港变—东港电厂', from: 'S7', to: 'P4', cap: 280, x: 0.05, r: 0.02 },
    { id: 'LN14', name: '北站—南岭', from: 'S2', to: 'S5', cap: 160, x: 0.14, r: 0.05 },
    { id: 'LN15', name: '西郊T接城西', from: 'S1', to: 'L1', cap: 150, x: 0.05, r: 0.02 },
    { id: 'LN16', name: '南岭T接城北', from: 'S5', to: 'L2', cap: 120, x: 0.05, r: 0.02 },
    { id: 'LN17', name: '中心T接中心城区', from: 'S3', to: 'L3', cap: 220, x: 0.03, r: 0.01 },
    { id: 'LN18', name: '东湖T接城东', from: 'S4', to: 'L4', cap: 170, x: 0.05, r: 0.02 },
    { id: 'LN19', name: '临港T接工业区', from: 'S8', to: 'L5', cap: 130, x: 0.05, r: 0.02 },
    { id: 'LN20', name: '北站—中心北联络', from: 'S2', to: 'S4', cap: 150, x: 0.13, r: 0.05 },
  ],
};

// 全局稳定与保护参数
const LIMITS = {
  fLow: 49.8,          // 安全下限
  fHigh: 50.2,         // 安全上限
  fAlarmLow: 49.5,     // 异常告警
  fAlarmHigh: 50.5,
  fUFLS: 49.0,         // 低频减载动作
  fCollapse: 48.5,     // 频率崩溃（区域掉电）
  fSyncMax: 0.2,       // 同期并网最大频差 Hz
  overloadTrip: 1.0,   // 持续过载跳闸阈值（占容量比）
  severeTrip: 1.25,    // 严重过载立即跳闸
  overloadHold: 8,     // 持续过载秒数后跳闸
  H: 4.0,              // 等效惯性常数 s
  droop: 0.04,         // 调差系数
  damp: 1.2,           // 负荷频率阻尼 MW/Hz
  mergeInrushMW: 60,   // 同期合闸冲击功率 MW（按频差缩放）
};

if (typeof module !== 'undefined' && module.exports) module.exports = { SCENARIO, LIMITS };
