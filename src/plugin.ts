/**
 * The bridge's Host half for the DSH **desktop** application.
 *
 * The web build of this bridge hangs its WebSocket off `ctx.webServer`. That service does not exist
 * in the desktop Host — a probe run inside it reported `missing: webServer, webStartup, webRuntime`
 * — because the desktop Host carries its API over framed byte pipes and starts no web server by
 * design. What the probe did confirm is the alternative used here: a plugin inside that process can
 * open its own loopback port and complete a real round trip to itself.
 *
 * So this plugin owns its listener (`server.ts`), and everything else is the same contract as the
 * web bridge: one WebSocket for the pet, the pet's words become a `user/message` on the conversation
 * a person last spoke in, and DSH's turns, replies, tools and approvals go back as notices.
 *
 * Two Host facts shape the code below:
 *
 *  - `ctx.logger` is not among the desktop Host's services, so `log()` writes its own JSONL file.
 *    Without that, a bridge that fails here would fail silently, which is the worst way to fail.
 *  - `ctx.get('sessionQuery')` returns nothing for a service this plugin never declared: cordis
 *    isolates services per fiber. The conversation listing is therefore wired through an explicit
 *    `inject`, and simply stays dark on a Host that does not mount it.
 *
 * `apply` never throws. It runs while a person's application boots; a crash there is not a failed
 * bridge, it is a person unable to start their editor.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PET_PATH, PROTOCOL_VERSION, PetHub, type SayResult } from './pet-hub.ts';
import { AgentRegistry, noticeOf, type SessionEventLike } from './session-watch.ts';
import { SessionDirectory, looksLikeSessionQuery, type SessionQueryLike } from './sessions.ts';
import { argumentNames, assistantText, carriesBridgePrefix, reasonText, type HostFrame } from './protocol.ts';
import { LoopbackHost } from './server.ts';

interface DshContext {
  inject(services: string[], callback: (scoped: DshContext) => void): void;
  effect(callback: () => void | (() => void)): void;
  on(event: string, listener: (...args: never[]) => void): () => void;
  get(name: string): unknown;
  logger?: { info(text: string): void; warn(text: string): void };
}

interface DshConfig {
  /** Loopback port the bridge binds; 19400 by default. */
  port?: number;
  /** How many conversations the pet may see in one listing. */
  sessions?: number;
}

/** `agent/created` payload. */
interface CreatedPayload {
  agent?: {
    session?: { id?: string; header?: { cwd?: string; parentSession?: string; origin?: string } };
    followup?(message: unknown): void;
    inject?(message: unknown): void;
  };
}

const PLUGIN_NAME = 'coopanion-desktop-bridge';

/** Injected by the build from package.json's version, so a receipt can name what answered. */
declare const __PKG_VERSION__: string;

/** The port chosen for this machine: next to the web bridge's 19387, clear of it. */
const DEFAULT_PORT = 19400;

/** Where the bridge writes its own log, since the desktop Host provides no logger service. */
function logFile(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}\\.dsh\\logs\\${PLUGIN_NAME}.jsonl`;
}

/**
 * Proof of load, plus every warning afterwards.
 *
 * Written by the plugin itself rather than through `ctx.logger`: the desktop Host does not provide
 * that service, and a bridge that cannot be heard from is a bridge that cannot be debugged.
 */
function write(line: Record<string, unknown>): void {
  const text = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...line })}\n`;
  try {
    const file = logFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, text);
  } catch {
    // a Host that cannot write its own log directory still runs
  }
  try {
    process.stdout.write(`[${PLUGIN_NAME}] ${text}`);
  } catch {
    // a closed stdout must not become an exception
  }
}

/** The module whose `createUserMessage` builds the exact user-role message `followup` accepts. */
const LLM_MODULE = '@deepseek-ai/dsh-llm';

let factory: ((options: { content: unknown; source: unknown }) => unknown) | null | undefined;

async function resolveFactory(): Promise<((options: { content: unknown; source: unknown }) => unknown) | null> {
  if (factory !== undefined) return factory;
  try {
    const mod = (await import(LLM_MODULE)) as { createUserMessage?: unknown };
    factory = typeof mod.createUserMessage === 'function'
      ? (mod.createUserMessage as (options: { content: unknown; source: unknown }) => unknown)
      : null;
  } catch {
    factory = null;
  }
  return factory;
}

