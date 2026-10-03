/**
 * The claim code: how a node with no owner gets its first one (node sign-in design, step 8, stage A).
 *
 * A boot that finds no owner (nodeHasOwner) and no usable claim code makes one: `claim-` and 16 hex digits in four
 * groups, 64 random bits. It writes the code to data/claim-code.txt (0600, readable by the server's user only) and keeps
 * only its scrypt hash, a short public id and when it was made in local-config.json (`claim`). Never in the log, for
 * the reason the first admin password is not (config/local-config.ts): in Docker stdout is the container log.
 *
 * A phone key claims the node with it (routes/node-claim.ts): it signs `beanpool-claim/1`, the host it reached and the
 * code's id, and sends the code beside the signature. Right code, valid signature, still no owner: in one transaction the
 * key becomes a member (as an invite's joiner does, engine/members.ts registerMemberInternal) and the owner
 * (grantNodeRole, granted by `claim:<id>`). Then the code is burned and the file deleted.
 *
 * Additive for now: the admin password works exactly as before. A password-made first invite does NOT make an owner on a
 * fresh node (the SYSTEM rows already count as members, routes/community.ts), so the claim stays open until someone
 * holds an owner role, by this claim or by a grant.
 *
 * The hash is the break-glass code's (break-glass-code.ts): scrypt with Node's defaults over the SHA-256 of the code, a
 * fresh 32-byte salt. Each check is braked as a break-glass code is while the password brake holds its source
 * (admin-auth.ts BREAK_GLASS_WHILE_BRAKED_MS / _PER_MIN): at most one check per source every 10 s, and 30 a minute
 * across the node. Against 64 random bits that is hopeless online.
 *
 * Never blocks the boot: anything that fails here is logged, and the node starts without a claim code (the password
 * still works).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMember, isInvalidatedKey, isMemberKeySpelling, isVisitorKey } from '@beanpool/engine';
import { db } from './db/db.js';
import { getLocalConfig, updateLocalConfig, type LocalConfig } from './config/local-config.js';
import { assertPlainTablesWritable } from './config/node-role.js';
import { grantNodeRole, nodeHasOwner } from './engine/node-roles.js';
import { registerMemberInternal } from './engine/members.js';
import { BREAK_GLASS_WHILE_BRAKED_MS, BREAK_GLASS_WHILE_BRAKED_PER_MIN } from './admin-auth.js';
import { logger } from './logger.js';

export const CLAIM_CODE_FILE = 'claim-code.txt';
const SCRYPT_PREFIX = 'scrypt$';
const CODE_SHAPE = /^claim-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;
const ID_SHAPE = /^[0-9a-f]{8}$/;

type ClaimRecord = NonNullable<LocalConfig['claim']>;

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

export function claimCodePath(): string {
    return path.join(dataDir(), CLAIM_CODE_FILE);
}

/** The command that reads the file. The image keeps its data in /data (Dockerfile, docker-compose.yml). */
function readCommand(file: string): string {
    return dataDir() === '/data' ? `docker compose exec beanpool-node cat ${file}` : `cat ${file}`;
}

/** A new code, e.g. claim-a1b2-c3d4-e5f6-7890. */
export function generateClaimCode(): string {
    return `claim-${crypto.randomBytes(8).toString('hex').match(/.{4}/g)!.join('-')}`;
}

function normalise(code: string): string {
    return String(code).trim().toLowerCase();
}

/** Whether `code` has a claim code's shape. Only such a string is ever hashed. */
export function isClaimCodeShape(code: unknown): code is string {
    return typeof code === 'string' && CODE_SHAPE.test(normalise(code));
}

export function isClaimCodeId(id: unknown): id is string {
    return typeof id === 'string' && ID_SHAPE.test(id);
}

function digestOf(code: string): string {
    return crypto.createHash('sha256').update(normalise(code)).digest('hex');
}

export function hashClaimCode(code: string): string {
    const salt = crypto.randomBytes(32).toString('hex');
    return `${SCRYPT_PREFIX}${salt}$${crypto.scryptSync(digestOf(code), salt, 64).toString('hex')}`;
}

function parseRecord(stored: string): { salt: string; expected: Buffer } | null {
    if (typeof stored !== 'string' || !stored.startsWith(SCRYPT_PREFIX)) return null;
    const [salt, hash] = stored.slice(SCRYPT_PREFIX.length).split('$');
    if (!salt || !hash || !/^[0-9a-f]+$/.test(hash)) return null;
    return { salt, expected: Buffer.from(hash, 'hex') };
}

function codeMatchesSync(code: string, stored: string): boolean {
    const rec = parseRecord(stored);
    if (!rec || !isClaimCodeShape(code)) return false;
    const derived = crypto.scryptSync(digestOf(code), rec.salt, rec.expected.length);
    return crypto.timingSafeEqual(derived, rec.expected);
}

