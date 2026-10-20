// Реалтайм-мокап: веб-камера → MediaPipe Pose (воркер) → сглаживание →
// ретаргет на скелет Mixamo → three.js.
//
// Запуск: node server.mjs  →  http://localhost:8090
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';

import { LandmarkFilter } from './filter.js';
import { findRig, captureRest, buildFallbackRig } from './rig.js';
import { Retargeter, StandingTracker, landmarkToWorld } from './retarget.js';
import { startCamera, stopCamera, listCameras, describeCameraError, permissionState } from './capture.js';
import { Recorder } from './record.js';
import { buildBVH, buildLandmarkJson, downloadText } from './bvh.js';
import { ArmsUpTrigger } from './gesture.js';
import { TrimStrip } from './trim.js';
import { analyze, alignLoop, pinFeet, removeDrift, smoothFrames, footContacts, clearFloor } from './polish.js';
import { LegGuard, LEG_POINTS } from './legs.js';

const CONFIG = {
  // Скелет + клип Mixamo (можно положить любой FBX/GLB с ригом Mixamo)
  rigUrl: encodeURI('/Fight Idle To Standing Idle.fbx'),
  wasmPath: '/vendor/mediapipe/wasm',
  modelPath: '/vendor/models/pose_landmarker_full.task',
};

// ---------- состояние ----------
const state = {
  mirror: false,
  zGain: 1.0,
  followHips: true,
  followCam: true,
  rootMotion: true,
  footLock: true,
  legGuard: true,
  gesture: true,
  telemetry: false,
  heightMeters: 1.75,
  loop: null,
  smoothing: 0.5,
  mode: 'live', // live | clip
  synthetic: false,
  tracking: false,
  camState: 'off', // off | ok | fail
  perm: 'unknown',
  lastPoseAt: 0,
  fps: 0,
  frames: 0,
  fpsTime: 0,
};

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function log(text) {
  console.log('[mocap]', text);
  if (statusEl) statusEl.textContent = text;
}

// ---------- сцена ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1017);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = false;
document.getElementById('app').appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0x9fc3ff, 0x1a1a22, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(2, 4, 3);
scene.add(key);

let grid = null;
let modelRoot = null;
let mixer = null;
let clip = null;
let clipAction = null;
let skeletonHelper = null;
let jointDots = [];
let retargeter = null;
let rig = null;
let restPose = null;
let standingTracker = new StandingTracker();
let gesture = new ArmsUpTrigger();
let trimStrip = null;
let baseRootY = 0;
let modelHeight = 1.8;
let recorder = null;

// Все кости под тазом в порядке иерархии — их и пишем, и отдаём в BVH.
// Виртуальные кончики (_End) пропускаем: в BVH они становятся End Site,
// а в каналах движения их быть не должно.
function collectBones() {
  const list = [];
  const walk = (b) => {
    if (!b.isBone) return;
    if (!/_End$/i.test(b.name)) list.push(b);
    for (const c of b.children) walk(c);
  };
  if (rig?.hips) walk(rig.hips);
  return list;
}

// ---------- загрузка рига ----------
async function loadRig() {
  let root = null;
  let animations = [];

  try {
    const fbx = await new FBXLoader().loadAsync(CONFIG.rigUrl);
    root = fbx;
    animations = fbx.animations || [];
    log(`FBX загружен: ${animations.length} клип(ов)`);
  } catch (err) {
    console.warn(err);
    root = buildFallbackRig();
    log('FBX не загрузился, работаю на запасном скелете');
  }

  scene.add(root);
  root.updateMatrixWorld(true);

  const found = findRig(root);
  if (!found.rig.hips) {
    scene.remove(root);
    root = buildFallbackRig();
    scene.add(root);
    root.updateMatrixWorld(true);
    Object.assign(found, findRig(root));
    log('В файле нет костей Mixamo — запасной скелет');
  }
  rig = found.rig;

  fitScene(root);

  restPose = captureRest(root, rig);
  retargeter = new Retargeter(rig, restPose.rest, restPose.hipsBasis, {
    smoothing: state.smoothing,
    footLock: state.footLock,
    legGuard: state.legGuard,
  });
  retargeter.setRoot(root);

  recorder = new Recorder({
    bones: collectBones(),
    root,
    fps: 30,
    warmup: 0.6,
    maxSeconds: 60,
    feet: [rig.lFoot, rig.lToe, rig.rFoot, rig.rToe],
    onChange: updateRecUi,
  });

  if ($('trim')) {
    trimStrip = new TrimStrip({ canvas: $('trim'), recorder, onChange: updateTrimUi });
  }

  // Визуализация скелета
  modelRoot = root;
  skeletonHelper = new THREE.SkeletonHelper(root);
  skeletonHelper.material.linewidth = 2;
  scene.add(skeletonHelper);
  buildJointDots(root);

  // Клип из файла
  if (animations.length) {
    clip = animations[0];
    mixer = new THREE.AnimationMixer(root);
    clipAction = mixer.clipAction(clip);
    clipAction.loop = THREE.LoopRepeat;
    clipAction.play();
    clipAction.paused = true;
    $('clipName').textContent = clip.name || '(без имени)';
  } else {
    $('clipName').textContent = 'нет';
    $('btnPlay').disabled = true;
  }

  return root;
}

function boneBounds(root) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isBone && o !== root) return;
    if (o.isBone && o.name.endsWith('_End')) return; // виртуальные кончики не считаем
    box.expandByPoint(v.setFromMatrixPosition(o.matrixWorld));
  });
  return box;
}

function fitScene(root) {
  root.position.y = 0;
  let box = boneBounds(root);
  if (!isFinite(box.min.y)) {
    box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  }
  modelHeight = Math.max(0.2, box.max.y - box.min.y);

  // ставим самую низкую кость ровно на пол
  baseRootY = -box.min.y;
  root.position.y = baseRootY;
  root.updateMatrixWorld(true);

  if (grid) scene.remove(grid);
  const span = modelHeight * 1.8;
  grid = new THREE.GridHelper(span, 16, 0x3a4a6a, 0x1e2636);
  scene.add(grid);

  const size = modelHeight;
  camera.position.set(size * 1.5, size * 1.0, size * 2.3);
  camera.near = size * 0.01;
  camera.far = size * 60;
  camera.updateProjectionMatrix();
  controls.target.set(0, size * 0.52, 0);
  controls.update();
}

function buildJointDots(root) {
  for (const dot of jointDots) scene.remove(dot.mesh);
  jointDots = [];
  const r = modelHeight * 0.014;
  const geo = new THREE.SphereGeometry(1, 10, 8);
  const mat = new THREE.MeshBasicMaterial({ color: 0x63e6ff });
  for (const key of Object.keys(rig)) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.setScalar(r);
    mesh.renderOrder = 2;
    scene.add(mesh);
    jointDots.push({ bone: rig[key], mesh });
  }
}

function updateJointDots() {
  const v = new THREE.Vector3();
  for (const dot of jointDots) {
    v.setFromMatrixPosition(dot.bone.matrixWorld);
    dot.mesh.position.copy(v);
  }
}

// ---------- поза ----------
const lmFilter = new LandmarkFilter(33, { minCutoff: 1.2, beta: 0.04 });
const _tmpVec = new THREE.Vector3();

function unpackWorld(buf) {
  const arr = new Float32Array(buf);
  const out = [];
  for (let i = 0; i < arr.length; i += 4) {
    out.push({ x: arr[i], y: arr[i + 1], z: arr[i + 2], visibility: arr[i + 3] });
  }
  return out;
}

// Ключевые точки, по которым решаем, что человек вообще виден
const TRACK_JOINTS = [11, 12, 23, 24, 25, 26, 27, 28];

// Последние точки ног с камеры 1 (в метрах, как их видит предохранитель) и
// сглаженная длина ноги «бедро + голень». Длина ноги не зависит от ракурса,
// поэтому по ней и сравниваем камеры: если у одной 84 см, а у другой 96 —
// вторая врёт по глубине.
let lastGuardPts = null;
const cam1Leg = { l: 0, r: 0 };

function legLengths(pts) {
  const out = { l: 0, r: 0 };
  for (const side of ['l', 'r']) {
    const ids = LEG_POINTS[side];
    const hip = pts[ids.hip];
    const knee = pts[ids.knee];
    const ankle = pts[ids.ankle];
    if (!hip || !knee || !ankle) continue;
    out[side] = Math.hypot(knee.x - hip.x, knee.y - hip.y, knee.z - hip.z)
      + Math.hypot(ankle.x - knee.x, ankle.y - knee.y, ankle.z - knee.z);
  }
  return out;
}

function onPose(msg) {
  state.diagCount = msg.count;
  state.diagMs = msg.ms;
  const raw = unpackWorld(msg.world);
  if (raw.length < 33) { state.tracking = false; return; }
  // Точки кадра нужны предохранителю ног: по ним видно, что точка «дорисована»
  // (вышла за кадр) и насколько крупно нога вообще видна. Их же показывает
  // телеметрия — где ноги в кадре и не срезаны ли.
  const image = unpackWorld(msg.image);
  lastImagePts = image;
  processWorld(raw, { image });
  drawOverlay(msg.image);
}

