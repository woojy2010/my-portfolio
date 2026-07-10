/* ============================================================================
 * GOLDEN MODULE 05 — VisualEngine (WebGL renderer, double buffer, transitions)
 * SONIC-VISUAL SYNC · paste verbatim into sonic-visual-sync.html <script>
 * Blueprint §2.4 + §5.3 + §5.4. Requires: ClipPool.
 * The shader below is the authoritative version (adds uScaleA/uScaleB cover-fit;
 * fixes the illegal ternary-sampler construct). Do not re-derive it.
 * ========================================================================== */
const SVS_VERT = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const SVS_FRAG = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTexA;   // outgoing clip
uniform sampler2D uTexB;   // incoming clip
uniform float uProgress;   // 0..1 (0 = all A, 1 = all B)
uniform float uEnergy;     // live audio energy 0..1
uniform float uBeat;       // 1.0 on onset frame, decays to 0
uniform int   uType;       // 0 crossfade, 1 luma-wipe, 2 zoom-punch, 3 glitch
uniform vec2  uScaleA;     // contain-fit scale for A
uniform vec2  uScaleB;     // contain-fit scale for B

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 fit(vec2 uv, vec2 s) { return (uv - 0.5) * s + 0.5; }
// contain-fit sample: whole frame stays inside the viewport; anything mapped
// outside the video's [0,1] texture range becomes black letterbox/pillarbox.
vec4 samp(sampler2D tex, vec2 uv, vec2 s) {
  vec2 p = fit(uv, s);
  vec2 inside = step(0.0, p) * step(p, vec2(1.0));   // 1 inside, 0 outside
  return texture2D(tex, p) * (inside.x * inside.y);
}

