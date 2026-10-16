/**
 * Which server a standby copies (design scratch/global-node/case19/DESIGN-standby-pin-fable.md D1–D4): its main server's
 * node key (PeerId), learnt once from a pairing code typed on the standby's own shell (`beanpool pair`,
 * pair-command.ts), and kept in data/standby-main.json. No route writes that file. Three things trust it: the copy import
 * (engine/sync.ts verifySyncPayload), the held take-over keys (standby-envelopes.ts) and a restore on a standby
 * (sealed-backup.ts restorePins).
 *
 *   - The pairing code (`replication-token/generate` on the main server): `bpair1-<base64url JSON>-<6 hex>`, the JSON
 *     `{ v: 1, url, communityId, peerId, token }`, the hex the first six of the sha256 of the base64url part, so a cut
 *     paste is caught before anything is written. The token is the secret part: never logged, never in argv.
 *   - The pickup: the command leaves data/pair-request.json (0600, whole or not at all), the running node takes it on a
 *     2 s tick, writes the pin and the copy source, and answers in data/pair-answer.json (never the token). As
 *     `beanpool claim` hands a name to the node (address-request.ts).
 *   - The boot migration (D4): a standby from before the pin takes its main server's key from its own import record, or
 *     from its one `mirror` link when it has taken a copy; otherwise it stays unpaired and says so (`standby.unpaired`).
 *
 * No database or config import at the top: the command loads this beside a running node. The node's half imports what
 * it needs when it runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { peerIdFromString } from '@libp2p/peer-id';

export const STANDBY_MAIN_FILE = 'standby-main.json';
export const PAIR_REQUEST_FILE = 'pair-request.json';
export const PAIR_ANSWER_FILE = 'pair-answer.json';
/** A pairing code is a few hundred characters; anything longer is not one. */
export const PAIRING_CODE_MAX_CHARS = 1024;
const MAX_FILE_BYTES = 4096;
const CODE_PREFIX = 'bpair1-';

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

export interface StandbyMain {
    v: 1;
    peerId: string;
    communityId: string | null;
    url: string | null;
    pairedAt: number;
    how: 'shell' | 'migrated';
}

/** The last eight characters of a key, as the take-over screens show it. */
export function keyEnd(peerId: string | null | undefined): string {
    return peerId ? `…${peerId.slice(-8)}` : '…';
}

/** An Ed25519 PeerId (the node keys this code ships), or false. */
export function isNodePeerId(v: unknown): v is string {
    if (typeof v !== 'string' || v.length < 40 || v.length > 64) return false;
    try {
        const raw = (peerIdFromString(v) as any).publicKey?.raw as Uint8Array | undefined;
        return !!raw && raw.length === 32;
    } catch {
        return false;
    }
}

function publicKeyOf(peerId: string): Uint8Array | null {
    try {
        const raw = (peerIdFromString(peerId) as any).publicKey?.raw as Uint8Array | undefined;
        return raw && raw.length === 32 ? raw : null;
    } catch {
        return null;
    }
}

/** A plain http(s) origin, or null. */
export function originOf(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > 300) return null;
    try {
        const u = new URL(raw.trim());
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
        return u.origin;
    } catch {
        return null;
    }
}

const COMMUNITY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^[0-9a-f]{64}$/;

/**
 * A small regular file's text, opened without following a link or waiting on a pipe (the node reads these on a 2 s
 * tick, and at boot: a read that blocks stops the node). Null when there is none, or it is anything else.
 */
function readSmallFile(file: string): string | null {
    let st: fs.Stats;
    try { st = fs.lstatSync(file); } catch { return null; }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    let fd = -1;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const open = fs.fstatSync(fd);
        if (!open.isFile() || open.size > MAX_FILE_BYTES) return null;
        const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return n > MAX_FILE_BYTES ? null : buf.subarray(0, n).toString('utf8');
    } catch {
        return null;
    } finally {
        if (fd >= 0) fs.closeSync(fd);
    }
}

/** Whole or not at all: a 0600 temp file renamed over the target. Throws naming the file. */
function writeWhole(file: string, text: string): void {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
        fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
        const fd = fs.openSync(tmp, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* never made */ }
        throw new Error(`could not write ${file} (${(e as NodeJS.ErrnoException).code || 'error'})`);
    }
}

