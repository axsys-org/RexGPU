// ═══════════════════════════════════════════════════════════════════
// PLAN BRIDGE — Phase A (localStorage stub)
// Persistence, undo/redo, event log without PLAN runtime.
// Replaces with real PLAN when available.
// ═══════════════════════════════════════════════════════════════════

const MAX_HISTORY = 100;
const MAX_EVENTS = 2000;
const STORAGE_KEY_TREE = 'rpe-tree-history';
const STORAGE_KEY_EVENTS = 'rpe-event-log';
const STORAGE_KEY_FORM = 'rpe-form-state';

export class PLANBridge {
  constructor(log) {
    this.log = log || (() => {});

    // ── Tree history (structure undo/redo) ──
    this._treeHistory = [];
    this._treeIndex = -1;

    // ── Event log (value-level changes) ──
    this._events = [];

    // ── Form state snapshot ──
    this._formSnapshot = {};

    // Load from localStorage
    this._load();
  }

  // ════════════════════════════════════════════════════════════════
  // TREE HISTORY — structure-level undo/redo
  // ════════════════════════════════════════════════════════════════

  pinTree(source) {
    // Deduplicate: don't push if same as current
    if (this._treeIndex >= 0 && this._treeHistory[this._treeIndex]?.source === source) return;

    // Truncate any redo history after current position
    this._treeHistory = this._treeHistory.slice(0, this._treeIndex + 1);

    // Push new entry
    this._treeHistory.push({
      source,
      timestamp: Date.now(),
      formState: { ...this._formSnapshot },
    });
    this._treeIndex = this._treeHistory.length - 1;

    // Cap history
    if (this._treeHistory.length > MAX_HISTORY) {
      this._treeHistory = this._treeHistory.slice(-MAX_HISTORY);
      this._treeIndex = this._treeHistory.length - 1;
    }

    this._saveTree();
  }

  undoTree() {
    if (this._treeIndex <= 0) return null;
    this._treeIndex--;
    this._saveTree();
    const entry = this._treeHistory[this._treeIndex];
    this.log(`plan: undo tree → ${this._treeIndex}/${this._treeHistory.length - 1}`, 'ok');
    return entry;
  }

  redoTree() {
    if (this._treeIndex >= this._treeHistory.length - 1) return null;
    this._treeIndex++;
    this._saveTree();
    const entry = this._treeHistory[this._treeIndex];
    this.log(`plan: redo tree → ${this._treeIndex}/${this._treeHistory.length - 1}`, 'ok');
    return entry;
  }

  getCurrentTree() {
    if (this._treeIndex >= 0 && this._treeIndex < this._treeHistory.length) {
      return this._treeHistory[this._treeIndex];
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════
  // EVENT LOG — value-level changes
  // ════════════════════════════════════════════════════════════════

  logEvent(event) {
    this._events.push({
      ...event,
      timestamp: event.timestamp || Date.now(),
    });

    if (this._events.length > MAX_EVENTS) {
      this._events = this._events.slice(-MAX_EVENTS);
    }

    // Periodic save (every 50 events)
    if (this._events.length % 50 === 0) this._saveEvents();
  }

  // Get events since a timestamp (for replay)
  eventsSince(timestamp) {
    return this._events.filter(e => e.timestamp >= timestamp);
  }

  // ════════════════════════════════════════════════════════════════
  // FORM STATE — snapshot for undo restore
  // ════════════════════════════════════════════════════════════════

  snapshotForm(formState) {
    this._formSnapshot = { ...formState };
  }

  restoreForm(entry) {
    if (entry && entry.formState) return { ...entry.formState };
    return {};
  }

  // ════════════════════════════════════════════════════════════════
  // VALUE UNDO — undo individual field changes
  // ════════════════════════════════════════════════════════════════

  undoValue(fieldName) {
    // Walk events backwards to find previous value for this field
    for (let i = this._events.length - 1; i >= 0; i--) {
      const e = this._events[i];
      if (e.path === fieldName && e.source === 'form-field' && e.prev !== undefined) {
        return { field: fieldName, value: e.prev };
      }
    }
    return null;
  }

  // Log a form field change with previous value
  logFormChange(name, value, prev) {
    this.logEvent({
      source: 'form-field',
      shrub: 'form',
      path: name,
      value,
      prev,
    });
  }

  // ════════════════════════════════════════════════════════════════
  // ASSET RESOLUTION — shrine:// stub
  // ════════════════════════════════════════════════════════════════

  resolveAsset(shrinePath) {
    // Phase A: shrine:// not yet supported
    // Phase B: resolve via PLAN server IPC
    // Phase C: resolve via native PLAN runtime
    return null;
  }

  // ════════════════════════════════════════════════════════════════
  // PERSISTENCE — localStorage
  // ════════════════════════════════════════════════════════════════

  _load() {
    try {
      const tree = localStorage.getItem(STORAGE_KEY_TREE);
      if (tree) {
        const parsed = JSON.parse(tree);
        this._treeHistory = parsed.history || [];
        this._treeIndex = parsed.index ?? -1;
      }
      const events = localStorage.getItem(STORAGE_KEY_EVENTS);
      if (events) this._events = JSON.parse(events);
      const form = localStorage.getItem(STORAGE_KEY_FORM);
      if (form) this._formSnapshot = JSON.parse(form);
    } catch (e) {
      // Corrupted storage — start fresh
      this._treeHistory = [];
      this._treeIndex = -1;
      this._events = [];
    }
  }

  _saveTree() {
    try {
      localStorage.setItem(STORAGE_KEY_TREE, JSON.stringify({
        history: this._treeHistory,
        index: this._treeIndex,
      }));
    } catch (e) {
      // localStorage full — trim history
      this._treeHistory = this._treeHistory.slice(-20);
      this._treeIndex = Math.min(this._treeIndex, this._treeHistory.length - 1);
    }
  }

  _saveEvents() {
    try {
      localStorage.setItem(STORAGE_KEY_EVENTS, JSON.stringify(this._events));
    } catch (e) {
      this._events = this._events.slice(-500);
    }
  }

  saveForm() {
    try {
      localStorage.setItem(STORAGE_KEY_FORM, JSON.stringify(this._formSnapshot));
    } catch (e) { /* ignore */ }
  }

  // ════════════════════════════════════════════════════════════════
  // DIAGNOSTICS
  // ════════════════════════════════════════════════════════════════

  getStats() {
    return {
      treeHistory: this._treeHistory.length,
      treeIndex: this._treeIndex,
      events: this._events.length,
      canUndo: this._treeIndex > 0,
      canRedo: this._treeIndex < this._treeHistory.length - 1,
    };
  }

  clear() {
    this._treeHistory = [];
    this._treeIndex = -1;
    this._events = [];
    this._formSnapshot = {};
    localStorage.removeItem(STORAGE_KEY_TREE);
    localStorage.removeItem(STORAGE_KEY_EVENTS);
    localStorage.removeItem(STORAGE_KEY_FORM);
  }
}