// Единый путь обработки: подходит и для камеры, и для тестового скелета
function processWorld(raw, opts = {}) {
  const t = performance.now() / 1000;
  state.lastPoseAt = performance.now();
  // Точки кадра запоминаем до всех проверок: даже при потерянном теле телеметрия
  // должна видеть, где ноги в кадре (это про кадрирование, а не про позу).
  if (opts.image) lastImagePts = opts.image;

  let vis = 0;
  for (const i of TRACK_JOINTS) vis += raw[i].visibility ?? 1;
  vis /= TRACK_JOINTS.length;
  state.diagVis = +vis.toFixed(3);
  if (vis < 0.5) {
    state.tracking = false;
    return; // держим последнюю позу, не дёргаемся
  }
  state.tracking = true;

  const filtered = lmFilter.apply(raw, t);

  // Оценка роста человека (для масштаба). Считается всегда: масштаб нужен IK.
  standingTracker.update(filtered);

  // Жест «обе руки вверх» — запуск и остановка записи без ходьбы к ноутбуку.
  if (state.gesture && gesture.update(filtered, t)) handleGesture();

  const live = state.mode === 'live' && !(recorder && recorder.playing);
  if (live && retargeter) {
    const zGain = state.zGain;
    const pts = filtered.map((p) => landmarkToWorld(
      { x: p.x, y: p.y, z: p.z * zGain },
      state.mirror,
      new THREE.Vector3(),
    ));

    // Те же точки, но неотфильтрованные и с visibility: предохранитель ног
    // должен видеть настоящий скачок точки, а фильтр его как раз сглаживает.
    const guardPts = raw.map((p) => {
      const v = landmarkToWorld(
        { x: p.x, y: p.y, z: p.z * zGain },
        state.mirror,
        new THREE.Vector3(),
      );
      return { x: v.x, y: v.y, z: v.z, visibility: p.visibility ?? 1 };
    });

    // Снимок для сравнения с второй камерой: те же точки и сглаженная длина ноги.
    lastGuardPts = guardPts;
    const ll = legLengths(guardPts);
    for (const side of ['l', 'r']) {
      if (!ll[side]) continue;
      cam1Leg[side] = cam1Leg[side] ? cam1Leg[side] * 0.9 + ll[side] * 0.1 : ll[side];
    }

    // Ретаргет: FK по направлениям + IK по ногам + высота таза + корневое движение.
    retargeter.update(pts, {
      heightMeters: Math.max(state.heightMeters, standingTracker.heightMeters),
      followFeet: state.followHips,
      rootMotion: state.rootMotion,
      guardPoints: guardPts,
      image: opts.image,
      legGuard: state.legGuard,
      t,
    });

    // Момент, когда предохранителю пришлось держать ногу, — самое интересное для
    // разбора. Помечаем его, чтобы кадр камеры и вид персонажа снялись сразу.
    const g = retargeter.legGuard;
    if (state.legGuard && g && !(g.trusted.l && g.trusted.r)) lastBadAt = t;

    if (recorder && recorder.recording) recorder.push(t, filtered);
  }
}

// Жест сработал: включаем/выключаем запись, не отходя от места съёмки.
function handleGesture() {
  if (!recorder) return;
  if (recorder.recording) {
    recorder.stop();
    log(`Жест: запись остановлена — ${recorder.frameCount} кадр., ${recorder.duration.toFixed(1)} с`);
    return;
  }
  if (recorder.countdown > 0) {
    recorder.countdown = 0;
    updateRecUi();
    log('Жест: отсчёт отменён');
    return;
  }
  if (state.mode === 'clip') {
    if ($('btnPlay')) $('btnPlay').textContent = 'Проиграть клип FBX';
    backToLive();
  }
  if (recorder.playing) recorder.togglePlay();
  lmFilter.reset();
  recorder.beginCountdown(2.2);
  log('Жест принят: опустите руки и встаньте в позу — запись через 2 с');
  updateRecUi();
}

// Кость под тазом по имени (для сшивания BVH и модели при проверке)
const normName = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

// Тестовый скелет без камеры: проверка всего пайплайна.
// Координаты — мировые MediaPipe (метры, начало в тазу, y ВНИЗ, z ОТ камеры).
// Здесь ходьба «в камеру»: иначе не проверить ни IK по стопам, ни корневое
// движение — опорная стопа должна ехать назад относительно таза.
function syntheticPose(t) {
  const p = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.99 }));
  const set = (i, x, y, z) => { p[i].x = x; p[i].y = y; p[i].z = z; };

  const CYCLE = 1.4;   // секунд на полный цикл (два шага)
  const STRIDE = 0.11; // амплитуда стопы вперёд/назад, м
  const STANCE = 0.6;  // доля цикла, когда стопа на полу
  const FLAT = 0.86;   // высота лодыжки стоя (y вниз)

  // Ходьба: на опоре стопа едет назад (z растёт), в переносе — вперёд и вверх.
  const leg = (ph) => {
    const u = ((ph % 1) + 1) % 1;
    if (u < STANCE) {
      const s = u / STANCE;
      return { z: -STRIDE + 2 * STRIDE * s, y: FLAT };
    }
    const s = (u - STANCE) / (1 - STANCE);
    const lift = Math.sin(Math.PI * s);
    return { z: STRIDE - 2 * STRIDE * s, y: FLAT - 0.17 * lift };
  };

  const phL = t / CYCLE;
  const phR = t / CYCLE + 0.5;
  const L = leg(phL);
  const R = leg(phR);
  const bob = 0.012 * Math.sin(t / CYCLE * Math.PI * 4); // покачивание корпуса
  const wave = Math.sin(t * 1.3);

  // таз
  set(23, 0.09, bob, 0);
  set(24, -0.09, bob, 0);
  // плечи и голова
  set(11, 0.18, -0.45 + bob, 0);
  set(12, -0.18, -0.45 + bob, 0);
  set(0, 0, -0.62 + bob, -0.04);
  // левая рука машет
  set(13, 0.40, -0.42 + bob, 0.02);
  set(15, 0.48 + 0.26 * wave, -0.16 - 0.32 * wave, 0.05);
  set(19, 0.52 + 0.28 * wave, -0.11 - 0.35 * wave, 0.06);
  // правая рука вбок
  set(14, -0.40, -0.42 + bob, 0.02);
  set(16, -0.60, -0.30 + bob, 0.05);
  set(20, -0.64, -0.28 + bob, 0.06);

  // ноги: колено смещено вперёд (в MP это −z) и в сторону
  const kneeF = (l) => 0.03 + Math.max(0, FLAT - l.y) * 1.1;
  const kneeY = (l) => 0.44 - 0.3 * Math.max(0, FLAT - l.y);
  set(25, 0.11, kneeY(L), L.z - kneeF(L));
  set(27, 0.11, L.y, L.z);
  set(31, 0.11, L.y - 0.06, L.z - 0.17);
  set(29, 0.11, L.y - 0.05, L.z + 0.05);
  set(26, -0.11, kneeY(R), R.z - kneeF(R));
  set(28, -0.11, R.y, R.z);
  set(32, -0.11, R.y - 0.06, R.z - 0.17);
  set(30, -0.11, R.y - 0.05, R.z + 0.05);
  return p;
}

// ---------- оверлей с видео и точками ----------
const overlay = $('overlay');
let videoEl = null;

function drawOverlay(imageBuf) {
  if (!$('chkDebug').checked || !videoEl) return;
  paintPreview(overlay, videoEl, imageBuf);
}

