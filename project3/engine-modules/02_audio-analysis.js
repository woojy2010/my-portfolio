/* ============================================================================
 * GOLDEN MODULE 02 — SonicDSP (pure offline audio analysis)
 * SONIC-VISUAL SYNC · paste verbatim into sonic-visual-sync.html <script>
 * Implements Blueprint §4 exactly: STFT → onsets → BPM → centroid/energy/key.
 * Pure functions, no browser APIs — deterministic for preview AND export.
 * ========================================================================== */
const SonicDSP = (() => {
  const FFT_SIZE = 2048;
  const HOP = 512;
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // In-place iterative radix-2 Cooley-Tukey FFT.
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wR = Math.cos(ang), wI = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cR = 1, cI = 0;
        for (let k = 0; k < half; k++) {
          const xr = re[i + k + half], xi = im[i + k + half];
          const vR = xr * cR - xi * cI;
          const vI = xr * cI + xi * cR;
          re[i + k + half] = re[i + k] - vR;
          im[i + k + half] = im[i + k] - vI;
          re[i + k] += vR;
          im[i + k] += vI;
          const nR = cR * wR - cI * wI;
          cI = cR * wI + cI * wR;
          cR = nR;
        }
      }
    }
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /**
   * analyze(mono, sampleRate [, onProgress]) → AudioAnalysis (Blueprint §4.5)
   * mono: Float32Array mixdown (L+R)/2. onProgress: optional fn(0..1).
   */
  function analyze(mono, sampleRate, onProgress) {
    const n = mono.length;
    const duration = n / sampleRate;
    const bins = FFT_SIZE / 2;
    const frameCount = Math.max(1, Math.floor((n - FFT_SIZE) / HOP) + 1);
    const hopTime = HOP / sampleRate;
    // Frames are timestamped at the WINDOW CENTER (Hann energy centroid):
    // t_k = k*hopTime + frameOffset. Without this, onsets read ~23 ms early.
    const frameOffset = (FFT_SIZE / 2) / sampleRate;
    const envRate = sampleRate / HOP;

    const hann = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++)
      hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));

    // ---- 4.1 STFT pass: flux, centroid, RMS, average spectrum -------------
    const flux = new Float32Array(frameCount);       // full-band → onset detection
    const fluxLow = new Float32Array(frameCount);     // low-band → tempo (§4.3)
    const bright = new Float32Array(frameCount);
    const energy = new Float32Array(frameCount);
    const avgSpec = new Float32Array(bins);
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    const mag = new Float32Array(bins);
    const prevMag = new Float32Array(bins);
    const binHz = sampleRate / FFT_SIZE;
    // Tempo is estimated from a low-frequency flux (kick/snare band, ≲900 Hz):
    // broadband hi-hats otherwise dominate full-band flux and lock the tempo
    // autocorrelation onto the hat subdivision (e.g. 104 BPM read as 138).
    const lowMax = Math.min(bins - 1, Math.round(900 / binHz));

    for (let k = 0; k < frameCount; k++) {
      const off = k * HOP;
      let rms = 0;
      for (let i = 0; i < FFT_SIZE; i++) {
        const s = mono[off + i] || 0;
        re[i] = s * hann[i];
        im[i] = 0;
        rms += s * s;
      }
      energy[k] = Math.sqrt(rms / FFT_SIZE);
      fft(re, im);
      let fl = 0, flLow = 0, cSum = 0, mSum = 0;
      for (let b = 0; b < bins; b++) {
        const m = Math.hypot(re[b], im[b]);
        mag[b] = m;
        avgSpec[b] += m;
        const d = m - prevMag[b];
        if (d > 0) { fl += d; if (b <= lowMax) flLow += d; }
        cSum += binHz * b * m;
        mSum += m;
      }
      flux[k] = fl;
      fluxLow[k] = flLow;
      bright[k] = mSum > 1e-9 ? clamp((cSum / mSum) / 4000, 0, 1) : 0;
      prevMag.set(mag);
      if (onProgress && (k & 63) === 0) onProgress(k / frameCount);
    }

    // Normalize flux & energy to [0,1]
    let fMax = 0, eMax = 0;
    for (let k = 0; k < frameCount; k++) {
      if (flux[k] > fMax) fMax = flux[k];
      if (energy[k] > eMax) eMax = energy[k];
    }
    if (fMax > 0) for (let k = 0; k < frameCount; k++) flux[k] /= fMax;
    if (eMax > 0) for (let k = 0; k < frameCount; k++) energy[k] /= eMax;
    let flLowMax = 0;
    for (let k = 0; k < frameCount; k++) if (fluxLow[k] > flLowMax) flLowMax = fluxLow[k];
    if (flLowMax > 0) for (let k = 0; k < frameCount; k++) fluxLow[k] /= flLowMax;

    // ---- 4.2 Onset detection: spectral flux + adaptive threshold ----------
    const onsets = [];
    let lastOnset = -Infinity;
    for (let k = 1; k < frameCount - 1; k++) {
      const a = Math.max(0, k - 10), b = Math.min(frameCount - 1, k + 10);
      let mean = 0;
      for (let i = a; i <= b; i++) mean += flux[i];
      mean /= (b - a + 1);
      const threshold = mean * 1.5 + 0.02;
      if (flux[k] <= threshold) continue;
      let isPeak = true;
      for (let i = Math.max(0, k - 3); i <= Math.min(frameCount - 1, k + 3); i++)
        if (flux[i] > flux[k]) { isPeak = false; break; }
      if (!isPeak) continue;
      const t = k * hopTime + frameOffset;
      if (t - lastOnset < 0.10) continue;
      onsets.push({ time: t, strength: flux[k] });
      lastOnset = t;
    }

    // ---- 4.3 BPM: autocorrelation of the onset envelope + harmonic scoring --
    // Plain argmax of the raw AC locks onto rhythmic SUBDIVISIONS as easily as
    // the beat — especially the dotted-eighth (lag ≈ 3/4·beat), which reads a
    // 104 BPM track as 138 ≈ 104·4/3 (a metrical error folding cannot fix).
    // Fix: score each candidate beat lag with a small HARMONIC COMB — the true
    // beat is reinforced by all of its multiples (L, 2L, 3L, 4L), a subdivision
    // peak is not. AC is made unbiased (divided by the overlap count) so longer
    // lags stay comparable to shorter ones.
    const lagMin = Math.round((60 / 180) * envRate);
    const lagMax = Math.round((60 / 60) * envRate);
    const maxLag = Math.min(frameCount - 1, lagMax * 4);
    const ac = new Float32Array(maxLag + 1);
    for (let lag = lagMin; lag <= maxLag; lag++) {
      let c = 0; const n = frameCount - lag;
      for (let k = 0; k < n; k++) c += fluxLow[k] * fluxLow[k + lag];
      ac[lag] = n > 0 ? c / n : 0;
    }
    const HARM = [1.0, 0.8, 0.6, 0.4];    // weights for L, 2L, 3L, 4L
    let bestLag = lagMin, bestComb = -Infinity;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let score = 0;
      for (let m = 0; m < HARM.length; m++) {
        const h = lag * (m + 1);
        if (h <= maxLag) score += HARM[m] * ac[h];
      }
      if (score > bestComb) { bestComb = score; bestLag = lag; }
    }
    let bpm = 60 * envRate / bestLag;
    while (bpm < 80) bpm *= 2;
    while (bpm >= 160) bpm /= 2;
    bpm = Math.round(bpm * 10) / 10;

    // Beat grid phase: maximize onset strength within ±40 ms of the grid.
    const beatInterval = 60 / bpm;
    let bestPhase = 0, bestScore = -Infinity;
    const PHASE_STEPS = 32;
    for (let p = 0; p < PHASE_STEPS; p++) {
      const phase = (p / PHASE_STEPS) * beatInterval;
      let score = 0;
      for (const o of onsets) {
        const d = (o.time - phase) % beatInterval;
        const dist = Math.min(Math.abs(d), beatInterval - Math.abs(d));
        if (dist <= 0.04) score += o.strength;
      }
      if (score > bestScore) { bestScore = score; bestPhase = phase; }
    }
    const beatTimes = [];
    for (let t = bestPhase; t < duration; t += beatInterval) beatTimes.push(t);

    // ---- 4.4 Key (display only) --------------------------------------------
    const pcSum = new Float32Array(12);
    for (let b = 1; b < bins; b++) {
      const f = b * binHz;
      if (f < 55 || f > 2000) continue;
      const pc = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12;
      pcSum[pc] += avgSpec[b];
    }
    let key = 'C', kMax = -Infinity;
    for (let i = 0; i < 12; i++)
      if (pcSum[i] > kMax) { kMax = pcSum[i]; key = NOTE_NAMES[i]; }

    // ---- EMA smoothing (α = 0.2) -------------------------------------------
    const brightSmooth = new Float32Array(frameCount);
    const energySmooth = new Float32Array(frameCount);
    let bs = bright[0], es = energy[0];
    for (let k = 0; k < frameCount; k++) {
      bs = 0.2 * bright[k] + 0.8 * bs;
      es = 0.2 * energy[k] + 0.8 * es;
      brightSmooth[k] = bs;
      energySmooth[k] = es;
    }

    // ---- Waveform peaks (2000 max-abs buckets) -------------------------------
    const PEAKS = 2000;
    const waveformPeaks = new Float32Array(PEAKS);
    const bucket = Math.max(1, Math.floor(n / PEAKS));
    for (let p = 0; p < PEAKS; p++) {
      let mx = 0;
      const s = p * bucket, e = Math.min(n, s + bucket);
      for (let i = s; i < e; i++) {
        const a = Math.abs(mono[i]);
        if (a > mx) mx = a;
      }
      waveformPeaks[p] = mx;
    }

    const analysis = {
      sampleRate, duration, bpm, beatTimes, onsets, key, waveformPeaks,
      frames: { hopTime, frameOffset, bright: brightSmooth, energy: energySmooth },
      featuresAt(time) {
        const i = clamp(Math.round((time - frameOffset) / hopTime), 0, frameCount - 1);
        // nearest onset within ±50 ms (onsets are time-sorted → binary search)
        let onsetNear = 0, lo = 0, hi = onsets.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (onsets[mid].time < time) lo = mid + 1; else hi = mid - 1;
        }
        for (const j of [hi, lo]) {
          if (j >= 0 && j < onsets.length && Math.abs(onsets[j].time - time) <= 0.05)
            onsetNear = Math.max(onsetNear, onsets[j].strength);
        }
        const rel = (time - bestPhase) / beatInterval;
        return {
          bright: brightSmooth[i],
          energy: energySmooth[i],
          onsetNear,
          beatPhase: rel - Math.floor(rel),
        };
      },
    };
    if (onProgress) onProgress(1);
    return analysis;
  }

  return { FFT_SIZE, HOP, fft, analyze };
})();

if (typeof module !== 'undefined') module.exports = { SonicDSP };