/** Check `code` against the stored hash, on the libuv threadpool, compared in constant time. */
export async function claimCodeMatches(code: string, stored: string): Promise<boolean> {
    const rec = parseRecord(stored);
    if (!rec || !isClaimCodeShape(code)) return false;
    const derived = await new Promise<Buffer | null>((resolve) => {
        crypto.scrypt(digestOf(code), rec.salt, rec.expected.length, (err, out) => resolve(err ? null : out));
    });
    return !!derived && derived.length === rec.expected.length && crypto.timingSafeEqual(derived, rec.expected);
}

/** The claim code still waiting to be used, if there is one. */
export function pendingClaim(config: LocalConfig = getLocalConfig()): ClaimRecord | null {
    const c = config.claim;
    return c && !c.claimedBy && typeof c.hash === 'string' && isClaimCodeId(c.id) ? c : null;
}

/** Flush a directory's entries where the filesystem allows it. */
function fsyncDir(dir: string): void {
    let fd: number | null = null;
    try {
        fd = fs.openSync(dir, 'r');
        fs.fsyncSync(fd);
    } catch { /* not every filesystem syncs a directory */ } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
    }
}

/** Whole or not at all: a fresh 0600 temp file renamed over the target. Throws naming the file, never the code. */
function writeClaimFile(code: string): void {
    const target = claimCodePath();
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        fs.mkdirSync(dataDir(), { recursive: true });
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try {
            fs.writeSync(fd, code + '\n');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, target);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* never made */ }
        throw new Error(`could not write ${target} (${(e as NodeJS.ErrnoException).code || 'error'})`);
    }
    fsyncDir(dataDir());
}

/** Delete the claim file, if there is one, and say so. */
export function removeClaimFile(why: string): void {
    const file = claimCodePath();
    try {
        fs.unlinkSync(file);
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') console.warn(`⚠️  ${why}, but ${file} could not be deleted (${code || 'error'}). It holds a claim code that no longer works: delete it by hand.`);
        return;
    }
    fsyncDir(dataDir());
    console.log(`🔑 ${why}: deleted ${file}, which held the claim code.`);
}

function readClaimFile(): string | null {
    try {
        return fs.readFileSync(claimCodePath(), 'utf-8').trim();
    } catch {
        return null;
    }
}

/**
 * At boot, after the database is open. An owner exists: no claim code, and any file left is deleted. No owner: the
 * waiting code is kept while its file still holds it; otherwise a new one is made. Never throws.
 */
export function initClaimCode(): void {
    try {
        const config = getLocalConfig();
        if (nodeHasOwner()) {
            if (pendingClaim(config)) updateLocalConfig({ claim: null });
            removeClaimFile('This community has an owner');
            return;
        }
        const file = claimCodePath();
        const pending = pendingClaim(config);
        if (pending) {
            const held = readClaimFile();
            if (held && codeMatchesSync(held, pending.hash)) {
                console.log(`🔑 This community has no owner yet. Its one-time claim code is in ${file}.`);
                console.log(`   Read it with: ${readCommand(file)}`);
                return;
            }
        }
        const code = generateClaimCode();
        const id = crypto.randomBytes(4).toString('hex');
        // The file first: if it cannot be written nothing is saved, and the next start tries again.
        writeClaimFile(code);
        const record: ClaimRecord = { hash: hashClaimCode(code), id, createdAt: Date.now() };
        updateLocalConfig({ claim: record });
        if (getLocalConfig().claim?.id !== id) {
            // saveLocalConfig logs a failed write and carries on: a file holding a code the node does not know is no use.
            fs.rmSync(file, { force: true });
            console.warn('⚠️  Could not save a claim code to local-config.json, so none was made. The next start tries again.');
            return;
        }
        console.log('');
        console.log('🔑 This community has no owner yet, so this server made a one-time claim code. It is not in this log.');
        console.log(`   It is in ${file}, which only the server's own user can read.`);
        console.log(`   Read it with: ${readCommand(file)}`);
        console.log('   The first phone to claim the community with it becomes its owner, and the code is burned.');
        console.log('');
    } catch (e) {
        console.warn(`⚠️  No claim code this start: ${(e as Error)?.message || e}. The node starts anyway; the admin password works as before.`);
    }
}

// ===================== THE BRAKE =====================
// As a break-glass code's while the password brake holds its source (admin-auth.ts admitBreakGlassWhileBraked): one
// check per source every BREAK_GLASS_WHILE_BRAKED_MS, BREAK_GLASS_WHILE_BRAKED_PER_MIN a minute across the node. Only
// a request that is about to cost an scrypt is counted.

const lastCheck = new Map<string, number>();
let nodeChecks: number[] = [];

