/**
 * Private contacts: the locked copy at each of the member's communities (scratch/fable-design/DESIGN-private-contacts-
 * fable.md §4.3-§4.5, slice C2). The server side is apps/server routes/contacts.ts (slice C1): each community keeps one
 * copy per member, takes only a newer number, and answers `contacts: { seq } | null` in GET /api/me/unread. The list and its
 * record on the phone are contacts-store.ts.
 *
 * **What each community gets** ({@link decide}): a community never heard from is asked its number (a tiny signed GET of
 * /api/me/unread) before anything is sent; one holding a number this phone hasn't merged has its copy fetched and merged
 * first; one holding exactly what this phone merged, or nothing, gets the phone's copy when it is newer. A copy one number
 * past the one heard there goes at once: the community takes only a newer number, so it refuses it (409) if another phone
 * of the member's saved there since. Further past, that save would land under it with no 409, and the number heard may be
 * days old, so the community is asked its number again first, in the same visit, and the copy goes only if it still holds
 * what this phone merged, or nothing. So a save never overwrites people this phone hasn't seen, but for a save landing
 * there in the moment between that answer and the PUT (the server would have to take a save only over the number it
 * names to close that). A 409 `stale_copy` is the same fetch, merge and save again.
 *
 * **When.** A member's change waits a random 2 to 15 minutes before it leaves the phone at all (contacts-store.ts
 * `saveWait`; design §5.2: a save straight after a profile view would say who was added), then goes to the community the
 * phone is on. The other communities are brought level as the rounds that already ask them (other-communities-unread.ts)
 * hear their numbers ({@link contactsHeard}). The community in use is asked its number once each time the app opens, and
 * again when the Contacts screen opens ({@link checkContactsHere}).
 *
 * **What is sent.** Only the locked copy, signed, to the member's own communities, never to one the phone only looks at as a
 * guest ({@link contactsCommunities}): no name, number or email of anyone ever leaves the phone readable
 * (utils/__tests__/contacts-sync.test.ts holds every request to that).
 *
 * **Refusals.** A community that keeps no lists (`contacts_off`, or a server from before them), whose server is full
 * (`node_full`), that took too many saves this hour, or that handed back a copy that doesn't open, is left alone for a
 * while; one that keeps no lists is named in the Contacts screen's footer ({@link contactsKeptAt}).
 */
import { ContactsCryptoError, type ContactsList } from '@beanpool/core';
import { onAccountOnPhone } from './account-on-phone';
import {
    changeContacts, contactsRecordChanged, contactsSyncStoreKey, inTurn, loadContacts, phoneContactsDeps, readOnPhone, readStateFor, readSyncState, takeInCopy,
    writeState,
    type ContactsAccount, type ContactsKv, type ContactsOnPhone, type ContactsRefusal, type ContactsStoreDeps, type ContactsSyncState,
} from './contacts-store';

export const CONTACTS_COPY_PATH = '/api/contacts/copy';
const UNREAD_PATH = '/api/me/unread';
/** How long one request may take. */
export const CONTACTS_REQUEST_MS = 15_000;
const HOUR = 60 * 60 * 1000;
/** How long each refusal leaves a community alone. */
const REFUSAL_WAIT: Record<ContactsRefusal, number> = {
    contacts_off: 24 * HOUR, node_full: 24 * HOUR, too_many_saves: HOUR, newer: 24 * HOUR, not_a_member: HOUR, unopened: 24 * HOUR, too_big: 24 * HOUR,
};
/** The most steps one visit to a community takes: ask, fetch, save, and once more after a 409 (fetch, save). */
const STEPS_MAX = 5;

/** A signed request to one of the member's communities. Null when it didn't answer. A DELETE (contacts-former.ts) has no body. */
export interface ContactsNet {
    call(community: string, account: ContactsAccount, method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: unknown } | null>;
}

export interface ContactsSyncDeps extends ContactsStoreDeps {
    net: ContactsNet;
    /** The community the phone is on, and every one it keeps (that one among them). */
    communities(): Promise<{ anchor: string | null; kept: string[] }>;
}

export type ContactsStep = 'ask' | 'fetch' | 'put' | 'level' | 'skip';

/** Whether the member's latest change may leave the phone yet (design §4.5's wait). */
export function contactsDue(s: Pick<ContactsSyncState, 'dueAt'>, now: number): boolean {
    return s.dueAt === null || s.dueAt <= now;
}

/**
 * What `community` said in this visit ({@link level}): the number of the copy it keeps, null for none, and undefined before
 * it has answered in it. As a step's result, undefined is "nothing learned", which ends the visit.
 */
