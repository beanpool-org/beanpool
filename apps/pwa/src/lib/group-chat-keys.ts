/**
 * group-chat-keys — a group chat's keys in the web app (group chats slice 4). The phone's twin is
 * apps/native/utils/group-chat-keys.ts (#1788, with its three reviews): the rules below are the phone's, rule for rule.
 *
 * Designs (all decided by Marty): scratch/global-node/DESIGN-group-chat-encryption-fable.md §2–§4, §14.3;
 * DESIGN-group-chat-wrap-provenance-fable.md §5.3 (the web asks only for the epochs it needs), §7 (which epoch to seal
 * under) and §10 (the web remembers the highest epoch; old epochs verified lazily); DESIGN-group-chat-epochs-over-time-
 * fable.md §1 (when to refuse a wrap) and §2 (no roster on reads).
 *
 * What the web keeps, and where:
 * - In memory only, for the page's life: each epoch's record as the node served it, MY wrap for it, the keys opened from
 *   those wraps, and the verdicts of the signatures verified. Nothing secret and no line is written anywhere (design §4:
 *   "the PWA holds keys in memory only and re-opens wraps on load"; it caches no messages).
 * - In IndexedDB, per identity and group (GroupLockStore): the highest epoch this browser has verified or made, which
 *   never falls, and whether it has seen the group locked (provenance §10 pick 1; the director's sticky lock). A read of
 *   that store that fails is never taken as "never seen": nothing is sealed or sent readable until it reads.
 *
 * Which epoch a line goes under (provenance §7): the node's current one, and only when (1) it is not below the highest
 * this browser holds (else "This node is serving an older key…", nothing sent), (2) its record verifies with its maker
 * in today's roster, it is not stale, and its recipients are exactly today's roster (else this browser rotates first),
 * and (3) this browser holds its key (else it waits for another member's top-up and sends nothing meanwhile). Every key
 * this browser makes or hands out goes only to members the group's members list shows (review of #1788, findings 1–2),
 * and a top-up only to a recipient of that epoch's signed record (director's decision a).
 */
import {
    makeEpochRecord, openMyKey, verifyGroupEpochRecord, groupEpochCoversExactly, makeTopUp, GroupKeyNotVerifiedError,
    type GroupEpochProgress, type GroupEpochReason, type GroupEpochRecord, type GroupLineVerifyMemo, type GroupServedWrap,
} from './group-chat-crypto';
import { onAccountEpochEnd } from './account-epoch';

/** Exact words the chat shows: the phone's (provenance §7 rule 2; epochs-over-time §1, §5), "phone" said as "browser". */
export const GROUP_KEY_ROLLBACK_TEXT = 'This node is serving an older key than one this app already holds.';
export const GROUP_KEY_WAITING_TEXT = "Waiting for the group's next key.";
export const GROUP_KEY_MISSING_TEXT = "This chat's key hasn't reached this browser yet. Another member's app hands it over when they next open the chat.";
export const GROUP_KEYS_UNOPENABLE_TEXT = "This device can't open your keys.";
/** The node's keys roster names someone its members list doesn't show (review of #1788, finding 2). */
export const GROUP_KEY_ROSTER_TEXT = "This node says someone holds this chat's key who isn't in its members list. Nothing was sent.";
export const GROUP_KEY_ROSTER_UNREAD_TEXT = "This browser couldn't check who is in this group just now. Nothing was sent; try again in a moment.";
/** The lock store didn't read (confirmation 2 of #1788, finding 1): never taken as "never held". */
export const GROUP_KEY_STORE_UNREAD_TEXT = "This browser couldn't check this chat's keys just now. Nothing was sent; try again in a moment.";
export const GROUP_CHAT_NOT_MEMBER_TEXT = 'Only members of this group can open its chat';

export type GroupChatKeyErrorCode = 'rollback' | 'no_key' | 'unopenable' | 'not_member' | 'refused' | 'roster' | 'store';

/** Why this browser will not seal a line now; `message` is the sentence the chat shows. */
export class GroupChatKeyError extends Error {
    constructor(message: string, public code: GroupChatKeyErrorCode) {
        super(message);
        this.name = 'GroupChatKeyError';
    }
}

