// Постобработка записи — всё детерминированное, без внешних сервисов.
//
// Что лечим:
//   • скольжение опорной стопы: корневое движение при захвате считается
//     инкрементально (с gain < 1), поэтому за секунду персонаж «уезжает»
//     относительно пола. Здесь стопа приклеивается жёстко: пока она на полу,
//     её мировая позиция не меняется — корень пересчитывается под это;
//   • дрейф: за цикл персонаж может сместиться; убирается линейной поправкой
//     (нужно для клипов «шаг на месте»);
//   • дрожь: скользящее среднее по кватернионам;
//   • стык петли: ищем в записи период движения и окно с минимальным
//     расхождением поз — тогда петля крутится без рывка.
//
// Ни одна функция не меняет вход: кадры возвращаются новыми объектами.
import * as THREE from 'three';

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _q = new THREE.Quaternion();

// Индексы в frame.feet: [L лодыжка, L носок, R лодыжка, R носок] × xyz
export const FOOT = { L: 0, LTOE: 1, R: 2, RTOE: 3 };

function cloneFrame(f, { quats = false } = {}) {
  return {
    t: f.t,
    root: [...f.root],
    hipsWorld: [...f.hipsWorld],
    hipsQuat: [...f.hipsQuat],
    quats: quats ? f.quats.slice() : f.quats,
    feet: f.feet ? f.feet.slice() : new Float32Array(12),
    landmarks: f.landmarks,
  };
}

const fx = (feet, i) => feet[i * 3 + 0];
const fy = (feet, i) => feet[i * 3 + 1];
const fz = (feet, i) => feet[i * 3 + 2];

// Угол между двумя поворотами, градусы.
export function angleBetween(a, b, k) {
  _qa.fromArray(a, k * 4);
  _qb.fromArray(b, k * 4);
  const d = Math.min(1, Math.abs(_qa.dot(_qb)));
  return (2 * Math.acos(d) * 180) / Math.PI;
}

// «Расстояние» между позами: сумма углов по костям.
export function poseDistance(a, b) {
  let s = 0;
  const n = a.quats.length / 4;
  for (let k = 0; k < n; k++) s += angleBetween(a.quats, b.quats, k);
  return s;
}

// ---------- контакт стоп ----------
// Стопа «на полу», если её низ не выше самой низкой стопы больше чем на eps.
// Интервалы короче minContact выбрасываются, соседние с зазором < mergeGap —
// сливаются: иначе флаг дребезжит на каждом кадре.
export function footContacts(frames, { plantEps = 3, minContact = 0.12, mergeGap = 0.08, fps = 30 } = {}) {
  const n = frames.length;
  const planted = new Uint8Array(n); // бит 1 — левая, бит 2 — правая
  for (let i = 0; i < n; i++) {
    const feet = frames[i].feet;
    if (!feet || !feet.length) continue;
    const yL = Math.min(fy(feet, FOOT.L), fy(feet, FOOT.LTOE));
    const yR = Math.min(fy(feet, FOOT.R), fy(feet, FOOT.RTOE));
    const low = Math.min(yL, yR);
    let m = 0;
    if (yL - low <= plantEps) m |= 1;
    if (yR - low <= plantEps) m |= 2;
    planted[i] = m;
  }

  const raw = [];
  const scan = (bit) => {
    let from = -1;
    for (let i = 0; i <= n; i++) {
      const on = i < n && (planted[i] & bit) !== 0;
      if (on && from < 0) from = i;
      if (!on && from >= 0) {
        raw.push({ bit, from, to: i - 1 });
        from = -1;
      }
    }
  };
  scan(1);
  scan(2);
  raw.sort((a, b) => a.from - b.from);

  // слияние близких и отбрасывание слишком коротких
  const merged = [];
  for (const it of raw) {
    const last = merged[merged.length - 1];
    if (last && last.bit === it.bit && it.from - last.to <= mergeGap * fps) last.to = it.to;
    else merged.push({ ...it });
  }
  const long = merged.filter((it) => it.to - it.from + 1 >= Math.max(2, Math.round(minContact * fps)));

  const intervals = long.map((it) => ({
    foot: it.bit === 1 ? 'L' : 'R',
    from: it.from,
    to: it.to,
    frames: it.to - it.from + 1,
  }));
  return { planted, stable: stableMask(planted, Math.max(3, Math.round(0.1 * fps))), intervals };
}

