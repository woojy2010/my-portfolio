/* ============================================================================
 * GOLDEN MODULE 01 — EventBus
 * SONIC-VISUAL SYNC · paste verbatim into sonic-visual-sync.html <script>
 * Do not modify. See MasterBlueprintPrompt_Engine.md §2.1 / §12.
 * ========================================================================== */
class EventBus {
  constructor() { this._h = new Map(); }
  on(event, handler) {
    if (!this._h.has(event)) this._h.set(event, new Set());
    this._h.get(event).add(handler);
  }
  off(event, handler) {
    const s = this._h.get(event);
    if (s) s.delete(handler);
  }
  emit(event, payload) {
    const s = this._h.get(event);
    if (!s) return;
    for (const fn of [...s]) {
      try { fn(payload); }
      catch (e) { console.error(`[EventBus] handler for "${event}" threw:`, e); }
    }
  }
}

if (typeof module !== 'undefined') module.exports = { EventBus };
