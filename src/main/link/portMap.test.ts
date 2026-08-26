import { describe, it, expect, afterEach } from 'vitest';
import { createSocket, type Socket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import {
  decodeNatPmpExternal, decodeNatPmpMap, discoverIgdLocations, encodeNatPmpExternalRequest,
  encodeNatPmpMapRequest, externalAddressUsable, findWanControlUrl, httpExchange, mapPort,
  parseSoapExternalIp, parseSoapFault, parseSsdpLocation, soapEnvelope,
} from './portMap';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

describe('externalAddressUsable', () => {
  it('accepts a routable address', () => {
    expect(externalAddressUsable('203.0.113.7')).toBe('usable');
  });

  it('calls out carrier-grade NAT, where the mapping succeeds and reaches nothing', () => {
    // The router reports 100.x as "its public address" while sitting behind the ISP's translator.
    // Advertising it would produce an invite that fails with no explanation on the other end.
    expect(externalAddressUsable('100.64.0.1')).toBe('carrier-nat');
    expect(externalAddressUsable('100.127.255.254')).toBe('carrier-nat');
    // 100.0-63 and 100.128+ are ordinary public space, not the shared CGNAT range.
    expect(externalAddressUsable('100.63.255.255')).toBe('usable');
    expect(externalAddressUsable('100.128.0.1')).toBe('usable');
  });

  it('calls out a second router in front of this one', () => {
    for (const ip of ['192.168.1.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '169.254.1.1', '127.0.0.1']) {
      expect(externalAddressUsable(ip), ip).toBe('private');
    }
    expect(externalAddressUsable('172.32.0.1')).toBe('usable'); // just outside the private block
  });

  it('treats anything that is not an address as unusable rather than throwing', () => {
    expect(externalAddressUsable('')).toBe('private');
    expect(externalAddressUsable('not-an-ip')).toBe('private');
    expect(externalAddressUsable('1.2.3')).toBe('private');
    expect(externalAddressUsable('1.2.3.999')).toBe('private');
  });
});

describe('NAT-PMP framing', () => {
  it('asks for the external address in two bytes', () => {
    expect([...encodeNatPmpExternalRequest()]).toEqual([0, 0]);
  });

  it('encodes a TCP mapping request the way the protocol specifies', () => {
    const buf = encodeNatPmpMapRequest(47820, 47820, 3600);
    expect(buf).toHaveLength(12);
    expect(buf.readUInt8(0)).toBe(0);   // version
    expect(buf.readUInt8(1)).toBe(2);   // opcode 2 = TCP
    expect(buf.readUInt16BE(4)).toBe(47820);
    expect(buf.readUInt16BE(6)).toBe(47820);
    expect(buf.readUInt32BE(8)).toBe(3600);
  });

  it('reads the external address out of a reply', () => {
    const reply = Buffer.alloc(12);
    reply.writeUInt8(0, 0); reply.writeUInt8(128, 1); reply.writeUInt16BE(0, 2);
    Buffer.from([203, 0, 113, 7]).copy(reply, 8);
    expect(decodeNatPmpExternal(reply)).toEqual({ ok: true, address: '203.0.113.7' });
  });

  it('reports a refusal instead of inventing an address', () => {
    const refused = Buffer.alloc(12);
    refused.writeUInt8(128, 1); refused.writeUInt16BE(2, 2); // 2 = network failure
    expect(decodeNatPmpExternal(refused)).toEqual({ ok: false, detail: 'result code 2' });
    expect(decodeNatPmpExternal(Buffer.alloc(4))).toEqual({ ok: false, detail: 'short reply (4 bytes)' });
    const wrongOp = Buffer.alloc(12); wrongOp.writeUInt8(129, 1);
    expect(decodeNatPmpExternal(wrongOp)).toEqual({ ok: false, detail: 'unexpected opcode 129' });
  });

  it('reads the port the router actually gave, which need not be the one asked for', () => {
    const reply = Buffer.alloc(16);
    reply.writeUInt8(130, 1); reply.writeUInt16BE(0, 2);
    reply.writeUInt16BE(47820, 8); reply.writeUInt16BE(51000, 10); reply.writeUInt32BE(1800, 12);
    expect(decodeNatPmpMap(reply)).toEqual({ ok: true, externalPort: 51000, lifetimeS: 1800 });
  });
});

describe('mapPort over NAT-PMP, against a router that answers', () => {
  /** A gateway that speaks the protocol, so the whole exchange runs for real over UDP. */
  const fakeGateway = (publicIp: number[]): Promise<Socket | null> => new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.on('error', () => resolve(null)); // something else holds 5351 on this machine
    socket.on('message', (msg, rinfo) => {
      if (msg.readUInt8(1) === 0) {
        const reply = Buffer.alloc(12);
        reply.writeUInt8(128, 1); reply.writeUInt32BE(1, 4);
        Buffer.from(publicIp).copy(reply, 8);
        socket.send(reply, rinfo.port, rinfo.address);
        return;
      }
      const reply = Buffer.alloc(16);
      reply.writeUInt8(130, 1);
      reply.writeUInt16BE(msg.readUInt16BE(4), 8);
      reply.writeUInt16BE(msg.readUInt16BE(6), 10);
      reply.writeUInt32BE(3600, 12);
      socket.send(reply, rinfo.port, rinfo.address);
    });
    socket.bind(5351, '127.0.0.1', () => resolve(socket));
  });

  it('opens the port and hands back the public address', async () => {
    const gateway = await fakeGateway([203, 0, 113, 7]);
    if (!gateway) return; // port 5351 is in use here; the framing tests above still cover the protocol
    closers.push(() => new Promise((done) => gateway.close(() => done())));
    const result = await mapPort({ port: 47820, gateway: '127.0.0.1', localAddress: null, timeoutMs: 1500 });
    expect(result).toMatchObject({ state: 'mapped', via: 'nat-pmp', externalAddress: '203.0.113.7', externalPort: 47820 });
  });

  it('refuses to advertise a carrier address, and says why', async () => {
    const gateway = await fakeGateway([100, 71, 3, 9]);
    if (!gateway) return;
    closers.push(() => new Promise((done) => gateway.close(() => done())));
    const result = await mapPort({ port: 47820, gateway: '127.0.0.1', localAddress: null, timeoutMs: 1500 });
    expect(result.state).toBe('carrier-nat');
    expect(result.detail).toContain('carrier');
  });
});