type Said = number | null | undefined;

/**
 * The next step for `community` (see the header). `said`: what it gave in this visit. A save more than one number past the
 * one heard there goes only on that word: the number heard may be days old, and a copy saved there since, under the
 * phone's, would be replaced with no 409.
 */
export function decide(community: string, s: ContactsSyncState, onPhone: ContactsOnPhone, now: number, said?: Said): ContactsStep {
    const refused = s.refused[community];
    if ((refused && refused.until > now) || onPhone.kind === 'unreadable') return 'skip';
    const heard = s.heard[community];
    const seq = onPhone.kind === 'list' ? onPhone.seq : 0;
    if (heard === undefined) return seq > 0 ? 'ask' : 'level';
    if (heard !== null && heard !== s.merged[community]) return 'fetch';
    if (seq <= (heard ?? 0) || !contactsDue(s, now)) return 'level';
    return seq > (heard ?? 0) + 1 && said !== heard ? 'ask' : 'put';
}

/**
 * Where the phone's latest copy is kept (design §3.6's footer): `at`, the communities holding exactly it, in the phone's
 * order; `off`, those that keep no lists (their owners' switch, or a server from before them). With none `at`, the list is
 * on this phone only: BeanPool tries again while any community might take it, and a file is the way to keep it safe when
 * none can (`off` is every one).
 */
export function contactsKeptAt(s: ContactsSyncState, onPhone: ContactsOnPhone, communities: readonly string[]): { at: string[]; off: string[]; savedAt: number | null } {
    const seq = onPhone.kind === 'list' ? onPhone.seq : 0;
    return {
        at: communities.filter((c) => seq > 0 && s.heard[c] === seq && s.merged[c] === seq),
        off: communities.filter((c) => s.refused[c]?.code === 'contacts_off'),
        savedAt: s.savedAt,
    };
}

const codeOf = (body: unknown): string | null => {
    const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? code : null;
};
const seqOf = (body: unknown): number | null => {
    const seq = body && typeof body === 'object' ? (body as { seq?: unknown }).seq : undefined;
    return Number.isSafeInteger(seq) && (seq as number) >= 1 ? (seq as number) : null;
};

/** A refusal noted for `community`, or none for an answer that says nothing lasting. */
function refusalOf(status: number, body: unknown): ContactsRefusal | null {
    const code = codeOf(body);
    if (status === 404 && code !== 'no_copy') return 'contacts_off';
    if (status === 409 && code === 'node_full') return 'node_full';
    if (status === 429) return 'too_many_saves';
    if (status === 403 && code === 'not_a_member') return 'not_a_member';
    return null;
}

/**
 * One step for `community`, in a visit where it said `said` so far. Returns what it says now: the number of the copy it
 * keeps, null for none, or undefined when nothing was learned (no answer, a refusal), which ends the visit.
 */
async function step(account: ContactsAccount, community: string, what: ContactsStep, deps: ContactsSyncDeps, said: Said): Promise<Said> {
    const now = (deps.now ?? Date.now)();
    if (what === 'fetch') {
        const answer = await deps.net.call(community, account, 'GET', CONTACTS_COPY_PATH);
        if (!answer) return undefined;
        if (answer.status === 200) {
            try {
                const took = await takeInCopy(account, community, answer.body, deps);
                return took.kind === 'merged' ? took.seq : undefined;
            } catch (e) {
                // Its copy and the phone's together can't be locked as one: rest a day rather than fetch it each pass.
                if (!(e instanceof ContactsCryptoError)) throw e;
                return note(account, deps, (s) => refuse(s, community, 'too_big', now));
            }
        }
        return note(account, deps, (s): Said => {
            if (answer.status === 404 && codeOf(answer.body) === 'no_copy') {
                s.heard[community] = null;
                delete s.merged[community];
                delete s.refused[community];
                return null;
            }
            return refuse(s, community, refusalOf(answer.status, answer.body), now);
        });
    }
    if (what === 'ask') {
        const answer = await deps.net.call(community, account, 'GET', UNREAD_PATH);
        if (!answer) return undefined;
        return note(account, deps, (s): Said => {
            if (answer.status !== 200) return refuse(s, community, refusalOf(answer.status, answer.body), now);
            const contacts = answer.body && typeof answer.body === 'object' ? (answer.body as { contacts?: unknown }).contacts : undefined;
            // A server from before private contacts says nothing of them: it keeps none.
            if (contacts === undefined) return refuse(s, community, 'contacts_off', now);
            const seq = contacts === null ? null : seqOf(contacts);
            if (contacts !== null && seq === null) return undefined;
            s.heard[community] = seq;
            delete s.refused[community];
            return seq;
        });
    }
    // 'put': the file's copy as it is, its number written down as sent before it goes, and only while `decide` still says so
    // on what this visit heard.
    const sending = await inTurn(account.publicKey, async () => {
        const onPhone = await readOnPhone(account, deps.disk);
        if (onPhone.kind !== 'list') return null;
        const s = await readStateFor(account, deps.kv, onPhone);
        if (decide(community, s, onPhone, now, said) !== 'put') return null;
        s.sentSeq = Math.max(s.sentSeq, onPhone.seq);
        await writeState(account, deps.kv, s);
        return onPhone;
    });
    if (!sending) return undefined;
    const answer = await deps.net.call(community, account, 'PUT', CONTACTS_COPY_PATH, sending.copy);
    if (!answer) return undefined;
    return note(account, deps, (s): Said => {
        if (answer.status === 200 && seqOf(answer.body) === sending.seq) {
            s.heard[community] = sending.seq;
            s.merged[community] = sending.seq;
            delete s.refused[community];
            s.savedAt = now;
            if (s.fileSeq === sending.seq) s.dueAt = null;
            return sending.seq;
        }
        if (answer.status === 409 && codeOf(answer.body) === 'stale_copy') {
            // Another phone of the member's saved a newer copy there: fetched and merged next.
            const kept = seqOf(answer.body);
            if (kept === null) return undefined;
            s.heard[community] = kept;
            return kept;
        }
        return refuse(s, community, refusalOf(answer.status, answer.body), now);
    });
}

