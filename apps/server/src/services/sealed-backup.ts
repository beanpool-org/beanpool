/**
 * Sealed backups (`.bpsealed`) — sealed-keys.md §6 (Fable, 2026-09-19), slice 3.
 *
 * A backup is the tar.gz it always was — `state.db`, `node_config.json` — plus the take-over bundle
 * (`takeover-bundle.json`: node key, community key, genesis, connectors, admin and 2FA fields, roles, the public
 * address), streamed through a `bpseal/v1` envelope of kind `backup` locked to the same people as the take-over
 * envelope: every owner, plus the printed recovery code. One file restores a whole community, and nobody who
 * finds the file can read it.
 *
 * ## What never happens
 *
 * - A backup leaves this server unsealed, under any credential. With nobody to seal to (no owner and no code) the
 *   download is refused with the one action that fixes it (§9); there is no plaintext fallback.
 * - A restore trusts the archive inside the envelope. Opening only proves the file was locked to a key someone
 *   here holds; the tar inside goes through exactly the hostile-archive checks a legacy upload does.
 * - A restore takes a file signed by someone else when this server knows who should have signed it (966
 *   follow-up #2). A removed owner who kept a data key can forge an envelope that the remaining owners open
 *   cleanly; only the header signature against a pinned key tells the two apart. See {@link signerCheck}.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { peerIdFromString } from '@libp2p/peer-id';
import {
    sealEnvelopeStream, openEnvelopeStream, readSealedHeader, verifySealedHeader,
    type SealedEnvelopeHeader, type SealedEnvelopeKey, type CodeStanza,
} from '@beanpool/core';
import { getLocalConfig, redactLocalConfig } from '../config/local-config.js';
import { writeDbSnapshot } from './snapshot-scheduler.js';
import {
    readSealingInputs, readNodeIdentity, peerIdOfKeyFile, BUNDLED_FILES, BUNDLED_LOCAL_CONFIG_FIELDS,
    type TakeoverBundle,
} from './takeover-envelope.js';

const execFileAsync = promisify(execFile);

export const SEALED_BACKUP_EXT = '.bpsealed';
/** The take-over bundle's name inside the backup tar. */
export const BUNDLE_MEMBER = 'takeover-bundle.json';
/** Read from a file in 1 MiB pieces: one envelope chunk per read. */
const READ_PIECE = 1_048_576;

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

export function isGzip(firstBytes: Uint8Array): boolean {
    return firstBytes.length >= 2 && firstBytes[0] === 0x1f && firstBytes[1] === 0x8b;
}

/** Nothing to lock a backup to, or no node identity to sign it with. Nothing was produced. */
export class BackupNotSealableError extends Error {
    constructor(public readonly state: string, message: string) {
        super(message);
        this.name = 'BackupNotSealableError';
    }
}

export function sealedBackupFilename(prefix = 'beanpool-backup', at = new Date()): string {
    return `${prefix}-${at.toISOString().replace(/[:.]/g, '-').slice(0, 19)}${SEALED_BACKUP_EXT}`;
}

/** Who can open a file, from its public header — for a status line or a restore screen. */
export function describeSealedHeader(header: SealedEnvelopeHeader): {
    envelopeId: string; communityId: string; createdAt: string; sealedBy: string;
    owners: string[]; codeIds: number[]; opensWith: string;
} {
    const owners = header.recipients.filter((r) => r.type === 'owner').map((r) => (r as any).callsign as string);
    const codeIds = header.recipients.filter((r): r is CodeStanza => r.type === 'code').map((r) => r.codeId);
    const opensWith = [
        ...owners.map((c) => '@' + c),
        ...codeIds.map((id) => `recovery code #${id}`),
    ].join(', ');
    return {
        envelopeId: header.envelopeId, communityId: header.communityId, createdAt: header.createdAt,
        sealedBy: header.nodePeerId, owners, codeIds, opensWith,
    };
}

// ── Making one ─────────────────────────────────────────────────────────────────────────────

export interface SealedBackup {
    header: SealedEnvelopeHeader;
    filename: string;
    /** The sealed bytes, header first. Consume once. */
    body: Readable;
    /** Remove the staging files. Safe to call more than once. */
    cleanup(): void;
}

/**
 * Build and seal a backup. `dbFile` seals that SQLite file as the database (a snapshot being downloaded);
 * without it, a consistent copy of the live database is taken. Throws {@link BackupNotSealableError} when there is
 * nobody to lock it to; anything else that fails throws before a byte is produced, so a caller can still answer
 * with an error rather than a truncated file.
 */