/** 0 when `source` may have a code checked now; otherwise the seconds to wait. */
export function admitClaimCheck(source: string, now = Date.now()): number {
    const last = lastCheck.get(source);
    if (last !== undefined && now - last < BREAK_GLASS_WHILE_BRAKED_MS) return Math.ceil((BREAK_GLASS_WHILE_BRAKED_MS - (now - last)) / 1000);
    nodeChecks = nodeChecks.filter(t => now - t < 60_000);
    if (nodeChecks.length >= BREAK_GLASS_WHILE_BRAKED_PER_MIN) {
        return Math.max(1, Math.ceil((nodeChecks[0] + 60_000 - now) / 1000));
    }
    nodeChecks.push(now);
    lastCheck.delete(source);
    lastCheck.set(source, now);
    if (lastCheck.size > 10_000) lastCheck.delete(lastCheck.keys().next().value!);
    return 0;
}

export function resetClaimBrake(): void {
    lastCheck.clear();
    nodeChecks = [];
}

// ===================== THE CLAIM =====================

export type ClaimOutcome =
    | { ok: true; memberPubkey: string; callsign: string; role: 'owner'; created: boolean; again: boolean }
    | { ok: false; status: number; error: string; code: string; retryAfter?: number };

/** Granted-by marker on the owner row a claim makes. */
export function claimGrantor(id: string): string {
    return `claim:${id}`;
}

/** Whether `pubkey` is the owner this node's claim made (the retry of a claim whose answer was lost). */
export function claimedByThisKey(pubkey: string, config: LocalConfig = getLocalConfig()): boolean {
    const c = config.claim;
    if (!c || c.claimedBy !== pubkey || !isClaimCodeId(c.id)) return false;
    const row = db.prepare("SELECT 1 FROM node_roles WHERE member_pubkey = ? AND role = 'owner' AND granted_by = ?").get(pubkey, claimGrantor(c.id));
    return !!row;
}

/**
 * Make `pubkey` this node's first owner. The caller has checked the signature and the code. In one transaction: the
 * member row if there is none (an invite's join, with `claim:<id>` where the invite code goes), then the owner role,
 * granted by `claim:<id>`. Then the code is burned (local-config.json) and the file deleted. Refused once the node has
 * an owner: the database is what says so, so a code whose burn never reached the disk claims nothing a second time.
 */
export function claimNode(params: {
    broadcast: (event: any) => void;
    pubkey: string;
    callsign: string;
    claim: ClaimRecord;
    source: string;
}): ClaimOutcome {
    const { pubkey, claim } = params;
    assertPlainTablesWritable();
    if (isInvalidatedKey(db, pubkey)) {
        return { ok: false, status: 403, error: 'This key was replaced by a new one, so it cannot claim this community.', code: 'claim_key_replaced' };
    }
    const existing = getMember(db, pubkey);
    const visitor = !!existing && isVisitorKey(db, pubkey);
    if (existing && !visitor && existing.status !== 'active') {
        return { ok: false, status: 403, error: 'This key\'s account here is closed or suspended, so it cannot claim this community.', code: 'claim_member_inactive' };
    }
    let created = false;
    let callsign = existing && !visitor ? String(existing.callsign || '') : '';
    try {
        db.transaction(() => {
            if (nodeHasOwner()) {
                const err: any = new Error('claimed');
                err.claimed = true;
                throw err;
            }
            if (!existing || visitor) {
                const member = registerMemberInternal(params.broadcast, pubkey, params.callsign, null, claimGrantor(claim.id));
                if (!member) throw new Error('Registration failed');
                created = true;
                callsign = member.callsign;
            }
            grantNodeRole(pubkey, 'owner', claimGrantor(claim.id));
        })();
    } catch (e: any) {
        if (e?.claimed) return { ok: false, status: 409, error: 'This community already has an owner.', code: 'claim_already_claimed' };
        logger.warn('AUTH', `A claim with a right code failed: ${e?.message || e}`);
        return { ok: false, status: 400, error: String(e?.message || 'The claim failed'), code: 'claim_failed' };
    }
    const now = Date.now();
    updateLocalConfig({ claim: { ...claim, claimedBy: pubkey, claimedAt: now } });
    removeClaimFile('This community was claimed');
    logger.security('AUTH', `This community was CLAIMED with its one-time claim code ${claim.id} by @${callsign} (key ${pubkey.slice(0, 12)}…, from ${params.source}${created ? ', who joined with it' : ''}): they are its owner`);
    return { ok: true, memberPubkey: pubkey, callsign, role: 'owner', created, again: false };
}

/** The key as the community keeps keys (lower-case hex), or null. */
export function claimKey(raw: unknown): string | null {
    const key = String(raw ?? '').trim();
    return isMemberKeySpelling(key) ? key : null;
}