// ── The pin ────────────────────────────────────────────────────────────────────────────────

/** The pin, or null when there is none or the file is not one (then this standby imports nothing: fail closed). */
export function readStandbyMain(dir = dataDir()): StandbyMain | null {
    const text = readSmallFile(path.join(dir, STANDBY_MAIN_FILE));
    if (text === null) return null;
    try {
        const p = JSON.parse(text);
        if (!p || p.v !== 1 || !isNodePeerId(p.peerId)) return null;
        return {
            v: 1, peerId: p.peerId,
            communityId: typeof p.communityId === 'string' && COMMUNITY_ID.test(p.communityId) ? p.communityId : null,
            url: originOf(p.url),
            pairedAt: Number.isSafeInteger(p.pairedAt) ? p.pairedAt : 0,
            how: p.how === 'migrated' ? 'migrated' : 'shell',
        };
    } catch {
        return null;
    }
}

/** The pinned main server's PeerId, or null. */
export function standbyMainPeerId(dir = dataDir()): string | null {
    return readStandbyMain(dir)?.peerId ?? null;
}

/** Written by the node only: the shell's pickup and the boot migration. */
export function writeStandbyMain(pin: StandbyMain, dir = dataDir()): void {
    writeWhole(path.join(dir, STANDBY_MAIN_FILE), JSON.stringify(pin, null, 2));
}

/**
 * A take-over's `pull-config` step (services/takeover.ts): the promoted server imports from nobody, so its pin goes to
 * standby-main.retired-<ms>.json. The undo copy holds the file, so a roll-back puts it back. Returns the retired name.
 */
export function retireStandbyMain(dir = dataDir()): string | null {
    const file = path.join(dir, STANDBY_MAIN_FILE);
    if (!fs.existsSync(file)) return null;
    const retired = `standby-main.retired-${Date.now()}.json`;
    fs.renameSync(file, path.join(dir, retired));
    return retired;
}

// ── The pairing code ───────────────────────────────────────────────────────────────────────

export interface PairingCode {
    url: string;
    communityId: string;
    peerId: string;
    token: string;
}

function checksumOf(body: string): string {
    return crypto.createHash('sha256').update(body).digest('hex').slice(0, 6);
}

/** The main server's code: its own key (never one from the request), its community, its address, the token. */
export function makePairingCode(c: PairingCode): string {
    const body = Buffer.from(JSON.stringify({ v: 1, url: c.url, communityId: c.communityId, peerId: c.peerId, token: c.token })).toString('base64url');
    return `${CODE_PREFIX}${body}-${checksumOf(body)}`;
}

export type ParsedPairingCode = { ok: true; code: PairingCode } | { ok: false; why: string };

/** Does this look like a pairing code at all (rather than a bare token)? */
export function looksLikePairingCode(raw: unknown): boolean {
    return typeof raw === 'string' && raw.trim().startsWith(CODE_PREFIX);
}

/**
 * The code, checked whole: its shape, its checksum (a cut or changed paste is refused here, before anything is written),
 * then each field. Spaces and line breaks a terminal or a chat put in are taken out first.
 */
