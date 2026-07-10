const path = '/Users/jw/Downloads/ClaudeTest_transition-studio/engine-modules/';
const { EventBus } = require(path + '01_event-bus.js');
const { SonicDSP } = require(path + '02_audio-analysis.js');
const { TheBrain, SVS_AFFINITY, mulberry32 } = require(path + '06_the-brain.js');
const { ExportEngine } = (() => {
  // 07 references no browser APIs at require time? It's a class def only — but
  // module.exports at bottom; requiring is safe since nothing executes.
  return require(path + '07_export-engine.js');
})();

let failures = 0;
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '  ' + detail));
  if (!cond) failures++;
}

// ---- 1. Synthetic 120 BPM click track --------------------------------------
const sr = 44100, dur = 20;
const mono = new Float32Array(sr * dur);
const beatInt = 0.5; // 120 BPM
for (let t = 0.1; t < dur; t += beatInt) {
  const s0 = Math.round(t * sr);
  for (let i = 0; i < 900; i++) {
    // decaying burst: sine + noise (broadband → strong spectral flux)
    mono[s0 + i] += (Math.sin(2 * Math.PI * 1000 * i / sr) * 0.7 +
                     (Math.random() - 0.5) * 0.6) * Math.exp(-i / 200);
  }
}
// quiet pad underneath (pitch content for key: A = 220 Hz)
for (let i = 0; i < mono.length; i++)
  mono[i] += 0.05 * Math.sin(2 * Math.PI * 220 * i / sr);

const an = SonicDSP.analyze(mono, sr);
check('BPM within ±3 of 120', Math.abs(an.bpm - 120) <= 3, `got ${an.bpm}`);
const expectedOnsets = Math.floor((dur - 0.1) / beatInt) + 1;
check('onset count ≈ clicks', Math.abs(an.onsets.length - expectedOnsets) <= 4,
  `got ${an.onsets.length}, expected ~${expectedOnsets}`);
// onset alignment: every onset within 30 ms of a click
const misaligned = an.onsets.filter(o => {
  const rel = (o.time - 0.1) % beatInt;
  return Math.min(rel, beatInt - rel) > 0.03;
});
check('onsets aligned to clicks (±30 ms)', misaligned.length === 0,
  `${misaligned.length} misaligned`);
check('key detected as A', an.key === 'A', `got ${an.key}`);
check('beatTimes span duration', an.beatTimes.length >= 35 && an.beatTimes.length <= 45,
  `got ${an.beatTimes.length}`);
const f = an.featuresAt(5.0);
check('featuresAt returns sane values',
  f.bright >= 0 && f.bright <= 1 && f.energy >= 0 && f.energy <= 1 &&
  f.beatPhase >= 0 && f.beatPhase < 1, JSON.stringify(f));
check('waveformPeaks length 2000', an.waveformPeaks.length === 2000);

// ---- 2. mulberry32 determinism ----------------------------------------------
const r1 = mulberry32(42), r2 = mulberry32(42);
check('mulberry32(42) deterministic',
  [1,2,3].every(() => r1() === r2()));

// ---- 3. TheBrain: scoring + compileTimeline ----------------------------------
const bus = new EventBus();
const mkClip = (id, tags, auto) => ({ id, name: id, tags, auto });
const clips = [
  mkClip('calm', ['#Calm', '#Slow'], { motion: 0.1, brightness: 0.3, saturation: 0.3 }),
  mkClip('fast', ['#Fast', '#Energetic'], { motion: 0.9, brightness: 0.7, saturation: 0.8 }),
  mkClip('abstract', ['#Abstract'], { motion: 0.5, brightness: 0.5, saturation: 0.5 }),
];
const poolMock = { all: () => clips, get: (id) => clips.find(c => c.id === id) };
const markers = [
  { id: 'm1', time: 5.0, tag: '#Drop' },
  { id: 'm2', time: 12.0, tag: '#Break' },
];
const audioMock = {
  analysis: an, currentTime: 0,
  markers,
  duration: an.duration,
};
const brain = new TheBrain(audioMock, poolMock, bus);

// scoring: #Drop must prefer fast over calm regardless of features
const rng0 = () => 0;
const sFast = brain.scoreClip(clips[1], { bright: 0.2, energy: 0.2, markerTag: '#Drop' }, [], rng0);
const sCalm = brain.scoreClip(clips[0], { bright: 0.2, energy: 0.2, markerTag: '#Drop' }, [], rng0);
check('#Drop prefers #Fast clip over #Calm clip', sFast > sCalm, `${sFast} vs ${sCalm}`);

