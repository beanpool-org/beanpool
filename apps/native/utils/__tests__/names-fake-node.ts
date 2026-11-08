/**
 * A community's node for the names list, as the phones see it (moved here from names-list.test.ts, unchanged, so a screen's
 * test can run the list's real flows against it: people-invites-names-notices.test.ts). It keeps the key history, the
 * shares, the entries and the admins by the same rules as apps/server engine/names-list.ts, checks every request as the
 * node's middleware does (signed by the admin's own key, for that host), and can show each phone something different.
 * Not a test file: vitest runs only *.test.ts.
 */
import {
    sealNamesEntry, newNamesEntryId, readNamesGeneration, readNamesShare, readNamesCopy, type NamesGeneration, type NamesShare,
} from '@beanpool/core';
import { boundSignatureValid } from './server-signature-check';
import type { NamesState, SealedEntryRow } from '../names-list';

export const CID = 'a1b2c3d4e5f60718';

export interface Sent { url: string; method: string; headers: Record<string, string>; body: string }

export type Admin = { pubkey: string; callsign: string; role: 'owner' | 'admin' };
/** What the node shows one phone instead; `quiet` hides that a holder of the current key was marked as no admin. */
export type View = Partial<{ admins: Admin[]; hide: string[]; current: string | null; communityId: string; extraShares: NamesShare[]; quiet: boolean }>;

/**
 * A community's node as the phones see it: the key history, the shares, the entries, the admins, by the same rules as
 * apps/server engine/names-list.ts. `views` shows a phone something else.
 */
