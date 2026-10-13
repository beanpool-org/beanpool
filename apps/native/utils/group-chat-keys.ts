/**
 * group-chat-keys — a group chat's keys on the phone (group chats slice 3).
 *
 * Designs (all decided by Marty): scratch/global-node/DESIGN-group-chat-encryption-fable.md §2–§4, §14.3, §15;
 * DESIGN-group-chat-wrap-provenance-fable.md §7 (which epoch to seal under) and §10 (old epochs verified lazily);
 * DESIGN-group-chat-epochs-over-time-fable.md §1 (when to refuse a wrap) and §2 (no roster on reads).
 *
 * What the phone keeps, per node and group: each epoch's record as the node served it (no wraps) and MY wrap for it, both
 * exactly as sent (ciphertext; nothing secret), the highest epoch it has verified or made (it never falls), and the
 * verdicts of line signatures it has verified (hashes). Opened epoch keys live in memory only, for the app's session,
 * and are opened from the wraps with the seed in SecureStore when a line under them is first shown (§4; provenance §10
 * pick 2). Nothing here trusts a node-served roster for reading: a record is opened by its signature and its key
 * commitment alone. Today's roster is used once, by the member about to seal (rule 3), and to build a new epoch.
 *
 * Which epoch a line goes under (provenance §7): the node's current one, and only when (1) it is not below the highest
 * this phone holds (else "This node is serving an older key…", nothing sent), (2) its record verifies with its maker in
 * today's roster, it is not stale, and its recipients are exactly today's roster (else this phone rotates first), and
 * (3) this phone holds its key (else it waits for another member's top-up and sends nothing meanwhile). After a rotation
 * it made, it seals under that one at once.
 */
import type { BeanPoolIdentity } from './identity';
import { signedGet, signedPost } from './node-post';
import {
    makeEpochRecord, openMyKey, verifyGroupEpochRecord, groupEpochCoversExactly, makeTopUp, GroupKeyNotVerifiedError, verifiedFormerKeys, servedChain,
    type GroupEpochProgress, type GroupEpochReason, type GroupEpochRecord, type GroupLineVerifyMemo, type GroupServedWrap,
} from './group-chat-crypto';

/** Exact words the chat shows (provenance §7 rule 2; epochs-over-time §1, §5). */
export const GROUP_KEY_ROLLBACK_TEXT = 'This node is serving an older key than one this app already holds.';
export const GROUP_KEY_WAITING_TEXT = "Waiting for the group's next key.";
export const GROUP_KEY_MISSING_TEXT = "This chat's key hasn't reached this phone yet. Another member's phone hands it over when they next open the chat.";
export const GROUP_KEYS_UNOPENABLE_TEXT = "This device can't open your keys.";
/** The node's keys roster names someone its members list doesn't show (review of #1788, finding 2). */
export const GROUP_KEY_ROSTER_TEXT = "This node says someone holds this chat's key who isn't in its members list. Nothing was sent.";
export const GROUP_KEY_ROSTER_UNREAD_TEXT = "This phone couldn't check who is in this group just now. Nothing was sent; try again in a moment.";
/**
 * What this phone keeps of a group's keys couldn't be read (a SQLite error, or the file of a community it has since
 * switched from): nothing is sent, and it is never taken for "never held" (confirmation 2 of #1788, finding 1).
 */
export const GROUP_KEY_STORE_UNREAD_TEXT = "This phone couldn't check this chat's keys just now. Nothing was sent; try again in a moment.";

export type GroupChatKeyErrorCode = 'rollback' | 'no_key' | 'unopenable' | 'not_member' | 'refused' | 'roster' | 'store';

/** Why this phone will not seal a line now; `message` is the sentence the chat shows. */
export class GroupChatKeyError extends Error {
    constructor(message: string, public code: GroupChatKeyErrorCode) {
        super(message);
        this.name = 'GroupChatKeyError';
    }
}

/** One epoch as this phone keeps it: the record as served (no wraps) and my wrap, exactly as the node sent them. */
export interface StoredGroupEpoch {
    epoch: number;
    record: GroupEpochRecord;
    wrap: GroupServedWrap | null;
}

/**
 * Where a group's keys are kept between sessions (SQLite on the phone, utils/group-chat-store.ts; memory in tests). The
 * `groupId` each call takes is the keyring's key for the rows: this identity's public key, "/", the group's id.
 */
export interface GroupKeyStore {
    load(groupId: string): Promise<{ epochs: StoredGroupEpoch[]; highest: number; after: number }>;
    putEpochs(groupId: string, epochs: StoredGroupEpoch[]): Promise<void>;
    setCursor(groupId: string, after: number): Promise<void>;
    /** Store max(stored, epoch): the highest epoch never falls. */
    raiseHighest(groupId: string, epoch: number): Promise<void>;
    dropWrap(groupId: string, epoch: number): Promise<void>;
    loadVerdicts(groupId: string): Promise<string[]>;
    addVerdict(groupId: string, key: string): Promise<void>;
    loadSigners(groupId: string): Promise<[string, string][]>;
    /** The first signer seen for a message id; never overwritten (an edit is compared with it). */
    putSigner(groupId: string, messageId: string, signer: string): Promise<void>;
}