/** A refusal noted for `community` (none for an answer that says nothing lasting). Nothing learned: the visit ends. */
function refuse(s: ContactsSyncState, community: string, code: ContactsRefusal | null, now: number): undefined {
    if (!code) return undefined;
    s.refused[community] = { code, until: now + REFUSAL_WAIT[code] };
    if (code === 'contacts_off') s.heard[community] = null;
    return undefined;
}

/**
 * `edit` applied to the record, in the account's turn, and written when it changed anything. Returns what `edit` returns.
 * `edit` is handed the list as this turn opened it, so a caller that needs it too doesn't open it a second time.
 */
async function note<T>(account: ContactsAccount, deps: ContactsSyncDeps, edit: (s: ContactsSyncState, onPhone: ContactsOnPhone) => T): Promise<T> {
    return inTurn(account.publicKey, async () => {
        const onPhone = await readOnPhone(account, deps.disk);
        const s = await readStateFor(account, deps.kv, onPhone);
        const before = JSON.stringify(s);
        const result = edit(s, onPhone);
        // Nothing is written for an account with no list and nothing heard: nothing exists until a first contact.
        if (JSON.stringify(s) !== before && (onPhone.kind !== 'none' || Object.values(s.heard).some((n) => n !== null))) {
            await writeState(account, deps.kv, s);
            contactsRecordChanged(account.publicKey);
        }
        return result;
    });
}

/**
 * `community` brought level, one step at a time (at most {@link STEPS_MAX}), each on what it has said in this visit: a
 * save far past the number heard there waits for its word ({@link decide}). Throws what the disk throws.
 */
async function level(account: ContactsAccount, community: string, deps: ContactsSyncDeps): Promise<void> {
    let said: Said;
    for (let i = 0; i < STEPS_MAX; i++) {
        const { onPhone, state } = await loadContacts(account, deps);
        const what = decide(community, state, onPhone, (deps.now ?? Date.now)(), said);
        if (what === 'level' || what === 'skip') return;
        said = await step(account, community, what, deps, said);
        if (said === undefined) return;
    }
}

/** The pass under way for each account. */
const passing = new Map<string, Promise<void>>();

/** The number of the list on the phone, or 0. */
async function fileSeqOf(account: ContactsAccount, deps: ContactsSyncDeps): Promise<number> {
    const { onPhone } = await loadContacts(account, deps);
    return onPhone.kind === 'list' ? onPhone.seq : 0;
}

/** How many times a pass goes round: a merge from a later community raises the list, and the earlier ones then get it too. */
const ROUNDS_MAX = 3;

/**
 * One pass over the member's communities: the one in use first, then every other one the phone keeps, one at a time, and
 * round again while a merge on the way raised the phone's list. A call while one runs waits for it. Never throws.
 */