export async function createSealedBackup(opts: { dbFile?: string; filenamePrefix?: string } = {}): Promise<SealedBackup> {
    const inputs = readSealingInputs();
    if (!inputs.ok) {
        const message = inputs.state === 'no-recipients'
            ? `Backups are locked to your community's owners, and ${inputs.message}. Make a recovery code (Settings), `
                + 'or make someone an owner, then download again.'
            : `A backup cannot be locked yet: ${inputs.message}.`;
        throw new BackupNotSealableError(inputs.state, message);
    }

    const work = path.join(dataDir(), `.backup-tmp-${crypto.randomBytes(6).toString('hex')}`);
    const stage = path.join(work, 'stage');
    const tarPath = path.join(work, 'backup.tar.gz');
    const cleanup = () => {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    try {
        fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
        // Only these three names go in the tar, so it never swallows data/snapshots/ or anything else in data/.
        const dbPath = path.join(stage, 'state.db');
        if (opts.dbFile) fs.copyFileSync(opts.dbFile, dbPath);
        else writeDbSnapshot(dbPath);
        const configPath = path.join(dataDir(), 'node_config.json');
        if (fs.existsSync(configPath)) {
            fs.copyFileSync(configPath, path.join(stage, 'node_config.json'));
        } else {
            // Without a standby's legacy plain-text admin password.
            fs.writeFileSync(path.join(stage, 'node_config.json'), JSON.stringify(redactLocalConfig(getLocalConfig()), null, 2));
        }
        fs.writeFileSync(path.join(stage, BUNDLE_MEMBER), JSON.stringify(inputs.bundle), { mode: 0o600 });
        // Async: gzip of a large database must not hold the event loop.
        await execFileAsync('tar', ['-czf', tarPath, '-C', stage, '.']);
        fs.rmSync(stage, { recursive: true, force: true });

        const sealed = sealEnvelopeStream(fs.createReadStream(tarPath, { highWaterMark: READ_PIECE }), {
            kind: 'backup',
            communityId: inputs.communityId,
            nodePeerId: inputs.identity.peerId,
            recipients: { owners: inputs.owners, codes: inputs.code ? [inputs.code] : [] },
            signingKey: inputs.identity.seed,
        });
        // Draw the header now: a sealing error surfaces here, before any response has started.
        const first = await sealed.next();
        if (first.done) throw new Error('The sealer produced no header.');
        const header = readSealedHeader(first.value);
        async function* all(): AsyncGenerator<Uint8Array> {
            try {
                yield first.value as Uint8Array;
                yield* sealed;
            } finally {
                cleanup();
            }
        }
        const body = Readable.from(all(), { objectMode: false });
        return { header, filename: sealedBackupFilename(opts.filenamePrefix), body, cleanup };
    } catch (e) {
        cleanup();
        throw e;
    }
}

// ── Reading one ────────────────────────────────────────────────────────────────────────────

/** The first bytes of a file (fewer if it is shorter). */
export function readFileStart(file: string, n: number): Buffer {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(n);
        const got = fs.readSync(fd, buf, 0, n, 0);
        return buf.subarray(0, got);
    } finally {
        fs.closeSync(fd);
    }
}

/** A sealed file's public header, reading only the header's bytes. Throws SealedEnvelopeError when it is not one. */
export function readSealedFileHeader(file: string): SealedEnvelopeHeader {
    const prefix = readFileStart(file, 4);
    const len = prefix.length === 4 ? prefix.readUInt32BE(0) : 0;
    // readSealedHeader enforces the 256 KiB cap; asking for a little more than that is harmless.
    return readSealedHeader(new Uint8Array(readFileStart(file, 4 + Math.min(len, 256 * 1024 + 1))));
}

/**
 * Open a sealed file into `outFile`, streaming. Everything written is untrusted until this resolves: a truncated
 * or altered file throws partway, and then `outFile` is removed.
 */
export async function openSealedFileTo(
    file: string, key: SealedEnvelopeKey, outFile: string,
): Promise<SealedEnvelopeHeader> {
    const { header, chunks } = await openEnvelopeStream(
        fs.createReadStream(file, { highWaterMark: READ_PIECE }), key, { kind: 'backup' },
    );
    try {
        await pipeline(Readable.from(chunks, { objectMode: false }), fs.createWriteStream(outFile, { mode: 0o600 }));
    } catch (e) {
        try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
        throw e;
    }
    return header;
}

/**
 * Seal an arbitrary local file (the harvester's seal-old pass, §6.4) and prove it re-opens to the same bytes
 * before returning. The data key lives in this function's memory only. Writes `outFile` atomically.
 */
