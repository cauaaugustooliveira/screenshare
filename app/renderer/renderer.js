const { Room, RoomEvent, Track } = LivekitClient;

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const audioSink = $('audio-sink');

const state = {
  room: null,
  tiles: new Map(),

  screenSharing: false,
  shareAudio: true,
  systemAudio: null,

  participantVolumes: new Map(),
  hosting: false,
  pendingHostMode: null,
  hostInvite: '',
  hostNetwork: null,
};

const saved = JSON.parse(
  localStorage.getItem('tela:config') || '{}'
);

$('name').value = saved.name || '';
$('room').value = saved.room || '';
$('hostName').value = saved.name || '';

$('joinBtn').addEventListener('click', join);
$('showJoinBtn').addEventListener('click', () => showForm('joinForm'));
$('showHostBtn').addEventListener('click', () => showForm('hostForm'));
$('backFromJoin').addEventListener('click', showLanding);
$('backFromHost').addEventListener('click', showLanding);
$('hostDirectBtn').addEventListener('click', () => createHostedRoom('direct'));
$('hostRadminBtn').addEventListener('click', () => createHostedRoom('radmin'));
$('copyInviteRoomBtn').addEventListener('click', () => copyInviteText(state.hostInvite, $('copyInviteRoomBtn')));

$('leaveBtn').addEventListener('click', () => {
  state.room?.disconnect();
});

$('shareBtn').addEventListener('click', toggleShare);

setupPicker();
setupFilteredAudioBridge();
window.telaAPI?.onHostStatus((status) => updateHostStatus(status));

// Mostra que a janela está preparando o LiveKit e só libera os controles
// depois que todos os handlers acima foram registrados.
requestAnimationFrame(() => {
  requestAnimationFrame(() => $('startup')?.classList.add('hidden'));
});

function showForm(id) {
  $('landingActions').classList.add('hidden');
  $('joinForm').classList.toggle('hidden', id !== 'joinForm');
  $('hostForm').classList.toggle('hidden', id !== 'hostForm');
  $('joinErr').textContent = '';
  $('hostErr').textContent = '';
}

function showLanding() {
  $('join').classList.remove('hidden');
  $('landingActions').classList.remove('hidden');
  $('joinForm').classList.add('hidden');
  $('hostForm').classList.add('hidden');
  $('joinErr').textContent = '';
  $('hostErr').textContent = '';
}

function updateHostStatus(status) {
  state.hostNetwork = status || null;
  const target = $('hostStatus');
  if (target && status?.message) target.textContent = status.message;
  renderConnectionDetails();
}

function renderConnectionDetails() {
  const details = $('connectionDetails');
  const content = $('connectionDetailsContent');
  const status = state.hostNetwork;
  if (!details || !content || !status?.running) return;
  const local = (status.localAddresses || []).map(({ name, address }) => `${name}: ${address}`).join('\n') || 'não detectado';
  const ipv6 = (status.ipv6Addresses || []).map(({ name, address }) => `${name}: ${address}`).join('\n') || 'não detectado';
  const mappings = (status.mappings || []).map(({ protocol, port, method }) => `${protocol} ${port}${method ? ` (${method})` : ''}`).join(', ') || 'nenhum';
  content.textContent = [
    `Modo: ${status.mode || 'preparando'}`,
    `Endereço usado: ${status.address || 'preparando'}`,
    `IPv4 público: ${status.publicIp || 'não detectado'}`,
    `UPnP: ${status.upnpStatus || 'não iniciado'}${status.upnpError ? ` (${status.upnpError})` : ''}`,
    `IPv4 local:\n${local}`,
    `Gateway: ${status.primaryNetwork?.gateway || 'não detectado'}`,
    `IPv6 global:\n${ipv6}`,
    `Mapeamentos: ${mappings}`,
    `Radmin: ${status.radmin?.address || 'não detectado'}`,
  ].join('\n\n');
}

function showShareError(message) {
  const element = $('shareErr');
  if (element) element.textContent = message || '';
}