export function syncContacts(account: ContactsAccount | null, deps: ContactsSyncDeps = phoneSyncDeps()): Promise<void> {
    if (!account?.publicKey || !account.privateKey) return Promise.resolve();
    const key = account.publicKey.toLowerCase();
    const running = passing.get(key);
    if (running) return running;
    const pass = (async () => {
        const { anchor, kept } = await deps.communities();
        const order = [...new Set([anchor, ...kept].filter((c): c is string => !!c))];
        for (let round = 0; round < ROUNDS_MAX; round++) {
            const before = await fileSeqOf(account, deps);
            for (const c of order) await level(account, c, deps);
            if (await fileSeqOf(account, deps) === before) break;
        }
        await forgetLeft(account, order, deps);
    })().catch((e) => console.warn('[Contacts] A pass over the communities failed', e)).finally(() => { passing.delete(key); });
    passing.set(key, pass);
    return pass;
}

/** What the record says of communities the phone no longer keeps goes: the footer names only where copies are. */
async function forgetLeft(account: ContactsAccount, kept: readonly string[], deps: ContactsSyncDeps): Promise<void> {
    await note(account, deps, (s) => {
        for (const map of [s.heard, s.merged, s.refused] as Record<string, unknown>[]) {
            for (const c of Object.keys(map)) if (!kept.includes(c)) delete map[c];
        }
        return false;
    });
}

/**
 * A round's answer from `community` (other-communities-unread.ts): the number of the member's copy kept there, written
 * down, and a pass started when that community needs one. Only while the app is open: a closed round only notes it. The
 * list is opened once for both: opening it is the costly part on an old phone (PR #3073's review; measured in the PR that
 * made this change, at 2,000 contacts on the API 26 emulator).
 */
export async function contactsHeard(account: ContactsAccount | null, community: string, body: unknown, open: boolean, deps: ContactsSyncDeps = phoneSyncDeps()): Promise<void> {
    if (!account?.publicKey || !account.privateKey) return;
    const contacts = body && typeof body === 'object' ? (body as { contacts?: unknown }).contacts : undefined;
    if (contacts === undefined) return;
    const seq = contacts === null ? null : seqOf(contacts);
    if (contacts !== null && seq === null) return;
    try {
        const what = await note(account, deps, (s, onPhone) => {
            s.heard[community] = seq;
            return decide(community, s, onPhone, (deps.now ?? Date.now)());
        });
        if (open && what !== 'level' && what !== 'skip') void syncContacts(account, deps);
    } catch (e) {
        console.warn('[Contacts] A round\'s answer was not noted', e);
    }
}

/** When each account last asked the community in use (ms). */
const lastHere = new Map<string, number>();
/** How often the community in use is asked its number, at most. */
export const CHECK_HERE_GAP_MS = 60 * 1000;

/**
 * The community in use asked its number (design §4.5: a new phone shows the list as soon as a community answers with it),
 * then a pass. At most once a minute. Never throws.
 */
export async function checkContactsHere(account: ContactsAccount | null, deps: ContactsSyncDeps = phoneSyncDeps()): Promise<void> {
    if (!account?.publicKey || !account.privateKey) return;
    const now = (deps.now ?? Date.now)();
    const key = account.publicKey.toLowerCase();
    const last = lastHere.get(key) ?? -Infinity;
    if (now - last < CHECK_HERE_GAP_MS && now >= last) return;
    lastHere.set(key, now);
    try {
        const { anchor } = await deps.communities();
        if (anchor) {
            const answer = await deps.net.call(anchor, account, 'GET', UNREAD_PATH);
            if (answer?.status === 200) await contactsHeard(account, anchor, answer.body, false, deps);
        }
    } catch (e) {
        console.warn('[Contacts] The community in use was not asked', e);
    }
    await syncContacts(account, deps);
}

/** For a test: forget when the community in use was last asked. */
export function resetContactsCheckForTests(): void {
    lastHere.clear();
}

let timer: { at: ReturnType<typeof setTimeout>; for: string } | null = null;
/** The account the phone last said it holds (account-on-phone.ts), once it has said one. */
let onPhoneNow: string | null | undefined;

function stopTimer(): void {
    if (timer) clearTimeout(timer.at);
    timer = null;
}

// A save set for an account that has since left the phone never goes: its pass would be signed with a key the phone no
// longer holds, to the communities of the account that replaced it.
onAccountOnPhone((publicKey) => {
    onPhoneNow = (publicKey ?? '').toLowerCase() || null;
    if (timer && timer.for !== onPhoneNow) stopTimer();
});

/**
 * A pass when the member's latest change is due to leave the phone (its wait, design §4.5): set after each change, and as
 * the app opens with a change still waiting. One timer for the phone; a later call replaces it. Never throws. Reads only the
 * record beside the list, never the list: when a change is due doesn't depend on it, and opening 2,000 contacts takes most of
 * a second on an old phone (PR #3142's measure), after every change and at every start.
 */
