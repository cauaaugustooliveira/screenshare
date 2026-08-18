const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { AccessToken } = require('livekit-server-sdk');
const { decodeInvite, encodeInvite, validateDisplayName, validateRoomName } = require('./invite-code');
const { detectPrimaryIPv4, getGlobalIPv6s, getLocalIPv4s, getPublicIPv4, getRadminNetwork, waitForTcp } = require('./network-manager');
const { UpnpManager } = require('./upnp-manager');
const { ensureWindowsFirewallRules } = require('./firewall-manager');

const LIVEKIT_PORT = 7880;
const TOKEN_PORT = 7883;

function formatHostForUrl(host) {
  return host.includes(':') ? `[${host}]` : host;
}

function quoteYaml(value) {
  return JSON.stringify(String(value));
}

function safeEqual(expected, supplied) {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(supplied || '', 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class HostManager {
  constructor({ electronApp, resolveServerPath, onStatus }) {
    this.electronApp = electronApp;
    this.resolveServerPath = resolveServerPath;
    this.onStatus = onStatus;
    this.hostState = null;
    this.stopping = false;
  }

  publicStatus(extra = {}) {
    const state = this.hostState;
    if (!state) return { running: false, ...extra };
    return {
      running: true,
      roomName: state.roomName,
      mode: state.mode,
      requestedMode: state.requestedMode,
      address: state.address,
      directProbable: state.directProbable,
      publicIp: state.publicIp,
      radmin: state.radmin ? { name: state.radmin.name, address: state.radmin.address } : null,
      localAddresses: state.localAddresses,
      primaryNetwork: state.primaryNetwork,
      upnpStatus: state.upnpStatus,
      upnpError: state.upnpError,
      ipv6Addresses: state.ipv6Addresses,
      mappings: state.upnp?.mappings.map(({ port, protocol, label, method, verifiedByGateway }) => ({ port, protocol, label, method, verifiedByGateway })) || [],
      ...extra,
    };
  }

  emit(status, message, extra = {}) {
    this.onStatus?.(this.publicStatus({ status, message, ...extra }));
  }

  async createHostedRoom({ roomName, name, mode }) {
    if (process.platform !== 'win32') throw new Error('A hospedagem local está disponível somente no Windows.');
    validateRoomName(roomName);
    validateDisplayName(name);
    if (!['direct', 'radmin'].includes(mode)) throw new Error('Escolha uma forma de hospedagem válida.');

    await this.stopHostedRoom();
    const serverPath = this.resolveServerPath();
    if (!serverPath) {
      throw new Error('livekit-server.exe não encontrado. Coloque-o em app\\bin antes de iniciar o ScreenShare.');
    }

    if (mode === 'direct') {
      this.onStatus?.({
        running: false,
        status: 'requesting-firewall',
        message: 'Preparando o Firewall do Windows. Confirme a janela de permissão para hospedar pela internet.',
      });
      try {
        await ensureWindowsFirewallRules();
      } catch (_) {
        throw new Error('O Firewall do Windows não foi configurado. Confirme a permissão do Windows e tente novamente.');
      }
    }

    const radmin = await getRadminNetwork();
    const primaryNetwork = await detectPrimaryIPv4();
    const localAddresses = primaryNetwork ? [primaryNetwork, ...getLocalIPv4s().filter(({ address }) => address !== primaryNetwork.address)] : getLocalIPv4s();
    const ipv6Addresses = getGlobalIPv6s();
    const preferredIPv6 = null;
    if (mode === 'radmin' && !radmin) {
      throw new Error('Radmin VPN não foi detectado. Conecte-se a uma rede Radmin e tente novamente.');
    }
    if (!localAddresses.length) throw new Error('Nenhuma conexão de rede IPv4 ativa foi encontrada.');

    const apiKey = `SS${crypto.randomBytes(10).toString('hex')}`;
    const apiSecret = crypto.randomBytes(32).toString('base64url');
    const joinKey = crypto.randomBytes(24).toString('base64url');
    const tempDir = await fs.mkdtemp(path.join(this.electronApp.getPath('temp'), 'screenshare-livekit-'));
    const configPath = path.join(tempDir, 'livekit.yaml');
    const config = [
      `port: ${LIVEKIT_PORT}`,
      'log_level: info',
      'rtc:',
      '  tcp_port: 7881',
      '  udp_port: 7882',
      `  use_external_ip: ${mode === 'direct' ? 'true' : 'false'}`,
      'keys:',
      `  ${quoteYaml(apiKey)}: ${quoteYaml(apiSecret)}`,
      '',
    ].join('\n');
    await fs.writeFile(configPath, config, { encoding: 'utf8', mode: 0o600 });

    // Mantemos o bind IPv4 estável. Nesta versão do LiveKit para Windows,
    // combinar 0.0.0.0 e :: encerra o processo em alguns adaptadores; IPv6
    // continua aparecendo no diagnóstico, mas não é anunciado como rota ativa.
    const bindAddress = '0.0.0.0';
    const child = spawn(serverPath, ['--config', configPath, '--bind', bindAddress], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.hostState = {
      roomName,
      requestedMode: mode,
      mode,
      apiKey,
      apiSecret,
      joinKey,
      tempDir,
      configPath,
      child,
      tokenServer: null,
      upnp: null,
      upnpStatus: 'unavailable',
      upnpError: null,
      address: null,
      publicIp: null,
      directProbable: false,
      radmin,
      localAddresses,
      primaryNetwork,
      ipv6Addresses,
      preferredIPv6,
      bindAddress,
      candidates: [],
    };
    const state = this.hostState;
    this.emit('starting-server', 'Iniciando o servidor local…');

    let diagnostics = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-2_000); });
    child.once('error', (error) => {
      if (this.hostState?.child === child && !this.stopping) {
        this.emit('server-error', `Não foi possível iniciar o LiveKit: ${error.message}`);
        void this.stopHostedRoom();
      }
    });
    child.once('exit', (code) => {
      if (this.hostState?.child === child && !this.stopping) {
        const suffix = diagnostics.trim() ? ` (${diagnostics.trim().slice(-300)})` : '';
        this.emit('server-stopped', `O servidor LiveKit foi encerrado inesperadamente (código ${code}).${suffix}`);
        void this.stopHostedRoom();
      }
    });

    const ready = await waitForTcp('127.0.0.1', LIVEKIT_PORT, 12_000);
    if (this.hostState !== state) {
      const suffix = diagnostics.trim() ? ` Detalhe: ${diagnostics.trim().slice(-300)}` : '';
      throw new Error(`O servidor LiveKit foi encerrado durante a inicialização.${suffix}`);
    }
    if (!ready) {
      await this.stopHostedRoom();
      throw new Error('O LiveKit não respondeu localmente. Verifique se as portas 7880–7883 estão livres.');
    }
    this.emit('server-ready', 'Servidor local pronto.');
    try {
      await this.startTokenServer(state);
    } catch (error) {
      await this.stopHostedRoom();
      throw new Error(`Não foi possível abrir o serviço de convites: ${error.message}`);
    }

    if (mode === 'radmin') {
      state.address = radmin.address;
      this.emit('radmin-ready', 'Pronto pela rede Radmin VPN.');
    } else {
      this.emit('trying-upnp', 'Tentando abrir as portas no roteador (UPnP)…');
      let upnp = null;
      try {
        state.upnpStatus = 'discovering';
        upnp = new UpnpManager();
        state.upnp = upnp;
        state.upnpStatus = 'mapping';
        await upnp.openMappings(localAddresses[0].address);
        if (this.hostState !== state) throw new Error('A hospedagem foi encerrada durante a configuração de rede.');
        state.publicIp = upnp.externalIp || await getPublicIPv4();
        if (state.publicIp) {
          state.address = state.publicIp;
          state.directProbable = true;
          state.upnpStatus = 'mapped';
          this.emit('direct-probable', 'Portas criadas no roteador. Conexão direta provavelmente disponível.');
        } else {
          state.address = localAddresses[0].address;
          state.mode = 'lan';
          state.upnpStatus = 'mapped';
          this.emit('direct-unavailable', 'UPnP respondeu, mas não foi possível descobrir o IP público. Use Radmin VPN ou a rede local.');
        }
      } catch (error) {
        await upnp?.close().catch(() => {});
        if (this.hostState !== state) throw new Error('A hospedagem foi encerrada durante a configuração de rede.');
        state.upnp = null;
        state.upnpStatus = 'failed';
        state.upnpError = error.message;
        state.address = localAddresses[0].address;
        state.mode = 'lan';
        this.emit('direct-unavailable', `UPnP indisponível: ${error.message}`);
      }
    }

    if (this.hostState !== state) throw new Error('A hospedagem foi encerrada antes de criar o convite.');
    state.candidates = mode === 'radmin'
      ? [{ host: radmin.address, mode: 'radmin' }]
      : [
          ...localAddresses.map(({ address }) => ({ host: address, mode: 'lan' })),
          ...(state.directProbable ? [{ host: state.publicIp, mode: 'direct' }] : []),
        ];
    const invite = encodeInvite({
      host: state.address,
      port: LIVEKIT_PORT,
      tokenPort: TOKEN_PORT,
      roomName: state.roomName,
      mode: state.mode,
      joinKey: state.joinKey,
      candidates: state.candidates,
    });
    const token = await this.issueToken(state.roomName, name);
    return { ...this.publicStatus(), invite, token, url: `ws://${bindAddress === '::' ? '[::1]' : '127.0.0.1'}:${LIVEKIT_PORT}` };
  }

  async issueToken(roomName, name, state = this.hostState) {
    if (!state || this.hostState !== state) throw new Error('A sala não está sendo hospedada.');
    const token = new AccessToken(state.apiKey, state.apiSecret, {
      identity: validateDisplayName(name),
      ttl: 60 * 60 * 6,
    });
    token.addGrant({ roomJoin: true, room: validateRoomName(roomName), canPublish: true, canSubscribe: true });
    return token.toJwt();
  }

  async startTokenServer(state) {
    if (!state || this.hostState !== state) throw new Error('A sala não está sendo hospedada.');
    const attempts = new Map();
    const server = http.createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/token') {
        response.writeHead(404).end();
        return;
      }
      try {
        const remote = request.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const recent = (attempts.get(remote) || []).filter((time) => now - time < 60_000);
        if (recent.length >= 12) throw new Error('Muitas tentativas.');
        recent.push(now);
        attempts.set(remote, recent);
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body, 'utf8') > 4096) throw new Error('Pedido grande demais.');
        }
        const data = JSON.parse(body);
        if (!safeEqual(state.joinKey, String(data.joinKey || ''))) throw new Error('Convite não autorizado.');
        if (data.roomName !== state.roomName) throw new Error('Convite não autorizado.');
        const token = await this.issueToken(state.roomName, data.name, state);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ token }));
      } catch (error) {
        response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: error.message === 'Convite não autorizado.' ? error.message : 'Pedido inválido.' }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port: TOKEN_PORT, host: state.bindAddress }, () => { server.removeListener('error', reject); resolve(); });
    });
    if (this.hostState !== state) {
      server.close();
      throw new Error('A hospedagem foi encerrada durante a inicialização.');
    }
    state.tokenServer = server;
  }

  async joinHostedRoom({ invite, name }) {
    const data = decodeInvite(invite.trim());
    validateDisplayName(name);
    try {
      let lastError = null;
      for (const candidate of data.candidates) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_500);
        try {
          const response = await fetch(`http://${formatHostForUrl(candidate.host)}:${data.tokenPort}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomName: data.roomName, name, joinKey: data.joinKey }),
            signal: controller.signal,
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || typeof result.token !== 'string') throw new Error(result.error || 'O anfitrião recusou o convite.');
          return { token: result.token, url: `ws://${formatHostForUrl(candidate.host)}:${data.port}`, roomName: data.roomName, mode: candidate.mode };
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError || new Error('Não foi possível alcançar o anfitrião.');
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Não foi possível alcançar o anfitrião em 8 segundos.');
      throw error;
    }
  }

  async stopHostedRoom() {
    const state = this.hostState;
    if (!state) return { stopped: true };
    this.stopping = true;
    this.hostState = null;
    await state.upnp?.close().catch(() => {});
    await new Promise((resolve) => state.tokenServer?.close(() => resolve()) || resolve());
    if (!state.child.killed) state.child.kill();
    await fs.rm(state.tempDir, { recursive: true, force: true }).catch(() => {});
    this.stopping = false;
    this.onStatus?.({ running: false, status: 'stopped', message: 'Hospedagem local encerrada.' });
    return { stopped: true };
  }

  getStatus() { return this.publicStatus(); }
}

module.exports = { HostManager };
