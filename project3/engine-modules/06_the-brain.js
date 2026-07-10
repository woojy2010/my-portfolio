/* ============================================================================
 * GOLDEN MODULE 06 — TheBrain (fusion & matching logic)
 * SONIC-VISUAL SYNC · paste verbatim into sonic-visual-sync.html <script>
 * Blueprint §3.3 + §6 exactly: affinity table, scoring function, deterministic
 * timeline compiler (seeded PRNG 42), live conductor. Priority: Manual > Auto.
 * Requires: AudioEngine, ClipPool, EventBus.
 * ========================================================================== */

// §3.3 Marker→Tag affinity matrix — hardcoded, do not tune.
const SVS_AFFINITY = {
  '#Drop':       { '#Fast': 1.0, '#Energetic': 1.0, '#Bright': 0.6, '#Calm': -0.8, '#Slow': -0.8 },
  '#Build':      { '#Energetic': 1.0, '#Abstract': 0.6, '#Fast': 0.6, '#Calm': -0.8 },
  '#Break':      { '#Calm': 1.0, '#Deep': 1.0, '#Dark': 0.6, '#Slow': 0.6, '#Fast': -0.8 },
  '#Transition': { '#Abstract': 1.0, '#Deep': 0.6 },
  '#Calm':       { '#Calm': 1.0, '#Slow': 1.0, '#Deep': 0.6, '#Dark': 0.6, '#Fast': -0.8, '#Energetic': -0.8 },
  '#Impact':     { '#Fast': 1.0, '#Bright': 1.0, '#Energetic': 0.6, '#Slow': -0.8 },
};

// §5.4 transition assignment per marker tag (type resolved at compile time).
const SVS_TRANSITION_RULES = {
  '#Drop':       { dur: 0.12, type: (energy) => energy < 0.8 ? 2 : 3 },
  '#Impact':     { dur: 0.12, type: (energy) => energy < 0.8 ? 2 : 3 },
  '#Break':      { dur: 1.2,  type: () => 0 },
  '#Calm':       { dur: 1.2,  type: () => 0 },
  '#Transition': { dur: 0.35, type: () => 1 },
  '#Build':      { dur: 0.35, type: () => 1 },
};

