import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
    isVaultClientCopy,
    isVaultKeyHex,
    isVaultPushToken,
    newVaultTicket,
    openVaultDepositBox,
    openWithX25519,
    sealVaultRelease,
    signVaultTicket,
    vaultB64,
    vaultUnb64,
    type SealedShare,
    type VaultSealedBox,
    type VaultTicketPurpose,
} from '@beanpool/core';
import {
    genesisStatement,
    proposalHash,
    restoreStatement,
    sealCustodianShare,
    SHARE_TAG,
    shareAad,
    shareStatement,
    textHash,
    unlockBind,
    verifyStatement,
    type CustodianShare,
    type ShareSubmission,
    type UnlockHello,
} from '../shared/ceremony.js';
import {
    BACKUP_BODY_AAD,
    BACKUP_DELETIONS_AAD,
    BACKUP_MAGIC,
    BACKUP_NAME_RE,
    BACKUP_SIG_TAG,
    parseBackupFile,
    type BackupHeader,
} from '../shared/backup-format.js';
import { isVaultProvider } from '../shared/providers.js';
import { noneAttestor, type Attestor } from './attestor.js';
import { asStateFile, openState, readStateFile, sealState, WorkingKeys, writeStateFile, type VaultStateFile } from './keys.js';
import { combineMnemonics, decodeShare, splitMasterSecret } from './slip39.js';

/**
 * vault-keyholder (key vault design §3): the shares, `M` and the working keys, and nothing else. It never hands out a
 * key. What it does with them is this list and no more:
 *
 *   index       HMAC(K_index, ...): a copy's `sub_index` and `pk_index`
 *   wrap        a copy's envelope under K_wrap, from a deposit box it opens itself (`depositWrap`), or with its
 *               push tokens or release time changed (`updateMeta`); the API reads everything but the copy (`readMeta`)
 *   release     unwrap a copy and seal it to the restoring device's key: the only way a copy leaves
 *   ticket      sign a ticket, and the daily report
 *   backup      seal and open backups
 *
 * and the ceremonies: genesis, unlock, reshare, taking a backup's state into a fresh vault.
 *
 * States: `fresh` (no state file: waiting for a genesis or a restore), `locked` (a state file, no `M`), `open`
 * (working keys in memory). Any restart is `locked` until two custodians unlock it (design §2.3).
 */

export class KeyholderError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = 'KeyholderError';
    }
}

export type KeyholderState = 'fresh' | 'locked' | 'open';

export interface KeyholderOptions {
    /** Holds `state.json`. Off the data partition, since it holds the key to it (V3 decides where). */
    stateDir: string;
    /** The three custodian keys a genesis (or a restore into a fresh vault) is accepted from. Pinned in the image (V3). */
    genesisCustodians: string[];
    clock?: () => number;
    attestor?: Attestor;
    /** What `/v1/unlock/hello` reports; V3's release check fills it. */
    releaseHash?: string;
    /** SLIP-0039 iteration exponent for new shares. */
    iterationExponent?: number;
}

/** A copy's row as the API holds it: every field base64url. */
export interface RowRef {
    id: string;
    subIndex: string;
    pkIndex: string;
    envelope?: string;
}

export interface CopyMeta {
    provider: string;
    pubkey: string;
    pushTokens: string[];
    lastReleasedAt: number | null;
    wrapVersion: number;
}

interface EnvelopeContents {
    provider: string;
    pubkey: string;
    clientCopy: SealedShare;
    pushTokens: string[];
    lastReleasedAt: number | null;
}

/** Push tokens kept per copy: a member's devices, newest first. */
export const MAX_PUSH_TOKENS = 5;
const ENVELOPE_TAG = Buffer.from('beanpool-vault-envelope/1');
const REPORT_TAG = 'beanpool-vault-report/1\n';
const DELETIONS_INFO = Buffer.from('beanpool-vault-deletions/1');
const BODY_INFO = Buffer.from('beanpool-vault-backup-body/1');
const RESTORE_PENDING_FILE = 'restore-pending.json';
const ROW_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

function fail(code: string, message: string): never {
    throw new KeyholderError(code, message);
}

