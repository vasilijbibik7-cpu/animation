// Локальный статический сервер (без зависимостей).
// Запуск: node server.mjs  ->  http://localhost:8090
// Камера (getUserMedia) работает на localhost без https.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};
// Телеметрия: приложение шлёт сюда срез диагностики — так на живую сессию
// можно смотреть снаружи (я или любой другой читатель), а не только глазами у
// монитора. Каждая строка — отдельный JSON-срез. Держим и файл, и кольцо в
// памяти, чтобы читать без диска.
//   POST /diag          — добавить срез
//   GET  /diag?n=50     — последние N срезов (без n — всё, что в кольце)
//   DELETE /diag        — очистить
const diagDir = path.join(root, 'diag');
const diagFile = path.join(diagDir, 'live.jsonl');
const diagRing = [];
const DIAG_MAX = 2000;

function handleDiag(req, res, url) {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      const line = body.trim();
      if (line) {
        diagRing.push(line);
        while (diagRing.length > DIAG_MAX) diagRing.shift();
        fs.mkdir(diagDir, { recursive: true }, () => fs.appendFile(diagFile, line + '\n', () => {}));
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  if (req.method === 'DELETE' || url.searchParams.has('reset')) {
    diagRing.length = 0;
    fs.rm(diagFile, { force: true }, () => {});
    res.writeHead(204);
    res.end();
    return;
  }
  const n = Number(url.searchParams.get('n')) || 0;
  const lines = n > 0 ? diagRing.slice(-n) : diagRing;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(lines.join('\n'));
}

// Картинка с камеры: приложение шлёт маленький JPEG с наложенными точками
// модели. Так живую сессию можно не только измерять, но и видеть.
//   POST /frame?t=12.3   — сохранить кадр
//   GET  /frames         — список последних кадров
const frameDir = path.join(diagDir, 'frames');
let frameSeq = 0;
const FRAME_KEEP = 200;

function handleFrame(req, res, url) {
  if (req.method === 'GET') {
    fs.readdir(frameDir, (err, list) => {
      const files = (err ? [] : list).filter((f) => f.endsWith('.jpg')).sort();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(files.join('\n'));
    });
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (!buf.length) { res.writeHead(204); res.end(); return; }
    const t = (url.searchParams.get('t') || '').replace(/[^0-9.]/g, '');
    // kind: cam — кадр с камеры, bad — кадр в момент, когда ногам перестали
    // верить, view — картинка 3D-вида, badview — вид в тот же момент. У каждого
    // набора свой префикс и свой «последний» файл, чтобы не путались.
    const kind = url.searchParams.get('kind') || 'cam';
    const sets = {
      cam: ['f-', 'last.jpg'],
      bad: ['b-', 'last-bad.jpg'],
      view: ['g-', 'last-view.jpg'],
      badview: ['v-', 'last-badview.jpg'],
    };
    const [prefix, last] = sets[kind] || sets.cam;
    frameSeq = (frameSeq + 1) % 100000;
    const name = `${prefix}${String(frameSeq).padStart(5, '0')}${t ? '-t' + t : ''}.jpg`;
    fs.mkdir(frameDir, { recursive: true }, () => {
      fs.writeFile(path.join(frameDir, name), buf, () => {});
      fs.writeFile(path.join(frameDir, last), buf, () => {});
      // держим только последние FRAME_KEEP кадров каждого набора
      fs.readdir(frameDir, (err, list) => {
        if (err) return;
        const mine = list.filter((f) => f.startsWith(prefix)).sort();
        for (const old of mine.slice(0, Math.max(0, mine.length - FRAME_KEEP))) {
          fs.rm(path.join(frameDir, old), { force: true }, () => {});
        }
      });
    });
    res.writeHead(204);
    res.end();
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/diag') { handleDiag(req, res, new URL(req.url, 'http://x')); return; }
  if (urlPath === '/frame' || urlPath === '/frames') { handleFrame(req, res, new URL(req.url, 'http://x')); return; }
  const file = path.normalize(path.join(root, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});
const PORT = Number(process.argv[2]) || 8090;
server.listen(PORT, () => console.log(`Mocap: http://localhost:${PORT}  (Ctrl+C — стоп)`));
