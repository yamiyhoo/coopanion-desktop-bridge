/**
 * The pet's side of the bridge: one local WebSocket the Coopanion World connects to, and the
 * notices DSH broadcasts to it. Bound to the Host's own `webServer`, so it shares the port the
 * console already uses and nothing listens on a second one.
 *
 * A notice with no connection is dropped. DSH work does not wait for a pet, and a queue here would
 * only replay stale turns into a bubble after the person already read them on the console.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { SAY_MAX, parsePetFrame, type HostFrame, type HostAck, type PetFrame } from './protocol.ts';
import type { SessionEntry } from './sessions.ts';

/** The path the pet connects to, relative to the DSH web server's root. */
export const PET_PATH = '/coopanion/pet';

/** Protocol revision; the pet refuses a Host that speaks another one. */
export const PROTOCOL_VERSION = 1;

/** How long a connection may stay silent before the Host pings it. */
const IDLE_PING_MS = 30_000;

/** What the Host made of one `say`: the conversation the words landed in, or why they did not. */
export type SayResult = { session: string; title?: string } | { reason: string };

export interface PetHubOptions {
  /**
   * The current owning agent's facts, or null when no conversation is open yet.
   * The pet connects first and waits in a "bound = false" state until facts become available;
   * when they do, the Host sends a late `ready` frame. This lets the pet connect before any
   * conversation has been created (common on `dsh web --no-open` and other CLI paths).
   */
  welcome(): { session: string; cwd: string; model: string } | null;
  /**
   * The name of one conversation, when it has already been read. This is the synchronous half of
   * the listing: `ready` and `accepted` must answer immediately, so a title that has not been
   * folded yet is simply absent rather than awaited.
   */
  titleOf?(session: string): string;
  /** The conversations this Host may be asked about; absent means this Host cannot list them. */
  sessions?(): Promise<{ entries: SessionEntry[]; why?: string }>;
  /**
   * A person's words arrived. Resolves to the conversation they were submitted to, or to the
   * refusal reason. The session is carried back to the pet so a receipt can be checked against
   * the window the person is actually looking at.
   */
  say(text: string, from: string): Promise<SayResult>;
  /** The pet asked to switch the owning session; return null to accept, or the refusal reason. */
  pick?(session: string): string | null;
  log(level: 'info' | 'warn', text: string): void;
  /** The upgrade handler of another server, when the caller owns one (tests, embedding). */
  server?: WebSocketServer;
}

