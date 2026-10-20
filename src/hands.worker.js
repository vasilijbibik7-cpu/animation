// Кисти и пальцы: отдельный воркер и отдельный проход по кадру.
//
// Почему отдельно: HandLandmarker на две руки стоит ~40 мс. Если считать его в
// воркере позы, каждый кадр тела ждёт ещё и кисти — тело падает с ~30 до ~15 к/с.
// Здесь руки считаются параллельно и с той скоростью, на которую способны;
// тело берёт последний готовый результат.
import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { installGlue } from './mp-glue.js';

let hands = null;
let lastMs = 0;

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

function packHands(result) {
  const world = result.worldLandmarks || [];
  const image = result.landmarks || [];
  const out = [];
  for (let i = 0; i < world.length; i++) {
    out.push({ world: pack1(world[i]), image: pack1(image[i] || []) });
  }
  return out;
}

async function createHands({ wasmPath, handModelPath, delegate }) {
  if (!handModelPath) return null;
  await installGlue(wasmPath);
  const vision = await FilesetResolver.forVisionTasks(wasmPath);
  const opts = (d) => ({
    baseOptions: { modelAssetPath: handModelPath, delegate: d },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.4,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  try {
    return { lm: await HandLandmarker.createFromOptions(vision, opts(delegate || 'GPU')), delegate: delegate || 'GPU' };
  } catch (err) {
    self.postMessage({ type: 'log', text: `кисти на GPU не взлетели (${err?.message || err}), пробую CPU` });
    try {
      return { lm: await HandLandmarker.createFromOptions(vision, opts('CPU')), delegate: 'CPU' };
    } catch (err2) {
      self.postMessage({ type: 'log', text: `кисти недоступны: ${err2?.message || err2}` });
      return null;
    }
  }
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      hands = await createHands(msg);
      // Первый прогон компилирует шейдеры (~2 с). Делаем его здесь, чтобы
      // первый настоящий кадр не висел и не копил очередь.
      if (hands) {
        try {
          const c = new OffscreenCanvas(64, 64);
          const g = c.getContext('2d');
          g.fillStyle = '#777';
          g.fillRect(0, 0, 64, 64);
          const bmp = c.transferToImageBitmap();
          hands.lm.detectForVideo(bmp, 0);
          bmp.close?.();
        } catch (err) {
          self.postMessage({ type: 'log', text: 'прогрев кистей: ' + (err?.message || err) });
        }
      }
      self.postMessage({ type: 'ready', hands: !!hands, delegate: hands?.delegate || '' });
    } catch (err) {
      self.postMessage({ type: 'error', text: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === 'frame') {
    if (!hands) { msg.bitmap.close?.(); return; }
    const t0 = performance.now();
    try {
      const result = hands.lm.detectForVideo(msg.bitmap, msg.ts);
      lastMs = performance.now() - t0;
      msg.bitmap.close?.();
      const packed = packHands(result);
      if (!self.__logged && packed.length) {
        self.__logged = true;
        self.postMessage({ type: 'log', text: `кисти: ${Math.round(lastMs)}мс, рук: ${packed.length}` });
      }
      self.postMessage({ type: 'hands', ts: msg.ts, ms: lastMs, hands: packed });
    } catch (err) {
      msg.bitmap.close?.();
      self.postMessage({ type: 'error', text: String(err?.message || err) });
    }
  }
};