/** A message that enters the session log must carry an identity of its own. */
function withOwnId(message: unknown): unknown {
  const id = (message as { id?: unknown } | null)?.id;
  if (typeof id === 'string' && id !== '') return message;
  return { ...(message as object), id: randomUUID() };
}

/** The message shapes this plugin can hand `followup`, best first. */
export function buildUserMessage(
  text: string,
  template: unknown,
  factoryOverride: ((options: { content: unknown; source: unknown }) => unknown) | null = factory ?? null,
): unknown {
  if (factoryOverride) {
    try {
      return withOwnId(factoryOverride({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    } catch {
      // fall through to the shapes below
    }
  }
  if (template && typeof template === 'object') {
    const base = template as { content?: unknown; source?: unknown };
    return { ...base, id: randomUUID(), content: [{ type: 'text', text }] };
  }
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

/** Every text block of a message, joined; used to recognise the bridge's own words. */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

export default {
  name: PLUGIN_NAME,
  apply(root: DshContext, config?: DshConfig): void {
    try {
      run(root, config ?? {});
    } catch (err) {
      // Never let a bridge failure stop a person's application from starting.
      write({ phase: 'apply-failed', error: err instanceof Error ? err.message : String(err) });
    }
  },
};

/** The plugin body; `apply` keeps every failure inside it. */
function run(root: DshContext, config: DshConfig): void {
  write({
    phase: 'load',
    execPath: process.execPath,
    argv: process.argv.slice(0, 6),
    cwd: process.cwd(),
    electron: process.versions.electron || null,
    node: process.versions.node,
    port: config.port ?? DEFAULT_PORT,
  });

  const agents = new AgentRegistry();
  let hub: PetHub | null = null;
  let userTemplate: unknown = null;

  /** Warnings go to the file and to the Host's logger when there is one. */
  const log = (level: 'info' | 'warn', text: string): void => {
    write({ phase: 'log', level, text });
    try {
      if (level === 'warn') root.logger?.warn(`[${PLUGIN_NAME}] ${text}`);
      else root.logger?.info(`[${PLUGIN_NAME}] ${text}`);
    } catch {
      // no logger service in this Host; the file above is the record
    }
  };

  /**
   * Resolves `sessionQuery` the way a cordis service must be resolved: by declaring it.
   *
   * A bare `ctx.get` reports nothing for an undeclared service, so the listing would be permanently
   * empty while looking healthy. Declaring it here keeps that failure visible: no injection, no
   * listing, and `/coopanion/sessions` says why.
   */
  let query: (() => SessionQueryLike | null) = () => null;
  try {
    root.inject(['sessionQuery'], (scoped) => {
      try {
        const service = typeof scoped.get === 'function' ? scoped.get('sessionQuery') : (scoped as { sessionQuery?: unknown }).sessionQuery;
        if (looksLikeSessionQuery(service)) {
          query = () => service;
          log('info', 'sessionQuery is available: the pet can list conversations');
        } else {
          log('warn', 'sessionQuery resolved but does not look like the query engine');
        }
      } catch (err) {
        log('warn', `cannot read sessionQuery: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  } catch (err) {
    log('warn', `cannot declare sessionQuery: ${err instanceof Error ? err.message : String(err)}`);
  }

  const directory = new SessionDirectory({ query: () => query(), agents, limit: config.sessions, log });

  const notify = (frame: HostFrame): void => {
    try {
      hub?.send(frame);
    } catch {
      // a socket that went away mid-notice is not an error worth raising
    }
  };

  const warmTitle = (session: string | null | undefined): void => {
    if (session) void directory.titleOf(session);
  };

  const pet = new PetHub({
    welcome: () => agents.facts(),
    titleOf: (session) => directory.cachedTitle(session),
    sessions: () => directory.list(),
    say: async (text, from): Promise<SayResult> => {
      const body = text.trim();
      if (!body) return { reason: 'empty message' };
      if (carriesBridgePrefix(body)) return { reason: 'this line already carries the bridge\'s prefix, so a second one would be nested around it' };
      const agent = agents.owner;
      const session = agents.ownerSession;
      if (!agent || !session) return { reason: 'no conversation is open on the DSH side' };
      if (typeof agent.followup !== 'function') return { reason: 'this DSH build cannot accept a message here' };
      try {
        await resolveFactory();
        const message = buildUserMessage(`${from}（通过桌宠）说：${body}`, userTemplate);
        const id = (message as { id?: unknown } | null)?.id;
        if (typeof id === 'string') agents.noteOwn(id);
        agent.followup(message);
        const title = await directory.titleOf(session);
        log('info', `submitted to ${session}${title ? ` (${title})` : ''}`);
        return title ? { session, title } : { session };
      } catch (err) {
        return { reason: `DSH refused the message: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    pick: (session) => (agents.setOwner(String(session)) ? null : 'no such open conversation'),
    log,
  });
  hub = pet;

  const host = new LoopbackHost({
    port: config.port ?? DEFAULT_PORT,
    path: PET_PATH,
    upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => pet.upgrade(req, socket, head),
    status: () => {
      const facts = agents.facts();
      return {
        v: PROTOCOL_VERSION,
        pluginVersion: __PKG_VERSION__,
        pet: pet.connected,
        session: facts?.session ?? null,
        title: facts ? directory.cachedTitle(facts.session) : null,
        lastHumanAt: facts?.lastHumanAt ?? 0,
        actor: facts?.actor ?? null,
        conversations: (query() ? 'available' : 'unavailable'),
      };
    },
    sessions: () => directory.list(),
    log,
  });
  host.listen();

  try {
    root.effect(() => () => {
      try {
        host.close();
        pet.close();
      } finally {
        hub = null;
      }
    });
  } catch (err) {
    log('warn', `cannot register teardown: ${err instanceof Error ? err.message : String(err)}`);
  }

  root.on('agent/created', ((payload: CreatedPayload) => {
    const agent = payload?.agent;
    const id = agent?.session?.id;
    if (!agent || !id) return;
    agents.add(String(id), agent as never);
    const facts = agents.facts();
    if (facts && hub && hub.connected) {
      warmTitle(facts.session);
      hub.notifyBound(facts);
    }
  }) as never);

  root.on('session/disposed', ((session: { id?: string }) => {
    const id = session?.id;
    const wasOwner = id && agents.ownerSession === id;
    if (id) agents.remove(String(id));
    if (wasOwner && hub && hub.connected) {
      const facts = agents.facts();
      if (facts) {
        warmTitle(facts.session);
        hub.notifyBound(facts);
      } else {
        hub.notifyUnbound();
      }
    }
  }) as never);

  root.on('session/event', ((session: { id?: string }, event: SessionEventLike) => {
    const id = String(session?.id ?? '');
    if (!id) return;
    const data = (event?.data ?? {}) as Record<string, unknown>;
    if (event?.type === 'request/header') {
      const model = (data.header as { config?: { model?: unknown } })?.config?.model;
      if (typeof model === 'string' && model) agents.rememberModel(id, model);
      return;
    }
    // A person speaking decides which conversation the pet belongs to, so this runs before the owner
    // guard: the session that is not the owner yet is the one this changes.
    if (event?.type === 'user/message') {
      const message = data.message ?? data;
      const messageId = typeof (message as { id?: unknown } | null)?.id === 'string' ? (message as { id: string }).id : '';
      const ours = (messageId !== '' && agents.owns(messageId)) || carriesBridgePrefix(messageText(message));
      if (!ours) {
        const before = agents.ownerSession;
        agents.noteHuman(id);
        if (agents.ownerSession !== before) {
          const facts = agents.facts();
          if (facts && hub && hub.connected) {
            warmTitle(facts.session);
            hub.notifyBound(facts);
          }
        }
      }
      if (agents.ownerSession === id) userTemplate = message;
      return;
    }
    if (agents.ownerSession !== id) return;
    if (event?.type === 'assistant/message') {
      const text = assistantText(data.message);
      if (text) notify({ t: 'reply', turn: Number(data.turn) || 0, text });
      return;
    }
    if (event?.type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : 'tool';
      notify({ t: 'tool', name, detail: argumentNames(data.arguments) });
      return;
    }
    if (event?.type === 'approval/asked') {
      notify({
        t: 'approval',
        name: typeof data.toolName === 'string' ? data.toolName : 'tool',
        reason: typeof data.reason === 'string' ? data.reason : '',
      });
      return;
    }
    const notice = noticeOf(id, event);
    if (!notice) return;
    const frame = notice.frame as { t: string; turn?: number; reason?: unknown };
    if (frame.t === 'turn-end') notify({ t: 'turn-end', turn: frame.turn ?? 0, reason: reasonText(frame.reason) });
    else notify(frame as HostFrame);
  }) as never);

  const owner = agents.ownerSession;
  if (owner) warmTitle(owner);
}
