/**
 * The claim code: how a node with no owner gets its first one (node sign-in design, step 8, stage A).
 *
 * A boot that finds no owner (nodeHasOwner) and no usable claim code makes one: `claim-` and 16 hex digits in four
 * groups, 64 random bits. It writes the code to data/claim-code.txt (0600, readable by the server's user only) and keeps
 * only K = scrypt(sha256(code), salt), the salt, a short public id and when it was made in local-config.json (`claim`).
 * Never in the log, for the reason the first admin password is not (config/local-config.ts): in Docker stdout is the
 * container log.
 *
 * A phone key claims the node with it (routes/node-claim.ts), claim v2: the code never crosses the wire. The phone
 * derives the same K from the code and the public salt (@beanpool/core claimKeyFromCode, the parameters in
 * CLAIM_SCRYPT) and sends HMAC(K, host, code id, its key) signed into `beanpool-claim/2`. Right proof, valid signature,
 * still no owner: in one transaction the key becomes a member (as an invite's joiner does, engine/members.ts
 * registerMemberInternal) and the owner (grantNodeRole, granted by `claim:<id>`). Then the code is burned, K and the
 * salt are deleted, and the file is deleted. The claim's answer carries no secret: a relaying server reads it.
 *
 * Additive for now: the admin password works exactly as before. A password-made first invite does NOT make an owner on a
 * fresh node (the SYSTEM rows already count as members, routes/community.ts), so the claim stays open until someone
 * holds an owner role, by this claim or by a grant.
 *
 * K is a secret: whoever holds it can claim while the node is unclaimed. It sits in the same 0600 data folder as the
 * code's file and stays out of backups and staging copies (local-config.ts). Checking a proof costs one HMAC, so there is
 * no node-wide cap for anyone to hold: a right proof is never braked. A wrong one makes its source wait 10 s
 * (BREAK_GLASS_WHILE_BRAKED_MS), which only sheds load: each guess costs the guesser an scrypt, against 64 random bits.
 *
 * Never blocks the boot: anything that fails here is logged, and the node starts without a claim code (the password
 * still works).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMember, isInvalidatedKey, isMemberKeySpelling, isVisitorKey } from '@beanpool/engine';
import { CLAIM_SCRYPT, claimProofText } from '@beanpool/core';
import { db } from './db/db.js';
import { getLocalConfig, updateLocalConfig, type LocalConfig } from './config/local-config.js';
import { assertPlainTablesWritable } from './config/node-role.js';
import { grantNodeRole, nodeHasOwner } from './engine/node-roles.js';
import { registerMemberInternal } from './engine/members.js';
import { BREAK_GLASS_WHILE_BRAKED_MS } from './admin-auth.js';
import { logger } from './logger.js';

export const CLAIM_CODE_FILE = 'claim-code.txt';
const CODE_SHAPE = /^claim-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;
const ID_SHAPE = /^[0-9a-f]{8}$/;
const PROOF_SHAPE = /^[0-9a-f]{64}$/;

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

/** Whether `code` has a claim code's shape. */
export function isClaimCodeShape(code: unknown): code is string {
    return typeof code === 'string' && CODE_SHAPE.test(normalise(code));
}

export function isClaimCodeId(id: unknown): id is string {
    return typeof id === 'string' && ID_SHAPE.test(id);
}

function digestOf(code: string): string {
    return crypto.createHash('sha256').update(normalise(code)).digest('hex');
}

/** K = scrypt(sha256(code), salt): byte for byte @beanpool/core claimKeyFromCode, which the phone runs. */
export function claimKeyOf(code: string, salt: string): Buffer {
    const { N, r, p, dkLen } = CLAIM_SCRYPT;
    return crypto.scryptSync(digestOf(code), salt, dkLen, { N, r, p });
}

