// Ноги: предохранитель и диагностика.
//
// Верх тела в кадре крупный, а ноги — мелкие и часто наполовину за кадром.
// MediaPipe по ним отдаёт догадки (высокая visibility у дорисованной точки —
// обычное дело), а IK верит точкам безусловно: одна плохая точка выворачивает
// колено и уводит стопу. Поэтому на каждую ногу считается «доверие» 0..1 по
// пяти независимым признакам, и IK этой ноги применяется, только когда доверие
// есть. Пока доверия нет — нога держит последнюю нормальную позу (в системе
// таза, поэтому корпус может продолжать двигаться) и медленно расслабляется в
// нейтральную стойку.
//
// Признаки (каждый бьёт по доверию независимо):
//   видимость — минимум по колену/лодыжке/пятке/носку;
//   кадр      — точка вне [0,1] по картинке = модель её дорисовала;
//   размер    — «таз→лодыжка» в долях кадра: чем меньше, тем хуже точность;
//   скачок    — прыжок лодыжки выше предела скорости человека (это перескок);
//   анатомия  — лодыжка должна быть ниже колена, а колено ниже таза.
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const LEG_POINTS = {
  l: { hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 },
  r: { hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 },
};

function smoothstep(v, a, b) {
  const u = clamp((v - a) / (b - a || 1), 0, 1);
  return u * u * (3 - 2 * u);
}

export class LegGuard {
  constructor(opts = {}) {
    this.minVis = opts.minVis ?? 0.45; // ниже — точке не верим
    this.goodVis = opts.goodVis ?? 0.7; // выше — верим
    this.minSpan = opts.minSpan ?? 0.1; // доля кадра «таз→лодыжка»
    this.goodSpan = opts.goodSpan ?? 0.17;
    // Прыжок меряем в метрах за кадр, но предел берём из скорости: иначе
    // на медленной машине (15 к/с) быстрый шаг выглядел бы как перескок.
    this.maxSpeed = opts.maxSpeed ?? 3.5; // м/с — быстрее лодыжка не летает
    this.minJump = opts.minJump ?? 0.12; // и не строже этого (30 к/с)
    this.trustUp = opts.trustUp ?? 0.05; // доверие возвращается медленно
    this.trustDown = opts.trustDown ?? 0.55; // теряется быстро
    this.trustMin = opts.trustMin ?? 0.55; // порог «верим/держим»
    this.grace = opts.grace ?? 0.3; // столько секунд держим ровно, без расслабления
    this.relaxTime = opts.relaxTime ?? 2.0; // потом за столько секунд отпускаем позу в стойку
    this.reset();
  }

  reset() {
    this.q = { l: 0, r: 0 };
    this.trust = { l: 0, r: 0 };
    this.trusted = { l: false, r: false };
    this.reason = { l: '', r: '' };
    this.span = { l: 0, r: 0 };
    this.vis = { l: 1, r: 1 };
    this.inFrame = { l: true, r: true };
    this.lostAt = { l: -1, r: -1 };
    this._prev = { l: null, r: null };
    this._lastT = 0;
  }

  // world — точки в координатах three.js (y вверх, метры от таза),
  // image — нормализованные точки кадра (для проверки «в кадре» и размера),
  // image может отсутствовать (тестовый режим) — тогда эти признаки не считаются.
  update(world, image, t = 0) {
    const dt = this._lastT ? clamp(t - this._lastT, 1 / 120, 0.5) : 1 / 30;
    this._lastT = t;
    const jumpLimit = clamp(this.maxSpeed * dt, this.minJump, 0.5);
    for (const side of ['l', 'r']) {
      const ids = LEG_POINTS[side];
      const hip = world[ids.hip];
      const knee = world[ids.knee];
      const ankle = world[ids.ankle];

      // 1) видимость
      let vis = 1;
      for (const i of [ids.knee, ids.ankle, ids.heel, ids.toe]) {
        vis = Math.min(vis, world[i]?.visibility ?? 1);
      }

      // 2) в кадре и 3) размер
      let inFrame = true;
      let span = 0;
      if (image && image[ids.ankle]) {
        for (const i of [ids.knee, ids.ankle, ids.toe]) {
          const p = image[i];
          if (!p) continue;
          if (p.x < -0.01 || p.x > 1.01 || p.y < -0.01 || p.y > 1.01) inFrame = false;
        }
        const a = image[ids.hip];
        const b = image[ids.ankle];
        if (a && b) span = Math.hypot(a.x - b.x, a.y - b.y);
      }

      // 4) скачок лодыжки за кадр
      let jump = 0;
      const cur = ankle ? [ankle.x, ankle.y, ankle.z] : null;
      const prev = this._prev[side];
      if (cur && prev) {
        jump = Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]);
      }
      if (cur) this._prev[side] = cur;

