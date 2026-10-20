// Полоска подрезки: видно, где в клипе движение, где провал; двумя ручками
// задаётся диапазон [in, out) — он же играет и он же уходит в BVH/JSON.
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class TrimStrip {
  constructor({ canvas, recorder, height = 46, onChange = () => {} }) {
    this.canvas = canvas;
    this.rec = recorder;
    this.onChange = onChange;
    this.h = height;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this._profile = null;
    this._profileKey = '';
    this._drag = null;
    this.resize();
    this._bind();
  }

  resize() {
    const w = Math.max(80, this.canvas.clientWidth || 240);
    this.w = w;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.height = this.h + 'px';
    this.ctx = this.canvas.getContext('2d');
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw();
  }

  profile() {
    const r = this.rec;
    if (this._profileOf !== r.frames) {
      this._profile = r.motionProfile();
      this._profileOf = r.frames;
    }
    return this._profile;
  }

  frameAt(x) {
    const n = this.rec.frames.length;
    if (n < 2) return 0;
    return Math.round(clamp(x / this.w, 0, 1) * (n - 1));
  }

  xOf(i) {
    const n = Math.max(1, this.rec.frames.length - 1);
    return (i / n) * this.w;
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.w;
    const h = this.h;
    const r = this.rec;
    ctx.clearRect(0, 0, w, h);

    // фон
    ctx.fillStyle = '#111726';
    ctx.fillRect(0, 0, w, h);

    const n = r.frames.length;
    if (n < 2) {
      ctx.strokeStyle = '#263149';
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      ctx.fillStyle = '#5c6b86';
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      ctx.fillText('нет записи', 6, h / 2 - 5);
      return;
    }

    // столбики движения
    const prof = this.profile();
    const bw = Math.max(1, w / n);
    for (let i = 0; i < n; i++) {
      const v = prof[i] || 0;
      const bh = Math.max(2, v * (h - 14));
      ctx.fillStyle = '#2f5b86';
      ctx.fillRect(i * bw, h - bh, Math.max(1, bw - (bw > 2 ? 1 : 0)), bh);
    }

    // затемнить то, что не попало в диапазон
    const xIn = this.xOf(r.inFrame);
    const xOut = this.xOf(Math.max(r.inFrame, r.outFrame - 1));
    ctx.fillStyle = 'rgba(6, 9, 15, .68)';
    ctx.fillRect(0, 0, xIn, h);
    ctx.fillRect(xOut, 0, w - xOut, h);

    // ручки
    ctx.fillStyle = '#63e6ff';
    ctx.fillRect(xIn, 0, 2, h);
    ctx.fillRect(xOut - 2, 0, 2, h);
    ctx.fillRect(xIn, 0, 6, 6);
    ctx.fillRect(xOut - 6, 0, 6, 6);

    // головка воспроизведения
    if (r.playing) {
      const i = clamp(r.inFrame + Math.round(r.playTime * r.fps), r.inFrame, Math.max(r.inFrame, r.outFrame - 1));
      const x = this.xOf(i);
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(x, 0, 1, h);
    }
  }

  _pos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return clamp(e.clientX - rect.left, 0, this.w);
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';

    c.addEventListener('pointerdown', (e) => {
      const r = this.rec;
      if (r.frameCount < 3) return;
      e.preventDefault();
      const x = this._pos(e);
      const dIn = Math.abs(x - this.xOf(r.inFrame));
      const dOut = Math.abs(x - this.xOf(Math.max(r.inFrame, r.outFrame - 1)));
      if (dIn > 22 && dOut > 22) return; // далеко от ручек — не трогаем
      this._drag = dIn <= dOut ? 'in' : 'out';
      this._dragSet(x);
      try { c.setPointerCapture?.(e.pointerId); } catch { /* синтетические события */ }
    });

    c.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      e.preventDefault();
      this._dragSet(this._pos(e));
    });

    const end = (e) => {
      if (!this._drag) return;
      this._drag = null;
      try { c.releasePointerCapture?.(e.pointerId); } catch { /* синтетические события */ }
      this.onChange();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  _dragSet(x) {
    const r = this.rec;
    const i = this.frameAt(x);
    const minLen = Math.max(2, Math.round(r.fps * 0.2)); // минимум 0.2 с
    if (this._drag === 'in') {
      r.inFrame = clamp(i, 0, r.outFrame - minLen);
    } else {
      r.outFrame = clamp(i + 1, r.inFrame + minLen, r.frames.length);
    }
    r.playTime = 0;
    this.draw();
    this.onChange();
  }
}