void main() {
  vec2 uv = vUV;
  // subtle beat-reactive zoom on everything (the "living frame")
  float zoom = 1.0 + uBeat * 0.03 * uEnergy;
  uv = (uv - 0.5) / zoom + 0.5;

  vec4 a = samp(uTexA, uv, uScaleA);
  vec4 b = samp(uTexB, uv, uScaleB);
  vec4 col;

  if (uType == 0) {                        // artistic crossfade (ease-in-out)
    float p = smoothstep(0.0, 1.0, uProgress);
    col = mix(a, b, p);
  } else if (uType == 1) {                 // luma wipe: bright pixels flip first
    float edge = smoothstep(uProgress - 0.15, uProgress + 0.15, luma(a.rgb));
    col = mix(b, a, edge);
  } else if (uType == 2) {                 // zoom punch: A zooms out, B punches in
    float p = smoothstep(0.0, 1.0, uProgress);
    vec2 uvA = (uv - 0.5) * (1.0 + p * 0.4) + 0.5;
    vec2 uvB = (uv - 0.5) * (2.0 - p) + 0.5;
    col = mix(samp(uTexA, uvA, uScaleA),
              samp(uTexB, uvB, uScaleB), p);
  } else {                                 // glitch: rgb-split slices
    float slice = floor(uv.y * 24.0);
    float jitter = (hash(vec2(slice, floor(uProgress * 20.0))) - 0.5)
                   * 0.15 * (1.0 - abs(uProgress * 2.0 - 1.0));
    vec2 uvg = vec2(uv.x + jitter, uv.y);
    vec4 ga = samp(uTexA, uvg, uScaleA);
    vec4 gb = samp(uTexB, uvg, uScaleB);
    float p = step(hash(vec2(slice, 7.0)), uProgress);
    col = mix(ga, gb, p);
    vec2 uvr = uvg + vec2(0.01 * uBeat, 0.0);
    if (p > 0.5) col.r = samp(uTexB, uvr, uScaleB).r;
    else         col.r = samp(uTexA, uvr, uScaleA).r;
  }

  // gentle energy-driven saturation lift
  float l = luma(col.rgb);
  col.rgb = mix(vec3(l), col.rgb, 1.0 + uEnergy * 0.25);
  gl_FragColor = vec4(col.rgb, 1.0);
}`;

class VisualEngine {
  constructor(canvas, clipPool) {
    this.canvas = canvas;
    this.clipPool = clipPool;
    this._active  = { el: VisualEngine._makePlayer(), clipId: null };
    this._standby = { el: VisualEngine._makePlayer(), clipId: null };
    this._trans = null;       // {clipId, type, dur, start} scheduled live transition
    this._beat = 0;
    this._playing = false;
    this._initGL();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[VisualEngine] WebGL context lost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      console.info('[VisualEngine] WebGL context restored — rebuilding pipeline');
      this._initGL();
    });
  }

  static _makePlayer() {
    const el = document.createElement('video');
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
    el.preload = 'auto';
    return el;
  }

  _initGL() {
    const gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        throw new Error('Shader compile: ' + gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, SVS_VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, SVS_FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('Program link: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this._prog = prog;

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this._u = {};
    for (const name of ['uTexA','uTexB','uProgress','uEnergy','uBeat','uType','uScaleA','uScaleB'])
      this._u[name] = gl.getUniformLocation(prog, name);

    this._texA = this._makeTexture();
    this._texB = this._makeTexture();
    gl.uniform1i(this._u.uTexA, 0);
    gl.uniform1i(this._u.uTexB, 1);
  }

  _makeTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
      gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return tex;
  }

  get activeClipId() { return this._active.clipId; }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  setPlaying(playing) {
    this._playing = playing;
    const el = this._active.el;
    if (playing && el.src) el.play().catch(() => {});
    else el.pause();
  }

  // Hard set (init / after seek) — no transition.
  showClip(clipId) {
    const clip = this.clipPool.get(clipId);
    if (!clip) return;
    this._trans = null;
    this._active.clipId = clipId;
    if (this._active.el.src !== clip.objectUrl) {
      this._active.el.src = clip.objectUrl;
      this._active.el.currentTime = 0;
    }
    if (this._playing) this._active.el.play().catch(() => {});
  }

  // §5.3 step 1–2: warm the standby decoder ≥ PRELOAD_LEAD before the cut.
  preload(clipId) {
    const clip = this.clipPool.get(clipId);
    if (!clip || this._standby.clipId === clipId) return;
    const el = this._standby.el;
    this._standby.clipId = clipId;
    el.src = clip.objectUrl;
    el.addEventListener('canplay', () => {
      el.play().then(() => { el.pause(); el.currentTime = 0; }).catch(() => {});
    }, { once: true });
  }

  transitionTo(clipId, type, durationSec, startAudioTime) {
    if (clipId === this._active.clipId) return;
    this.preload(clipId);   // no-op when already preloaded
    this._trans = { clipId, type, dur: durationSec, start: startAudioTime };
  }

  /**
   * Draw one frame. Same code path for preview and export.
   * override (export only): {type, progress, clipB} — bypasses live scheduling.
   */
  renderFrame(audioTime, features, override = null) {
    const gl = this.gl;
    const f = features || { energy: 0, onsetNear: 0 };
    this._beat = Math.max(this._beat * 0.90, f.onsetNear || 0);

    let progress = 0, type = 0, elB = this._standby.el;

    if (override) {
      progress = override.progress;
      type = override.type;
    } else if (this._trans && audioTime >= this._trans.start) {
      const tr = this._trans;
      if (this._standby.el.paused && this._playing)
        this._standby.el.play().catch(() => {});      // §5.3 step 3
      progress = Math.min(1, Math.max(0, (audioTime - tr.start) / tr.dur));
      type = tr.type;
      if (progress >= 1) {                            // §5.3 step 4: swap roles
        const old = this._active;
        this._active = { el: this._standby.el, clipId: tr.clipId };
        this._standby = { el: old.el, clipId: null };
        old.el.pause();
        this._trans = null;
        progress = 0;
      }
    }

    this._upload(gl.TEXTURE0, this._texA, this._active.el, this._u.uScaleA);
    this._upload(gl.TEXTURE1, this._texB,
      progress > 0 ? elB : this._active.el, this._u.uScaleB);

    gl.uniform1f(this._u.uProgress, progress);
    gl.uniform1f(this._u.uEnergy, f.energy || 0);
    gl.uniform1f(this._u.uBeat, this._beat);
    gl.uniform1i(this._u.uType, type);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _upload(unit, tex, video, scaleLoc) {
    const gl = this.gl;
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch (e) { /* mid-src-swap frame; keep last texture */ }
      // contain-fit: whole frame visible, centered, black letterbox/pillarbox
      // (shader masks out-of-range samples). Never crop, never stretch.
      const va = video.videoWidth / video.videoHeight;
      const ca = this.canvas.width / this.canvas.height;
      if (va > ca) gl.uniform2f(scaleLoc, 1, va / ca);
      else gl.uniform2f(scaleLoc, ca / va, 1);
    } else {
      gl.uniform2f(scaleLoc, 1, 1);
    }
  }

  // ---- Offline API (ExportEngine only) ------------------------------------
  // Assign a clip to a role ('active' | 'standby') and seek it, deterministic.
  async offlineSet(role, clipId, clipLocalTime) {
    const slot = role === 'active' ? this._active : this._standby;
    const clip = this.clipPool.get(clipId);
    if (!clip) return;
    if (slot.clipId !== clipId || slot.el.src !== clip.objectUrl) {
      slot.clipId = clipId;
      slot.el.src = clip.objectUrl;
      slot.el.pause();
      await VisualEngine._await(slot.el, 'loadedmetadata', 3000);
    }
    const t = clip.duration > 0 ? clipLocalTime % clip.duration : 0;
    if (Math.abs(slot.el.currentTime - t) > 0.001) {
      slot.el.currentTime = t;
      await VisualEngine._await(slot.el, 'seeked', 2000);   // §8.2 MANDATORY
    }
  }

  static _await(el, event, timeoutMs) {
    return new Promise((resolve) => {
      const to = setTimeout(() => {
        el.removeEventListener(event, ok);
        console.warn(`[VisualEngine] "${event}" timeout — using last decoded frame`);
        resolve();
      }, timeoutMs);
      const ok = () => { clearTimeout(to); resolve(); };
      el.addEventListener(event, ok, { once: true });
    });
  }
}

if (typeof module !== 'undefined') module.exports = { VisualEngine, SVS_VERT, SVS_FRAG };
