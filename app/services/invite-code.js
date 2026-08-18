const net = require('net');

const PREFIX = 'TELA1:';
const MODES = new Set(['direct', 'radmin', 'lan', 'ipv6']);

function validateRoomName(room) {
  if (typeof room !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(room)) {
    throw new Error('Nome da sala inválido. Use letras, números, _ ou - (até 64 caracteres).');
  }
  return room;
}

function validateDisplayName(name) {
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 48) {
    throw new Error('Informe um nome entre 1 e 48 caracteres.');
  }
  return name.trim();
}

function validateHost(host) {
  if (typeof host !== 'string' || host.length > 253) throw new Error('Endereço do host inválido.');
  if (net.isIP(host) === 4 || net.isIP(host) === 6) return host;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || host.includes('..')) {
    throw new Error('Endereço do host inválido.');
  }
  return host.toLowerCase();
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Porta inválida.');
  return port;
}

function validateJoinKey(joinKey) {
  if (typeof joinKey !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(joinKey)) {
    throw new Error('Código de convite inválido.');
  }
  return joinKey;
}

function validateCandidates(candidates, fallback) {
  if (candidates === undefined) return [fallback];
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 8) {
    throw new Error('Rotas do convite inválidas.');
  }
  return candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('Rotas do convite inválidas.');
    const host = validateHost(candidate.host);
    if (!MODES.has(candidate.mode)) throw new Error('Rotas do convite inválidas.');
    return { host, mode: candidate.mode };
  });
}

function encodeInvite({ host, port = 7880, tokenPort = 7883, roomName, mode, joinKey, candidates }) {
  const payload = {
    v: 1,
    h: validateHost(host),
    p: validatePort(port),
    tp: validatePort(tokenPort),
    r: validateRoomName(roomName),
    m: mode,
    k: validateJoinKey(joinKey),
  };
  if (!MODES.has(payload.m)) throw new Error('Modo de hospedagem inválido.');
  payload.c = validateCandidates(candidates, { host: payload.h, mode: payload.m });
  return `${PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function decodeInvite(invite) {
  if (typeof invite !== 'string' || !invite.startsWith(PREFIX) || invite.length > 1200) {
    throw new Error('Código de sala inválido.');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(invite.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch (_) {
    throw new Error('Código de sala inválido.');
  }
  if (!payload || payload.v !== 1 || !MODES.has(payload.m)) throw new Error('Código de sala incompatível.');
  const allowedKeys = new Set(['v', 'h', 'p', 'tp', 'r', 'm', 'k', 'c']);
  if (Object.keys(payload).some((key) => !allowedKeys.has(key))) throw new Error('Código de sala incompatível.');
  return {
    host: validateHost(payload.h),
    port: validatePort(payload.p),
    tokenPort: validatePort(payload.tp),
    roomName: validateRoomName(payload.r),
    mode: payload.m,
    joinKey: validateJoinKey(payload.k),
    candidates: validateCandidates(payload.c, { host: validateHost(payload.h), mode: payload.m }),
  };
}

module.exports = { PREFIX, decodeInvite, encodeInvite, validateDisplayName, validateRoomName };
