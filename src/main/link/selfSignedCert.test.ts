import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import * as tls from 'node:tls';
import { generateMachineCertificate, certificateFingerprint, fingerprintOfPem, fingerprintsMatch } from './selfSignedCert';

describe('generateMachineCertificate', () => {
  it('produces a certificate Node can parse and verify against its own key', () => {
    // The hand-written DER either round-trips through a real X.509 parser or it is wrong. There is no
    // partial credit here, which is exactly why writing the container by hand is acceptable.
    const id = generateMachineCertificate({ commonName: 'devdeck-host' });
    const cert = new X509Certificate(id.certPem);
    expect(cert.subject).toContain('devdeck-host');
    expect(cert.issuer).toBe(cert.subject); // self-signed
    expect(cert.verify(cert.publicKey)).toBe(true); // the signature really covers this key
    expect(cert.ca).toBe(false);
  });

  it('is valid now and stays valid long enough not to strand a pairing', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const id = generateMachineCertificate({ now, validDays: 3650 });
    const cert = new X509Certificate(id.certPem);
    // Backdated by a day so a peer whose clock lags slightly does not see a not-yet-valid certificate.
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(now.getTime());
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(now.getTime() + 3600 * 86_400_000);
  });

  it('gives every machine a distinct key and fingerprint', () => {
    const a = generateMachineCertificate();
    const b = generateMachineCertificate();
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.keyPem).not.toBe(b.keyPem);
  });

  it('reports the fingerprint in the same shape TLS reports a peer certificate', () => {
    // Pinning compares a stored string against what the socket says. A different format on either side
    // would mean every connection fails closed — or, worse, that someone "fixes" it by loosening it.
    const id = generateMachineCertificate();
    expect(id.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(fingerprintOfPem(id.certPem)).toBe(id.fingerprint);
    expect(certificateFingerprint(new X509Certificate(id.certPem).raw)).toBe(id.fingerprint);
  });

  it('sanitizes a hostile common name instead of embedding it', () => {
    const id = generateMachineCertificate({ commonName: 'evil name\n../../x' });
    expect(new X509Certificate(id.certPem).subject).toMatch(/CN=evil-name-\.\.-\.\.-x/);
  });
});

describe('fingerprintsMatch', () => {
  it('ignores case and separators, because one side is text a person pasted', () => {
    const id = generateMachineCertificate();
    expect(fingerprintsMatch(id.fingerprint, id.fingerprint.toLowerCase().replace(/:/g, ''))).toBe(true);
  });

  it('never treats an absent or truncated peer value as a match', () => {
    // A peer that presents no certificate reports undefined. Comparing that loosely is how pinning
    // silently turns into no pinning at all.
    const id = generateMachineCertificate();
    for (const bad of [undefined, null, '', '  ', 'AB:CD', id.fingerprint.slice(0, -3)]) {
      expect(fingerprintsMatch(id.fingerprint, bad), String(bad)).toBe(false);
    }
    expect(fingerprintsMatch(undefined, undefined)).toBe(false);
  });

  it('rejects a different machine', () => {
    expect(fingerprintsMatch(generateMachineCertificate().fingerprint, generateMachineCertificate().fingerprint)).toBe(false);
  });
});

describe('mutual TLS with pinned self-signed certificates', () => {
  it('completes a handshake and lets each side identify the other by fingerprint', async () => {
    const host = generateMachineCertificate({ commonName: 'devdeck-host' });
    const client = generateMachineCertificate({ commonName: 'devdeck-client' });

    const seen = await new Promise<{ hostSawClient?: string; clientSawHost?: string; echo?: string }>((resolve, reject) => {
      const result: { hostSawClient?: string; clientSawHost?: string; echo?: string } = {};
      const server = tls.createServer({
        key: host.keyPem, cert: host.certPem,
        // Pinning is done in application code below, not by a CA chain — so the TLS layer is told not
        // to reject the unknown certificate, and the socket is dropped by us if the pin fails.
        requestCert: true, rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
      }, (socket) => {
        result.hostSawClient = socket.getPeerX509Certificate()?.fingerprint256;
        socket.on('data', (d) => socket.write('pong:' + d));
      });
      server.on('tlsClientError', (e) => reject(e));
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        const socket = tls.connect({
          port, host: '127.0.0.1',
          key: client.keyPem, cert: client.certPem,
          rejectUnauthorized: false, checkServerIdentity: () => undefined,
          minVersion: 'TLSv1.3',
        }, () => {
          result.clientSawHost = socket.getPeerX509Certificate()?.fingerprint256;
          socket.write('ping');
        });
        socket.on('data', (d) => {
          result.echo = String(d);
          socket.destroy(); server.close(); resolve(result);
        });
        socket.on('error', reject);
      });
    });

    expect(seen.echo).toBe('pong:ping');
    expect(fingerprintsMatch(seen.clientSawHost, host.fingerprint)).toBe(true);
    expect(fingerprintsMatch(seen.hostSawClient, client.fingerprint)).toBe(true);
    // And an impostor's certificate must not satisfy the host's pin.
    expect(fingerprintsMatch(seen.clientSawHost, generateMachineCertificate().fingerprint)).toBe(false);
  });
});
