// Общая для воркеров установка wasm-glue MediaPipe.
//
// Засада: mediapipe-шный загрузчик wasm раскрывает glue-файл через importScripts(),
// а в module-воркере importScripts бросает TypeError — код откатывается на
// import(), но тогда `var ModuleFactory` остаётся в области модуля, а не в
// глобальной, и MediaPipe падает с "ModuleFactory not set.".
// Поэтому glue ставим руками через indirect eval (он кладёт var в globalThis).

// Те же байты, которыми MediaPipe проверяет SIMD
const SIMD_TEST = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
  10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

function simdSupported() {
  try { return WebAssembly.validate(SIMD_TEST); } catch { return false; }
}

export async function installGlue(wasmPath) {
  // В каждом воркере — свой globalThis, поэтому проверка локальная.
  if (typeof self.ModuleFactory === 'function') return;
  const name = `vision_wasm${simdSupported() ? '' : '_nosimd'}_internal.js`;
  const url = `${wasmPath}/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`не могу скачать ${url}: ${res.status}`);
  const src = await res.text();
  // indirect eval -> код выполняется в глобальной области видимости воркера
  (0, eval)(src);
  if (typeof self.ModuleFactory !== 'function') {
    throw new Error('glue не установил ModuleFactory');
  }
  self.postMessage({ type: 'log', text: `glue загружен (${name})` });
}
