/**
 * The conversation listing: the names a person already sees, and the mark that stops the pet from
 * pointing at a conversation that cannot hear it.
 *
 * The reads are faked here — a store is not what these tests are about — but the shapes are the ones
 * `ctx.sessionQuery` returns, including the index-aligned per-session title results.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SessionDirectory,
  looksLikeSessionQuery,
  shortSessionId,
  titleText,
  type SessionQueryLike,
} from '../src/sessions.ts';

/** A session header as the query service lists it. */
const header = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  cwd: '/w',
  createdAt: 1,
  ...extra,
});

/** A query service over fixed records, with titles keyed by session id. */
function queryOf(
  records: Array<{ header: Record<string, unknown>; live?: boolean; persisted?: boolean }>,
  titles: Record<string, string> = {},
): SessionQueryLike & { listSessions: ReturnType<typeof vi.fn>; readTitleSnapshots: ReturnType<typeof vi.fn> } {
  return {
    listSessions: vi.fn(async () => records),
    // The real shape: `value.title` is a title *snapshot* (`{ title, messageSeqs, … }`), which is
    // what `foldSessionTitle` returns — not the string a first reading assumes.
    readTitleSnapshots: vi.fn(async (ids: string[]) =>
      ids.map((id) =>
        titles[id] === undefined
          ? { status: 'rejected' as const }
          : {
              status: 'fulfilled' as const,
              value: { title: { title: titles[id], messageSeqs: [1], eventSeq: 2, updatedAt: 3 } },
            },
      ),
    ),
  } as never;
}

/** The registry slice the listing reads. */
function agentsOf(overrides: Partial<{ owner: string | null; has: string[]; human: Record<string, number> }> = {}) {
  return {
    ownerSession: overrides.owner ?? null,
    has: (id: string) => (overrides.has ?? []).includes(id),
    lastHumanAtOf: (id: string) => (overrides.human ?? {})[id] ?? 0,
  };
}

describe('a conversation id as a person reads it', () => {
  it('is the first block of the id, after the prefix', () => {
    expect(shortSessionId('session-d80ba9b9-6de1-4487-82f9-a7b34d1ed62d')).toBe('d80ba9b9');
    expect(shortSessionId('d80ba9b9-6de1')).toBe('d80ba9b9');
    expect(shortSessionId('session')).toBe('session');
  });
});

describe('the session query service', () => {
  it('is recognised by the two reads this listing needs', () => {
    expect(looksLikeSessionQuery(queryOf([]))).toBe(true);
    expect(looksLikeSessionQuery({ listSessions: () => [] })).toBe(false);
    expect(looksLikeSessionQuery(null)).toBe(false);
    expect(looksLikeSessionQuery('sessionQuery')).toBe(false);
  });
});

describe('the text of a folded title', () => {
  it('is read out of the snapshot object the query service returns', () => {
    expect(titleText({ title: '修 Telegram @ 识别', messageSeqs: [9], eventSeq: 13 })).toBe('修 Telegram @ 识别');
  });

  it('is read from a bare string too', () => {
    expect(titleText('另一个标题')).toBe('另一个标题');
  });

  it('is nothing when there is no title at all', () => {
    expect(titleText(undefined)).toBe('');
    expect(titleText(null)).toBe('');
    expect(titleText({})).toBe('');
    expect(titleText({ title: 42 })).toBe('');
  });
});

