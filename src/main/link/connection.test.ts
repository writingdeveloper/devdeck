/**
 * The heartbeat, in isolation: two connections over a real loopback socket, with a clock the test
 * owns. The property under test is the one that cannot be seen from a healthy link — that a peer
 * which has silently vanished is noticed, and a peer that is merely old is not.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import { attachConnection, type HeartbeatOptions, type LinkConnection } from './connection';
import { encodeJsonFrame, encodePtyFrame, type LinkMessage } from './protocol';

interface Peer {
  conn: LinkConnection;
  socket: net.Socket;
  received: LinkMessage[];
  ptys: string[];
  closedWith: (string | null)[];
}

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

/** Two ends of one TCP connection, each wrapped as a link connection. */
async function pair(a: Partial<HeartbeatOptions>, b: Partial<HeartbeatOptions>, now: () => number): Promise<[Peer, Peer]> {
  const base: HeartbeatOptions = { idleMs: 60, timeoutMs: 200, now };
  const wrap = (socket: net.Socket, opts: Partial<HeartbeatOptions>): Peer => {
    const peer: Peer = { conn: undefined as unknown as LinkConnection, socket, received: [], ptys: [], closedWith: [] };
    peer.conn = attachConnection(socket, {
      onMessage: (m) => peer.received.push(m),
      onPty: (id) => peer.ptys.push(id),
      onClose: (r) => peer.closedWith.push(r),
    }, { ...base, ...opts });
    return peer;
  };
  const server = net.createServer();
  servers.push(server);
  const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const client = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => client.once('connect', resolve));
  const serverSide = await accepted;
  sockets.push(client, serverSide);
  return [wrap(client, a), wrap(serverSide, b)];
}

const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

describe('heartbeat', () => {
  it('answers a ping with a pong and shows neither to the layer above', async () => {
    let t = 1_000;
    const [a, b] = await pair({}, {}, () => t);
    a.socket.write(encodeJsonFrame({ t: 'ping', at: 7 }));
    await settle();
    expect(b.received).toEqual([]); // b answered it itself
    expect(a.received).toEqual([]); // and a swallowed the pong
    // The pong did arrive: a's idea of "last heard from b" moved to the current clock.
    t = 2_000;
    a.socket.write(encodeJsonFrame({ t: 'ping', at: 8 }));
    await settle();
    expect(a.conn.lastFrameAt).toBe(2_000);
    expect(a.conn.closed).toBe(false);
    expect(b.conn.closed).toBe(false);
  });

  it('hangs up on a peer that stops answering', async () => {
    // b is a build that "supports" pings but has gone away without a FIN — simulated by a peer that
    // never answers. Nothing else in the world would ever tell a about it.
    let t = 0;
    const [a] = await pair({}, { answerPings: false }, () => t);
    a.conn.startHeartbeat(true);
    t = 100; await settle();  // silence past idleMs → ping sent, no answer
    expect(a.conn.closed).toBe(false);
    t = 250; await settle();  // past timeoutMs
    expect(a.conn.closed).toBe(true);
    expect(a.closedWith).toEqual(['heartbeat timeout']);
  });

  it('never hangs up on a peer that predates pings', async () => {
    let t = 0;
    const [a, b] = await pair({}, { answerPings: false }, () => t);
    a.conn.startHeartbeat(false); // b's hello carried no features
    t = 100; await settle();
    t = 1_000; await settle();
    t = 10_000; await settle();
    expect(a.conn.closed).toBe(false);
    expect(b.conn.closed).toBe(false);
  });

  it('takes terminal output as proof of life, so a streaming session is never pinged to death', async () => {
    let t = 0;
    const [a, b] = await pair({}, { answerPings: false }, () => t);
    a.conn.startHeartbeat(true);
    for (const step of [100, 200, 300, 400]) {
      t = step;
      b.socket.write(encodePtyFrame('sess', 'still here'));
      await settle();
    }
    expect(a.conn.closed).toBe(false);
    expect(a.ptys.length).toBe(4);
    expect(a.conn.lastFrameAt).toBe(400);
  });

  it('a probe hangs up within its own deadline, not the heartbeat\'s', async () => {
    let t = 0;
    const [a] = await pair({ idleMs: 60_000, timeoutMs: 180_000 }, { answerPings: false }, () => t);
    a.conn.startHeartbeat(true);
    a.conn.probe(500);
    t = 400; await settle(60);
    expect(a.conn.closed).toBe(false);
    t = 600; await settle(60);
    expect(a.conn.closed).toBe(true);
    expect(a.closedWith).toEqual(['heartbeat timeout']);
  });

  it('a probe is answered by any frame at all, and a probe of an old peer sets no deadline', async () => {
    let t = 0;
    const [a, b] = await pair({ idleMs: 60_000, timeoutMs: 180_000 }, {}, () => t);
    a.conn.startHeartbeat(true);
    a.conn.probe(500);
    await settle(); // b answered the ping → deadline cleared
    t = 10_000; await settle(60);
    expect(a.conn.closed).toBe(false);

    const [c] = await pair({ idleMs: 60_000, timeoutMs: 180_000 }, { answerPings: false }, () => t);
    c.conn.startHeartbeat(false);
    c.conn.probe(500);
    t = 20_000; await settle(60);
    expect(c.conn.closed).toBe(false);
    b.conn.close();
  });

  it('stops its timer when the connection closes for any other reason', async () => {
    let t = 0;
    const [a, b] = await pair({}, {}, () => t);
    a.conn.startHeartbeat(true);
    b.conn.close('done');
    await settle();
    expect(a.conn.closed).toBe(true);
    // Advancing far past the timeout produces no second close.
    t = 100_000; await settle();
    expect(a.closedWith.length).toBe(1);
  });
});
