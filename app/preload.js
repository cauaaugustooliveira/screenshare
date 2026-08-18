const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('telaAPI', {
  generateToken: (room, name) =>
    ipcRenderer.invoke('tela:generate-token', { room, name }),

  createHostedRoom: (roomName, name, mode) =>
    ipcRenderer.invoke('tela:create-hosted-room', { roomName, name, mode }),

  joinHostedRoom: (invite, name) =>
    ipcRenderer.invoke('tela:join-hosted-room', { invite, name }),

  stopHostedRoom: () => ipcRenderer.invoke('tela:stop-hosted-room'),
  getHostStatus: () => ipcRenderer.invoke('tela:get-host-status'),

  onHostStatus: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on('tela:host-status', listener);
    return () => ipcRenderer.removeListener('tela:host-status', listener);
  },

  onPickSource: (handler) => {
    const listener = (_e, sources) => handler(sources);

    ipcRenderer.on('tela:pick-source', listener);

    return () =>
      ipcRenderer.removeListener('tela:pick-source', listener);
  },

  respondPickSource: (sourceId) => {
    ipcRenderer.send(
      'tela:pick-source-response',
      sourceId ?? null
    );
  },

  startFilteredAudioCapture: () =>
    ipcRenderer.invoke('tela:start-filtered-audio-capture'),

  stopFilteredAudioCapture: () =>
    ipcRenderer.invoke('tela:stop-filtered-audio-capture'),

  onAudioFormat: (handler) => {
    const listener = (_event, format) => handler(format);
    ipcRenderer.on('tela:audio-format', listener);
    return () => ipcRenderer.removeListener('tela:audio-format', listener);
  },

  onAudioChunk: (handler) => {
    const listener = (_event, pcm) => handler(new Uint8Array(pcm));
    ipcRenderer.on('tela:audio-chunk', listener);
    return () => ipcRenderer.removeListener('tela:audio-chunk', listener);
  },

  onFilteredAudioError: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on('tela:filtered-audio-error', listener);
    return () => ipcRenderer.removeListener('tela:filtered-audio-error', listener);
  },
});