function bytes32(value: unknown, what: string): Buffer {
    const b = vaultUnb64(value, 32);
    if (!b || b.length !== 32) fail('bad_request', `${what} is not 32 bytes of base64url.`);
    return Buffer.from(b);
}

export class Keyholder {
    private state: KeyholderState;
    private since: number;
    private stateFile: VaultStateFile | null;
    private keys: WorkingKeys | null = null;
    private readonly bootId = crypto.randomBytes(16);
    private helloSecret = Buffer.alloc(32);
    private helloPub = Buffer.alloc(32);
    private collected = new Map<string, string>();
    private collecting: { purpose: string; proposal: string; newCustodians?: string[] } | null = null;
    private lastError: string | null = null;
    private readonly clock: () => number;
    private readonly attestor: Attestor;
    private readonly genesisCustodians: string[];

    constructor(private readonly opts: KeyholderOptions) {
        this.clock = opts.clock ?? (() => Date.now());
        this.attestor = opts.attestor ?? noneAttestor;
        this.genesisCustodians = [...opts.genesisCustodians];
        this.stateFile = readStateFile(opts.stateDir);
        this.state = this.stateFile ? 'locked' : 'fresh';
        this.since = this.clock();
        this.newHelloKey();
    }

    // ─── State ─────────────────────────────────────────────────────────────────────────────

    private newHelloKey(): void {
        this.helloSecret.fill(0);
        this.helloSecret = Buffer.alloc(32);
        crypto.randomFillSync(this.helloSecret);
        this.helloPub = Buffer.from(x25519.getPublicKey(this.helloSecret));
    }

    private setState(state: KeyholderState): void {
        this.state = state;
        this.since = this.clock();
    }

    private dropCollected(): void {
        this.collected.clear();
        this.collecting = null;
    }

    private requireOpen(): WorkingKeys {
        if (this.state !== 'open' || !this.keys) fail('locked', 'The vault is locked.');
        return this.keys;
    }

    private get bootIdB64(): string {
        return vaultB64(this.bootId);
    }

    private get helloPubB64(): string {
        return vaultB64(this.helloPub);
    }

    status() {
        const keys = this.state === 'open' ? this.keys : null;
        return {
            state: this.state,
            since: this.since,
            bootId: this.bootIdB64,
            vaultId: this.stateFile?.vaultId ?? null,
            generation: this.stateFile?.generation ?? null,
            custodians: this.stateFile?.custodians ?? this.genesisCustodians,
            threshold: this.stateFile?.threshold ?? 2,
            sharesPresent: this.collected.size,
            collecting: this.collecting?.purpose ?? null,
            lastError: this.lastError,
            platform: this.attestor.platform,
            releaseHash: this.opts.releaseHash ?? 'unreleased',
            restorePending: existsSync(path.join(this.opts.stateDir, RESTORE_PENDING_FILE)),
            publicKeys: keys ? { ticket: keys.ticketPublicKeys, deposit: keys.depositPublicKeys } : null,
            wrapVersion: keys ? keys.wrap[0].version : null,
        };
    }

    /** Forget everything held in memory, as a restart would (SIGTERM, and tests). */
    lock(): void {
        this.keys?.wipe();
        this.keys = null;
        this.dropCollected();
        this.newHelloKey();
        if (this.state === 'open') this.setState('locked');
    }

    // ─── Ceremonies ────────────────────────────────────────────────────────────────────────

    /** The hello (host design §5.1): this boot's id and hello key, and the evidence bound to the custodian's nonce. */
    async hello(custodianNonce: unknown): Promise<UnlockHello> {
        const nonce = bytes32(custodianNonce, 'custodianNonce');
        const bind = unlockBind(this.helloPub, this.bootId, nonce);
        const evidence = await this.attestor.evidence(bind);
        return {
            bootId: this.bootIdB64,
            helloPub: this.helloPubB64,
            releaseHash: this.opts.releaseHash ?? 'unreleased',
            platform: this.attestor.platform,
            evidence: evidence ? vaultB64(evidence) : null,
        };
    }

    private validCustodianSet(keys: unknown): keys is string[] {
        return Array.isArray(keys) && keys.length === 3 && keys.every(isVaultKeyHex) && new Set(keys).size === 3;
    }

