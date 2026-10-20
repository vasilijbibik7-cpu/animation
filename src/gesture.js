// Жест-триггер записи: «обе кисти выше носа» удержано hold секунд.
//
// Зачем: кнопку надо нажать, потом дойти до места съёмки, а в конце вернуться
// и нажать «Стоп» — в клип попадает ходьба по комнате. Жест запускает и
// останавливает запись из кадра, поэтому лишнего просто не пишется.
//
// Точки — мировые MediaPipe: y ВНИЗ, поэтому «выше» = меньше y.
export class ArmsUpTrigger {
  constructor({ hold = 0.4, release = 0.3, cooldown = 0.8, margin = 0.06, minVis = 0.55 } = {}) {
    this.hold = hold;
    this.release = release;
    this.cooldown = cooldown;
    this.margin = margin;
    this.minVis = minVis;
    this.reset();
  }

  reset() {
    this.armed = true;
    this.since = 0;
    this.lastFire = -99;
    this.progress = 0;
    this.active = false;
  }

  get state() {
    if (this.active) return 'charging';
    return this.armed ? 'idle' : 'blocked';
  }

  // Тело жеста: обе кисти заметно выше носа и точки видимы.
  detect(points) {
    if (!points || points.length < 17) return false;
    const nose = points[0];
    const lw = points[15];
    const rw = points[16];
    if (!nose || !lw || !rw) return false;
    const vis = (p) => p.visibility ?? 1;
    if (vis(nose) < this.minVis || vis(lw) < this.minVis || vis(rw) < this.minVis) return false;
    return lw.y < nose.y - this.margin && rw.y < nose.y - this.margin;
  }

  // Возвращает true ровно в тот кадр, когда жест сработал.
  update(points, t) {
    const ok = this.detect(points);

    if (!this.armed) {
      // ждём, пока руки опустят — иначе одно поднятие сработает дважды
      if (!ok && t - this.lastFire > this.release) this.armed = true;
      this.active = false;
      this.progress = 0;
      return false;
    }

    if (!ok) {
      this.since = 0;
      this.active = false;
      this.progress = 0;
      return false;
    }

    if (!this.since) this.since = t;
    this.active = true;
    this.progress = Math.min(1, (t - this.since) / this.hold);

    if (t - this.since >= this.hold && t - this.lastFire > this.cooldown) {
      this.lastFire = t;
      this.armed = false;
      this.active = false;
      this.since = 0;
      this.progress = 0;
      return true;
    }
    return false;
  }
}
