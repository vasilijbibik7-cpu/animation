// Импорт сохранённых точек: JSON (mocap-landmarks) → тот же ретаргет, что и с
// камеры → новый дубль записи. Камера для этого не нужна: точки уже в файле,
// а рост, зеркало и глубину можно поменять и получить другой BVH из той же
// съёмки. Сглаживание второй раз не применяем: в JSON лежат уже сглаженные
// точки.
import * as THREE from 'three';
import { StandingTracker, landmarkToWorld } from './retarget.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// JSON → проверенный объект. Ошибки по-русски: их показываем в HUD.
export function parseLandmarkJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('файл не читается как JSON');
  }
  if (!data || data.format !== 'mocap-landmarks') {
    throw new Error('это не файл точек mocap-landmarks');
  }
  const frames = data.landmarks;
  if (!Array.isArray(frames) || frames.length < 4) {
    throw new Error('в файле меньше 4 кадров — записывать нечего');
  }
  const stride = frames[0]?.length || 0;
  if (stride % 4 !== 0 || stride < 33 * 4) {
    throw new Error(`в кадре ${stride} чисел, а нужно 132 (33 точки × x,y,z,видимость)`);
  }
  for (let i = 0; i < frames.length; i++) {
    if (!Array.isArray(frames[i]) || frames[i].length !== stride) {
      throw new Error(`кадр ${i}: длина ${frames[i]?.length ?? '—'}, нужно ${stride}`);
    }
  }
  return data;
}

// Плоский кадр [x,y,z,vis, ...] → точки MediaPipe, как их отдаёт воркер.
function pointsFromFlat(flat) {
  const n = flat.length / 4;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      x: flat[i * 4],
      y: flat[i * 4 + 1],
      z: flat[i * 4 + 2],
      visibility: flat[i * 4 + 3] ?? 1,
    };
  }
  return out;
}

// Прогнать точки через ретаргет и записать результат дублем.
// Возвращает { frames, duration, height, fps } — для отчёта в HUD.
export function retargetTake(data, {
  retargeter, recorder, heightMeters = 1.75, mirror = false, zGain = 1,
  followFeet = true, rootMotion = true, legGuard = true, label = '', fps = 30,
} = {}) {
  if (!retargeter || !recorder) throw new Error('нет скелета');
  const frames = data.landmarks;
  const srcFps = clamp(Number(data.fps) || fps, 10, 60);
  const standing = new StandingTracker();

  // Корень и масштаб — с нуля: иначе первая поза «прыгнет» из того места, где
  // камера закончила, и корневое движение поедет не от нуля.
  retargeter.resetRoot();

  const prevWarmup = recorder.warmup;
  const prevMax = recorder.maxSeconds;
  recorder.warmup = 0; // у импорта нет разогрева: первый кадр нужен
  recorder.maxSeconds = Math.max(prevMax, frames.length / srcFps + 2);

  try {
    recorder.start(0, { label, source: 'json' });
    for (let i = 0; i < frames.length; i++) {
      const t = i / srcFps;
      const raw = pointsFromFlat(frames[i]);
      // Рост: как в живом режиме — не ниже заданного ползунком и не ниже
      // наблюдённого в этих точках.
      standing.update(raw);
      const height = Math.max(heightMeters, standing.heightMeters);

      const pts = raw.map((p) => {
        const v = landmarkToWorld(
          { x: p.x, y: p.y, z: p.z * zGain },
          mirror,
          new THREE.Vector3(),
        );
        return { x: v.x, y: v.y, z: v.z, visibility: p.visibility ?? 1 };
      });

      retargeter.update(pts, {
        heightMeters: height,
        followFeet,
        rootMotion,
        guardPoints: pts,
        // Картинки кадра в JSON нет: предохранитель ног проверяет только
        // скачки точек, а не «нога вышла за кадр».
        legGuard,
        t,
      });
      recorder.push(t, raw);
    }
    recorder.stop();
  } catch (err) {
    if (recorder.recording) recorder.abort();
    throw err;
  } finally {
    recorder.warmup = prevWarmup;
    recorder.maxSeconds = prevMax;
  }

  if (!recorder.frameCount) throw new Error('из этих точек не получилось ни одного кадра');

  return {
    frames: recorder.frameCount,
    duration: recorder.duration,
    height: Math.max(heightMeters, standing.heightMeters),
    fps: srcFps,
  };
}