// Общая отрисовка превью: видео зеркально + точки кадра. Годится обеим камерам.
function paintPreview(cv, video, imageBuf) {
  if (!cv || !video || !video.videoWidth) return;
  const g = cv.getContext('2d');
  const w = cv.width;
  const h = cv.height;
  g.save();
  g.clearRect(0, 0, w, h);

  const sc = Math.max(w / video.videoWidth, h / video.videoHeight);
  const dw = video.videoWidth * sc;
  const dh = video.videoHeight * sc;
  g.translate(w / 2, h / 2);
  g.scale(-1, 1); // зеркально, как в зеркале
  g.drawImage(video, -dw / 2, -dh / 2, dw, dh);
  g.restore();

  if (imageBuf) {
    const arr = imageBuf instanceof Float32Array ? imageBuf : new Float32Array(imageBuf);
    g.save();
    g.fillStyle = '#63e6ff';
    for (let i = 0; i < arr.length; i += 4) {
      if (arr[i + 3] < 0.4) continue;
      const x = (1 - arr[i]) * w; // зеркально
      const y = arr[i + 1] * h;
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
}

// ---------- воркер позы ----------
let worker = null;
let lastVideoTime = -1;
let pendingFrame = false;
let poseReady = false;
let useMainThread = false;
let mainLandmarker = null;

function packPoints(arr) {
  const out = [];
  for (const p of arr) out.push({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 });
  return out;
}

function startPoseWorker() {
  worker = new Worker('./src/pose.worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      poseReady = true;
      state.poseReady = true;
      log('Модель позы готова (воркер)');
    } else if (msg.type === 'pose') {
      pendingFrame = false;
      onPose(msg);
    } else if (msg.type === 'log') {
      console.log('[worker]', msg.text);
    } else if (msg.type === 'error') {
      pendingFrame = false;
      if (!poseReady && !useMainThread) fallbackToMainThread(msg.text);
      else log('Ошибка позы: ' + msg.text);
    }
  };
  worker.postMessage({
    type: 'init',
    wasmPath: CONFIG.wasmPath,
    modelPath: CONFIG.modelPath,
  });
}

// Если воркер не смог поднять MediaPipe — считаем позу в главном потоке.
// Просадка fps, зато работает всегда.
async function fallbackToMainThread(reason) {
  useMainThread = true;
  log('Воркер не смог: ' + reason + ' → считаю в главном потоке');
  try {
    const { FilesetResolver, PoseLandmarker } = await import('../vendor/mediapipe/vision_bundle.mjs');
    const vision = await FilesetResolver.forVisionTasks(CONFIG.wasmPath);
    const opts = (d) => ({
      baseOptions: { modelAssetPath: CONFIG.modelPath, delegate: d },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    try {
      mainLandmarker = await PoseLandmarker.createFromOptions(vision, opts('GPU'));
    } catch {
      mainLandmarker = await PoseLandmarker.createFromOptions(vision, opts('CPU'));
    }
    poseReady = true;
    worker.terminate();
    worker = null;
    log('Модель позы готова (главный поток)');
  } catch (err) {
    log('Поза недоступна: ' + (err?.message || err));
  }
}

function detectMainThread() {
  if (!mainLandmarker || !videoEl || videoEl.readyState < 2) return;
  if (videoEl.currentTime === lastVideoTime) return;
  lastVideoTime = videoEl.currentTime;
  try {
    const res = mainLandmarker.detectForVideo(videoEl, performance.now());
    const world = res.worldLandmarks?.[0];
    if (world && world.length >= 33) {
      processWorld(packPoints(world));
      const img = res.landmarks?.[0];
      if (img) drawOverlay(packFlat(img));
    } else {
      state.tracking = false;
    }
  } catch (err) {
    log('Ошибка позы: ' + (err?.message || err));
  }
}

function packFlat(arr) {
  const out = new Float32Array(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    out[i * 4 + 0] = arr[i].x;
    out[i * 4 + 1] = arr[i].y;
    out[i * 4 + 2] = arr[i].z;
    out[i * 4 + 3] = arr[i].visibility ?? 1;
  }
  return out;
}

function pumpVideo() {
  if (!videoEl || state.mode === 'clip' || state.synthetic) return;
  if (useMainThread) { detectMainThread(); return; }
  if (!worker) return;
  if (videoEl.readyState < 2) return;
  if (videoEl.currentTime === lastVideoTime) return;
  if (pendingFrame) return;
  lastVideoTime = videoEl.currentTime;
  pendingFrame = true;
  createImageBitmap(videoEl).then((bitmap) => {
    worker.postMessage({ type: 'frame', bitmap, ts: performance.now() }, [bitmap]);
  }).catch(() => { pendingFrame = false; });
}

// ---------- цикл ----------
let lastTime = performance.now() / 1000;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  overlay.width = 320;
  overlay.height = 240;
  trimStrip?.resize();
}

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now() / 1000;
  const dt = Math.min(0.1, now - lastTime);
  lastTime = now;

  pumpVideo();
  pumpObserver();
  const playRec = recorder && recorder.playing;
  if (state.synthetic && !playRec) processWorld(syntheticPose(now));
  if (recorder) {
    recorder.tick(dt);
    recorder.apply(dt);
  }
  if (mixer && state.mode === 'clip' && !playRec) mixer.update(dt);

  updateJointDots();
  followCamera();
  controls.update();
  renderer.render(scene, camera);
  if (state.telemetry) viewTick(now);
  updateRecState();
  telemetryTick(now);
  frameTick(now);

  // FPS
  state.frames++;
  if (now - state.fpsTime > 0.5) {
    state.fps = Math.round(state.frames / (now - state.fpsTime));
    state.frames = 0;
    state.fpsTime = now;
    updateHud();
  }
}

// Камера «следит» за персонажем, когда он уезжает от начала координат
// (корневое движение). Орбита при этом не ломается.
function followCamera() {
  if (!state.followCam || !modelRoot) return;
  const k = 0.08;
  const dx = (modelRoot.position.x - controls.target.x) * k;
  const dz = (modelRoot.position.z - controls.target.z) * k;
  if (Math.abs(dx) < 1e-5 && Math.abs(dz) < 1e-5) return;
  controls.target.x += dx;
  controls.target.z += dz;
  camera.position.x += dx;
  camera.position.z += dz;
}

let lastRecText = '';
function updateRecState() {
  const el = $('recState');
  if (!el) return;
  let txt = '—';
  if (recorder) {
    if (recorder.recording) txt = `● ${recorder.elapsed.toFixed(1)} с · ${recorder.samples.length} проб`;
    else if (recorder.countdown > 0) txt = `отсчёт ${Math.ceil(recorder.countdown)}`;
    else if (recorder.playing) txt = `▶ ${recorder.playTime.toFixed(1)} / ${recorder.duration.toFixed(1)} с`;
    else if (recorder.hasClip) txt = `${recorder.duration.toFixed(1)} с · ${recorder.frameCount} кадр.`;
    else if (state.gesture) txt = 'поднимите обе руки';
    if (gesture.active && state.gesture && !recorder.recording) {
      txt = `жест… ${Math.round(gesture.progress * 100)} %`;
    }
  }
  if (txt !== lastRecText) {
    lastRecText = txt;
    el.textContent = txt;
  }

  // подсказка по жесту
  const gh = $('gestHint');
  if (gh) {
    const on = state.gesture;
    const line = !on
      ? 'Жест выключен — запись кнопкой'
      : recorder && recorder.recording
        ? 'Поднимите обе руки, чтобы остановить'
        : recorder && recorder.countdown > 0
          ? 'Опустите руки, отсчёт идёт'
          : 'Поднимите обе руки — запись начнётся сама';
    if (gh.textContent !== line) gh.textContent = line;
    gh.classList.toggle('hot', !!(gesture.active && on));
  }

  // полоска подрезки: головка воспроизведения
  if (trimStrip && recorder && recorder.playing) trimStrip.draw();

  const cd = $('count');
  if (cd) {
    const show = recorder && recorder.countdown > 0;
    const text = show ? String(Math.ceil(recorder.countdown)) : '';
    if (show !== cd.classList.contains('on')) cd.classList.toggle('on', show);
    if (show && cd.textContent !== text) cd.textContent = text;
  }

  const camBox = $('cam');
  if (camBox) camBox.classList.toggle('rec', !!(recorder && recorder.recording));
}

function updateHud() {
  $('fps').textContent = state.fps;
  const age = performance.now() - state.lastPoseAt;
  const trackEl = $('track');
  if (state.mode === 'clip') {
    trackEl.textContent = 'клип из файла';
    trackEl.className = 'ok';
  } else if (recorder && recorder.playing) {
    trackEl.textContent = 'просмотр записи';
    trackEl.className = 'ok';
  } else if (state.tracking && age < 500) {
    trackEl.textContent = 'тело найдено';
    trackEl.className = 'ok';
  } else {
    trackEl.textContent = 'тело не видно';
    trackEl.className = 'bad';
  }
  $('bones').textContent = `${Object.keys(rig || {}).length}`;

  // Предохранитель ног: сколько доверия и почему нога «держится»
  const legsEl = $('legsInfo');
  const hintEl = $('legsHint');
  if (legsEl) {
    const g = retargeter && retargeter.legGuard;
    if (!g) {
      legsEl.textContent = '—';
      legsEl.className = '';
    } else if (!retargeter.guardEnabled) {
      legsEl.textContent = 'предохранитель выключен';
      legsEl.className = '';
    } else if (!state.tracking && state.mode === 'live') {
      legsEl.textContent = 'нет тела в кадре';
      legsEl.className = 'bad';
    } else {
      legsEl.textContent = g.describe();
      legsEl.className = g.trusted.l && g.trusted.r ? 'ok' : 'bad';
    }
    if (hintEl) {
      const h = g && retargeter.guardEnabled ? g.hint() : '';
      hintEl.textContent = h || (legsEl.className === 'bad'
        ? 'Ноги «держим»: модель не уверена в точках и держит последнюю позу'
        : 'Ноги в порядке: колени и стопы идут с камеры');
      hintEl.className = h ? 'hint hot' : 'hint';
    }
  }

  // Кадрирование: где тело в кадре и сколько запаса до краёв. Главная причина
  // поломанных ног — не модель, а край кадра, поэтому это видно всегда.
  const fInfo = $('frameInfo');
  if (fInfo) {
    const f = state.mode === 'live' && !state.synthetic ? framingReport() : null;
    const v = framingVerdict(f);
    fInfo.textContent = v.info;
    fInfo.className = v.level === 'bad' ? 'bad' : v.level === 'tight' ? 'hot' : v.level === 'ok' ? 'ok' : '';
    const fHint = $('frameHint');
    if (fHint) {
      fHint.textContent = v.hint;
      fHint.className = 'hint' + (v.level && v.level !== 'ok' ? ' hot' : '');
    }
    drawFrameBox(f, v.level);
  }

  // 2-я камера: те же цифры, что у первой — доверие ногам, размер ноги в кадре,
  // кадрирование и длина ноги. По ним и решается, помогает вторая камера или нет.
  const bState = $('camBState');
  if (bState) {
    let text = 'выкл';
    let cls = '';
    if (obs.err) {
      text = 'ошибка';
      cls = 'bad';
    } else if (obs.on) {
      const age = obs.at ? performance.now() - obs.at : Infinity;
      if (!obs.ready) {
        text = 'модель…';
      } else if (age > 1500) {
        text = `${obs.fps} к/с · нет позы`;
        cls = 'bad';
      } else {
        text = `${obs.fps} к/с · ${obs.w}×${obs.h}`;
      }
    }
    if (bState.textContent !== text) bState.textContent = text;
    bState.className = cls;
  }

  const bInfo = $('camBInfo');
  if (bInfo) {
    let text = '—';
    let cls = '';
    if (!obs.on) {
      text = '—';
    } else if (!obs.ready) {
      text = 'загружаю модель…';
    } else if (!obs.at) {
      text = 'нет позы';
      cls = 'bad';
    } else {
      text = obs.guard.describe();
      cls = obs.guard.trusted.l && obs.guard.trusted.r ? 'ok' : 'bad';
    }
    if (bInfo.textContent !== text) bInfo.textContent = text;
    bInfo.className = cls;
  }

  const bHint = $('camBHint');
  if (bHint) {
    const fB = obs.on && obs.ready ? framingReport(obs.image, obs.history) : null;
    const vB = framingVerdict(fB);
    let line = vB.hint;
    if (obs.err) line = shortError(obs.err);
    else if (!obs.on) line = '2-я камера только смотрит: персонажем управляет первая';
    else if (!obs.ready) line = 'Гружу вторую модель MediaPipe…';
    if (bHint.textContent !== line) bHint.textContent = line;
    bHint.className = 'hint' + (obs.on && vB.level && vB.level !== 'ok' ? ' hot' : '');
    drawFrameBox(fB, vB.level, 'frameBoxB');
  }

  const bDiff = $('camBDiff');
  if (bDiff) {
    const both = obs.on && obs.at && lastGuardPts && cam1Leg.l > 0 && obs.legLen.l > 0;
    if (!both) {
      if (bDiff.textContent !== '—') bDiff.textContent = '—';
    } else {
      const cm = (m) => Math.round(m * 100); // точки в метрах
      const text = `L ${cm(cam1Leg.l)}/${cm(obs.legLen.l)} · R ${cm(cam1Leg.r)}/${cm(obs.legLen.r)}`;
      if (bDiff.textContent !== text) bDiff.textContent = text;
    }
  }

  // Телеметрия: счётчик отправленных срезов
  const teleEl = $('teleState');
  if (teleEl) {
    teleEl.textContent = !state.telemetry ? 'выкл'
      : teleDown ? 'сервер не отвечает'
        : `вкл · ${teleSent}`;
    teleEl.className = teleDown && state.telemetry ? 'bad' : '';
  }

  const camEl = $('camState');
  if (state.camState === 'ok') {
    camEl.textContent = 'работает';
    camEl.className = 'ok';
  } else if (state.camState === 'fail') {
    camEl.textContent = `отказано (${state.perm})`;
    camEl.className = 'bad';
  } else {
    camEl.textContent = `выключена (${state.perm})`;
    camEl.className = '';
  }
}

// ---------- телеметрия ----------
// Единственный способ смотреть ЖИВУЮ сессию снаружи (не сидя за этим
// компьютером): раз в ~0.4 с срез уходит на сервер в POST /diag, оттуда его
// читает наблюдатель. Здесь только сбор данных — вся логика на той стороне.
let lastImagePts = null;
let lastTeleAt = 0;
let teleSent = 0;
let teleBusy = false;
let teleDown = false;
const r3 = (v) => +Number(v).toFixed(3);

// Прямоугольник группы точек в кадре: видно, где именно ноги и не срезаны ли.
function boxOf(pts, idx) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (const i of idx) {
    const p = pts[i];
    if (!p) continue;
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
    n++;
  }
  return n ? [r3(x0), r3(y0), r3(x1), r3(y1)] : null;
}

