// Ретаргет: 33 точки MediaPipe → кватернионы костей скелета Mixamo.
//
// 1) FK-проход: работаем ТОЛЬКО с направлениями костей, а не с длинами.
//    Для каждой кости известно её rest-направление «кость → ребёнок» в системе
//    координат родителя. Направление-цель берётся из landmark'ов, переводится в
//    систему родителя (уже с его НОВЫМ поворотом) и берётся кратчайший поворот
//    между rest и целью. Поэтому несовпадение пропорций не мешает.
// 2) IK-проход по ногам (foot-lock): целевая позиция стопы берётся из точек
//    (метры, относительно таза), масштабируется под модель, прижимается к полу и
//    решается двухзвенная IK. Это убирает «всплывание» стоп.
// 3) Корневое движение: пока стопа стоит на полу, смещение таза относительно неё
//    и есть движение персонажа вперёд.
import * as THREE from 'three';
import { LegGuard } from './legs.js';

// Как распределить общий наклон корпуса по трём суставам спины: доля поворота,
// накопленная к этому суставу. 0.5 / 0.8 / 1.0 — спина гнётся дугой, а не
// щёлкает одним суставом.
const SPINE_SPLIT = [['spine', 0.5], ['spine1', 0.8], ['spine2', 1.0]];

// Индексы точек MediaPipe Pose (33 шт.)
export const MP = {
  nose: 0,
  lEar: 7, rEar: 8,
  lShoulder: 11, rShoulder: 12,
  lElbow: 13, rElbow: 14,
  lWrist: 15, rWrist: 16,
  lIndex: 19, rIndex: 20,
  lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26,
  lAnkle: 27, rAnkle: 28,
  lHeel: 29, rHeel: 30,
  lFoot: 31, rFoot: 32,
};