/** One epoch as this browser holds it for the page's life: the record as served (no wraps) and my wrap, as sent. */
export interface HeldGroupEpoch {
    epoch: number;
    record: GroupEpochRecord;
    wrap: GroupServedWrap | null;
}

/** What the web keeps of a group between visits: two facts, per identity and group, and nothing secret. */
export interface GroupLockState {
    highest: number;
    locked: boolean;
}

/**
 * Where the two facts are kept (IndexedDB in the browser, group-chat-lock-store.ts; memory in tests). The `key` each
 * call takes is this identity's public key, "/", the group's id. `load` THROWS when it can't read: the caller never
 * takes that as "nothing kept".
 */
export interface GroupLockStore {
    load(key: string): Promise<GroupLockState>;
    /** Store max(stored, epoch) and locked: the highest epoch never falls. */
    raiseHighest(key: string, epoch: number): Promise<void>;
    markLocked(key: string): Promise<void>;
}

/** A store in memory: for tests. */
export function memoryGroupLockStore(): GroupLockStore & { rows: Map<string, GroupLockState> } {
    const rows = new Map<string, GroupLockState>();
    const row = (k: string) => { let v = rows.get(k); if (!v) { v = { highest: 0, locked: false }; rows.set(k, v); } return v; };
    return {
        rows,
        async load(k) { const v = rows.get(k); return v ? { ...v } : { highest: 0, locked: false }; },
        async raiseHighest(k, epoch) { const v = row(k); v.highest = Math.max(v.highest, epoch); v.locked = true; },
        async markLocked(k) { row(k).locked = true; },
    };
}

/** How the keyring reaches the node: signed requests as this member (the web's lib/api.ts signedFetch). */
export interface GroupKeysTransport {
    get(path: string): Promise<Response>;
    post(path: string, body: unknown): Promise<Response>;
}

/** What GET /api/groups/:id/keys answers (engine/group-keys.ts getGroupKeys). */
interface KeysAnswer {
    current: number | null;
    stale: boolean;
    fromEpoch: number | null;
    roster: string[];
    epochs: (Omit<GroupEpochRecord, 'groupId' | 'wraps'> & { stale?: boolean })[];
    myWraps: GroupServedWrap[];
    more: boolean;
}

/** The chat's lock as the last sync left it. */
export interface GroupKeysState {
    current: number | null;
    stale: boolean;
    fromEpoch: number | null;
    /** The node's roster for this group's keys (active rows that are members of this node), sorted. For sealing only. */
    roster: string[];
}

/** A node's refusal, with its status, code and the extra fields a 409 carries (current, roster). */
export class GroupKeysRequestError extends Error {
    constructor(message: string, public status: number, public body: any) {
        super(message);
        this.name = 'GroupKeysRequestError';
    }
}

export async function answerOf(res: Response): Promise<any> {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new GroupKeysRequestError(body?.error || `The node answered ${res.status}.`, res.status, body);
    return body;
}

// Per page load, across every group: whether any wrap has opened under this identity (an AEAD failure is then the
// wrap's fault, not the identity's), and how many failed before one did (epochs-over-time §1).
let wrapOpenedThisSession = false;
let wrapFailuresBeforeAnyOpened = 0;

/** True when every wrap this browser tried failed to open and none ever opened: suspect the identity, refuse nothing. */
export function groupKeysLookUnopenable(): boolean {
    return !wrapOpenedThisSession && wrapFailuresBeforeAnyOpened > 0;
}

const HOLE_REFETCH_MS = 60_000;
/** `after` past any epoch: the keys answer's header (current, stale, fromEpoch, roster) with no records. */
const HEADER_ONLY = '?after=999999999';
const EPOCHS_PER_ASK = 100;