function suppressLocalAppPlayback(suppress) {
  // O Process Loopback só aceita excluir uma árvore (a do Discord). As tracks
  // remotas do LiveKit são reproduzidas pelo próprio Electron, portanto são
  // silenciadas localmente durante a captura para não voltarem no áudio de tela.
  audioSink.querySelectorAll('audio').forEach((audio) => {
    audio.muted = suppress;
  });
}

/* =========================================================
   ÁUDIO DO SISTEMA FILTRADO
========================================================= */

function setupFilteredAudioBridge() {
  window.telaAPI?.onAudioChunk((pcm) => {
    const audio = state.systemAudio;
    if (!audio?.wanted) return;

    // IPC pode reutilizar o buffer internamente; transfira uma cópia ao worklet.
    const buffer = pcm.slice().buffer;
    if (audio.node) {
      audio.node.port.postMessage(buffer, [buffer]);
    } else {
      // O helper pode começar antes do AudioWorklet terminar de carregar.
      // Mantemos no máximo dois segundos para não acumular memória.
      audio.queuedBytes += buffer.byteLength;
      if (audio.queuedBytes <= 48000 * 2 * 4 * 2) audio.queued.push(buffer);
    }
  });

  window.telaAPI?.onAudioFormat(async (format) => {
    if (!state.systemAudio?.wanted || !state.screenSharing) return;
    try {
      await createSystemAudioTrack(format);
    } catch (error) {
      console.error('Erro criando track de áudio do sistema:', error);
      showShareError('Não foi possível publicar o áudio do sistema. O vídeo continua ativo.');
      await stopSystemAudio({ stopHelper: true });
    }
  });

  window.telaAPI?.onFilteredAudioError(async (message) => {
    console.warn('Captura de áudio filtrada:', message);
    showShareError(message);
    // O helper já encerrou; só fechamos a track publicada e o contexto Web Audio.
    await stopSystemAudio({ stopHelper: false });
  });
}

async function startSystemAudio() {
  // Faça isso antes de iniciar o helper: evita que até o primeiro pacote PCM
  // carregue o áudio recebido pelo próprio app.
  suppressLocalAppPlayback(true);

  state.systemAudio = {
    wanted: true,
    queued: [],
    queuedBytes: 0,
    node: null,
    context: null,
    destination: null,
    mediaTrack: null,
    localTrack: null,
  };

  let result;
  try {
    result = await window.telaAPI.startFilteredAudioCapture();
  } catch (error) {
    state.systemAudio = null;
    suppressLocalAppPlayback(false);
    showShareError(`Não foi possível iniciar o áudio do sistema: ${error.message}`);
    return;
  }

  if (result?.error) {
    state.systemAudio = null;
    suppressLocalAppPlayback(false);
    showShareError(result.error);
  }
}

async function createSystemAudioTrack(format) {
  const audio = state.systemAudio;
  const participant = state.room?.localParticipant;
  if (!audio?.wanted || audio.node || !participant) return;

  if (format?.sampleRate !== 48000 || format?.channels !== 2 || format?.format !== 'f32le') {
    throw new Error('Formato PCM inesperado recebido do helper.');
  }

  const context = new AudioContext({ sampleRate: format.sampleRate });
  await context.audioWorklet.addModule('audio-worklet.js');
  const node = new AudioWorkletNode(context, 'tela-pcm-player', {
    outputChannelCount: [2],
  });
  const destination = context.createMediaStreamDestination();
  node.connect(destination);

  const mediaTrack = destination.stream.getAudioTracks()[0];
  mediaTrack.contentHint = 'music';
  const localTrack = new LivekitClient.LocalAudioTrack(mediaTrack);
  localTrack.source = Track.Source.ScreenShareAudio;

  // A track criada pelo MediaStreamDestination é a ponte correta entre PCM e WebRTC.
  // Não existe API Web que converta PCM diretamente em MediaStreamTrack.
  await participant.publishTrack(localTrack);
  await context.resume();

  if (state.systemAudio !== audio || !audio.wanted) {
    await participant.unpublishTrack(localTrack);
    localTrack.stop();
    await context.close();
    return;
  }

  audio.context = context;
  audio.node = node;
  audio.destination = destination;
  audio.mediaTrack = mediaTrack;
  audio.localTrack = localTrack;

  for (const buffer of audio.queued) node.port.postMessage(buffer, [buffer]);
  audio.queued = [];
  audio.queuedBytes = 0;
  showShareError('');
}

