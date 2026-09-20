'use strict';

// 多策略持久化：localStorage 保存所有策略快照（含完整步骤现场），重启自动接续
const Store = {
  KEY: 'blackstart_strategies_v1',
  ACTIVE_KEY: 'blackstart_active_v1',

  loadAll() {
    try {
      const raw = localStorage.getItem(this.KEY);
      const map = raw ? JSON.parse(raw) : {};
      return map || {};
    } catch (e) {
      return {};
    }
  },

  saveAll(map) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(map));
    } catch (e) {
      console.warn('策略保存失败', e);
    }
  },

  list() {
    const map = this.loadAll();
    return Object.values(map).sort((a, b) => b.createdAt - a.createdAt);
  },

  get(id) {
    return this.loadAll()[id] || null;
  },

  activeId() {
    return localStorage.getItem(this.ACTIVE_KEY);
  },

  setActive(id) {
    if (id) localStorage.setItem(this.ACTIVE_KEY, id);
    else localStorage.removeItem(this.ACTIVE_KEY);
  },

  upsert(strategy) {
    const map = this.loadAll();
    strategy.updatedAt = Date.now();
    map[strategy.id] = strategy;
    this.saveAll(map);
    this.setActive(strategy.id);
  },

  remove(id) {
    const map = this.loadAll();
    delete map[id];
    this.saveAll(map);
    if (this.activeId() === id) this.setActive(null);
  },

  newStrategy(name) {
    const id = 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return {
      id,
      name: name || ('策略 ' + new Date().toLocaleString('zh-CN', { hour12: false })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      state: null,        // Engine state
      steps: [],          // [{action,label,before,after,risk,result,time}]
      rejected: [],       // 被系统驳回的尝试
    };
  },

  // 从已有策略复制（策略对照：换一种恢复顺序）
  branch(id, name) {
    const src = this.get(id);
    const copy = this.newStrategy(name || (src.name + '（对照）'));
    copy.state = src.state ? JSON.parse(JSON.stringify(src.state)) : null;
    copy.steps = JSON.parse(JSON.stringify(src.steps));
    return copy;
  },
};

if (typeof window !== 'undefined') window.Store = Store;