/** One group's keys in this browser. Get it with groupKeyring() so the opened keys are shared for the page's life. */
export class GroupKeyring {
    private keys = new Map<number, Uint8Array>();
    private epochs = new Map<number, HeldGroupEpoch>();
    private highest = 0;
    private locked = false;
    private loaded: Promise<void> | null = null;
    private verdicts = new Set<string>();
    private signers = new Map<string, string>();
    private lastHoleFetch = 0;
    /** Succession verdicts for this group's roster (line-display §4 2b): one walk per (member, former key) per load. */
    readonly successions = new Map<string, boolean>();
    /** Epochs whose record didn't verify: nothing under them opens, and no wrap of theirs is refused for it. */
    private badRecords = new Set<number>();
    /** The active members the screen shows (GET …/members), as last read here or handed in by the screen. */
    private shown: Set<string> | null = null;
    /** Each epoch's recipients by its signed record (…/keys/:epoch/wraps, digests re-derived): who may be topped up. */
    private recordRecipients = new Map<number, Set<string>>();
    /** Epochs this browser made and the node said it stored, not yet served back: a served record that verifies replaces one. */
    private unconfirmed = new Set<number>();
    /** Epochs whose refused record was asked for again this load (finding 7): once each. */
    private refetched = new Set<number>();
    state: GroupKeysState | null = null;

    /** What this group's two facts are kept under: this identity's key, then the group's (finding 8: never another's). */
    private readonly storeKey: string;
    private readonly base: string;

    constructor(public readonly groupId: string, private readonly net: GroupKeysTransport, private readonly identity: { publicKey: string; privateKey: string }, private readonly store: GroupLockStore) {
        this.storeKey = `${identity.publicKey}/${groupId}`;
        this.base = `/api/groups/${encodeURIComponent(groupId)}`;
    }

    /**
     * Read the two kept facts. A failed read is NOT remembered as "nothing kept" (confirmation 2 of #1788, finding 1): it
     * throws GroupChatKeyError('store') and the next call reads again.
     */
    private async ensureLoaded(): Promise<void> {
        if (!this.loaded) {
            const p = (async () => {
                let saved: GroupLockState;
                try {
                    saved = await this.store.load(this.storeKey);
                } catch {
                    throw new GroupChatKeyError(GROUP_KEY_STORE_UNREAD_TEXT, 'store');
                }
                this.highest = Math.max(this.highest, Number(saved?.highest) || 0);
                this.locked = this.locked || !!saved?.locked;
            })();
            this.loaded = p;
            p.catch(() => { if (this.loaded === p) this.loaded = null; });
        }
        return this.loaded;
    }

    /**
     * True once this browser has seen this group locked (its chat answer locked, an epoch verified, opened or made): the
     * chat is locked here for good, whatever a node says later (director's decision b). When the store can't be read,
     * true: a read failure never counts as "never held".
     */
    async seenLocked(): Promise<boolean> {
        try {
            await this.ensureLoaded();
        } catch {
            return true;
        }
        return this.seenLockedInMemory();
    }

    /** What this page has seen of the lock itself, whatever the store wrote (review of #1816, finding 4). */
    seenLockedInMemory(): boolean {
        return this.locked || this.highest > 0 || this.keys.size > 0 || [...this.epochs.values()].some((e) => !!e.wrap);
    }

    /** Remember that this browser has seen the group locked (its chat answer carried `encryption`). */
    async noteLocked(): Promise<void> {
        this.locked = true;
        await this.store.markLocked(this.storeKey).catch(() => { });
    }

    /** True if a record's maker is me or someone the screen shows as a member: only such a record raises the highest (finding 6). */
    private makerShown(record: GroupEpochRecord): boolean {
        return record.createdBy === this.identity.publicKey || !!this.shown?.has(record.createdBy);
    }

    /** True when the node's `current` is older than what this browser holds (rule 1; finding 5). */
    private rolledBack(current: number | null): boolean {
        return current === null ? (this.highest > 0 || this.keys.size > 0) : current < this.highest;
    }

    /** True if this browser may not make or take `epoch`: at or below the highest, or one it holds (finding 5). */
    refusesEpoch(epoch: number): boolean {
        if (epoch <= this.highest || this.keys.has(epoch)) return true;
        const held = this.epochs.get(epoch);
        return !!held && this.verifies(held.record, epoch);
    }

    private verifies(record: GroupEpochRecord, epoch: number): boolean {
        try { verifyGroupEpochRecord(record, { groupId: this.groupId, epoch }); return true; } catch { return false; }
    }

    /** The highest epoch this browser has verified or made (rule 1). Throws when the store can't be read. */
    async highestEpoch(): Promise<number> {
        await this.ensureLoaded();
        return this.highest;
    }