describe('the conversation listing', () => {
  it('names the conversations and folds their titles in the order they were listed', async () => {
    const directory = new SessionDirectory({
      query: () => queryOf([{ header: header('session-a') }, { header: header('session-b') }], {
        'session-a': '修 Telegram @ 识别',
        'session-b': '装 token-cost',
      }),
      agents: agentsOf({ owner: 'session-b', has: ['session-b'], human: { 'session-b': 1_700 } }),
    });
    const { entries } = await directory.list();
    expect(entries.map((entry) => [entry.short, entry.title])).toEqual([
      ['a', '修 Telegram @ 识别'],
      ['b', '装 token-cost'],
    ]);
    expect(entries[1]).toMatchObject({ id: 'session-b', owner: true, lastHumanAt: 1_700, live: true, pickable: true });
    expect(entries[0]).toMatchObject({ owner: false, pickable: false });
  });

  it('marks a conversation this Host does not hold as read-only, whatever the registry says', async () => {
    const directory = new SessionDirectory({
      query: () => queryOf([{ header: header('session-desk'), live: false }]),
      agents: agentsOf({ has: ['session-desk'] }),
    });
    const { entries } = await directory.list();
    // A line submitted to it would reach a process this bridge cannot talk to: listing it as
    // ordinary would rebuild the illusion that "delivered" means "delivered to my window".
    expect(entries[0]).toMatchObject({ live: false, pickable: false });
  });

  it('leaves subagents out: a person never opened one, so they cannot choose it', async () => {
    const directory = new SessionDirectory({
      query: () =>
        queryOf([
          { header: header('session-a') },
          { header: header('session-sub', { parentSession: 'session-a' }) },
          { header: header('session-sub2', { origin: 'subagent' }) },
        ]),
      agents: agentsOf(),
    });
    const { entries } = await directory.list();
    expect(entries.map((entry) => entry.id)).toEqual(['session-a']);
  });

  it('keeps the page short enough for a bubble', async () => {
    const records = Array.from({ length: 6 }, (_, index) => ({ header: header(`session-${index}`) }));
    const directory = new SessionDirectory({ query: () => queryOf(records), agents: agentsOf(), limit: 3 });
    expect((await directory.list()).entries).toHaveLength(3);
  });

  it('reads the store once while the listing is fresh', async () => {
    let now = 1_000;
    const query = queryOf([{ header: header('session-a') }]);
    const directory = new SessionDirectory({ query: () => query, agents: agentsOf(), ttlMs: 10_000, now: () => now });
    await directory.list();
    now += 5_000;
    await directory.list();
    expect(query.listSessions).toHaveBeenCalledTimes(1);
    now += 6_000;
    await directory.list();
    expect(query.listSessions).toHaveBeenCalledTimes(2);
  });

  it('explains an empty listing instead of failing the bridge', async () => {
    const directory = new SessionDirectory({ query: () => null, agents: agentsOf() });
    const listing = await directory.list();
    expect(listing.entries).toEqual([]);
    expect(listing.why).toContain('no session query service');
  });

  it('reports a failed listing as a reason, not a throw', async () => {
    const query = queryOf([]);
    query.listSessions.mockRejectedValueOnce(new Error('store is unreadable'));
    const directory = new SessionDirectory({ query: () => query, agents: agentsOf() });
    const listing = await directory.list();
    expect(listing.entries).toEqual([]);
    expect(listing.why).toContain('store is unreadable');
  });

  it('still lists a conversation whose title cannot be read', async () => {
    const query = queryOf([{ header: header('session-a') }]);
    query.readTitleSnapshots.mockRejectedValueOnce(new Error('title fold failed'));
    const directory = new SessionDirectory({ query: () => query, agents: agentsOf() });
    const { entries } = await directory.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('');
  });

  it('reads one title on demand and remembers it', async () => {
    const query = queryOf([], { 'session-x': '临时会话' });
    const directory = new SessionDirectory({ query: () => query, agents: agentsOf() });
    expect(await directory.titleOf('session-x')).toBe('临时会话');
    expect(directory.cachedTitle('session-x')).toBe('临时会话');
    await directory.titleOf('session-x');
    expect(query.readTitleSnapshots).toHaveBeenCalledTimes(1);
  });

  it('answers with no title when the service is absent', async () => {
    const directory = new SessionDirectory({ query: () => null, agents: agentsOf() });
    expect(await directory.titleOf('session-x')).toBe('');
    expect(directory.cachedTitle('session-x')).toBe('');
  });
});