describe('mapPort with nothing listening', () => {
  it('reports that the router does not speak either protocol, rather than throwing', async () => {
    // 192.0.2.0/24 is the documentation range: guaranteed to answer nothing.
    const result = await mapPort({ port: 47820, gateway: '192.0.2.1', localAddress: null, timeoutMs: 250 });
    expect(result.state).toBe('unsupported');
  });
});

describe('UPnP IGD parsing', () => {
  it('finds the description URL in an SSDP reply', () => {
    const reply = ['HTTP/1.1 200 OK', 'CACHE-CONTROL: max-age=1800', 'LOCATION: http://192.168.1.254:5000/rootDesc.xml', 'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1', '', ''].join('\r\n');
    expect(parseSsdpLocation(reply)).toBe('http://192.168.1.254:5000/rootDesc.xml');
    expect(parseSsdpLocation('HTTP/1.1 200 OK\r\n\r\n')).toBeNull();
  });

  it('resolves a relative control URL against the description it came from', () => {
    const xml = `<root><device><serviceList>
      <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service>
      <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
    </serviceList></device></root>`;
    expect(findWanControlUrl(xml, 'http://192.168.1.254:5000/rootDesc.xml')).toEqual({
      controlUrl: 'http://192.168.1.254:5000/ctl/IPConn',
      serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    });
  });

  it('prefers URLBase when the gateway supplies one', () => {
    const xml = `<root><URLBase>http://10.0.0.1:1900/</URLBase><device><serviceList>
      <service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>ctl/PPP</controlURL></service>
    </serviceList></device></root>`;
    expect(findWanControlUrl(xml, 'http://10.0.0.1:5000/desc.xml')?.controlUrl).toBe('http://10.0.0.1:1900/ctl/PPP');
  });

  it('takes a dialling gateway as readily as a cable one', () => {
    const xml = '<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>/ppp</controlURL></service></serviceList></device></root>';
    expect(findWanControlUrl(xml, 'http://192.168.0.1/d.xml')?.serviceType).toContain('WANPPPConnection');
  });

  it('ignores a device that lists no WAN connection service', () => {
    const xml = '<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/cic</controlURL></service></serviceList></device></root>';
    expect(findWanControlUrl(xml, 'http://192.168.0.1/d.xml')).toBeNull();
    expect(findWanControlUrl('<root></root>', 'http://192.168.0.1/d.xml')).toBeNull();
  });

  it('builds a SOAP body the router will accept', () => {
    const body = soapEnvelope('AddPortMapping', 'urn:schemas-upnp-org:service:WANIPConnection:1', { NewExternalPort: 47820, NewProtocol: 'TCP' });
    expect(body).toContain('<u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">');
    expect(body).toContain('<NewExternalPort>47820</NewExternalPort>');
    expect(body).toContain('<NewProtocol>TCP</NewProtocol>');
  });

  it('reads the external address, and a refusal, out of a SOAP reply', () => {
    expect(parseSoapExternalIp('<s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body>')).toBe('203.0.113.7');
    expect(parseSoapExternalIp('<s:Body></s:Body>')).toBeNull();
    expect(parseSoapFault('<UPnPError><errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription></UPnPError>'))
      .toBe('error 718: ConflictInMappingEntry');
    expect(parseSoapFault('<ok/>')).toBeNull();
  });
});