    private async raise(epoch: number): Promise<void> {
        if (epoch > this.highest) this.highest = epoch;
        this.locked = true;
        await this.store.raiseHighest(this.storeKey, epoch).catch(() => { });
    }

    /** The verify memo for this group's lines (core GroupLineVerifyMemo): memory only. */
    get memo(): GroupLineVerifyMemo {
        return { has: (k) => this.verdicts.has(k), add: (k) => { this.verdicts.add(k); } };
    }

    /** The first signer this load saw for a message id (line-display design §4 rule 3), and remember one. */
    signerSeen(messageId: string): string | undefined { return this.signers.get(messageId); }
    rememberSigner(messageId: string, signer: string): void {
        if (!this.signers.has(messageId)) this.signers.set(messageId, signer);
    }

    private servedRecord(e: KeysAnswer['epochs'][number]): GroupEpochRecord {
        return {
            groupId: this.groupId, epoch: e.epoch, reason: e.reason, subject: e.subject ?? null, createdBy: e.createdBy, createdAt: e.createdAt,
            keyCommit: e.keyCommit, membersDigest: e.membersDigest, wrapsDigest: e.wrapsDigest, sig: e.sig,
        };
    }

    private async fetchKeys(query: string): Promise<KeysAnswer> {
        return answerOf(await this.net.get(`${this.base}/keys${query}`));
    }

    private absorb(a: KeysAnswer): number[] {
        const wraps = new Map<number, GroupServedWrap>();
        for (const w of Array.isArray(a.myWraps) ? a.myWraps : []) wraps.set(w.epoch, w);
        const put: number[] = [];
        for (const e of Array.isArray(a.epochs) ? a.epochs : []) {
            const prev = this.epochs.get(e.epoch);
            const wrap = wraps.get(e.epoch) ?? null;
            const record = this.servedRecord(e);
            if (prev && sameRecord(prev.record, record)) this.unconfirmed.delete(e.epoch);
            else if (prev) {
                // A record is the maker's signed header and never changes. One that differs from the copy held is the
                // node's doing: the held copy stays, unless it doesn't verify, or this browser made it and the node never
                // served it back, and the served one does (review of #1788, findings 5 and 7).
                if (!((this.unconfirmed.has(e.epoch) || !this.verifies(prev.record, e.epoch)) && this.verifies(record, e.epoch))) continue;
                for (const held of [this.keys, this.recordRecipients]) held.delete(e.epoch);
                this.badRecords.delete(e.epoch);
                this.unconfirmed.delete(e.epoch);
                this.epochs.set(e.epoch, { epoch: e.epoch, record, wrap });
                put.push(e.epoch);
                continue;
            }
            const wrapChanged = JSON.stringify(prev?.wrap ?? null) !== JSON.stringify(wrap);
            if (prev && !wrapChanged) continue;
            if (wrapChanged && prev?.wrap && this.keys.has(e.epoch)) continue; // the key is already open from the old wrap
            this.epochs.set(e.epoch, { epoch: e.epoch, record, wrap: wrap ?? prev?.wrap ?? null });
            put.push(e.epoch);
        }
        return put;
    }

