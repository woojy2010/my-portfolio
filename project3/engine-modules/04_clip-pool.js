/* ============================================================================
 * GOLDEN MODULE 04 — ClipPool (asset registry + auto CV analysis)
 * SONIC-VISUAL SYNC · paste verbatim into sonic-visual-sync.html <script>
 * Blueprint §2.3 + §5.1 + §5.2. Requires: EventBus.
 * ========================================================================== */
class ClipPool {
  constructor(bus) {
    this.bus = bus;
    this._clips = new Map();
    this._elPool = [];
    this._idSeq = 0;
  }

  async addFile(file) {
    const id = 'clip' + (++this._idSeq);
    const objectUrl = URL.createObjectURL(file);
    const clip = {
      id, name: file.name, file, objectUrl,
      duration: 0, tags: [],
      auto: { motion: 0.5, brightness: 0.5, saturation: 0.5 },
      thumbnail: null,
    };
    this._clips.set(id, clip);
    this.bus.emit('clip:added', clip);
    try {
      await this._analyzeClip(clip);
    } catch (e) {
      console.warn(`[ClipPool] analysis failed for ${file.name}; using neutral defaults`, e);
    }
    this.bus.emit('clip:analyzed', clip);
    return clip;
  }

  remove(clipId) {
    const clip = this._clips.get(clipId);
    if (!clip) return;
    this._clips.delete(clipId);
    URL.revokeObjectURL(clip.objectUrl);
    this.bus.emit('clip:removed', clip);
  }

  setTags(clipId, tags) {
    const clip = this._clips.get(clipId);
    if (!clip) return;
    clip.tags = tags.slice(0, 3);
    this.bus.emit('clip:analyzed', clip);   // re-triggers timeline recompile
  }

  get(clipId) { return this._clips.get(clipId); }
  all() { return [...this._clips.values()]; }

  acquireElement(clipId) {
    const clip = this._clips.get(clipId);
    if (!clip) return null;
    const el = this._elPool.pop() || ClipPool._makeVideo();
    el.src = clip.objectUrl;
    return el;
  }
  releaseElement(el) {
    el.pause();
    el.removeAttribute('src');
    el.load();
    if (this._elPool.length < 4) this._elPool.push(el);
  }

  static _makeVideo() {
    const el = document.createElement('video');
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    return el;
  }

  // ---- §5.2: seek 5 timestamps, sample 64×36, derive auto features ---------
  async _analyzeClip(clip) {
    const video = ClipPool._makeVideo();
    video.src = clip.objectUrl;
    await ClipPool._once(video, 'loadedmetadata', 5000);
    clip.duration = video.duration;
    if (!isFinite(clip.duration) || clip.duration <= 0)
      throw new Error('no finite duration');

    const W = 64, H = 36;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true });

    let sumB = 0, sumS = 0, sumDiff = 0, prev = null, samples = 0, diffs = 0;
    for (let s = 0; s < 5; s++) {
      const t = clip.duration * (0.1 + 0.2 * s);
      video.currentTime = t;
      await ClipPool._once(video, 'seeked', 2000);
      cx.drawImage(video, 0, 0, W, H);
      const px = cx.getImageData(0, 0, W, H).data;
      let b = 0, sat = 0;
      const luma = new Float32Array(W * H);
      for (let i = 0, p = 0; i < px.length; i += 4, p++) {
        const r = px[i], g = px[i + 1], bl = px[i + 2];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        luma[p] = l;
        b += l / 255;
        const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
        sat += (mx - mn) / Math.max(mx, 1);
      }
      sumB += b / (W * H);
      sumS += sat / (W * H);
      if (prev) {
        let d = 0;
        for (let p = 0; p < luma.length; p++) d += Math.abs(luma[p] - prev[p]);
        sumDiff += d / luma.length;
        diffs++;
      }
      prev = luma;
      samples++;

      if (s === 2) {   // §5.1 thumbnail from t ≈ duration/2
        const th = document.createElement('canvas');
        th.width = 160; th.height = 90;
        th.getContext('2d').drawImage(video, 0, 0, 160, 90);
        clip.thumbnail = th.toDataURL('image/jpeg', 0.7);
      }
    }
    clip.auto = {
      brightness: sumB / samples,
      saturation: sumS / samples,
      motion: Math.min(1, Math.max(0, (sumDiff / Math.max(diffs, 1)) / 30)),
    };
    video.removeAttribute('src');
    video.load();
  }

  static _once(el, event, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const to = setTimeout(() => {
        if (done) return;
        done = true;
        el.removeEventListener(event, ok);
        reject(new Error(`timeout waiting for "${event}"`));
      }, timeoutMs);
      const ok = () => {
        if (done) return;
        done = true;
        clearTimeout(to);
        resolve();
      };
      el.addEventListener(event, ok, { once: true });
    });
  }
}

if (typeof module !== 'undefined') module.exports = { ClipPool };
