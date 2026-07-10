# GOLDEN MODULES — SONIC-VISUAL SYNC core engines

Pre-built, tested reference implementations of the engine cores from
`MasterBlueprintPrompt_Engine.md`. When prompting an AI to build the app,
paste the blueprint AND these files; the AI must inline them **verbatim**
(in numeric order) inside the single HTML file's `<script>` and build only
the remaining parts (`UIController`, `App`, HTML/CSS) around them.

| File | Module | Blueprint § |
|------|--------|-------------|
| `01_event-bus.js`      | EventBus — pub/sub backbone | §2.1 |
| `02_audio-analysis.js` | SonicDSP — FFT, onsets, BPM, centroid/energy/key, `featuresAt` | §4 |
| `03_audio-engine.js`   | AudioEngine — decode, playback, the master clock, markers | §2.2, §7.2 |
| `04_clip-pool.js`      | ClipPool — clip registry, thumbnails, motion/brightness/saturation CV | §2.3, §5.1–5.2 |
| `05_visual-engine.js`  | VisualEngine — WebGL, 4 transition shaders, double buffer, offline API | §2.4, §5.3–5.4 |
| `06_the-brain.js`      | TheBrain — affinity table, scoring, timeline compiler, live conductor | §3.3, §6 |
| `07_export-engine.js`  | ExportEngine — frame-by-frame render, FFmpeg.wasm MP4 + WebM fallback | §8 |

Verified 2026-07-07 (Node harness): BPM ±3 on a synthetic 120 BPM track,
onset alignment ±30 ms, key detection, seeded-timeline determinism, marker
affinity picks, transition rules, min-shot/marker-guard constraints,
segment coverage — 23/23 assertions passing. Modules 03/04/05/07 need a
browser (WebAudio/WebGL/MediaRecorder) and are syntax-checked only.

Wiring contract for the `App` glue (see blueprint §12):
`brain:show → visualEngine.showClip`, `brain:preload → visualEngine.preload`,
`brain:cut → visualEngine.transitionTo(clipId, transitionType, transitionDuration, time)`,
`transport:play/pause → visualEngine.setPlaying(true/false)`,
and a single rAF loop emitting `transport:tick {time}` +
calling `visualEngine.renderFrame(time, analysis.featuresAt(time))`.