// ---------- кадрирование ----------
// Самая частая причина поломанных ног — не модель и не IK, а кадр: стопы у
// нижней кромки, голова у верхней, и на шаге точка уходит за край, где модель
// начинает её дорисовывать. Индикатор считает запас до краёв по точкам КАДРА
// (где модель видит человека, а не где мы его нарисовали) и говорит, что делать.
const SAFE_EDGE = 0.05; // минимальный запас до края, доля кадра
const FRAME_MEMORY = 5000; // мс: помним худший запас за это время
let frameHistory = [];

function framingReport(pts = lastImagePts, history = frameHistory) {
  if (!pts || pts.length < 33) return null;
  let minX = 1, maxX = 0, minY = 1, maxY = 0, n = 0, out = 0;
  for (const p of pts) {
    if (!p || (p.visibility ?? 1) < 0.5) continue;
    n++;
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) out++;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const nose = pts[0];
  if (n < 10 || !nose || (nose.visibility ?? 1) < 0.5) return null;

  // низ тела — самая низкая из видимых точек стоп
  let soleY = nose.y;
  for (const i of [29, 30, 31, 32, 27, 28]) {
    const p = pts[i];
    if (p && (p.visibility ?? 1) >= 0.5 && p.y > soleY) soleY = p.y;
  }
  const H = Math.max(0.01, soleY - nose.y);
  // макушка выше носа и подошва ниже носка — точки в 33 landmark'ах не отдают
  const top = nose.y - H * 0.07;
  const sole = soleY + H * 0.02;
  const f = {
    n,
    out,
    body: r3(sole - top), // сколько кадра занимает человек целиком
    top: r3(top),
    bottom: r3(1 - sole),
    left: r3(minX),
    right: r3(1 - maxX),
    box: [r3(minX), r3(minY), r3(maxX), r3(maxY)],
  };

  // Худшее за последние 5 с: в шаге тело поднимается выше и опускается ниже, чем
  // в стойке, и «запас сейчас» обманывает — смотреть надо на худший момент.
  const now = performance.now();
  const last = history[history.length - 1];
  if (!last || now - last.t > 150) {
    history.push({ t: now, top: f.top, bottom: f.bottom, body: f.body });
    while (history.length && now - history[0].t > FRAME_MEMORY) history.shift();
  }
  f.worstTop = Math.min(...history.map((h) => h.top));
  f.worstBottom = Math.min(...history.map((h) => h.bottom));
  f.worstBody = Math.max(...history.map((h) => h.body));
  return f;
}

// Что сказать человеку. Уровень: ok / tight / bad — тот же цвет в HUD и на схеме.
function framingVerdict(f) {
  const fit = 1 - 2 * SAFE_EDGE; // 0.9 кадра — предел с запасом 5 % по краям
  const pct = (v) => `${Math.round(Math.max(0, v) * 100)} %`;
  if (!f) {
    return {
      level: '',
      info: 'нет данных',
      hint: 'Кадр не считается: включите камеру или тестовый скелет',
    };
  }
  // срезано ли что-то сейчас или было срезано за последние 5 с
  const cutNow = f.out > 0 || f.top < 0 || f.bottom < 0;
  const cutTop = Math.max(0, -f.top, -(f.worstTop ?? f.top));
  const cutBottom = Math.max(0, -f.bottom, -(f.worstBottom ?? f.bottom));
  const cut = cutNow || cutTop > 0 || cutBottom > 0;
  const body = Math.max(f.body, f.worstBody ?? 0);
  // сколько кадра заняло бы всё тело, включая срезанное
  const extent = body + cutTop + cutBottom;
  const away = Math.max(0, Math.round((extent / fit - 1) * 100));
  const needPct = Math.min(60, Math.max(5, away)); // «отойдите на 300 %» — это уже не совет
  const stepWord = away <= 5 ? 'чуть дальше' : away <= 16 ? 'на полшага дальше' : 'на шаг дальше';
  const tight = Math.min(f.top, f.bottom);
  const worst = Math.min(f.worstTop ?? f.top, f.worstBottom ?? f.bottom);
  const wasTight = worst < tight - 0.03;

  if (cut) {
    return {
      level: cutNow ? 'bad' : 'tight',
      info: cutNow ? `${pct(body)} кадра · за краем` : `${pct(f.body)} кадра · в шаге за краем`,
      hint: cutNow
        ? `Тело не влезает в кадр: отойдите ${stepWord} (примерно на ${needPct} % дальше) — срезанное модель дорисовывает.`
        : `В стойке тело влезает, но в движении выходит за край: отойдите ${stepWord} (примерно на ${needPct} % дальше).`,
    };
  }
  if (body > fit) {
    return {
      level: 'tight',
      info: `${pct(body)} кадра · запас ${pct(tight)}${wasTight ? ` · в шаге ${pct(worst)}` : ''}`,
      hint: `Тело занимает ${pct(body)} кадра, для запаса нужно до ${pct(fit)}: отойдите ${stepWord}.`,
    };
  }
  if (f.bottom < SAFE_EDGE && f.top >= SAFE_EDGE) {
    return {
      level: 'tight',
      info: `снизу ${pct(f.bottom)} · тело ${pct(f.body)}`,
      hint: 'Стопы у нижнего края: наклоните камеру ниже (или опустите её) — на шаге ступня выйдет за край.',
    };
  }
  if (f.top < SAFE_EDGE && f.bottom >= SAFE_EDGE) {
    return {
      level: 'tight',
      info: `сверху ${pct(f.top)} · тело ${pct(f.body)}`,
      hint: 'Голова у верхнего края: наклоните камеру выше (или поднимите её).',
    };
  }
  if (Math.min(f.left, f.right) < SAFE_EDGE * 0.6) {
    return {
      level: 'tight',
      info: `по бокам ${pct(Math.min(f.left, f.right))}`,
      hint: 'Руки почти у края кадра: чуть дальше или разверните камеру.',
    };
  }
  return {
    level: 'ok',
    info: `${pct(f.body)} кадра · сверху ${pct(f.top)} · снизу ${pct(f.bottom)}${wasTight ? ` · в шаге ${pct(worst)}` : ''}`,
    hint: wasTight
      ? 'В стойке запас есть, но в движении край близко: чуть дальше — и шаг перестанет выходить за кадр.'
      : 'Всё тело в кадре с запасом — ноги не ломаются.',
  };
}

// Схема кадра: где человек и где безопасная зона
function drawFrameBox(f, level, canvasId = 'frameBox') {
  const cv = $(canvasId);
  if (!cv) return;
  const g = cv.getContext('2d');
  const w = cv.width;
  const h = cv.height;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#0b0f16';
  g.fillRect(0, 0, w, h);

  // безопасная зона
  const m = SAFE_EDGE;
  g.strokeStyle = '#2b3a55';
  g.lineWidth = 1;
  g.setLineDash([4, 4]);
  g.strokeRect(0.5, m * h + 0.5, w - 1, (1 - 2 * m) * h - 1);
  g.setLineDash([]);

  if (!f) return;
  const col = level === 'bad' ? '#ff7b72' : level === 'tight' ? '#ffd166' : '#7ee787';
  const x0 = Math.max(-0.15, f.box[0]) * w;
  const x1 = Math.min(1.15, f.box[2]) * w;
  const y0 = Math.max(-0.15, f.top) * h;
  const y1 = Math.min(1.15, 1 - f.bottom) * h;
  g.fillStyle = col + '22';
  g.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  g.strokeStyle = col;
  g.lineWidth = 2;
  g.strokeRect(x0 + 1, y0 + 1, Math.max(1, x1 - x0 - 2), Math.max(1, y1 - y0 - 2));
}