export class PetHub {
  private readonly wss: WebSocketServer;
  private readonly ownsServer: boolean;
  private connection: WebSocket | null = null;
  /** True after this.connection has received its first `ready` frame. A pet in waiting state may
   *  have an open connection but has not yet been told which session to speak into. */
  private bound: boolean = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly opts: PetHubOptions) {
    this.ownsServer = opts.server === undefined;
    this.wss = opts.server ?? new WebSocketServer({ noServer: true });
    this.timer = setInterval(() => this.ping(), IDLE_PING_MS);
    this.timer.unref?.();
  }

  get connected(): boolean {
    return this.connection !== null && this.connection.readyState === this.connection.OPEN;
  }

  /** Whether an open connection has been bound to a DSH conversation (has received `ready`). */
  get boundState(): boolean {
    return this.bound && this.connected;
  }

  /** The upgrade route `webServer.registerUpgrade` takes.
   *
   *  Always accepts the HTTP upgrade: whether a conversation exists or not, the pet gets an open
   *  socket. When no conversation exists yet it lands in waiting state and receives a late `ready`
   *  later via `notifyBound()`. */
  readonly upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  };

  /** A notice to the pet; false when nobody is listening or the pet has not yet bound to a session. */
  send(frame: HostFrame): boolean {
    if (!this.connected || !this.bound) return false;
    this.connection!.send(JSON.stringify(frame));
    return true;
  }

  /** Tells the pet the owning conversation has appeared or changed; sends `ready` if the pet is waiting. */
  notifyBound(facts: { session: string; cwd: string; model: string }): void {
    if (!this.connected) return;
    this.opts.log('info', `DSH bridge bound to session ${facts.session}`);
    this.connection!.send(this.ready(facts));
    this.bound = true;
  }

  /** The `ready` frame, naming the conversation when its title has already been folded. */
  private ready(facts: { session: string; cwd: string; model: string }): string {
    const title = this.opts.titleOf?.(facts.session) ?? '';
    return JSON.stringify({
      t: 'ready',
      v: PROTOCOL_VERSION,
      ...facts,
      ...(title ? { title } : {}),
    } satisfies HostFrame);
  }

  /** Tells the pet the owning conversation is gone (disposed / subagent filtered out).
   *  Resets bound so subsequent `send()` calls are dropped and the caller may re-bind later. */
  notifyUnbound(): void {
    if (!this.connected) return;
    this.bound = false;
    this.connection!.send(JSON.stringify({ t: 'error', text: 'owning conversation disposed, waiting for a new one' } satisfies HostFrame));
  }

  close(): void {
    clearInterval(this.timer);
    try {
      this.connection?.close(1001, 'host closing');
    } catch {
      // a socket already gone needs no goodbye
    }
    this.connection = null;
    for (const client of this.wss.clients) client.terminate();
    if (this.ownsServer) this.wss.close();
  }

  private accept(ws: WebSocket): void {
    this.connection?.close(4000, 'replaced');
    this.connection = ws;
    this.bound = false;
    let greeted = false;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const frame = parsePetFrame(data.toString());
      if (!frame) return;
      if (!greeted && frame.t !== 'hello') {
        ws.close(4001, 'hello first');
        return;
      }
      switch (frame.t) {
        case 'hello': {
          if (frame.v !== PROTOCOL_VERSION) {
            this.opts.log('warn', `pet speaks protocol ${frame.v}, this Host speaks ${PROTOCOL_VERSION}`);
            ws.close(4002, 'protocol mismatch');
            return;
          }
          greeted = true;
          const welcome = this.opts.welcome();
          if (welcome) {
            this.bound = true;
            this.opts.log('info', `Coopanion pet "${frame.name}" connected`);
            ws.send(this.ready(welcome));
          } else {
            this.opts.log('info', `Coopanion pet "${frame.name}" connected, waiting for a conversation`);
            // No `ready` yet — notifyBound() will send one when the caller has facts.
          }
          return;
        }
        case 'say': {
          const text = frame.text.slice(0, SAY_MAX);
          void this.opts.say(text, frame.from).then((result) => {
            const ack: HostAck = 'session' in result
              ? { t: 'accepted', id: frame.id, session: result.session, ...(result.title ? { title: result.title } : {}) }
              : { t: 'refused', id: frame.id, reason: result.reason };
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ack));
          });
          return;
        }
        case 'sessions': {
          // A Host that cannot list conversations still answers, so the pet learns why instead of
          // waiting for a frame that will never come.
          const listing = this.opts.sessions;
          void (listing === undefined
            ? Promise.resolve({ entries: [] as SessionEntry[], why: 'this Host does not list conversations' })
            : listing()
          ).then((result) => {
            const reply = { t: 'sessions' as const, list: result.entries, ...(result.why ? { why: result.why } : {}) };
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
          });
          return;
        }
        case 'ping':
          return;
        case 'pick': {
          // `pick` resolves `null` on acceptance, so absence must be tested explicitly: `??`
          // would turn an accepted pick into the "unsupported" refusal.
          const pick = this.opts.pick;
          const reason = pick === undefined ? 'this Host does not support session switching' : pick(frame.session);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(reason === null ? { t: 'picked', session: frame.session } : { t: 'refused', reason }));
          }
          return;
        }
      }
    });
    ws.on('close', () => {
      if (this.connection === ws) this.connection = null;
    });
    ws.on('error', (err: Error) => this.opts.log('warn', `pet socket error: ${err.message}`));
  }

  private ping(): void {
    if (!this.connected) return;
    try {
      this.connection!.ping();
    } catch {
      // the socket is closing; the close handler clears it
    }
  }
}

export type { PetFrame, HostFrame };
