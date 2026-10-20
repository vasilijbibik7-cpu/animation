// Почему камера 1 держит ноги: разбор последних секунд.
const rows = (await (await fetch('http://localhost:8090/diag')).text())
  .split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
const end = rows[rows.length - 1].t;
const seg = rows.filter((r) => end - r.t <= 45);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const bad = seg.filter((r) => r.tracking && r.guard && !(r.guard.trusted.l && r.guard.trusted.r));
const reasons = {};
for (const r of bad) for (const s of ['l', 'r']) {
  const w = r.guard.reason[s];
  if (w) reasons[w] = (reasons[w] || 0) + 1;
}
const out = {
  samples: seg.length,
  tracking: seg.filter((r) => r.tracking).length,
  held: bad.length,
  reasons,
  frameMargins: {
    left: +med(seg.filter((r) => r.frame).map((r) => r.frame.left)).toFixed(3),
    right: +med(seg.filter((r) => r.frame).map((r) => r.frame.right)).toFixed(3),
    top: +med(seg.filter((r) => r.frame).map((r) => r.frame.top)).toFixed(3),
    bottom: +med(seg.filter((r) => r.frame).map((r) => r.frame.bottom)).toFixed(3),
  },
  examples: bad.slice(0, 5).map((r) => ({
    t: +r.t.toFixed(1),
    legL: r.legJoints?.l,
    legR: r.legJoints?.r,
    inFrame: r.guard.inFrame,
    span: [+r.guard.span.l.toFixed(2), +r.guard.span.r.toFixed(2)],
    vis: [+r.guard.vis.l.toFixed(2), +r.guard.vis.r.toFixed(2)],
  })),
  // как часто нога уходит вбок за край
  legX: (() => {
    const xs = seg.filter((r) => r.legJoints?.l).map((r) => [r.legJoints.l[2][0], r.legJoints.l[3][0]]);
    return { min: Math.min(...xs.flat()), max: Math.max(...xs.flat()) };
  })(),
};
console.log(JSON.stringify(out, null, 2));