function telemetryPayload(now) {
  const g = retargeter && retargeter.legGuard;
  const wp = (name) => {
    const b = rig && rig[name];
    if (!b) return null;
    const v = b.getWorldPosition(new THREE.Vector3());
    return [r3(v.x), r3(v.y), r3(v.z)];
  };
  const p = modelRoot ? modelRoot.position : null;
  const img = lastImagePts;
  const feet = img
    ? { l: img[27] ? [r3(img[27].x), r3(img[27].y)] : null, r: img[28] ? [r3(img[28].x), r3(img[28].y)] : null }
    : null;
  return {
    t: r3(now),
    mode: state.mode, tracking: state.tracking, synthetic: state.synthetic,
    fps: state.fps, inferMs: state.diagMs, inferN: state.diagCount, visAvg: state.diagVis,
    video: videoEl ? [videoEl.videoWidth, videoEl.videoHeight] : null,
    heightM: r3(state.heightMeters), estM: r3(standingTracker.heightMeters),
    scaleK: r3((retargeter && retargeter.scaleK) || 0), zGain: state.zGain, mirror: state.mirror,
    root: p ? [r3(p.x), r3(p.y), r3(p.z)] : null,
    guard: g ? g.snapshot() : null,
    legs: { hip: wp('hips'), kneeL: wp('lLeg'), footL: wp('lFoot'), kneeR: wp('rLeg'), footR: wp('rFoot') },
    // Точки ног как их вернула модель, в координатах кадра:
    // [x, y, видимость] по порядку [таз, колено, лодыжка, носок].
    legJoints: img
      ? {
        l: [23, 25, 27, 31].map((i) => (img[i] ? [r3(img[i].x), r3(img[i].y), r3(img[i].visibility ?? 1)] : null)),
        r: [24, 26, 28, 32].map((i) => (img[i] ? [r3(img[i].x), r3(img[i].y), r3(img[i].visibility ?? 1)] : null)),
      }
      : null,
    img: img
      ? {
        body: boxOf(img, [0, 11, 12, 15, 16, 23, 24, 27, 28, 31, 32]),
        legL: boxOf(img, [23, 25, 27, 29, 31]),
        legR: boxOf(img, [24, 26, 28, 30, 32]),
        feet,
      }
      : null,
    // Кадрирование: запас до краёв кадра и вердикт (ok/tight/bad) — то, что
    // решает, будут ли ноги целыми.
    frame: (() => {
      const f = framingReport();
      const v = framingVerdict(f);
      return f ? { ...f, level: v.level } : null;
    })(),
    // Длина ноги «бедро + голень» (м) по камере 1 — с ней сравнивается вторая.
    legLen: { l: r3(cam1Leg.l), r: r3(cam1Leg.r) },
    // 2-я камера: наблюдатель. Свои цифры, чтобы потом решать по ним, а не по
    // ощущению «вроде лучше».
    cam2: (() => {
      if (!obs.on) return null;
      const fB = framingReport(obs.image || [], obs.history);
      const vB = framingVerdict(fB);
      return {
        on: true,
        ready: obs.ready,
        fps: obs.fps,
        ms: r3(obs.ms),
        vis: obs.vis,
        video: [obs.w, obs.h],
        ageMs: obs.at ? Math.round(performance.now() - obs.at) : null,
        err: obs.err || null,
        trust: obs.guard.snapshot(),
        legLen: { l: r3(obs.legLen.l), r: r3(obs.legLen.r) },
        frame: fB ? { ...fB, level: vB.level } : null,
        img: obs.image
          ? {
            body: boxOf(obs.image, [0, 11, 12, 15, 16, 23, 24, 27, 28, 31, 32]),
            legL: boxOf(obs.image, [23, 25, 27, 29, 31]),
            legR: boxOf(obs.image, [24, 26, 28, 30, 32]),
          }
          : null,
      };
    })(),
  };
}

function telemetryTick(now) {
  if (!state.telemetry || teleBusy) return;
  if (now - lastTeleAt < 0.4) return; // now — секунды с запуска страницы
  lastTeleAt = now;
  teleBusy = true;
  fetch('/diag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(telemetryPayload(now)),
  }).then((r) => {
    teleDown = !r.ok;
    if (r.ok) teleSent++;
    const el = $('teleState');
    if (el && state.telemetry) el.textContent = `вкл · ${teleSent} срезов · ${framesSent} кадров · ${viewsSent} видов · ${badShots} сбоев`;
  }).catch(() => { teleDown = true; }).finally(() => { teleBusy = false; });
}

// Раз в секунду уходит маленький кадр: видео + точки модели на нём. По нему
// снаружи видно и кадрирование, и куда именно модель ставит колени и стопы.
// Плюс «кадр беды»: как только предохранитель ног перестал верить точке, кадр
// снимается немедленно (kind=bad) — именно он объясняет, почему нога «залипла».
let lastFrameAt = 0;
let lastBadAt = 0;
let lastBadShotAt = 0;
let frameCanvas = null;
let frameCtx = null;
let frameBusy = false;
let framesSent = 0;
let badShots = 0;

function frameTick(now) {
  if (!state.telemetry || frameBusy || !videoEl || !videoEl.videoWidth) return;
  const bad = now - lastBadAt < 0.4 && now - lastBadShotAt > 0.8;
  if (!bad && now - lastFrameAt < 1.0) return;
  if (bad) { lastBadShotAt = now; badShots++; viewForce = true; } else lastFrameAt = now;
  if (!frameCanvas) {
    frameCanvas = document.createElement('canvas');
    frameCanvas.width = 320;
    frameCanvas.height = 180;
    frameCtx = frameCanvas.getContext('2d');
  }
  const w = frameCanvas.width;
  const h = frameCanvas.height;
  frameCtx.drawImage(videoEl, 0, 0, w, h);
  // точки кадра — ровно то, что вернула модель (не скелет персонажа)
  if (lastImagePts) {
    frameCtx.fillStyle = '#7ee787';
    for (const i of [0, 11, 12, 23, 24]) {
      const p = lastImagePts[i];
      if (p) frameCtx.fillRect(p.x * w - 1, p.y * h - 1, 3, 3);
    }
    for (const i of [25, 26, 27, 28, 29, 30, 31, 32]) {
      const p = lastImagePts[i];
      if (!p) continue;
      frameCtx.fillStyle = '#ffd166';
      frameCtx.beginPath();
      frameCtx.arc(p.x * w, p.y * h, 2.4, 0, Math.PI * 2);
      frameCtx.fill();
    }
  }
  frameCanvas.toBlob((blob) => {
    if (!blob) return;
    frameBusy = true;
    fetch(`/frame?kind=${bad ? 'bad' : 'cam'}&t=${now.toFixed(1)}`, { method: 'POST', body: blob })
      .then((r) => { if (r.ok) framesSent++; })
      .catch(() => {})
      .finally(() => { frameBusy = false; });
  }, 'image/jpeg', 0.7);
}

// Раз в секунду уходит картинка самого 3D-вида: так снаружи видно, что именно
// получилось у персонажа (ноги в воздухе, выворот колена, залипание), а не только
// числа. Кадр берётся сразу после renderer.render — иначе WebGL-буфер уже пуст.
let lastViewAt = 0;
let viewCanvas = null;
let viewCtx = null;
let viewBusy = false;
let viewsSent = 0;
let viewForce = false;

function viewTick(now) {
  if (viewBusy) return;
  const forced = viewForce && now - lastViewAt > 0.8;
  if (!forced && now - lastViewAt < 1.0) return;
  viewForce = false;
  const gl = renderer && renderer.domElement;
  if (!gl || !gl.width) return;
  lastViewAt = now;
  if (!viewCanvas) {
    viewCanvas = document.createElement('canvas');
    viewCanvas.width = 640;
    viewCanvas.height = 360;
    viewCtx = viewCanvas.getContext('2d');
  }
  try {
    viewCtx.drawImage(gl, 0, 0, viewCanvas.width, viewCanvas.height);
  } catch (e) {
    return;
  }
  viewCanvas.toBlob((blob) => {
    if (!blob) return;
    viewBusy = true;
    fetch(`/frame?kind=${forced ? 'badview' : 'view'}&t=${now.toFixed(1)}`, { method: 'POST', body: blob })
      .then((r) => { if (r.ok) viewsSent++; })
      .catch(() => {})
      .finally(() => { viewBusy = false; });
  }, 'image/jpeg', 0.72);
}

function telemetryToggle(on) {
  state.telemetry = on;
  const btn = $('btnTele');
  if (btn) btn.textContent = on ? 'Телеметрия: вкл' : 'Телеметрия: выкл';
  if (on) {
    // начинаем с чистого листа: иначе старые срезы смешаются с новыми
    fetch('/diag', { method: 'DELETE' }).catch(() => {});
    teleSent = 0;
    teleDown = false;
    log('Телеметрия включена: срез раз в 0.4 с уходит на /diag');
  } else {
    log('Телеметрия выключена');
  }
  const el = $('teleState');
  if (el) el.textContent = on ? `вкл · ${teleSent}` : 'выкл';
}

// ---------- камеры ----------
let camStream = null;

function fillCamSel(sel, list, prefer) {
  if (!sel) return;
  const cur = sel.value;
  sel.textContent = '';
  if (!list.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'камеры не найдены';
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const c of list) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.label;
    sel.appendChild(o);
  }
  if (cur && list.some((c) => c.id === cur)) sel.value = cur;
  else if (prefer && list.some((c) => c.id === prefer)) sel.value = prefer;
}

async function refreshCameras() {
  const sel = $('camPick');
  const list = await listCameras();
  fillCamSel(sel, list, list[0]?.id);
  // По умолчанию вторая камера — не та, что выбрана первой: одну и ту же
  // камеру дважды не открыть, и это самая частая ошибка при двух камерах.
  if (list.length) {
    const first = sel.value || list[0].id;
    const other = list.find((c) => c.id !== first) || list[0];
    fillCamSel($('camPickB'), list, other.id);
  } else {
    fillCamSel($('camPickB'), list, null);
  }
}

async function turnOnCamera() {
  $('btnCam').disabled = true;
  state.perm = await permissionState();
  try {
    const cam = await startCamera({ deviceId: $('camPick').value || undefined });
    videoEl = cam.video;
    camStream = cam.stream;
    state.camState = 'ok';
    log(`Камера: ${cam.label} ${cam.width}x${cam.height}`);
    await refreshCameras(); // после разрешения появляются настоящие названия
  } catch (err) {
    state.camState = 'fail';
    log('Камера: ' + describeCameraError(err));
    console.warn('[mocap] getUserMedia', err);
  }
  $('btnCam').disabled = false;
  updateHud();
}