async function stopSystemAudio({ stopHelper }) {
  const audio = state.systemAudio;
  state.systemAudio = null;

  if (audio) {
    audio.wanted = false;
    try {
      if (audio.localTrack) await state.room?.localParticipant?.unpublishTrack(audio.localTrack);
    } catch (error) {
      console.warn('Não foi possível despublicar o áudio do sistema:', error);
    }
    try { audio.localTrack?.stop(); } catch (_) { /* já encerrada */ }
    try { audio.mediaTrack?.stop(); } catch (_) { /* já encerrada */ }
    try { audio.node?.disconnect(); } catch (_) { /* já desconectado */ }
    try { await audio.context?.close(); } catch (_) { /* já fechado */ }
  }

  if (stopHelper) await window.telaAPI.stopFilteredAudioCapture();
  suppressLocalAppPlayback(false);
}

/* =========================================================
   ENTRAR NA SALA
========================================================= */

async function join() {
  const name = $('name').value.trim();
  const roomInput = $('room').value.trim();

  $('joinErr').textContent = '';

  if (!name || !roomInput) {
    $('joinErr').textContent = 'Preencha nome e sala.';
    return;
  }

  localStorage.setItem(
    'tela:config',
    JSON.stringify({
      name,
      room: roomInput,
    })
  );

  try {
    const result = roomInput.startsWith('TELA1:')
      ? await window.telaAPI.joinHostedRoom(roomInput, name)
      : await window.telaAPI.generateToken(roomInput.toUpperCase(), name);

    if (result.error) {
      throw new Error(result.error);
    }
    await connectToRoom({
      name,
      roomName: result.roomName || roomInput.toUpperCase(),
      token: result.token,
      url: result.url,
    });
  } catch (e) {
    $('joinErr').textContent = e.message;
  }
}

async function createHostedRoom(mode) {
  const name = $('hostName').value.trim();
  const roomName = $('hostRoom').value.trim();
  $('hostErr').textContent = '';
  if (!name || !roomName) {
    $('hostErr').textContent = 'Preencha nome e sala.';
    return;
  }

  state.pendingHostMode = mode;
  $('hostDirectBtn').disabled = true;
  $('hostRadminBtn').disabled = true;
  $('hostStatus').textContent = 'Preparando a hospedagem local…';

  try {
    const result = await window.telaAPI.createHostedRoom(roomName, name, mode);
    if (result.error) throw new Error(result.error);
    state.hostInvite = result.invite;
    state.hostNetwork = result;
    $('copyInviteRoomBtn').classList.remove('hidden');
    $('connectionDetails').classList.remove('hidden');
    renderConnectionDetails();
    $('hostStatus').textContent = result.directProbable
      ? 'Convite pronto. A conexão direta é provável; um teste externo independente ainda é necessário para confirmar.'
      : `Convite pronto para ${result.mode === 'radmin' ? 'Radmin VPN' : 'rede local'}.`;
    localStorage.setItem('tela:config', JSON.stringify({ name, room: roomName }));
    state.hosting = true;
    await connectToRoom({ name, roomName: result.roomName, token: result.token, url: result.url });
  } catch (error) {
    $('hostErr').textContent = error.message;
    if (state.hosting) {
      await window.telaAPI.stopHostedRoom();
      state.hosting = false;
    }
  } finally {
    $('hostDirectBtn').disabled = false;
    $('hostRadminBtn').disabled = false;
  }
}