// Кадры «устойчивой» опоры: там, где состав опорных стоп не менялся близко
// (переход между фазами — это не скольжение, а сам переход).
function stableMask(planted, margin = 4) {
  const n = planted.length;
  const ok = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    if (i > 0 && planted[i] !== planted[i - 1]) {
      const lo = Math.max(0, i - margin);
      const hi = Math.min(n, i + margin);
      for (let j = lo; j < hi; j++) ok[j] = 0;
    }
  }
  return ok;
}

// Скольжение: насколько «гуляет» опорная стопа за время контакта.
// Меряем размах (габарит) её мировой позиции по кадрам интервала — так метрика
// не зависит от того, где именно стоит персонаж, и ловит именно проскальзывание.
// singleOnly — только кадры, где опорна ровно одна стопа, only — маска
// «устойчивых» кадров (см. stableMask): переход между фазами — не скольжение.
function slideOf(frames, intervals, { planted = null, singleOnly = false, only = null } = {}) {
  let max = 0;
  for (const it of intervals) {
    const idx = it.foot === 'L' ? FOOT.L : FOOT.R;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    let cnt = 0;
    for (let i = it.from; i <= it.to; i++) {
      if (singleOnly && planted && planted[i] !== (it.foot === 'L' ? 1 : 2)) continue;
      if (only && !only[i]) continue;
      const x = fx(frames[i].feet, idx);
      const z = fz(frames[i].feet, idx);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
      cnt++;
    }
    if (cnt > 1) max = Math.max(max, Math.hypot(x1 - x0, z1 - z0));
  }
  return max;
}

// ---------- приклейка стоп ----------
// Пока стопа в контакте, её мировая позиция не должна меняться. Переносим это
// на корень: поправка[i] = (позиция стопы в начале контакта) − (позиция сейчас).
//
// В двойной опоре у двух стоп разные поправки (данные чуть противоречивы: у
// корневого движения gain < 1). Требовать обе сразу нельзя, поэтому кадр
// «принадлежит» тому контакту, который начался позже (только что вставшая стопа
// не должна проскальзывать), а смена владельца сглаживается по времени —
// получается одна непрерывная кривая поправки без ступенек.
export function pinFeet(frames, contacts) {
  const n = frames.length;
  const corr = new Array(n);
  const owner = new Array(n).fill(-1);

  for (let k = 0; k < contacts.intervals.length; k++) {
    const it = contacts.intervals[k];
    for (let i = it.from; i <= it.to; i++) {
      if (owner[i] < 0 || it.from > contacts.intervals[owner[i]].from) owner[i] = k;
    }
  }

  for (let i = 0; i < n; i++) {
    const k = owner[i];
    if (k < 0) continue;
    const it = contacts.intervals[k];
    const idx = it.foot === 'L' ? FOOT.L : FOOT.R;
    corr[i] = [
      fx(frames[it.from].feet, idx) - fx(frames[i].feet, idx),
      fz(frames[it.from].feet, idx) - fz(frames[i].feet, idx),
    ];
  }

  // дырки — линейно между соседними известными точками
  const known = [];
  for (let i = 0; i < n; i++) if (corr[i]) known.push(i);
  if (!known.length) return { frames, slideBefore: 0, slideAfter: 0, slideSingleBefore: 0, slideSingleAfter: 0, maxJump: 0, pinned: 0 };
  for (let i = 0; i < n; i++) {
    if (corr[i]) continue;
    let a = null;
    let b = null;
    for (const k of known) { if (k < i) a = k; else { b = k; break; } }
    if (a === null) corr[i] = [...corr[b]];
    else if (b === null) corr[i] = [...corr[a]];
    else {
      const u = (i - a) / (b - a);
      corr[i] = [corr[a][0] + (corr[b][0] - corr[a][0]) * u, corr[a][1] + (corr[b][1] - corr[a][1]) * u];
    }
  }

  // сглаживание кривой поправки: смена владельца перестаёт быть ступенькой
  const smooth = corr.map((_, i) => {
    let sx = 0;
    let sz = 0;
    let c = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      sx += corr[j][0];
      sz += corr[j][1];
      c++;
    }
    return [sx / c, sz / c];
  });

  const out = new Array(n);
  let maxJump = 0;
  for (let i = 0; i < n; i++) {
    const f = cloneFrame(frames[i]);
    f.root[0] += smooth[i][0];
    f.root[2] += smooth[i][1];
    f.hipsWorld[0] += smooth[i][0];
    f.hipsWorld[2] += smooth[i][1];
    for (let k = 0; k < 4; k++) {
      f.feet[k * 3 + 0] += smooth[i][0];
      f.feet[k * 3 + 2] += smooth[i][1];
    }
    if (i > 0) maxJump = Math.max(maxJump, Math.hypot(smooth[i][0] - smooth[i - 1][0], smooth[i][1] - smooth[i - 1][1]));
    out[i] = f;
  }

  return {
    frames: out,
    slideBefore: slideOf(frames, contacts.intervals, { planted: contacts.planted, singleOnly: true, only: contacts.stable }),
    slideAfter: slideOf(out, contacts.intervals, { planted: contacts.planted, singleOnly: true, only: contacts.stable }),
    slideAllBefore: slideOf(frames, contacts.intervals),
    slideAllAfter: slideOf(out, contacts.intervals),
    maxJump,
    pinned: contacts.intervals.reduce((s, it) => s + it.frames, 0),
  };
}