export async function sealFileVerified(
    inFile: string, outFile: string,
    opts: { communityId: string; nodePeerId: string; signingKey: Uint8Array;
            recipients: { owners: { pubkey: string; callsign: string }[]; codes: any[] } },
): Promise<{ header: SealedEnvelopeHeader; sha256: string }> {
    let dataKey: Uint8Array | null = null;
    const tmp = `${outFile}.tmp-${process.pid}`;
    const inHash = crypto.createHash('sha256');
    try {
        const source = fs.createReadStream(inFile, { highWaterMark: READ_PIECE });
        source.on('data', (b) => inHash.update(b as Buffer));
        await pipeline(
            Readable.from(sealEnvelopeStream(source, { kind: 'backup', ...opts, onDataKey: (k) => { dataKey = k; } }), { objectMode: false }),
            fs.createWriteStream(tmp, { mode: 0o600 }),
        );
        const expected = inHash.digest('hex');
        if (!dataKey) throw new Error('the sealer did not hand back its data key');
        const { header, chunks } = await openEnvelopeStream(
            fs.createReadStream(tmp, { highWaterMark: READ_PIECE }), { type: 'dataKey', dataKey }, { kind: 'backup' },
        );
        const outHash = crypto.createHash('sha256');
        for await (const c of chunks) outHash.update(c);
        const got = outHash.digest('hex');
        if (got !== expected) throw new Error(`re-opened to different bytes (${got.slice(0, 12)} ≠ ${expected.slice(0, 12)})`);
        fs.renameSync(tmp, outFile);
        return { header, sha256: expected };
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        throw e;
    } finally {
        if (dataKey) (dataKey as Uint8Array).fill(0);
    }
}

// ── Who may have signed it ─────────────────────────────────────────────────────────────────

/**
 * The keys this server can hold a restore to (966 follow-up #2): its own node key when the file is from its own
 * community, and a standby's pinned main server (the `mirror` connector). A fresh server restoring someone's
 * community has none, and then opening is the whole proof, as §2.2 allows for an owner.
 */
export function restorePins(header: SealedEnvelopeHeader): string[] {
    const pins = new Set<string>();
    try {
        const genesis = JSON.parse(fs.readFileSync(path.join(dataDir(), 'genesis.json'), 'utf-8'));
        if (genesis?.communityId === header.communityId) {
            const me = readNodeIdentity();
            if (me) pins.add(me.peerId);
        }
    } catch { /* no genesis: no own pin */ }
    try {
        const connectors = JSON.parse(fs.readFileSync(path.join(dataDir(), 'connectors.json'), 'utf-8'));
        for (const c of Array.isArray(connectors) ? connectors : []) {
            if (c?.trustLevel !== 'mirror' || typeof c.address !== 'string') continue;
            const m = c.address.match(/\/p2p\/([^/]+)$/);
            if (m) pins.add(m[1]);
        }
    } catch { /* no connectors */ }
    return [...pins];
}

/** The Ed25519 public key a PeerId embeds, or null when it embeds none. */
function publicKeyOfPeerId(peerId: string): Uint8Array | null {
    try {
        const raw = (peerIdFromString(peerId) as any).publicKey?.raw as Uint8Array | undefined;
        return raw && raw.length === 32 ? raw : null;
    } catch {
        return null;
    }
}

export type SignerCheck =
    | { ok: true; pinned: boolean }
    | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Does the header's signature hold up? Always: it must verify against the key its own `nodePeerId` names — no
 * sealer this code ships writes anything else. Where this server has pins, the signer must also be one of them,
 * unless the operator has named that exact signer (`acceptSigner`): a backup the fleet manager locked (its
 * seal-old pass signs with its own key) is legitimate, and the screen asks rather than refuses.
 */
export function signerCheck(header: SealedEnvelopeHeader, acceptSigner?: string | null): SignerCheck {
    const signerKey = publicKeyOfPeerId(header.nodePeerId);
    if (!signerKey || !verifySealedHeader(header, signerKey)) {
        return {
            ok: false, status: 400,
            body: { error: 'This backup file has been altered: its signature does not match the server it names.', badSignature: true },
        };
    }
    const pins = restorePins(header);
    if (pins.length === 0) return { ok: true, pinned: false };
    if (pins.includes(header.nodePeerId)) return { ok: true, pinned: true };
    if (acceptSigner && acceptSigner === header.nodePeerId) return { ok: true, pinned: false };
    return {
        ok: false, status: 409,
        body: {
            error: `This backup of your community was locked by ${header.nodePeerId}, not by this community's server. `
                + "If you know that machine (the fleet manager locks old backups with its own key), restore again and "
                + 'confirm it by name. Otherwise do not restore it: someone who once held a key may have made it.',
            signerNotPinned: true,
            signer: header.nodePeerId,
            pins,
        },
    };
}

