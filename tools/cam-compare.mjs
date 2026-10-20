// Разбор /diag: камера 1 против камеры 2.
// node tools/cam-compare.mjs            — сводка по последним 120 с
// node tools/cam-compare.mjs file       — то же по diag/live.jsonl
// node tools/cam-compare.mjs timeline   — таблица по времени (последние 3 мин)
import fs from 'node:fs';

const parseLines = (text) => text
  .split('\n')
  .filter((l) => l.trim().startsWith('{'))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const arg = process.argv[2];
let rows;
if (arg === 'file') rows = parseLines(fs.readFileSync('diag/live.jsonl', 'utf8'));
else rows = parseLines(await (await fetch('http://localhost:8090/diag')).text());

const tEnd = rows[rows.length - 1].t;
const windowSec = arg === 'timeline' ? 180 : 120;
const seg = rows.filter((r) => tEnd - r.t <= windowSec);

const med = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const f2 = (v) => +v.toFixed(2);
const f3 = (v) => +v.toFixed(3);
const col = (r) => {
  const g1 = r.guard || {};
  const c2 = r.cam2;
  const g2 = c2?.trust;
  return {
    t: f2(r.t),
    tr: r.tracking ? 1 : 0,
    vis1: f2(r.visAvg ?? 0),
    // камера 1
    tl: f2(g1.trust?.l ?? 0), tr1: f2(g1.trust?.r ?? 0),
    sp1: f2(g1.span?.l ?? 0),
    len1: f2(r.legLen?.l ?? 0),
    f1: r.frame ? `${r.frame.level} b${f2(r.frame.body)} t${f2(r.frame.top)} bot${f2(r.frame.bottom)}` : '-',
    // камера 2
    on: c2 ? 1 : 0,
    fps2: c2 ? f2(c2.fps) : -1,
    tl2: g2 ? f2(g2.trust.l) : -1,
    tr2: g2 ? f2(g2.trust.r) : -1,
    sp2: g2 ? f2(g2.span.l) : -1,
    len2: c2 ? f2(c2.legLen.l) : -1,
    vis2: c2 ? f2(c2.vis) : -1,
    f2l: c2?.frame ? `${c2.frame.level} b${f2(c2.frame.body)} t${f2(c2.frame.top)} bot${f2(c2.frame.bottom)}` : '-',
  };
};

if (arg === 'timeline') {
  const every = Math.max(1, Math.floor(seg.length / 24));
  const rowsOut = seg.filter((_, i) => i % every === 0).map(col);
  console.table(rowsOut);
} else {
  const c1 = seg.filter((r) => r.tracking);
  const c2 = seg.filter((r) => r.cam2 && r.cam2.ageMs != null && r.cam2.ageMs < 400 && r.cam2.legLen?.l > 0.1);
  const both = seg.filter((r) =>
    r.tracking && r.guard?.trusted?.l && r.guard?.trusted?.r
    && r.cam2?.trust?.trusted?.l && r.cam2?.trust?.trusted?.r);
  const out = {
    window: `${f2(tEnd - Math.min(...seg.map((r) => r.t)))} с, ${seg.length} срезов`,
    cam1: {
      video: seg[seg.length - 1].video,
      trackingPct: pct(c1.length, seg.length),
      visAvg: f3(med(c1.map((r) => r.visAvg))),
      fps: f2(med(seg.map((r) => r.fps))),
      inferMs: f2(med(seg.filter((r) => r.inferMs).map((r) => r.inferMs))),
      legTrust: [f3(med(c1.map((r) => r.guard?.trust?.l ?? 0))), f3(med(c1.map((r) => r.guard?.trust?.r ?? 0)))],
      legsHeldPct: pct(c1.filter((r) => !(r.guard?.trusted?.l && r.guard?.trusted?.r)).length, c1.length),
      legSpan: [f3(med(c1.map((r) => r.guard?.span?.l ?? 0))), f3(med(c1.map((r) => r.guard?.span?.r ?? 0)))],
      reasons: Object.entries(c1.reduce((m, r) => {
        for (const s of ['l', 'r']) {
          const why = r.guard?.reason?.[s];
          if (why) m[why] = (m[why] || 0) + 1;
        }
        return m;
      }, {})).sort((a, b) => b[1] - a[1]).slice(0, 4),
      frameLevels: c1.reduce((m, r) => { const l = r.frame?.level; if (l) m[l] = (m[l] || 0) + 1; return m; }, {}),
      body: f3(med(c1.filter((r) => r.frame).map((r) => r.frame.body))),
      top: f3(med(c1.filter((r) => r.frame).map((r) => r.frame.top))),
      bottom: f3(med(c1.filter((r) => r.frame).map((r) => r.frame.bottom))),
      legLen: [f3(med(c1.map((r) => r.legLen?.l ?? 0))), f3(med(c1.map((r) => r.legLen?.r ?? 0)))],
    },
    cam2: {
      video: c2[0]?.cam2.video,
      fps: f2(med(c2.map((r) => r.cam2.fps))),
      ms: f2(med(c2.map((r) => r.cam2.ms))),
      vis: f3(med(c2.map((r) => r.cam2.vis))),
      legTrust: [f3(med(c2.map((r) => r.cam2.trust.trust.l))), f3(med(c2.map((r) => r.cam2.trust.trust.r)))],
      legsHeldPct: pct(c2.filter((r) => !(r.cam2.trust.trusted.l && r.cam2.trust.trusted.r)).length, c2.length),
      legSpan: [f3(med(c2.map((r) => r.cam2.trust.span.l))), f3(med(c2.map((r) => r.cam2.trust.span.r)))],
      frameLevels: c2.reduce((m, r) => { const l = r.cam2.frame?.level; if (l) m[l] = (m[l] || 0) + 1; return m; }, {}),
      body: f3(med(c2.filter((r) => r.cam2.frame).map((r) => r.cam2.frame.body))),
      top: f3(med(c2.filter((r) => r.cam2.frame).map((r) => r.cam2.frame.top))),
      bottom: f3(med(c2.filter((r) => r.cam2.frame).map((r) => r.cam2.frame.bottom))),
      out: f2(med(c2.filter((r) => r.cam2.frame).map((r) => r.cam2.frame.out))),
      legLen: [f3(med(c2.map((r) => r.cam2.legLen.l))), f3(med(c2.map((r) => r.cam2.legLen.r)))],
      err: [...new Set(c2.map((r) => r.cam2.err).filter(Boolean))],
    },
    agreeCm: {
      n: both.length,
      l: f2(med(both.map((r) => (r.legLen.l - r.cam2.legLen.l) * 100))),
      r: f2(med(both.map((r) => (r.legLen.r - r.cam2.legLen.r) * 100))),
      lAbs: f2(med(both.map((r) => Math.abs(r.legLen.l - r.cam2.legLen.l) * 100))),
      rAbs: f2(med(both.map((r) => Math.abs(r.legLen.r - r.cam2.legLen.r) * 100))),
    },
    // сколько процентов времени вторая камера может подменить первую по ногам
    cam2HelpsPct: pct(both.length, seg.filter((r) => r.tracking).length),
  };
  console.log(JSON.stringify(out, null, 2));
}