/** A store in memory: for tests, and the phone's fallback when SQLite can't be opened. */
export function memoryGroupKeyStore(): GroupKeyStore {
    const groups = new Map<string, { epochs: Map<number, StoredGroupEpoch>; highest: number; after: number; verdicts: Set<string>; signers: Map<string, string> }>();
    const g = (id: string) => {
        let v = groups.get(id);
        if (!v) { v = { epochs: new Map(), highest: 0, after: 0, verdicts: new Set(), signers: new Map() }; groups.set(id, v); }
        return v;
    };
    return {
        async load(id) { const v = g(id); return { epochs: [...v.epochs.values()].map((e) => ({ ...e })), highest: v.highest, after: v.after }; },
        async putEpochs(id, epochs) { const v = g(id); for (const e of epochs) v.epochs.set(e.epoch, { ...e }); },
        async setCursor(id, after) { g(id).after = Math.max(g(id).after, after); },
        async raiseHighest(id, epoch) { g(id).highest = Math.max(g(id).highest, epoch); },
        async dropWrap(id, epoch) { const e = g(id).epochs.get(epoch); if (e) e.wrap = null; },
        async loadVerdicts(id) { return [...g(id).verdicts]; },
        async addVerdict(id, key) { g(id).verdicts.add(key); },
        async loadSigners(id) { return [...g(id).signers.entries()]; },
        async putSigner(id, messageId, signer) { const s = g(id).signers; if (!s.has(messageId)) s.set(messageId, signer); },
    };
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

async function answerOf(res: Response): Promise<any> {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new GroupKeysRequestError(body?.error || `The node answered ${res.status}.`, res.status, body);
    return body;
}

// Per app session, across every group: whether any wrap has opened under this identity (an AEAD failure is then the
// wrap's fault, not the identity's), and how many failed before one did (epochs-over-time §1, phone rule).
let wrapOpenedThisSession = false;
let wrapFailuresBeforeAnyOpened = 0;

/** True when every wrap this phone tried failed to open and none ever opened: suspect the identity, refuse nothing. */
export function groupKeysLookUnopenable(): boolean {
    return !wrapOpenedThisSession && wrapFailuresBeforeAnyOpened > 0;
}

/** For tests: a fresh app session. */
export function _resetGroupKeySessionForTests(): void {
    wrapOpenedThisSession = false;
    wrapFailuresBeforeAnyOpened = 0;
    keyrings.clear();
}

const HOLE_REFETCH_MS = 60_000;

/** One group's keys on this phone. Get it with groupKeyring() so the opened keys are shared for the session. */
export class GroupKeyring {
    private keys = new Map<number, Uint8Array>();
    private epochs = new Map<number, StoredGroupEpoch>();
    private highest = 0;
    private after = 0;
    private loading: Promise<void> | null = null;
    private verdicts = new Set<string>();
    private signers = new Map<string, string>();
    private lastHoleFetch = 0;
    /** Succession verdicts for this group's roster (line-display §4 2b): one walk per (member, former key) per session. */
    readonly successions = new Map<string, boolean>();
    /** Epochs whose record didn't verify: nothing under them opens, and no wrap of theirs is refused for it. */
    private badRecords = new Set<number>();
    /** The active members the screen shows (GET …/members), as last read here or handed in by the screen. */
    private shown: Set<string> | null = null;
    /**
     * Each shown member's former keys this phone has verified (core walkKeySuccession over the row's `formerKeys`): a
     * chain their current key signed, never the node's `rekeyed_to` (line-display design §4 2b, §5). Read with the list.
     * A claim is only the claimant's word, so a key that is this phone's, a shown member's current key, or one two shown
     * members claim is nobody's former key here (review of #1826, finding 1 and NB3). Used only to complete an old
     * epoch's recipients to its signed set (recipientsOf), so other members' slots can be repaired after a re-key: no key
     * is ever handed to a member through it.
     */
    private formerOf = new Map<string, string[]>();
    /** Each row's verified chain, by (member, the chain as served): one walk per chain while the keyring lives (NB8). */
    private chainWalks = new Map<string, string[]>();
    /** Each epoch's recipients by its signed record (…/keys/:epoch/wraps, digests re-derived): who may be topped up. */
    private recordRecipients = new Map<number, Set<string>>();
    /** Epochs this phone made and the node said it stored, not yet served back: a served record that verifies replaces one. */
    private unconfirmed = new Set<number>();
    /** Epochs whose refused record was asked for again this session (finding 7): once each. */
    private refetched = new Set<number>();
    state: GroupKeysState | null = null;

    /**
     * What this group's rows are kept under: this identity's, then the group's. Another identity on this phone (a sign-in
     * after a sign-out, a new one) never reads or extends them (review of #1788, finding 8).
     */
    private readonly storeKey: string;

    constructor(public readonly groupId: string, private readonly nodeUrl: string, private readonly identity: Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>, private readonly store: GroupKeyStore) {
        this.storeKey = `${identity.publicKey}/${groupId}`;
    }

    /**
     * Read what this phone keeps of the group, once per session. A read that fails is never remembered: it throws
     * GROUP_KEY_STORE_UNREAD_TEXT ('store') to the caller, so every send and edit refuses, and the next call reads again.
     * Taken for "nothing stored", one SQLite error would make a held group look never held for the rest of the session,
     * and its next line go out readable (confirmation 2 of #1788, finding 1).
     */
    private ensureLoaded(): Promise<void> {
        if (!this.loading) {
            const loading = (async () => {
                let saved: { epochs: StoredGroupEpoch[]; highest: number; after: number };
                let verdicts: string[];
                let signers: [string, string][];
                try {
                    saved = await this.store.load(this.storeKey);
                    verdicts = await this.store.loadVerdicts(this.storeKey);
                    signers = await this.store.loadSigners(this.storeKey);
                } catch (e: any) {
                    console.warn('[GroupKeys] could not read this group\'s keys on the phone:', e?.message || e);
                    throw new GroupChatKeyError(GROUP_KEY_STORE_UNREAD_TEXT, 'store');
                }
                for (const e of saved.epochs) this.epochs.set(e.epoch, e);
                this.highest = Math.max(this.highest, saved.highest);
                this.after = Math.max(this.after, saved.after);
                for (const k of verdicts) this.verdicts.add(k);
                for (const [id, s] of signers) this.signers.set(id, s);
            })();
            this.loading = loading;
            loading.catch(() => { if (this.loading === loading) this.loading = null; });
        }
        return this.loading;
    }

    /**
     * True once this phone has held a key of this group (an epoch verified, opened or made): the chat is locked here for
     * good, whatever a node says later (review of #1788, finding 4; director's decision b).
     */
    async seenLocked(): Promise<boolean> {
        await this.ensureLoaded();
        return this.highest > 0 || this.keys.size > 0 || [...this.epochs.values()].some((e) => !!e.wrap);
    }

    /**
     * True if a record's maker is this phone or someone the screen shows as a member: only such a record raises the
     * highest epoch. Any key can sign a record, and a raise is for good, so one the node made would stop this phone
     * sending in the group ever again (review of #1788, finding 6). Reading still needs no roster.
     */
    private makerShown(record: GroupEpochRecord): boolean {
        return record.createdBy === this.identity.publicKey || !!this.shown?.has(record.createdBy);
    }

    /**
     * True when the node's `current` is older than what this phone holds (provenance §7 rule 1): below the highest, or
     * none at all once this phone has held a key of the group (a node that came back without its key tables). Nothing is
     * made or sealed then (review of #1788, finding 5).
     */
    private rolledBack(current: number | null): boolean {
        return current === null ? (this.highest > 0 || this.keys.size > 0) : current < this.highest;
    }

    /** True if this phone may not make or take `epoch`: at or below the highest, or one it holds (finding 5). */
    refusesEpoch(epoch: number): boolean {
        if (epoch <= this.highest || this.keys.has(epoch)) return true;
        const held = this.epochs.get(epoch);
        return !!held && this.verifies(held.record, epoch);
    }

    private verifies(record: GroupEpochRecord, epoch: number): boolean {
        try { verifyGroupEpochRecord(record, { groupId: this.groupId, epoch }); return true; } catch { return false; }
    }

    /** The highest epoch this phone has verified or made (provenance §7 rule 1). */
    async highestEpoch(): Promise<number> {
        await this.ensureLoaded();
        return this.highest;
    }

    private async raise(epoch: number): Promise<void> {
        if (epoch > this.highest) this.highest = epoch;
        await this.store.raiseHighest(this.storeKey, epoch).catch(() => { });
    }

    /** The verify memo for this group's lines (core GroupLineVerifyMemo): in memory, each new verdict written behind. */
    get memo(): GroupLineVerifyMemo {
        return {
            has: (k) => this.verdicts.has(k),
            add: (k) => { this.verdicts.add(k); this.store.addVerdict(this.storeKey, k).catch(() => { }); },
        };
    }

    /** The first signer this phone saw for a message id (line-display design §4 rule 3), and remember one. */
    signerSeen(messageId: string): string | undefined { return this.signers.get(messageId); }
    rememberSigner(messageId: string, signer: string): void {
        if (this.signers.has(messageId)) return;
        this.signers.set(messageId, signer);
        this.store.putSigner(this.storeKey, messageId, signer).catch(() => { });
    }

    private servedRecord(e: KeysAnswer['epochs'][number]): GroupEpochRecord {
        return {
            groupId: this.groupId, epoch: e.epoch, reason: e.reason, subject: e.subject ?? null, createdBy: e.createdBy, createdAt: e.createdAt,
            keyCommit: e.keyCommit, membersDigest: e.membersDigest, wrapsDigest: e.wrapsDigest, sig: e.sig,
        };
    }

    private async fetchKeys(query: string): Promise<KeysAnswer> {
        return answerOf(await signedGet(this.nodeUrl, `/api/groups/${encodeURIComponent(this.groupId)}/keys${query}`, this.identity as BeanPoolIdentity));
    }

    private async absorb(a: KeysAnswer): Promise<number[]> {
        const wraps = new Map<number, GroupServedWrap>();
        for (const w of Array.isArray(a.myWraps) ? a.myWraps : []) wraps.set(w.epoch, w);
        const put: StoredGroupEpoch[] = [];
        for (const e of Array.isArray(a.epochs) ? a.epochs : []) {
            const prev = this.epochs.get(e.epoch);
            const wrap = wraps.get(e.epoch) ?? null;
            const record = this.servedRecord(e);
            if (prev && sameRecord(prev.record, record)) this.unconfirmed.delete(e.epoch);
            else if (prev) {
                // A record is the maker's signed header and never changes. One that differs from the copy this phone
                // holds is the node's doing: the held copy stays, unless it doesn't verify, or this phone made it and
                // the node never served it back, and the served one does (review of #1788, findings 5 and 7).
                if (!((this.unconfirmed.has(e.epoch) || !this.verifies(prev.record, e.epoch)) && this.verifies(record, e.epoch))) continue;
                for (const held of [this.keys, this.recordRecipients]) held.delete(e.epoch);
                this.badRecords.delete(e.epoch);
                this.unconfirmed.delete(e.epoch);
                const next: StoredGroupEpoch = { epoch: e.epoch, record, wrap };
                this.epochs.set(e.epoch, next);
                put.push(next);
                continue;
            }
            const wrapChanged = JSON.stringify(prev?.wrap ?? null) !== JSON.stringify(wrap);
            if (prev && !wrapChanged) continue;
            if (wrapChanged && prev?.wrap && this.keys.has(e.epoch)) continue; // the key is already open from the old wrap
            const next: StoredGroupEpoch = { epoch: e.epoch, record, wrap: wrap ?? prev?.wrap ?? null };
            this.epochs.set(e.epoch, next);
            put.push(next);
        }
        if (put.length) await this.store.putEpochs(this.storeKey, put).catch(() => { });
        return put.map((e) => e.epoch);
    }

    /**
     * Bring this phone's copy up to the node: new epochs since the last sync (`?after`), and, at most once a minute, the
     * epochs this phone holds no wrap for (a top-up may have landed). Raises the highest epoch to the newest record that
     * verifies. Throws the node's refusal (GroupKeysRequestError).
     */
    async sync(): Promise<GroupKeysState> {
        await this.ensureLoaded();
        let a: KeysAnswer;
        let newest = 0;
        let guard = 0;
        do {
            a = await this.fetchKeys(`?after=${this.after}`);
            await this.absorb(a);
            const top = (a.epochs || []).reduce((m, e) => Math.max(m, e.epoch), 0);
            if (top > this.after) { this.after = top; await this.store.setCursor(this.storeKey, top).catch(() => { }); }
            newest = Math.max(newest, top);
        } while (a.more && ++guard < 50);
        const from = a.fromEpoch;
        const holes = [...this.epochs.values()].filter((e) => !e.wrap && (from === null || e.epoch >= from) && !this.keys.has(e.epoch)).map((e) => e.epoch);
        if (holes.length && Date.now() - this.lastHoleFetch > HOLE_REFETCH_MS) {
            this.lastHoleFetch = Date.now();
            await this.absorb(await this.fetchKeys(`?epochs=${holes.slice(-100).join(',')}`)).catch(() => { });
        }
        // The highest rises when a record verifies (rule 1): the newest one this phone has, by its header, made by someone
        // the screen shows (finding 6).
        const top = Math.max(newest, a.current ?? 0);
        if (top > this.highest) {
            const rec = this.epochs.get(top)?.record;
            try {
                if (rec && this.makerShown(rec)) { verifyGroupEpochRecord(rec, { groupId: this.groupId, epoch: top }); await this.raise(top); }
            } catch { this.badRecords.add(top); }
        }
        this.state = { current: a.current ?? null, stale: !!a.stale, fromEpoch: a.fromEpoch ?? null, roster: Array.isArray(a.roster) ? a.roster : [] };
        return this.state;
    }

    /** The roster the screen shows (its active members' keys): what a recipient of a key this phone hands out must be in. */
    noteShownRoster(keys: readonly string[]): void {
        this.shown = new Set(keys);
    }

    /** Read the members list the screen shows (GET …/members, active rows): null when the node won't say. */
    private async readShownRoster(): Promise<Set<string> | null> {
        try {
            const rows = await answerOf(await signedGet(this.nodeUrl, `/api/groups/${encodeURIComponent(this.groupId)}/members`, this.identity as BeanPoolIdentity));
            if (!Array.isArray(rows)) return null;
            const active = rows.filter((m: any) => m?.status === 'active' && typeof m.memberPubkey === 'string');
            const shown = new Set<string>(active.map((m: any) => m.memberPubkey as string));
            this.shown = shown;
            const claimed = new Map<string, string[]>();
            const claims = new Map<string, number>();
            for (const m of active) {
                const verified = this.walkedChain(m.memberPubkey, m.formerKeys);
                if (verified.length === 0) continue;
                claimed.set(m.memberPubkey, verified);
                for (const k of verified) claims.set(k, (claims.get(k) ?? 0) + 1);
            }
            this.formerOf = new Map();
            for (const [current, verified] of claimed) {
                const kept = verified.filter((k) => k !== this.identity.publicKey && !shown.has(k) && claims.get(k) === 1);
                if (kept.length > 0) this.formerOf.set(current, kept);
            }
            return shown;
        } catch {
            return null;
        }
    }

    /**
     * A row's verified former keys (verifiedFormerKeys over servedChain), walked once per (member, chain) while this
     * keyring lives. Keyed by the chain's walkable entries only, so a node serving junk can't grow this (NB5).
     */
    private walkedChain(member: string, formerKeys: unknown): string[] {
        const { chain, id: chainId } = servedChain(formerKeys);
        if (member.length !== 64 || chain.length === 0) return [];
        const id = `${member}|${chainId}`;
        let verified = this.chainWalks.get(id);
        if (!verified) {
            if (this.chainWalks.size >= 4096) this.chainWalks.clear();
            verified = verifiedFormerKeys({ memberPubkey: member, formerKeys: chain });
            this.chainWalks.set(id, verified);
        }
        return verified;
    }

    /**
     * True if every recipient is someone the screen shows as an active member (or one of `extra`: the member a change is
     * about). The keys roster and a 409's are the node's word; the members list is what everyone in the group sees, so
     * a recipient nobody can see is never wrapped to (review of #1788, finding 2; the design's limit a). ⊆, not =: an
     * honest node keeps a pruned account in the members list but not in the keys roster. `fresh` reads the list now;
     * otherwise the screen's copy is enough when it covers them. Null when the list can't be read.
     */
    async rosterShown(recipients: readonly string[], opts: { extra?: readonly (string | null)[]; fresh?: boolean } = {}): Promise<boolean | null> {
        const extra = new Set((opts.extra ?? []).filter((k): k is string => !!k));
        const covered = (shown: Set<string>) => recipients.every((k) => shown.has(k) || extra.has(k));
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
     * maker; GET …/keys/:epoch/wraps) must be exactly the ones its signed membersDigest names. Not its wrapsDigest: a wrap
     * the node spoiled still names its recipient, and repairing that slot is what a top-up is for. Null when they don't
     * match or can't be read. Top-ups are outside the record: a member they reached is not in it.
     *
     * A re-key drops the old key's wraps on the node (dropGroupWrapsOf), so a re-keyed member's old key is missing from
     * them (review of #1788, NB2). The set is completed from shown members' verified former keys, at most one per member
     * (a member held one key at a time), and is taken only if the completed set is exactly the signed one.
     */
    private async recipientsOf(epoch: number): Promise<Set<string> | null> {
        const known = this.recordRecipients.get(epoch);
        if (known) return known;
        const stored = this.epochs.get(epoch);
        if (!stored) return null;
        try {
            const a = await answerOf(await signedGet(this.nodeUrl, `/api/groups/${encodeURIComponent(this.groupId)}/keys/${epoch}/wraps`, this.identity as BeanPoolIdentity));
            const set = new Set<string>((Array.isArray(a?.wraps) ? a.wraps : [])
                .filter((w: any) => w && (w.sig === null || w.sig === undefined) && w.wrapper === stored.record.createdBy && typeof w.recipient === 'string')
                .map((w: any) => w.recipient as string));
            verifyGroupEpochRecord(stored.record, { groupId: this.groupId, epoch });
            const exact = groupEpochCoversExactly(stored.record, [...set]) ? set : this.completedBySuccession(stored.record, set);
            if (!exact) return null;
            this.recordRecipients.set(epoch, exact);
            return exact;
        } catch {
            return null;
        }
    }

    /**
     * The record's own wraps' recipients plus, for some shown members whose key is not among them, one of their verified
     * former keys each: the first such set the signed membersDigest names, or null. Smallest completions first (one
     * member's key, then two members', …), so the usual case, one re-key, costs at most one try per verified former key
     * whatever the roster's order (review of #1826, NB7). Tries at most 256 sets.
     */
    private completedBySuccession(record: GroupEpochRecord, set: Set<string>): Set<string> | null {
        const choices = [...this.formerOf.entries()]
            .filter(([current, former]) => !set.has(current) && !former.some((k) => set.has(k)))
            .map(([, former]) => former);
        let tried = 0;
        const pick = (from: number, left: number, chosen: string[]): Set<string> | null => {
            if (left === 0) {
                tried++;
                const candidate = new Set([...set, ...chosen]);
                return groupEpochCoversExactly(record, [...candidate]) ? candidate : null;
            }
            for (let i = from; i <= choices.length - left; i++) {
                for (const k of choices[i]) {
                    if (tried >= 256) return null;
                    const found = pick(i + 1, left - 1, [...chosen, k]);
                    if (found) return found;
                }
            }
            return null;
        };
        for (let size = 1; size <= choices.length && tried < 256; size++) {
            const found = pick(0, size, []);
            if (found) return found;
        }
        return null;
    }

    /** The key for an epoch if it is already open (no work): what the line display reads synchronously. */
    openedKey(epoch: number): Uint8Array | undefined {
        return this.keys.get(epoch);
    }

    /** True if this phone holds a wrap for `epoch` it has not yet refused (it may not have opened it yet). */
    holdsWrap(epoch: number): boolean {
        return this.keys.has(epoch) || !!this.epochs.get(epoch)?.wrap;
    }

    /**
     * The key for `epoch`, opened now if need be (verify the record's signature, open my wrap, check the commitment):
     * null when this phone holds no wrap for it, or the wrap or record doesn't verify. A wrap that holds another key than
     * its record commits to is refused on the node at once; one that fails its AEAD is refused only once another wrap
     * has opened under this identity in this session; when every wrap fails, nothing is refused (epochs-over-time §1).
     */
    async keyFor(epoch: number): Promise<Uint8Array | null> {
        await this.ensureLoaded();
        const held = this.keys.get(epoch);
        if (held) return held;
        const stored = this.epochs.get(epoch);
        if (!stored?.wrap) return null;
        if (this.badRecords.has(epoch)) return this.refetchRefused(epoch, stored);
        try {
            const key = openMyKey(stored.record, stored.wrap, this.identity.privateKey, this.groupId);
            this.keys.set(epoch, key);
            wrapOpenedThisSession = true;
            if (this.makerShown(stored.record)) await this.raise(epoch);
            return key;
        } catch (e) {
            if (!(e instanceof GroupKeyNotVerifiedError)) throw e;
            const why = e.message;
            if (why.startsWith('Epoch record refused')) {
                // The record itself is bad: the node served a header its maker didn't sign. Not the wrap's fault.
                this.badRecords.add(epoch);
                return this.refetchRefused(epoch, stored);
            }
            const unambiguous = why.includes('commits to') || why.startsWith('Top-up refused') || why.startsWith('An unsigned wrap');
            if (unambiguous || wrapOpenedThisSession) await this.refuse(stored);
            else wrapFailuresBeforeAnyOpened++;
            return null;
        }
    }

    /**
     * A held record that doesn't verify is asked for again, once a session: `?after` has moved past it, and a record that
     * verifies replaces it (absorb), so one bad answer never shuts an epoch on this phone for good (review of #1788,
     * finding 7). Opens the key from the new copy when there is one.
     */
    private async refetchRefused(epoch: number, stored: StoredGroupEpoch): Promise<Uint8Array | null> {
        if (this.refetched.has(epoch)) return null;
        this.refetched.add(epoch);
        try {
            await this.absorb(await this.fetchKeys(`?epochs=${epoch}`));
        } catch {
            return null;
        }
        return this.epochs.get(epoch) !== stored ? this.keyFor(epoch) : null;
    }

    /** Refuse my wrap for one epoch on the node (POST …/keys/:epoch/reject): the slot shows in `missing` again. */
    private async refuse(stored: StoredGroupEpoch): Promise<void> {
        const wrap = stored.wrap;
        if (!wrap) return;
        stored.wrap = null;
        // The next sync asks for this epoch again at once: another member's top-up may already be there.
        this.lastHoleFetch = 0;
        await this.store.dropWrap(this.storeKey, stored.epoch).catch(() => { });
        await signedPost(this.nodeUrl, `/api/groups/${encodeURIComponent(this.groupId)}/keys/${stored.epoch}/reject`,
            { wrapper: wrap.wrapper, ephPub: wrap.ephPub }, this.identity as BeanPoolIdentity).catch(() => null);
    }

    private storeMade(record: GroupEpochRecord, key: Uint8Array): StoredGroupEpoch {
        const mine = record.wraps!.find((w) => w.recipient === this.identity.publicKey)!;
        const { wraps: _wraps, ...served } = record;
        const stored: StoredGroupEpoch = {
            epoch: record.epoch, record: served,
            wrap: { epoch: record.epoch, wrapper: this.identity.publicKey, ephPub: mine.ephPub, nonce: mine.nonce, wrapped: mine.wrapped, sig: null },
        };
        this.epochs.set(record.epoch, stored);
        this.keys.set(record.epoch, key);
        return stored;
    }

    /**
     * After the node stored an epoch this phone made: keep it, raise the highest, and seal under it at once (rule 6). Never
     * over an epoch this phone holds, or at or below its highest (finding 5).
     */
    async adopt(record: GroupEpochRecord, key: Uint8Array): Promise<void> {
        await this.ensureLoaded();
        if (this.refusesEpoch(record.epoch)) throw new GroupChatKeyError(GROUP_KEY_ROLLBACK_TEXT, 'rollback');
        const stored = this.storeMade(record, key);
        await this.store.putEpochs(this.storeKey, [stored]).catch(() => { });
        await this.raise(record.epoch);
        if (record.epoch > this.after) { this.after = record.epoch; await this.store.setCursor(this.storeKey, record.epoch).catch(() => { }); }
        this.state = { current: record.epoch, stale: false, fromEpoch: this.state?.fromEpoch ?? null, roster: this.state?.roster ?? [] };
    }

    /**
     * After a membership change the node answered 2xx: an answer that carries no epoch looks the same from an old node
     * that ignored it, so the key this phone made is taken only once a sync serves the same record back (finding 5).
     * Otherwise it is dropped, and the change went alone, as designed.
     */
    async confirmMade(record: GroupEpochRecord, key: Uint8Array): Promise<boolean> {
        await this.sync().catch(() => null);
        const held = this.epochs.get(record.epoch);
        const { wraps: _wraps, ...served } = record;
        if (!held || !sameRecord(held.record, served) || this.keys.has(record.epoch)) return false;
        this.keys.set(record.epoch, key);
        await this.raise(record.epoch);
        return true;
    }

    /** Make the next epoch for a membership change or a rotation, wrapped to `recipients` (the maker among them). */
    async makeRecord(input: { epoch: number; reason: GroupEpochReason; subject?: string | null; recipients: string[] }, progress?: GroupEpochProgress) {
        return makeEpochRecord({
            myEdPrivHex: this.identity.privateKey, groupId: this.groupId, epoch: input.epoch, reason: input.reason,
            subject: input.subject ?? null, createdAt: new Date().toISOString(), recipients: [...new Set(input.recipients)],
        }, progress);
    }

    /**
     * Rotate (§2.3, reason 'rotate', or 'start' for a chat with no epoch yet): a fresh key to exactly today's roster, and
     * only when every one of them is in the members list read just now. A 409 means this phone's roster or epoch was old:
     * once more after reading both again (never the 409's own roster). Returns the new epoch and its key.
     */
    async rotate(progress?: GroupEpochProgress): Promise<{ epoch: number; key: Uint8Array }> {
        let state = this.state ?? await this.sync();
        for (let attempt = 0; ; attempt++) {
            if (!state.roster.includes(this.identity.publicKey)) throw new GroupChatKeyError('Only members of this group can open its chat', 'not_member');
            await this.requireRosterShown(state.roster, true);
            const epoch = (state.current ?? 0) + 1;
            if (this.rolledBack(state.current) || this.refusesEpoch(epoch)) throw new GroupChatKeyError(GROUP_KEY_ROLLBACK_TEXT, 'rollback');
            const { record, groupKey } = await this.makeRecord({ epoch, reason: epoch === 1 ? 'start' : 'rotate', recipients: state.roster }, progress);
            try {
                await answerOf(await signedPost(this.nodeUrl, `/api/groups/${encodeURIComponent(this.groupId)}/keys/epoch`, { epoch: record }, this.identity as BeanPoolIdentity));
                await this.adopt(record, groupKey);
                this.unconfirmed.add(epoch);
                return { epoch, key: groupKey };
            } catch (e) {
                if (attempt === 0 && e instanceof GroupKeysRequestError && e.status === 409 && e.body?.code === 'epoch_conflict') {
                    // A 409 naming an older current than this phone holds is a rollback, whatever a sync says next.
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
     * sentence the chat shows when nothing may be sent.
     */
    async prepareToSeal(progress?: GroupEpochProgress): Promise<{ epoch: number; key: Uint8Array }> {
        const state = await this.sync();
        if (this.rolledBack(state.current)) throw new GroupChatKeyError(GROUP_KEY_ROLLBACK_TEXT, 'rollback');
        // Whoever the line goes to must be in the members list the screen shows (finding 2), sealed or rotated.
        await this.requireRosterShown(state.roster, false);
        if (state.current === null) return this.rotate(progress);
        const stored = this.epochs.get(state.current);
        let fits = !state.stale && !!stored && !this.badRecords.has(state.current);
        if (fits && stored) {
            try {
                // Today's roster, for the epoch about to be sealed under only: its maker must be in it, and it must
                // cover exactly it (a member added, removed or gone without a rotation means a new key first).
                verifyGroupEpochRecord(stored.record, { groupId: this.groupId, epoch: state.current, activeMembers: state.roster });
                fits = groupEpochCoversExactly(stored.record, state.roster);
            } catch {
                fits = false;
            }
        }
        if (!fits) return this.rotate(progress);
        // Verified with its maker in today's roster, which the screen shows: the highest is at least this one.
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
     * most `max` per call (they share the chat's rate limit with sends). A slot already filled, or one my wrap was once
     * refused on, is left. Returns how many went.
     *
     * `missing` is the node's word, so a key goes only to someone the screen shows as a member AND whom that epoch's maker
     * wrapped it to, by the record's signature (review of #1788, finding 1; director's decision a): a junk wrap's repair.
     * A newcomer is never handed an epoch from before them, and a re-keyed member's new key is in no old record: they
     * read from their next epoch. Never through a former key: a succession chain proves the new key's claim, not the old
     * key's owner, and the node's members answer can leave the honest claimant out, so no epoch goes to a key on the
     * strength of a statement (review of #1826, finding 1; the director's option 2). A member who changes phones keeps
     * their name on their old lines; the group's history from before the change stays on the old phone.
     */
    async serveMissing(max = 10): Promise<number> {
        await this.ensureLoaded();
        let answer: { missing?: { pubkey: string; epochs: number[] }[] };
        try {
            answer = await answerOf(await signedGet(this.nodeUrl, `/api/groups/${encodeURIComponent(this.groupId)}/keys/missing`, this.identity as BeanPoolIdentity));
        } catch {
            return 0;
        }
        // A slot for an epoch this phone hasn't fetched yet (it never opened the chat since): fetch first, once.
        const wanted = (answer.missing ?? []).flatMap((m) => m.epochs ?? []);
        if (wanted.some((e) => !this.epochs.has(e))) await this.sync().catch(() => null);
        if (!(answer.missing ?? []).some((m) => m?.pubkey !== this.identity.publicKey)) return 0;
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
                const res = await signedPost(this.nodeUrl, `/api/groups/${encodeURIComponent(this.groupId)}/keys/wrap`,
                    { epoch, recipient: t.recipient, ephPub: t.ephPub, nonce: t.nonce, wrapped: t.wrapped, sig: t.sig }, this.identity as BeanPoolIdentity).catch(() => null);
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

/**
 * The keyring for one group on one node for this identity, shared for the app's session (the opened keys with it). The
 * group's id is lower-cased (the node makes ids lower-case): a link or a push can carry it in capitals, and every spelling
 * gets this one keyring, its rows, its highest epoch and its rollback check (#1815 review, finding 1).
 */
export function groupKeyring(nodeUrl: string, identity: Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>, groupId: string, store: GroupKeyStore): GroupKeyring {
    const gid = groupId.toLowerCase();
    const id = `${nodeUrl.replace(/\/+$/, '')}|${identity.publicKey}|${gid}`;
    let k = keyrings.get(id);
    if (!k) { k = new GroupKeyring(gid, nodeUrl.replace(/\/+$/, ''), identity, store); keyrings.set(id, k); }
    return k;
}

/** Every wipe (utils/db.ts clearDB): every opened key leaves memory, and this session's wrap tally; a kept store reopens them. */
export function forgetGroupKeys(): void {
    keyrings.clear();
    wrapOpenedThisSession = false;
    wrapFailuresBeforeAnyOpened = 0;
}

// ─── Membership changes that carry an epoch (§2.3) ─────────────────────────────────────────────────────────────────

/** What a membership request sends; `epoch` absent sends none (the node then marks the current epoch stale). */
type MembershipSend = (epoch?: GroupEpochRecord) => Promise<Response>;

/**
 * A membership change with its epoch, in one request: built from what this phone knows, once more after a 409 (the
 * keys read again when this phone may read them; a joiner can't, and takes the 409's), and, if the node still refuses
 * the epoch, the change alone (nobody is kept out of a group by crypto: the node marks the epoch stale and the next
 * member to write rotates). The epoch goes only to members the members list shows, read just now, and the member the
 * change is about (finding 2): otherwise, or when the list can't be read (an invitee may not see it), the change goes
 * alone. Returns the node's answer.
 */
async function withEpoch(
    ring: GroupKeyring, send: MembershipSend, build: (current: number | null, roster: string[]) => { reason: GroupEpochReason; subject: string; recipients: string[] } | null,
    known: { current: number | null; roster: string[] }, progress?: GroupEpochProgress,
): Promise<any> {
    let current = known.current;
    let roster = known.roster;
    for (let attempt = 0; attempt < 2; attempt++) {
        const plan = build(current, roster);
        if (!plan) break;
        if (!(await ring.rosterShown(plan.recipients, { extra: [plan.subject], fresh: true }))) break;
        const epoch = (current ?? 0) + 1;
        // Never an epoch at or below the highest this phone holds, or one it holds (finding 5): the change goes alone.
        if (ring.refusesEpoch(epoch)) break;
        const { record, groupKey } = await ring.makeRecord({ epoch, ...plan }, progress);
        const res = await send(record);
        const body = await res.clone().json().catch(() => ({}));
        if (res.ok) {
            await ring.confirmMade(record, groupKey).catch(() => false);
            return body;
        }
        if (res.status === 409 && body?.code === 'epoch_conflict') {
            const synced = await ring.sync().catch(() => null);
            current = synced ? synced.current : (body.current ?? null);
            roster = synced ? synced.roster : (Array.isArray(body.roster) ? body.roster : roster);
            continue;
        }
        if (typeof body?.code === 'string' && /^epoch_/.test(body.code)) break;
        throw new Error(body?.error || `The node answered ${res.status}.`);
    }
    return answerOf(await send(undefined));
}

/**
 * Join an open group, or accept an invitation (§2.3, §3): the joiner makes the next epoch, wrapped to every active member
 * and themselves. The joiner can't read the keys before joining, so the first try guesses from the roster it can see
 * and the node's 409 says the rest. A request to join an approval group lets nobody in yet, so it carries no epoch.
 */
export async function joinGroupWithEpoch(
    nodeUrl: string, identity: BeanPoolIdentity, store: GroupKeyStore,
    group: { id: string; joinPolicy?: string | null; viewerStatus?: string | null; activeMembers?: string[] }, progress?: GroupEpochProgress,
): Promise<any> {
    const path = `/api/groups/${encodeURIComponent(group.id)}/join`;
    const send: MembershipSend = (epoch) => signedPost(nodeUrl, path, epoch ? { epoch } : {}, identity);
    const invited = group.viewerStatus === 'invited';
    if (!invited && group.joinPolicy && group.joinPolicy !== 'open') return answerOf(await send(undefined));
    const ring = groupKeyring(nodeUrl, identity, group.id, store);
    const me = identity.publicKey;
    // The joiner can't read the keys yet: the first try guesses past the highest it holds (a member coming back), and the
    // node's 409 says the rest.
    return withEpoch(ring, send, (_c, roster) => ({ reason: invited ? 'invite' : 'join', subject: me, recipients: [...roster, me] }),
        { current: (await ring.highestEpoch()) || null, roster: group.activeMembers ?? [] }, progress);
}

/** A convenor approves a request (or invites someone who had asked): the approved member's first epoch (§2.3). */
export async function approveWithEpoch(
    nodeUrl: string, identity: BeanPoolIdentity, store: GroupKeyStore, groupId: string, subject: string,
    body: Record<string, unknown>, progress?: GroupEpochProgress,
): Promise<any> {
    const ring = groupKeyring(nodeUrl, identity, groupId, store);
    const state = await ring.sync().catch(() => null);
    const send: MembershipSend = (epoch) => signedPost(nodeUrl, `/api/groups/${encodeURIComponent(groupId)}/members`, epoch ? { ...body, epoch } : body, identity);
    if (!state) return answerOf(await send(undefined));
    return withEpoch(ring, send, (_c, roster) => ({ reason: 'approve', subject, recipients: [...roster.filter((k) => k !== subject), subject] }),
        { current: state.current, roster: state.roster }, progress);
}

/** A convenor removes a member: the removal IS the rotation, wrapped to everyone but them (§2.4). */
export async function removeWithEpoch(
    nodeUrl: string, identity: BeanPoolIdentity, store: GroupKeyStore, groupId: string, subject: string,
    sendDelete: (body: Record<string, unknown>) => Promise<Response>, progress?: GroupEpochProgress,
): Promise<any> {
    const ring = groupKeyring(nodeUrl, identity, groupId, store);
    const state = await ring.sync().catch(() => null);
    const send: MembershipSend = (epoch) => sendDelete(epoch ? { epoch } : {});
    if (!state) return answerOf(await send(undefined));
    return withEpoch(ring, send, (_c, roster) => ({ reason: 'remove', subject, recipients: roster.filter((k) => k !== subject) }),
        { current: state.current, roster: state.roster }, progress);
}