// ── Applying the bundle on restore (§6.2 step 3, §5.4 step 3) ──────────────────────────────

/** Read and check the bundle from an extracted backup. Returns null when the backup has none (a legacy tar, or a
 *  harvester-sealed old database). Throws when it is there and wrong. */
export function readBundleFrom(extractDir: string, header: SealedEnvelopeHeader | null): TakeoverBundle | null {
    const p = path.join(extractDir, BUNDLE_MEMBER);
    if (!fs.existsSync(p)) return null;
    if (!fs.lstatSync(p).isFile()) throw new Error(`Invalid backup archive: ${BUNDLE_MEMBER} is not a file`);
    let bundle: TakeoverBundle;
    try {
        bundle = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
        throw new Error(`Invalid backup archive: ${BUNDLE_MEMBER} is not readable`);
    }
    if (bundle?.v !== 1 || !bundle.files || typeof bundle.files !== 'object' || !bundle.localConfig) {
        throw new Error(`Invalid backup archive: ${BUNDLE_MEMBER} is not a version 1 bundle`);
    }
    for (const f of BUNDLED_FILES) {
        const v = (bundle.files as any)[f];
        if (v !== null && v !== undefined && (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v))) {
            throw new Error(`Invalid backup archive: the bundle's ${f} is not base64`);
        }
    }
    const genesisB64 = bundle.files['genesis.json'];
    if (!genesisB64) throw new Error('Invalid backup archive: the bundle has no genesis.json');
    let genesis: any;
    try { genesis = JSON.parse(Buffer.from(genesisB64, 'base64').toString('utf-8')); } catch { genesis = null; }
    if (!genesis?.communityId) throw new Error('Invalid backup archive: the bundle\'s genesis.json is unreadable');
    const keyB64 = bundle.files.libp2p_key;
    if (!keyB64) throw new Error('Invalid backup archive: the bundle has no node key');
    let bundlePeerId: string;
    try {
        bundlePeerId = peerIdOfKeyFile(Buffer.from(keyB64, 'base64'));
    } catch {
        throw new Error('Invalid backup archive: the bundle\'s node key is not an Ed25519 key');
    }
    if (header) {
        // The bundle belongs to the server that sealed the file, and to the community the header names.
        if (genesis.communityId !== header.communityId) {
            throw new Error('Invalid backup archive: the bundle is from a different community than the file says');
        }
        if (bundlePeerId !== header.nodePeerId) {
            throw new Error('Invalid backup archive: the bundle\'s node key is not the key that locked the file');
        }
    }
    return bundle;
}

function writeAtomic(file: string, data: Buffer, mode: number): void {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
}

/**
 * Write the bundle's identity files and admin fields into this server's data dir. The database already carries
 * the roles and the public address (they are rows in state.db). Names come from the fixed list, never the file.
 * Returns what was written, for the log.
 */
export function applyBundle(bundle: TakeoverBundle): string[] {
    const dir = dataDir();
    const written: string[] = [];
    for (const f of BUNDLED_FILES) {
        const b64 = bundle.files[f];
        if (!b64) continue;
        writeAtomic(path.join(dir, f), Buffer.from(b64, 'base64'), f === 'genesis.json' || f === 'connectors.json' ? 0o644 : 0o600);
        written.push(f);
    }
    // local-config.json: the community's admin and 2FA credentials, and its recovery code's public record, so this
    // server signs owners in with the community's password and keeps locking to the same paper. Everything else
    // in this server's config (its own replication token, callsign, gateway) stays.
    const configPath = path.join(dir, 'local-config.json');
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { config = {}; }
    for (const f of BUNDLED_LOCAL_CONFIG_FIELDS) config[f] = (bundle.localConfig as any)[f] ?? null;
    if (bundle.recoveryCode) {
        config.recoveryCode = bundle.recoveryCode;
        config.recoveryCodeLastId = Math.max(Number(config.recoveryCodeLastId) || 0, bundle.recoveryCode.codeId);
    }
    writeAtomic(configPath, Buffer.from(JSON.stringify(config, null, 2)), 0o600);
    written.push('local-config.json (admin, 2FA, recovery code record)');
    return written;
}
