// Biblioteca JavaScript pura: não usa addon nativo e é compatível com Electron.
const LIVEKIT_MAPPINGS = [
  { port: 7880, protocol: 'TCP', label: 'sinalização LiveKit' },
  { port: 7881, protocol: 'TCP', label: 'ICE/TCP LiveKit' },
  { port: 7882, protocol: 'UDP', label: 'ICE/UDP mux LiveKit' },
  { port: 7883, protocol: 'TCP', label: 'convites ScreenShare' },
];

class UpnpManager {
  constructor() { this.gateway = null; this.mappings = []; this.method = null; this.refreshTimer = null; this.localIp = null; }

  async openMappings(localIp) {
    const { upnpNat } = await import('@achingbrain/nat-port-mapper');
    const client = upnpNat();
    for await (const gateway of client.findGateways({ signal: AbortSignal.timeout(8_000) })) {
      this.gateway = gateway;
      break;
    }
    if (!this.gateway) throw new Error('Nenhum roteador UPnP foi encontrado.');

    this.method = 'upnp';
    this.localIp = localIp;
    await this.mapAll(localIp);
    this.externalIp = await this.gateway.externalIp().catch(() => null);
    this.scheduleRefresh();
    return this.mappings;
  }

  async openNatPmpMappings(localIp, gatewayIp) {
    if (!gatewayIp) throw new Error('Gateway IPv4 não encontrado para NAT-PMP.');
    const { pmpNat } = await import('@achingbrain/nat-port-mapper');
    this.gateway = pmpNat(gatewayIp, { autoRefresh: false });
    this.method = 'nat-pmp';
    return this.mapAll(localIp);
  }

  async mapAll(localIp) {
    for (const spec of LIVEKIT_MAPPINGS) {
      const mapping = await this.gateway.map(spec.port, localIp, { protocol: spec.protocol.toLowerCase(), ttl: 60 * 60 * 1000 });
      // A resposta do gateway confirma a regra criada, mas não é uma prova de
      // alcançabilidade externa: CGNAT e firewall da operadora ainda podem impedir acesso.
      this.mappings.push({ ...spec, mapping, method: this.method, verifiedByGateway: true });
    }
    return this.mappings;
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshMappings().catch(() => {}), 30 * 60 * 1000);
  }

  async refreshMappings() {
    if (!this.gateway || !this.localIp) return;
    this.mappings = [];
    await this.mapAll(this.localIp);
    this.scheduleRefresh();
  }

  async close() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (!this.gateway) return;
    await Promise.allSettled(this.mappings.map(({ port }) => this.gateway.unmap(port)));
    await this.gateway.stop().catch(() => {});
    this.gateway = null;
    this.mappings = [];
  }
}

module.exports = { LIVEKIT_MAPPINGS, UpnpManager };