// Мировые координаты MediaPipe (метры, начало в тазу, y вниз, z от камеры вглубь)
// → координаты three.js (y вверх, z на камеру).
export function landmarkToWorld(p, mirror, out) {
  out.set(mirror ? -p.x : p.x, -p.y, -p.z);
  return out;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Retargeter {
  constructor(rig, rest, hipsBasis, opts = {}) {
    this.rig = rig;
    this.rest = rest;
    this.hipsBasis = hipsBasis || new THREE.Quaternion();
    this.rootWorldQuat = new THREE.Quaternion();
    this.rootWorldQuatInv = new THREE.Quaternion();
    this.restLocal = new Map();
    this._keys = new Map();
    for (const [k, b] of Object.entries(rig)) this._keys.set(b, k);

    this.modelRoot = null;
    this.scaleK = 1; // «метры человека» → «единицы модели»
    // Средний человек: таз→лодыжка по вертикали ≈ 0.49 роста.
    // Если задать рост, масштаб не зависит от позы (широкая стойка больше
    // не «раздувает» персонажа).
    this.heightMeters = opts.heightMeters ?? 1.75;
    this.followFeet = opts.followFeet ?? true;
    this.baseRootY = 0;
    this.hipsOffsetY = 0;
    this.rootReady = false;

    // Длины звеньев ног и высота стопы над полом в rest-позе
    this.legs = {};
    for (const side of ['l', 'r']) {
      const upper = rest[side + 'UpLeg'];
      const lower = rest[side + 'Leg'];
      const foot = rest[side + 'Foot'];
      if (!upper || !lower || !foot) continue;
      this.legs[side] = {
        L1: upper.worldPos.distanceTo(lower.worldPos),
        L2: lower.worldPos.distanceTo(foot.worldPos),
      };
    }
    this.restAnkleY = 0;
    const ankles = ['l', 'r'].map((s) => rest[s + 'Foot']).filter(Boolean);
    if (ankles.length) {
      this.restAnkleY = ankles.reduce((s, a) => s + a.worldPos.y, 0) / ankles.length;
    }
    this.restHipsY = rest.hips?.worldPos?.y ?? 0;

    this.footLock = opts.footLock ?? true;
    const legSpan = Math.max(1e-3, this.restHipsY - this.restAnkleY);
    this.legSpan = legSpan;
    // «Стоит на полу» = лодыжка на полной длине ноги ниже таза; допуск 3 % роста.
    this.rootMotion = new RootMotionTracker({ plantEps: legSpan * 0.03 });

    // Направления костей ног в rest-позе, но в МИРОВЫХ осях: нужно, чтобы
    // удерживаемая нога могла расслабиться в нейтральную стойку.
    this.restWorldDir = new Map();
    for (const [key, r] of Object.entries(rest)) {
      if (r.dirParent && r.parentWorldQuat) {
        this.restWorldDir.set(
          key,
          r.dirParent.clone().applyQuaternion(r.parentWorldQuat).normalize(),
        );
      }
    }

    // Предохранитель ног: пока точки на ноге не заслуживают доверия, IK этой
    // ноги не применяется — держим последнюю нормальную позу (в системе таза).
    this.guardEnabled = opts.legGuard !== false;
    this.legGuard = new LegGuard(opts.legGuardOpts || {});
    this.heldLegs = { l: null, r: null };
    this.poleSmooth = { l: null, r: null };

    // Скольжение опорной стопы: пока стопа стоит, её мировая точка не должна
    // ехать. Скорость в единицах модели в секунду (см/с для Mixamo-модели).
    this.slipRate = { l: 0, r: 0 };
    this._footPrev = { l: null, r: null };
  }

  // Вызывать после добавления модели в сцену.
  setRoot(root) {
    this.modelRoot = root;
    root.updateMatrixWorld(true);
    const hips = this.rig.hips;
    if (!hips) return;
    const parent = hips.parent;
    this.rootWorldQuat = parent
      ? new THREE.Quaternion().setFromRotationMatrix(parent.matrixWorld)
      : new THREE.Quaternion();
    this.rootWorldQuatInv.copy(this.rootWorldQuat).invert();
    this.baseRootY = root.position.y;
    this.hipsOffsetY = this.restHipsY - this.baseRootY;
    this.restLocal.clear();
    root.traverse((o) => {
      if (o.isBone) this.restLocal.set(o, o.quaternion.clone());
    });
  }

  // Поза «человека нет в кадре». Берём первый кадр клипа, а не rest-позу:
  // T-поза посреди работы выглядит как поломка.
  captureRelaxPose() {
    const map = new Map();
    for (const key of Object.keys(this.rig)) {
      const bone = this.rig[key];
      if (bone) map.set(bone, bone.quaternion.clone());
    }
    this.relaxPose = map;
  }

  // Тело пропало из кадра: плавно уводим управляемые кости в rest-позу,
  // а не держим кадр замороженным. Возвращает true, пока ещё есть куда идти.
  relax(dt = 0.016) {
    if (!this.modelRoot) return false;
    const k = 1 - Math.exp(-dt / 0.35);
    let moving = false;
    for (const key of Object.keys(this.rig)) {
      const bone = this.rig[key];
      if (!bone) continue;
      const target = (this.relaxPose && this.relaxPose.get(bone)) || this.restLocal.get(bone);
      if (!target) continue;
      bone.quaternion.slerp(target, k);
      if (bone.quaternion.angleTo(target) > 0.004) moving = true;
    }
    const dy = this.baseRootY - this.modelRoot.position.y;
    if (Math.abs(dy) > 1e-4) {
      this.modelRoot.position.y += dy * k;
      moving = true;
    }
    this.modelRoot.updateMatrixWorld(true);
    return moving;
  }

  resetRoot() {    this.rootMotion.reset();
    this.rootReady = false;
    this.legGuard.reset();
    this.heldLegs = { l: null, r: null };
    this.poleSmooth = { l: null, r: null };
    if (this.modelRoot) {
      this.modelRoot.position.x = 0;
      this.modelRoot.position.z = 0;
      this.modelRoot.position.y = this.baseRootY;
    }
  }

  // points — 33 точки уже в координатах three.js (метры, относительно таза).
  // opts.heightMeters — рост человека (масштаб), opts.followFeet — держать таз
  // над полом, opts.rootMotion — горизонтальное корневое движение.
  update(points, opts = {}) {
    const rig = this.rig;
    const rest = this.rest;
    if (!rig.hips || !this.modelRoot) return null;

    const P = (i) => points[i];
    const t = opts.t ?? performance.now() / 1000;

    // Доверие к ногам считаем раньше всего: от него зависят и IK, и высота таза,
    // и корневое движение. guardPoints — «сырые» точки (фильтр сглаживает
    // скачки, а нам нужен именно скачок).
    const trusted = this.guardEnabled && opts.legGuard !== false
      ? this.legGuard.update(opts.guardPoints || points, opts.image, t)
      : { l: true, r: true };
    const midHip = new THREE.Vector3(
      (P(MP.lHip).x + P(MP.rHip).x) / 2,
      (P(MP.lHip).y + P(MP.rHip).y) / 2,
      (P(MP.lHip).z + P(MP.rHip).z) / 2,
    );
    const midSho = new THREE.Vector3(
      (P(MP.lShoulder).x + P(MP.rShoulder).x) / 2,
      (P(MP.lShoulder).y + P(MP.rShoulder).y) / 2,
      (P(MP.lShoulder).z + P(MP.rShoulder).z) / 2,
    );
    const dir = (a, b) => new THREE.Vector3(
      P(b).x - P(a).x, P(b).y - P(a).y, P(b).z - P(a).z,
    );

    // ---- масштаб: метры человека → единицы модели ----
    // Рост (а не текущая поза!) задаёт масштаб: при широкой стойке таз
    // опускается, но персонаж не раздувается.
    const height = clamp(opts.heightMeters || this.heightMeters, 1.0, 2.4);
    this.scaleK = this.legSpan / (0.49 * height);

    // ---- локальные цели стоп (относительно таза, в единицах модели) ----
    const localAnkle = {
      l: dir(MP.lHip, MP.lAnkle).add(new THREE.Vector3(
        P(MP.lHip).x - midHip.x, P(MP.lHip).y - midHip.y, P(MP.lHip).z - midHip.z,
      )).multiplyScalar(this.scaleK),
      r: dir(MP.rHip, MP.rAnkle).add(new THREE.Vector3(
        P(MP.rHip).x - midHip.x, P(MP.rHip).y - midHip.y, P(MP.rHip).z - midHip.z,
      )).multiplyScalar(this.scaleK),
    };

    // ---- высота таза: самая низкая стопа ставится на пол ----
    // Это и «приседания», и широкая стойка, и всё остальное: абсолютной высоты
    // в точках MediaPipe нет, но низкая стопа всегда на полу.
    if (opts.followFeet ?? this.followFeet) {
      // Ноги, которым не верим, высоту таза не задают: иначе мусорная лодыжка
      // поднимет или уронит персонажа.
      const ys = [];
      if (trusted.l) ys.push(localAnkle.l.y);
      if (trusted.r) ys.push(localAnkle.r.y);
      if (ys.length) {
        const want = this.restAnkleY - Math.min(...ys) - this.hipsOffsetY;
        const lo = this.baseRootY - this.legSpan * 0.8;
        const hi = this.baseRootY + this.legSpan * 0.35;
        const targetY = clamp(want, lo, hi);
        // первый кадр после сброса — сразу на место, дальше мягко
        const k = this.rootReady ? 0.3 : 1;
        this.rootReady = true;
        this.modelRoot.position.y += (targetY - this.modelRoot.position.y) * k;
      }
    }

    // ---- корневое движение (до IK: оно меняет положение таза в мире) ----
    if (opts.rootMotion !== false) {
      const off = this.rootMotion.update(localAnkle, this.scaleK, trusted);
      this.modelRoot.position.x = off.x;
      this.modelRoot.position.z = off.z;
    }
    this.modelRoot.updateMatrixWorld(true);

    // ---- направления-цели (мировые), единичные ----
    const targets = {
      spine: new THREE.Vector3().subVectors(midSho, midHip).normalize(),
      neck: dir(MP.lShoulder, MP.nose).add(dir(MP.rShoulder, MP.nose)).multiplyScalar(0.5).normalize(),
      lArm: dir(MP.lShoulder, MP.lElbow).normalize(),
      lForeArm: dir(MP.lElbow, MP.lWrist).normalize(),
      rArm: dir(MP.rShoulder, MP.rElbow).normalize(),
      rForeArm: dir(MP.rElbow, MP.rWrist).normalize(),
      lUpLeg: dir(MP.lHip, MP.lKnee).normalize(),
      lLeg: dir(MP.lKnee, MP.lAnkle).normalize(),
      rUpLeg: dir(MP.rHip, MP.rKnee).normalize(),
      rLeg: dir(MP.rKnee, MP.rAnkle).normalize(),
      lFoot: dir(MP.lAnkle, MP.lFoot).normalize(),
      rFoot: dir(MP.rAnkle, MP.rFoot).normalize(),
    };

    // Спина: общий наклон раскладываем на три сустава. Иначе весь наклон
    // приходится на Spine, а Spine1/Spine2 стоят доской и торс не гнётся.
    const spineRest = this.restWorldDir.get('spine');
    if (spineRest) {
      const qTotal = new THREE.Quaternion().setFromUnitVectors(spineRest, targets.spine);
      const qPart = new THREE.Quaternion();
      for (const [key, f] of SPINE_SPLIT) {
        const base = this.restWorldDir.get(key);
        if (!base) continue;
        qPart.identity().slerp(qTotal, f);
        targets[key] = base.clone().applyQuaternion(qPart).normalize();
      }
    }

    // ---- базис таза: x — ось бёдер, y — вверх по корпусу ----
    const xAxis = new THREE.Vector3(
      P(MP.lHip).x - P(MP.rHip).x,
      P(MP.lHip).y - P(MP.rHip).y,
      P(MP.lHip).z - P(MP.rHip).z,
    ).normalize();
    const yRaw = new THREE.Vector3().subVectors(midSho, midHip).normalize();
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yRaw).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    const curBasis = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis),
    );
    const delta = curBasis.clone().multiply(this.hipsBasis.clone().invert());

    // ---- FK-проход сверху вниз ----
    const worldQ = new Map();
    const tmpQ = new THREE.Quaternion();

    const walk = (bone) => {
      if (!bone.isBone) return;
      const key = this._keys.get(bone);
      const restLocal = this.restLocal.get(bone) || bone.quaternion.clone();
      const parentQ = bone.parent && bone.parent.isBone && worldQ.has(bone.parent)
        ? worldQ.get(bone.parent)
        : this.rootWorldQuat;

      if (key === 'hips') {
        const qWorld = delta.clone().multiply(rest.hips.worldQuat);
        bone.quaternion.copy(this.rootWorldQuatInv.clone().multiply(qWorld));
        worldQ.set(bone, this.rootWorldQuat.clone().multiply(bone.quaternion));
      } else if (key && targets[key] && rest[key] && rest[key].dirParent) {
        const dTargetParent = targets[key].clone()
          .applyQuaternion(parentQ.clone().invert())
          .normalize();
        tmpQ.setFromUnitVectors(rest[key].dirParent, dTargetParent);
        bone.quaternion.copy(tmpQ).multiply(restLocal);
        worldQ.set(bone, parentQ.clone().multiply(bone.quaternion));
      } else {
        bone.quaternion.copy(restLocal);
        worldQ.set(bone, parentQ.clone().multiply(bone.quaternion));
      }

      for (const child of bone.children) walk(child);
    };
    walk(rig.hips);

    const info = { delta, targets, worldQ, ik: null, guard: this.legGuard };
    if (this.footLock) {
      info.ik = this.solveLegs(points, delta, midHip, worldQ, { trusted, t, fwd: zAxis });
    }
    return info;
  }

  // Двухзвенная IK по ногам + прижим стопы к полу.
  solveLegs(points, delta, midHip, worldQ, ctx = {}) {
    const rig = this.rig;
    const P = (i) => points[i];
    const trusted = ctx.trusted || { l: true, r: true };
    const t = ctx.t ?? performance.now() / 1000;
    const fwd = ctx.fwd || null;
    // мировые матрицы после FK (позиции костей от поворотов не зависят)
    rig.hips.updateMatrixWorld(true);

    const result = {};
    const v = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const pole = new THREE.Vector3();
    const kneeTarget = new THREE.Vector3();

    for (const side of ['l', 'r']) {
      const leg = this.legs[side];
      const upper = rig[side + 'UpLeg'];
      const lower = rig[side + 'Leg'];
      const foot = rig[side + 'Foot'];
      if (!leg || !upper || !lower || !foot) continue;

      const hipsQ = worldQ.get(rig.hips);
      const hipsQInv = hipsQ.clone().invert();

      // ---- ноге сейчас не верим: держим последнюю нормальную позу --------
      // Поза хранится в системе таза, поэтому корпус может продолжать
      // двигаться и поворачиваться, а нога едет вместе с ним. Со временем
      // расслабляем ногу в нейтральную стойку, чтобы персонаж не замер
      // навсегда в позе посреди шага.
      if (!trusted[side]) {
        const restLocalDir = (name) => {
          const r = this.restWorldDir.get(side + name);
          return r ? r.clone().applyQuaternion(hipsQInv).normalize() : null;
        };
        const held = this.heldLegs[side] || {};
        const u = this.legGuard.relax(side, t);
        const pick = (h, name) => {
          const to = restLocalDir(name);
          if (!h) return to;
          if (u <= 0 || !to) return h.clone().normalize();
          return h.clone().lerp(to, u).normalize();
        };
        const lThigh = pick(held.thigh, 'UpLeg');
        const lShin = pick(held.shin, 'Leg');
        const lFoot = pick(held.foot, 'Foot');
        if (!lThigh || !lShin) continue;

        const dThigh = lThigh.clone().applyQuaternion(hipsQ).normalize();
        const dShin = lShin.clone().applyQuaternion(hipsQ).normalize();
        const dFoot = lFoot ? lFoot.clone().applyQuaternion(hipsQ).normalize() : null;

        const thighQ = this.applyDirection(upper, hipsQ, dThigh);
        const shinQ = this.applyDirection(lower, thighQ, dShin);
        const footQ = dFoot ? this.applyDirection(foot, shinQ, dFoot) : shinQ;

        const kneePos = upper.getWorldPosition(new THREE.Vector3()).addScaledVector(dThigh, leg.L1);
        result[side] = {
          target: kneePos.clone().addScaledVector(dShin, leg.L2),
          knee: kneePos,
          worldQ: footQ,
          planted: !!held.planted,
          reach: held.reach ?? 1,
          held: true,
          relax: u,
        };
        continue;
      }

      const hipIdx = side === 'l' ? MP.lHip : MP.rHip;
      const kneeIdx = side === 'l' ? MP.lKnee : MP.rKnee;
      const ankleIdx = side === 'l' ? MP.lAnkle : MP.rAnkle;

      // цель: таз + (точка − таз) * масштаб, не ниже «пола»
      const local = new THREE.Vector3(
        P(ankleIdx).x - midHip.x, P(ankleIdx).y - midHip.y, P(ankleIdx).z - midHip.z,
      ).multiplyScalar(this.scaleK);
      const hipsWorld = upper.parent.getWorldPosition(new THREE.Vector3());
      const target = hipsWorld.clone().add(local);
      target.y = Math.max(target.y, this.restAnkleY);

      const H = upper.getWorldPosition(new THREE.Vector3());
      const dRaw = target.distanceTo(H);
      const full = leg.L1 + leg.L2;
      const minD = Math.abs(leg.L1 - leg.L2) + 1e-3;
      // небольшая недотяжка: полностью выпрямленная нога — точка сингулярности,
      // IK там «щёлкает» коленом. Полсантиметра сгиба глазу не видно.
      const d = clamp(dRaw, minD, full * 0.995);

      axis.copy(target).sub(H).normalize();
      const a = (leg.L1 * leg.L1 - leg.L2 * leg.L2 + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, leg.L1 * leg.L1 - a * a));

      // плоскость сгиба: направление на колено из точки; если вырождено —
      // берём плоскость, которую дал FK-проход
      pole.set(P(kneeIdx).x - P(hipIdx).x, P(kneeIdx).y - P(hipIdx).y, P(kneeIdx).z - P(hipIdx).z);
      pole.addScaledVector(axis, -pole.dot(axis));
      if (pole.lengthSq() < 1e-8) {
        pole.copy(lower.getWorldPosition(v)).sub(H);
        pole.addScaledVector(axis, -pole.dot(axis));
      }
      if (pole.lengthSq() < 1e-8) pole.set(0, 0, 1);
      pole.normalize();

      // Колено сгибается ВПЕРЁД. «Вперёд» берём из базиса таза (бёдра и плечи
      // — самые надёжные точки), а не из колена: именно по колену модель и врёт.
      // Без этого одна плохая точка выворачивает колено назад.
      if (fwd) {
        const f = fwd.clone().addScaledVector(axis, -fwd.dot(axis));
        if (f.lengthSq() > 1e-6) {
          f.normalize();
          const need = 0.25; // хотя бы такая «вперёд»-составляющая
          const dot = pole.dot(f);
          if (dot < need) pole.lerp(f, (need - dot) / (need + 1)).normalize();
        }
      }
      // и мягкое сглаживание по времени: колено не должно перекидываться
      const prevPole = this.poleSmooth[side];
      if (prevPole) {
        pole.lerp(prevPole, 0.5);
        pole.addScaledVector(axis, -pole.dot(axis));
        if (pole.lengthSq() < 1e-8) pole.copy(prevPole);
      }
      pole.normalize();
      this.poleSmooth[side] = pole.clone();

      kneeTarget.copy(H).addScaledVector(axis, a).addScaledVector(pole, h);

      const dThigh = kneeTarget.clone().sub(H).normalize();
      const dShin = target.clone().sub(kneeTarget).normalize();

      // родитель бедра — таз, его мировой кватернион уже посчитан
      const thighQ = this.applyDirection(upper, hipsQ, dThigh);
      const shinQ = this.applyDirection(lower, thighQ, dShin);

      // стопа: из landmark'а, но при опоре стремимся держать подошву горизонтально
      const footDir = new THREE.Vector3(
        P(ankleIdx).x - P(ankleIdx).x, 0, 0,
      );
      const toeIdx = side === 'l' ? MP.lFoot : MP.rFoot;
      footDir.set(
        P(toeIdx).x - P(ankleIdx).x,
        P(toeIdx).y - P(ankleIdx).y,
        P(toeIdx).z - P(ankleIdx).z,
      );
      if (footDir.lengthSq() < 1e-8) {
        footDir.copy(dShin);
      }
      footDir.normalize();
      const planted = target.y <= this.restAnkleY + 1e-3;
      if (planted) {
        // подошва горизонтально: раскладываем направление стопы по плоскости пола
        footDir.y *= 0.15;
        footDir.normalize();
      }
      const footQ = this.applyDirection(foot, shinQ, footDir);

      // Запоминаем «нормальную» позу ноги в системе таза — на случай, если
      // точки испортятся и эту ногу придётся держать.
      this.heldLegs[side] = {
        thigh: dThigh.clone().applyQuaternion(hipsQInv).normalize(),
        shin: dShin.clone().applyQuaternion(hipsQInv).normalize(),
        foot: footDir.clone().applyQuaternion(hipsQInv).normalize(),
        planted,
        reach: dRaw / full,
      };

      result[side] = { target, knee: kneeTarget, worldQ: footQ, planted, reach: dRaw / full, held: false };

      // Скольжение опоры: сравнение мировой точки стопы с прошлым кадром.
      // Считаем только когда стопа стояла и стоит (шаг и перенос — не скольжение).
      const prev = this._footPrev[side];
      if (prev && prev.planted && planted) {
        const dt = Math.max(1e-3, t - prev.t);
        // потолок: после «удержания» ноги точка может прыгнуть — это не скольжение
        const v = Math.min(300, Math.hypot(target.x - prev.x, target.z - prev.z) / dt);
        this.slipRate[side] = this.slipRate[side] * 0.9 + v * 0.1;
      } else {
        this.slipRate[side] *= 0.9;
      }
      this._footPrev[side] = { x: target.x, z: target.z, t, planted };
    }
    return result;
  }

  // Повернуть кость так, чтобы её мировое направление стало desiredDir.
  // Возвращает новое мировой кватернион кости.
  applyDirection(bone, parentWorldQ, desiredDir) {
    const key = this._keys.get(bone);
    const restLocal = this.restLocal.get(bone) || bone.quaternion.clone();
    const restDir = this.rest[key]?.dirParent;
    if (!restDir) return parentWorldQ.clone().multiply(bone.quaternion);

    const dParent = desiredDir.clone()
      .applyQuaternion(parentWorldQ.clone().invert())
      .normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(restDir, dParent);
    bone.quaternion.copy(q).multiply(restLocal);
    return parentWorldQ.clone().multiply(bone.quaternion);
  }
}

