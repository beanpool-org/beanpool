/**
 * The standby's copies of the main server's take-over envelope (sealed-keys.md §3, §4; slice 4).
 *
 * On every pull tick the standby asks the main server for its current envelope
 * (`GET /api/local/admin/takeover-envelope`, replication token, `If-None-Match: "<newest envelopeId held>"`),
 * so an unchanged envelope costs a bodyless 304. A new one is kept only when its header is signed by the main
 * server this standby already trusts for sync: the pinned `mirror` connector, the same gate
 * `importRemoteState` applies to snapshots (engine/sync.ts). Anything else is refused with a log line and never
 * written.
 *
 * ## Keep five, evict the oldest
 *
 * A broken or hostile main server could push a fresh envelope locked to nobody useful. It already has the keys,
 * so that gains it nothing, but it would quietly disarm a take-over. So the standby keeps the last five
 * (~1–2 KB each) and a new one evicts only the oldest; the status flags when the newest one's recipients
 * differ from the one before it.
 *
 * ## Never plaintext
 *
 * The standby has no owner key and no recovery code, so it cannot open an envelope and never tries. It writes
 * the sealed bytes exactly as they arrived; everything it shows comes from the public header (who it is locked
 * to, when, by which server).
 *
 * Files: data/held-takeover-envelopes/<receivedAt ms, 13 digits>-<envelopeId>.bpseal, mode 0600.
 */

import fs from 'node:fs';
import path from 'node:path';
import { peerIdFromString } from '@libp2p/peer-id';
import { readSealedHeader, verifySealedHeader, type SealedEnvelopeHeader } from '@beanpool/core';
import { getConnectorsByLevel } from '../connector-manager.js';
import { logger } from '../logger.js';

export const HELD_ENVELOPES_DIR = 'held-takeover-envelopes';
export const HELD_ENVELOPES_KEEP = 5;
export const TAKEOVER_ENVELOPE_PATH = '/api/local/admin/takeover-envelope';
/** A take-over envelope is a few KB; connectors.json is the only part that grows. Anything this big is not one. */
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const FILE_RE = /^(\d{13})-([0-9a-f]{32})\.bpseal$/;

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}
function heldDir(): string {
    return path.join(dataDir(), HELD_ENVELOPES_DIR);
}

// ── What is held ───────────────────────────────────────────────────────────────────────────

export interface HeldRecipients {
    owners: { pubkey: string; callsign: string }[];
    codes: { codeId: number; createdAt: string }[];
}

export interface HeldEnvelope {
    envelopeId: string;
    /** When the main server sealed it (header.createdAt). */
    sealedAt: string;
    /** When this standby received it. */
    receivedAt: number;
    signer: string;
    communityId: string;
    recipients: HeldRecipients;
}

function recipientsOf(header: SealedEnvelopeHeader): HeldRecipients {
    const owners: HeldRecipients['owners'] = [];
    const codes: HeldRecipients['codes'] = [];
    for (const r of header.recipients) {
        if (r.type === 'owner') owners.push({ pubkey: r.pubkey, callsign: r.callsign });
        else codes.push({ codeId: r.codeId, createdAt: r.createdAt });
    }
    return { owners, codes };
}

/** Oldest first. A file that no longer reads as a take-over envelope is left out (and never served as one). */
export function listHeldEnvelopes(): HeldEnvelope[] {
    let names: string[];
    try {
        names = fs.readdirSync(heldDir());
    } catch {
        return [];
    }
    const held: HeldEnvelope[] = [];
    for (const name of names.filter((n) => FILE_RE.test(n)).sort()) {
        const m = name.match(FILE_RE)!;
        try {
            const header = readSealedHeader(new Uint8Array(fs.readFileSync(path.join(heldDir(), name))));
            if (header.envelopeId !== m[2] || header.kind !== 'takeover') continue;
            held.push({
                envelopeId: header.envelopeId,
                sealedAt: header.createdAt,
                receivedAt: Number(m[1]),
                signer: header.nodePeerId,
                communityId: header.communityId,
                recipients: recipientsOf(header),
            });
        } catch { /* unreadable: skip */ }
    }
    return held;
}

