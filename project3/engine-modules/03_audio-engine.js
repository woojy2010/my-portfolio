/* ============================================================================
 * GOLDEN MODULE 03 — AudioEngine (decode, playback clock, markers)
 * SONIC-VISUAL SYNC · paste verbatim into sonic-visual-sync.html <script>
 * Blueprint §2.2 + §7.2. The clock here is the SINGLE source of truth for
 * every visual decision. Requires: SonicDSP (module 02), EventBus (module 01).
 * ========================================================================== */
class AudioEngine {
  constructor(bus) {
    this.bus = bus;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.buffer = null;          // decoded AudioBuffer
    this.fileBytes = null;       // original file bytes (for FFmpeg mux)
    this.fileName = '';
    this._analysis = null;
    this._markers = [];
    this._src = null;            // active AudioBufferSourceNode
    this._playing = false;
    this._pausedAt = 0;
    this._startCtxTime = 0;
    this._startOffset = 0;
    this._idSeq = 0;
  }

  async loadFile(file) {
    const bytes = await file.arrayBuffer();
    this.fileBytes = bytes.slice(0);          // decodeAudioData detaches its copy
    this.fileName = file.name;
    this.pause();
    this.buffer = await this.ctx.decodeAudioData(bytes);
    this._pausedAt = 0;
    this._analysis = null;
    this.bus.emit('audio:loaded', { name: file.name, duration: this.buffer.duration });
  }

  async analyze(onProgress) {
    const b = this.buffer;
    if (!b) throw new Error('AudioEngine.analyze: no audio loaded');
    const mono = new Float32Array(b.length);
    const L = b.getChannelData(0);
    const R = b.numberOfChannels > 1 ? b.getChannelData(1) : L;
    for (let i = 0; i < b.length; i++) mono[i] = (L[i] + R[i]) / 2;
    // Chunk the pure analysis behind rAF-sized yields so the UI stays alive.
    this._analysis = await new Promise((resolve, reject) => {
      setTimeout(() => {
        try { resolve(SonicDSP.analyze(mono, b.sampleRate, onProgress)); }
        catch (e) { reject(e); }
      }, 0);
    });
    console.info(`[AudioEngine] analyzed: ${this._analysis.bpm} BPM, ` +
      `${this._analysis.onsets.length} onsets, key ${this._analysis.key}`);
    this.bus.emit('audio:analyzed', this._analysis);
    return this._analysis;
  }

  play(fromTime = null) {
    if (!this.buffer) return;
    if (this._playing) this.pause();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const offset = fromTime !== null ? fromTime : this._pausedAt;
    this._src = this.ctx.createBufferSource();
    this._src.buffer = this.buffer;
    this._src.connect(this.ctx.destination);
    this._src.onended = () => {
      if (this._playing && this.currentTime >= this.duration - 0.05) {
        this._playing = false;
        this._pausedAt = 0;
        this.bus.emit('transport:pause', { time: 0, ended: true });
      }
    };
    this._src.start(0, offset);
    this._startCtxTime = this.ctx.currentTime;   // §7.2 — the clock anchor
    this._startOffset = offset;
    this._playing = true;
    this.bus.emit('transport:play', { time: offset });
  }

  pause() {
    if (!this._playing) return;
    this._pausedAt = this.currentTime;
    this._playing = false;
    if (this._src) {
      this._src.onended = null;
      try { this._src.stop(); } catch (e) { /* already stopped */ }
      this._src = null;
    }
    this.bus.emit('transport:pause', { time: this._pausedAt });
  }

  seek(time) {
    const t = Math.min(Math.max(0, time), this.duration);
    const wasPlaying = this._playing;
    if (wasPlaying) this.pause();
    this._pausedAt = t;
    this.bus.emit('transport:seek', { time: t });
    if (wasPlaying) this.play(t);
  }

  get playing() { return this._playing; }
  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get analysis() { return this._analysis; }

  get currentTime() {
    return this._playing
      ? Math.min(this._startOffset + (this.ctx.currentTime - this._startCtxTime), this.duration)
      : this._pausedAt;
  }

  // ---- Markers (Blueprint §3.1) -------------------------------------------
  addMarker(time, tag) {
    const m = { id: 'mk' + (++this._idSeq), time, tag };
    this._markers.push(m);
    this._markers.sort((a, b) => a.time - b.time);
    this.bus.emit('marker:added', m);
    return m;
  }
  removeMarker(id) {
    const i = this._markers.findIndex(m => m.id === id);
    if (i < 0) return;
    const [m] = this._markers.splice(i, 1);
    this.bus.emit('marker:removed', m);
  }
  updateMarker(id, patch) {
    const m = this._markers.find(x => x.id === id);
    if (!m) return;
    if (patch.time !== undefined) m.time = patch.time;
    if (patch.tag !== undefined) m.tag = patch.tag;
    this._markers.sort((a, b) => a.time - b.time);
    this.bus.emit('marker:updated', m);
  }
  get markers() { return [...this._markers]; }
}

if (typeof module !== 'undefined') module.exports = { AudioEngine };