// Deterministic PRNG for export reproducibility (§6.2).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class TheBrain {
  constructor(audioEngine, clipPool, bus) {
    this.audio = audioEngine;
    this.pool = clipPool;
    this.bus = bus;
    this.PRELOAD_LEAD = 1.5;
    this._timeline = null;
    this._live = false;
    this._cutIdx = 0;
    this._preloaded = false;
    this._recompileTimer = null;

    const recompile = () => this._debouncedRecompile();
    for (const ev of ['marker:added', 'marker:removed', 'marker:updated',
                      'clip:analyzed', 'clip:removed'])
      bus.on(ev, recompile);
    bus.on('transport:tick', (p) => { if (this._live) this._onTick(p.time); });
    bus.on('transport:seek', (p) => { if (this._live) this._onSeek(p.time); });
  }

  get mode() { return 'hybrid'; }
  get timeline() { return this._timeline; }

  // ---- §6.2 The scoring function (pure) ------------------------------------
  scoreClip(clip, state, history = [], rng = Math.random) {
    let tagScore = 0;
    if (state.markerTag) {
      const row = SVS_AFFINITY[state.markerTag] || {};
      for (const t of clip.tags) tagScore += row[t] || 0;
    }
    const fBright = 1 - Math.abs(clip.auto.brightness - state.bright);
    const fMotion = 1 - Math.abs(clip.auto.motion - state.energy);
    const fSat    = 1 - Math.abs(clip.auto.saturation - (0.3 + 0.7 * state.energy));
    const featureScore = 0.45 * fBright + 0.40 * fMotion + 0.15 * fSat;

    let novelty = 0;
    if (history.length && history[history.length - 1] === clip.id) novelty = -1.5;
    else if (history.slice(-3, -1).includes(clip.id)) novelty = -0.6;

    return 1.2 * tagScore + 1.0 * featureScore + novelty + 0.05 * rng();
  }

  _pickClip(state, history, rng) {
    let best = null, bestScore = -Infinity;
    for (const clip of this.pool.all()) {
      const s = this.scoreClip(clip, state, history, rng);
      if (s > bestScore) { bestScore = s; best = clip; }
    }
    return best;
  }

  // ---- §6.3 + §6.4 Deterministic timeline compiler ---------------------------
  compileTimeline() {
    const analysis = this.audio.analysis;
    const clips = this.pool.all();
    if (!analysis || clips.length === 0) { this._timeline = { cuts: [] }; return this._timeline; }

    const rng = mulberry32(42);
    const duration = analysis.duration;
    const markers = this.audio.markers.filter(m => m.time >= 0 && m.time < duration);
    const MIN_SHOT = 1.0, MARKER_GUARD = 1.0, SNAP = 0.08;

    // Auto cut times between marker boundaries (§6.3).
    const bounds = [0, ...markers.map(m => m.time), duration];
    const autoTimes = [];
    for (let s = 0; s < bounds.length - 1; s++) {
      const a = bounds[s], b = bounds[s + 1];
      let lastCut = a, beatsSince = 0;
      for (const bt of analysis.beatTimes) {
        if (bt <= a || bt >= b) continue;
        beatsSince++;
        const energy = analysis.featuresAt(bt).energy;
        const N = energy > 0.6 ? 4 : 8;
        if (beatsSince < N) continue;
        // snap to nearest onset within ±80 ms
        let t = bt, bestD = SNAP;
        for (const o of analysis.onsets) {
          const d = Math.abs(o.time - bt);
          if (d < bestD) { bestD = d; t = o.time; }
        }
        const nearMarker = markers.some(m => Math.abs(m.time - t) < MARKER_GUARD);
        if (nearMarker || t - lastCut < MIN_SHOT || b - t < MIN_SHOT) continue;
        autoTimes.push(t);
        lastCut = t;
        beatsSince = 0;
      }
    }

    // Merge: opening cut + manual (absolute) + auto, sorted.
    const events = [
      { time: 0, markerTag: null, reason: 'auto:start' },
      ...markers.map(m => ({ time: m.time, markerTag: m.tag, reason: 'manual:' + m.tag })),
      ...autoTimes.map(t => ({ time: t, markerTag: null, reason: 'auto:beat' })),
    ].sort((x, y) => x.time - y.time);

    const cuts = [];
    const history = [];
    let autoAlt = 0;
    for (const ev of events) {
      const f = analysis.featuresAt(ev.time);
      const state = { bright: f.bright, energy: f.energy, markerTag: ev.markerTag };
      const clip = this._pickClip(state, history, rng);
      if (!clip) continue;
      let transitionType = 0, transitionDuration = 0.35;
      if (ev.time === 0) {
        transitionType = null; transitionDuration = 0;        // opening: hard show
      } else if (ev.markerTag) {
        const rule = SVS_TRANSITION_RULES[ev.markerTag];
        transitionType = rule.type(f.energy);
        transitionDuration = rule.dur;
      } else {
        transitionType = (autoAlt++ % 2);                     // alternate 0/1
        transitionDuration = 0.35;
      }
      cuts.push({ time: ev.time, clipId: clip.id, transitionType,
                  transitionDuration, reason: ev.reason });
      history.push(clip.id);
    }

    this._timeline = { cuts };
    console.info(`[TheBrain] compiled timeline: ${cuts.length} cuts ` +
      `(${markers.length} manual, ${cuts.length - markers.length - 1} auto)`);
    return this._timeline;
  }

  _debouncedRecompile() {
    clearTimeout(this._recompileTimer);
    this._recompileTimer = setTimeout(() => {
      this.compileTimeline();
      if (this._live) this._resync(this.audio.currentTime);
    }, 150);
  }

  // ---- §6.5 Live conductor ----------------------------------------------------
  startLive() {
    if (!this._timeline) this.compileTimeline();
    this._live = true;
    this._resync(this.audio.currentTime);
  }
  stopLive() { this._live = false; }

  _resync(time) {
    const cuts = this._timeline ? this._timeline.cuts : [];
    let seg = 0;
    for (let i = 0; i < cuts.length; i++) if (cuts[i].time <= time) seg = i;
    if (cuts.length) this.bus.emit('brain:show', { clipId: cuts[seg].clipId });
    this._cutIdx = seg + 1;
    this._preloaded = false;
  }

  _onTick(time) {
    const cuts = this._timeline ? this._timeline.cuts : [];
    if (this._cutIdx >= cuts.length) return;
    const next = cuts[this._cutIdx];
    if (!this._preloaded && time >= next.time - this.PRELOAD_LEAD) {
      this.bus.emit('brain:preload', { clipId: next.clipId });
      this._preloaded = true;
    }
    if (time >= next.time) {
      this.bus.emit('brain:cut', {
        time: next.time, clipId: next.clipId,
        transitionType: next.transitionType,
        transitionDuration: next.transitionDuration,
        reason: next.reason,
      });
      this._cutIdx++;
      this._preloaded = false;
    }
  }

  _onSeek(time) { this._resync(time); }
}

if (typeof module !== 'undefined')
  module.exports = { TheBrain, SVS_AFFINITY, SVS_TRANSITION_RULES, mulberry32 };