    /**
     * Genesis, once (design §2.1): a new `M` in memory, the working keys under it, and one share for each pinned
     * custodian, sealed to that custodian's key. `M` is wiped before this returns; the vault is open.
     */
    genesis(args: { custodian: unknown; sig: unknown }) {
        if (this.state !== 'fresh') fail('already_set_up', 'This vault already has its keys.');
        if (!this.validCustodianSet(this.genesisCustodians)) fail('no_custodians', 'This keyholder has no three custodian keys pinned.');
        const custodian = String(args.custodian);
        if (!this.genesisCustodians.includes(custodian)) fail('unknown_custodian', 'That key is not one of this vault\'s custodians.');
        if (!verifyStatement(custodian, genesisStatement(this.bootIdB64, this.helloPubB64), args.sig)) {
            fail('bad_signature', 'The genesis request is not signed by that custodian for this boot.');
        }
        const m = crypto.randomBytes(32);
        const keys = WorkingKeys.fresh(1);
        try {
            const header = { v: 1 as const, vaultId: vaultB64(crypto.randomBytes(16)), generation: 1, custodians: [...this.genesisCustodians], threshold: 2 };
            const file = sealState(m, header, keys);
            const mnemonics = splitMasterSecret(m, { threshold: 2, count: 3, iterationExponent: this.opts.iterationExponent });
            writeStateFile(this.opts.stateDir, file);
            const custodianShares = mnemonics.map((words, i) => sealCustodianShare(words, header.custodians[i], header.vaultId, 1, i + 1));
            this.stateFile = file;
            this.keys = keys;
            this.lastError = null;
            this.setState('open');
            this.newHelloKey();
            return { vaultId: header.vaultId, generation: 1, custodianShares, publicKeys: { ticket: keys.ticketPublicKeys, deposit: keys.depositPublicKeys } };
        } catch (e) {
            if (this.keys !== keys) keys.wipe();
            throw e;
        } finally {
            m.fill(0);
        }
    }

    /**
     * A fresh vault takes a backup's state (design §4's cold path). It is then locked until two custodians unlock it
     * with the shares for that backup's `M`; after that {@link openBackup} opens only the backup named here.
     */
    adoptState(args: { custodian: unknown; sig: unknown; backupName: unknown; state: unknown }): void {
        if (this.state !== 'fresh') fail('already_set_up', 'This vault already has its keys.');
        const state = asStateFile(args.state);
        if (!state) fail('bad_request', 'That is not a vault state.');
        const backupName = String(args.backupName);
        if (!BACKUP_NAME_RE.test(backupName)) fail('bad_request', 'That is not a backup name.');
        const custodian = String(args.custodian);
        if (!this.genesisCustodians.includes(custodian) && !state.custodians.includes(custodian)) {
            fail('unknown_custodian', 'That key is not one of this vault\'s custodians.');
        }
        if (!verifyStatement(custodian, restoreStatement(this.bootIdB64, this.helloPubB64, backupName), args.sig)) {
            fail('bad_signature', 'The restore request is not signed by that custodian for this boot.');
        }
        mkdirSync(this.opts.stateDir, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(this.opts.stateDir, RESTORE_PENDING_FILE),
            `${JSON.stringify({ backupName, stateHash: textHash(JSON.stringify(state)) })}\n`, { mode: 0o600 });
        writeStateFile(this.opts.stateDir, state);
        this.stateFile = state;
        this.setState('locked');
    }

