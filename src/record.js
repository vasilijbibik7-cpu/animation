// Запись клипа: пишем позу «как приходит» (до 60 Гц, зависит от камеры),
// затем пересэмплируем на фиксированные 30 к/с — иначе клип дёргается и
// проигрывается с разной скоростью на разных машинах.
//
// Чтобы в клип не попадал мусор (человек отошёл к ноутбуку, вышел из кадра):
//   • пишем только кадры, где человек реально виден (это делает main.js);
//   • разрыв во времени больше maxGap = это не «плавный слайд», а конец
//     фрагмента: клип режется на независимые куски, и лишнее просто не
//     участвует в пересэмплировании;
//   • после записи границы можно подрезать руками (inFrame/outFrame).
//
// Дополнительно пишем:
//   • мировые точки MediaPipe (33×4) — для оффлайн-ретаргета в JSON;
//   • мировое положение и поворот таза — это корень для BVH;
//   • локальные кватернионы всех костей — для воспроизведения в приложении.
import * as THREE from 'three';

export const REC_FPS = 30;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r4 = (v) => Math.round(v * 10000) / 10000;

export class Recorder {
  constructor({
    bones = [], root = null, fps = REC_FPS, maxSeconds = 60, warmup = 0.6,
    loopFade = true, fadeSeconds = 0.3, maxGap = 0.2, minSegment = 0.3,
    feet = [], onChange = () => {},
  } = {}) {
    this.bones = bones;
    this.root = root;
    // 4 кости стоп (лодыжка+носок ×2) — по ним считается контакт с полом и
    // скольжение при постобработке
    this.feet = feet.filter(Boolean);
    this.fps = fps;
    this.maxSeconds = maxSeconds;
    this.warmup = warmup;
    this.maxGap = maxGap;
    this.minSegment = minSegment;
    this.onChange = onChange;

    this.countdown = 0;
    this.recording = false;
    this.samples = [];
    this.frames = [];
    this.segments = [];
    this.activeSegment = 0;
    this.inFrame = 0;
    this.outFrame = 0;
    this.playing = false;
    this.playTime = 0;
    this.t0 = 0;
    this.loopFade = loopFade;
    this.fadeSeconds = fadeSeconds;
    this.lost = 0; // сколько секунд записи пропущено из-за потери трекинга

    // Дубли: каждая запись или импорт остаются в списке, а не затирают
    // предыдущую. Активный дубль — тот, что сейчас лежит в frames/segments.
    this.takes = [];
    this.activeTake = -1;
    this._takeId = 0;
    this._pendingTake = null;

    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
    this._q = new THREE.Quaternion();
    this._hipsQ = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  // ---- что реально играем и экспортируем: отрезок [inFrame, outFrame) ----
  // Сшивка цикла делается здесь, а не при остановке записи: кадры остаются
  // как записаны (их не портит подмешивание), галочку можно менять в любой
  // момент, а подрезка и выравнивание петли работают по настоящим кадрам.
  get clipFrames() {
    const n = this.outFrame - this.inFrame;
    const f = this.fadeLen(n);
    if (
      this._clip && this._clipOf === this.frames && this._clipIn === this.inFrame &&
      this._clipOut === this.outFrame && this._clipFade === f
    ) {
      return this._clip;
    }
    const raw = this.frames.slice(this.inFrame, this.outFrame);
    this._clip = f >= 2 ? this.crossFade(raw, f) : raw;
    this._clipOf = this.frames;
    this._clipIn = this.inFrame;
    this._clipOut = this.outFrame;
    this._clipFade = f;
    return this._clip;
  }

  // Сколько кадров уходит на сшивку для клипа длиной n.
  fadeLen(n) {
    if (!this.loopFade) return 0;
    return Math.min(Math.round(this.fadeSeconds * this.fps), Math.floor(n / 3));
  }

  // Кадры выбранного диапазона без сшивки цикла — для измерений и шлифовки:
  // сшивка подмешивает хвост в начало, и мерить качество по ней бессмысленно.
  rawClip() {
    return this.frames.slice(this.inFrame, this.outFrame);
  }

  get faded() {
    return this.fadeLen(this.outFrame - this.inFrame);
  }

  get frameCount() {
    return this.clipFrames.length;
  }

  get duration() {
    return this.frameCount ? this.frameCount / this.fps : 0;
  }

  get fullDuration() {
    return this.frames.length ? this.frames.length / this.fps : 0;
  }

  get hasClip() {
    return this.frameCount > 1;
  }

  get trimmed() {
    return this.inFrame > 0 || this.outFrame < this.frames.length;
  }

  get elapsed() {
    return this.recording ? performance.now() / 1000 - this.t0 : 0;
  }

  // ---- правка границ ----
  setTrim(inFrame, outFrame) {
    const n = this.frames.length;
    const a = clamp(Math.round(inFrame), 0, Math.max(0, n - 2));
    const b = clamp(Math.round(outFrame), a + 2, n);
    this.inFrame = a;
    this.outFrame = b;
    this.playTime = 0;
    this.onChange();
  }

  resetTrim() {
    this.setTrim(0, this.frames.length);
  }

  setSegment(i) {
    if (!this.segments[i]) return;
    this.activeSegment = i;
    this.frames = this.segments[i].frames;
    this.inFrame = 0;
    this.outFrame = this.frames.length;
    this.playTime = 0;
    this._clip = null;
    this.onChange();
  }

  // ---- дубли ----
  // Один дубль — это один прогон записи (или импорт JSON). Поля дубля — те же,
  // что у recorder, и хранятся ссылками: кадры и куски не копируются. Поэтому
  // состояние активного дубля снимаем в него только в момент ухода с него
  // (новая запись, переключение, удаление).
  _syncTake() {
    const t = this.takes[this.activeTake];
    if (!t) return;
    t.frames = this.frames;
    t.segments = this.segments;
    t.activeSegment = this.activeSegment;
    t.inFrame = this.inFrame;
    t.outFrame = this.outFrame;
    t.lost = this.lost;
  }

  // Записать текущие кадры как новый дубль. Обычно вызывается из stop().
  saveTake({ label = '', source = 'live' } = {}) {
    if (!this.frames.length) return null;
    const id = ++this._takeId;
    const take = {
      id,
      label: label || `Дубль ${id}`,
      at: Date.now(),
      source,
    };
    this.takes.push(take);
    this.activeTake = this.takes.length - 1;
    this._syncTake();
    this.onChange();
    return take;
  }

  // Кадры дубля: у активного их надо брать из recorder — подрезка, шлифовка и
  // смена фрагмента меняют именно его.
  takeFrames(i) {
    return i === this.activeTake ? this.frames : (this.takes[i]?.frames || []);
  }

  setTake(i) {
    const t = this.takes[i];
    if (!t || this.recording) return false;
    this._syncTake();
    const frames = t.frames || [];
    this.activeTake = i;
    this.frames = frames;
    this.segments = t.segments?.length ? t.segments : (frames.length ? [{ frames }] : []);
    this.activeSegment = Math.min(t.activeSegment ?? 0, Math.max(0, this.segments.length - 1));
    this.inFrame = t.inFrame ?? 0;
    this.outFrame = t.outFrame ?? frames.length;
    this.lost = t.lost || 0;
    this.countdown = 0;
    this.playing = false;
    this.playTime = 0;
    this.samples = [];
    this._clip = null;
    this.onChange();
    return true;
  }

  removeTake(i = this.activeTake) {
    if (this.recording || !this.takes[i]) return false;
    this._syncTake();
    this.takes.splice(i, 1);
    if (!this.takes.length) {
      this.clear();
      return true;
    }
    this.activeTake = -1; // следующий дубль загружаем как есть, без sync
    this.setTake(Math.min(i, this.takes.length - 1));
    return true;
  }

  // Прервать запись, не создавая дубль (ошибка импорта JSON).
  abort() {
    this.recording = false;
    this.clear();
  }

  // ---- управление ----
  beginCountdown(seconds = 3.2) {
    if (this.recording) return;
    this.playing = false;
    this.playTime = 0;
    this.countdown = seconds;
    this.onChange();
  }

  tick(dt) {
    if (this.countdown > 0) {
      this.countdown -= dt;
      if (this.countdown <= 0) this.start(performance.now() / 1000);
    }
  }

  start(t, take = null) {
    this.countdown = 0;
    // Прежний дубль оставляем в списке: снимаем с него итоговое состояние
    // (подрезку, шлифовку), пока кадры не очищены.
    this._syncTake();
    this.activeTake = -1; // новая запись станет дублем только после stop()
    this._pendingTake = take || { label: '', source: 'live' };
    this.samples = [];
    this.frames = [];
    this.segments = [];
    this.activeSegment = 0;
    this.inFrame = 0;
    this.outFrame = 0;
    this._clip = null;
    this.playing = false;
    this.playTime = 0;
    this.recording = true;
    this.t0 = t;
    this.lost = 0;
    this.onChange();
  }

  stop() {
    if (!this.recording) return;
    this.recording = false;
    this.segments = [];
    for (const chunk of this.splitSegments()) {
      const frames = this.resampleRange(chunk, this.segments.length === 0);
      if (frames.length < 4) continue;
      this.segments.push({ frames });
    }
    // самый длинный фрагмент — по умолчанию
    let best = 0;
    for (let i = 1; i < this.segments.length; i++) {
      if (this.segments[i].frames.length > this.segments[best].frames.length) best = i;
    }
    this.activeSegment = best;
    this.frames = this.segments[best] ? this.segments[best].frames : [];
    this.activeSegment = best;
    // сколько секунд записи не попало ни в один фрагмент (пропуски + разогрев)
    let kept = 0;
    for (const s of this.segments) kept += s.frames.length / this.fps;
    const total = this.samples.length ? this.samples[this.samples.length - 1].t - this.t0 : 0;
    this.lost = Math.max(0, total - kept);
    this.inFrame = 0;
    this.outFrame = this.frames.length;
    this._clip = null;
    // Новая запись становится дублем. Если кадров не набралось (человек так и
    // не появился в кадре), прежние дубли остаются нетронутыми.
    const pending = this._pendingTake;
    this._pendingTake = null;
    if (this.frames.length) this.saveTake(pending || {});
    else this.onChange();
  }

  // Режем сэмплы там, где зияет дырка: человек вышел из кадра / отошёл.
  splitSegments() {
    const chunks = [];
    let cur = [];
    for (const s of this.samples) {
      if (cur.length && s.t - cur[cur.length - 1].t > this.maxGap) {
        chunks.push(cur);
        cur = [];
      }
      cur.push(s);
    }
    if (cur.length) chunks.push(cur);

    const ok = chunks.filter((c) => c.length >= 4 && c[c.length - 1].t - c[0].t >= this.minSegment);
    if (ok.length) return ok;
    // всё короткое — отдаём самый длинный, что есть
    let best = null;
    for (const c of chunks) if (!best || c.length > best.length) best = c;
    return best ? [best] : [];
  }

  // Смешать хвост клипа с началом: стык петли без рывка. Возвращает новый
  // массив (кадры на входе не меняются — их подрезка/переключение фрагмента
  // должны видеть как были).
  crossFade(frames, f) {
    const n = frames.length;
    const k = f ?? Math.min(Math.round(this.fadeSeconds * this.fps), Math.floor(n / 3));
    if (k < 2) return frames.slice();
    const out = new Array(n - k);
    for (let i = 0; i < k; i++) {
      const u = i / (k - 1);
      out[i] = this._blend(frames[n - k + i], frames[i], u);
    }
    for (let i = k; i < n - k; i++) out[i] = { ...frames[i] };
    for (let i = 0; i < out.length; i++) out[i].t = i / this.fps; // время снова монотонное
    return out;
  }

  // Смешать два кадра: u = 0 → A, u = 1 → B.
  _blend(A, B, u) {
    const nb = this.bones.length;
    const quats = new Float32Array(nb * 4);
    for (let k = 0; k < nb; k++) {
      this._qa.fromArray(A.quats, k * 4);
      this._qb.fromArray(B.quats, k * 4);
      this._q.copy(this._qa).slerp(this._qb, u);
      quats[k * 4 + 0] = this._q.x;
      quats[k * 4 + 1] = this._q.y;
      quats[k * 4 + 2] = this._q.z;
      quats[k * 4 + 3] = this._q.w;
    }
    const mix3 = (a, b) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    const hq = new THREE.Quaternion(A.hipsQuat[0], A.hipsQuat[1], A.hipsQuat[2], A.hipsQuat[3])
      .slerp(new THREE.Quaternion(B.hipsQuat[0], B.hipsQuat[1], B.hipsQuat[2], B.hipsQuat[3]), u);
    const lm = new Float32Array(A.landmarks.length);
    for (let k = 0; k < lm.length; k++) lm[k] = A.landmarks[k] + (B.landmarks[k] - A.landmarks[k]) * u;
    const feet = new Float32Array(12);
    for (let k = 0; k < feet.length; k++) {
      feet[k] = (A.feet?.[k] || 0) + ((B.feet?.[k] || 0) - (A.feet?.[k] || 0)) * u;
    }
    return {
      t: A.t,
      root: mix3(A.root, B.root),
      hipsWorld: mix3(A.hipsWorld, B.hipsWorld),
      hipsQuat: [hq.x, hq.y, hq.z, hq.w],
      quats,
      feet,
      landmarks: lm,
    };
  }

  togglePlay() {
    if (!this.hasClip) return;
    this.playing = !this.playing;
    this.playTime = 0;
    this.onChange();
  }

  clear() {
    this.samples = [];
    this.frames = [];
    this.segments = [];
    this.inFrame = 0;
    this.outFrame = 0;
    this._clip = null;
    this.playing = false;
    this.activeTake = -1;
    this._pendingTake = null;
    this.onChange();
  }

  // ---- запись ----
  // Вызывать после каждого обновления позы, только в живом режиме.
  // landmarks — массив {x,y,z,visibility} (уже отфильтрованный).
  push(t, landmarks) {
    if (!this.recording || !this.root) return;
    if (t - this.t0 > this.maxSeconds) { this.stop(); return; }

    const n = this.bones.length;
    const quats = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const q = this.bones[i].quaternion;
      quats[i * 4 + 0] = q.x;
      quats[i * 4 + 1] = q.y;
      quats[i * 4 + 2] = q.z;
      quats[i * 4 + 3] = q.w;
    }

    let hipsWorld = [0, 0, 0];
    let hipsQuat = [0, 0, 0, 1];
    const hips = this.bones[0];
    if (hips) {
      this.root.updateMatrixWorld(true);
      hips.getWorldPosition(this._v);
      hipsWorld = [this._v.x, this._v.y, this._v.z];
      hips.getWorldQuaternion(this._hipsQ);
      hipsQuat = [this._hipsQ.x, this._hipsQ.y, this._hipsQ.z, this._hipsQ.w];
    }

    const lm = new Float32Array(landmarks.length * 4);
    for (let i = 0; i < landmarks.length; i++) {
      const p = landmarks[i];
      lm[i * 4 + 0] = p.x;
      lm[i * 4 + 1] = p.y;
      lm[i * 4 + 2] = p.z;
      lm[i * 4 + 3] = p.visibility ?? 1;
    }

    // мировые позиции стоп: по ним потом клеим стопы и меряем скольжение
    const feet = new Float32Array(12);
    for (let i = 0; i < 4; i++) {
      const b = this.feet[i];
      if (!b) continue;
      b.getWorldPosition(this._v);
      feet[i * 3 + 0] = this._v.x;
      feet[i * 3 + 1] = this._v.y;
      feet[i * 3 + 2] = this._v.z;
    }

    this.samples.push({
      t,
      root: [this.root.position.x, this.root.position.y, this.root.position.z],
      hipsWorld,
      hipsQuat,
      quats,
      feet,
      landmarks: lm,
    });
  }

