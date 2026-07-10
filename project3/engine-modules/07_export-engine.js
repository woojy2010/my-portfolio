/* ============================================================================
 * GOLDEN MODULE 07 — ExportEngine (deterministic frame-by-frame masterpiece)
 * SONIC-VISUAL SYNC · paste verbatim into sonic-visual-sync.html <script>
 * Blueprint §8. Primary: FFmpeg.wasm → MP4. Fallback: MediaRecorder → WebM.
 * Requires: AudioEngine, ClipPool, VisualEngine (class), TheBrain, EventBus.
 * ========================================================================== */
class ExportEngine {
  constructor(audioEngine, clipPool, visualEngine, brain, bus) {
    this.audio = audioEngine;
    this.pool = clipPool;
    this.liveVE = visualEngine;   // preview engine (fallback path renders here)
    this.brain = brain;
    this.bus = bus;
    this._cancelled = false;
    this._ffmpeg = null;
  }

  cancel() { this._cancelled = true; }

  async export(options = {}) {
    const opts = { width: 1920, height: 1080, fps: 30, format: 'mp4', ...options };
    this._cancelled = false;
    try {
      const timeline = this.brain.compileTimeline();      // seeded → reproducible
      if (!timeline.cuts.length) throw new Error('Nothing to export: empty timeline');
      const segments = ExportEngine.buildSegments(timeline.cuts, this.audio.duration);
      let ok = false;
      if (opts.format === 'mp4') ok = await this._tryFfmpegPath(opts, segments);
      if (!ok) await this._fallbackMediaRecorder(opts, timeline);
    } catch (e) {
      if (!this._cancelled) {
        console.error('[ExportEngine]', e);
        this.bus.emit('export:error', { message: e.message });
      }
    }
  }

  /** Pure: cut list → segments [{start, end, clipId, prevClipId, type, dur}]. */
  static buildSegments(cuts, duration) {
    const segs = [];
    for (let i = 0; i < cuts.length; i++) {
      const c = cuts[i];
      segs.push({
        start: c.time,
        end: i + 1 < cuts.length ? cuts[i + 1].time : duration,
        clipId: c.clipId,
        prevClipId: i > 0 ? cuts[i - 1].clipId : null,
        type: c.transitionType,
        dur: c.transitionDuration,
      });
    }
    return segs;
  }

  // ---- §8.2 + §8.3 Primary path: offline render → FFmpeg.wasm MP4 -----------
  async _tryFfmpegPath(opts, segments) {
    const ffmpeg = await this._loadFfmpeg();
    if (!ffmpeg) return false;

    const canvas = document.createElement('canvas');
    canvas.width = opts.width; canvas.height = opts.height;
    const ve = new VisualEngine(canvas, this.pool);
    ve.resize(opts.width, opts.height);

    const analysis = this.audio.analysis;
    const totalFrames = Math.ceil(this.audio.duration * opts.fps);
    const num = (i) => String(i).padStart(6, '0');

    for (let i = 0; i < totalFrames; i++) {
      if (this._cancelled) { this._cleanupFrames(ffmpeg, i); return true; }
      const t = i / opts.fps;
      const seg = segments.reduce((acc, s) => (t >= s.start ? s : acc), segments[0]);
      const inTransition = seg.prevClipId && seg.type !== null &&
                           t < seg.start + seg.dur && seg.prevClipId !== seg.clipId;

      if (inTransition) {
        const prev = segments[segments.indexOf(seg) - 1];
        await ve.offlineSet('active', seg.prevClipId, t - prev.start);
        await ve.offlineSet('standby', seg.clipId, t - seg.start);
        ve.renderFrame(t, analysis.featuresAt(t),
          { type: seg.type, progress: (t - seg.start) / seg.dur });
      } else {
        await ve.offlineSet('active', seg.clipId, t - seg.start);
        ve.renderFrame(t, analysis.featuresAt(t), { type: 0, progress: 0 });
      }

      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
      ffmpeg.FS('writeFile', `frame${num(i)}.jpg`,
        new Uint8Array(await blob.arrayBuffer()));

      if (i % 10 === 0) {
        this.bus.emit('export:progress', { phase: 'render', ratio: i / totalFrames });
        await new Promise(r => setTimeout(r, 0));   // keep UI alive
      }
    }

    this.bus.emit('export:progress', { phase: 'encode', ratio: 0 });
    ffmpeg.FS('writeFile', 'audio.dat', new Uint8Array(this.audio.fileBytes));
    ffmpeg.setProgress(({ ratio }) =>
      this.bus.emit('export:progress', { phase: 'encode', ratio: ratio || 0 }));
    await ffmpeg.run(
      '-framerate', String(opts.fps), '-i', 'frame%06d.jpg',
      '-i', 'audio.dat',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
      '-shortest', 'out.mp4');

    const data = ffmpeg.FS('readFile', 'out.mp4');
    this._cleanupFrames(ffmpeg, totalFrames);
    try { ffmpeg.FS('unlink', 'audio.dat'); ffmpeg.FS('unlink', 'out.mp4'); } catch (e) {}
    const blobUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
    this.bus.emit('export:done',
      { blobUrl, mime: 'video/mp4', fileName: 'sonic-visual-sync_masterpiece.mp4' });
    return true;
  }

