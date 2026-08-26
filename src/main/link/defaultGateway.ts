/**
 * Which address is the router.
 *
 * NAT-PMP is a unicast conversation with the default gateway, so its address has to be known before
 * anything can be asked of it — and Node exposes interfaces but not the routing table. Every
 * platform will print the table; the parsers below read it.
 *
 * The Windows table is LOCALIZED — its column headers come back in the system language — so the
 * parser reads the rows by shape rather than by heading: the default route is the row whose
 * destination and mask are both `0.0.0.0`, and among several, the one with the lowest metric is the
 * one the OS uses.
 */
import { execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';

/** An IPv4 dotted quad, and nothing that merely looks like one. */
function isIpv4(text: string): boolean {
  const parts = text.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * `route print -4` on Windows.
 *
 * Rows look like `0.0.0.0  0.0.0.0  192.168.1.254  192.168.1.69  20` — destination, mask, gateway,
 * interface, metric. An "on-link" default route names no gateway, and is skipped: the third column
 * is then a word in the system language rather than an address.
 */
export function parseWindowsRouteTable(output: string): string | null {
  let best: { gateway: string; metric: number } | null = null;
  for (const line of output.split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 4 || cells[0] !== '0.0.0.0' || cells[1] !== '0.0.0.0') continue;
    if (!isIpv4(cells[2])) continue; // on-link, or a localized word where the gateway would be
    const metric = Number(cells[4]);
    const candidate = { gateway: cells[2], metric: Number.isFinite(metric) ? metric : Number.MAX_SAFE_INTEGER };
    if (!best || candidate.metric < best.metric) best = candidate;
  }
  return best?.gateway ?? null;
}

/** `ip -4 route show default` → `default via 192.168.1.254 dev eth0 proto dhcp metric 100`. */
export function parseIpRoute(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const via = /^default\s+via\s+(\S+)/.exec(line.trim())?.[1];
    if (via && isIpv4(via)) return via;
  }
  return null;
}

/** `netstat -rn -f inet` → `default            192.168.1.254      UGScg          en0`. */
export function parseNetstatRoute(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/);
    if (cells[0] !== 'default' || cells.length < 2 || !isIpv4(cells[1])) continue;
    return cells[1];
  }
  return null;
}

function run(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? null : String(stdout));
    });
  });
}

/**
 * The default gateway's address, or null when it cannot be determined.
 *
 * Null is a normal answer, not a failure: the caller falls back to UPnP, which finds the gateway by
 * multicast and needs no address at all.
 */
export async function defaultGateway(platform: string = process.platform, timeoutMs = 2_000): Promise<string | null> {
  try {
    if (platform === 'win32') {
      const output = await run('route', ['print', '-4'], timeoutMs);
      return output ? parseWindowsRouteTable(output) : null;
    }
    if (platform === 'linux') {
      const output = await run('ip', ['-4', 'route', 'show', 'default'], timeoutMs);
      return output ? parseIpRoute(output) : null;
    }
    const output = await run('netstat', ['-rn', '-f', 'inet'], timeoutMs);
    return output ? parseNetstatRoute(output) : null;
  } catch {
    return null;
  }
}

/**
 * The address this machine would use to reach `target`, asked of the OS rather than guessed.
 *
 * UPnP maps a port TO somewhere and has to be told where, and picking "the first LAN address" is
 * wrong on any machine with Docker, WSL or a VPN client — several of those are LAN addresses and
 * only one of them is on the router's network. A connected UDP socket sends nothing, but the kernel
 * still resolves the route to fill in a source address, which is exactly the answer.
 */
export function localAddressFor(target: string, timeoutMs = 1_000): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closing */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
    socket.on('error', () => { clearTimeout(timer); done(null); });
    try {
      socket.connect(1, target, () => {
        clearTimeout(timer);
        try { done(socket.address().address ?? null); } catch { done(null); }
      });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}