// ---------- вторая камера: наблюдатель ----------
// Пока НЕ управляет персонажем. Цель — увидеть по числам, что она реально даёт,
// и только потом решать про слияние. Поэтому у неё своя модель MediaPipe (свой
// воркер), свой предохранитель ног и своё кадрирование: иначе «лучше/хуже»
// решается на глаз, а не по цифрам.
const obs = {
  on: false,
  video: null,
  stream: null,
  label: '',
  w: 0,
  h: 0,
  worker: null,
  ready: false,
  pending: false,
  deviceId: '',
  lastVideoTime: -1,
  guard: new LegGuard(),
  world: null,
  image: null,
  at: 0,
  ms: 0,
  seen: 0,
  fps: 0,
  fpsTime: 0,
  vis: 0,
  err: '',
  history: [], // своя память кадрирования
  legLen: { l: 0, r: 0 },
};

// В HUD — только первая фраза ошибки: остальное уходит в лог/статус.
function shortError(text) {
  const first = String(text).split('. ')[0];
  return first.length > 110 ? first.slice(0, 108) + '…' : first;
}

function obsStartWorker() {
  if (obs.worker) return;
  obs.worker = new Worker('./src/pose.worker.js', { type: 'module' });
  obs.worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      obs.ready = true;
      log('2-я камера: модель позы готова');
    } else if (msg.type === 'pose') {
      obs.pending = false;
      onObsPose(msg);
    } else if (msg.type === 'log') {
      console.log('[worker2]', msg.text);
    } else if (msg.type === 'error') {
      obs.pending = false;
      obs.err = msg.text;
      log('2-я камера, поза: ' + msg.text);
    }
  };
  obs.worker.postMessage({ type: 'init', wasmPath: CONFIG.wasmPath, modelPath: CONFIG.modelPath });
}

// Одна поза со второй камеры: доверие ногам, длины ног, точки на превью.
function onObsPose(msg) {
  const t = performance.now() / 1000;
  const raw = unpackWorld(msg.world);
  if (raw.length < 33) return; // пустой кадр — ждём следующий
  const image = msg.image && msg.image.byteLength ? unpackWorld(msg.image) : null;
  obs.world = raw;
  obs.image = image;
  obs.at = performance.now();
  if (msg.ms) obs.ms = msg.ms;

  let vis = 0;
  for (const i of TRACK_JOINTS) vis += raw[i].visibility ?? 1;
  obs.vis = +(vis / TRACK_JOINTS.length).toFixed(3);

  // В те же координаты, что и камера 1: доверие и длины ног считаются одинаково.
  const pts = raw.map((p) => {
    const v = landmarkToWorld({ x: p.x, y: p.y, z: p.z * state.zGain }, state.mirror, new THREE.Vector3());
    return { x: v.x, y: v.y, z: v.z, visibility: p.visibility ?? 1 };
  });
  obs.guard.update(pts, image, t);

  const ll = legLengths(pts);
  for (const side of ['l', 'r']) {
    if (!ll[side]) continue;
    obs.legLen[side] = obs.legLen[side] ? obs.legLen[side] * 0.9 + ll[side] * 0.1 : ll[side];
  }

  paintPreview($('overlayB'), obs.video, msg.image);

  obs.seen++;
  if (!obs.fpsTime) obs.fpsTime = t;
  else if (t - obs.fpsTime > 0.5) {
    obs.fps = Math.round(obs.seen / (t - obs.fpsTime));
    obs.seen = 0;
    obs.fpsTime = t;
  }
}

function pumpObserver() {
  if (!obs.on || !obs.ready || obs.pending || !obs.video || !obs.worker) return;
  const v = obs.video;
  if (v.readyState < 2) return;
  if (v.currentTime === obs.lastVideoTime) return;
  obs.lastVideoTime = v.currentTime;
  obs.pending = true;
  // Превью рисуем сразу по видео, не дожидаясь позы: если модель никого не
  // найдёт, в окошке всё равно должно быть видно, что снимает камера.
  paintPreview($('overlayB'), v, null);
  createImageBitmap(v).then((bitmap) => {
    obs.worker?.postMessage({ type: 'frame', bitmap, ts: performance.now() }, [bitmap]);
  }).catch(() => { obs.pending = false; });
}

async function turnOnCameraB() {
  const btn = $('btnCamB');
  if (obs.on) { stopObserver(); return; }

  const id = $('camPickB')?.value || undefined;
  const idA = $('camPick')?.value || undefined;
  if (id && idA && id === idA) {
    obs.err = 'это та же камера, что и первая';
    log('2-я камера: выбрана та же камера — выберите другую (телефон или вторую вебку)');
    updateHud();
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const cam = await startCamera({ deviceId: id, width: 640, height: 480, videoEl: $('video2') });
    obs.video = cam.video;
    obs.stream = cam.stream;
    obs.label = cam.label;
    obs.w = cam.width;
    obs.h = cam.height;
    obs.on = true;
    obs.err = '';
    obs.deviceId = id || '';
    obs.lastVideoTime = -1;
    obs.guard.reset();
    obs.history = [];
    obs.legLen = { l: 0, r: 0 };
    obs.seen = 0;
    obs.fpsTime = 0;
    obs.fps = 0;
    obs.at = 0;
    $('camB')?.classList.add('on');
    obsStartWorker(); // вторая модель MediaPipe — только когда камера уже открылась
    log(`2-я камера: ${cam.label} ${cam.width}x${cam.height}`);
    await refreshCameras();
  } catch (err) {
    obs.err = describeCameraError(err);
    log('2-я камера: ' + obs.err);
    console.warn('[mocap] getUserMedia 2', err);
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = obs.on ? 'Выключить 2-ю камеру' : 'Включить 2-ю камеру';
  }
  updateHud();
}

function stopObserver() {
  obs.on = false;
  obs.err = '';
  if (obs.stream) stopCamera(obs.stream);
  obs.stream = null;
  obs.video = null;
  obs.world = null;
  obs.image = null;
  obs.at = 0;
  obs.legLen = { l: 0, r: 0 };
  obs.history = [];
  obs.guard.reset();
  $('camB')?.classList.remove('on');
  const btn = $('btnCamB');
  if (btn) btn.textContent = 'Включить 2-ю камеру';
  log('2-я камера: выключена');
  updateHud();
}

// ---------- запись и экспорт ----------

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// BVH — в метрах: Blender импортирует файл как есть, без ручного масштаба.
function bvhOptions() {
  const s = new THREE.Vector3(1, 1, 1);
  modelRoot.getWorldScale(s);
  const unitScale = modelHeight > 20 ? 0.01 : 1; // модель в сантиметрах → метры
  return {
    bones: recorder.bones,
    frames: recorder.clip(),
    fps: recorder.fps,
    unitScale,
    rootScale: s.x,
  };
}

function exportBvh() {
  if (!recorder?.hasClip) return;
  const text = buildBVH(bvhOptions());
  downloadText(`mocap-${stamp()}.bvh`, text);
  log(`BVH сохранён: ${recorder.frameCount} кадров, ${recorder.duration.toFixed(1)} с`);
}

// Метаданные отчёта: они же уходят в JSON рядом с точками (для офлайн-разбора
// и для генерации скриптов постобработки в Blender).
function jsonMeta() {
  const q = qualityReport();
  const k = cmScale();
  const perMeter = modelHeight > 20 ? 100 : 1;
  const loop = state.loop && recorder.inFrame === state.loop.start &&
      recorder.outFrame === state.loop.start + state.loop.length - 1
    ? {
        period: +state.loop.period.toFixed(3),
        seamAvgDeg: +state.loop.seamAvgDeg.toFixed(2),
      }
    : null;
  return {
    mirror: state.mirror,
    zGain: state.zGain,
    model: decodeURI(CONFIG.rigUrl),
    quality: {
      contacts: q.contacts,
      contactSeconds: q.contactSeconds,
      maxFootSlideCm: +(q.slideSingle * k).toFixed(2),
      maxFootSlideBothCm: +(q.slide * k).toFixed(2),
      driftCm: +(q.drift * k).toFixed(2),
      maxRootSpeedMs: +(q.maxSpeed / perMeter).toFixed(2),
      minFootY: +q.minFootY.toFixed(3),
      footBelowFloorCm: +Math.max(0, -q.minFootAboveFloor * k).toFixed(2),
    },
    loop,
    polish: state.polish || null,
  };
}

function exportJson() {
  if (!recorder?.hasClip) return;
  const text = buildLandmarkJson(recorder, jsonMeta());
  downloadText(`mocap-${stamp()}.json`, text, 'application/json');
  log(`Точки сохранены: ${recorder.frameCount} кадров`);
}