describe('httpExchange', () => {
  const serve = (handler: (url: string, body: string) => { status: number; body: string }): Promise<{ server: Server; base: string }> =>
    new Promise((resolve) => {
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const out = handler(req.url ?? '', body);
          res.writeHead(out.status, { 'Content-Type': 'text/xml' });
          res.end(out.body);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve({ server, base: `http://127.0.0.1:${port}` });
      });
    });

  it('runs a real SOAP call end to end against a gateway that answers', async () => {
    const { server, base } = await serve((url, body) => {
      if (url === '/desc.xml') {
        return { status: 200, body: '<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>' };
      }
      if (body.includes('AddPortMapping')) return { status: 200, body: '<s:Body><u:AddPortMappingResponse/></s:Body>' };
      return { status: 200, body: '<s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body>' };
    });
    closers.push(() => new Promise((done) => server.close(() => done())));

    const described = await httpExchange(`${base}/desc.xml`, { timeoutMs: 2000 });
    const service = findWanControlUrl(described!.body, `${base}/desc.xml`)!;
    expect(service.controlUrl).toBe(`${base}/ctl`);

    const added = await httpExchange(service.controlUrl, {
      method: 'POST', timeoutMs: 2000,
      body: soapEnvelope('AddPortMapping', service.serviceType, { NewExternalPort: 47820 }),
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service.serviceType}#AddPortMapping"` },
    });
    expect(added?.status).toBe(200);

    const external = await httpExchange(service.controlUrl, {
      method: 'POST', timeoutMs: 2000,
      body: soapEnvelope('GetExternalIPAddress', service.serviceType, {}),
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service.serviceType}#GetExternalIPAddress"` },
    });
    expect(parseSoapExternalIp(external!.body)).toBe('203.0.113.7');
  });

  it('answers null rather than throwing when the gateway is not there', async () => {
    expect(await httpExchange('http://127.0.0.1:1/desc.xml', { timeoutMs: 500 })).toBeNull();
    expect(await httpExchange('not a url', { timeoutMs: 500 })).toBeNull();
    // A description is served over plain HTTP; anything else is not a gateway talking.
    expect(await httpExchange('https://example.invalid/desc.xml', { timeoutMs: 500 })).toBeNull();
  });
});

describe('discoverIgdLocations', () => {
  it('gives up quietly when no gateway answers the multicast', async () => {
    expect(await discoverIgdLocations(300)).toEqual([]);
  });
});
