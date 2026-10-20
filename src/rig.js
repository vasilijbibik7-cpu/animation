// Поиск костей скелета Mixamo, калибровка rest-позы (T-pose из файла)
// и запасной скелет, если FBX не загрузился.
import * as THREE from 'three';

// Короткие имена костей Mixamo, которые нам нужны.
// Полные имена в three выглядят как 'mixamorigHips' (двоеточие вырезается
// санитайзером FBXLoader), поэтому ищем по окончанию имени.
export const BONE_KEYS = {
  hips: 'Hips',
  spine: 'Spine',
  spine1: 'Spine1',
  spine2: 'Spine2',
  neck: 'Neck',
  head: 'Head',
  lShoulder: 'LeftShoulder',
  lArm: 'LeftArm',
  lForeArm: 'LeftForeArm',
  lHand: 'LeftHand',
  rShoulder: 'RightShoulder',
  rArm: 'RightArm',
  rForeArm: 'RightForeArm',
  rHand: 'RightHand',
  lUpLeg: 'LeftUpLeg',
  lLeg: 'LeftLeg',
  lFoot: 'LeftFoot',
  lToe: 'LeftToeBase',
  rUpLeg: 'RightUpLeg',
  rLeg: 'RightLeg',
  rFoot: 'RightFoot',
  rToe: 'RightToeBase',
};

// Пальцы: 4 кости на палец (у большого тоже 4), 5 пальцев на руку.
// Короткие ключи: lThumb1 … rPinky4 — по ним же строятся цели ретаргета.
export const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
for (const side of ['Left', 'Right']) {
  const s = side === 'Left' ? 'l' : 'r';
  for (const f of FINGER_NAMES) {
    for (let j = 1; j <= 4; j++) BONE_KEYS[`${s}${f}${j}`] = `${side}Hand${f}${j}`;
  }
}

export function findRig(root) {
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });

  const rig = {};
  for (const [key, short] of Object.entries(BONE_KEYS)) {
    const cands = bones.filter((b) => b.name.endsWith(short));
    if (cands.length) {
      // самое короткое имя = самая точная кость (Spine раньше Spine1)
      cands.sort((a, b) => a.name.length - b.name.length);
      rig[key] = cands[0];
    }
  }
  return { bones, rig };
}

function worldQuatOf(obj) {
  return new THREE.Quaternion().setFromRotationMatrix(obj.matrixWorld);
}

// Снимок rest-позы: локальные кватернионы всех костей, направления кость→ребёнок
// в системе координат родителя и базис таза. Считается ОДИН раз до проигрывания
// любых анимаций.
export function captureRest(root, rig) {
  root.updateMatrixWorld(true);

  const localQuats = new Map();
  const rest = {};

  root.traverse((o) => {
    if (o.isBone) localQuats.set(o, o.quaternion.clone());
  });

  for (const [key, bone] of Object.entries(rig)) {
    let child = bone.children.find((c) => c.isBone);
    // Кисть: направление задаёт ладонь (запястье → основание среднего пальца),
    // а не первый ребёнок — у Mixamo это большой палец.
    if (key === 'lHand' || key === 'rHand') {
      const mid = rig[key[0] + 'Middle1'];
      if (mid) child = mid;
    }
    const worldPos = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
    const parentWorldQuat = bone.parent ? worldQuatOf(bone.parent) : new THREE.Quaternion();

    let dirParent = null;
    if (child) {
      const childPos = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld);
      const dir = childPos.sub(worldPos).normalize();
      dirParent = dir.applyQuaternion(parentWorldQuat.clone().invert()).normalize();
    }

    rest[key] = {
      localQuat: bone.quaternion.clone(),
      worldQuat: worldQuatOf(bone),
      worldPos,
      parentWorldQuat,
      dirParent,
    };
  }

  // Базис таза в rest-позе: x — ось бёдер (левое минус правое), y — вверх по спине.
  const hipsBasis = restBasis(rest.hips?.worldPos, rest.lUpLeg?.worldPos, rest.rUpLeg?.worldPos, rest.spine2?.worldPos || rest.spine1?.worldPos || rest.spine?.worldPos);

  return { localQuats, rest, hipsBasis };
}

function restBasis(hipsPos, lHip, rHip, chest) {
  if (!hipsPos || !lHip || !rHip || !chest) return new THREE.Quaternion();
  const x = new THREE.Vector3().subVectors(lHip, rHip).normalize();
  const y = new THREE.Vector3().subVectors(chest, hipsPos).normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  const y2 = new THREE.Vector3().crossVectors(z, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y2, z);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

// Запасной скелет с именами Mixamo — если FBX не найден, приложение всё равно
// покажет захват (стик-скелет).
export function buildFallbackRig() {
  const group = new THREE.Group();
  group.name = 'FallbackRig';

  const mk = (name, parent, len, dir) => {
    const b = new THREE.Bone();
    b.name = 'mixamorig' + name;
    b.position.copy(dir).multiplyScalar(len);
    parent.add(b);
    return b;
  };

  const UP = new THREE.Vector3(0, 1, 0);
  const DOWN = new THREE.Vector3(0, -1, 0);
  const X = new THREE.Vector3(1, 0, 0);

  const hips = new THREE.Bone();
  hips.name = 'mixamorigHips';
  hips.position.set(0, 0.9, 0);
  group.add(hips);

  const spine = mk('Spine', hips, 0.18, UP);
  const spine1 = mk('Spine1', spine, 0.18, UP);
  const spine2 = mk('Spine2', spine1, 0.18, UP);
  const neck = mk('Neck', spine2, 0.12, UP);
  mk('Head', neck, 0.18, UP);

  for (const [side, sx] of [['Left', 1], ['Right', -1]]) {
    const sh = mk(side + 'Shoulder', spine2, 0.14, new THREE.Vector3(sx, 0.2, 0).normalize());
    const arm = mk(side + 'Arm', sh, 0.26, new THREE.Vector3(sx, 0, 0));
    const fore = mk(side + 'ForeArm', arm, 0.24, new THREE.Vector3(sx, 0, 0));
    mk(side + 'Hand', fore, 0.09, new THREE.Vector3(sx, 0, 0));

    const up = mk(side + 'UpLeg', hips, 0.42, new THREE.Vector3(sx * 0.18, -1, 0).normalize());
    const leg = mk(side + 'Leg', up, 0.40, DOWN);
    const foot = mk(side + 'Foot', leg, 0.12, new THREE.Vector3(0, -0.4, 0.9).normalize());
    mk(side + 'ToeBase', foot, 0.12, new THREE.Vector3(0, 0, 1));
  }

  return group;
}