// ---------- дрейф ----------
export function removeDrift(frames) {
  const n = frames.length;
  if (n < 2) return { frames, driftBefore: 0, driftAfter: 0 };
  const a = frames[0];
  const b = frames[n - 1];
  const dx = b.root[0] - a.root[0];
  const dz = b.root[2] - a.root[2];
  const out = frames.map((f, i) => {
    const u = i / (n - 1);
    const c = cloneFrame(f);
    c.root[0] -= dx * u;
    c.root[2] -= dz * u;
    c.hipsWorld[0] -= dx * u;
    c.hipsWorld[2] -= dz * u;
    for (let k = 0; k < 4; k++) {
      c.feet[k * 3 + 0] -= dx * u;
      c.feet[k * 3 + 2] -= dz * u;
    }
    return c;
  });
  return { frames: out, driftBefore: Math.hypot(dx, dz), driftAfter: 0 };
}

// ---------- сглаживание ----------
// Скользящее среднее по кватернионам (со выравниванием знака, иначе slerp
// уходит «через другую сторону») и по положению корня.
export function smoothFrames(frames, { window = 3, skipFirst = 0, skipLast = 0 } = {}) {
  const n = frames.length;
  if (n < 3 || window < 2) return { frames, jerkBefore: 0, jerkAfter: 0 };
  const half = Math.floor(window / 2);
  const nb = frames[0].quats.length / 4;
  const jerk = (arr) => {
    let s = 0;
    let c = 0;
    for (let i = 0; i < arr.length - 1; i++) {
      s += poseDistance(arr[i], arr[i + 1]);
      c++;
    }
    return c ? s / c : 0;
  };

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(skipFirst, i - half);
    const hi = Math.min(n - 1 - skipLast, i + half);
    if (lo >= hi || i < skipFirst || i > n - 1 - skipLast) {
      out[i] = cloneFrame(frames[i]);
      continue;
    }
    const f = cloneFrame(frames[i], { quats: true });
    for (let k = 0; k < nb; k++) {
      // опорное направление для знака — сам сглаживаемый кадр
      _qa.fromArray(frames[i].quats, k * 4);
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let sw = 0;
      for (let j = lo; j <= hi; j++) {
        _qb.fromArray(frames[j].quats, k * 4);
        const s = _qb.dot(_qa) < 0 ? -1 : 1;
        sx += _qb.x * s;
        sy += _qb.y * s;
        sz += _qb.z * s;
        sw += _qb.w * s;
      }
      _q.set(sx, sy, sz, sw).normalize();
      f.quats[k * 4 + 0] = _q.x;
      f.quats[k * 4 + 1] = _q.y;
      f.quats[k * 4 + 2] = _q.z;
      f.quats[k * 4 + 3] = _q.w;
    }
    for (const key of ['root', 'hipsWorld']) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let j = lo; j <= hi; j++) s += frames[j][key][c];
        f[key][c] = s / (hi - lo + 1);
      }
    }
    out[i] = f;
  }
  return { frames: out, jerkBefore: jerk(frames), jerkAfter: jerk(out) };
}