    /**
     * One custodian's share, for an unlock (while locked) or a reshare (while open). Shares are held in memory until
     * the threshold; then `M` is rebuilt, checked, used and wiped, with the shares. A share from a key that isn't a
     * custodian, or not signed for this boot, changes nothing.
     */
    submitShare(raw: unknown) {
        const sub = raw as ShareSubmission;
        if (!sub || typeof sub !== 'object' || (sub.purpose !== 'unlock' && sub.purpose !== 'reshare')) fail('bad_request', 'Not a share.');
        if (sub.purpose === 'unlock' && this.state !== 'locked') {
            fail(this.state === 'open' ? 'open' : 'fresh', this.state === 'open' ? 'The vault is already open.' : 'This vault has no keys yet.');
        }
        if (sub.purpose === 'reshare' && this.state !== 'open') fail('locked', 'A reshare needs the vault open.');
        const file = this.stateFile;
        if (!file) fail('fresh', 'This vault has no keys yet.');
        const custodian = String(sub.custodian);
        if (!file.custodians.includes(custodian)) fail('unknown_custodian', 'That key is not one of this vault\'s custodians.');
        const proposal = String(sub.proposal);
        const box = sub.box as VaultSealedBox;
        if (!box || typeof box !== 'object') fail('bad_request', 'The share has no box.');
        if (!verifyStatement(custodian, shareStatement(sub.purpose, this.bootIdB64, this.helloPubB64, proposal, box), sub.sig)) {
            fail('bad_signature', 'The share is not signed by that custodian for this boot.');
        }
        let newCustodians: string[] | undefined;
        if (sub.purpose === 'unlock') {
            if (proposal !== '-') fail('bad_request', 'An unlock share names no proposal.');
        } else {
            if (!this.validCustodianSet(sub.newCustodians)) fail('bad_request', 'A reshare names three different custodian keys.');
            newCustodians = [...sub.newCustodians];
            if (proposalHash({ custodians: newCustodians }) !== proposal) fail('bad_request', 'The reshare proposal does not match its custodians.');
        }
        let words: string;
        try {
            words = new TextDecoder().decode(openWithX25519(this.helloSecret, box, SHARE_TAG, shareAad(sub.purpose, this.bootIdB64, custodian, proposal), 4096));
            decodeShare(words);
        } catch {
            fail('bad_share', 'The share did not open with this boot\'s hello key, or is not a SLIP-0039 share.');
        }
        if (this.collecting && (this.collecting.purpose !== sub.purpose || this.collecting.proposal !== proposal)) {
            fail('proposal_mismatch', 'Another custodian started a different ceremony. Finish or restart that one first.');
        }
        this.collecting = { purpose: sub.purpose, proposal, newCustodians };
        this.collected.set(custodian, words);
        if (this.collected.size < file.threshold) {
            return { state: this.state, sharesPresent: this.collected.size, threshold: file.threshold };
        }

        const mnemonics = [...this.collected.values()];
        const purpose = sub.purpose;
        this.dropCollected();
        this.newHelloKey();
        let m: Buffer;
        try {
            m = combineMnemonics(mnemonics);
        } catch {
            this.lastError = 'bad_shares';
            return { state: this.state, sharesPresent: 0, threshold: file.threshold, error: 'bad_shares' };
        }
        try {
            const opened = openState(m, file);
            if (!opened.ok) {
                this.lastError = opened.reason;
                return { state: this.state, sharesPresent: 0, threshold: file.threshold, error: opened.reason };
            }
            if (purpose === 'unlock') {
                this.keys = opened.keys;
                this.lastError = null;
                this.setState('open');
                return { state: this.state, sharesPresent: 0, threshold: file.threshold };
            }
            opened.keys.wipe();
            this.lastError = null;
            return { state: this.state, sharesPresent: 0, threshold: file.threshold, ...this.reshare(newCustodians as string[]) };
        } finally {
            m.fill(0);
        }
    }

    /**
     * A reshare (design §2.4), after two current shares proved two custodians agree: a new `M`, the working keys under
     * it with a new K_wrap (the old ones stay in `DK` so envelopes not yet re-wrapped still open) and a new K_backup,
     * and three new shares for `newCustodians`. K_index, the ticket and deposit keys stay: the apps pin the last two.
     *
     * K_disk stays too. On V3's image it is the data partition's LUKS key, and changing it there is a keyslot change
     * V3 makes in the same step; until then it has no disk to open.
     */
    private reshare(newCustodians: string[]) {
        const keys = this.requireOpen();
        const file = this.stateFile as VaultStateFile;
        const copy = (b: Buffer) => Buffer.from(b);
        const nextVersion = Math.max(...keys.wrap.map(w => w.version)) + 1;
        const fresh = WorkingKeys.fresh(file.generation + 1);
        const next = new WorkingKeys(
            file.generation + 1, copy(keys.kIndex), copy(keys.kDisk), fresh.kBackup,
            [{ version: nextVersion, key: fresh.wrap[0].key }, ...keys.wrap.map(w => ({ version: w.version, key: copy(w.key) }))],
            keys.ticketSeeds.map(copy), keys.depositSecrets.map(copy),
        );
        fresh.kIndex.fill(0);
        fresh.kDisk.fill(0);
        for (const b of [...fresh.ticketSeeds, ...fresh.depositSecrets]) b.fill(0);
        const m = crypto.randomBytes(32);
        try {
            const header = { v: 1 as const, vaultId: file.vaultId, generation: file.generation + 1, custodians: newCustodians, threshold: 2 };
            const nextFile = sealState(m, header, next);
            const mnemonics = splitMasterSecret(m, { threshold: 2, count: 3, iterationExponent: this.opts.iterationExponent });
            writeStateFile(this.opts.stateDir, nextFile);
            keys.wipe();
            this.keys = next;
            this.stateFile = nextFile;
            const custodianShares: CustodianShare[] = mnemonics.map((words, i) =>
                sealCustodianShare(words, newCustodians[i], file.vaultId, header.generation, i + 1));
            return { generation: header.generation, custodianShares, wrapVersion: nextVersion };
        } catch (e) {
            if (this.keys !== next) next.wipe();
            throw e;
        } finally {
            m.fill(0);
        }
    }

