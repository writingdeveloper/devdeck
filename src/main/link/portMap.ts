/**
 * Asking the router to open the port, so nobody has to open it by hand.
 *
 * A host behind NAT only ever sees its own `192.168.x.x`, so that is all it can honestly put in an
 * invite — and an invite full of private addresses reaches nothing from another network. Port
 * forwarding fixes that, but it is a router admin page, a static lease, and a support conversation.
 * Both protocols here exist to skip all of it: the host asks the gateway to map a port and to say
 * what its public address is, and that address then travels in the invite like any other.
 *
 * Two protocols, because routers disagree about which they answer:
 *  - NAT-PMP (UDP 5351) is four packets and no parsing. Apple's, and widely adopted since.
 *  - UPnP IGD is SSDP discovery, an XML device description, and SOAP. Older, uglier, and the one a
 *    consumer router is most likely to support.
 * NAT-PMP is tried first because it answers in milliseconds or not at all, while UPnP costs a
 * multicast round trip and two HTTP requests before it can fail.
 *
 * WHAT THIS CANNOT DO: when the router is itself behind the ISP's NAT (CGNAT), the "external"
 * address it reports is a carrier address the open internet cannot route to either. The mapping
 * succeeds and is useless. That is detected and reported as its own state rather than advertised —
 * an address that silently reaches nothing is the worst outcome available here.
 */
import { createSocket } from 'node:dgram';
import { request } from 'node:http';

/** How long a mapping is asked for. Renewed at half of it; routers commonly clamp it down. */
export const PORT_MAP_LIFETIME_S = 3600;

export type PortMapState =
  /** The router opened the port and gave a public address. */
  | 'mapped'
  /** Neither protocol answered — the router does not speak them, or they are switched off. */
  | 'unsupported'
  /** A mapping exists, but the address behind it is the carrier's, not the internet's. */
  | 'carrier-nat'
  /** The router answered, and refused. */
  | 'failed';

export interface PortMapResult {
  state: PortMapState;
  via?: 'nat-pmp' | 'upnp';
  externalAddress?: string;
  externalPort?: number;
  lifetimeS?: number;
  detail?: string;
}

// ---- what an external address is worth ----

/**
 * Whether an address the router reported can actually be reached from outside.
 *
 * `100.64.0.0/10` is the giveaway for carrier-grade NAT: the router holds a "public" address that is
 * itself behind the ISP's translator. An RFC1918 answer means a second router in front of this one.
 * Neither is reachable, and advertising either produces an invite that fails with no explanation.
 */
export function externalAddressUsable(ip: string): 'usable' | 'carrier-nat' | 'private' {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'private';
  const [a, b] = parts;
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-nat';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 127 || a === 0 || (a === 169 && b === 254)) return 'private';
  return 'usable';
}

// ---- NAT-PMP ----

/** Opcode 0: "what is your public address". Two bytes, and that is the whole request. */
export function encodeNatPmpExternalRequest(): Buffer {
  return Buffer.from([0, 0]);
}

/** Opcode 2: map a TCP port. Version 0, then the ports and the lifetime being asked for. */
export function encodeNatPmpMapRequest(internalPort: number, externalPort: number, lifetimeS: number): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt8(0, 0);    // version
  buf.writeUInt8(2, 1);    // opcode 2 = map TCP (1 would be UDP)
  buf.writeUInt16BE(0, 2); // reserved
  buf.writeUInt16BE(internalPort, 4);
  buf.writeUInt16BE(externalPort, 6);
  buf.writeUInt32BE(lifetimeS, 8);
  return buf;
}

export function decodeNatPmpExternal(msg: Buffer): { ok: true; address: string } | { ok: false; detail: string } {
  if (msg.length < 12) return { ok: false, detail: `short reply (${msg.length} bytes)` };
  if (msg.readUInt8(1) !== 128) return { ok: false, detail: `unexpected opcode ${msg.readUInt8(1)}` };
  const code = msg.readUInt16BE(2);
  if (code !== 0) return { ok: false, detail: `result code ${code}` };
  return { ok: true, address: [...msg.subarray(8, 12)].join('.') };
}