async function copyInviteText(invite, button) {
  if (!invite) return;
  try {
    await navigator.clipboard.writeText(invite);
    button.textContent = 'Convite copiado';
  } catch (_) {
    const fallback = document.createElement('textarea');
    fallback.value = invite;
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand('copy');
    fallback.remove();
    button.textContent = 'Convite copiado';
  }
  setTimeout(() => { button.textContent = 'Copiar convite'; }, 1600);
}

async function connectToRoom({ name, roomName, token, url }) {

  const room = new Room({
    adaptiveStream: true,
    dynacast: true,

    videoCaptureDefaults: {
      resolution: {
        width: 1920,
        height: 1080,
        frameRate: 30,
      },
    },
  });

  state.room = room;

  room
    .on(
      RoomEvent.TrackSubscribed,
      onTrackSubscribed
    )
    .on(
      RoomEvent.TrackUnsubscribed,
      onTrackUnsubscribed
    )
    .on(
      RoomEvent.LocalTrackPublished,
      onLocalTrackPublished
    )
    .on(
      RoomEvent.LocalTrackUnpublished,
      onLocalTrackUnpublished
    )
    .on(
      RoomEvent.ParticipantConnected,
      onParticipantConnected
    )
    .on(
      RoomEvent.ParticipantDisconnected,
      onParticipantDisconnected
    )
    .on(
      RoomEvent.Disconnected,
      onDisconnected
    );

  try {
    await room.connect(
      url,
      token
    );

  } catch (e) {
    state.room = null;
    throw new Error(`Erro ao conectar: ${e.message}`);
  }

  updateParticipantsList();

  $('roomLabel').textContent =
    `Sala ${roomName} — ${name}`;

  $('join')
    .classList
    .add('hidden');

  $('room-view')
    .classList
    .remove('hidden');
}

/* =========================================================
   PARTICIPANTES
========================================================= */

function onParticipantConnected(
  participant
) {
  console.log(
    'Participante entrou:',
    participant.identity
  );

  updateParticipantsList();
}

function onParticipantDisconnected(
  participant
) {
  console.log(
    'Participante saiu:',
    participant.identity
  );

  state.participantVolumes.delete(
    participant.identity
  );

  updateParticipantsList();
}

function updateParticipantsList() {
  const list =
    $('participantsList');

  if (
    !list ||
    !state.room
  ) {
    return;
  }

  list.innerHTML = '';

  const localParticipant =
    state.room.localParticipant;

  const participantsTitle = $('participantsTitle');
  if (participantsTitle) {
    const total = state.room.remoteParticipants.size + (localParticipant ? 1 : 0);
    participantsTitle.textContent = `${total} ${total === 1 ? 'pessoa na sala' : 'pessoas na sala'}`;
  }

  if (localParticipant) {
    list.appendChild(
      createParticipantItem(
        localParticipant.identity,
        true
      )
    );
  }

  state.room.remoteParticipants.forEach(
    (participant) => {
      list.appendChild(
        createParticipantItem(
          participant.identity,
          false
        )
      );
    }
  );
}

function createParticipantItem(
  identity,
  isLocal
) {
  const item =
    document.createElement('li');

  item.className =
    'participant-item';

  if (isLocal) {
    item.classList.add(
      'local'
    );
  }

  const avatar =
    document.createElement('div');

  avatar.className =
    'participant-avatar';

  avatar.style.background = colorForParticipant(identity);

  avatar.textContent =
    identity
      ? identity.charAt(0).toUpperCase()
      : '?';

  const name =
    document.createElement('span');

  name.className =
    'participant-name';

  name.textContent =
    isLocal
      ? `${identity} (você)`
      : identity;

  const status =
    document.createElement('span');

  status.className =
    'participant-status';

  status.title =
    'Online';

  item.appendChild(avatar);
  item.appendChild(name);
  item.appendChild(status);

  return item;
}

/* =========================================================
   COMPARTILHAMENTO DE TELA
========================================================= */

