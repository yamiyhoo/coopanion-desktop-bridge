/**
 * Which agent the pet's words belong to, and what the pet hears about it.
 *
 * The pet is a second mouth for one conversation, so the bridge keeps exactly one owning agent. The
 * rule is **the conversation a person last spoke in**: several sessions can be live in one Host at
 * once, and the one on the person's screen is the one whose `user/message` is newest. Creation order
 * is only the fallback for a Host where nobody has typed since the bridge started — following it
 * alone sent the pet's words to whichever conversation happened to be created last, which is how a
 * bubble that said "delivered" landed in a window nobody was looking at.
 *
 * A `user/message` this bridge submitted itself is not a person speaking: the Host records the id of
 * every message it sends, and stamps each one with the bridge prefix, so either is enough to tell the
 * two apart even when DSH rewrites the source of an injected message.
 *
 * Everything this module reads from DSH arrives through `session/event`, whose envelopes are
 * `{ type, data }`. The plugin never writes an event of its own type: a reader that meets an
 * unknown persisted type cannot reopen the session.
 */

/** Who decided the owning conversation, so a receipt can be checked against it. */
export type OwnerActor = 'human' | 'pinned' | 'newest';

/** What the pet may be told about the agent it is talking to. */
export interface AgentFacts {
  session: string;
  cwd: string;
  model: string;
  /** When this Host last saw a person speak in the owning conversation; 0 when never. */
  lastHumanAt: number;
  /** How the owner was chosen: a person's words, the pet's `pick`, or creation order. */
  actor: OwnerActor;
}

/** DSH's session header: where cwd and subagent flags actually live. */
interface SessionHeader {
  cwd?: string;
  parentSession?: string;
  origin?: string;
}

/** One live agent, as much of it as this plugin touches. */
export interface LiveAgent {
  session: { id?: string; header?: SessionHeader };
  /** Submits context and wakes the agent; resolves once the message is queued. */
  followup?(message: unknown): void;
  /** Submits context without waking the agent. */
  inject?(message: unknown): void;
  /** DSH's own text-only user message factory, resolved once per process. */
  createUserMessage?: (options: { content: string; source: unknown }) => unknown;
}

/** How many of this bridge's own message ids are remembered before the oldest is forgotten. */
const OWN_IDS = 128;

/** A person's words beat both the pin and creation order; a subagent never owns anything. */
export class AgentRegistry {
  private readonly live = new Map<string, LiveAgent>();
  /** model 按 session 缓存，因为模型是请求级属性而非 agent 常驻属性。 */
  private readonly modelCache = new Map<string, string>();
  /** When a person last spoke in each session, by this Host's clock. */
  private readonly humanAt = new Map<string, number>();
  /** Ids of the messages this bridge submitted, oldest first. */
  private readonly own = new Set<string>();
  /** Creation order, so the "nobody has typed yet" fallback stays deterministic. */
  private readonly born = new Map<string, number>();
  private nextBorn = 0;
  private pinnedId: string | null = null;
  private pinnedAt = 0;

  /** Keyed by session id, which is what `agent/created` and `session/disposed` agree on. */
  add(id: string, agent: LiveAgent): void {
    this.live.set(id, agent);
    if (!this.born.has(id)) this.born.set(id, ++this.nextBorn);
  }

  remove(id: string): void {
    this.live.delete(id);
    this.modelCache.delete(id);
    this.humanAt.delete(id);
    this.born.delete(id);
    if (this.pinnedId === id) this.pinnedId = null;
  }

  get owner(): LiveAgent | null {
    const id = this.resolve();
    if (id === null) return null;
    const agent = this.live.get(id);
    return agent && !this.isSubagent(agent) ? agent : null;
  }

  get ownerSession(): string | null {
    return this.resolve();
  }

  /**
   * Lets the pet point its words at a specific live session. The pin holds until a person speaks
   * somewhere else, at which point their words are the better evidence of where they are looking.
   * Returns false when the session is not live (already disposed, never created, or a subagent).
   */
  setOwner(id: string): boolean {
    const agent = this.live.get(id);
    if (!agent) return false;
    if (this.isSubagent(agent)) return false;
    this.pinnedId = id;
    this.pinnedAt = Date.now();
    return true;
  }

  /** True when `id` names a live, non-subagent conversation this Host holds. */
  has(id: string): boolean {
    const agent = this.live.get(id);
    return agent !== undefined && !this.isSubagent(agent);
  }