    // ─── Copies ────────────────────────────────────────────────────────────────────────────

    private hmacIndex(keys: WorkingKeys, parts: (string | Uint8Array)[]): string {
        const h = crypto.createHmac('sha256', keys.kIndex);
        parts.forEach((p, i) => {
            if (i) h.update(Buffer.from([0]));
            h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
        });
        return vaultB64(h.digest());
    }

    /** `sub_index = HMAC(K_index, "sub" ‖ provider ‖ sub)` or `pk_index = HMAC(K_index, "pk" ‖ memberPubkey)`. */
    index(args: { kind?: unknown; provider?: unknown; sub?: unknown; key?: unknown }): string {
        const keys = this.requireOpen();
        if (args.kind === 'sub') {
            if (!isVaultProvider(args.provider)) fail('bad_request', 'Not a provider this vault keeps copies for.');
            if (typeof args.sub !== 'string' || !args.sub || args.sub.length > 256) fail('bad_request', 'Not a sign-in subject.');
            return this.hmacIndex(keys, ['sub', args.provider, args.sub]);
        }
        if (args.kind === 'pk') {
            if (!isVaultKeyHex(args.key)) fail('bad_request', 'Not a member key.');
            return this.hmacIndex(keys, ['pk', Buffer.from(args.key, 'hex')]);
        }
        fail('bad_request', 'An index is of a sub or a key.');
    }

    private rowAad(row: RowRef): Buffer {
        if (typeof row?.id !== 'string' || !ROW_ID_RE.test(row.id)) fail('bad_request', 'Not a row id.');
        return Buffer.concat([ENVELOPE_TAG, Buffer.from([0]), Buffer.from(row.id), Buffer.from([0]),
            bytes32(row.subIndex, 'subIndex'), bytes32(row.pkIndex, 'pkIndex')]);
    }

    private wrapEnvelope(keys: WorkingKeys, row: RowRef, contents: EnvelopeContents): string {
        const current = keys.wrap[0];
        const plain = Buffer.from(JSON.stringify(contents), 'utf8');
        const nonce = crypto.randomBytes(24);
        const head = Buffer.alloc(5);
        head[0] = 1;
        head.writeUInt32BE(current.version, 1);
        try {
            const ct = xchacha20poly1305(current.key, nonce, this.rowAad(row)).encrypt(plain);
            return vaultB64(Buffer.concat([head, nonce, ct]));
        } finally {
            plain.fill(0);
        }
    }

    private unwrapEnvelope(keys: WorkingKeys, row: RowRef): { contents: EnvelopeContents; version: number } {
        const env = vaultUnb64(row.envelope, 32 * 1024);
        if (!env || env.length < 5 + 24 + 16 || env[0] !== 1) fail('bad_envelope', 'Not an envelope.');
        const version = Buffer.from(env).readUInt32BE(1);
        const key = keys.wrapKey(version);
        if (!key) fail('bad_envelope', 'The envelope is under a wrap key this vault no longer has.');
        let plain: Uint8Array;
        try {
            plain = xchacha20poly1305(key, env.subarray(5, 29), this.rowAad(row)).decrypt(env.subarray(29));
        } catch {
            fail('bad_envelope', 'The envelope does not open for this row.');
        }
        try {
            const c = JSON.parse(Buffer.from(plain).toString('utf8')) as EnvelopeContents;
            return { contents: c, version };
        } finally {
            plain.fill(0);
        }
    }