async function toggleShare() {
  const participant =
    state.room?.localParticipant;

  if (!participant) {
    return;
  }

  const btn =
    $('shareBtn');

  btn.disabled = true;

  try {
    /*
      Parar compartilhamento.
    */

    if (state.screenSharing) {
      await stopSystemAudio({ stopHelper: true });
      await participant.setScreenShareEnabled(
        false
      );

      state.screenSharing =
        false;

      btn.textContent =
        'Compartilhar tela';

      showShareError('');

      return;
    }

    /*
      Iniciar compartilhamento.
    */

    await participant.setScreenShareEnabled(true, {
      audio: false,
    });

    state.screenSharing =
      true;

    btn.textContent =
      'Parar compartilhamento';

    if (state.shareAudio) {
      await startSystemAudio();
    }

  } catch (e) {
    state.screenSharing =
      false;

    btn.textContent =
      'Compartilhar tela';

    console.error(
      'Erro ao compartilhar tela:',
      e
    );

  } finally {
    btn.disabled = false;
  }
}

/* =========================================================
   TRACKS
========================================================= */

function onTrackSubscribed(
  track,
  publication,
  participant
) {
  if (
    track.kind ===
    Track.Kind.Video
  ) {
    addVideoTile(
      track,
      participant,
      false
    );

    return;
  }

  if (
    track.kind ===
    Track.Kind.Audio
  ) {
    const audio =
      track.attach();

    audio.dataset.participant =
      participant.identity;

    /*
      Volume salvo daquele participante.
      1 = 100%
    */

    const volume =
      state.participantVolumes.get(
        participant.identity
      ) ?? 1;

    audio.volume =
      volume;

    audio.autoplay =
      true;

    if (state.systemAudio?.wanted) {
      audio.muted = true;
    }

    audioSink.appendChild(
      audio
    );

    /*
      A track de áudio fica salva no Map
      para poder ser removida depois.
    */

    state.tiles.set(
      track.sid,
      audio
    );
  }
}

function onTrackUnsubscribed(
  track
) {
  removeTile(
    track.sid
  );

  track
    .detach()
    .forEach(
      (el) => el.remove()
    );
}

function onLocalTrackPublished(
  publication,
  participant
) {
  if (
    publication.source ===
    Track.Source.ScreenShare &&
    publication.track
  ) {
    addVideoTile(
      publication.track,
      participant,
      true
    );
  }
}

function onLocalTrackUnpublished(
  publication
) {
  if (
    publication.track
  ) {
    removeTile(
      publication.track.sid
    );
  }
}

/* =========================================================
   TILE DE VÍDEO
========================================================= */

function addVideoTile(
  track,
  participant,
  isLocal
) {
  const tile =
    document.createElement('div');

  tile.className =
    'tile';

  tile.dataset.participant =
    participant.identity;

  tile.style.setProperty(
    '--owner-color',
    colorForParticipant(participant.identity)
  );

  const video =
    track.attach();

  video.autoplay =
    true;

  video.playsInline =
    true;

  /*
    Não reproduz o próprio áudio.
  */

  if (isLocal) {
    video.muted =
      true;
  }

  /*
    Identificação sempre visível. O nome deixa de ser apenas uma
    legenda pequena, para ficar claro de quem é cada compartilhamento.
  */

  const owner = document.createElement('div');
  owner.className = 'screen-owner';

  const ownerAvatar = document.createElement('span');
  ownerAvatar.className = 'screen-owner-avatar';
  ownerAvatar.textContent = (participant.identity || '?').charAt(0).toUpperCase();

  const ownerText = document.createElement('span');
  ownerText.className = 'screen-owner-text';

  const ownerName = document.createElement('strong');
  ownerName.textContent = isLocal ? 'Sua tela' : participant.identity;

  const ownerStatus = document.createElement('small');
  ownerStatus.textContent = isLocal ? 'Você está compartilhando' : 'Compartilhando tela';

  ownerText.appendChild(ownerName);
  ownerText.appendChild(ownerStatus);
  owner.appendChild(ownerAvatar);
  owner.appendChild(ownerText);

  /*
    Maximizar
  */

  const maximizeBtn =
    document.createElement(
      'button'
    );

  maximizeBtn.className =
    'tile-maximize';

  maximizeBtn.type =
    'button';

  maximizeBtn.title =
    'Maximizar';

  maximizeBtn.textContent =
    '⛶';

  maximizeBtn.addEventListener(
    'click',
    (event) => {
      event.stopPropagation();

      toggleTileMaximize(
        tile,
        maximizeBtn
      );
    }
  );

  tile.appendChild(video);
  tile.appendChild(owner);
  tile.appendChild(
    maximizeBtn
  );

  /*
    Controle de volume.

    Só aparece para compartilhamentos
    de outras pessoas.
  */

  if (!isLocal) {
    const volumeControl =
      createVolumeControl(
        participant.identity
      );

    tile.appendChild(
      volumeControl
    );
  }

  grid.appendChild(
    tile
  );

  state.tiles.set(
    track.sid,
    tile
  );
}