    /**
     * Bring this browser's copy up to the node for the epochs it needs (provenance §5.3: the web asks for `current` plus
     * the epochs of the lines it loaded, never every epoch since the group began): `wanted`, the node's current, and, at
     * most once a minute, the epochs this browser holds no wrap for (a top-up may have landed). Raises the highest epoch
     * to the current one when its record verifies, made by someone the screen shows. Throws the node's refusal.
     */
    async sync(wanted: readonly number[] = []): Promise<GroupKeysState> {
        await this.ensureLoaded().catch(() => { });
        const ask = new Set<number>(wanted.filter((e) => Number.isSafeInteger(e) && e >= 1 && !this.epochs.has(e)));
        if (this.state?.current && !this.epochs.has(this.state.current)) ask.add(this.state.current);
        const holes = [...this.epochs.values()].filter((e) => !e.wrap && !this.keys.has(e.epoch)).map((e) => e.epoch);
        if (holes.length && Date.now() - this.lastHoleFetch > HOLE_REFETCH_MS) {
            this.lastHoleFetch = Date.now();
            for (const h of holes) ask.add(h);
        }
        const list = [...ask].sort((x, y) => y - x).slice(0, EPOCHS_PER_ASK);
        let a = await this.fetchKeys(list.length ? `?epochs=${list.join(',')}` : HEADER_ONLY);
        this.absorb(a);
        if (a.current !== null && a.current !== undefined && !this.epochs.has(a.current)) {
            const head = a;
            a = await this.fetchKeys(`?epochs=${a.current}`);
            this.absorb(a);
            a = { ...a, current: head.current ?? a.current };
        }
        // The highest rises when a record verifies (rule 1): the current one, by its header, made by someone the screen
        // shows (finding 6).
        const top = a.current ?? 0;
        if (top > this.highest) {
            const rec = this.epochs.get(top)?.record;
            try {
                if (rec && this.makerShown(rec)) { verifyGroupEpochRecord(rec, { groupId: this.groupId, epoch: top }); await this.raise(top); }
            } catch { this.badRecords.add(top); }
        }
        this.state = { current: a.current ?? null, stale: !!a.stale, fromEpoch: a.fromEpoch ?? null, roster: Array.isArray(a.roster) ? a.roster : [] };
        return this.state;
    }

    /** The roster the screen shows (its active members' keys): what a recipient of a key this browser hands out must be in. */
    noteShownRoster(keys: readonly string[]): void {
        this.shown = new Set(keys);
    }

    /** Read the members list the screen shows (GET …/members, active rows): null when the node won't say. */
    private async readShownRoster(): Promise<Set<string> | null> {
        try {
            const rows = await answerOf(await this.net.get(`${this.base}/members`));
            if (!Array.isArray(rows)) return null;
            this.shown = new Set(rows.filter((m: any) => m?.status === 'active' && typeof m.memberPubkey === 'string').map((m: any) => m.memberPubkey as string));
            return this.shown;
        } catch {
            return null;
        }
    }

    /**
     * True if every recipient is someone the screen shows as an active member (finding 2; the design's limit a). ⊆, not
     * =: an honest node keeps a pruned account in the members list but not in the keys roster. `fresh` reads the list
     * now; otherwise the screen's copy is enough when it covers them. Null when the list can't be read.
     */
    async rosterShown(recipients: readonly string[], opts: { fresh?: boolean } = {}): Promise<boolean | null> {
        const covered = (shown: Set<string>) => recipients.every((k) => shown.has(k));
        if (!opts.fresh && this.shown && covered(this.shown)) return true;
        const shown = await this.readShownRoster();
        return shown ? covered(shown) : null;
    }

    private async requireRosterShown(recipients: readonly string[], fresh: boolean): Promise<void> {
        const ok = await this.rosterShown(recipients, { fresh });
        if (ok === null) throw new GroupChatKeyError(GROUP_KEY_ROSTER_UNREAD_TEXT, 'roster');
        if (!ok) throw new GroupChatKeyError(GROUP_KEY_ROSTER_TEXT, 'roster');
    }

    /**
     * Who an epoch's maker wrapped it to, by the record's signature: the recipients of its own wraps (unsigned, by its
     * maker; GET …/keys/:epoch/wraps) must be exactly the ones its signed membersDigest names. Null when they don't match
     * or can't be read. Top-ups are outside the record: a member they reached is not in it.
     */
    private async recipientsOf(epoch: number): Promise<Set<string> | null> {
        const known = this.recordRecipients.get(epoch);
        if (known) return known;
        const held = this.epochs.get(epoch);
        if (!held) return null;
        try {
            const a = await answerOf(await this.net.get(`${this.base}/keys/${epoch}/wraps`));
            const set = new Set<string>((Array.isArray(a?.wraps) ? a.wraps : [])
                .filter((w: any) => w && (w.sig === null || w.sig === undefined) && w.wrapper === held.record.createdBy && typeof w.recipient === 'string')
                .map((w: any) => w.recipient as string));
            verifyGroupEpochRecord(held.record, { groupId: this.groupId, epoch });
            if (!groupEpochCoversExactly(held.record, [...set])) return null;
            this.recordRecipients.set(epoch, set);
            return set;
        } catch {
            return null;
        }
    }

