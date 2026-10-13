/**
 * Members on demand (DESIGN-global-members-by-area §2.2, #1792): on a community whose profile says
 * `features.membersOnDemand` (the worldwide one), this phone never reads the directory whole. It holds the cards it can
 * show a reason for, the "referenced" keys: its own, everyone it chats with, trades with, rates or is rated by, its
 * friends and whoever vouched it in. Listing authors are not in it: the by-area posts row carries their name and face.
 * After each landed cycle it asks the node for the referenced cards it lacks, `keys=` at most 100 at a time and at most
 * three requests a cycle (the rest the next cycle), re-checks the 100 held cards it fetched longest ago, and past 1,000
 * cards drops the oldest ones nothing references. Nothing here deletes a card for a read that did not land.
 *
 * Pure: the sync (services/pillar-sync.ts) reads the sets out of the phone's database and does what the plan says.
 */

/** At most this many keys a `keys=` read: ~6.6 KB of query string. The node refuses more; never raise it. */
export const KEYS_BATCH = 100;
/** At most this many `keys=` reads for missing cards a cycle; the rest wait for the next cycle. */
export const MISSING_BATCHES_PER_CYCLE = 3;
/** Past this many held cards the oldest unreferenced ones are dropped. A referenced card and the own card never are. */
export const HELD_CARDS_MAX = 1000;

/** A key as the node spells member keys: 64 lower-case hexadecimal characters. Anything else (a project or escrow
 *  account, a typo) is never asked for: the node answers 400 to a batch with one in it. */
const MEMBER_KEY = /^[0-9a-f]{64}$/;
export function isMemberKey(key: unknown): key is string {
    return typeof key === 'string' && MEMBER_KEY.test(key);
}

/** One held card: its key and when this phone last fetched it from the node (ISO), or null for a card from before. */
export interface HeldCard {
    key: string;
    fetchedAt: string | null;
}

export interface MembersPlan {
    /** The `keys=` reads for referenced cards this phone lacks, each ≤ KEYS_BATCH keys, at most MISSING_BATCHES_PER_CYCLE. */
    missing: string[][];
    /** The held cards to re-check this cycle (≤ KEYS_BATCH, oldest fetch first), or null when none are held. */
    revalidate: { keys: string[]; since: string | null } | null;
}

function byFetchOldestFirst(a: HeldCard, b: HeldCard): number {
    // A card never stamped (held from before this rule) is the oldest of all.
    if (a.fetchedAt === b.fetchedAt) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    if (a.fetchedAt === null) return -1;
    if (b.fetchedAt === null) return 1;
    return a.fetchedAt < b.fetchedAt ? -1 : 1;
}

/** The keys this phone must hold: the own key and every referenced one, each spelled as a member key. */
export function neededKeys(own: string | null, referenced: Iterable<string>): Set<string> {
    const needed = new Set<string>();
    if (isMemberKey(own)) needed.add(own);
    for (const k of referenced) if (isMemberKey(k)) needed.add(k);
    return needed;
}

/**
 * What to ask the node this cycle. `missing` = (own ∪ referenced) − held, sorted, cut into batches of KEYS_BATCH, at
 * most MISSING_BATCHES_PER_CYCLE of them. `revalidate` = up to KEYS_BATCH held cards (not the ones just asked for),
 * oldest fetch first, with `since` = the oldest stamp among them: the node then answers only the cards changed after
 * it (usually none), and every card when `since` is null (a card never stamped is fetched whole).
 */
export function planMembersCycle(own: string | null, referenced: Iterable<string>, held: Iterable<HeldCard>): MembersPlan {
    const needed = neededKeys(own, referenced);
    const heldCards = [...held].filter(c => isMemberKey(c.key));
    const heldKeys = new Set(heldCards.map(c => c.key));
    const lacking = [...needed].filter(k => !heldKeys.has(k)).sort();
    const missing: string[][] = [];
    for (let i = 0; i < lacking.length && missing.length < MISSING_BATCHES_PER_CYCLE; i += KEYS_BATCH) {
        missing.push(lacking.slice(i, i + KEYS_BATCH));
    }
    const oldest = heldCards.sort(byFetchOldestFirst).slice(0, KEYS_BATCH);
    const revalidate = oldest.length === 0 ? null : {
        keys: oldest.map(c => c.key),
        since: oldest.some(c => c.fetchedAt === null) ? null : oldest[0].fetchedAt,
    };
    return { missing, revalidate };
}

/**
 * The held cards to drop so at most `max` remain: the oldest fetched among those neither referenced nor the own card.
 * A referenced card or the own card is never dropped, even past the bound (they are what the screens name).
 */
export function cardsToDrop(own: string | null, referenced: Iterable<string>, held: Iterable<HeldCard>, max: number = HELD_CARDS_MAX): string[] {
    const needed = neededKeys(own, referenced);
    const heldCards = [...held];
    const over = heldCards.length - max;
    if (over <= 0) return [];
    return heldCards
        .filter(c => !needed.has(c.key))
        .sort(byFetchOldestFirst)
        .slice(0, over)
        .map(c => c.key);
}

/** The `keys=` read for one batch, with the cursor the node compares each card's change against when re-checking. */
export function membersKeysPath(keys: readonly string[], since?: string | null): string {
    if (keys.length === 0 || keys.length > KEYS_BATCH) throw new Error(`a keys read is 1 to ${KEYS_BATCH} keys`);
    const cursor = since ? `&updatedAfter=${encodeURIComponent(since)}` : '';
    return `/api/members?keys=${keys.join(',')}${cursor}`;
}

/** A referenced key the node answered no card for (a member pruned since, an account that is not a person) is not
 *  asked again for this long, so one such key never costs a request every cycle. Its screens show the key's first
 *  8 characters meanwhile, as they do for any card not held. */
export const ABSENT_RETRY_MS = 24 * 60 * 60 * 1000;

/** The keys asked for recently and not answered, from what was stored (`{ key: when asked, ms }`); stale ones dropped. */
export function readAbsent(raw: string | null, nowMs: number): Map<string, number> {
    const absent = new Map<string, number>();
    try {
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [k, at] of Object.entries(parsed)) {
                if (isMemberKey(k) && typeof at === 'number' && nowMs - at < ABSENT_RETRY_MS && at <= nowMs) absent.set(k, at);
            }
        }
    } catch {}
    return absent;
}

/** What to store after a cycle: the keys still absent, those asked and not answered now added, the answered ones gone. */
export function absentAfter(before: Map<string, number>, asked: readonly string[], answered: ReadonlySet<string>, nowMs: number): string {
    const next: Record<string, number> = {};
    for (const [k, at] of before) if (!answered.has(k)) next[k] = at;
    for (const k of asked) if (!answered.has(k)) next[k] = nowMs;
    return JSON.stringify(next);
}