export function decodeNatPmpMap(msg: Buffer): { ok: true; externalPort: number; lifetimeS: number } | { ok: false; detail: string } {
  if (msg.length < 16) return { ok: false, detail: `short reply (${msg.length} bytes)` };
  if (msg.readUInt8(1) !== 130) return { ok: false, detail: `unexpected opcode ${msg.readUInt8(1)}` };
  const code = msg.readUInt16BE(2);
  if (code !== 0) return { ok: false, detail: `result code ${code}` };
  return { ok: true, externalPort: msg.readUInt16BE(10), lifetimeS: msg.readUInt32BE(12) };
}

// ---- UPnP IGD ----

/** The LOCATION header of an SSDP reply — the URL of the gateway's device description. */
export function parseSsdpLocation(reply: string): string | null {
  const match = /^LOCATION:[ \t]*(\S+)[ \t]*\r?$/im.exec(reply);
  return match ? match[1] : null;
}

/**
 * The control URL of whichever WAN connection service the gateway exposes, resolved against the
 * description's own URL.
 *
 * A gateway offers WANIPConnection (a router on Ethernet or cable) or WANPPPConnection (one dialling
 * PPPoE); which one is not knowable in advance, and a device lists services it does not implement,
 * so the first that carries a control URL is the one used.
 */
export function findWanControlUrl(xml: string, location: string): { controlUrl: string; serviceType: string } | null {
  const base = /<URLBase>\s*([^<]+?)\s*<\/URLBase>/i.exec(xml)?.[1];
  for (const block of xml.split(/<service>/i).slice(1)) {
    const serviceType = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(block)?.[1];
    const controlUrl = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block)?.[1];
    if (!serviceType || !controlUrl) continue;
    if (!/WAN(IP|PPP)Connection:\d+$/i.test(serviceType)) continue;
    try {
      return { controlUrl: new URL(controlUrl, base || location).toString(), serviceType };
    } catch {
      return null;
    }
  }
  return null;
}

export function soapEnvelope(action: string, serviceType: string, args: Record<string, string | number>): string {
  const body = Object.entries(args).map(([key, value]) => `<${key}>${value}</${key}>`).join('');
  return '<?xml version="1.0"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body></s:Envelope>`;
}

export function parseSoapExternalIp(xml: string): string | null {
  return /<NewExternalIPAddress>\s*([^<\s]+)\s*<\/NewExternalIPAddress>/i.exec(xml)?.[1] ?? null;
}

/** A SOAP fault carries the reason the router said no, which is worth reporting as given. */
export function parseSoapFault(xml: string): string | null {
  const code = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(xml)?.[1];
  const description = /<errorDescription>\s*([^<]+?)\s*<\/errorDescription>/i.exec(xml)?.[1];
  if (!code && !description) return null;
  return [code ? `error ${code}` : '', description ?? ''].filter(Boolean).join(': ');
}

// ---- the IO ----

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const NAT_PMP_PORT = 5351;

function natPmpExchange(gateway: string, payload: Buffer, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const done = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closing */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
    socket.on('error', () => { clearTimeout(timer); done(null); });
    socket.on('message', (msg) => { clearTimeout(timer); done(msg); });
    socket.send(payload, NAT_PMP_PORT, gateway, (err) => { if (err) { clearTimeout(timer); done(null); } });
  });
}

async function tryNatPmp(gateway: string, port: number, timeoutMs: number): Promise<PortMapResult | null> {
  const external = await natPmpExchange(gateway, encodeNatPmpExternalRequest(), timeoutMs);
  if (!external) return null; // no answer at all: this router does not speak NAT-PMP
  const address = decodeNatPmpExternal(external);
  if (!address.ok) return { state: 'failed', via: 'nat-pmp', detail: address.detail };
  const mapped = await natPmpExchange(gateway, encodeNatPmpMapRequest(port, port, PORT_MAP_LIFETIME_S), timeoutMs);
  if (!mapped) return { state: 'failed', via: 'nat-pmp', detail: 'no answer to the mapping request' };
  const map = decodeNatPmpMap(mapped);
  if (!map.ok) return { state: 'failed', via: 'nat-pmp', detail: map.detail };
  const usable = externalAddressUsable(address.address);
  return {
    state: usable === 'usable' ? 'mapped' : 'carrier-nat',
    via: 'nat-pmp',
    externalAddress: address.address,
    externalPort: map.externalPort,
    lifetimeS: map.lifetimeS,
    detail: usable === 'usable' ? undefined : `the router's own address is ${usable === 'carrier-nat' ? 'a carrier one' : 'private'}`,
  };
}