    /** The key for an epoch if it is already open (no work): what the line display reads synchronously. */
    openedKey(epoch: number): Uint8Array | undefined {
        return this.keys.get(epoch);
    }

    /** True if this browser holds a wrap for `epoch` it has not yet refused (it may not have opened it yet). */
    holdsWrap(epoch: number): boolean {
        return this.keys.has(epoch) || !!this.epochs.get(epoch)?.wrap;
    }

    /**
     * The key for `epoch`, opened now if need be (verify the record's signature, open my wrap, check the commitment):
     * null when this browser holds no wrap for it, or the wrap or record doesn't verify. A wrap that holds another key
     * than its record commits to is refused on the node at once; one that fails its AEAD only once another wrap has
     * opened under this identity in this load; when every wrap fails, nothing is refused (epochs-over-time §1).
     */
    async keyFor(epoch: number): Promise<Uint8Array | null> {
        const opened = this.keys.get(epoch);
        if (opened) return opened;
        const held = this.epochs.get(epoch);
        if (!held?.wrap) return null;
        if (this.badRecords.has(epoch)) return this.refetchRefused(epoch, held);
        try {
            const key = openMyKey(held.record, held.wrap, this.identity.privateKey, this.groupId);
            this.keys.set(epoch, key);
            wrapOpenedThisSession = true;
            if (this.makerShown(held.record)) await this.raise(epoch);
            else { this.locked = true; await this.store.markLocked(this.storeKey).catch(() => { }); }
            return key;
        } catch (e) {
            if (!(e instanceof GroupKeyNotVerifiedError)) throw e;
            const why = e.message;
            if (why.startsWith('Epoch record refused')) {
                this.badRecords.add(epoch);
                return this.refetchRefused(epoch, held);
            }
            const unambiguous = why.includes('commits to') || why.startsWith('Top-up refused') || why.startsWith('An unsigned wrap');
            if (unambiguous || wrapOpenedThisSession) await this.refuse(held);
            else wrapFailuresBeforeAnyOpened++;
            return null;
        }
    }

    /** A held record that doesn't verify is asked for again, once a load (finding 7). */
    private async refetchRefused(epoch: number, held: HeldGroupEpoch): Promise<Uint8Array | null> {
        if (this.refetched.has(epoch)) return null;
        this.refetched.add(epoch);
        try {
            this.absorb(await this.fetchKeys(`?epochs=${epoch}`));
        } catch {
            return null;
        }
        return this.epochs.get(epoch) !== held ? this.keyFor(epoch) : null;
    }

    /** Refuse my wrap for one epoch on the node (POST …/keys/:epoch/reject): the slot shows in `missing` again. */
    private async refuse(held: HeldGroupEpoch): Promise<void> {
        const wrap = held.wrap;
        if (!wrap) return;
        held.wrap = null;
        this.lastHoleFetch = 0;
        await this.net.post(`${this.base}/keys/${held.epoch}/reject`, { wrapper: wrap.wrapper, ephPub: wrap.ephPub }).catch(() => null);
    }

    private holdMade(record: GroupEpochRecord, key: Uint8Array): void {
        const mine = record.wraps!.find((w) => w.recipient === this.identity.publicKey)!;
        const { wraps: _wraps, ...served } = record;
        this.epochs.set(record.epoch, {
            epoch: record.epoch, record: served,
            wrap: { epoch: record.epoch, wrapper: this.identity.publicKey, ephPub: mine.ephPub, nonce: mine.nonce, wrapped: mine.wrapped, sig: null },
        });
        this.keys.set(record.epoch, key);
    }

    /** After the node stored an epoch this browser made: keep it, raise the highest, seal under it at once (rule 6). */
    async adopt(record: GroupEpochRecord, key: Uint8Array): Promise<void> {
        await this.ensureLoaded();
        if (this.refusesEpoch(record.epoch)) throw new GroupChatKeyError(GROUP_KEY_ROLLBACK_TEXT, 'rollback');
        this.holdMade(record, key);
        await this.raise(record.epoch);
        this.state = { current: record.epoch, stale: false, fromEpoch: this.state?.fromEpoch ?? null, roster: this.state?.roster ?? [] };
    }

