// Сглаживание: OneEuroFilter (скаляры) + фильтр кватернионов.
// OneEuro — стандарт для мокапа: не даёт лага при быстром движении
// и хорошо гасит дрожь в покое.

export class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.05, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x, t) {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    let dt = t - this.tPrev;
    if (!(dt > 0)) dt = 1 / 60;
    this.tPrev = t;

    const dx = (x - this.xPrev) / dt;
    const aD = OneEuro.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = OneEuro.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }

  reset() {
    this.xPrev = null;
    this.tPrev = null;
    this.dxPrev = 0;
  }
}

// Фильтр массива точек (x, y, z, visibility) — по одному OneEuro на компоненту.
export class LandmarkFilter {
  constructor(count, opts) {
    this.axes = Array.from({ length: count }, () => ({
      x: new OneEuro(opts),
      y: new OneEuro(opts),
      z: new OneEuro(opts),
      v: new OneEuro({ minCutoff: 0.5, beta: 0.01 }),
    }));
  }

  apply(points, t) {
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const a = this.axes[i];
      out[i] = {
        x: a.x.filter(p.x, t),
        y: a.y.filter(p.y, t),
        z: a.z.filter(p.z, t),
        visibility: a.v.filter(p.visibility ?? 1, t),
      };
    }
    return out;
  }

  reset() {
    for (const a of this.axes) {
      a.x.reset(); a.y.reset(); a.z.reset(); a.v.reset();
    }
  }
}

// Мягкое сглаживание выходных кватернионов (nlerp к предыдущему значению).
// Скорость адаптивная: при быстром изменении почти не тормозим.
export class QuatSmoother {
  constructor(tau = 0.035) {
    this.tau = tau;
    this.prev = new Map();
  }

  apply(key, q, dt) {
    const p = this.prev.get(key);
    if (!p) {
      this.prev.set(key, q.clone());
      return q;
    }
    if (p.dot(q) < 0) p.set(-p.x, -p.y, -p.z, -p.w); // канонизация знака
    const a = 1 - Math.exp(-dt / this.tau);
    const out = p.clone().lerp(q, a).normalize();
    this.prev.set(key, out);
    return out;
  }

  reset() {
    this.prev.clear();
  }
}