// Оценка размера человека: максимальное наблюдённое расстояние «таз → низкая
// лодыжка». Мировые точки MediaPipe центрированы в тазу, поэтому абсолютной
// высоты нет, но стоя это расстояние максимально.
// Нужна только чтобы понять рост — высоту таза считает IK по стопам.
export class StandingTracker {
  constructor() {
    this.standing = 0;
    this.samples = 0;
  }

  reset() {
    this.standing = 0;
    this.samples = 0;
  }

  update(points) {
    const lowAnkle = Math.max(points[MP.lAnkle].y, points[MP.rAnkle].y); // y вниз
    if (!(lowAnkle > 0)) return this.standing;
    this.samples++;
    if (lowAnkle > this.standing) this.standing = lowAnkle; // выпрямился — сразу
    else this.standing *= 0.9999; // и очень медленно забываем максимум
    return this.standing;
  }

  // Рост в метрах: таз→лодыжка ≈ 0.49 роста.
  get heightMeters() {
    return this.standing > 0.15 ? this.standing / 0.49 : 0;
  }
}

// Корневое движение: пока стопа стоит на полу, её смещение в системе персонажа
// означает, что персонаж уехал в обратную сторону. Так ходьба перестаёт быть
// «ходьбой на месте».
//
// Стопа считается опорной, если она не выше самой низкой стопы на plantEps.
// Если опорная одна — берём её смещение, если обе (двойная опора) — среднее.
export class RootMotionTracker {
  constructor(opts = {}) {
    this.pos = new THREE.Vector3();
    this.prev = [null, null];
    this.prevPlanted = [false, false];
    this.plantEps = opts.plantEps ?? 2.5; // в единицах модели (≈3 % длины ноги)
    this.maxStep = opts.maxStep ?? 0.06; // максимум метров за кадр (скорость 3.6 м/с)
    // 1 — опорная стопа держится жёстко: смещение таза ровно равно смещению
    // стопы. Раньше стояло 0.95 «на всякий случай», и опора ехала на 5 % шага.
    this.gain = opts.gain ?? 1;
  }