  // ---- пересэмплирование одного фрагмента на ровную сетку 30 к/с ----
  resampleRange(samples, first) {
    const s = samples;
    const out = [];
    if (s.length < 3) return out;

    const t1 = s[s.length - 1].t;
    const t0 = s[0].t + (first ? this.warmup : 0); // разогрев выбрасываем один раз
    if (t1 - t0 < 0.15) return out;

    const n = Math.max(2, Math.round((t1 - t0) * this.fps));
    const step = (t1 - t0) / n;
    const nb = this.bones.length;
    let j = 0;

    for (let i = 0; i <= n; i++) {
      const t = t0 + i * step;
      while (j < s.length - 2 && s[j + 1].t < t) j++;
      const A = s[j];
      const B = s[j + 1] || A;
      const span = Math.max(1e-6, B.t - A.t);
      const u = clamp((t - A.t) / span, 0, 1);

      const quats = new Float32Array(nb * 4);
      for (let k = 0; k < nb; k++) {
        this._qa.fromArray(A.quats, k * 4);
        this._qb.fromArray(B.quats, k * 4);
        this._q.copy(this._qa).slerp(this._qb, u);
        quats[k * 4 + 0] = this._q.x;
        quats[k * 4 + 1] = this._q.y;
        quats[k * 4 + 2] = this._q.z;
        quats[k * 4 + 3] = this._q.w;
      }

      const lerp3 = (a, b) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
      const hq = new THREE.Quaternion(A.hipsQuat[0], A.hipsQuat[1], A.hipsQuat[2], A.hipsQuat[3])
        .slerp(new THREE.Quaternion(B.hipsQuat[0], B.hipsQuat[1], B.hipsQuat[2], B.hipsQuat[3]), u);

      const lm = new Float32Array(A.landmarks.length);
      for (let k = 0; k < lm.length; k++) {
        lm[k] = A.landmarks[k] + (B.landmarks[k] - A.landmarks[k]) * u;
      }

      const feet = new Float32Array(12);
      for (let k = 0; k < feet.length; k++) {
        feet[k] = (A.feet?.[k] || 0) + ((B.feet?.[k] || 0) - (A.feet?.[k] || 0)) * u;
      }

      out.push({
        t: i / this.fps,
        root: lerp3(A.root, B.root),
        hipsWorld: lerp3(A.hipsWorld, B.hipsWorld),
        hipsQuat: [hq.x, hq.y, hq.z, hq.w],
        quats,
        feet,
        landmarks: lm,
      });
    }
    return out;
  }

