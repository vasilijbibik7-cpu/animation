// Читает живую телеметрию с POST /diag сервера и печатает компактную сводку.
//   node tools/diag-read.mjs                 — весь кольцевой буфер
//   node tools/diag-read.mjs --n=60          — только последние 60 срезов
//   node tools/diag-read.mjs --url=http://...--n=60
// Смысл: смотреть чужие глаза (и камеру) со стороны — что модель видит на ногах,
// где ноги в кадре, сколько им доверия и что происходит с позой скелета.
const args = process.argv.slice(2);
const num = (name, def) => {
  const a = args.find((s) => s.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : def;
};
const url = (args.find((s) => s.startsWith('--url=')) || '').split('=')[1] || 'http://localhost:8090/diag';
const n = num('n', 0);

const res = await fetch(n > 0 ? `${url}?n=${n}` : url);
const text = await res.text();
const rows = text.split('\n').filter((l) => l.trim()).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);
if (!rows.length) {
  console.log('Пусто. Телеметрия в приложении выключена или ещё не отправляла срезы.');
  process.exit(0);
}

const R = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));
const maxOr = (a) => (a.length ? Math.max(...a) : null);
const med = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)} %`);

const first = rows[0];
const last = rows[rows.length - 1];
const dur = last.t - first.t;
const fpsHz = dur > 0 ? rows.length / dur : 0;

// ---- «срезано кадром»: любые координаты ног вне [0,1] ----
const outOfFrame = (r) => {
  const boxes = r.img ? [r.img.body, r.img.legL, r.img.legR] : [];
  for (const b of boxes) {
    if (!b) continue;
    if (b[0] < 0 || b[1] < 0 || b[2] > 1 || b[3] > 1) return true;
  }
  return false;
};

// высота стопы над уровнем стоя (restAnkleY модели, у Mixamo ≈ 8.7 см)
const REST_ANKLE = 8.73;
const footRise = (r, side) => {
  const f = r.legs && r.legs[side === 'l' ? 'footL' : 'footR'];
  return f ? f[1] - REST_ANKLE : null;
};
const guard = (r) => (r.guard || {});
const trust = (r, side) => (r.guard && r.guard.trust ? r.guard.trust[side] : null);
const span = (r, side) => {
  const b = r.img && r.img[side === 'l' ? 'legL' : 'legR'];
  return b ? b[3] - b[1] : null; // высота рамки ноги в долях кадра
};

const reasons = new Map();
let trustedFrames = { l: 0, r: 0 };
let cutFrames = 0;
let noBody = 0;
const spansL = [], spansR = [], riseL = [], riseR = [];
let kneeBack = 0;
for (const r of rows) {
  const g = guard(r);
  if (g.trusted) {
    if (g.trusted.l) trustedFrames.l++;
    if (g.trusted.r) trustedFrames.r++;
  }
  for (const side of ['l', 'r']) {
    const why = g.reason && g.reason[side];
    if (why) reasons.set(why, (reasons.get(why) || 0) + 1);
  }
  if (outOfFrame(r)) cutFrames++;
  if (r.tracking === false) noBody++;
  const sl = span(r, 'l'); if (sl !== null) spansL.push(sl);
  const sr = span(r, 'r'); if (sr !== null) spansR.push(sr);
  const rl = footRise(r, 'l'); if (rl !== null) riseL.push(rl);
  const rr = footRise(r, 'r'); if (rr !== null) riseR.push(rr);
  if (r.legs && r.legs.kneeL && r.legs.footL && r.legs.kneeL[2] - r.legs.footL[2] < 0) kneeBack++;
}

console.log(`срезы: ${rows.length} за ${R(dur)} с (~${R(fpsHz)}/с), t ${R(first.t)}…${R(last.t)}`);
console.log(`кадр: ${last.video ? `${last.video[0]}x${last.video[1]}` : 'нет видео (тестовый режим?)'}` +
  ` · инференс ${R(last.inferMs, 0)} мс · fps ${last.fps}` +
  ` · рост задан ${last.heightM} м` + (last.estM ? `, оценка ${R(last.estM, 2)} м` : '') +
  (last.synthetic ? ' · ТЕСТОВЫЙ РЕЖИМ (не камера!)' : ''));
console.log(`тело найдено: ${pct(1 - noBody / rows.length)} срезов · средняя видимость ключевых точек ${R(last.visAvg, 2)}`);
console.log(`доверие ногам: L ${pct(trustedFrames.l / rows.length)} · R ${pct(trustedFrames.r / rows.length)} срезов`);
if (reasons.size) {
  console.log('причины удержания: ' + [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
} else {
  console.log('причины удержания: нет');
}
console.log(`нога в кадре: L ${pct(med(spansL))} · R ${pct(med(spansR))} (медиана высоты рамки)` +
  ` · срезано краем кадра: ${cutFrames} срезов`);
// ---- «коллапс ноги»: кадровый размер таз→лодыжка (то, что считает предохранитель).
// Если стоя нога вдруг становится 20 % кадра вместо 45 % — модель утянула
// колено/лодыжку к тазу: это не шум на сантиметр, это потеря формы ноги.
const spans = { l: [], r: [] };
const feetYs = { l: [], r: [] };
for (const r of rows) {
  const g = guard(r);
  if (g.span) {
    if (g.span.l > 0) spans.l.push(g.span.l);
    if (g.span.r > 0) spans.r.push(g.span.r);
  }
  const f = r.img && r.img.feet;
  if (f && f.l) feetYs.l.push(f.l[1]);
  if (f && f.r) feetYs.r.push(f.r[1]);
}
const rangeOf = (a) => (a.length ? { min: Math.min(...a), max: Math.max(...a), med: med(a) } : null);
for (const side of ['l', 'r']) {
  const s = rangeOf(spans[side]);
  const f = rangeOf(feetYs[side]);
  if (!s) continue;
  // 1 % кадра ≈ 2 см при росте 1.75 и теле во весь кадр
  console.log(
    `нога ${side.toUpperCase()} в кадре: медиана ${pct(s.med)}, гуляет ${pct(s.min)}…${pct(s.max)}` +
    ` (размах ${pct(s.max - s.min)} ≈ ${R((s.max - s.min) * 0.88 * 175)} см)` +
    (f ? ` · стопа по y ${R(f.min, 3)}…${R(f.max, 3)}` : ''),
  );
}
if (spansR.length || spansL.length) {
  console.log('  (нога ~45 % кадра — норма для полного роста в кадре; 20 % — модель потеряла форму ноги)');
}

// ---- точки модели по отдельности: кто именно «уезжает» ----
// legJoints: [таз, колено, лодыжка, носок] как [x, y, видимость] в долях кадра.
// Рост 1.75 м занимает ~0.88 кадра => 1.0 кадра ≈ 2 m, 1 % ≈ 2 см.
const CM = 175 / 0.88;
const jointRows = rows.filter((r) => r.legJoints);
if (jointRows.length) {
  const names = ['таз', 'колено', 'лодыжка', 'носок'];
  console.log('\nточки ног в кадре (медиана и разброс за окно):');
  for (const side of ['l', 'r']) {
    for (let j = 0; j < 4; j++) {
      const xs = [], ys = [], vs = [];
      for (const r of jointRows) {
        const p = r.legJoints[side] && r.legJoints[side][j];
        if (!p) continue;
        xs.push(p[0]); ys.push(p[1]); vs.push(p[2]);
      }
      if (!ys.length) continue;
      const yr = rangeOf(ys);
      // максимальный скачок между соседними срезами — сколько точка «прыгает»
      let maxJump = 0;
      let prev = null;
      for (const v of ys) {
        if (prev !== null) maxJump = Math.max(maxJump, Math.abs(v - prev));
        prev = v;
      }
      console.log(
        `  ${side.toUpperCase()} ${names[j].padEnd(8)} y ${R(yr.min, 3)}…${R(yr.max, 3)}` +
        ` (разброс ${R((yr.max - yr.min) * CM)} см, худший скачок ${R(maxJump * CM)} см)` +
        ` · видимость ${R(med(vs), 2)}`,
      );
    }
  }
  // Где нога «схлопнулась» сильнее всего — кто из четырёх точек виноват
  const collapse = [...jointRows].map((r) => {
    const sp = span(r, 'l');
    return { sp: sp === null ? 9 : sp, r };
  }).sort((a, b) => a.sp - b.sp).slice(0, 3);
  console.log('\nхудшие по форме ноги (L):');
  for (const { sp, r } of collapse) {
    const j = r.legJoints.l;
    const f = (p) => (p ? `${R(p[0], 3)}/${R(p[1], 3)} в${R(p[2], 2)}` : '—');
    console.log(`  t=${R(r.t, 1)}с  нога ${pct(sp)}  таз ${f(j[0])}  колено ${f(j[1])}  лодыжка ${f(j[2])}  носок ${f(j[3])}`);
  }
}

console.log(`стопа над уровнем стоя: L макс ${R(maxOr(riseL))} см · R макс ${R(maxOr(riseR))} см` +
  ' (в покое ≈ 0; больше — либо шаг, либо мусор)');
console.log(`колено позади лодыжки: ${kneeBack} срезов из ${rows.length}`);

// ---- динамика: по строке на 10 срезов, видно «мигание» доверия ----
const step = Math.max(1, Math.floor(rows.length / 20));
console.log('\nдинамика (t: доверие L/R, причина, ноги в кадре):');
for (let i = 0; i < rows.length; i += step) {
  const r = rows[i];
  const g = guard(r);
  const mark = (s) => (g.trusted && g.trusted[s] ? '✓'
    : `✗${g.reason && g.reason[s] ? ' ' + g.reason[s] : ' (раскачка)'}`);
  const b = r.img && r.img.body;
  console.log(
    `  ${R(r.t, 1)}с  L ${pct(trust(r, 'l'))} ${mark('l')}  R ${pct(trust(r, 'r'))} ${mark('r')}` +
    `  ноги ${pct(med([span(r, 'l'), span(r, 'r')].filter((v) => v !== null)))}` +
    (b ? `  тело y ${R(b[1], 2)}…${R(b[3], 2)}` : '') +
    (r.root ? `  корень z ${R(r.root[2], 0)}` : ''),
  );
}

// ---- худшие срезы: где доверия меньше всего ----
const worst = [...rows].map((r) => {
  const g = guard(r);
  const t = Math.min(trust(r, 'l') ?? 1, trust(r, 'r') ?? 1);
  return { t, r, g };
}).sort((a, b) => a.t - b.t).slice(0, 5);
console.log('\nхудшие срезы (низкое доверие):');
for (const { t, r, g } of worst) {
  console.log(`  t=${R(r.t, 1)}с  trust ${R(t, 2)}  причины ${JSON.stringify(g.reason || {})}` +
    `  ноги в кадре ${pct(med([span(r, 'l'), span(r, 'r')].filter((v) => v !== null)))}` +
    `  в кадре целиком: ${outOfFrame(r) ? 'нет' : 'да'}`);
}
