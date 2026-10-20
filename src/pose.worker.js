// Воркер оценки позы. Детект блокирует поток, поэтому он живёт отдельно
// от рендера (об этом прямо предупреждает документация MediaPipe).
//
// Засада: mediapipe-шный загрузчик wasm раскрывает glue-файл через importScripts(),
// а в module-воркере importScripts бросает TypeError — код откатывается на
// import(), но тогда `var ModuleFactory` остаётся в области модуля, а не в
// глобальной, и MediaPipe падает с "ModuleFactory not set.".
// Поэтому glue ставим руками через indirect eval (он кладёт var в globalThis).
import { FilesetResolver, PoseLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

let landmarker = null;
let frames = 0;
let totalMs = 0;

// Те же байты, которыми MediaPipe проверяет SIMD
const SIMD_TEST = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
  10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

function simdSupported() {
  try { return WebAssembly.validate(SIMD_TEST); } catch { return false; }
}

async function installGlue(wasmPath) {
  if (typeof self.ModuleFactory === 'function') return;
  const name = `vision_wasm${simdSupported() ? '' : '_nosimd'}_internal.js`;
  const url = `${wasmPath}/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`не могу скачать ${url}: ${res.status}`);
  const src = await res.text();
  // indirect eval -> код выполняется в глобальной области видимости воркера
  (0, eval)(src);
  if (typeof self.ModuleFactory !== 'function') {
    throw new Error('glue не установил ModuleFactory');
  }
  self.postMessage({ type: 'log', text: `glue загружен (${name})` });
}

async function createLandmarker({ wasmPath, modelPath, delegate }) {
  await installGlue(wasmPath);
  const vision = await FilesetResolver.forVisionTasks(wasmPath);

  const opts = (delegateName) => ({
    baseOptions: { modelAssetPath: modelPath, delegate: delegateName },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  try {
    const lm = await PoseLandmarker.createFromOptions(vision, opts(delegate || 'GPU'));
    return { landmarker: lm, delegate: delegate || 'GPU' };
  } catch (err) {
    self.postMessage({ type: 'log', text: `GPU не взлетел (${err?.message || err}), падаю на CPU` });
    const lm = await PoseLandmarker.createFromOptions(vision, opts('CPU'));
    return { landmarker: lm, delegate: 'CPU' };
  }
}

function pack(result) {
  const l = result.landmarks?.[0] || [];
  const w = result.worldLandmarks?.[0] || [];
  const pack1 = (arr) => {
    const out = new Float32Array(arr.length * 4);
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      out[i * 4 + 0] = p.x;
      out[i * 4 + 1] = p.y;
      out[i * 4 + 2] = p.z;
      out[i * 4 + 3] = p.visibility ?? 1;
    }
    return out;
  };
  return { image: pack1(l), world: pack1(w), count: l.length };
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      const made = await createLandmarker(msg);
      landmarker = made.landmarker;
      self.postMessage({ type: 'ready', delegate: made.delegate });
    } catch (err) {
      self.postMessage({ type: 'error', text: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === 'frame') {
    if (!landmarker) { msg.bitmap.close?.(); return; }
    const t0 = performance.now();
    try {
      const result = landmarker.detectForVideo(msg.bitmap, msg.ts);
      msg.bitmap.close?.();
      totalMs += performance.now() - t0;
      frames++;
      const packed = pack(result);
      if (frames <= 3) {
        self.postMessage({
          type: 'log',
          text: `детект ${Math.round(performance.now() - t0)}мс, точек: ${packed.count}`,
        });
      }
      self.postMessage({ type: 'pose', ts: msg.ts, ms: totalMs / frames, ...packed });
    } catch (err) {
      msg.bitmap.close?.();
      self.postMessage({ type: 'error', text: String(err?.message || err) });
    }
  }
};