// ---------- выравнивание петли ----------
// 1) ищем период движения по автокорреляции высоты левой лодыжки относительно
//    таза (чистый периодический сигнал для ходьбы);
// 2) среди всех окон такой длины выбираем то, где последний кадр ближе всего к
//    первому — это и есть стык петли.
export function alignLoop(frames, { fps = 30, minPeriod = 0.4, maxPeriod = 2.4, sampleQuats = 24 } = {}) {
  const n = frames.length;
  if (n < 8) return { error: 'клип короткий' };

  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    sig[i] = fy(f.feet, FOOT.L) - f.hipsWorld[1];
  }
  let mean = 0;
  for (const v of sig) mean += v / n;
  for (let i = 0; i < n; i++) sig[i] -= mean;

  const lo = Math.max(2, Math.round(minPeriod * fps));
  const hi = Math.min(n - 4, Math.round(maxPeriod * fps));
  let bestLag = 0;
  let bestScore = -Infinity;
  let bestEnergy = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let dot = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      dot += sig[i] * sig[i + lag];
      e1 += sig[i] * sig[i];
      e2 += sig[i + lag] * sig[i + lag];
    }
    const score = dot / Math.sqrt(Math.max(1e-9, e1 * e2));
    if (score > bestScore) { bestScore = score; bestLag = lag; bestEnergy = Math.sqrt(e1 + e2); }
  }
  // сигнал почти не меняется (человек стоял) — периода нет
  if (bestLag < lo || bestScore < 0.3 || bestEnergy < 1e-3) {
    return { error: 'период не найден — движение не циклично', period: 0 };
  }

  const step = Math.max(1, Math.floor(n / sampleQuats));
  let best = { start: 0, seam: Infinity };
  for (let s = 0; s + bestLag < n; s++) {
    let seam = 0;
    for (let k = 0; k < frames[s].quats.length / 4; k += step) {
      seam += angleBetween(frames[s].quats, frames[s + bestLag].quats, k);
    }
    if (seam < best.seam) best = { start: s, seam };
  }

  return {
    start: best.start,
    length: bestLag + 1,
    period: bestLag / fps,
    score: bestScore,
    seamDeg: best.seam,
    seamAvgDeg: best.seam / Math.max(1, Math.ceil(frames[0].quats.length / 4 / step)),
  };
}

// ---------- сводка по качества ----------
export function analyze(frames, { plantEps = 3, fps = 30 } = {}) {
  const contacts = footContacts(frames, { plantEps, fps });
  const n = frames.length;
  let minFoot = Infinity;
  let maxSpeed = 0;
  for (let i = 0; i < n; i++) {
    const feet = frames[i].feet;
    if (!feet || !feet.length) continue;
    for (const k of [FOOT.L, FOOT.LTOE, FOOT.R, FOOT.RTOE]) minFoot = Math.min(minFoot, fy(feet, k));
    if (i > 0) {
      const dx = frames[i].root[0] - frames[i - 1].root[0];
      const dz = frames[i].root[2] - frames[i - 1].root[2];
      maxSpeed = Math.max(maxSpeed, Math.hypot(dx, dz) * fps);
    }
  }
  const drift = n > 1 ? Math.hypot(frames[n - 1].root[0] - frames[0].root[0], frames[n - 1].root[2] - frames[0].root[2]) : 0;
  return {
    frames: n,
    duration: n / fps,
    contacts: contacts.intervals.length,
    contactSeconds: +(contacts.intervals.reduce((s, it) => s + it.frames, 0) / fps).toFixed(2),
    slide: slideOf(frames, contacts.intervals),
    slideSingle: slideOf(frames, contacts.intervals, { planted: contacts.planted, singleOnly: true, only: contacts.stable }),
    drift,
    minFootY: Number.isFinite(minFoot) ? minFoot : 0,
    maxSpeed,
  };
}