  _cleanupFrames(ffmpeg, upTo) {
    for (let i = 0; i < upTo; i++) {
      try { ffmpeg.FS('unlink', `frame${String(i).padStart(6, '0')}.jpg`); }
      catch (e) { /* already gone */ }
    }
  }

  async _loadFfmpeg() {
    if (this._ffmpeg) return this._ffmpeg;
    try {
      if (!window.FFmpeg) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js';
          s.onload = resolve;
          s.onerror = () => reject(new Error('FFmpeg.wasm script failed to load'));
          document.head.appendChild(s);
        });
      }
      // Single-thread core: works without cross-origin isolation.
      const ffmpeg = window.FFmpeg.createFFmpeg({
        log: false,
        corePath: 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js',
        mainName: 'main',
      });
      await ffmpeg.load();
      this._ffmpeg = ffmpeg;
      console.info('[ExportEngine] FFmpeg.wasm ready (single-thread core)');
      return ffmpeg;
    } catch (e) {
      console.warn('[ExportEngine] FFmpeg.wasm unavailable — will use fallback:', e.message);
      return null;
    }
  }

  // ---- §8.4 Fallback: paced real-time render → MediaRecorder WebM -----------
  async _fallbackMediaRecorder(opts, timeline) {
    const canvas = this.liveVE.canvas;
    const ctx = this.audio.ctx;
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    src.buffer = this.audio.buffer;
    src.connect(dest);

    const stream = canvas.captureStream(opts.fps);
    const audioTrack = dest.stream.getAudioTracks()[0];
    if (audioTrack) stream.addTrack(audioTrack);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const cuts = timeline.cuts;
    const duration = this.audio.duration;
    const analysis = this.audio.analysis;
    const ve = this.liveVE;

    ve.showClip(cuts[0].clipId);
    ve.setPlaying(true);
    rec.start(500);
    const t0 = ctx.currentTime;
    src.start();
    let idx = 1;

    await new Promise((resolve) => {
      const step = () => {
        const t = ctx.currentTime - t0;
        if (this._cancelled || t >= duration) return resolve();
        if (idx < cuts.length && t >= cuts[idx].time - this.brain.PRELOAD_LEAD)
          ve.preload(cuts[idx].clipId);
        if (idx < cuts.length && t >= cuts[idx].time) {
          const c = cuts[idx];
          ve.transitionTo(c.clipId, c.transitionType ?? 0, c.transitionDuration, c.time);
          idx++;
        }
        ve.renderFrame(t, analysis.featuresAt(t));
        this.bus.emit('export:progress', { phase: 'render', ratio: t / duration });
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    try { src.stop(); } catch (e) {}
    ve.setPlaying(false);
    await new Promise((resolve) => { rec.onstop = resolve; rec.stop(); });
    if (this._cancelled) return;
    const blobUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    this.bus.emit('export:done', {
      blobUrl, mime: 'video/webm', fallback: true,
      fileName: 'sonic-visual-sync_masterpiece.webm',
      note: 'WebM (fallback encoder)',
    });
  }
}

if (typeof module !== 'undefined') module.exports = { ExportEngine };