function colorForParticipant(identity) {
  const colors = ['#6b8dff', '#b779f7', '#38bdf8', '#34d399', '#f59e0b', '#fb7185'];
  let hash = 0;
  for (const character of identity || '') {
    hash = ((hash << 5) - hash) + character.charCodeAt(0);
    hash |= 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

/* =========================================================
   MAXIMIZAR TELA
========================================================= */

function toggleTileMaximize(
  tile,
  button
) {
  const isMaximized =
    tile.classList.contains(
      'maximized'
    );

  /*
    Fecha qualquer outro
    compartilhamento maximizado.
  */

  document
    .querySelectorAll(
      '.tile.maximized'
    )
    .forEach(
      (otherTile) => {
        if (
          otherTile === tile
        ) {
          return;
        }

        otherTile.classList.remove(
          'maximized'
        );

        const otherButton =
          otherTile.querySelector(
            '.tile-maximize'
          );

        if (otherButton) {
          otherButton.textContent =
            '⛶';

          otherButton.title =
            'Maximizar';
        }
      }
    );

  if (isMaximized) {
    tile.classList.remove(
      'maximized'
    );

    button.textContent =
      '⛶';

    button.title =
      'Maximizar';

    document.body.classList.remove(
      'tile-is-maximized'
    );

    return;
  }

  tile.classList.add(
    'maximized'
  );

  button.textContent =
    '✕';

  button.title =
    'Fechar';

  document.body.classList.add(
    'tile-is-maximized'
  );
}

/* =========================================================
   CONTROLE DE VOLUME
========================================================= */

function createVolumeControl(
  identity
) {
  const container =
    document.createElement(
      'div'
    );

  container.className =
    'tile-volume';

  /*
    Botão/ícone de volume.
    Também funciona como mute rápido.
  */

  const volumeButton =
    document.createElement(
      'button'
    );

  volumeButton.className =
    'volume-button';

  volumeButton.type =
    'button';

  volumeButton.title =
    'Mutar áudio';

  /*
    Slider
  */

  const slider =
    document.createElement(
      'input'
    );

  slider.type =
    'range';

  slider.min =
    '0';

  slider.max =
    '100';

  slider.step =
    '1';

  slider.className =
    'volume-slider';

  /*
    Volume inicial
  */

  const currentVolume =
    state.participantVolumes.get(
      identity
    ) ?? 1;

  slider.value =
    String(
      Math.round(
        currentVolume * 100
      )
    );

  updateVolumeButton(
    volumeButton,
    currentVolume
  );

  /*
    Alteração do slider
  */

  slider.addEventListener(
    'input',
    (event) => {
      event.stopPropagation();

      const volume =
        Number(
          slider.value
        ) / 100;

      setParticipantVolume(
        identity,
        volume
      );

      updateVolumeButton(
        volumeButton,
        volume
      );
    }
  );

  slider.addEventListener(
    'click',
    (event) => {
      event.stopPropagation();
    }
  );

  /*
    Clique no ícone:
    0% = mutado
    clicando novamente = volta para 100%
  */

  volumeButton.addEventListener(
    'click',
    (event) => {
      event.stopPropagation();

      const current =
        state.participantVolumes.get(
          identity
        ) ?? 1;

      const newVolume =
        current > 0
          ? 0
          : 1;

      setParticipantVolume(
        identity,
        newVolume
      );

      slider.value =
        String(
          Math.round(
            newVolume * 100
          )
        );

      updateVolumeButton(
        volumeButton,
        newVolume
      );
    }
  );

  container.appendChild(
    volumeButton
  );

  container.appendChild(
    slider
  );

  return container;
}

/* =========================================================
   ALTERAR VOLUME
========================================================= */

function setParticipantVolume(
  identity,
  volume
) {
  /*
    Garante valor entre
    0 e 1.
  */

  const normalizedVolume =
    Math.max(
      0,
      Math.min(
        1,
        volume
      )
    );

  state.participantVolumes.set(
    identity,
    normalizedVolume
  );

  /*
    Altera todas as tracks de áudio
    daquele participante.
  */

  audioSink
    .querySelectorAll(
      `audio[data-participant="${CSS.escape(
        identity
      )}"]`
    )
    .forEach(
      (audio) => {
        audio.volume =
          normalizedVolume;
      }
    );
}

/* =========================================================
   ÍCONE DE VOLUME
========================================================= */

function updateVolumeButton(
  button,
  volume
) {
  if (volume <= 0) {
    button.textContent =
      '🔇';

    button.title =
      'Ativar áudio';

    return;
  }

  if (volume < 0.5) {
    button.textContent =
      '🔉';

    button.title =
      'Mutar áudio';

    return;
  }

  button.textContent =
    '🔊';

  button.title =
    'Mutar áudio';
}

/* =========================================================
   REMOVER TILE / ÁUDIO
========================================================= */

function removeTile(
  sid
) {
  const element =
    state.tiles.get(
      sid
    );

  if (element) {
    element.remove();
  }

  state.tiles.delete(
    sid
  );
}

/* =========================================================
   PICKER
========================================================= */

let pickerSources =
  [];

let pickerTab =
  'screen';

function setupPicker() {
  if (
    !window.telaAPI
  ) {
    return;
  }

  window.telaAPI.onPickSource(
    (sources) => {
      pickerSources =
        sources || [];

      const hasScreen =
        pickerSources.some(
          (source) =>
            source.type ===
            'screen'
        );

      pickerTab =
        hasScreen
          ? 'screen'
          : 'window';

      setActiveTab(
        pickerTab
      );

      renderPickerList();

      /*
        Valor atual do checkbox
        de áudio.
      */

      const checkbox =
        $('shareAudio');

      if (checkbox) {
        checkbox.checked =
          state.shareAudio;
      }

      $('picker')
        .classList
        .remove('hidden');
    }
  );

  $('pickerCancel')
    .addEventListener(
      'click',
      cancelPicker
    );

  document
    .querySelectorAll(
      '.picker-tabs .tab'
    )
    .forEach(
      (button) => {
        button.addEventListener(
          'click',
          () => {
            pickerTab =
              button.dataset.tab;

            setActiveTab(
              pickerTab
            );

            renderPickerList();
          }
        );
      }
    );

  /*
    ESC:
    1. fecha picker;
    2. caso contrário, fecha maximização.
  */

  document.addEventListener(
    'keydown',
    (event) => {
      if (
        event.key !==
        'Escape'
      ) {
        return;
      }

      /*
        Picker aberto
      */

      if (
        !$('picker')
          .classList
          .contains('hidden')
      ) {
        cancelPicker();

        return;
      }

      /*
        Tela maximizada
      */

      const maximized =
        document.querySelector(
          '.tile.maximized'
        );

      if (!maximized) {
        return;
      }

      maximized.classList.remove(
        'maximized'
      );

      const button =
        maximized.querySelector(
          '.tile-maximize'
        );

      if (button) {
        button.textContent =
          '⛶';

        button.title =
          'Maximizar';
      }

      document.body.classList.remove(
        'tile-is-maximized'
      );
    }
  );
}

/* =========================================================
   ABAS DO PICKER
========================================================= */

function setActiveTab(
  tab
) {
  document
    .querySelectorAll(
      '.picker-tabs .tab'
    )
    .forEach(
      (button) => {
        button.classList.toggle(
          'active',
          button.dataset.tab === tab
        );
      }
    );
}

/* =========================================================
   LISTAR TELAS / JANELAS
========================================================= */

function renderPickerList() {
  const list =
    $('pickerList');

  list.innerHTML =
    '';

  const filtered =
    pickerSources.filter(
      (source) =>
        source.type ===
        pickerTab
    );

  if (
    !filtered.length
  ) {
    const empty =
      document.createElement(
        'p'
      );

    empty.className =
      'picker-empty';

    empty.textContent =
      'Nada disponível.';

    list.appendChild(
      empty
    );

    return;
  }

  filtered.forEach(
    (source) => {
      const item =
        document.createElement(
          'button'
        );

      item.className =
        'picker-item';

      item.type =
        'button';

      /*
        Thumbnail
      */

      if (
        source.thumbnail
      ) {
        const img =
          document.createElement(
            'img'
          );

        img.src =
          source.thumbnail;

        img.alt =
          '';

        item.appendChild(
          img
        );
      }

      /*
        Linha com nome
        e ícone.
      */

      const nameRow =
        document.createElement(
          'div'
        );

      nameRow.className =
        'picker-name';

      if (
        source.appIcon
      ) {
        const icon =
          document.createElement(
            'img'
          );

        icon.className =
          'picker-icon';

        icon.src =
          source.appIcon;

        icon.alt =
          '';

        nameRow.appendChild(
          icon
        );
      }

      const label =
        document.createElement(
          'span'
        );

      label.textContent =
        source.name;

      nameRow.appendChild(
        label
      );

      item.appendChild(
        nameRow
      );

      item.addEventListener(
        'click',
        () => {
          choosePicker(
            source.id
          );
        }
      );

      list.appendChild(
        item
      );
    }
  );
}

/* =========================================================
   ESCOLHER TELA
========================================================= */

function choosePicker(
  id
) {
  /*
    Salva a preferência
    de compartilhar áudio.
  */

  const checkbox =
    $('shareAudio');

  state.shareAudio =
    checkbox?.checked ??
    true;

  $('picker')
    .classList
    .add('hidden');

  window.telaAPI
    ?.respondPickSource(
      id
    );
}

/* =========================================================
   CANCELAR PICKER
========================================================= */

function cancelPicker() {
  $('picker')
    .classList
    .add('hidden');

  window.telaAPI
    ?.respondPickSource(
      null
    );
}

/* =========================================================
   DESCONECTAR
========================================================= */

function onDisconnected() {
  if (state.hosting) {
    state.hosting = false;
    void window.telaAPI.stopHostedRoom();
  }
  void stopSystemAudio({ stopHelper: true });
  grid.innerHTML =
    '';

  audioSink.innerHTML =
    '';

  const participantsList =
    $('participantsList');

  if (
    participantsList
  ) {
    participantsList.innerHTML =
      '';
  }

  state.tiles.clear();

  state.participantVolumes.clear();

  state.room =
    null;

  state.screenSharing =
    false;

  state.hostInvite = '';
  state.hostNetwork = null;
  $('copyInviteRoomBtn').classList.add('hidden');
  $('connectionDetails').classList.add('hidden');

  state.shareAudio =
    true;

  $('shareBtn').textContent =
    'Compartilhar tela';

  showShareError('');

  document.body.classList.remove(
    'tile-is-maximized'
  );

  $('room-view')
    .classList
    .add('hidden');

  showLanding();
}