export function parsePairingCode(raw: unknown): ParsedPairingCode {
    if (typeof raw !== 'string') return { ok: false, why: 'There is no pairing code.' };
    const s = raw.replace(/\s+/g, '');
    if (s.length > PAIRING_CODE_MAX_CHARS) return { ok: false, why: 'That is too long to be a pairing code.' };
    if (!s.startsWith(CODE_PREFIX)) return { ok: false, why: 'That is not a pairing code: it starts with bpair1-. Make one under Replication Access on the main server.' };
    const rest = s.slice(CODE_PREFIX.length);
    const m = /^([A-Za-z0-9_-]+)-([0-9a-f]{6})$/.exec(rest);
    if (!m || checksumOf(m[1]) !== m[2]) {
        return { ok: false, why: 'The pairing code is not whole: part of it is missing or changed. Copy it again from the main server.' };
    }
    let j: any;
    try { j = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { j = null; }
    if (!j || j.v !== 1) return { ok: false, why: 'This pairing code is from a version of BeanPool this server does not know.' };
    const url = originOf(j.url);
    if (!url) return { ok: false, why: "The pairing code's address is not an http(s) address." };
    if (typeof j.communityId !== 'string' || !COMMUNITY_ID.test(j.communityId)) return { ok: false, why: "The pairing code's community id is not one." };
    if (!isNodePeerId(j.peerId)) return { ok: false, why: "The pairing code's server key is not one." };
    if (typeof j.token !== 'string' || !TOKEN.test(j.token)) return { ok: false, why: "The pairing code's replication token is not one." };
    return { ok: true, code: { url, communityId: j.communityId, peerId: j.peerId, token: j.token } };
}

// ── The request and the answer (the shell's half writes, the node's half takes) ─────────────

export interface PairRequest {
    v: 1;
    id: string;
    code: string;
    followNewServer: boolean;
    at: number;
}

export interface PairAnswer {
    v: 1;
    id: string;
    ok: boolean;
    /** paired: a first pin; same: the same key, its address and token updated; replaced: --follow-new-server. */
    outcome: 'paired' | 'same' | 'replaced' | 'refused';
    /** What the command prints, in order. Never the token. */
    lines: string[];
    /** The amber line: the address answers as another key (it pairs anyway). */
    amber: string | null;
}

/** Left by the command. Throws naming the file. */
export function writePairRequestFile(req: PairRequest, dir = dataDir()): void {
    writeWhole(path.join(dir, PAIR_REQUEST_FILE), JSON.stringify(req));
}

/** The node's answer for this request id, and the file gone; null while there is none. */
export function takePairAnswerFile(id: string, dir = dataDir()): PairAnswer | null {
    const file = path.join(dir, PAIR_ANSWER_FILE);
    const text = readSmallFile(file);
    if (text === null) return null;
    try {
        const a = JSON.parse(text);
        if (!a || a.v !== 1 || a.id !== id) return null;
        try { fs.unlinkSync(file); } catch { /* gone */ }
        return {
            v: 1, id, ok: a.ok === true, outcome: a.outcome,
            lines: Array.isArray(a.lines) ? a.lines.filter((l: unknown) => typeof l === 'string') : [],
            amber: typeof a.amber === 'string' ? a.amber : null,
        };
    } catch {
        return null;
    }
}

/** In the node: the request, and the file gone; null when there is none (anything that is not one is removed). */
export function takePairRequestFile(dir = dataDir()): PairRequest | null {
    const file = path.join(dir, PAIR_REQUEST_FILE);
    let there = false;
    try { there = !!fs.lstatSync(file); } catch { return null; }
    const text = readSmallFile(file);
    if (there) { try { fs.rmSync(file, { force: true, recursive: false }); } catch { /* a directory: left */ } }
    if (text === null) return null;
    try {
        const r = JSON.parse(text);
        if (!r || r.v !== 1 || typeof r.id !== 'string' || !/^[0-9a-f]{16,32}$/.test(r.id) || typeof r.code !== 'string') return null;
        return { v: 1, id: r.id, code: r.code, followNewServer: r.followNewServer === true, at: Number(r.at) || Date.now() };
    } catch {
        return null;
    }
}

// ── The node's half ────────────────────────────────────────────────────────────────────────

/** The words a refusal of a code naming another key carries, on the shell and in Settings. */
export function otherKeyWords(pin: string, code: string): string {
    return `This code is for a different main server (key ending ${keyEnd(code)}); this standby follows ${keyEnd(pin)}.`;
}

/**
 * Does `<url>/api/node/identity-epoch` answer as this key? The amber line when it answers as another; null when it
 * answers as this one or not at all (the main server may not be up yet: the pin, not the address, is what is trusted).
 */
export async function probeMainServerKey(url: string, peerId: string): Promise<{ amber: string | null; reached: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(`${url}/api/node/identity-epoch`, { signal: controller.signal, redirect: 'manual' });
        if (!res.ok) return { amber: null, reached: false };
        const body = await res.json().catch(() => null) as any;
        const s = body?.statement;
        const key = publicKeyOf(peerId);
        const { epochStatementSignedBy } = await import('./identity-epoch.js');
        const valid = !!key && epochStatementSignedBy(body, peerId, key);
        if (valid) return { amber: null, reached: true };
        const other = typeof s?.peerId === 'string' ? s.peerId : null;
        return {
            amber: `The server at ${url} answers as another key${other ? ` (ending ${keyEnd(other)})` : ''}: check the address. `
                + 'This standby is paired anyway: it trusts the key in the code, not the address.',
            reached: true,
        };
    } catch {
        return { amber: null, reached: false };
    } finally {
        clearTimeout(timer);
    }
}

