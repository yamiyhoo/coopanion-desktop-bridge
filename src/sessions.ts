/**
 * What the pet may know about the conversations this Host holds.
 *
 * The pet could always speak (`say`) and always point (`pick`), but it had no way to learn a
 * session id: a misdelivery reached the person as "已交给 DSH" and nothing else. This reads the
 * names a person already sees and marks which of them can actually receive a line **here**.
 *
 * That mark is the whole point. `%USERPROFILE%\.dsh` is shared with the desktop app, so a listing
 * of the store contains conversations this Host does not hold live: the desktop app's sessions, and
 * the subagents inside them. Line into one of those goes nowhere a person is looking, which is
 * exactly the failure this bridge was fixed for — so a read-only entry is listed as read-only and
 * `pick` refuses it.
 *
 * Reading is optional. `ctx.sessionQuery` is mounted by `@deepseek-ai/dsh-base`, and this module
 * takes a getter rather than the service so a Host without it still runs the bridge: the listing is
 * then empty with a reason, and nothing else changes.
 */

/** One conversation, as much of it as the pet may see. */
export interface SessionEntry {
  /** The full id, which is what `pick` takes. */
  id: string;
  /** The id as a person reads it out loud: `session-` plus the first block, e.g. `d80ba9b9`. */
  short: string;
  /** The name the person sees in DSH, or an empty string when the log carries none. */
  title: string;
  /** True when this Host holds the session live, so a line submitted here reaches its agent. */
  live: boolean;
  /** True when `pick` would be accepted: live, not a subagent, and known to the registry. */
  pickable: boolean;
  cwd: string;
  /** True for the conversation the pet currently speaks into. */
  owner: boolean;
  /** When a person last spoke in it, by this Host's clock; 0 when it has not since activation. */
  lastHumanAt: number;
}

/** A listing outcome: entries, plus why there are none when something could not be read. */
export interface SessionListing {
  entries: SessionEntry[];
  why?: string;
}

/** The slice of `ctx.sessionQuery` this module uses. */
export interface SessionQueryLike {
  listSessions(signal?: unknown): Promise<Array<{ header?: Record<string, unknown>; live?: boolean; persisted?: boolean }>>;
  readTitleSnapshots(
    ids: string[],
    signal?: unknown,
  ): Promise<Array<{ status: string; value?: { title?: unknown } }>>;
}

/** The slice of the agent registry the listing needs. */
export interface ListingAgents {
  ownerSession: string | null;
  has(id: string): boolean;
  lastHumanAtOf(id: string): number;
}

/** How many conversations a bubble-sized listing may carry. */
const LIMIT = 20;

/** How long one listing is reused before the store is read again. */
const TTL_MS = 10_000;

/** True when a value looks like the query service rather than something else of that name. */
export function looksLikeSessionQuery(value: unknown): value is SessionQueryLike {
  if (typeof value !== 'object' || value === null) return false;
  const q = value as { listSessions?: unknown; readTitleSnapshots?: unknown };
  return typeof q.listSessions === 'function' && typeof q.readTitleSnapshots === 'function';
}

/**
 * The newest conversations of this Host, with the names a person sees.
 *
 * One listing is held for `ttlMs` because a title folds the session's own log; a pet that asks
 * twice in a second must not replay twenty reads for the same answer.
 */