      // 5) анатомия: y вверх, поэтому «ниже» = меньше.
      // Допуски щедрые: высокий подъём колена (бег) и глубокий присед должны
      // проходить, а вот «лодыжка выше колена» — уже точно мусор.
      let anat = true;
      if (knee && ankle) anat = ankle.y <= knee.y + 0.05;
      if (anat && hip && knee) anat = knee.y <= hip.y + 0.25;
      if (anat && hip && ankle) anat = ankle.y <= hip.y;

      let q = 1;
      let why = '';
      q *= smoothstep(vis, this.minVis, this.goodVis);
      if (!inFrame) {
        q *= 0.15;
        why = 'вне кадра';
      }
      if (span > 0 && span < this.minSpan) {
        q *= 0.4;
        why = why || 'мелко';
      } else if (span > 0 && span < this.goodSpan) {
        q *= 0.75; // мелковато, но не смертельно — учитываем без «ярлыка»
      }
      if (jump > jumpLimit) {
        q *= 0.15;
        why = why || 'скачок';
      }
      if (!anat) {
        q *= 0.2;
        why = why || 'анатомия';
      }

      this.q[side] = q;
      this.vis[side] = vis;
      this.span[side] = span;
      this.inFrame[side] = inFrame;
      this.reason[side] = q >= this.trustMin ? '' : why || 'видимость';

      // асимметричное сглаживание: теряем доверие сразу, возвращаем неохотно
      const k = q < this.trust[side] ? this.trustDown : this.trustUp;
      this.trust[side] += (q - this.trust[side]) * k;
      const now = this.trust[side] >= this.trustMin;
      if (!now && this.trusted[side]) this.lostAt[side] = t;
      if (now) this.lostAt[side] = -1;
      this.trusted[side] = now;
    }
    return this.trusted;
  }

  // Насколько нога «забыта»: 0 — только что потеряли (или ещё идёт «льготное»
  // время, в которое поза держится ровно), 1 — пора в нейтральную стойку.
  relax(side, t) {
    const since = this.lostAt[side];
    if (since < 0) return 0;
    const age = t - since - this.grace;
    if (age <= 0) return 0;
    return clamp(age / this.relaxTime, 0, 1);
  }

  // Короткая сводка для HUD.
  describe() {
    const pct = (side) => `${Math.round(this.trust[side] * 100)}%`;
    const mark = (side) => (this.trusted[side] ? '✓' : `✗ ${this.reason[side] || '—'}`);
    // размер показываем только по ногам, которые вообще в кадре: у вынесенной
    // за кадр точки «таз→лодыжка» измеряет уже не ногу, а выдумку модели
    const spans = ['l', 'r'].filter((s) => this.inFrame[s]).map((s) => this.span[s]);
    const span = spans.length ? Math.max(...spans) : 0;
    return `L ${pct('l')} ${mark('l')} · R ${pct('r')} ${mark('r')}` +
      (span ? ` · нога ${Math.round(span * 100)}% кадра` : '');
  }

  // Всё, что нужно для отчёта/отладки.
  snapshot() {
    return {
      trust: { l: +this.trust.l.toFixed(3), r: +this.trust.r.toFixed(3) },
      trusted: { ...this.trusted },
      reason: { ...this.reason },
      span: { l: +this.span.l.toFixed(3), r: +this.span.r.toFixed(3) },
      vis: { l: +this.vis.l.toFixed(3), r: +this.vis.r.toFixed(3) },
      inFrame: { ...this.inFrame },
    };
  }

  // Что сделать, чтобы ногам можно было верить: подсказка по причине.
  hint() {
    for (const side of ['l', 'r']) {
      if (this.trusted[side]) continue;
      const why = this.reason[side];
      if (why === 'вне кадра') {
        return 'Ноги выходят из кадра: отойдите дальше или опустите камеру ниже — ступни должны быть видны целиком.';
      }
      if (why === 'мелко') {
        return 'Ноги мелкие в кадре: подойдите ближе или разверните камеру так, чтобы нога занимала больше кадра.';
      }
      if (why === 'скачок') {
        return 'Точки ног перескакивают: уберите из кадра мебель, дайте ногам ровный свет и контрастный фон.';
      }
      if (why === 'анатомия') {
        return 'Модель путает колено и лодыжку: встаньте так, чтобы обе ноги были видны сбоку-спереди, не одна за другой.';
      }
      return 'Ноги видны плохо: проверьте свет и что ноги не перекрыты мебелью.';
    }
    return '';
  }
}