/** The sealed bytes of one held envelope, exactly as received. For the take-over (slice 5). */
export function readHeldEnvelope(envelopeId: string): Uint8Array | null {
    if (!/^[0-9a-f]{32}$/.test(envelopeId)) return null;
    try {
        const name = fs.readdirSync(heldDir()).find((n) => FILE_RE.test(n) && n.endsWith(`-${envelopeId}.bpseal`));
        return name ? new Uint8Array(fs.readFileSync(path.join(heldDir(), name))) : null;
    } catch {
        return null;
    }
}

/** Append one envelope and evict the oldest beyond five. Never removes anything but the oldest. */
function keep(bytes: Uint8Array, header: SealedEnvelopeHeader): void {
    const dir = heldDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Strictly after the newest held one, so a clock step backwards can't file a new envelope as the oldest.
    const newest = listHeldEnvelopes().at(-1);
    const at = Math.max(Date.now(), (newest?.receivedAt ?? 0) + 1);
    const name = `${String(at).padStart(13, '0')}-${header.envelopeId}.bpseal`;
    const tmp = path.join(dir, `.${name}.tmp-${process.pid}`);
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, name));
    const all = fs.readdirSync(dir).filter((n) => FILE_RE.test(n)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - HELD_ENVELOPES_KEEP))) {
        fs.unlinkSync(path.join(dir, old));
        logger.info('P2P', `[Backup] Dropped the oldest held take-over envelope ${old.slice(14, 22)} (keeping the last ${HELD_ENVELOPES_KEEP})`);
    }
}

// ── Who may have sealed it ─────────────────────────────────────────────────────────────────

/** The PeerIds this standby trusts as its main server: its `mirror` connectors, as for sync. */
function mirrorPins(): string[] {
    return getConnectorsByLevel('mirror').map((c) => c.peerId).filter((p): p is string => typeof p === 'string' && !!p);
}

function publicKeyOfPeerId(peerId: string): Uint8Array | null {
    try {
        const raw = (peerIdFromString(peerId) as any).publicKey?.raw as Uint8Array | undefined;
        return raw && raw.length === 32 ? raw : null;
    } catch {
        return null;
    }
}

export type EnvelopeCheck = { ok: true; header: SealedEnvelopeHeader } | { ok: false; why: string; signer: string | null };

/** Is this a take-over envelope signed by the main server this standby is pinned to? Reads the header only. */
export function checkEnvelopeFromMirror(bytes: Uint8Array): EnvelopeCheck {
    let header: SealedEnvelopeHeader;
    try {
        header = readSealedHeader(bytes);
    } catch (e: any) {
        return { ok: false, why: `it is not a sealed envelope (${e?.message || 'unreadable header'})`, signer: null };
    }
    if (header.kind !== 'takeover') return { ok: false, why: `it is a ${header.kind} envelope, not a take-over envelope`, signer: header.nodePeerId };
    const pins = mirrorPins();
    if (pins.length === 0) {
        return { ok: false, why: 'this standby has no pinned main server (no mirror connector) to check its signature against', signer: header.nodePeerId };
    }
    if (!pins.includes(header.nodePeerId)) {
        return { ok: false, why: `it names ${header.nodePeerId}, not the main server this standby copies from`, signer: header.nodePeerId };
    }
    const key = publicKeyOfPeerId(header.nodePeerId);
    if (!key || !verifySealedHeader(header, key)) {
        // Keep a PeerId in the sentence: the log sanitiser redacts any run of 12+ plain words as a seed phrase.
        return { ok: false, why: `its signature does not match the pinned main server ${header.nodePeerId}`, signer: header.nodePeerId };
    }
    return { ok: true, header };
}

// ── The fetch ──────────────────────────────────────────────────────────────────────────────

export type EnvelopeFetchOutcome =
    | 'stored' // a new envelope, signature checked, kept
    | 'unchanged' // 304, or one already held
    | 'main-too-old' // 404 with no envelope state: the main server has no envelope route
    | 'main-has-none' // the main server answers but has nothing to hand out (no owner and no code, …)
    | 'rejected' // an envelope that failed the mirror check: not kept
    | 'no-token' // this standby has no replication token to ask with
    | 'failed'; // network, HTTP or disk error