/** The node takes a request and answers it. Never throws. */
export async function answerPairRequest(req: PairRequest, dir = dataDir()): Promise<PairAnswer> {
    const refused = (lines: string[]): PairAnswer => ({ v: 1, id: req.id, ok: false, outcome: 'refused', lines: [...lines, 'Nothing was changed.'], amber: null });
    try {
        const parsed = parsePairingCode(req.code);
        if (!parsed.ok) return refused([parsed.why]);
        const code = parsed.code;
        const { getNodeRole } = await import('../config/node-role.js');
        if (getNodeRole() !== 'backup') return refused(['This server is a main server; a standby has NODE_ROLE=backup.']);
        const current = readStandbyMain(dir);
        if (current && current.peerId !== code.peerId && !req.followNewServer) {
            return refused([
                `This standby follows ${keyEnd(current.peerId)}, and this code names ${keyEnd(code.peerId)}.`,
                'To follow that server instead: beanpool pair --follow-new-server',
            ]);
        }
        const outcome: PairAnswer['outcome'] = !current ? 'paired' : current.peerId === code.peerId ? 'same' : 'replaced';
        const probe = await probeMainServerKey(code.url, code.peerId);
        const { updateLocalConfig } = await import('../config/local-config.js');
        const { logger } = await import('../logger.js');
        if (outcome === 'same') {
            if (current!.url !== code.url) writeStandbyMain({ ...current!, url: code.url }, dir);
        } else {
            writeStandbyMain({ v: 1, peerId: code.peerId, communityId: code.communityId, url: code.url, pairedAt: Date.now(), how: 'shell' }, dir);
        }
        updateLocalConfig({ backupPrimaryUrl: code.url, backupReplicationToken: code.token, backupAdminPassword: null });
        if (outcome !== 'same') {
            // The next pull is a whole copy, built from nothing in the stager; the copy held now is kept until it is accepted.
            const { forgetPullCursor } = await import('./backup-puller.js');
            forgetPullCursor();
        }
        const lines = outcome === 'same'
            ? [`This standby already follows ${keyEnd(code.peerId)}: its main server's address and token are updated (${code.url}). No copy starts again.`]
            : outcome === 'replaced'
                ? [`This standby now follows ${keyEnd(code.peerId)} (it followed ${keyEnd(current!.peerId)}). Its next copy is built from nothing; the copy it holds now is kept until that one is accepted.`]
                : [`This standby is paired with its main server ${keyEnd(code.peerId)} at ${code.url}. Its first copy starts within a minute.`];
        if (!probe.reached) lines.push(`${code.url} did not answer now; this standby copies from it once it does.`);
        logger.security('P2P', outcome === 'replaced'
            ? `[Standby] This standby now follows a different main server ${code.peerId} (it followed ${current!.peerId}), paired again from the server's shell`
            : outcome === 'paired'
                ? `[Standby] This standby was paired with its main server ${code.peerId}, from the server's shell`
                : `[Standby] The main server's address and token were updated from the server's shell (same key ${code.peerId})`);
        return { v: 1, id: req.id, ok: true, outcome, lines, amber: probe.amber };
    } catch (e: any) {
        return refused([`The node could not pair (${e?.code || e?.message || 'error'}).`]);
    }
}

let pairTimer: ReturnType<typeof setInterval> | null = null;
let pairing = false;

/** The node's 2 s look for data/pair-request.json. On every role: a main server answers with its refusal. */
export function startPairRequestWatch(dir = dataDir()): void {
    if (pairTimer) return;
    pairTimer = setInterval(() => {
        if (pairing) return;
        const req = takePairRequestFile(dir);
        if (!req) return;
        pairing = true;
        void answerPairRequest(req, dir).then((answer) => {
            try { writeWhole(path.join(dir, PAIR_ANSWER_FILE), JSON.stringify(answer)); } catch (e: any) { console.warn(`[Standby] ${e?.message || e}`); }
        }).finally(() => { pairing = false; });
    }, 2000);
    pairTimer.unref?.();
}

export function stopPairRequestWatch(): void {
    if (pairTimer) clearInterval(pairTimer);
    pairTimer = null;
}

// ── The boot migration (D4) ────────────────────────────────────────────────────────────────