/** One SSDP M-SEARCH, returning the description URLs that answered. */
export function discoverIgdLocations(timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const found: string[] = [];
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closing */ }
      resolve(found);
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    socket.on('error', () => { clearTimeout(timer); done(); });
    socket.on('message', (msg) => {
      const location = parseSsdpLocation(msg.toString());
      if (location && !found.includes(location)) found.push(location);
    });
    socket.bind(() => {
      const probe = Buffer.from([
        'M-SEARCH * HTTP/1.1',
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
        'MAN: "ssdp:discover"',
        'MX: 2',
        'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        '', '',
      ].join('\r\n'));
      socket.send(probe, SSDP_PORT, SSDP_ADDRESS, (err) => { if (err) { clearTimeout(timer); done(); } });
    });
  });
}

/**
 * A plain HTTP exchange with the gateway.
 *
 * Deliberately not `fetch`: this is LAN HTTP to a device that frequently gets the framing subtly
 * wrong, the body is small enough to hold in memory, and the timeout has to cover a router that
 * accepts the connection and then says nothing.
 */
export function httpExchange(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number },
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    let target: URL;
    try { target = new URL(url); } catch { resolve(null); return; }
    if (target.protocol !== 'http:') { resolve(null); return; } // a gateway description is never https
    const req = request(target, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { if (body.length < 256 * 1024) body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.setTimeout(init.timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function tryUpnp(port: number, localAddress: string, timeoutMs: number): Promise<PortMapResult | null> {
  const locations = await discoverIgdLocations(timeoutMs);
  for (const location of locations) {
    const described = await httpExchange(location, { timeoutMs });
    if (!described || described.status >= 400) continue;
    const service = findWanControlUrl(described.body, location);
    if (!service) continue;
    const call = (action: string, args: Record<string, string | number>): Promise<{ status: number; body: string } | null> => {
      const body = soapEnvelope(action, service.serviceType, args);
      return httpExchange(service.controlUrl, {
        method: 'POST',
        body,
        timeoutMs,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${service.serviceType}#${action}"`,
          'Content-Length': String(Buffer.byteLength(body)),
        },
      });
    };
    const added = await call('AddPortMapping', {
      NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP',
      NewInternalPort: port, NewInternalClient: localAddress,
      NewEnabled: 1, NewPortMappingDescription: 'DevDeck Link', NewLeaseDuration: 0,
    });
    if (!added) continue;
    if (added.status >= 400) {
      return { state: 'failed', via: 'upnp', detail: parseSoapFault(added.body) ?? `HTTP ${added.status}` };
    }
    const external = await call('GetExternalIPAddress', {});
    const address = external ? parseSoapExternalIp(external.body) : null;
    if (!address) return { state: 'failed', via: 'upnp', detail: 'the router mapped the port but would not say its address' };
    const usable = externalAddressUsable(address);
    return {
      state: usable === 'usable' ? 'mapped' : 'carrier-nat',
      via: 'upnp',
      externalAddress: address,
      externalPort: port,
      detail: usable === 'usable' ? undefined : `the router's own address is ${usable === 'carrier-nat' ? 'a carrier one' : 'private'}`,
    };
  }
  return null;
}

export interface MapPortOptions {
  port: number;
  /** The default gateway, for NAT-PMP. Skipped when unknown. */
  gateway: string | null;
  /** This machine's LAN address — UPnP maps a port TO somewhere, and has to be told where. */
  localAddress: string | null;
  timeoutMs?: number;
}

/**
 * Ask the router to open `port`, by whichever protocol it answers.
 *
 * Never throws: a router that ignores both protocols is the normal case on plenty of networks, and
 * the answer to it is the rest of the address list, not an error.
 */
export async function mapPort(options: MapPortOptions): Promise<PortMapResult> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (options.gateway) {
    const viaPmp = await tryNatPmp(options.gateway, options.port, timeoutMs).catch(() => null);
    if (viaPmp) return viaPmp;
  }
  if (options.localAddress) {
    const viaUpnp = await tryUpnp(options.port, options.localAddress, timeoutMs).catch(() => null);
    if (viaUpnp) return viaUpnp;
  }
  return { state: 'unsupported', detail: 'the router answered neither NAT-PMP nor UPnP' };
}
