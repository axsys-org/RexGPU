// ═══════════════════════════
// TAB SESSION MANAGER
// ═══════════════════════════
export class TabManager {
  constructor() {
    this.tabs = [];
    this.activeTabId = null;
    this.nextId = 1;
    this.tabBar = document.getElementById('tab-bar');
    this.tabAdd = document.getElementById('tab-add');
    this.tabAdd.addEventListener('click', () => this.createTab());
  }

  createTab(name) {
    const id = this.nextId++;
    const tab = {
      id,
      name: name || `Session ${id}`,
      rexSrc: '',
      messages: [],
      formState: {},
      logs: [],
      currentTree: null,
      lastSrc: '',
      rafId: null,
      active: false,
    };
    this.tabs.push(tab);
    this._renderTabBar();
    this.switchTo(id);
    return tab;
  }

  switchTo(id) {
    const prev = this.tabs.find(t => t.id === this.activeTabId);
    if (prev) {
      // Save state from current DOM
      prev.rexSrc = document.getElementById('rex-src').value;
      prev.formState = {...(window._currentForm?.state || {})};
      prev.messages = document.getElementById('messages').innerHTML;
      prev.active = false;
      // Cancel rAF — stop GPU work for inactive tab
      if (prev.rafId) { cancelAnimationFrame(prev.rafId); prev.rafId = null; }
    }

    this.activeTabId = id;
    const tab = this.tabs.find(t => t.id === id);
    if (!tab) return;
    tab.active = true;

    // Restore state to DOM
    document.getElementById('rex-src').value = tab.rexSrc;
    if (tab.messages) document.getElementById('messages').innerHTML = tab.messages;
    if (window._currentForm) window._currentForm.state = {...tab.formState};

    // Restart render loop for this tab
    window._restartRenderLoop?.();

    this._renderTabBar();
  }

  closeTab(id) {
    if (this.tabs.length <= 1) return; // Don't close last tab
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];
    if (tab.rafId) { cancelAnimationFrame(tab.rafId); tab.rafId = null; }
    this.tabs.splice(idx, 1);
    if (this.activeTabId === id) {
      const newIdx = Math.min(idx, this.tabs.length - 1);
      this.switchTo(this.tabs[newIdx].id);
    }
    this._renderTabBar();
  }

  renameTab(id, name) {
    const tab = this.tabs.find(t => t.id === id);
    if (tab) tab.name = name;
    this._renderTabBar();
  }

  getActive() {
    return this.tabs.find(t => t.id === this.activeTabId);
  }

  setRafId(id) {
    const tab = this.getActive();
    if (tab) tab.rafId = id;
  }

  _renderTabBar() {
    // Remove all tabs (keep the + button)
    const children = Array.from(this.tabBar.children);
    for (const c of children) { if (c !== this.tabAdd) c.remove(); }

    for (const tab of this.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab.id === this.activeTabId ? ' active' : '');

      const indicator = document.createElement('span');
      indicator.className = 'tab-indicator ' + (tab.active ? 'running' : 'paused');
      el.appendChild(indicator);

      const label = document.createElement('span');
      label.textContent = tab.name;
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.value = tab.name;
        input.style.cssText = 'background:var(--bg);color:var(--text);border:1px solid var(--accent);font:inherit;width:80px;padding:0 4px;';
        label.replaceWith(input);
        input.focus(); input.select();
        const done = () => { this.renameTab(tab.id, input.value || tab.name); };
        input.addEventListener('blur', done);
        input.addEventListener('keydown', e2 => { if(e2.key==='Enter') done(); });
      });
      el.appendChild(label);

      if (this.tabs.length > 1) {
        const close = document.createElement('span');
        close.className = 'tab-close';
        close.textContent = '\u00d7';
        close.addEventListener('click', (e) => { e.stopPropagation(); this.closeTab(tab.id); });
        el.appendChild(close);
      }

      el.addEventListener('click', () => this.switchTo(tab.id));
      this.tabBar.insertBefore(el, this.tabAdd);
    }
  }
}