    /** Make the next epoch for a rotation, wrapped to `recipients` (the maker among them). */
    private makeRecord(input: { epoch: number; reason: GroupEpochReason; recipients: string[] }, progress?: GroupEpochProgress) {
        return makeEpochRecord({
            myEdPrivHex: this.identity.privateKey, groupId: this.groupId, epoch: input.epoch, reason: input.reason,
            subject: null, createdAt: new Date().toISOString(), recipients: [...new Set(input.recipients)],
        }, progress);
    }

    /**
     * Rotate (§2.3, reason 'rotate', or 'start' for a chat with no epoch yet): a fresh key to exactly today's roster, and
     * only when every one of them is in the members list read just now. A 409 means this browser's roster or epoch was
     * old: once more after reading both again (never the 409's own roster).
     */
    async rotate(progress?: GroupEpochProgress): Promise<{ epoch: number; key: Uint8Array }> {
        let state = this.state ?? await this.sync();
        for (let attempt = 0; ; attempt++) {
            if (!state.roster.includes(this.identity.publicKey)) throw new GroupChatKeyError(GROUP_CHAT_NOT_MEMBER_TEXT, 'not_member');
            await this.requireRosterShown(state.roster, true);
            const epoch = (state.current ?? 0) + 1;
            if (this.rolledBack(state.current) || this.refusesEpoch(epoch)) throw new GroupChatKeyError(GROUP_KEY_ROLLBACK_TEXT, 'rollback');
            const { record, groupKey } = await this.makeRecord({ epoch, reason: epoch === 1 ? 'start' : 'rotate', recipients: state.roster }, progress);
            try {
                await answerOf(await this.net.post(`${this.base}/keys/epoch`, { epoch: record }));
                await this.adopt(record, groupKey);
                this.unconfirmed.add(epoch);
                return { epoch, key: groupKey };
            } catch (e) {
                if (attempt === 0 && e instanceof GroupKeysRequestError && e.status === 409 && e.body?.code === 'epoch_conflict') {
                    // A 409 naming an older current than this browser holds is a rollback, whatever a sync says next.
                    if (typeof e.body.current === 'number' ? e.body.current < this.highest : this.rolledBack(null)) {
                        throw new GroupChatKeyError(GROUP_KEY_ROLLBACK_TEXT, 'rollback');
                    }
                    state = await this.sync();
                    continue;
                }
                throw e;
            }
        }
    }

    /**
     * Which epoch to seal under, and its key (provenance §7 rules 1–3, 6). Syncs first. Throws GroupChatKeyError with the
     * sentence the chat shows when nothing may be sent; a store that can't be read refuses ('store').
     */
    async prepareToSeal(progress?: GroupEpochProgress): Promise<{ epoch: number; key: Uint8Array }> {
        await this.ensureLoaded();
        const state = await this.sync();
        if (this.rolledBack(state.current)) throw new GroupChatKeyError(GROUP_KEY_ROLLBACK_TEXT, 'rollback');
        // Whoever the line goes to must be in the members list the screen shows (finding 2), sealed or rotated.
        await this.requireRosterShown(state.roster, false);
        if (state.current === null) return this.rotate(progress);
        const held = this.epochs.get(state.current);
        let fits = !state.stale && !!held && !this.badRecords.has(state.current);
        if (fits && held) {
            try {
                // Today's roster, for the epoch about to be sealed under only: its maker must be in it, and it must
                // cover exactly it (a member added, removed or gone without a rotation means a new key first).
                verifyGroupEpochRecord(held.record, { groupId: this.groupId, epoch: state.current, activeMembers: state.roster });
                fits = groupEpochCoversExactly(held.record, state.roster);
            } catch {
                fits = false;
            }
        }
        if (!fits) return this.rotate(progress);
        await this.raise(state.current);
        const key = await this.keyFor(state.current);
        if (!key) {
            if (groupKeysLookUnopenable()) throw new GroupChatKeyError(GROUP_KEYS_UNOPENABLE_TEXT, 'unopenable');
            throw new GroupChatKeyError(GROUP_KEY_MISSING_TEXT, 'no_key');
        }
        return { epoch: state.current, key };
    }

