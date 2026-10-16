/**
 * The router port mapping's lifecycle against the server it was asked for. The router itself is
 * stubbed: what is under test is that an answer arriving for a server that has since been replaced
 * (a port change, host mode off) is thrown away rather than adopted and renewed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortMapResult, MapPortOptions } from './portMap';

vi.mock('electron', () => ({ clipboard: { readText: () => '' } }));

const asked: { options: MapPortOptions; answer: (r: PortMapResult) => void }[] = [];
vi.mock('./portMap', () => ({
  PORT_MAP_LIFETIME_S: 3600,
  mapPort: (options: MapPortOptions) => new Promise<PortMapResult>((resolve) => { asked.push({ options, answer: resolve }); }),
}));
vi.mock('./defaultGateway', () => ({
  defaultGateway: async () => '192.168.1.1',
  localAddressFor: async () => '192.168.1.50',
}));

import { createLinkService, type LinkPersistence, type LinkService } from './linkService';
import { makeMethodTable } from '../api/methods';
import { makeEventHub } from '../api/events';
import type { KnownHost, PairedDevice } from './devices';

const dirs: string[] = [];
const services: LinkService[] = [];

function memoryStore(): LinkPersistence {
  let hostMode = false;
  let devices: PairedDevice[] = [];
  let hosts: KnownHost[] = [];
  let port = 0;
  return {
    getHostMode: () => hostMode, setHostMode: (on) => { hostMode = on; },
    getPort: () => port, setPort: (p) => { port = p; },
    getPairedDevices: () => devices, setPairedDevices: (d) => { devices = d; },
    getKnownHosts: () => hosts, setKnownHosts: (h) => { hosts = h; },
  };
}

/** setPort refuses 0, and the default port may well be taken by a real DevDeck on this machine. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  asked.length = 0;
});

describe('router port mapping', () => {
  it('discards an answer for a server that a port change has already replaced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devdeck-portmap-'));
    dirs.push(dir);
    const service = createLinkService({
      userDataDir: dir,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t), decryptString: (b) => b.toString() },
      api: { methods: makeMethodTable().table, events: makeEventHub() },
      machineId: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      machineName: () => 'host',
      appVersion: '1.34.1',
      store: memoryStore(),
      onError: () => undefined,
    });
    services.push(service);

    await service.setHostMode(true);
    await waitFor(() => asked.length === 1);
    const firstPort = asked[0].options.port;

    // Changed before the router answered for the first server.
    await service.setPort(await freePort());
    await waitFor(() => asked.length === 2);
    const secondPort = service.hostStatus().port;
    expect(asked[1].options.port).toBe(secondPort);

    asked[0].answer({ state: 'mapped', via: 'nat-pmp', externalAddress: '203.0.113.7', externalPort: firstPort, lifetimeS: 120 });
    await new Promise((r) => setTimeout(r, 20));
    // Neither published as this host's mapping nor (same path) renewed.
    expect(service.hostStatus().portMap).toBeNull();

    asked[1].answer({ state: 'mapped', via: 'nat-pmp', externalAddress: '203.0.113.7', externalPort: secondPort, lifetimeS: 120 });
    await waitFor(() => service.hostStatus().portMap !== null);
    expect(service.hostStatus().portMap?.externalPort).toBe(secondPort);
  });

  it('discards an answer that arrives after host mode was turned off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devdeck-portmap-'));
    dirs.push(dir);
    const service = createLinkService({
      userDataDir: dir,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t), decryptString: (b) => b.toString() },
      api: { methods: makeMethodTable().table, events: makeEventHub() },
      machineId: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      machineName: () => 'host',
      appVersion: '1.34.1',
      store: memoryStore(),
      onError: () => undefined,
    });
    services.push(service);
    await service.setHostMode(true);
    await waitFor(() => asked.length === 1);
    await service.setHostMode(false);
    asked[0].answer({ state: 'mapped', via: 'upnp', externalAddress: '203.0.113.7', externalPort: 1, lifetimeS: 120 });
    await new Promise((r) => setTimeout(r, 20));
    expect(service.hostStatus().portMap).toBeNull();
  });
});