export class SessionDirectory {
  private cache: { at: number; listing: SessionListing } | null = null;
  private readonly titles = new Map<string, string>();
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      /** Resolved per call: the service may mount after this plugin does, or never. */
      query: () => SessionQueryLike | null;
      agents: ListingAgents;
      limit?: number;
      ttlMs?: number;
      now?: () => number;
      /** Where a failed title read is reported; a listing is not worth failing over for one. */
      log?: (level: 'info' | 'warn', text: string) => void;
    },
  ) {
    this.limit = opts.limit ?? LIMIT;
    this.ttlMs = opts.ttlMs ?? TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** The listing, oldest read reused while fresh. Never throws: a failure becomes `why`. */
  async list(): Promise<SessionListing> {
    const now = this.now();
    if (this.cache !== null && now - this.cache.at < this.ttlMs) return this.cache.listing;
    const query = this.opts.query();
    if (!query) {
      return { entries: [], why: 'this Host has no session query service, so conversations cannot be listed' };
    }
    let records: Awaited<ReturnType<SessionQueryLike['listSessions']>>;
    try {
      records = await query.listSessions();
    } catch (err) {
      return { entries: [], why: `listing conversations failed: ${(err as Error).message}` };
    }
    const rows = (records ?? [])
      .filter((record) => typeof record?.header?.id === 'string' && record.header.id !== '')
      .filter((record) => !isSubagentHeader(record.header))
      .slice(0, this.limit);
    const ids = rows.map((record) => String(record.header!.id));
    const titles = await this.titlesOf(query, ids);
    const entries = rows.map((record, index) => this.entryOf(record, String(record.header!.id), titles[index] ?? ''));
    for (const [index, id] of ids.entries()) this.titles.set(id, titles[index] ?? '');
    const listing: SessionListing = { entries };
    this.cache = { at: now, listing };
    return listing;
  }

  /** One conversation's title; '' when the log has none or the service cannot be reached. */
  async titleOf(session: string): Promise<string> {
    if (!session) return '';
    const cached = this.titles.get(session);
    if (cached !== undefined) return cached;
    const query = this.opts.query();
    if (!query) return '';
    const titles = await this.titlesOf(query, [session]);
    const title = titles[0] ?? '';
    this.titles.set(session, title);
    return title;
  }

  /** The title read for `session` so far, for the frames that must answer without waiting. */
  cachedTitle(session: string): string {
    return this.titles.get(session) ?? '';
  }

  /** Folds titles for `ids`, index-aligned; a rejected read yields '' rather than aborting the page. */
  private async titlesOf(query: SessionQueryLike, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    try {
      const snapshots = await query.readTitleSnapshots(ids);
      const rejected = (snapshots ?? []).filter((snapshot) => snapshot?.status !== 'fulfilled').length;
      if (rejected > 0) this.opts.log?.('warn', `${rejected}/${ids.length} conversation titles could not be read`);
      return ids.map((_, index) => {
        const snapshot = snapshots?.[index];
        if (!snapshot || snapshot.status !== 'fulfilled') return '';
        return titleText(snapshot.value?.title);
      });
    } catch (err) {
      // A title is a courtesy; the listing itself is the contract, so it survives this.
      this.opts.log?.('warn', `reading conversation titles failed: ${(err as Error).message}`);
      return ids.map(() => '');
    }
  }

  private entryOf(
    record: { header?: Record<string, unknown>; live?: boolean },
    id: string,
    title: string,
  ): SessionEntry {
    const live = record.live !== false;
    return {
      id,
      short: shortSessionId(id),
      title,
      live,
      pickable: live && this.opts.agents.has(id),
      cwd: typeof record.header?.cwd === 'string' ? record.header.cwd : '',
      owner: this.opts.agents.ownerSession === id,
      lastHumanAt: this.opts.agents.lastHumanAtOf(id),
    };
  }
}

/** `session-d80ba9b9-…` → `d80ba9b9`: enough to name a conversation in a bubble, short of an id. */
export function shortSessionId(id: string): string {
  const bare = id.startsWith('session-') ? id.slice('session-'.length) : id;
  return bare.split('-')[0] ?? bare;
}

/**
 * The text of a folded title.
 *
 * `readTitleSnapshots` puts a **title snapshot** there, not a string: `{ title, messageSeqs,
 * source, eventSeq, updatedAt }` from `foldSessionTitle`. Reading it as a string turned every
 * conversation nameless in exactly the release that was supposed to name them, so both shapes are
 * accepted here.
 */
export function titleText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const inner = (value as { title?: unknown }).title;
    if (typeof inner === 'string') return inner;
  }
  return '';
}

/** A subagent is a speaker a person never opened, so it is not one they may choose either. */
function isSubagentHeader(header: Record<string, unknown> | undefined): boolean {
  if (!header) return false;
  const parent = header.parentSession;
  if (typeof parent === 'string' && parent.length > 0) return true;
  return header.origin === 'subagent';
}
