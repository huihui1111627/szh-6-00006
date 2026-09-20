'use strict';

// ============ 黑启动推演台主控制器 ============
const App = {
  engine: null,
  strategy: null,
  st: null,
  selected: null,           // {kind:'plant'|'line'|'load', id}
  timer: null,
  speed: 40,                // 仿真秒 / 真实秒（推演倍速）
  chartSeries: {},
  chartStart: 0,

  init() {
    this.engine = new Engine(SCENARIO, LIMITS);
    this.bindStatic();
    this.bootstrap();
    this.setSpeed(40);
    this.render();
  },

  bootstrap() {
    const id = Store.activeId();
    let strat = id ? Store.get(id) : null;
    if (!strat) {
      const list = Store.list();
      strat = list[0] || null;
    }
    if (strat && strat.state) {
      this.strategy = strat;
      this.st = strat.state;
    } else {
      this.newStrategy('默认恢复策略', true);
    }
  },

  newStrategy(name, silent) {
    const strat = Store.newStrategy(name);
    strat.state = this.engine.freshState();
    this.strategy = strat;
    this.st = strat.state;
    Store.upsert(strat);
    this.selected = null;
    if (!silent) this.render();
  },

  persist() {
    this.strategy.state = this.st;
    Store.upsert(this.strategy);
  },

  // ---------- 静态事件 ----------
  bindStatic() {
    document.getElementById('btn-new-strategy').onclick = () => {
      const name = prompt('请输入新策略名称：', '策略 ' + (Store.list().length + 1));
      if (name !== null) { this.newStrategy(name.trim() || undefined); this.stopLoop(); this.render(); }
    };
    document.getElementById('btn-compare').onclick = () => this.openCompare();
    document.getElementById('btn-help').onclick = () => this.openHelp();
    document.getElementById('btn-close-compare').onclick = () => document.getElementById('modal-compare').classList.add('hidden');
    document.getElementById('btn-close-help').onclick = () => document.getElementById('modal-help').classList.add('hidden');
    document.getElementById('btn-branch').onclick = () => {
      const name = prompt('基于当前策略创建对照副本，名称：', this.strategy.name + '（对照）');
      if (name !== null) {
        const copy = Store.branch(this.strategy.id, name.trim() || undefined);
        Store.upsert(copy);
        this.strategy = copy; this.st = copy.state;
        this.selected = null; this.stopLoop(); this.render();
      }
    };
    document.getElementById('btn-reset').onclick = () => {
      if (confirm('确定重置当前策略？将清空所有步骤（不影响其他策略）。')) {
        this.newStrategy(this.strategy.name, true);
        this.stopLoop(); this.render();
      }
    };
    document.querySelectorAll('.speed-btn').forEach((btn) => {
      btn.onclick = () => this.setSpeed(Number(btn.dataset.speed));
    });
  },

  setSpeed(sp) {
    this.speed = sp;
    document.querySelectorAll('.speed-btn').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.speed) === sp);
    });
  },

  // ---------- 推演主循环 ----------
  startLoop() {
    if (this.timer) return;
    let last = performance.now();
    this.chartStart = this.st.simTime;
    this.chartSeries = {};
    this._stepNadir = 50; this._stepPeak = 50;
    const tick = (now) => {
      const wall = (now - last) / 1000;
      last = now;
      let dt = wall * this.speed;
      dt = Math.min(dt, 2.0); // 单帧最大 2 仿真秒，防止低帧率数值发散
      const sub = Math.max(1, Math.ceil(dt / 0.25));
      const h = dt / sub;
      for (let i = 0; i < sub; i++) this.engine.step(this.st, h);
      this.collectChart();
      this.renderTransient();
      if (!this.st.transient || this.st.failed) {
        this.finishStep();
        this.timer = null;
        return;
      }
      this.timer = requestAnimationFrame(tick);
    };
    this.timer = requestAnimationFrame(tick);
  },

  stopLoop() {
    if (this.timer) { cancelAnimationFrame(this.timer); this.timer = null; }
  },

  collectChart() {
    const tr = this.st.transient;
    if (!tr) return;
    this.engine.compsIslandKeys = this.engine.compsIslandKeys || {};
    this.st.comps.forEach((c, i) => {
      if (!c.energized) return;
      const key = 'island' + i;
      const t = +(this.st.simTime - tr.t0).toFixed(1);
      const f = +this.engine.compFreq(this.st, c.id).toFixed(3);
      this._stepNadir = Math.min(this._stepNadir, f);
      this._stepPeak = Math.max(this._stepPeak, f);
      if (!this.chartSeries[key]) this.chartSeries[key] = [];
      const arr = this.chartSeries[key];
      if (!arr.length || t - arr[arr.length - 1][0] >= 0.3) arr.push([t, f]);
    });
  },

  // ---------- 执行操作 ----------
  requestAction(action, label) {
    if (this.st.transient) { this.toast('请等待当前操作稳定', 'warn'); return; }
    const pc = this.engine.precheck(this.st, action);
    if (!pc.ok) {
      this.strategy.rejected.push({
        action, label, errors: pc.errors, time: this.st.simTime, at: Date.now(),
      });
      this.persist();
      this.render();
      this.toast('系统校核未通过：' + pc.errors[0], 'error');
      return;
    }
    const before = this.engine.snapshot(this.st);
    const riskBefore = this.st.risk;
    this.engine.beginAction(this.st, action, label);
    const step = {
      action, label, before,
      after: null,
      risk: 0,
      _riskBefore: riskBefore,
      result: 'running',
      t0: this.st.simTime,
      nadir: 50, peak: 50,
      charts: {},
    };
    this._pendingStep = step;
    this.render();
    this.startLoop();
  },

  finishStep() {
    const step = this._pendingStep;
    if (!step) { this.render(); return; }
    this._pendingStep = null;
    step.charts = JSON.parse(JSON.stringify(this.chartSeries));
    step.risk = Math.max(0, Math.round(this.st.risk - (step._riskBefore || 0)));
    step.nadir = this._stepNadir || 50; step.peak = this._stepPeak || 50;
    if (this.st.failed) {
      step.result = 'failed';
      step.failReason = this.st.failReason;
      step.after = null; // 保留失败现场，不覆盖 before
    } else {
      step.result = 'ok';
      step.after = this.engine.snapshot(this.st);
    }
    this.strategy.steps.push(step);
    this.persist();
    this.render();
    if (this.st.failed) this.toast('操作失败：' + this.st.failReason, 'error');
  },

  // 回退：回到指定步骤执行前的现场（截断其后所有步骤，包括失败步骤）
  rollback(index) {
    this.stopLoop();
    const step = this.strategy.steps[index];
    if (!step) return;
    const snapshot = this.engine.snapshot(step.before);
    this.st = snapshot;
    this.strategy.state = snapshot;
    this.strategy.steps = this.strategy.steps.slice(0, index);
    // 风险累计回退到该步之前
    const kept = this.strategy.steps;
    this.st.risk = kept.length ? (kept[kept.length - 1]._riskBefore || 0) : 0;
    this.persist();
    this.render();
    this.toast(`已回退到「${step.label}」之前`, 'ok');
  },

  loadStrategy(id) {
    const strat = Store.get(id);
    if (!strat || !strat.state) return;
    this.stopLoop();
    this.strategy = strat;
    this.st = strat.state;
    Store.setActive(id);
    this.selected = null;
    this.render();
  },

  deleteStrategy(id, ev) {
    ev.stopPropagation();
    const s = Store.get(id);
    if (confirm(`删除策略「${s ? s.name : id}」？不可恢复。`)) {
      Store.remove(id);
      if (this.strategy && this.strategy.id === id) {
        const list = Store.list();
        if (list.length) this.loadStrategy(list[0].id);
        else this.newStrategy('默认恢复策略');
      }
      this.render();
    }
  },
};