// Проверка BVH: читаем свой же файл BVHLoader'ом, ставим те же кадры и
// сравниваем мировые позиции костей с моделью. Ловит ошибки порядка каналов
// и знаков углов — то, что глазами не видно, а в Blender вылезет.
async function checkBVH() {
  if (!recorder?.hasClip) return { error: 'нет записи' };
  const opts = bvhOptions();
  const text = buildBVH(opts);

  let parsed;
  try {
    parsed = new BVHLoader().parse(text);
  } catch (err) {
    return { error: 'BVH не читается: ' + (err?.message || err) };
  }
  const { skeleton, clip } = parsed;
  // BVHLoader не задаёт duration: он получается равным времени последнего кадра,
  // а миксер в режиме повтора на этой точке «заворачивает» клип в нулевой кадр —
  // последний кадр сравнивался бы с первым. Удлиняем на волосок: тогда любой
  // кадр читается ровно тем, чем записан.
  clip.duration += 1e-3;

  const holder = new THREE.Group();
  holder.add(skeleton.bones[0]);
  const mixer = new THREE.AnimationMixer(holder);
  mixer.clipAction(clip).play();

  const bones = recorder.bones;
  const hips = bones[0];
  const byName = new Map(skeleton.bones.map((b) => [normName(b.name), b]));
  const pairs = bones
    .map((b) => [b, byName.get(normName(b.name))])
    .filter(([, bb]) => bb);

  const frames = opts.frames;
  const step = Math.max(1, Math.floor(frames.length / 10));
  const idx = [];
  for (let i = 0; i < frames.length; i += step) idx.push(i);
  if (idx[idx.length - 1] !== frames.length - 1) idx.push(frames.length - 1); // последний — всегда
  const v = new THREE.Vector3();
  const w = new THREE.Vector3();

  let maxErr = 0;
  let sum = 0;
  let n = 0;
  let worst = '';
  let worstFrame = -1;
  let worstModel = null;
  let worstBvh = null;
  let checked = 0;
  const frameErrs = [];

  for (const i of idx) {
    const f = frames[i];
    checked++;
    let fe = 0;

    for (let k = 0; k < bones.length; k++) bones[k].quaternion.fromArray(f.quats, k * 4);
    modelRoot.position.fromArray(f.root);
    modelRoot.updateMatrixWorld(true);
    hips.getWorldPosition(v);

    mixer.setTime(f.t);
    skeleton.bones[0].updateMatrixWorld(true);
    skeleton.bones[0].getWorldPosition(w);

    for (const [mb, bb] of pairs) {
      if (bb.name === skeleton.bones[0].name) continue;
      const m = mb.getWorldPosition(new THREE.Vector3()).sub(v).multiplyScalar(opts.unitScale);
      const b = bb.getWorldPosition(new THREE.Vector3()).sub(w);
      const err = m.distanceTo(b);
      sum += err;
      n++;
      if (err > fe) fe = err;
      if (err > maxErr) {
        maxErr = err;
        worst = mb.name;
        worstFrame = i;
        worstModel = m.toArray();
        worstBvh = b.toArray();
      }
    }
    frameErrs.push([i, +(fe * 100).toFixed(2)]);
  }

  return {
    frames: checked,
    bones: pairs.length,
    maxErrCm: +(maxErr * 100).toFixed(2),
    meanErrCm: +(sum / Math.max(1, n) * 100).toFixed(3),
    worst,
    worstFrame,
    worstModel,
    worstBvh,
    frameErrs,
  };
}

// ---------- шлифовка записи ----------
// Единицы модели: у Mixamo это сантиметры, у glTF — метры. Для подписей приводим к см.
function cmScale() {
  return modelHeight > 20 ? 1 : 100;
}

// Допуск «стопа на полу» — 3 % длины ноги, как в корневом движении.
function plantEpsValue() {
  const leg = retargeter?.legSpan || 95;
  return leg * 0.03;
}

// Высота четырёх костей стопы над полом в rest-позе — в том же порядке, что и
// frame.feet: [лодыжка L, носок L, лодыжка R, носок R]. По ней считается, какая
// точка стопы провалилась ниже пола (пол — это y = 0 после fitScene).
function footRestY() {
  const r = restPose?.rest;
  return ['lFoot', 'lToe', 'rFoot', 'rToe'].map((key) => +((r?.[key]?.worldPos?.y) ?? 0).toFixed(3));
}

let polishUndo = null; // { before, after } — для отмены шлифовки

function qualityReport() {
  return analyze(recorder.rawClip(), {
    plantEps: plantEpsValue(),
    fps: recorder.fps,
    restY: footRestY(),
  });
}

function doPolish() {
  if (!recorder?.hasClip) return;
  const wantSmooth = $('chkPolishSmooth').checked;
  const wantPin = $('chkPolishPin').checked;
  const wantDrift = $('chkPolishDrift').checked;
  const wantFloor = $('chkPolishFloor')?.checked ?? false;
  if (!wantSmooth && !wantPin && !wantDrift && !wantFloor) {
    log('Шлифовка: выберите хотя бы один проход');
    return;
  }

  const k = cmScale();
  const eps = plantEpsValue();
  const before = recorder.frames;
  const parts = [];
  let frames = before;

  if (wantSmooth) {
    const r = smoothFrames(frames, { window: 3 });
    frames = r.frames;
    const nb = Math.max(1, recorder.bones.length);
    parts.push(`дрожь ${(r.jerkBefore / nb).toFixed(2)}° → ${(r.jerkAfter / nb).toFixed(2)}°`);
  }
  if (wantPin) {
    const c = footContacts(frames, { plantEps: eps, fps: recorder.fps });
    const r = pinFeet(frames, c);
    frames = r.frames;
    parts.push(`стопы ${(r.slideBefore * k).toFixed(1)} → ${(r.slideAfter * k).toFixed(1)} см (контактов ${c.intervals.length})`);
    if (r.maxJump * k > 2) parts.push(`ступеньки корня до ${(r.maxJump * k).toFixed(1)} см`);
  }
  if (wantDrift) {
    const r = removeDrift(frames);
    frames = r.frames;
    parts.push(`дрейф ${(r.driftBefore * k).toFixed(1)} → ${(r.driftAfter * k).toFixed(1)} см`);
  }
  // Пол — последним: он единственный двигает вверх и должен остаться гарантией.
  if (wantFloor) {
    const r = clearFloor(frames, { restY: footRestY(), maxLift: (retargeter?.legSpan || 95) * 0.3 });
    frames = r.frames;
    if (r.lifted) {
      parts.push(`пол ${(r.penetrationBefore * k).toFixed(1)} → ${(r.penetrationAfter * k).toFixed(1)} см (подъём до ${(r.maxLift * k).toFixed(1)} см)`);
      if (r.clamped) parts.push(`в ${r.clamped} кадрах упёрлось в предел — осталось ${(r.penetrationAfter * k).toFixed(1)} см`);
    } else {
      parts.push('пол: стопы не проваливались');
    }
  }

  polishUndo = { before, after: frames };
  recorder.replaceFrames(frames, { keepTrim: true });
  // Итог считаем по конечным кадрам: приклейка стоп и «шаг на месте» тянут
  // в разные стороны (по определению: стоящий на месте персонаж не может
  // нести опорную стопу вместе с собой), и это должно быть видно числом.
  const fin = analyze(frames, { plantEps: eps, fps: recorder.fps, restY: footRestY() });
  state.polish = {
    passes: [wantSmooth && 'smooth', wantPin && 'pinFeet', wantDrift && 'removeDrift', wantFloor && 'clearFloor'].filter(Boolean),
    slideCm: +(fin.slideSingle * k).toFixed(2),
    driftCm: +(fin.drift * k).toFixed(2),
    footBelowFloorCm: +Math.max(0, -fin.minFootAboveFloor * k).toFixed(2),
  };
  log(`Шлифовка: ${parts.join(' · ')} → итог: скольжение ${(fin.slideSingle * k).toFixed(1)} см, дрейф ${(fin.drift * k).toFixed(1)} см`);
}

function undoPolish() {
  if (!polishUndo || recorder.frames !== polishUndo.after) return;
  recorder.replaceFrames(polishUndo.before, { keepTrim: true });
  polishUndo = null;
  state.polish = null;
  log('Шлифовка отменена');
}

// Выровнять петлю: найти период движения и окно с минимальным расхождением поз.
// Это подрезка, а не порча кадров — видно и отменяется ручками.
function doAlignLoop() {
  if (!recorder?.hasClip) return;
  const r = alignLoop(recorder.frames, { fps: recorder.fps });
  if (r.error) {
    log('Петля: ' + r.error);
    return;
  }
  recorder.setTrim(r.start, r.start + r.length - 1);
  state.loop = r;
  log(
    `Петля: период ${r.period.toFixed(2)} с (совпадение ${(r.score * 100).toFixed(0)} %), ` +
    `кадры ${r.start}–${r.start + r.length - 1}, стык ${r.seamAvgDeg.toFixed(1)}°`,
  );
}

// ---------- UI ----------
function updateRecUi() {
  if (!recorder) return;
  const b = $('btnRec');
  b.textContent = recorder.recording ? '■ Стоп' : recorder.countdown > 0 ? 'Отмена' : '● Записать';
  $('btnPlayRec').textContent = recorder.playing ? '⏸ Остановить запись' : '▶ Проиграть запись';
  $('btnPlayRec').disabled = !recorder.hasClip;
  $('btnBvh').disabled = !recorder.hasClip;
  $('btnJson').disabled = !recorder.hasClip;
  $('btnBvhCheck').disabled = !recorder.hasClip;
  renderSegments();
  updateTrimUi();
  updatePolishUi();
}

// Шлифовка: кнопки + сводка по качеству записи
function updatePolishUi() {
  if (!recorder) return;
  // шлифовка относится к конкретным кадрам: если кадры другие — отмена недействительна
  if (polishUndo && recorder.frames !== polishUndo.after) {
    polishUndo = null;
    state.polish = null;
  }
  const has = recorder.hasClip;
  const undoBtn = $('btnPolishUndo');
  const alignBtn = $('btnLoopAlign');
  if (undoBtn) undoBtn.disabled = !(polishUndo && recorder.frames === polishUndo.after);
  if (alignBtn) alignBtn.disabled = !has;
  const btn = $('btnPolish');
  if (btn) btn.disabled = !has;
  const qEl = $('quality');
  if (qEl) {
    if (!has) {
      qEl.textContent = 'записи нет';
    } else {
      const q = qualityReport();
      const k = cmScale();
      const below = Math.max(0, -q.minFootAboveFloor * k);
      qEl.textContent =
        `${q.frames} кадр. · ${q.contacts} контактов (${q.contactSeconds} с) · ` +
        `скольжение ${(q.slideSingle * k).toFixed(1)} см · дрейф ${(q.drift * k).toFixed(1)} см` +
        (below > 0.5 ? ` · под полом ${below.toFixed(1)} см` : '');
    }
  }
}