    /**
     * Hand keys I hold to members who lack them (GET …/keys/missing, POST …/keys/wrap; §2.5): newest epochs first, at
     * most `max` per call. `missing` is the node's word, so a key goes only to someone the screen shows as a member AND
     * whom that epoch's maker wrapped it to, by the record's signature (finding 1; director's decision a): a junk wrap's
     * repair. A newcomer is never handed an epoch from before them, and a re-keyed member's new key is in no old record.
     */
    async serveMissing(max = 10): Promise<number> {
        let answer: { missing?: { pubkey: string; epochs: number[] }[] };
        try {
            answer = await answerOf(await this.net.get(`${this.base}/keys/missing`));
        } catch {
            return 0;
        }
        if (!(answer.missing ?? []).some((m) => m?.pubkey !== this.identity.publicKey)) return 0;
        const wanted = (answer.missing ?? []).flatMap((m) => m.epochs ?? []).filter((e) => !this.epochs.has(e));
        if (wanted.length) await this.sync(wanted).catch(() => null);
        const shown = await this.readShownRoster();
        if (!shown) return 0;
        let sent = 0;
        for (const m of answer.missing ?? []) {
            if (m.pubkey === this.identity.publicKey || !shown.has(m.pubkey)) continue;
            for (const epoch of [...(m.epochs ?? [])].sort((x, y) => y - x)) {
                if (sent >= max) return sent;
                const key = await this.keyFor(epoch);
                if (!key) continue;
                if (!(await this.recipientsOf(epoch))?.has(m.pubkey)) continue;
                const t = makeTopUp(key, { myEdPrivHex: this.identity.privateKey, groupId: this.groupId, epoch, recipientPubHex: m.pubkey });
                const res = await this.net.post(`${this.base}/keys/wrap`,
                    { epoch, recipient: t.recipient, ephPub: t.ephPub, nonce: t.nonce, wrapped: t.wrapped, sig: t.sig }).catch(() => null);
                if (res?.status === 201) sent++;
                else if (res?.status === 429) return sent;
                // 409 wrap_exists / wrap_rejected, 403, 404: this slot is not mine to fill; the loop moves on.
            }
        }
        return sent;
    }
}

/** Two copies of an epoch record's signed header are the same record. */
function sameRecord(a: Omit<GroupEpochRecord, 'wraps'>, b: Omit<GroupEpochRecord, 'wraps'>): boolean {
    return a.epoch === b.epoch && a.reason === b.reason && (a.subject ?? null) === (b.subject ?? null) && a.createdBy === b.createdBy
        && a.createdAt === b.createdAt && a.keyCommit === b.keyCommit && a.membersDigest === b.membersDigest
        && a.wrapsDigest === b.wrapsDigest && a.sig === b.sig;
}

const keyrings = new Map<string, GroupKeyring>();

/** The keyring for one group for this identity, shared for the page's life (the opened keys with it). */
export function groupKeyring(net: GroupKeysTransport, identity: { publicKey: string; privateKey: string }, groupId: string, store: GroupLockStore): GroupKeyring {
    const id = `${identity.publicKey}|${groupId}`;
    let k = keyrings.get(id);
    if (!k) { k = new GroupKeyring(groupId, net, identity, store); keyrings.set(id, k); }
    return k;
}

/** The groups this page's keyrings have seen locked for this identity (lib/group-hold.ts asks them with the store). */
export function groupsSeenLockedInMemory(identityPub: string): string[] {
    const out: string[] = [];
    for (const [id, ring] of keyrings) {
        const bar = id.indexOf('|');
        if (id.slice(0, bar) === identityPub && ring.seenLockedInMemory()) out.push(id.slice(bar + 1));
    }
    return out;
}

/** Sign-out, another identity: every opened key leaves memory, and this load's wrap tally. */
export function forgetGroupKeys(): void {
    keyrings.clear();
    wrapOpenedThisSession = false;
    wrapFailuresBeforeAnyOpened = 0;
}

// A Sign Out in another tab of this web address: this tab's opened keys go too (review of #1816, finding 8).
onAccountEpochEnd((end) => { if (end === 'signed-out') forgetGroupKeys(); });
