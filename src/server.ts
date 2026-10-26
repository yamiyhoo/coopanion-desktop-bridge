/**
 * The port this plugin opens for itself.
 *
 * The desktop Host is built to carry its API over framed byte pipes and starts no web server: a
 * probe run inside it listed `missing: webServer`, `webStartup`, `webRuntime`, so a bridge that
 * waits for `ctx.webServer` never activates there. What a plugin does still have is the process's
 * own right to listen — the same probe opened `http.createServer().listen(0, '127.0.0.1')` inside
 * the Electron host, completed a real request round trip to itself, and closed it again.
 *
 * So this file is the smallest thing that stands in for the Host's web server: one HTTP server with
 * two read-only routes and one WebSocket upgrade path, bound to loopback only, refusing any request
 * whose `Host` header is not loopback so a web page cannot reach it through DNS rebinding.
 *
 * Nothing here throws. A port already in use is recorded and reported, not raised: this runs while a
 * person's application boots.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

/** Loopback in every spelling a browser or a client may use for it. */
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(:\d+)?$/i;

/** What one request needs from the plugin: a JSON body, or a reason it has none. */
export interface HostRoutes {
  status(): unknown;
  sessions(): Promise<unknown>;
}

export interface LoopbackHostOptions extends HostRoutes {
  /** The port to try; 0 asks the OS for one. */
  port: number;
  /** The path a pet upgrades on. */
  path: string;
  /** The pet's upgrade handler, once the request has been checked. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  log(level: 'info' | 'warn', text: string): void;
}

export class LoopbackHost {
  private server: Server | null = null;
  private bound: number | null = null;
  private failure: string | null = null;

  constructor(private readonly opts: LoopbackHostOptions) {}

  /** The port actually bound, or null while it is not listening. */
  get listening(): number | null {
    return this.bound;
  }

  /** Why the last `listen` failed, or null. Reported in `/coopanion/status`, never thrown. */
  get lastError(): string | null {
    return this.failure;
  }

  /** Binds, or records why it could not. Safe to call on a Host that already holds the port. */
  listen(): void {
    try {
      const server = createServer((req, res) => {
        void this.route(req, res);
      });
      server.on('upgrade', (req, socket, head) => {
        if (!this.isLoopback(req)) {
          socket.destroy();
          return;
        }
        if (this.pathOf(req) !== this.opts.path) {
          socket.destroy();
          return;
        }
        try {
          this.opts.upgrade(req, socket, head);
        } catch (err) {
          this.opts.log('warn', `pet upgrade failed: ${message(err)}`);
          try {
            socket.destroy();
          } catch {
            // an already-closed socket needs no second goodbye
          }
        }
      });
      server.on('error', (err) => {
        this.failure = message(err);
        this.bound = null;
        this.opts.log('warn', `cannot listen on 127.0.0.1:${this.opts.port}: ${this.failure}`);
      });
      server.listen(this.opts.port, '127.0.0.1', () => {
        const address = server.address() as AddressInfo | null;
        this.bound = address?.port ?? null;
        this.failure = null;
        this.opts.log('info', `bridge listening on 127.0.0.1:${this.bound}${this.opts.path}`);
      });
      this.server = server;
    } catch (err) {
      this.failure = message(err);
      this.opts.log('warn', `cannot create the bridge listener: ${this.failure}`);
    }
  }

  close(): void {
    try {
      this.server?.close();
    } catch {
      // a server that never started has nothing to close
    }
    this.server = null;
    this.bound = null;
  }

  /** The two read-only routes, plus a plain 404 for everything else. */
  private async route(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    try {
      if (!this.isLoopback(req)) {
        this.reply(res, 403, { ok: false, why: 'this bridge answers loopback requests only' });
        return;
      }
      const path = this.pathOf(req);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.reply(res, 405, { ok: false, why: 'read-only: GET or HEAD' });
        return;
      }
      if (path === '/coopanion/status') {
        this.reply(res, 200, { ok: true, ...(this.opts.status() as object), port: this.bound, listenError: this.failure });
        return;
      }
      if (path === '/coopanion/sessions') {
        const listing = (await this.opts.sessions()) as { entries?: unknown; why?: string };
        this.reply(res, 200, { ok: true, list: listing.entries ?? [], ...(listing.why ? { why: listing.why } : {}) });
        return;
      }
      this.reply(res, 404, { ok: false, why: `no such route: ${path}` });
    } catch (err) {
      try {
        this.reply(res, 500, { ok: false, why: message(err) });
      } catch {
        // the response was already on its way
      }
    }
  }

  private reply(res: import('node:http').ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private pathOf(req: IncomingMessage): string {
    try {
      return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      return '/';
    }
  }

  private isLoopback(req: IncomingMessage): boolean {
    return LOOPBACK.test(String(req.headers.host ?? ''));
  }
}

/** An error's message, without trusting it to be an Error. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