interface LastCheck {
    at: number;
    outcome: EnvelopeFetchOutcome;
    /** One sentence, never a secret. */
    detail: string;
}

let lastCheck: LastCheck | null = null;
let lastRejected: { at: number; signer: string | null; why: string } | null = null;
let inFlight = false;

function done(outcome: EnvelopeFetchOutcome, detail: string): EnvelopeFetchOutcome {
    lastCheck = { at: Date.now(), outcome, detail };
    return outcome;
}

async function readCapped(res: Response): Promise<Uint8Array> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ENVELOPE_BYTES) throw new Error(`the envelope is too large (${declared} bytes)`);
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        total += value.byteLength;
        if (total > MAX_ENVELOPE_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error('the envelope is too large');
        }
        parts.push(value);
    }
    return new Uint8Array(Buffer.concat(parts));
}

/**
 * Ask the main server for its take-over envelope once. Never throws. Sends only the replication token: a
 * standby still on the legacy admin password fetches nothing until it has swapped it (backup-puller.ts).
 */
export async function pullTakeoverEnvelope(opts: { primaryUrl: string; replicationToken: string | null }): Promise<EnvelopeFetchOutcome> {
    if (inFlight) return lastCheck?.outcome ?? 'failed';
    if (!opts.replicationToken) {
        return done('no-token', "this standby has no replication token, so it can't fetch the take-over keys (it never sends the admin password for them)");
    }
    inFlight = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const newest = listHeldEnvelopes().at(-1);
        const headers: Record<string, string> = { 'X-Replication-Token': opts.replicationToken };
        if (newest) headers['If-None-Match'] = `"${newest.envelopeId}"`;
        const res = await fetch(opts.primaryUrl.replace(/\/$/, '') + TAKEOVER_ENVELOPE_PATH, { method: 'GET', headers, signal: controller.signal });

        if (res.status === 304) {
            await res.body?.cancel().catch(() => {});
            return done('unchanged', 'the main server still has the envelope this standby holds');
        }
        if (res.status === 404) {
            // The route answers 404 with a JSON `state` when it has nothing to hand out. Any other 404 is a main
            // server from before take-over envelopes: the path simply isn't there.
            const text = await res.text().catch(() => '');
            let body: any = null;
            try { body = JSON.parse(text); } catch { body = null; }
            if (body && typeof body.state === 'string') {
                const said = typeof body.error === 'string' && body.error ? body.error : body.state;
                return done('main-has-none', `the main server has no take-over envelope to send: ${said}`);
            }
            return done('main-too-old', 'the main server is too old to send a take-over envelope');
        }
        if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            return done('failed', `the main server answered HTTP ${res.status}`);
        }

        const bytes = await readCapped(res);
        const check = checkEnvelopeFromMirror(bytes);
        if (!check.ok) {
            lastRejected = { at: Date.now(), signer: check.signer, why: check.why };
            logger.security('P2P', `[Backup] ❌ Refused a take-over envelope: ${check.why}. Not kept; the ones already held are unchanged.`);
            return done('rejected', `refused the envelope the main server sent: ${check.why}`);
        }
        if (listHeldEnvelopes().some((h) => h.envelopeId === check.header.envelopeId)) {
            return done('unchanged', 'the main server still has the envelope this standby holds');
        }
        keep(bytes, check.header);
        const r = recipientsOf(check.header);
        logger.info('P2P', `[Backup] 🔐 Holding the main server's take-over envelope ${check.header.envelopeId.slice(0, 8)} `
            + `(sealed ${check.header.createdAt}, ${r.owners.length} owner(s)${r.codes.length ? ` + recovery code #${r.codes.map((c) => c.codeId).join(', #')}` : ''})`);
        return done('stored', 'fetched a new envelope from the main server');
    } catch (e: any) {
        const msg = e?.name === 'AbortError' ? `no answer within ${FETCH_TIMEOUT_MS / 1000}s` : (e?.message || String(e));
        logger.warn('P2P', `[Backup] Could not fetch the take-over envelope: ${msg}`);
        return done('failed', `could not fetch the take-over envelope: ${msg}`);
    } finally {
        clearTimeout(timer);
        inFlight = false;
    }
}