// novelty: active clip penalized
const sRepeat = brain.scoreClip(clips[1], { bright: 0.7, energy: 0.9, markerTag: null }, ['fast'], rng0);
const sFresh  = brain.scoreClip(clips[1], { bright: 0.7, energy: 0.9, markerTag: null }, ['calm'], rng0);
check('novelty penalty applied to repeat', sFresh - sRepeat === 1.5, `${sFresh - sRepeat}`);

const tl1 = brain.compileTimeline();
const tl2 = brain.compileTimeline();
check('timeline non-empty', tl1.cuts.length > 2, `got ${tl1.cuts.length}`);
check('timeline deterministic (seeded)', JSON.stringify(tl1) === JSON.stringify(tl2));
check('first cut at t=0, no transition',
  tl1.cuts[0].time === 0 && tl1.cuts[0].transitionType === null);
const dropCut = tl1.cuts.find(c => c.reason === 'manual:#Drop');
const breakCut = tl1.cuts.find(c => c.reason === 'manual:#Break');
check('manual markers produce cuts at exact times',
  dropCut && dropCut.time === 5.0 && breakCut && breakCut.time === 12.0);
check('#Drop cut picks the #Fast clip', dropCut.clipId === 'fast', dropCut && dropCut.clipId);
check('#Break cut picks the #Calm clip', breakCut.clipId === 'calm', breakCut && breakCut.clipId);
check('#Drop transition is 0.12 s punch/glitch',
  dropCut.transitionDuration === 0.12 && (dropCut.transitionType === 2 || dropCut.transitionType === 3));
check('#Break transition is 1.2 s crossfade',
  breakCut.transitionDuration === 1.2 && breakCut.transitionType === 0);
// guards: no auto cut within 1.0 s of a marker; min shot 1.0 s
const autoCuts = tl1.cuts.filter(c => c.reason === 'auto:beat');
const guardViolation = autoCuts.some(c => markers.some(m => Math.abs(m.time - c.time) < 1.0));
check('no auto cut within 1.0 s of a marker', !guardViolation);
let minShot = Infinity;
for (let i = 1; i < tl1.cuts.length; i++)
  minShot = Math.min(minShot, tl1.cuts[i].time - tl1.cuts[i - 1].time);
check('minimum shot length ≥ 1.0 s', minShot >= 1.0, `min ${minShot}`);
const consecutiveRepeat = tl1.cuts.some((c, i) => i > 0 && c.clipId === tl1.cuts[i - 1].clipId);
check('no clip plays twice consecutively', !consecutiveRepeat);

// ---- 4. ExportEngine.buildSegments (pure) -------------------------------------
const segs = ExportEngine.buildSegments(tl1.cuts, an.duration);
check('segments cover full duration',
  segs[0].start === 0 && Math.abs(segs[segs.length - 1].end - an.duration) < 1e-9 &&
  segs.every((s, i) => i === 0 || s.start === segs[i - 1].end));

// ---- 5. BPM robustness: dotted-eighth hats must NOT fool tempo (v1.3) --------
// Regression for the 104→138 (·4/3) metrical error: broadband hats every 3/4
// beat once dominated full-band flux; tempo now runs on the low band.
function makeDottedTrack(bpm, hatAmp) {
  const sr5 = 44100, dur5 = 40, beat = 60 / bpm;
  const m = new Float32Array(sr5 * dur5);
  const burst = (t0, f, a, dec, noise) => {
    const s0 = Math.round(t0 * sr5);
    for (let i = 0; i < sr5 * 0.15 && s0 + i < m.length; i++) {
      const e = Math.exp(-i / (sr5 * dec));
      m[s0 + i] += (Math.sin(2 * Math.PI * f * i / sr5) * (1 - noise) +
                    (Math.random() - 0.5) * 2 * noise) * a * e;
    }
  };
  for (let t = 0.2; t < dur5; t += beat) burst(t, 80, 0.9, 0.05, 0.1);        // kick/beat
  for (let t = 0.2; t < dur5; t += beat * 0.75) burst(t, 8000, hatAmp, 0.02, 0.9); // dotted hats
  for (let i = 0; i < m.length; i++) m[i] += 0.04 * Math.sin(2 * Math.PI * 220 * i / sr5);
  return { mono: m, sr: sr5 };
}
for (const hat of [0.3, 0.7]) {
  const t = makeDottedTrack(104, hat);
  const a5 = SonicDSP.analyze(t.mono, t.sr);
  check(`104 BPM with ${hat < 0.5 ? 'quiet' : 'loud'} dotted-eighth hats stays ≈104`,
    Math.abs(a5.bpm - 104) <= 3, `got ${a5.bpm}`);
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