  // ---- постобработка ----
  // Заменить кадры активного фрагмента (после шлифовки).
  replaceFrames(frames, { keepTrim = false } = {}) {
    this.frames = frames;
    const seg = this.segments[this.activeSegment];
    if (seg) seg.frames = frames;
    if (keepTrim) {
      this.inFrame = clamp(this.inFrame, 0, Math.max(0, frames.length - 2));
      this.outFrame = clamp(this.outFrame, this.inFrame + 2, frames.length);
    } else {
      this.inFrame = 0;
      this.outFrame = frames.length;
    }
    this._clip = null;
    this.playTime = 0;
    this.onChange();
  }

  // ---- воспроизведение по кругу (по обрезанному диапазону) ----
  apply(dt) {
    const clip = this.clipFrames;
    if (!this.playing || clip.length < 2 || !this.root) return;
    const dur = clip.length / this.fps;
    this.playTime += dt;
    while (this.playTime >= dur) this.playTime -= dur;
    if (this.playTime < 0) this.playTime += dur;

    const pos = this.playTime * this.fps;
    const i0 = Math.floor(pos) % clip.length;
    const i1 = (i0 + 1) % clip.length;
    const u = pos - Math.floor(pos);
    const A = clip[i0];
    const B = clip[i1];

    for (let k = 0; k < this.bones.length; k++) {
      this._qa.fromArray(A.quats, k * 4);
      this._qb.fromArray(B.quats, k * 4);
      this.bones[k].quaternion.copy(this._qa).slerp(this._qb, u);
    }

    this.root.position.set(
      A.root[0] + (B.root[0] - A.root[0]) * u,
      A.root[1] + (B.root[1] - A.root[1]) * u,
      A.root[2] + (B.root[2] - A.root[2]) * u,
    );
  }