  /** When a person last spoke in `id`, by this Host's clock; 0 when they have not since activation. */
  lastHumanAtOf(id: string): number {
    return this.humanAt.get(id) ?? 0;
  }

  /** Records a message id this bridge submitted, so its own words are not read as a person's. */
  noteOwn(id: string): void {
    if (!id) return;
    this.own.add(id);
    while (this.own.size > OWN_IDS) {
      const oldest = this.own.values().next().value;
      if (typeof oldest !== 'string') break;
      this.own.delete(oldest);
    }
  }

  /** True when `id` names a message this bridge submitted. */
  owns(id: string): boolean {
    return this.own.has(id);
  }

  /**
   * Records that a person spoke in `session`: that conversation is now the pet's.
   *
   * `at` defaults to this Host's clock and exists so a test can order two events without sleeping;
   * the plugin never passes it.
   */
  noteHuman(session: string, at: number = Date.now()): void {
    if (!session) return;
    this.humanAt.set(session, at);
    if (this.pinnedId !== null && this.pinnedId !== session) {
      if (at > this.pinnedAt) this.pinnedId = null;
    }
  }

  /** 记录某会话最近一次 request/header 里看到的模型名。 */
  rememberModel(id: string, model: string): void {
    if (model) this.modelCache.set(id, model);
  }

  /** What the pet is told on connect; null when no conversation is open yet. */
  facts(): AgentFacts | null {
    const id = this.resolve();
    if (id === null) return null;
    const agent = this.live.get(id);
    if (!agent) return null;
    const header = agent.session.header;
    return {
      session: String(agent.session.id ?? id),
      cwd: String(header?.cwd ?? ''),
      model: this.modelOf(id),
      lastHumanAt: this.humanAt.get(id) ?? 0,
      actor: this.actorOf(id),
    };
  }

  private actorOf(id: string): OwnerActor {
    if (this.pinnedId === id && (this.humanAt.get(id) ?? 0) <= this.pinnedAt) return 'pinned';
    return (this.humanAt.get(id) ?? 0) > 0 ? 'human' : 'newest';
  }

  private modelOf(sessionId: string): string {
    return this.modelCache.get(sessionId) ?? '';
  }

  /** The owning session: a person's last words, else a live pin, else the newest conversation. */
  private resolve(): string | null {
    const candidates = [...this.live.keys()].filter((id) => {
      const agent = this.live.get(id);
      return agent !== undefined && !this.isSubagent(agent);
    });
    if (candidates.length === 0) return null;
    const newest = candidates.reduce((best, id) => ((this.born.get(id) ?? 0) > (this.born.get(best) ?? 0) ? id : best));
    const spoke = candidates.filter((id) => (this.humanAt.get(id) ?? 0) > 0);
    if (spoke.length === 0) {
      return this.pinnedId !== null && candidates.includes(this.pinnedId) ? this.pinnedId : newest;
    }
    const latest = spoke.reduce((best, id) => ((this.humanAt.get(id) ?? 0) > (this.humanAt.get(best) ?? 0) ? id : best));
    // A pin only stands while the person is quieter than the moment they made it: typing somewhere
    // else is a clearer statement of where they are than the pet's earlier `pick`.
    if (this.pinnedId !== null && (this.humanAt.get(latest) ?? 0) <= this.pinnedAt) {
      if (candidates.includes(this.pinnedId)) return this.pinnedId;
    }
    return latest;
  }

  private isSubagent(agent: LiveAgent): boolean {
    const header = agent.session.header;
    if (!header) return false;
    if (typeof header.parentSession === 'string' && header.parentSession.length > 0) return true;
    if (header.origin === 'subagent') return true;
    return false;
  }
}

/** DSH envelope: `{ type, data }` with the payload keyed by type. */
export interface SessionEventLike {
  type?: unknown;
  data?: unknown;
}

/** A notice for the pet derived from one session event, or null when the event is not the pet's business. */
export function noticeOf(sessionId: string, event: SessionEventLike): { to: string; frame: unknown } | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'turn/start':
      return number(data.turn) === null
        ? null
        : { to: sessionId, frame: { t: 'turn-start', turn: number(data.turn) } };
    case 'turn/end':
      return number(data.turn) === null
        ? null
        : { to: sessionId, frame: { t: 'turn-end', turn: number(data.turn), reason: reason(data.reason) } };
    default:
      return null;
  }
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function reason(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return 'completed';
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : 'completed';
}