if (typeof window !== 'undefined') window.App = App;
// ============ 渲染 ============
Object.assign(App, {
  // ---------- 主渲染 ----------
  render() {
    this.renderHeader();
    this.renderGrid();
    this.renderMetrics();
    this.renderActionCard();
    this.renderSteps();
    this.renderAlarms();
    this.renderStrategyTabs();
    this.renderChartStatic();
  },

  renderTransient() {
    this.renderGrid();
    this.renderMetrics();
    this.renderActionCard(true);
    const canvas = document.getElementById('freq-canvas');
    FreqChart.draw(canvas, this.chartSeries, LIMITS);
  },

  renderHeader() {
    document.getElementById('strategy-name').textContent = this.strategy.name;
    const m = this.engine.metrics(this.st);
    document.getElementById('sim-time').textContent = this.fmtTime(m.time);
    const status = document.getElementById('run-status');
    if (this.st.failed) {
      status.textContent = '● 失败闭锁';
      status.className = 'status-badge failed';
    } else if (this.st.transient) {
      status.textContent = '● 波动稳定中…';
      status.className = 'status-badge running';
    } else {
      status.textContent = '● 待操作';
      status.className = 'status-badge idle';
    }
  },

  fmtTime(s) {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return m + '分' + String(ss).padStart(2, '0') + '秒';
  },

  nodeEnergized(id) {
    return this.st.comps[this.st.compOf[id]].energized;
  },

  // ---------- SVG 电网 ----------
  fitView() {
    const svg = document.getElementById('grid-svg');
    const rect = svg.getBoundingClientRect();
    if (rect.width < 10) return;
    // 内容包围盒（含标签边距）
    let minX = 60, maxX = 960, minY = 48, maxY = 600;
    const w = maxX - minX, h = maxY - minY;
    const target = rect.width / rect.height;
    let vw = w, vh = h, ox = minX, oy = minY;
    if (w / h > target) {
      // 容器更“瘦高”：加高 viewBox（上下补白）
      vh = w / target; oy = minY - (vh - h) / 2;
    } else {
      // 容器更“宽扁”：加宽 viewBox（左右补白）
      vw = h * target; ox = minX - (vw - w) / 2;
    }
    svg.setAttribute('viewBox', `${ox.toFixed(0)} ${oy.toFixed(0)} ${vw.toFixed(0)} ${vh.toFixed(0)}`);
  },

  renderGrid() {
    const svg = document.getElementById('grid-svg');
    this.fitView();
    const layers = { line: '', flow: '', node: '' };

    // 线路
    this.engine.lines.forEach((l) => {
      const pa = this.nodeXY(l.from), pb = this.nodeXY(l.to);
      const ra = this.nodeRadius(l.from), rb = this.nodeRadius(l.to);
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const a = { x: pa.x + ux * ra, y: pa.y + uy * ra };
      const b = { x: pb.x - ux * rb, y: pb.y - uy * rb };
      const ls = this.st.lines[l.id];
      const ea = this.nodeEnergized(l.from), eb = this.nodeEnergized(l.to);
      let cls = 'line dead';
      if (ls.closed && ea && eb) cls = 'line live';
      else if (ls.closed) cls = 'line tripped';
      if (this.selected && this.selected.kind === 'line' && this.selected.id === l.id) cls += ' sel';
      const over = ls.loading > 1;
      if (over && ls.closed) cls += ' overload';
      layers.line += `<line data-kind="line" data-id="${l.id}" class="${cls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;

      if (ls.closed && ea && eb) {
        const pct = Math.min(1, ls.loading);
        const fcls = ls.loading > 1 ? 'flowline ov' : 'flowline';
        layers.flow += `<line class="${fcls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-dasharray="${6 + pct * 6} ${10 - pct * 6}"/>`;
        // 潮流标签
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 6;
        const tcls = ls.loading > 1 ? 'flow-tag ov' : ls.loading > 0.85 ? 'flow-tag warn' : 'flow-tag';
        layers.flow += `<g class="${tcls}"><rect x="${mx - 26}" y="${my - 9}" width="52" height="15" rx="3"/><text x="${mx}" y="${my + 2}">${Math.abs(ls.flow).toFixed(0)}MW ${(ls.loading * 100).toFixed(0)}%</text></g>`;
      }
      if (!ls.closed) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        layers.flow += `<g class="breaker-open" data-kind="line" data-id="${l.id}"><circle cx="${mx}" cy="${my}" r="7"/><text x="${mx}" y="${my + 3}">×</text></g>`;
      }
    });

    // 电站
    SCENARIO.plants.forEach((p) => {
      const ps = this.st.plants[p.id];
      const en = this.nodeEnergized(p.id);
      let stateCls = 'off';
      if (ps.status === 'online') stateCls = 'online';
      else if (ps.status === 'starting') stateCls = 'starting';
      const cls = `plant ${stateCls}${this.selCls('plant', p.id)}`;
      const f = en ? this.engine.compFreq(this.st, this.st.compOf[p.id]) : 0;
      layers.node += `<g data-kind="plant" data-id="${p.id}" class="${cls}" transform="translate(${p.x},${p.y})">
        <rect x="-30" y="-22" width="60" height="44" rx="6"/>
        <text class="pname" y="-28">${p.name}</text>
        <text class="pval" y="-6">${p.cap}MW</text>
        <text class="pstatus" y="7">${this.plantStatusText(p, ps)}</text>
        ${en ? `<text class="pfreq" y="20">${f.toFixed(2)}Hz</text>` : ''}
      </g>`;
    });

    // 变电站
    SCENARIO.substations.forEach((s) => {
      const en = this.nodeEnergized(s.id);
      const cls = `sub ${en ? 'live' : 'dead'}${this.selCls('sub', s.id)}`;
      layers.node += `<g data-kind="sub" data-id="${s.id}" class="${cls}" transform="translate(${s.x},${s.y})">
        <rect x="-12" y="-12" width="24" height="24" rx="3"/>
        <text class="sname" y="22">${s.name}</text>
      </g>`;
    });

    // 负荷
    SCENARIO.loads.forEach((ld) => {
      const ls = this.st.loads[ld.id];
      const en = this.nodeEnergized(ld.id);
      const pct = ls.restoredMw / ld.mw;
      let cls = 'load';
      if (ls.shed) cls += ' shed';
      else if (pct >= 0.999) cls += ' full';
      else if (pct > 0) cls += ' partial';
      else cls += en ? ' energized' : ' dead';
      cls += this.selCls('load', ld.id);
      layers.node += `<g data-kind="load" data-id="${ld.id}" class="${cls}" transform="translate(${ld.x},${ld.y})">
        <circle r="18"/>
        <text class="lname" y="-24">${ld.name}</text>
        <text class="lmw">${ld.mw}MW</text>
        <text class="lpct">${pct > 0 ? Math.round(pct * 100) + '%' : (ls.shed ? '已切除' : '未恢复')}</text>
        ${pct > 0 && pct < 0.999 ? `<circle class="ring" r="18" pathLength="100" stroke-dasharray="${pct * 100} 100"/>` : ''}
      </g>`;
    });

    svg.innerHTML = `<g class="layer-line">${layers.line}</g>
      <g class="layer-flow">${layers.flow}</g>
      <g class="layer-node">${layers.node}</g>`;

    svg.onclick = (ev) => {
      const el = ev.target.closest('[data-kind]');
      if (el && svg.contains(el)) {
        this.selected = { kind: el.dataset.kind, id: el.dataset.id };
      } else {
        this.selected = null;
      }
      this.render();
    };
  },

  selCls(kind, id) {
    return this.selected && this.selected.kind === kind && this.selected.id === id ? ' sel' : '';
  },

  nodeRadius(id) {
    if (this.engine.plantMap[id]) return 30;
    if (this.engine.loadMap[id]) return 18;
    return 13;
  },

  nodeXY(id) {
    const p = this.engine.plantMap[id];
    if (p) return { x: p.x, y: p.y };
    const s = SCENARIO.substations.find((x) => x.id === id);
    if (s) return { x: s.x, y: s.y };
    const l = this.engine.loadMap[id];
    return { x: l.x, y: l.y };
  },

  plantStatusText(p, ps) {
    if (ps.status === 'online') return '并网 ' + Math.round(ps.pg) + 'MW';
    if (ps.status === 'starting') return p.blackstart ? '黑启动中' : '启动 ' + Math.ceil(ps.remain) + 's';
    return ps.status === 'tripped' ? '跳闸' : '停机';
  },

  // ---------- 指标条 ----------
  renderMetrics() {
    const m = this.engine.metrics(this.st);
    const box = document.getElementById('metrics');
    const islandFreqs = this.st.comps.filter((c) => c.energized).map((c) => this.engine.compFreq(this.st, c.id));
    const fMin = islandFreqs.length ? Math.min(...islandFreqs) : 0;
    const fMax = islandFreqs.length ? Math.max(...islandFreqs) : 0;
    box.innerHTML = `
      <div class="metric"><div class="m-label">仿真时刻</div><div class="m-value">${this.fmtTime(m.time)}</div></div>
      <div class="metric"><div class="m-label">系统频率</div><div class="m-value ${this.freqCls(fMin, fMax)}">${islandFreqs.length ? fMin.toFixed(2) + '–' + fMax.toFixed(2) : '—'}<small>Hz</small></div></div>
      <div class="metric"><div class="m-label">带电分区</div><div class="m-value">${m.islands}<small>个</small></div></div>
      <div class="metric"><div class="m-label">并网容量</div><div class="m-value">${Math.round(m.onlineCap)}<small>MW</small></div></div>
      <div class="metric"><div class="m-label">负荷缺口</div><div class="m-value ${m.gap > 0 ? 'gap' : ''}">${Math.round(m.gap)}<small>MW</small></div></div>
      <div class="metric"><div class="m-label">恢复进度</div><div class="m-value">${(m.restoredPct * 100).toFixed(0)}<small>%</small></div>
        <div class="bar"><div style="width:${m.restoredPct * 100}%"></div></div></div>
      <div class="metric"><div class="m-label">带电范围</div><div class="m-value">${(m.energizedPct * 100).toFixed(0)}<small>%</small></div>
        <div class="bar alt"><div style="width:${m.energizedPct * 100}%"></div></div></div>
      <div class="metric"><div class="m-label">累计风险</div><div class="m-value">${m.risk}</div></div>`;
  },

  freqCls(lo, hi) {
    if (lo < LIMITS.fUFLS || hi > LIMITS.fAlarmHigh) return 'crit';
    if (lo < LIMITS.fLow || hi > LIMITS.fHigh) return 'warn';
    return 'ok';
  },
});
// ============ 操作卡 / 步骤 / 告警 / 策略 / 图表 ============
Object.assign(App, {
  renderActionCard(live) {
    const box = document.getElementById('action-card');
    if (this.st.failed) {
      box.innerHTML = `<div class="fail-panel">
        <div class="fail-title">⚠ 恢复失败 · 现场已保留</div>
        <div class="fail-reason">${this.st.failReason}</div>
        <div class="fail-actions">
          <button class="btn primary" id="btn-rollback-fail">回退到失败前一步</button>
        </div>
        <div class="fail-hint">失败现场（频率、潮流、开关位置）已冻结，可查看后再决定回退点。</div>
      </div>`;
      document.getElementById('btn-rollback-fail').onclick = () => this.rollback(this.strategy.steps.length - 1);
      return;
    }
    if (this.st.transient) {
      const tr = this.st.transient;
      box.innerHTML = `<div class="run-panel">
        <div class="run-title">${this.spinner()} ${tr.label}</div>
        <div class="run-sub">系统正在校核动态过程，等待频率/潮流稳定…</div>
        <div class="run-events">${tr.events.slice(-3).map((x) => '<div>' + x + '</div>').join('')}</div>
      </div>`;
      return;
    }
    if (!this.selected) {
      box.innerHTML = `<div class="hint-panel">
        <div class="hint-title">选择操作对象</div>
        <ul class="hint-list">
          <li><b>电站</b>：黑启动水电/燃机，或为火电送厂用电后启动并网</li>
          <li><b>线路开关 ×</b>：对线路充电、合环，或同期并列两个带电分区</li>
          <li><b>负荷</b>：按批次投入，孤网首批宜小，频率稳定后再加大批次</li>
        </ul>
        <div class="legend">
          <span><i class="dot online"></i>并网机组</span>
          <span><i class="dot starting"></i>启动中</span>
          <span><i class="dot live"></i>带电节点</span>
          <span><i class="dot dead"></i>停电</span>
          <span><i class="dot ov"></i>过载</span>
        </div>
      </div>`;
      return;
    }
    const { kind, id } = this.selected;
    if (kind === 'plant') this.plantCard(box, id);
    else if (kind === 'line') this.lineCard(box, id);
    else this.loadCard(box, id);
  },

  plantCard(box, id) {
    const p = this.engine.plantMap[id];
    const ps = this.st.plants[id];
    const comp = this.st.comps[this.st.compOf[id]];
    const f = comp.energized ? this.engine.compFreq(this.st, this.st.compOf[id]) : null;
    const action = { type: 'start', plantId: id };
    const pc = this.engine.precheck(this.st, action);
    let btn;
    if (ps.status === 'online') btn = '<button class="btn" disabled>已并网运行</button>';
    else if (ps.status === 'starting') btn = `<button class="btn" disabled>${p.blackstart ? '黑启动中' : '启动中'} ${Math.ceil(ps.remain)}s</button>`;
    else btn = `<button class="btn primary" id="act-start">${p.blackstart ? '⚡ 执行黑启动' : '送电后启动并网'}</button>`;
    box.innerHTML = `<div class="card">
      <div class="card-head"><span class="tag tag-${p.type}">${p.type === 'hydro' ? '水电' : p.type === 'gas' ? '燃机' : '火电'}</span><b>${p.name}</b></div>
      <div class="kv"><span>额定容量</span><b>${p.cap} MW</b></div>
      <div class="kv"><span>爬坡速率</span><b>${p.ramp} MW/s</b></div>
      <div class="kv"><span>开机耗时</span><b>${p.start} s</b></div>
      <div class="kv"><span>黑启动能力</span><b>${p.blackstart ? '具备（自启动）' : '不具备（需外部电源）'}</b></div>
      <div class="kv"><span>当前状态</span><b>${this.plantStatusText(p, ps)}</b></div>
      ${f !== null ? `<div class="kv"><span>所在分区频率</span><b>${f.toFixed(2)} Hz</b></div>` : ''}
      <div class="judge ${pc.ok ? 'ok' : 'no'}">
        <b>系统校核：</b>${pc.ok ? '允许执行' : pc.errors.join('；')}
        ${pc.warnings.length ? '<div class="warn-line">⚠ ' + pc.warnings.join('；') + '</div>' : ''}
      </div>
      <div class="card-actions">${btn}</div>
    </div>`;
    const el = document.getElementById('act-start');
    if (el) el.onclick = () => this.requestAction(action, `${p.blackstart ? '黑启动' : '启动'}${p.name}`);
  },

  lineCard(box, id) {
    const l = this.engine.lineMap[id];
    const ls = this.st.lines[id];
    const action = { type: 'close', lineId: id };
    const a = this.st.comps[this.st.compOf[l.from]];
    const b = this.st.comps[this.st.compOf[l.to]];
    let state;
    if (ls.closed) state = '已合位（带电运行）';
    else if (!a.energized && !b.energized) state = '两侧均停电';
    else if (a.energized && b.energized) state = '两侧分属带电分区（待同期）';
    else state = '一侧带电（可对线路充电）';
    const pc = this.engine.precheck(this.st, action);
    const canClose = !ls.closed;
    box.innerHTML = `<div class="card">
      <div class="card-head"><span class="tag tag-line">线路</span><b>${l.name}</b></div>
      <div class="kv"><span>编号</span><b>${l.id}</b></div>
      <div class="kv"><span>额定载流量</span><b>${l.cap} MW</b></div>
      <div class="kv"><span>开关状态</span><b>${ls.closed ? '合位' : '分位'}</b></div>
      <div class="kv"><span>当前潮流</span><b class="${ls.loading > 1 ? 'crit' : ''}">${Math.abs(ls.flow).toFixed(0)} MW（${(ls.loading * 100).toFixed(0)}%）</b></div>
      <div class="kv"><span>两侧状态</span><b>${state}</b></div>
      ${a.energized && b.energized && a.id !== b.id ? `<div class="kv"><span>两侧频差</span><b class="${Math.abs(this.engine.compFreq(this.st,a.id)-this.engine.compFreq(this.st,b.id))>LIMITS.fSyncMax?'crit':'warn'}">${Math.abs(this.engine.compFreq(this.st,a.id)-this.engine.compFreq(this.st,b.id)).toFixed(2)} Hz（定值 ${LIMITS.fSyncMax}）</b></div>` : ''}
      <div class="judge ${pc.ok ? 'ok' : 'no'}">
        <b>系统校核：</b>${pc.ok ? (pc.warnings.length ? '允许（有风险）' : '允许执行') : pc.errors.join('；')}
        ${pc.warnings.length ? '<div class="warn-line">⚠ ' + pc.warnings.join('；') + '</div>' : ''}
      </div>
      <div class="card-actions">${canClose ? `<button class="btn primary" id="act-close" ${pc.ok ? '' : 'disabled'}>合闸${a.energized && b.energized && a.id !== b.id ? '并列分区' : '送电'}</button>` : '<button class="btn" disabled>已在合位</button>'}</div>
    </div>`;
    const el = document.getElementById('act-close');
    if (el) el.onclick = () => {
      const merge = a.energized && b.energized && a.id !== b.id;
      this.requestAction(action, `${merge ? '同期并列：' : '合闸送电：'}${l.name}`);
    };
  },

  loadCard(box, id) {
    const l = this.engine.loadMap[id];
    const ls = this.st.loads[id];
    const comp = this.st.comps[this.st.compOf[id]];
    const remain = l.mw - ls.restoredMw;
    const m = this.engine.metrics(this.st);
    const stats = comp.energized ? this.engine.compStats(this.st, comp.id) : null;
    const spare = stats ? stats.capOnline - stats.demand : 0;
    const presets = [10, 20, 30, 50].filter((x) => x <= remain + 0.5);
    const f = comp.energized ? this.engine.compFreq(this.st, comp.id) : null;
    box.innerHTML = `<div class="card">
      <div class="card-head"><span class="tag tag-load">负荷</span><b>${l.name}</b></div>
      <div class="kv"><span>负荷总量</span><b>${l.mw} MW</b></div>
      <div class="kv"><span>已恢复</span><b>${ls.restoredMw.toFixed(0)} MW（${Math.round(ls.restoredMw / l.mw * 100)}%）</b></div>
      <div class="kv"><span>剩余待恢复</span><b>${remain.toFixed(0)} MW</b></div>
      <div class="kv"><span>区域状态</span><b>${comp.energized ? '带电 · 分区旋转备用 ' + spare.toFixed(0) + 'MW' : '区域停电'}</b></div>
      ${f !== null ? `<div class="kv"><span>分区频率</span><b>${f.toFixed(2)} Hz</b></div>` : ''}
      ${ls.shed ? '<div class="judge no"><b>该负荷被低频减载切除</b>，需回退或重新分批投入</div>' : ''}
      <div class="kv batch-row"><span>本批投入</span>
        <div class="batch-btns">
          ${presets.length ? presets.map((x) => `<button class="btn mini" data-mw="${x}">${x}MW</button>`).join('') : '<b>已全部恢复</b>'}
        </div>
      </div>
      <div class="hint-line">提示：孤网首批负荷建议 ≤10–20MW，观察频率最低点（UFLS 定值 ${LIMITS.fUFLS}Hz）后再加大批次。</div>
    </div>`;
    box.querySelectorAll('.batch-btns button').forEach((b) => {
      b.onclick = () => {
        const mw = Number(b.dataset.mw);
        this.requestAction({ type: 'restore', items: [{ loadId: id, mw }] }, `恢复${l.name} ${mw}MW`);
      };
    });
  },
});
// ============ 步骤历史 / 告警 / 策略标签 / 对照弹窗 / 图表 ============
Object.assign(App, {
  renderSteps() {
    const box = document.getElementById('step-list');
    const steps = this.strategy.steps;
    if (!steps.length) {
      box.innerHTML = '<div class="empty-steps">尚无操作步骤。从黑启动电源开始恢复。</div>';
      return;
    }
    box.innerHTML = steps.map((s, i) => {
      const cls = s.result === 'failed' ? 'step failed' : 'step ok';
      const icon = s.result === 'failed' ? '✗' : '✓';
      const meta = s.result === 'failed'
        ? `<div class="step-fail">${s.failReason}</div>`
        : `<div class="step-meta">${this.fmtTime(s.t0)} · 风险 ${s.risk}${(s.nadir && s.nadir < 49.8) ? ' · 最低 ' + s.nadir.toFixed(2) + 'Hz' : ''}${(s.peak && s.peak > 50.2) ? ' · 最高 ' + s.peak.toFixed(2) + 'Hz' : ''}</div>`;
      return `<div class="${cls}">
        <div class="step-main"><span class="step-icon">${icon}</span>
          <span class="step-no">#${i + 1}</span>
          <span class="step-label">${s.label}</span>
          <button class="rb-btn" data-i="${i}" title="回退到该步骤之前">回退</button>
        </div>
        ${meta}
      </div>`;
    }).join('');
    box.querySelectorAll('.rb-btn').forEach((b) => {
      b.onclick = () => this.rollback(Number(b.dataset.i));
    });
  },

  renderAlarms() {
    const box = document.getElementById('alarm-list');
    const alarms = (this.st.alarms || []).slice(-8).reverse();
    const rejected = (this.strategy.rejected || []).slice(-5).reverse();
    let html = '';
    if (this.st.failed) {
      html += `<div class="alarm fail"><b>失败闭锁：</b>${this.st.failReason}</div>`;
    }
    html += alarms.map((a) => `<div class="alarm">${a}</div>`).join('');
    html += rejected.map((r) => `<div class="alarm reject"><b>驳回：</b>${r.label} — ${r.errors.join('；')}</div>`).join('');
    if (!html) html = '<div class="alarm-empty">暂无告警与保护动作记录</div>';
    box.innerHTML = html;
  },

  renderStrategyTabs() {
    const box = document.getElementById('strategy-tabs');
    const list = Store.list();
    box.innerHTML = list.map((s) => {
      const active = s.id === this.strategy.id;
      const fail = s.state && s.state.failed;
      return `<div class="tab ${active ? 'active' : ''}" data-id="${s.id}">
        <span class="tab-name">${s.name}</span>
        ${fail ? '<span class="tab-dot fail" title="该策略处于失败状态"></span>' : ''}
        <span class="tab-del" data-del="${s.id}">✕</span>
      </div>`;
    }).join('');
    box.querySelectorAll('.tab').forEach((t) => {
      t.onclick = (e) => {
        if (e.target.classList.contains('tab-del')) return;
        this.loadStrategy(t.dataset.id);
      };
    });
    box.querySelectorAll('.tab-del').forEach((d) => {
      d.onclick = (e) => this.deleteStrategy(d.dataset.del, e);
    });
  },

  renderChartStatic() {
    const canvas = document.getElementById('freq-canvas');
    let series = {};
    if (this.st.transient) {
      series = this.chartSeries;
    } else {
      // 最近一步的频率曲线（失败步也保留）
      const steps = this.strategy.steps;
      const last = steps[steps.length - 1];
      if (last && last.charts && Object.keys(last.charts).length) series = last.charts;
    }
    FreqChart.draw(canvas, series, LIMITS);
  },

  // ---------- 策略对照 ----------
  openCompare() {
    const list = Store.list();
    const tbody = document.getElementById('compare-body');
    const rows = list.map((s) => {
      const st = s.state;
      if (!st) return null;
      const m = this.engine.metrics(st);
      const failed = st.failed;
      const steps = s.steps.length;
      const restoredPct = (m.restoredPct * 100).toFixed(0) + '%';
      const gap = Math.round(m.gap);
      const time = this.fmtTime(m.time);
      const risk = m.risk;
      const reach = (m.energizedPct * 100).toFixed(0) + '%';
      const active = s.id === this.strategy.id;
      return `<tr class="${active ? 'cur' : ''}" data-load="${s.id}">
        <td><b>${s.name}</b>${active ? ' <span class="now">(当前)</span>' : ''}${failed ? ' <span class="tag-fail">失败</span>' : ''}</td>
        <td>${steps}</td>
        <td>${time}</td>
        <td class="${risk > 40 ? 'crit' : risk > 15 ? 'warn' : ''}">${risk}</td>
        <td>${restoredPct}</td>
        <td class="${gap > 0 ? '' : 'ok-text'}">${gap} MW</td>
        <td>${reach}</td>
        <td>${failed ? '✗ ' + (st.failReason || '').slice(0, 12) : (gap === 0 ? '✓ 全部恢复' : '进行中')}</td>
      </tr>`;
    }).filter(Boolean).join('');
    tbody.innerHTML = rows || '<tr><td colspan="8">暂无策略，点击顶部「新建策略」开始推演。</td></tr>';
    tbody.querySelectorAll('tr[data-load]').forEach((tr) => {
      tr.onclick = () => { this.loadStrategy(tr.dataset.load); document.getElementById('modal-compare').classList.add('hidden'); };
    });
    document.getElementById('modal-compare').classList.remove('hidden');
  },

  openHelp() {
    document.getElementById('modal-help').classList.remove('hidden');
  },

  // ---------- 提示 ----------
  toast(msg, type) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (type || '');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.className = 'toast'; }, 3200);
  },

  spinner() {
    return '<span class="spin"></span>';
  },
});

window.addEventListener('DOMContentLoaded', () => App.init());
window.addEventListener('resize', () => { if (window.App) App.renderGrid(); });
