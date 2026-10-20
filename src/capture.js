// Захват видео с камеры (webcam / телефон как веб-камера).

// Человеческие подсказки по именам ошибок getUserMedia.
const HINTS = {
  NotAllowedError:
    'браузер запретил доступ к камере. Значок камеры в адресной строке → «Разрешить», ' +
    'потом F5. Проверь Windows: Параметры → Конфиденциальность → Камера. ' +
    'Открывать надо через http://localhost:8090, а не файлом.',
  PermissionDeniedError:
    'браузер запретил доступ к камере — разреши её для этого сайта и перезагрузи страницу.',
  NotFoundError:
    'камера не найдена. Подключи веб-камеру или включи её в Windows (Параметры → Bluetooth и устройства).',
  DevicesNotFoundError: 'камера не найдена.',
  NotReadableError:
    'камера занята другим приложением (Zoom, Teams, Skype, другая вкладка) — закрой их и попробуй снова.',
  TrackStartError: 'камера занята другим приложением.',
  OverconstrainedError:
    'камера не поддерживает запрошенные параметры — пробую без требований.',
  ConstraintNotSatisfiedError: 'камера не поддерживает запрошенные параметры.',
  SecurityError:
    'страница не в защищённом контексте. Нужен http://localhost или https://.',
  AbortError: 'система прервала доступ к камере — попробуй ещё раз.',
  TypeError: 'камера не найдена или браузер не поддерживает getUserMedia.',
};

export function describeCameraError(err) {
  const hint = HINTS[err?.name];
  if (hint) return `${err.name}: ${hint}`;
  return err?.message || String(err);
}

export async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Камера ${i + 1}` }));
  } catch {
    return [];
  }
}

export async function permissionState() {
  try {
    const st = await navigator.permissions.query({ name: 'camera' });
    return st.state; // granted | prompt | denied
  } catch {
    return 'unknown';
  }
}

// Пробуем по очереди: выбранная камера → с параметрами → вообще без требований.
// videoEl — чтобы можно было поднять вторую камеру в отдельный <video>.
export async function startCamera({ deviceId, width = 1280, height = 720, videoEl } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('браузер не даёт доступ к камере (нет getUserMedia)');
  }

  const video = videoEl || document.getElementById('video');
  const attempts = [];
  if (deviceId) attempts.push({ video: { deviceId: { exact: deviceId } }, audio: false });
  attempts.push({
    video: { width: { ideal: width }, height: { ideal: height }, facingMode: 'user' },
    audio: false,
  });
  attempts.push({ video: true, audio: false });

  let stream = null;
  let lastErr = null;
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (err) {
      lastErr = err;
      // если доступ запрещён или камеры нет — дальше пробовать бессмысленно
      if (err.name === 'NotAllowedError' || err.name === 'NotFoundError') break;
    }
  }
  if (!stream) throw lastErr;

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  if (!video.videoWidth) {
    await new Promise((resolve) => {
      video.addEventListener('loadeddata', resolve, { once: true });
    });
  }

  const track = stream.getVideoTracks()[0];
  return {
    video,
    stream,
    width: video.videoWidth,
    height: video.videoHeight,
    label: track?.label || 'камера',
  };
}

export function stopCamera(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