// ── Status (§3: "shows the recipient list of the newest envelope and flags a change") ─────

export interface RecipientChange {
    ownersAdded: string[];
    ownersRemoved: string[];
    codesAdded: number[];
    codesRemoved: number[];
}

export interface HeldEnvelopesStatus {
    state: 'holding' | 'holding-none';
    /** One or two sentences for Settings. Never a secret. */
    message: string;
    /** Newest first. */
    held: HeldEnvelope[];
    newest: HeldEnvelope | null;
    /** The newest envelope's recipients differ from the one held before it. */
    recipientsChanged: boolean;
    change: RecipientChange | null;
    lastCheck: LastCheck | null;
    lastRejected: { at: number; signer: string | null; why: string } | null;
    keep: number;
}

function label(o: { pubkey: string; callsign: string }): string {
    return '@' + (o.callsign || o.pubkey.slice(0, 8));
}

function diffRecipients(prev: HeldRecipients, next: HeldRecipients): RecipientChange | null {
    const prevOwners = new Map(prev.owners.map((o) => [o.pubkey, o]));
    const nextOwners = new Map(next.owners.map((o) => [o.pubkey, o]));
    const prevCodes = new Set(prev.codes.map((c) => c.codeId));
    const nextCodes = new Set(next.codes.map((c) => c.codeId));
    const change: RecipientChange = {
        ownersAdded: [...nextOwners.values()].filter((o) => !prevOwners.has(o.pubkey)).map(label),
        ownersRemoved: [...prevOwners.values()].filter((o) => !nextOwners.has(o.pubkey)).map(label),
        codesAdded: [...nextCodes].filter((c) => !prevCodes.has(c)),
        codesRemoved: [...prevCodes].filter((c) => !nextCodes.has(c)),
    };
    const any = change.ownersAdded.length + change.ownersRemoved.length + change.codesAdded.length + change.codesRemoved.length;
    return any ? change : null;
}

function describeRecipients(r: HeldRecipients): string {
    const parts = [
        r.owners.length ? r.owners.map(label).join(', ') : null,
        r.codes.length ? `recovery code #${r.codes.map((c) => c.codeId).join(', #')}` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(' and ') : 'nobody';
}

function describeChange(c: RecipientChange): string {
    const bits = [
        c.ownersAdded.length ? `added ${c.ownersAdded.join(', ')}` : null,
        c.ownersRemoved.length ? `removed ${c.ownersRemoved.join(', ')}` : null,
        c.codesAdded.length ? `added recovery code #${c.codesAdded.join(', #')}` : null,
        c.codesRemoved.length ? `dropped recovery code #${c.codesRemoved.join(', #')}` : null,
    ].filter(Boolean);
    return bits.join('; ');
}

export function getHeldEnvelopesStatus(): HeldEnvelopesStatus {
    const oldestFirst = listHeldEnvelopes();
    const held = [...oldestFirst].reverse();
    const newest = held[0] ?? null;
    const change = held.length >= 2 ? diffRecipients(held[1].recipients, held[0].recipients) : null;

    let message: string;
    if (newest) {
        message = `This standby holds the main server's take-over keys, locked; it cannot open them. `
            + `The newest copy was sealed ${newest.sealedAt} and opens with ${describeRecipients(newest.recipients)}.`;
        if (change) message += ` The people it is locked to changed since the copy before it: ${describeChange(change)}.`;
    } else {
        message = 'This standby holds no take-over keys yet.';
    }
    if (lastCheck && lastCheck.outcome !== 'stored' && lastCheck.outcome !== 'unchanged') {
        const why = lastCheck.detail.charAt(0).toUpperCase() + lastCheck.detail.slice(1);
        message += newest ? ` The last check did not update it. ${why}.` : ` ${why}.`;
    }
    return {
        state: newest ? 'holding' : 'holding-none',
        message,
        held,
        newest,
        recipientsChanged: !!change,
        change,
        lastCheck,
        lastRejected,
        keep: HELD_ENVELOPES_KEEP,
    };
}

/** Tests only: forget the in-memory check results. */
export function resetHeldEnvelopeChecks(): void {
    lastCheck = null;
    lastRejected = null;
}
