// Воркер оценки позы. Детект блокирует поток, поэтому он живёт отдельно
// от рендера (об этом прямо предупреждает документация MediaPipe).
//
// Кисти считает отдельный воркер (hands.worker.js): второй проход по кадру не
// должен задерживать тело.
import { FilesetResolver, PoseLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { installGlue } from './mp-glue.js';

let landmarker = null;
let frames = 0;
let totalMs = 0;

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

function pack1(arr) {
  const out = new Float32Array(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    out[i * 4 + 0] = p.x;
    out[i * 4 + 1] = p.y;
    out[i * 4 + 2] = p.z;
    out[i * 4 + 3] = p.visibility ?? 1;
  }
  return out;
}

function pack(result) {
  const l = result.landmarks?.[0] || [];
  const w = result.worldLandmarks?.[0] || [];
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
          text: `детект ${Math.round(totalMs / frames)}мс, точек: ${packed.count}`,
        });
      }
      self.postMessage({ type: 'pose', ts: msg.ts, ms: totalMs / frames, ...packed });
    } catch (err) {
      msg.bitmap.close?.();
      self.postMessage({ type: 'error', text: String(err?.message || err) });
    }
  }
};
