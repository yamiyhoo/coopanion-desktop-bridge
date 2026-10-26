/**
 * The listener this plugin owns, tested the way it will be used: a real socket on loopback.
 *
 * The desktop Host provides no web server, so this class is standing in for one; the cases below are
 * the contract a pet and a person depend on — it answers on loopback, it refuses anything else, and
 * a port that is already taken is reported instead of thrown.
 */
import { describe, expect, it } from 'vitest';
import { request, type IncomingHttpHeaders } from 'node:http';
import { LoopbackHost } from '../src/server.ts';

/** Starts a host on an OS-chosen port and returns it with the port it got. */
async function started(options: Partial<ConstructorParameters<typeof LoopbackHost>[0]> = {}): Promise<{ host: LoopbackHost; port: number }> {
  const host = new LoopbackHost({
    port: 0,
    path: '/coopanion/pet',
    upgrade: () => {},
    status: () => ({ session: 'session-a', pet: true }),
    sessions: async () => ({ entries: [{ id: 'session-a' }] }),
    log: () => {},
    ...options,
  });
  host.listen();
  const deadline = Date.now() + 3000;
  while (host.listening === null && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  if (host.listening === null) throw new Error(`host did not bind: ${host.lastError}`);
  return { host, port: host.listening };
}

/** One GET against the host, returning status and parsed body. */
function get(port: number, path: string, headers: IncomingHttpHeaders = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          body = { raw: text };
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Waits until `check` holds, so an asynchronous call can be observed without guessing a delay. */
async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('condition never held');
}

describe('the listener a plugin owns', () => {
  it('binds a loopback port and reports the one it got', async () => {
    const { host, port } = await started();
    try {
      expect(port).toBeGreaterThan(0);
      expect(host.lastError).toBeNull();
    } finally {
      host.close();
    }
  });

  it('answers the status route a person can check by hand', async () => {
    const { host, port } = await started();
    try {
      const { status, body } = await get(port, '/coopanion/status');
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, session: 'session-a', pet: true, port });
    } finally {
      host.close();
    }
  });

  it('answers the conversation listing', async () => {
    const { host, port } = await started();
    try {
      const { status, body } = await get(port, '/coopanion/sessions');
      expect(status).toBe(200);
      expect(body.list).toEqual([{ id: 'session-a' }]);
    } finally {
      host.close();
    }
  });

  it('refuses a request that did not come through loopback', async () => {
    const { host, port } = await started();
    try {
      const { status, body } = await get(port, '/coopanion/status', { host: 'evil.example' });
      expect(status).toBe(403);
      expect(String(body.why)).toContain('loopback');
    } finally {
      host.close();
    }
  });

  it('is read-only: anything but GET or HEAD is refused', async () => {
    const { host, port } = await started();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/coopanion/status', method: 'POST' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end('{}');
      });
      expect(status).toBe(405);
    } finally {
      host.close();
    }
  });

  it('says which route does not exist instead of guessing', async () => {
    const { host, port } = await started();
    try {
      const { status, body } = await get(port, '/nope');
      expect(status).toBe(404);
      expect(String(body.why)).toContain('/nope');
    } finally {
      host.close();
    }
  });

  it('hands the pet path to the upgrade handler, and drops any other', async () => {
    const seen: string[] = [];
    const { host, port } = await started({ upgrade: (req) => seen.push(String(req.url)) });
    const headers = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };
    try {
      // The stub never completes a handshake, so the client socket is just left hanging: this asks
      // the handler to be *called*, which is the contract, and then drops the request.
      const first = request({ host: '127.0.0.1', port, path: '/coopanion/pet', headers });
      first.on('error', () => {});
      first.end();
      await waitUntil(() => seen.includes('/coopanion/pet'));

      const dropped = await new Promise<boolean>((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/elsewhere', headers });
        req.on('error', () => resolve(true));
        req.on('close', () => resolve(true));
        req.end();
        setTimeout(() => resolve(false), 1500);
      });
      first.destroy();
      expect(dropped).toBe(true);
      expect(seen).not.toContain('/elsewhere');
    } finally {
      host.close();
    }
  });

  it('reports a port already in use instead of throwing', async () => {
    const first = await started();
    try {
      const second = new LoopbackHost({
        port: first.port,
        path: '/coopanion/pet',
        upgrade: () => {},
        status: () => ({}),
        sessions: async () => ({ entries: [] }),
        log: () => {},
      });
      expect(() => second.listen()).not.toThrow();
      const deadline = Date.now() + 3000;
      while (second.lastError === null && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
      expect(second.lastError).toBeTruthy();
      expect(second.listening).toBeNull();
      second.close();
    } finally {
      first.host.close();
    }
  });
});
