// Экспорт записи в BVH (Biovision Hierarchy).
//
// Почему BVH: это простой текстовый формат, который нативно понимает Blender
// (File → Import → Motion Capture (.bvh)), а из Blender уже делается FBX для
// Unity/Unreal. Писать FBX прямо в браузере (родной или ASCII) — лишний риск.
//
// Детали формата:
//  • BVH — Y-up, правая система координат, как и three.js.
//  • Порядок каналов вращения берём такой, как пишет сам Blender:
//    'Zrotation Xrotation Yrotation' = R = Rz · Rx · Ry, то есть Euler 'ZXY'.
//    three.js читает его так же (см. BVHLoader: rotation.multiply(quat) по списку).
//  • OFFSET — локальное смещение кости в rest-позе. У корня (таз) OFFSET = 0,
//    а положение едет позиционными каналами: так скелет стоит в начале координат,
//    а анимация несёт смещение персонажа.
import * as THREE from 'three';

const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

function fmt(v, scale) {
  const x = (Number.isFinite(v) ? v : 0) * scale;
  const r = Math.round(x * 1e5) / 1e5;
  return Object.is(r, -0) ? '0' : String(r);
}

const R2D = 180 / Math.PI;

// Кватернион → три угла в порядке каналов BVH (Z, X, Y), в градусах.
// Порядок 'ZXY' в three даёт R = Rz · Rx · Ry — ровно то, что читает Blender.
function pushEuler(q, row) {
  _euler.setFromQuaternion(q, 'ZXY');
  row.push(
    (_euler.z * R2D).toFixed(4),
    (_euler.x * R2D).toFixed(4),
    (_euler.y * R2D).toFixed(4),
  );
}

export function buildBVH({ bones, frames, fps = 30, unitScale = 1, rootScale = 1 }) {
  if (!bones?.length || !frames?.length) return '';

  const set = new Set(bones);
  const idx = new Map();
  bones.forEach((b, i) => idx.set(b, i));

  const isEnd = (b) => /_End$/i.test(b.name);
  const show = (b) => set.has(b) && !isEnd(b);
  const offScale = unitScale * rootScale;
  const boneName = (b) => String(b.name || 'joint').replace(/[\s:]+/g, '_');

  const out = ['HIERARCHY'];
  const root = bones[0];

  const joint = (bone, depth, isRoot) => {
    const pad = '  '.repeat(depth);
    out.push(`${pad}${isRoot ? 'ROOT' : 'JOINT'} ${boneName(bone)}`);
    out.push(`${pad}{`);

    if (isRoot) {
      out.push(`${pad}  OFFSET 0 0 0`);
      out.push(`${pad}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`);
    } else {
      out.push(`${pad}  OFFSET ${fmt(bone.position.x, offScale)} ${fmt(bone.position.y, offScale)} ${fmt(bone.position.z, offScale)}`);
      out.push(`${pad}  CHANNELS 3 Zrotation Xrotation Yrotation`);
    }

    const kids = bone.children.filter((c) => c.isBone);
    const shown = kids.filter(show);

    if (shown.length) {
      for (const k of shown) joint(k, depth + 1, false);
    } else {
      // Концевая точка: до последней (_End) кости, если она есть.
      const end = kids.find(isEnd);
      const e = end ? end.position : new THREE.Vector3(0, 1, 0);
      out.push(`${pad}  End Site`);
      out.push(`${pad}  {`);
      out.push(`${pad}    OFFSET ${fmt(e.x, offScale)} ${fmt(e.y, offScale)} ${fmt(e.z, offScale)}`);
      out.push(`${pad}  }`);
    }

    out.push(`${pad}}`);
  };

  joint(root, 0, true);

  out.push('MOTION');
  out.push(`Frames: ${frames.length}`);
  out.push(`Frame Time: ${(1 / fps).toFixed(7)}`);

  const body = bones.slice(1);
  const bodyIdx = body.map((b) => idx.get(b));

  for (const f of frames) {
    const row = [];
    const hp = f.hipsWorld || [0, 0, 0];
    row.push(fmt(hp[0], unitScale), fmt(hp[1], unitScale), fmt(hp[2], unitScale));

    _quat.set(...(f.hipsQuat || [0, 0, 0, 1]));
    _quat.normalize();
    pushEuler(_quat, row);

    for (let k = 0; k < body.length; k++) {
      const i = bodyIdx[k];
      _quat.set(f.quats[i * 4], f.quats[i * 4 + 1], f.quats[i * 4 + 2], f.quats[i * 4 + 3]);
      _quat.normalize();
      pushEuler(_quat, row);
    }

    out.push(row.join(' '));
  }

  return out.join('\n') + '\n';
}

// Точки MediaPipe из записи → JSON для оффлайн-ретаргета.
export function buildLandmarkJson(rec, meta = {}) {
  return JSON.stringify({
    format: 'mocap-landmarks',
    version: 1,
    createdAt: new Date().toISOString(),
    fps: rec.fps,
    frames: rec.frameCount,
    duration: +rec.duration.toFixed(3),
    warmupTrimmed: rec.warmup,
    segments: rec.segments.length,
    trim: { inFrame: rec.inFrame, outFrame: rec.outFrame },
    index: {
      0: 'nose', 7: 'left_ear', 8: 'right_ear',
      11: 'left_shoulder', 12: 'right_shoulder', 13: 'left_elbow', 14: 'right_elbow',
      15: 'left_wrist', 16: 'right_wrist', 19: 'left_index', 20: 'right_index',
      23: 'left_hip', 24: 'right_hip', 25: 'left_knee', 26: 'right_knee',
      27: 'left_ankle', 28: 'right_ankle', 29: 'left_heel', 30: 'right_heel',
      31: 'left_foot_index', 32: 'right_foot_index',
    },
    note: 'world landmarks MediaPipe: метры, начало координат в середине таза, y вниз, z от камеры',
    ...meta,
    landmarks: rec.landmarksJson(),
  });
}

export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