/** Whether `proof` is HMAC(K, host, code id, key) for the waiting code, compared in constant time. */
export function claimProofMatches(claim: ClaimRecord, host: string, codeId: string, pubkey: string, proof: unknown): boolean {
    if (typeof proof !== 'string' || !PROOF_SHAPE.test(proof) || typeof claim.key !== 'string' || !PROOF_SHAPE.test(claim.key)) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(claim.key, 'hex')).update(claimProofText(host, codeId, pubkey)).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(proof, 'hex'));
}

/** The claim code still waiting to be used, if there is one. */
export function pendingClaim(config: LocalConfig = getLocalConfig()): ClaimRecord | null {
    const c = config.claim;
    return c && !c.claimedBy && typeof c.key === 'string' && PROOF_SHAPE.test(c.key) && typeof c.salt === 'string' && isClaimCodeId(c.id) ? c : null;
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
            if (held && isClaimCodeShape(held) && crypto.timingSafeEqual(claimKeyOf(held, pending.salt!), Buffer.from(pending.key!, 'hex'))) {
                console.log(`🔑 This community has no owner yet. Its one-time claim code is in ${file}.`);
                console.log(`   Read it with: ${readCommand(file)}`);
                return;
            }
        }
        const code = generateClaimCode();
        const id = crypto.randomBytes(4).toString('hex');
        // The file first: if it cannot be written nothing is saved, and the next start tries again.
        writeClaimFile(code);
        const salt = crypto.randomBytes(32).toString('hex');
        const record: ClaimRecord = { key: claimKeyOf(code, salt).toString('hex'), salt, id, createdAt: Date.now() };
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
// Only a wrong proof is braked, and only its own source: for BREAK_GLASS_WHILE_BRAKED_MS that source's next wrong proofs
// are 429 without a signature check or a log line. A right proof is checked before the brake and never waits for it,
// from any source, so no stranger can starve the owner of the claim.

const lastWrong = new Map<string, number>();

/** 0 when `source` sent no wrong proof in the last 10 s; otherwise the seconds left. */
export function claimBrakeWait(source: string, now = Date.now()): number {
    const last = lastWrong.get(source);
    return last !== undefined && now - last < BREAK_GLASS_WHILE_BRAKED_MS ? Math.ceil((BREAK_GLASS_WHILE_BRAKED_MS - (now - last)) / 1000) : 0;
}

/** `source` sent a wrong proof: brake it for 10 s. */
export function brakeClaimSource(source: string, now = Date.now()): void {
    lastWrong.delete(source);
    lastWrong.set(source, now);
    if (lastWrong.size > 10_000) lastWrong.delete(lastWrong.keys().next().value!);
}

export function resetClaimBrake(): void {
    lastWrong.clear();
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
 * Make `pubkey` this node's first owner. The caller has checked the signature and the proof. In one transaction: the
 * member row if there is none (an invite's join, with `claim:<id>` where the invite code goes), then the owner role,
 * granted by `claim:<id>`. Then the code is burned (local-config.json, K and the salt deleted) and the file deleted. Refused once the node has
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
        logger.warn('AUTH', `A claim with a right proof failed: ${e?.message || e}`);
        return { ok: false, status: 400, error: String(e?.message || 'The claim failed'), code: 'claim_failed' };
    }
    const now = Date.now();
    updateLocalConfig({ claim: { id: claim.id, createdAt: claim.createdAt, claimedBy: pubkey, claimedAt: now } });
    removeClaimFile('This community was claimed');
    logger.security('AUTH', `This community was CLAIMED with its one-time claim code ${claim.id} by @${callsign} (key ${pubkey.slice(0, 12)}…, from ${params.source}${created ? ', who joined with it' : ''}): they are its owner`);
    return { ok: true, memberPubkey: pubkey, callsign, role: 'owner', created, again: false };
}

/** The key as the community keeps keys (lower-case hex), or null. */
export function claimKey(raw: unknown): string | null {
    const key = String(raw ?? '').trim();
    return isMemberKeySpelling(key) ? key : null;
}
