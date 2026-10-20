# Разовая закачка зависимостей в vendor/ (дальше интернет не нужен).
# Запуск: powershell -ExecutionPolicy Bypass -File tools\fetch-vendor.ps1

$ErrorActionPreference = 'Stop'
$vendor = Join-Path $PSScriptRoot '..\vendor'
$vendor = [System.IO.Path]::GetFullPath($vendor)

$mpVersion = '1.1.1'
$mpBase = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$mpVersion"
$modelBase = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker'

New-Item -ItemType Directory -Force -Path `
  (Join-Path $vendor 'mediapipe\wasm'), `
  (Join-Path $vendor 'models') | Out-Null

function Get-File($url, $out) {
  Write-Host "  $url"
  Invoke-WebRequest -UseBasicParsing $url -OutFile $out
}

Write-Host 'MediaPipe tasks-vision:'
Get-File "$mpBase/vision_bundle.mjs" (Join-Path $vendor 'mediapipe\vision_bundle.mjs')
foreach ($f in @(
  'vision_wasm_internal.js', 'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'
)) {
  Get-File "$mpBase/wasm/$f" (Join-Path $vendor "mediapipe\wasm\$f")
}

Write-Host 'Модели позы:'
Get-File "$modelBase/pose_landmarker_full/float16/1/pose_landmarker_full.task" (Join-Path $vendor 'models\pose_landmarker_full.task')
Get-File "$modelBase/pose_landmarker_lite/float16/1/pose_landmarker_lite.task" (Join-Path $vendor 'models\pose_landmarker_lite.task')

Write-Host 'three.js (берем из соседнего проекта three.js, если он есть):'
$srcThree = Join-Path $PSScriptRoot '..\..\three.js\farm-demo\vendor'
if (Test-Path $srcThree) {
  Copy-Item (Join-Path $srcThree 'three.module.js') $vendor -Force
  Copy-Item (Join-Path $srcThree 'three.core.js') $vendor -Force
  foreach ($item in @(
    'jsm\loaders\FBXLoader.js', 'jsm\loaders\GLTFLoader.js',
    'jsm\controls\OrbitControls.js', 'jsm\libs\fflate.module.js',
    'jsm\libs\stats.module.js', 'jsm\utils\BufferGeometryUtils.js'
  )) {
    $dst = Join-Path $vendor $item
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item (Join-Path $srcThree $item) $dst -Force
  }
  Copy-Item (Join-Path $srcThree 'jsm\curves') (Join-Path $vendor 'jsm\curves') -Recurse -Force
} else {
  Write-Host '  (не найден — установите three: npm i three и скопируйте build + addons)'
}

Write-Host 'Готово.'