    /**
     * A deposit: open the member's box (sealed to the deposit key for this member key and provider) and wrap its copy
     * into the row's envelope. The indexes are recomputed here from the sub and the key, so an envelope always sits in
     * the row its own sub and key name. `carry` is the member's own earlier envelope for the same sign-in account:
     * its push tokens and last release time move to the new one.
     */
    depositWrap(args: { id?: unknown; provider?: unknown; sub?: unknown; memberKey?: unknown; box?: unknown; carry?: RowRef | null }) {
        const keys = this.requireOpen();
        if (!isVaultProvider(args.provider)) fail('bad_request', 'Not a provider this vault keeps copies for.');
        if (!isVaultKeyHex(args.memberKey)) fail('bad_request', 'Not a member key.');
        const provider = args.provider;
        const memberKey = args.memberKey;
        const row: RowRef = {
            id: String(args.id),
            subIndex: this.index({ kind: 'sub', provider, sub: args.sub }),
            pkIndex: this.index({ kind: 'pk', key: memberKey }),
        };
        const box = args.box as VaultSealedBox;
        const secret = keys.depositSecretFor(box?.kid);
        if (!secret) fail('bad_box', 'The deposit box is sealed to a key this vault does not have.');
        let contents;
        try {
            contents = openVaultDepositBox(box, secret, memberKey, provider);
        } catch {
            fail('bad_box', 'The deposit box does not open for this key and provider.');
        }
        let pushTokens = contents.pushToken ? [contents.pushToken] : [];
        let lastReleasedAt: number | null = null;
        if (args.carry) {
            const old = this.unwrapEnvelope(keys, args.carry).contents;
            if (old.pubkey === memberKey) {
                pushTokens = [...new Set([...pushTokens, ...old.pushTokens])].slice(0, MAX_PUSH_TOKENS);
                lastReleasedAt = old.lastReleasedAt;
            }
        }
        const envelope = this.wrapEnvelope(keys, row, { provider, pubkey: memberKey, clientCopy: contents.clientCopy, pushTokens, lastReleasedAt });
        return { ...row, envelope, pushTokens: pushTokens.length };
    }

    /** Everything in an envelope but the copy. */
    readMeta(args: { row?: RowRef }): CopyMeta {
        const keys = this.requireOpen();
        const { contents: c, version } = this.unwrapEnvelope(keys, args.row as RowRef);
        return { provider: c.provider, pubkey: c.pubkey, pushTokens: [...c.pushTokens], lastReleasedAt: c.lastReleasedAt, wrapVersion: version };
    }

    /** The envelope with a push token added (newest first) and/or the last release time set, under the current K_wrap. */
    updateMeta(args: { row?: RowRef; addPushToken?: unknown; lastReleasedAt?: unknown }) {
        const keys = this.requireOpen();
        const row = args.row as RowRef;
        const { contents } = this.unwrapEnvelope(keys, row);
        if (args.addPushToken !== undefined) {
            if (!isVaultPushToken(args.addPushToken)) fail('bad_request', 'That is not an Expo push token.');
            contents.pushTokens = [args.addPushToken, ...contents.pushTokens.filter(t => t !== args.addPushToken)].slice(0, MAX_PUSH_TOKENS);
        }
        if (args.lastReleasedAt !== undefined) {
            if (!Number.isSafeInteger(args.lastReleasedAt)) fail('bad_request', 'Not a time.');
            contents.lastReleasedAt = args.lastReleasedAt as number;
        }
        return { envelope: this.wrapEnvelope(keys, row, contents) };
    }

    /** The envelope under the current K_wrap (after a reshare), or unchanged when it already is. */
    rewrap(args: { row?: RowRef }) {
        const keys = this.requireOpen();
        const row = args.row as RowRef;
        const { contents, version } = this.unwrapEnvelope(keys, row);
        if (version === keys.wrap[0].version) return { envelope: row.envelope as string, changed: false };
        return { envelope: this.wrapEnvelope(keys, row, contents), changed: true };
    }

