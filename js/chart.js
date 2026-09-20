'use strict';

// 频率波动曲线：多分区叠加，含安全区/告警区/越限区色带
const FreqChart = {
  draw(canvas, series, limits) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const padL = 44, padR = 12, padT = 12, padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const fMin = 48.0, fMax = 52.0;
    const f2y = (f) => padT + plotH * (1 - (f - fMin) / (fMax - fMin));

    // 背景色带
    const bands = [
      { lo: fMin, hi: limits.fCollapse, color: 'rgba(239,68,68,0.22)' },
      { lo: limits.fCollapse, hi: limits.fUFLS, color: 'rgba(249,115,22,0.18)' },
      { lo: limits.fUFLS, hi: limits.fAlarmLow, color: 'rgba(234,179,8,0.12)' },
      { lo: limits.fAlarmLow, hi: limits.fLow, color: 'rgba(234,179,8,0.07)' },
      { lo: limits.fLow, hi: limits.fHigh, color: 'rgba(34,197,94,0.07)' },
      { lo: limits.fHigh, hi: limits.fAlarmHigh, color: 'rgba(234,179,8,0.07)' },
      { lo: limits.fAlarmHigh, hi: fMax, color: 'rgba(239,68,68,0.18)' },
    ];
    bands.forEach((b) => {
      ctx.fillStyle = b.color;
      const y1 = f2y(Math.max(fMin, b.hi));
      const y2 = f2y(Math.min(fMax, b.lo));
      ctx.fillRect(padL, y1, plotW, y2 - y1);
    });

    // 网格 + y 轴刻度
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;
    [48, 49, 49.5, 49.8, 50, 50.2, 50.5, 51, 52].forEach((f) => {
      const y = f2y(f);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.fillText(f.toFixed(1), 8, y + 3);
    });

    // 50Hz 中线
    ctx.strokeStyle = 'rgba(226,232,240,0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, f2y(50));
    ctx.lineTo(W - padR, f2y(50));
    ctx.stroke();
    ctx.setLineDash([]);

    const entries = Object.entries(series || {});
    let tMax = 30;
    entries.forEach(([, pts]) => pts.forEach((p) => { tMax = Math.max(tMax, p[0]); }));
    const t2x = (t) => padL + plotW * (t / tMax);

    // x 轴刻度
    ctx.fillStyle = '#94a3b8';
    const step = tMax > 120 ? 30 : tMax > 40 ? 10 : 5;
    for (let t = 0; t <= tMax; t += step) {
      const x = t2x(t);
      ctx.strokeStyle = 'rgba(148,163,184,0.12)';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillText(t + 's', x - 8, H - 6);
    }

    const colors = ['#38bdf8', '#fbbf24', '#a78bfa', '#34d399', '#fb7185', '#f472b6'];
    entries.forEach(([key, pts], i) => {
      if (!pts.length) return;
      const color = colors[i % colors.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, j) => {
        const x = t2x(p[0]), y = f2y(Math.max(fMin, Math.min(fMax, p[1])));
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    // 图例
    let lx = padL + 8;
    entries.forEach(([key, pts], i) => {
      if (!pts.length) return;
      const color = colors[i % colors.length];
      ctx.fillStyle = color;
      ctx.fillRect(lx, padT + 4, 10, 3);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '10px sans-serif';
      const label = '分区' + key.replace('island', '');
      ctx.fillText(label, lx + 14, padT + 9);
      lx += 56;
    });
  },
};

if (typeof window !== 'undefined') window.FreqChart = FreqChart;