// Полоска подрезки: цифры + сброс
function updateTrimUi() {
  if (!recorder) return;
  const info = $('trimInfo');
  if (info) {
    if (!recorder.hasClip) info.textContent = '—';
    else {
      const a = recorder.inFrame / recorder.fps;
      const b = recorder.outFrame / recorder.fps;
      const kept = recorder.trimmed ? ' · подрезано' : '';
      info.textContent = `${a.toFixed(2)} – ${b.toFixed(2)} с · ${recorder.frameCount} кадр.${kept}`;
    }
  }
  const rst = $('btnTrimReset');
  if (rst) rst.disabled = !recorder.trimmed;
  trimStrip?.draw();
}

// Фрагменты записи: если человек выходил из кадра, клип разрезан на куски.
function renderSegments() {
  const box = $('segs');
  if (!box || !recorder) return;
  if (recorder.segments.length < 2) {
    box.textContent = '';
    box.style.display = 'none';
    return;
  }
  box.style.display = 'flex';
  box.textContent = '';
  const label = document.createElement('span');
  label.className = 'k';
  label.textContent = recorder.lost > 0.05 ? `фрагменты (потеряно ${recorder.lost.toFixed(1)} с):` : 'фрагменты:';
  box.appendChild(label);
  recorder.segments.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'seg' + (i === recorder.activeSegment ? ' on' : '');
    btn.textContent = `${i + 1} · ${(s.frames.length / recorder.fps).toFixed(1)}с`;
    btn.title = 'Выбрать этот фрагмент';
    btn.addEventListener('click', () => recorder.setSegment(i));
    box.appendChild(btn);
  });
}

function backToLive() {
  if (!clipAction) return;
  state.mode = 'live';
  clipAction.paused = true;
  lmFilter.reset();
  standingTracker.reset();
  retargeter?.resetRoot();
}

function wireUi() {
  $('btnCam').addEventListener('click', turnOnCamera);

  $('camPick').addEventListener('change', async () => {
    if (state.camState !== 'ok') return;
    // Вторая камера могла занять именно это устройство — освобождаем его.
    if (obs.on && obs.deviceId && obs.deviceId === $('camPick').value) {
      log('2-я камера: устройство занято первой камерой — выключаю наблюдателя');
      stopObserver();
    }
    stopCamera(camStream);
    camStream = null;
    await turnOnCamera();
  });

  $('btnCamB').addEventListener('click', turnOnCameraB);

  // Телефон как веб-камера появляется в системе не сразу: без этого список
  // камер пришлось бы обновлять перезагрузкой страницы.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    refreshCameras().catch(() => {});
  });

  $('btnPlay').addEventListener('click', () => {
    if (!clipAction) return;
    if (state.mode === 'live') {
      if (recorder) recorder.playing = false;
      state.mode = 'clip';
      clipAction.paused = false;
      $('btnPlay').textContent = 'Живой захват';
    } else {
      $('btnPlay').textContent = 'Проиграть клип FBX';
      backToLive();
      log('Живой захват');
    }
    updateRecUi();
  });

  $('btnCal').addEventListener('click', () => {
    standingTracker.reset();
    lmFilter.reset();
    retargeter?.resetRoot();
    log('Калибровка сброшена — встаньте ровно');
  });

  $('chkMirror').addEventListener('change', (e) => { state.mirror = e.target.checked; });
  $('chkFollow').addEventListener('change', (e) => { state.followHips = e.target.checked; });
  $('chkRootMotion').addEventListener('change', (e) => {
    state.rootMotion = e.target.checked;
    if (!state.rootMotion) retargeter?.resetRoot();
  });
  $('chkFootLock').addEventListener('change', (e) => {
    state.footLock = e.target.checked;
    if (retargeter) retargeter.footLock = state.footLock;
  });
  $('chkLegGuard').addEventListener('change', (e) => {
    state.legGuard = e.target.checked;
    if (retargeter) retargeter.guardEnabled = state.legGuard;
    if (!state.legGuard) retargeter?.legGuard.reset();
  });
  $('chkFollowCam').addEventListener('change', (e) => { state.followCam = e.target.checked; });
  $('btnTele').addEventListener('click', () => telemetryToggle(!state.telemetry));
  $('zGain').addEventListener('input', (e) => { state.zGain = Number(e.target.value); });
  $('height').addEventListener('input', (e) => {
    state.heightMeters = Number(e.target.value);
    $('heightVal').textContent = state.heightMeters.toFixed(2);
  });

  // ---- запись ----
  $('btnRec').addEventListener('click', () => {
    if (!recorder) return;
    if (recorder.recording) {
      recorder.stop();
      log(`Запись: ${recorder.frames.length} кадров, ${recorder.duration.toFixed(1)} с`);
      return;
    }
    if (recorder.countdown > 0) {
      recorder.countdown = 0;
      updateRecUi();
      log('Запись отменена');
      return;
    }
    if (state.mode === 'clip') {
      if ($('btnPlay')) $('btnPlay').textContent = 'Проиграть клип FBX';
      backToLive();
    }
    if (recorder.playing) recorder.togglePlay();
    lmFilter.reset();
    recorder.beginCountdown(3.2);
    log('Приготовьтесь: запись через 3 секунды');
  });

  $('btnPlayRec').addEventListener('click', () => {
    if (!recorder?.hasClip) return;
    if (state.mode === 'clip') {
      if ($('btnPlay')) $('btnPlay').textContent = 'Проиграть клип FBX';
      backToLive();
    }
    recorder.togglePlay();
    if (recorder.playing) {
      lmFilter.reset();
      standingTracker.reset();
      retargeter?.resetRoot();
      log(`Проигрываю запись по кругу: ${recorder.duration.toFixed(1)} с`);
    } else {
      log('Воспроизведение записи остановлено');
    }
  });

  $('btnBvh').addEventListener('click', exportBvh);
  $('btnJson').addEventListener('click', exportJson);
  $('chkLoopFade').addEventListener('change', (e) => {
    if (!recorder) return;
    recorder.loopFade = e.target.checked; // сшивка считается на лету
    recorder.onChange();
  });
  $('chkGesture').addEventListener('change', (e) => {
    state.gesture = e.target.checked;
    gesture.reset();
    log(state.gesture ? 'Жест включён: руки вверх — старт/стоп' : 'Жест выключен');
  });
  $('btnTrimReset').addEventListener('click', () => {
    recorder?.resetTrim();
    log('Подрезка сброшена');
  });
  $('btnPolish').addEventListener('click', doPolish);
  $('btnPolishUndo').addEventListener('click', undoPolish);
  $('btnLoopAlign').addEventListener('click', doAlignLoop);
  $('btnBvhCheck').addEventListener('click', async () => {
    const r = await checkBVH();
    log(r.error ? `Проверка BVH: ${r.error}` : `BVH ок · кадров ${r.frames} · костей ${r.bones} · макс. ошибка ${r.maxErrCm} см · средняя ${r.meanErrCm} см`);
  });

  $('btnTest').addEventListener('click', () => {
    state.synthetic = !state.synthetic;
    if (!state.synthetic) { lmFilter.reset(); standingTracker.reset(); retargeter?.resetRoot(); }
    $('btnTest').textContent = state.synthetic ? 'Тест ВЫКЛ' : 'Тест без камеры';
    state.lastPoseAt = performance.now();
    log(state.synthetic ? 'Тестовый скелет (ходьба)' : 'Ожидание камеры');
  });
}

// ---------- старт ----------
(async function main() {
  resize();
  window.addEventListener('resize', resize);
  wireUi();

  // отладочный доступ из консоли
  window.__mocap = {
    state, scene, camera, THREE,
    get rig() { return rig; },
    get rest() { return restPose; },
    get retargeter() { return retargeter; },
    get legGuard() { return retargeter ? retargeter.legGuard : null; },
    get recorder() { return recorder; },
    get gesture() { return gesture; },
    get trimStrip() { return trimStrip; },
    get model() { return modelRoot; },
    syntheticPose,
    // Прогнать произвольный набор точек через тот же путь, что и камеру
    // (второй аргумент — точки кадра: по ним предохранитель ног видит, что
    //  точка вышла за кадр, и насколько крупно нога видна)
    feed: (points, image) => processWorld(points, { image }),
    gestureFromPose: (points) => gesture.update(points, performance.now() / 1000),
    checkBVH,
    telemetryToggle,
    telemetryPayload,
    frameTick,
    get framesSent() { return framesSent; },
    get viewsSent() { return viewsSent; },
    get badShots() { return badShots; },
    doPolish,
    undoPolish,
    doAlignLoop,
    qualityReport,
    framingReport,
    framingVerdict,
    // 2-я камера-наблюдатель: цифры и отладочные входы
    obs,
    turnOnCameraB,
    stopObserver,
    obsStartWorker,
    obsFeed: (world, image) => onObsPose({ world: packFlat(world), image: packFlat(image || []) }),
    get cam1Leg() { return cam1Leg; },
    legLengths,
    polishLib: { analyze, alignLoop, pinFeet, removeDrift, smoothFrames, footContacts, clearFloor },
    footRestY,
    bvhText: () => (recorder?.hasClip ? buildBVH(bvhOptions()) : ''),
    jsonText: () => (recorder?.hasClip ? buildLandmarkJson(recorder, jsonMeta()) : ''),
    // Прогнать статичную картинку через тот же путь, что и камеру
    testFrame: async (url) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const bitmap = await createImageBitmap(img);
      if (!worker) return 'нет воркера';
      worker.postMessage({ type: 'frame', bitmap, ts: performance.now() }, [bitmap]);
      return 'отправлено';
    },
    boneWorld: (name) => {
      const b = rig?.[name];
      return b ? new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).toArray() : null;
    },
    // Автотест записи на синтетическом скелете
    testRecord: async (seconds = 3) => {
      state.synthetic = true;
      lmFilter.reset();
      standingTracker.reset();
      recorder.start(performance.now() / 1000);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      recorder.stop();
      return {
        samples: recorder.samples.length,
        frames: recorder.frames.length,
        duration: +recorder.duration.toFixed(2),
      };
    },
  };

  startPoseWorker();
  await loadRig();
  state.perm = await permissionState();
  await refreshCameras();
  updateHud();
  loop();
})();
