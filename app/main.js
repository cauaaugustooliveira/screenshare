const { app, BrowserWindow, session, desktopCapturer, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { AccessToken } = require('livekit-server-sdk');

let credentials = null;
try {
  const c = require('./credentials.json');
  if (c && c.LIVEKIT_URL && c.LIVEKIT_API_KEY && c.LIVEKIT_API_SECRET) {
    credentials = c;
  }
} catch (_e) {
  credentials = null;
}

let mainWindow = null;
let pendingPick = null;
let audioCapture = null;

const AUDIO_HEADER_SIZE = 16;
const AUDIO_MAGIC = 'TLAU';

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function resolveAudioCapturePath() {
  // extraResources fica ao lado do app.asar depois do empacotamento.
  const packagedPath = path.join(
    process.resourcesPath,
    'audio-capture',
    'AudioCapture.exe',
  );
  const developmentPaths = [
    path.join(__dirname, 'native', 'audio-capture', 'build', 'Release', 'AudioCapture.exe'),
    path.join(__dirname, 'native', 'audio-capture', 'build', 'AudioCapture.exe'),
  ];

  return [packagedPath, ...developmentPaths].find(fs.existsSync) || null;
}

function appendBuffer(left, right) {
  return left.length ? Buffer.concat([left, right]) : right;
}

function stopFilteredAudioCapture() {
  const capture = audioCapture;
  audioCapture = null;

  if (!capture) return Promise.resolve();

  capture.stopping = true;
  capture.child.stdout.removeAllListeners('data');

  return new Promise((resolve) => {
    const forceKill = setTimeout(() => {
      if (!capture.child.killed) capture.child.kill();
      resolve();
    }, 1500);

    capture.child.once('exit', () => {
      clearTimeout(forceKill);
      resolve();
    });

    // No Windows, ChildProcess.kill encerra o .exe sem usar shell/PowerShell.
    if (!capture.child.killed) capture.child.kill();
  });
}

function startFilteredAudioCapture() {
  if (process.platform !== 'win32') {
    return { error: 'A captura de áudio filtrada está disponível somente no Windows.' };
  }

  const helperPath = resolveAudioCapturePath();
  if (!helperPath) {
    return {
      error: 'AudioCapture.exe não encontrado. Compile o helper nativo antes de iniciar o app.',
    };
  }

  // Uma nova captura sempre substitui integralmente a anterior.
  void stopFilteredAudioCapture();

  const child = spawn(helperPath, [`--parent-pid=${process.pid}`], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const capture = {
    child,
    stopping: false,
    headerReceived: false,
    pending: Buffer.alloc(0),
    frameBytes: 8,
    lastError: '',
  };
  audioCapture = capture;

  child.stdout.on('data', (chunk) => {
    if (audioCapture !== capture || capture.stopping) return;

    capture.pending = appendBuffer(capture.pending, chunk);

    if (!capture.headerReceived) {
      if (capture.pending.length < AUDIO_HEADER_SIZE) return;

      const header = capture.pending.subarray(0, AUDIO_HEADER_SIZE);
      capture.pending = capture.pending.subarray(AUDIO_HEADER_SIZE);

      const valid = header.subarray(0, 4).toString('ascii') === AUDIO_MAGIC
        && header.readUInt16LE(4) === 1
        && header.readUInt16LE(6) === 2
        && header.readUInt32LE(8) === 48000
        && header.readUInt16LE(12) === 32;

      if (!valid) {
        sendToRenderer('tela:filtered-audio-error', 'O helper enviou um formato de áudio inválido.');
        void stopFilteredAudioCapture();
        return;
      }

      capture.headerReceived = true;
      sendToRenderer('tela:audio-format', {
        sampleRate: 48000,
        channels: 2,
        format: 'f32le',
      });
    }

    // Entrega somente frames completos (2 canais * float32) ao renderer.
    const fullBytes = capture.pending.length - (capture.pending.length % capture.frameBytes);
    if (!fullBytes) return;

    const pcm = capture.pending.subarray(0, fullBytes);
    capture.pending = capture.pending.subarray(fullBytes);
    sendToRenderer('tela:audio-chunk', pcm);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (message) => {
    // stderr é o canal de diagnóstico do helper; stdout permanece exclusivamente binário.
    const diagnostic = message.trim();
    console.warn('[AudioCapture]', diagnostic);
    if (diagnostic.startsWith('ERROR ')) {
      capture.lastError = diagnostic.slice('ERROR '.length);
    }
  });

  child.once('error', (error) => {
    if (audioCapture === capture && !capture.stopping) {
      audioCapture = null;
      sendToRenderer('tela:filtered-audio-error', `Não foi possível iniciar o áudio filtrado: ${error.message}`);
    }
  });

  child.once('exit', (code) => {
    if (audioCapture !== capture) return;
    audioCapture = null;

    if (!capture.stopping && code !== 0) {
      sendToRenderer(
        'tela:filtered-audio-error',
        capture.lastError
          ? `A captura de áudio filtrada falhou: ${capture.lastError}`
          : 'A captura de áudio filtrada parou. O vídeo continua sendo compartilhado.',
      );
    }
  });

  return { started: true };
}

function createWindow() {
  // Remove a barra padrão File/Edit/View/Window/Help do Windows.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'ScreenShare',
    backgroundColor: '#1e1e22',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: {
            width: 320,
            height: 180
          },
          fetchWindowIcons: true,
        });

        const chosenId = await requestPick(sources);

        if (!chosenId) {
          return callback({});
        }

        const chosen = sources.find(
          (s) => s.id === chosenId
        );

        if (!chosen) {
          return callback({});
        }

        // Somente vídeo.
        // O áudio será publicado separadamente.
        callback({
          video: chosen
        });

      } catch (e) {
        console.error(
          'display media handler error',
          e
        );

        callback({});
      }
    },
    {
      useSystemPicker: true,
    }
  );

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function requestPick(sources) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve(null);
    if (pendingPick) {
      pendingPick(null);
      pendingPick = null;
    }
    pendingPick = resolve;
    const payload = sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail?.toDataURL() || null,
      appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
    }));
    mainWindow.webContents.send('tela:pick-source', payload);
  });
}

ipcMain.on('tela:pick-source-response', (_e, sourceId) => {
  if (pendingPick) {
    pendingPick(sourceId || null);
    pendingPick = null;
  }
});

ipcMain.handle('tela:start-filtered-audio-capture', () => startFilteredAudioCapture());
ipcMain.handle('tela:stop-filtered-audio-capture', async () => {
  await stopFilteredAudioCapture();
  return { stopped: true };
});

ipcMain.handle('tela:generate-token', async (_e, { room, name }) => {
  if (!credentials) {
    return {
      error: 'App nao configurado. Fale com quem enviou este .exe para gerar uma versao com credenciais.',
    };
  }
  if (!room || !name) {
    return { error: 'Nome e codigo da sala sao obrigatorios.' };
  }
  try {
    const at = new AccessToken(credentials.LIVEKIT_API_KEY, credentials.LIVEKIT_API_SECRET, {
      identity: name,
      ttl: 60 * 60 * 6,
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
    });
    return { token: await at.toJwt(), url: credentials.LIVEKIT_URL };
  } catch (e) {
    return { error: `Erro gerando token: ${e.message}` };
  }
});

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  // Não deixe um AudioCapture.exe sobreviver ao encerramento do Electron.
  void stopFilteredAudioCapture();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
