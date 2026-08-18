const https = require('https');
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function getLocalIPv4s() {
  const addresses = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      addresses.push({ name, address: entry.address });
    }
  }
  return addresses;
}

function getGlobalIPv6s() {
  const addresses = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const address = String(entry.address || '').split('%')[0].toLowerCase();
      if (entry.family !== 'IPv6' || entry.internal || !address) continue;
      // Exclui link-local, loopback, ULA e IPv4 mapeado. O restante é um
      // candidato global; alcançabilidade externa ainda depende do firewall.
      if (/^(fe[89ab]|f[cd]|::1$|::ffff:)/.test(address)) continue;
      if (net.isIP(address) === 6) addresses.push({ name, address });
    }
  }
  return addresses;
}

async function getPreferredGlobalIPv6() {
  const fallback = getGlobalIPv6s()[0] || null;
  if (process.platform !== 'win32') return fallback;
  const script = [
    "$items = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notmatch '^(fe80|fc|fd|::1)' }",
    "$stable = $items | Where-Object { $_.SuffixOrigin -ne 'Random' } | Select-Object -First 1",
    '($stable ?? ($items | Select-Object -First 1)) | Select-Object InterfaceAlias,IPAddress | ConvertTo-Json -Compress',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4_000, windowsHide: true });
    const result = stdout.trim() ? JSON.parse(stdout) : null;
    if (result?.IPAddress && net.isIP(result.IPAddress) === 6) return { name: result.InterfaceAlias, address: result.IPAddress };
  } catch (_) { /* IPv4 permanece como alternativa */ }
  return fallback;
}

async function getDefaultGatewayIPv4() {
  if (process.platform !== 'win32') return null;
  const script = "Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1 -ExpandProperty NextHop";
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4_000, windowsHide: true });
    const gateway = stdout.trim();
    return net.isIP(gateway) === 4 ? gateway : null;
  } catch (_) { return null; }
}

async function detectPrimaryIPv4() {
  const fallback = getLocalIPv4s()[0] || null;
  if (process.platform !== 'win32') return fallback && { ...fallback, gateway: null };
  const script = [
    "$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1",
    '$result = if ($route) {',
    "  $ip = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1",
    '  $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue',
    '  if ($ip) { [pscustomobject]@{ name = $adapter.Name; address = $ip.IPAddress; gateway = $route.NextHop } }',
    '}; $result | ConvertTo-Json -Compress',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4_000, windowsHide: true });
    const result = stdout.trim() ? JSON.parse(stdout) : null;
    if (result?.address && net.isIP(result.address) === 4) return result;
  } catch (_) { /* usa fallback */ }
  return fallback && { ...fallback, gateway: null };
}

function getRadminNetworkFromNode() {
  return getLocalIPv4s().find(({ name, address }) =>
    /(radmin|famatech)/i.test(name) && /^26\./.test(address),
  ) || null;
}

async function getRadminNetwork() {
  // O Node só expõe o alias da interface. No Windows consultamos também a
  // descrição do adaptador, pois ela pode conter Radmin/Famatech mesmo quando
  // o usuário renomeou a conexão. O script é fixo, sem entrada do usuário.
  if (process.platform !== 'win32') return getRadminNetworkFromNode();
  const script = [
    "$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like '26.*' }",
    '$found = foreach ($ip in $ips) {',
    '  $adapter = Get-NetAdapter -InterfaceIndex $ip.InterfaceIndex -ErrorAction SilentlyContinue',
    "  if ($adapter -and (($adapter.Name -match 'radmin|famatech') -or ($adapter.InterfaceDescription -match 'radmin|famatech'))) {",
    '    [pscustomobject]@{ name = $adapter.Name; description = $adapter.InterfaceDescription; address = $ip.IPAddress }; break',
    '  }',
    '}',
    '$found | ConvertTo-Json -Compress',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4_000, windowsHide: true });
    const found = stdout.trim() ? JSON.parse(stdout) : null;
    if (found?.address && /^26\./.test(found.address)) return found;
  } catch (_) { /* usa o alias disponível no Node como alternativa */ }
  return getRadminNetworkFromNode();
}

function fetchText(url, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'ScreenShare/1.0' }, timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body.trim()));
    });
    request.on('timeout', () => request.destroy(new Error('Tempo esgotado')));
    request.on('error', reject);
  });
}

async function getPublicIPv4() {
  for (const provider of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try {
      const ip = await fetchText(provider);
      if (net.isIP(ip) === 4) return ip;
    } catch (_) { /* tenta o próximo provedor */ }
  }
  return null;
}

function waitForTcp(host, port, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let finished = false;

    const finish = (value) => {
      if (finished) return;
      finished = true;
      resolve(value);
    };

    const attempt = () => {
      if (Date.now() >= deadline) return finish(false);
      const socket = net.createConnection({ host, port });
      let retryScheduled = false;
      const retry = () => {
        if (retryScheduled || finished) return;
        retryScheduled = true;
        socket.destroy();
        if (Date.now() >= deadline) finish(false);
        else setTimeout(attempt, 200);
      };
      socket.setTimeout(Math.min(1_000, Math.max(1, deadline - Date.now())));
      socket.once('connect', () => { socket.destroy(); finish(true); });
      socket.once('timeout', retry);
      socket.once('error', retry);
    };

    attempt();
  });
}

module.exports = { detectPrimaryIPv4, getDefaultGatewayIPv4, getGlobalIPv6s, getLocalIPv4s, getPreferredGlobalIPv6, getPublicIPv4, getRadminNetwork, waitForTcp };