export class FakeNode {
    gens = new Map<string, NamesGeneration>();
    shares = new Map<string, NamesShare>();
    entries: SealedEntryRow[] = [];
    admins: Admin[] = [];
    marks = new Set<string>();
    log: { actor: string; action: string; subject: string | null }[] = [];
    views = new Map<string, View>();
    /** The names keys went by before a re-key (the server follows rekey_audit_log to the member's callsign). */
    former: Record<string, string> = {};
    /** The locked copies (design §4), by owner; null: a node from before them (no `myCopy`, no route). */
    copies: Map<string, { header: string; signature: string; box: unknown; seq: number; headN: number; headId: string | null; savedAt: string; digest: string }> | null = null;
    /** Called before each request is answered: lets a test make something land first. */
    onRequest: ((req: Sent) => void) | null = null;
    /** Set when the node makes one branch of a fork its current (then each statement it takes moves it on). */
    head: string | null = null;
    current(): NamesGeneration | null {
        if (this.head) return this.gens.get(this.head) ?? null;
        return [...this.gens.values()].sort((a, b) => b.n - a.n)[0] ?? null;
    }
    /** `mayHold` (design Addendum 4): maker, and both ends of every share naming the id; for the freeze and `no_key`. */
    holdersOf(id: string): Set<string> {
        const out = new Set<string>();
        const g = this.gens.get(id);
        if (g) out.add(g.maker);
        for (const s of this.shares.values()) if (s.keyIds.includes(id)) { out.add(s.from); out.add(s.to); }
        for (const m of this.marks) if (m.endsWith(`|${id}`)) out.delete(m.split('|')[0]);
        return out;
    }
    /** `holds`: on the holder's own word (maker, or its own share header lists the id); for keyIds, holders and ask_for_share. */
    holds(id: string): Set<string> {
        const out = new Set<string>();
        const g = this.gens.get(id);
        if (g) out.add(g.maker);
        for (const s of this.shares.values()) if (s.keyIds.includes(id)) out.add(s.from);
        for (const m of this.marks) if (m.endsWith(`|${id}`)) out.delete(m.split('|')[0]);
        return out;
    }
    keyIdsOf(pk: string): string[] {
        return [...this.gens.keys()].filter((id) => this.holds(id).has(pk)).sort();
    }
    /** Ids an admin deleted, newest last (the log's `delete` lines). */
    deleted: string[] = [];
    reconcile(): void {
        const cur = this.current();
        if (!cur) return;
        const admins = new Set(this.admins.map((a) => a.pubkey));
        for (const h of this.holdersOf(cur.id)) {
            if (!admins.has(h) && !this.marks.has(`${h}|${cur.id}`)) {
                this.marks.add(`${h}|${cur.id}`);
                this.log.push({ actor: 'node', action: 'holder_dropped', subject: h });
            }
        }
    }
    isAdmin(pk: string) { return this.admins.some((a) => a.pubkey === pk); }
    stateFor(me: string): NamesState {
        const v = this.views.get(me) ?? {};
        const admins = v.admins ?? this.admins;
        const gens = [...this.gens.values()].filter((g) => !(v.hide ?? []).includes(g.id)).sort((a, b) => a.n - b.n);
        const cur = v.current !== undefined ? (v.current ? this.gens.get(v.current) ?? null : null) : this.current();
        const holders = cur ? this.holds(cur.id) : new Set<string>();
        const holdersOfCurrent = admins.map((a) => a.pubkey).filter((k) => holders.has(k));
        const byKey: Record<string, number> = {};
        for (const e of this.entries) byKey[e.keyId] = (byKey[e.keyId] ?? 0) + 1;
        const meRow = admins.find((a) => a.pubkey === me);
        return {
            communityId: v.communityId ?? CID,
            current: cur ? { id: cur.id, n: cur.n } : null,
            generations: gens.map((g) => ({ statement: g.statement, signature: g.signature, id: g.id, n: g.n, parentId: g.parentId, maker: g.maker, drops: g.drops })),
            shares: [...this.shares.values(), ...(v.extraShares ?? [])].map((s) => ({ header: s.header, signature: s.signature, from: s.from, to: s.to, headId: s.headId, keyIds: s.keyIds, trusts: s.trusts, ...(s.to === me && s.box ? { box: s.box } : {}) })),
            admins: admins.map((a) => ({ ...a, keyIds: this.keyIdsOf(a.pubkey), holdsCurrent: holders.has(a.pubkey) })),
            holdersOfCurrent,
            droppedHolders: cur && !v.quiet ? [...this.marks].filter((m) => m.endsWith(`|${cur.id}`)).map((m) => m.split('|')[0]) : [],
            nobodyHoldsKey: !!cur && holdersOfCurrent.length === 0,
            newKeyNeeded: !!cur && !v.quiet && [...this.marks].some((m) => m.endsWith(`|${cur.id}`)),
            callsigns: { ...this.former, ...Object.fromEntries(this.admins.map((a) => [a.pubkey, a.callsign])) },
            settings: { twoAdminsToConfirm: false, namesShownToMembers: false },
            counts: { entries: this.entries.length, confirmed: 0, awaitingSecond: 0, byKey, locked: 0 },
            me: { pubkey: me, role: meRow?.role ?? null, owner: meRow?.role === 'owner' },
            ...(this.copies ? { myCopy: ((c) => (c ? { seq: c.seq, headN: c.headN, headId: c.headId, savedAt: c.savedAt, digest: c.digest } : null))(this.copies.get(me)) } : {}),
        };
    }
    put(g: NamesGeneration): void { this.gens.set(g.id, g); }
    add(key: Uint8Array, keyId: string, name: string, by = 'x'): string {
        const id = newNamesEntryId();
        this.entries.push({ id, ciphertext: sealNamesEntry(key, id, keyId, { name, note: '' }), keyId, createdBy: by, createdAt: '2026-10-01', updatedBy: null, updatedAt: '' });
        return id;
    }
    answer(req: Sent): { status: number; body?: unknown } {
        const who = req.headers['X-Public-Key'];
        if (!who || !boundSignatureValid(req, who)) return { status: 401, body: { error: 'unsigned', code: 'unsigned' } };
        if (!this.isAdmin(who)) return { status: 403, body: { error: 'Only the community’s owners and admins can open the names list.', code: 'admins_only' } };
        this.onRequest?.(req);
        this.reconcile();
        const { pathname } = new URL(req.url);
        const body = req.body ? JSON.parse(req.body) : {};
        const err = (status: number, code: string) => ({ status, body: { error: code, code } });
        if (req.method === 'GET' && pathname === '/api/names/state') return { status: 200, body: this.stateFor(who) };
        if (req.method === 'GET' && pathname === '/api/names/entries') return { status: 200, body: { current: this.current()?.id ?? null, entries: this.entries, confirmations: [], deleted: [...this.deleted].reverse() } };
        if (req.method === 'DELETE' && pathname.startsWith('/api/names/entries/')) {
            const id = pathname.split('/').pop()!;
            if (!this.entries.some((e) => e.id === id)) return err(404, 'no_entry');
            this.entries = this.entries.filter((e) => e.id !== id);
            this.deleted.push(id);
            this.log.push({ actor: who, action: 'delete', subject: null });
            return { status: 200, body: { id } };
        }
        if (req.method === 'GET' && pathname === '/api/names/log') return { status: 200, body: { log: [], total: 0 } };
        if (req.method === 'POST' && pathname === '/api/names/generations') {
            const g = readNamesGeneration(body, CID);
            if (!g) return err(400, 'bad_signature');
            if (this.gens.has(g.id)) return { status: 200, body: { id: g.id, n: g.n, code: 'exists' } };
            const cur = this.current();
            if ((g.parentId ?? null) !== (cur?.id ?? null) || g.n !== (cur ? cur.n + 1 : 1)) return err(409, 'stale');
            if (g.maker === who && body.replay !== true && cur) {
                const holders = [...this.holds(cur.id)].filter((k) => this.isAdmin(k));
                if (holders.length && !holders.includes(who)) return err(409, 'ask_for_share');
            }
            this.gens.set(g.id, g);
            if (this.head) this.head = g.id;
            this.log.push({ actor: who, action: cur ? 'key_changed' : 'key_made', subject: null });
            return { status: 201, body: { id: g.id, n: g.n } };
        }
        if (req.method === 'POST' && pathname === '/api/names/shares') {
            const s = readNamesShare(body, CID);
            if (!s || s.from !== who) return err(400, 'bad_signature');
            if (!s.box) return err(400, 'bad_box');
            if (!this.isAdmin(s.to)) return err(400, 'not_admin');
            if (!this.gens.has(s.headId) || s.keyIds.some((id) => !this.gens.has(id))) return err(400, 'unknown_key');
            this.shares.set(`${s.from}|${s.to}`, s);
            this.log.push({ actor: who, action: 'key_shared', subject: s.to });
            return { status: 200, body: { to: s.to } };
        }
        if ((req.method === 'POST' && pathname === '/api/names/entries') || (req.method === 'PUT' && pathname.startsWith('/api/names/entries/'))) {
            const cur = this.current();
            if (!cur) return err(409, 'no_list_key');
            if ([...this.marks].some((m) => m.endsWith(`|${cur.id}`))) return err(409, 'new_key_first');
            if (body.keyId !== cur.id) return err(409, 'stale_key');
            if (!this.holdersOf(cur.id).has(who)) return err(403, 'no_key');
            const id = req.method === 'POST' ? body.id : pathname.split('/').pop()!;
            const row = this.entries.find((e) => e.id === id);
            if (req.method === 'POST') {
                if (row) return err(409, 'entry_exists');
                this.entries.push({ id, ciphertext: body.ciphertext, keyId: body.keyId, createdBy: who, createdAt: new Date().toISOString(), updatedBy: who, updatedAt: '' });
                return { status: 201, body: { id } };
            }
            if (!row) return err(404, 'no_entry');
            row.ciphertext = body.ciphertext;
            row.keyId = body.keyId;
            return { status: 200, body: { id } };
        }
        if (this.copies && req.method === 'PUT' && pathname === '/api/names/copy') {
            // As apps/server engine/names-list.ts saveNamesCopy: read, owner, exists, stale, upsert; no log line.
            const r = readNamesCopy(body);
            if (!r.ok) return err(400, 'bad_copy');
            const c = r.copy;
            if (c.owner !== who) return err(403, 'not_yours');
            const old = this.copies.get(who);
            if (old && old.header === c.header) return { status: 200, body: { seq: c.seq, code: 'exists' } };
            if (old && c.seq <= old.seq) return { status: 409, body: { error: 'stale_copy', code: 'stale_copy', seq: old.seq } };
            this.copies.set(who, { header: c.header, signature: c.signature, box: c.box, seq: c.seq, headN: c.headN, headId: c.headId, savedAt: c.savedAt, digest: c.boxDigest });
            return { status: 200, body: { seq: c.seq } };
        }
        if (this.copies && req.method === 'GET' && pathname === '/api/names/copy') {
            const c = this.copies.get(who);
            if (!c) return err(404, 'no_copy');
            this.log.push({ actor: who, action: 'copy_restored', subject: null });
            return { status: 200, body: { header: c.header, signature: c.signature, box: c.box } };
        }
        return err(404, 'not_found');
    }
}