export async function savePassWhenDue(account: ContactsAccount | null, deps: ContactsSyncDeps = phoneSyncDeps()): Promise<void> {
    stopTimer();
    if (!account?.publicKey) return;
    try {
        const state = readSyncState(await deps.kv.getItem(contactsSyncStoreKey(account.publicKey)));
        if (state.dueAt === null) return;
        const wait = Math.max(0, state.dueAt - (deps.now ?? Date.now)());
        stopTimer();
        const key = account.publicKey.toLowerCase();
        // The account went while its record was read: nothing is set for it.
        if (onPhoneNow !== undefined && onPhoneNow !== key) return;
        const at = setTimeout(() => {
            timer = null;
            if (onPhoneNow === undefined || onPhoneNow === key) void syncContacts(account, deps);
        }, wait + 1000);
        timer = { at, for: key };
    } catch (e) {
        console.warn('[Contacts] The save could not be set for later', e);
    }
}

/** The phone's own requests: signed with the member's key for that community's host, with no body on a GET or a DELETE. */
export function phoneContactsNet(): ContactsNet {
    return {
        async call(community, account, method, path, body) {
            const url = `${community.replace(/\/+$/, '')}${path}`;
            const raw = method === 'PUT' ? JSON.stringify(body ?? {}) : '';
            const controller = new AbortController();
            const stop = setTimeout(() => controller.abort(), CONTACTS_REQUEST_MS);
            try {
                const { buildSignedHeaders } = await import('./crypto');
                const headers = await buildSignedHeaders(method, url, raw, account.privateKey, account.publicKey);
                if (!raw) delete headers['Content-Type'];
                const res = await fetch(url, { method, headers: { Accept: 'application/json', ...headers }, ...(raw ? { body: raw } : {}), signal: controller.signal });
                return { status: res.status, body: await res.json().catch(() => null) };
            } catch (e) {
                console.log(`[Contacts] ${community} did not answer: ${e instanceof Error ? e.message : e}`);
                return null;
            } finally {
                clearTimeout(stop);
            }
        },
    };
}

/** The communities the phone only looks at as a guest (nodes.ts `markGuestNode`). */
const GUEST_NODES_STORE_KEY = 'beanpool_guest_nodes';

/**
 * The communities a pass visits: every one the phone keeps (push-pins.ts `readKeptCommunities`), the one in use first, but
 * none it only looks at as a guest (nodes.ts `markGuestNode`: Global after "Explore worldwide", say), the one in use among
 * them. A look is not belonging, as push-registrations.ts `communitiesForAlerts` has it: such a community keeps no copy
 * for a guest, and it isn't told of the member's key at the times their contacts change (design §5.1: BeanPool runs no
 * service in this). Joining clears the mark. One with alerts off stays: the member belongs there. Throws when the phone's
 * storage can't be read.
 */
export async function contactsCommunities(storage: Pick<ContactsKv, 'getItem'>): Promise<{ anchor: string | null; kept: string[] }> {
    const { readKeptCommunities, sameCommunity } = await import('./push-pins');
    const { anchor, kept } = await readKeptCommunities(storage);
    // A read that fails throws (no pass); only a record that reads but doesn't parse counts as none, as nodes.ts reads it.
    const raw = await storage.getItem(GUEST_NODES_STORE_KEY);
    let marks: unknown;
    try {
        marks = JSON.parse(raw ?? '[]');
    } catch {
        marks = [];
    }
    const looks = Array.isArray(marks) ? marks : [];
    const belongs = (c: string) => !looks.some((look) => sameCommunity(look, c));
    return { anchor: anchor !== null && belongs(anchor) ? anchor : null, kept: kept.filter(belongs) };
}

/** The phone's own: its disk, AsyncStorage, signed fetch and the member's communities ({@link contactsCommunities}). */
export function phoneSyncDeps(base: ContactsStoreDeps = phoneContactsDeps()): ContactsSyncDeps {
    return {
        ...base,
        net: phoneContactsNet(),
        communities: () => contactsCommunities(base.kv),
    };
}

/**
 * The member's change (contacts-store.ts `changeContacts`), and its save set for when its wait is over. What every screen
 * calls. Throws what `changeContacts` throws (a list on this phone that can't be opened is never written over).
 */
export async function editContacts(account: ContactsAccount, change: (list: ContactsList) => ContactsList, deps: ContactsSyncDeps = phoneSyncDeps()): Promise<ContactsList> {
    const next = await changeContacts(account, change, deps);
    await savePassWhenDue(account, deps);
    return next;
}