  reset() {
    this.pos.set(0, 0, 0);
    this.prev = [null, null];
    this.prevPlanted = [false, false];
  }

  // localAnkle: {l, r} — позиции лодыжек относительно таза, в единицах модели.
  // trusted — какой лодыжке верим: по недоверенной движение не считаем (иначе
  // мусорная точка утащит персонажа), но и «предыдущую» позицию не портим.
  update(localAnkle, scaleK, trusted = [true, true]) {
    const local = [localAnkle.l, localAnkle.r];
    const minY = Math.min(local[0].y, local[1].y);
    const planted = [
      local[0].y - minY <= this.plantEps,
      local[1].y - minY <= this.plantEps,
    ];

    let dx = 0;
    let dz = 0;
    let n = 0;
    for (let i = 0; i < 2; i++) {
      const ok = trusted[i] !== false;
      if (ok && planted[i] && this.prevPlanted[i] && this.prev[i]) {
        dx += this.prev[i].x - local[i].x;
        dz += this.prev[i].z - local[i].z;
        n++;
      }
      if (ok) {
        this.prev[i] = local[i].clone();
        this.prevPlanted[i] = planted[i];
      } else {
        // недоверенную точку не запоминаем: когда доверие вернётся, шаг
        // посчитается от последней честной позиции, а не от мусора
        this.prevPlanted[i] = false;
      }
    }

    if (n > 0) {
      const limit = this.maxStep * scaleK;
      this.pos.x += clamp((dx / n) * this.gain, -limit, limit);
      this.pos.z += clamp((dz / n) * this.gain, -limit, limit);
    }
    return this.pos;
  }
}