    /** The only way a copy leaves: sealed to the restoring device's key, which the ticket named. */
    release(args: { row?: RowRef; requesterKey?: unknown }) {
        const keys = this.requireOpen();
        if (!isVaultKeyHex(args.requesterKey)) fail('bad_request', 'Not a restoring key.');
        const { contents } = this.unwrapEnvelope(keys, args.row as RowRef);
        if (!isVaultClientCopy(contents.clientCopy)) fail('bad_envelope', 'The envelope holds no copy.');
        const release = sealVaultRelease({ provider: contents.provider, pubkey: contents.pubkey, clientCopy: contents.clientCopy }, args.requesterKey);
        return { release, provider: contents.provider };
    }

    // ─── Tickets and the report ────────────────────────────────────────────────────────────

    signTicket(args: { key?: unknown; purpose?: unknown }) {
        const keys = this.requireOpen();
        if (!isVaultKeyHex(args.key)) fail('bad_request', 'A ticket names a 64-character hex key.');
        if (args.purpose !== 'deposit' && args.purpose !== 'restore') fail('bad_request', 'A ticket is for a deposit or a restore.');
        const t = newVaultTicket(args.key, args.purpose as VaultTicketPurpose, this.clock());
        return { ticket: signVaultTicket(t, keys.ticketSeeds[0]), expiresAt: t.exp };
    }

    signReport(args: { text?: unknown }) {
        const keys = this.requireOpen();
        if (typeof args.text !== 'string' || args.text.length > 64 * 1024) fail('bad_request', 'Not a report.');
        return { signature: vaultB64(ed25519.sign(Buffer.from(REPORT_TAG + args.text, 'utf8'), keys.ticketSeeds[0])) };
    }

    // ─── Backups ───────────────────────────────────────────────────────────────────────────

    private backupKeys(keys: WorkingKeys, vaultId: string) {
        const salt = vaultUnb64(vaultId, 16) as Uint8Array;
        return {
            deletions: Buffer.from(crypto.hkdfSync('sha256', keys.kIndex, salt, DELETIONS_INFO, 32)),
            body: Buffer.from(crypto.hkdfSync('sha256', keys.kBackup, salt, BODY_INFO, 32)),
        };
    }

    /** A backup file (shared/backup-format.ts) of `body`, a database snapshot, with the deletion records beside it. */
    sealBackup(args: { name?: unknown; createdAt?: unknown; deletions?: unknown }, body: Buffer): Buffer {
        const keys = this.requireOpen();
        const file = this.stateFile as VaultStateFile;
        if (typeof args.name !== 'string' || !BACKUP_NAME_RE.test(args.name)) fail('bad_request', 'Not a backup name.');
        if (!Number.isSafeInteger(args.createdAt)) fail('bad_request', 'Not a time.');
        if (typeof args.deletions !== 'string') fail('bad_request', 'The deletion records are missing.');
        const header: BackupHeader = { v: 1, vaultId: file.vaultId, name: args.name, createdAt: args.createdAt as number, generation: file.generation, state: file };
        const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
        const k = this.backupKeys(keys, file.vaultId);
        try {
            const dn = crypto.randomBytes(24);
            const dct = xchacha20poly1305(k.deletions, dn, Buffer.concat([Buffer.from(BACKUP_DELETIONS_AAD), headerBytes])).encrypt(Buffer.from(args.deletions, 'utf8'));
            const bn = crypto.randomBytes(24);
            const bct = xchacha20poly1305(k.body, bn, Buffer.concat([Buffer.from(BACKUP_BODY_AAD), headerBytes])).encrypt(body);
            const lengths = Buffer.alloc(8);
            lengths.writeUInt32BE(headerBytes.length, 0);
            lengths.writeUInt32BE(24 + dct.length, 4);
            const signed = Buffer.concat([BACKUP_MAGIC, lengths.subarray(0, 4), headerBytes, lengths.subarray(4), dn, dct, bn, bct]);
            const digest = crypto.createHash('sha512').update(signed).digest();
            const sig = ed25519.sign(Buffer.concat([Buffer.from(BACKUP_SIG_TAG), digest]), keys.ticketSeeds[0]);
            return Buffer.concat([signed, sig]);
        } finally {
            k.deletions.fill(0);
            k.body.fill(0);
        }
    }