export type MigrationOutcome =
    | { kind: 'paired-already' }
    | { kind: 'not-a-standby' }
    | { kind: 'migrated'; from: 'audit-log' | 'mirror-link'; peerId: string }
    | { kind: 'unpaired'; why: string };

/** The mirror links connectors.json holds as written (before connector-manager.ts drops them), with their PeerIds. */
function mirrorLinksOnDisk(dir: string): { peerId: string | null }[] {
    try {
        const list = JSON.parse(fs.readFileSync(path.join(dir, 'connectors.json'), 'utf-8'));
        return (Array.isArray(list) ? list : [])
            .filter((c: any) => c && (c.trustLevel === 'mirror' || c.trustLevel === 'full_sync'))
            .map((c: any) => {
                const m = typeof c.address === 'string' ? c.address.match(/\/p2p\/([^/]+)$/) : null;
                return { peerId: m && isNodePeerId(m[1]) ? m[1] : null };
            });
    } catch {
        return [];
    }
}

/**
 * At the first start on this version, a standby with no pin: its own import record's newest signer (one row per accepted
 * import, the verified signer: engine/sync.ts recordSyncAudit; a local table, never copied), else its one `mirror` link
 * when it has taken a copy, else none (`standby.unpaired`). One write; a second boot finds the pin and writes nothing.
 * Never throws: a failure leaves the standby unpaired, which is loud.
 */
export async function migrateStandbyMainAtBoot(dir = dataDir()): Promise<MigrationOutcome> {
    const { logger } = await import('../logger.js');
    try {
        const { roleFromSettings } = await import('../config/node-role.js');
        if (roleFromSettings() !== 'backup') return { kind: 'not-a-standby' };
        if (readStandbyMain(dir)) return { kind: 'paired-already' };
        const { db } = await import('../db/db.js');
        const { getLocalConfig } = await import('../config/local-config.js');
        let communityId: string | null = null;
        try {
            const g = JSON.parse(fs.readFileSync(path.join(dir, 'genesis.json'), 'utf-8'));
            communityId = typeof g?.communityId === 'string' && COMMUNITY_ID.test(g.communityId) ? g.communityId : null;
        } catch { /* none */ }
        const url = originOf(getLocalConfig().backupPrimaryUrl || process.env.BACKUP_PRIMARY_URL || '');
        const pin = (peerId: string, from: 'audit-log' | 'mirror-link'): MigrationOutcome => {
            writeStandbyMain({ v: 1, peerId, communityId, url, pairedAt: Date.now(), how: 'migrated' }, dir);
            logger.security('P2P', `[Standby] Pinned this standby's main server ${peerId} from its ${from === 'audit-log' ? 'own record of the copies it took' : 'one mirror link and the copy it took'} (data/${STANDBY_MAIN_FILE})`);
            return { kind: 'migrated', from, peerId };
        };
        let newest: string | null = null;
        try {
            const row = db.prepare('SELECT origin_peer_id AS p FROM sync_audit_log ORDER BY id DESC LIMIT 1').get() as { p: string } | undefined;
            newest = row && isNodePeerId(row.p) ? row.p : null;
        } catch { /* no table yet */ }
        if (newest) return pin(newest, 'audit-log');
        const links = mirrorLinksOnDisk(dir);
        let copied = false;
        try {
            copied = !!db.prepare("SELECT 1 FROM sync_cursors WHERE peer_id = 'backup:primary'").get()
                || !!db.prepare("SELECT 1 FROM node_config WHERE key = 'replica_format'").get();
        } catch { copied = false; }
        if (links.length === 1 && links[0].peerId && copied) return pin(links[0].peerId, 'mirror-link');
        const why = links.length > 1 ? `${links.length} mirror links` : links.length === 1 ? (copied ? 'a mirror link without a key' : 'a mirror link, but no copy taken') : 'no mirror link';
        logger.security('P2P', `[Standby] This standby is not paired with a main server (${why}), so it copies nothing. `
            + 'On the main server make a pairing code under Replication Access, then on this server: docker compose exec beanpool-node beanpool pair');
        return { kind: 'unpaired', why };
    } catch (e: any) {
        logger.warn('P2P', `[Standby] The pin migration failed (${e?.message || e}): this standby stays unpaired`);
        return { kind: 'unpaired', why: 'error' };
    }
}