  // Кадры для экспорта/проверки: выбранный диапазон со сшивкой, время с нуля.
  clip() {
    const src = this.clipFrames;
    if (!src.length || Math.abs(src[0].t) < 1e-9) return src;
    return src.map((f, i) => ({ ...f, t: i / this.fps }));
  }

  // Кадр записи в виде объекта для экспорта
  frame(i) {
    const clip = this.clipFrames;
    return clip[clamp(i, 0, clip.length - 1)];
  }

  // Точки для JSON (в пределах обрезки)
  landmarksJson() {
    return this.clipFrames.map((f) => {
      const out = new Array(f.landmarks.length);
      for (let k = 0; k < f.landmarks.length; k++) out[k] = r4(f.landmarks[k]);
      return out;
    });
  }

  // Профиль движения по кадрам всей записи (0..1) — для полоски подрезки.
  // Считаем по полному клипу: полоска показывает всю запись, а диапазон
  // подрезки выделяется поверх неё.
  motionProfile() {
    const clip = this.frames;
    const n = clip.length;
    const out = new Float32Array(n);
    if (n < 2) return out;
    const stride = clip[0].landmarks.length;
    let max = 0;
    for (let i = 1; i < n; i++) {
      const a = clip[i - 1].landmarks;
      const b = clip[i].landmarks;
      let sum = 0;
      let cnt = 0;
      for (let k = 0; k < stride; k += 4) {
        const dx = b[k] - a[k];
        const dy = b[k + 1] - a[k + 1];
        const dz = b[k + 2] - a[k + 2];
        sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
        cnt++;
      }
      out[i] = cnt ? sum / cnt : 0;
      if (out[i] > max) max = out[i];
    }
    if (max > 1e-6) for (let i = 0; i < n; i++) out[i] /= max;
    return out;
  }
}