    private checkBackup(keys: WorkingKeys, file: Buffer) {
        let parsed;
        try {
            parsed = parseBackupFile(file);
        } catch (e) {
            fail('bad_backup', (e as Error).message);
        }
        const state = this.stateFile as VaultStateFile;
        if (parsed.header.vaultId !== state.vaultId) fail('bad_backup', 'That backup is another vault\'s.');
        const digest = crypto.createHash('sha512').update(parsed.signed).digest();
        const signedBytes = Buffer.concat([Buffer.from(BACKUP_SIG_TAG), digest]);
        const ok = keys.ticketPublicKeys.some(k => {
            try {
                return ed25519.verify(parsed.signature, signedBytes, Buffer.from(k, 'hex'), { zip215: false });
            } catch {
                return false;
            }
        });
        if (!ok) fail('bad_backup', 'The backup is not signed by this vault.');
        return parsed;
    }

    /**
     * Open a backup of this generation: its snapshot and deletion records. After a restore was adopted, only the backup
     * the custodian named, with exactly the state it gave this vault.
     */
    openBackup(file: Buffer): { header: Omit<BackupHeader, 'state'>; deletions: string; body: Buffer } {
        const keys = this.requireOpen();
        const parsed = this.checkBackup(keys, file);
        const pendingFile = path.join(this.opts.stateDir, RESTORE_PENDING_FILE);
        if (existsSync(pendingFile)) {
            const pending = JSON.parse(readFileSync(pendingFile, 'utf8')) as { backupName: string; stateHash: string };
            const stateHash = textHash(JSON.stringify(asStateFile(parsed.header.state)));
            if (parsed.header.name !== pending.backupName || stateHash !== pending.stateHash) {
                fail('bad_backup', 'That is not the backup the custodian named for this restore.');
            }
        }
        if (parsed.header.generation !== (this.stateFile as VaultStateFile).generation) {
            fail('bad_backup', 'That backup is from another generation of this vault\'s keys.');
        }
        const k = this.backupKeys(keys, parsed.header.vaultId);
        try {
            const aad = (label: string) => Buffer.concat([Buffer.from(label), parsed.headerBytes]);
            let deletions: Uint8Array;
            let body: Uint8Array;
            try {
                deletions = xchacha20poly1305(k.deletions, parsed.deletions.nonce, aad(BACKUP_DELETIONS_AAD)).decrypt(parsed.deletions.ct);
                body = xchacha20poly1305(k.body, parsed.body.nonce, aad(BACKUP_BODY_AAD)).decrypt(parsed.body.ct);
            } catch {
                fail('bad_backup', 'The backup does not open with this vault\'s keys.');
            }
            const header: Omit<BackupHeader, 'state'> & { state?: unknown } = { ...parsed.header };
            delete header.state;
            return { header, deletions: Buffer.from(deletions).toString('utf8'), body: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
        } finally {
            k.deletions.fill(0);
            k.body.fill(0);
        }
    }

    /** A backup's deletion records only. Opens across reshares (they are under K_index, which a reshare keeps). */
    openBackupDeletions(file: Buffer): { name: string; createdAt: number; deletions: string } {
        const keys = this.requireOpen();
        const parsed = this.checkBackup(keys, file);
        const k = this.backupKeys(keys, parsed.header.vaultId);
        try {
            const plain = xchacha20poly1305(k.deletions, parsed.deletions.nonce,
                Buffer.concat([Buffer.from(BACKUP_DELETIONS_AAD), parsed.headerBytes])).decrypt(parsed.deletions.ct);
            return { name: parsed.header.name, createdAt: parsed.header.createdAt, deletions: Buffer.from(plain).toString('utf8') };
        } catch (e) {
            if (e instanceof KeyholderError) throw e;
            fail('bad_backup', 'The backup\'s deletion records do not open with this vault\'s keys.');
        } finally {
            k.deletions.fill(0);
            k.body.fill(0);
        }
    }

    /** The restore a custodian started is finished: forget which backup it named. */
    restoreDone(): void {
        this.requireOpen();
        rmSync(path.join(this.opts.stateDir, RESTORE_PENDING_FILE), { force: true });
    }
}
