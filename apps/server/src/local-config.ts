/**
 * Local Configuration — Node Identity & Admin Auth
 *
 * First boot:
 *   - Reads ADMIN_PASSWORD env var → hashes with scrypt → saves to data/local-config.json
 *   - If no env var, auto-generates a random password and prints to console
 *
 * Subsequent boots:
 *   - Loads existing config from disk (env var ignored)
 *
 * Password reset:
 *   - SSH in, delete data/local-config.json, restart container
 */

import { scryptSync, randomBytes, timingSafeEqual, randomInt, scrypt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'local-config.json');

export interface LocalConfig {
    isLocked: boolean;
    callsign: string | null;
    location: { lat: number; lng: number } | null;
    adminHash: string | null;
    salt: string | null;
    joinedAt: number | null;
    thresholds?: Thresholds;
    communityName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    currencyType?: 'text' | 'image';
    currencyValue?: string;
    backupPrimaryUrl?: string | null;
    backupAdminPassword?: string | null;
    // --- Replication credential (live backup) ---
    // Primary side: scrypt hash of a dedicated replication token. The snapshot-pull
    // endpoint accepts a request bearing the matching token (least-privilege, scoped
    // to read-only replication only — distinct from the all-powerful admin password,
    // and independently rotatable). Never store the plaintext.
    replicationTokenHash?: string | null;
    replicationTokenSalt?: string | null;
    replicationTokenCreatedAt?: number | null;
    // When true, the snapshot endpoint refuses admin-password auth and REQUIRES the
    // token. Left false during rollout so existing backups keep working until the
    // token is provisioned on both ends, then flipped on for token-only enforcement.
    replicationTokenOnly?: boolean;
    // Backup side: the plaintext token this backup presents to its primary.
    backupReplicationToken?: string | null;
    // --- Backup pull cadence (operator-tunable, e.g. from the fleet manager) ---
    // How often the backup asks the primary "what changed?" (the cheap delta pull).
    // Small; fine to run every minute or less. Null → env BACKUP_PULL_INTERVAL_MS → 60s.
    backupPullSeconds?: number | null;
    // How often the backup does a FULL re-read as a belt-and-suspenders verification.
    // This one moves the whole DB, so it's spaced out and can be turned off entirely
    // (0) at scale — the per-minute deltas + the stateHash drift canary keep the copy
    // correct, and a drift is corrected on demand. Null → env BACKUP_RECONCILE_EVERY_MS
    // → 15m. 0 → routine full reconcile disabled (drift-triggered fulls still run).
    backupReconcileMinutes?: number | null;
}

export interface Thresholds {
    // Credit
    circulationRate: number;    // Base monthly decay rate (unused with brackets, kept for legacy UI)
    circulationEpochDays: number; // Days per epoch month (default: 30)
    
    // Legacy mapping support
    demurrageRate?: number;
    demurrageEpochDays?: number;

    // Health flags
    washTradingWindowHours: number;  // Window for wash trading detection (default: 24)
    washTradingMinTxns: number;      // Min txns in window to flag (default: 4)
    inactiveMemberDays: number;      // Days with no activity to flag (default: 30)
    isolatedBranchMinTxns: number;   // Min internal txns to flag isolation (default: 3)
    maxProjectExpiryDays: number;    // Max days allowed for crowdfund expiry (default: 365)
    // Sybil funnel detection
    sybilFunnelMinInvitees: number;  // Min invitees funneling back to flag (default: 2)
    sybilFunnelMinAmount: number;    // Min total beans funneled to flag (default: 100)
    sybilFunnelWindowDays: number;   // Rolling window in days (default: 30)
}

const DEFAULT_CONFIG: LocalConfig = {
    isLocked: false,
    callsign: null,
    location: null,
    adminHash: null,
    salt: null,
    joinedAt: null,
    communityName: null,
    contactEmail: null,
    contactPhone: null,
    currencyType: 'image',
    currencyValue: 'bean',
};

export function getLocalConfig(): LocalConfig {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as LocalConfig;
            
            // Backward compatibility for demurrage -> circulation renaming
            if (raw.thresholds) {
                if (raw.thresholds.demurrageRate !== undefined && raw.thresholds.circulationRate === undefined) {
                    raw.thresholds.circulationRate = raw.thresholds.demurrageRate;
                }
                if (raw.thresholds.demurrageEpochDays !== undefined && raw.thresholds.circulationEpochDays === undefined) {
                    raw.thresholds.circulationEpochDays = raw.thresholds.demurrageEpochDays;
                }
            }
            return raw;
        }
    } catch (e) {
        console.warn('[Config] Failed to read local config:', e);
    }
    return { ...DEFAULT_CONFIG };
}

export function saveLocalConfig(config: LocalConfig): void {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('[Config] Failed to save local config:', e);
    }
}

export function hashPassword(password: string): { hash: string; salt: string } {
    const salt = randomBytes(32).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return { hash, salt };
}

export function verifyPassword(password: string, storedHash: string, storedSalt: string): boolean {
    try {
        const hash = scryptSync(password, storedSalt, 64);
        const expected = Buffer.from(storedHash, 'hex');
        return timingSafeEqual(hash, expected);
    } catch {
        return false;
    }
}

/**
 * A2-21 (SRV-14): async password verification. `scryptSync` blocks Node's single
 * event-loop thread for ~100–300 ms on the low-end hardware this targets; with
 * `checkAdminAuth` calling it on EVERY `/api/local/*` + `/api/admin/*` request and
 * the dashboard fanning out several admin POSTs, the synchronous calls serialized
 * and head-of-line-blocked the loop until the front proxy returned 502. This async
 * variant runs scrypt on the libuv threadpool, so concurrent admin requests no
 * longer block the event loop (health probes + other requests stay responsive).
 */
export function verifyPasswordAsync(password: string, storedHash: string, storedSalt: string): Promise<boolean> {
    return new Promise((resolve) => {
        scrypt(password, storedSalt, 64, (err, derived) => {
            if (err) { resolve(false); return; }
            try {
                const expected = Buffer.from(storedHash, 'hex');
                resolve(derived.length === expected.length && timingSafeEqual(derived, expected));
            } catch { resolve(false); }
        });
    });
}

/**
 * Validate password complexity:
 * - Minimum 8 characters
 * - Uppercase, lowercase, number, symbol
 */
export function validatePasswordStrength(password: string): { valid: boolean; error?: string } {
    if (!password) {
        return { valid: false, error: 'Password is required' };
    }
    if (password.length < 8) {
        return { valid: false, error: 'Password must be at least 8 characters long' };
    }
    if (!/[A-Z]/.test(password)) {
        return { valid: false, error: 'Password must contain at least one uppercase letter' };
    }
    if (!/[a-z]/.test(password)) {
        return { valid: false, error: 'Password must contain at least one lowercase letter' };
    }
    if (!/[0-9]/.test(password)) {
        return { valid: false, error: 'Password must contain at least one number' };
    }
    if (!/[!@#$%^&*(),.?":{}|<>\-_]/.test(password)) {
        return { valid: false, error: 'Password must contain at least one special character (!@#$%^&*(),.?":{}|<>_-)' };
    }
    return { valid: true };
}

/**
 * Generates a high-entropy 20-character password satisfying the strength validator
 */
export function generateStrongPassword(): string {
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const symbols = '!@#$%^&*()';
    const all = uppercase + lowercase + numbers + symbols;

    // SECURITY (SRV-10): this is an authentication credential, so draw from a
    // CSPRNG (crypto.randomInt) — never Math.random, whose output is not
    // cryptographically secure and can be reconstructed from observed values.
    const chars: string[] = [
        // Guarantee at least one character from each required category
        uppercase[randomInt(uppercase.length)],
        lowercase[randomInt(lowercase.length)],
        numbers[randomInt(numbers.length)],
        symbols[randomInt(symbols.length)],
    ];
    // Fill up to the 20-character length
    for (let i = 0; i < 16; i++) {
        chars.push(all[randomInt(all.length)]);
    }

    // Cryptographic Fisher-Yates shuffle so the guaranteed-category characters
    // aren't pinned to the first four positions (and to avoid the biased
    // comparator-based shuffle the previous implementation used).
    for (let i = chars.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

/**
 * Initialize admin password on first boot.
 * - If config already locked → skip (password already set)
 * - If ADMIN_PASSWORD env var set → hash and save
 * - If no env var → auto-generate and print to logs
 */
export function initAdminPassword(): void {
    const config = getLocalConfig();

    if (config.isLocked) {
        console.log('🔒 Node is locked — admin password already configured.');
        return;
    }

    let password = process.env.ADMIN_PASSWORD;

    if (password) {
        const validation = validatePasswordStrength(password);
        if (!validation.valid) {
            throw new Error(`[Config] ADMIN_PASSWORD environment variable is invalid: ${validation.error}`);
        }
    } else {
        password = generateStrongPassword();
        console.log('');
        console.log('╔══════════════════════════════════════════════╗');
        console.log('║  🔑 Auto-generated admin password:          ║');
        console.log(`║  ${password}                ║`);
        console.log('║                                              ║');
        console.log('║  Save this! It won\'t be shown again.        ║');
        console.log('╚══════════════════════════════════════════════╝');
        console.log('');
    }

    const { hash, salt } = hashPassword(password);

    saveLocalConfig({
        ...config,
        isLocked: true,
        adminHash: hash,
        salt: salt,
        joinedAt: Date.now(),
    });

    console.log('🔒 Admin password configured and saved.');
}

// ===================== REPLICATION TOKEN =====================

/** Generate a fresh 256-bit replication token (shown to the operator once). */
export function generateReplicationToken(): string {
    return randomBytes(32).toString('hex');
}

/** Store the scrypt hash of a replication token (primary side). Plaintext is never persisted. */
export function setReplicationToken(token: string): void {
    const config = getLocalConfig();
    const { hash, salt } = hashPassword(token);
    config.replicationTokenHash = hash;
    config.replicationTokenSalt = salt;
    config.replicationTokenCreatedAt = Date.now();
    saveLocalConfig(config);
}

/** Remove the replication token and revert to admin-password auth on the snapshot endpoint. */
export function clearReplicationToken(): void {
    const config = getLocalConfig();
    config.replicationTokenHash = null;
    config.replicationTokenSalt = null;
    config.replicationTokenCreatedAt = null;
    config.replicationTokenOnly = false;
    saveLocalConfig(config);
}

export function hasReplicationToken(): boolean {
    const config = getLocalConfig();
    return !!(config.replicationTokenHash && config.replicationTokenSalt);
}

/** Constant-time verify of a presented replication token (async — runs scrypt off the event loop). */
export async function verifyReplicationToken(token: string): Promise<boolean> {
    const config = getLocalConfig();
    if (!token || !config.replicationTokenHash || !config.replicationTokenSalt) return false;
    return verifyPasswordAsync(token, config.replicationTokenHash, config.replicationTokenSalt);
}

// ===================== THRESHOLDS =====================

export const DEFAULT_THRESHOLDS: Thresholds = {
    circulationRate: 0.005,
    circulationEpochDays: 30,
    washTradingWindowHours: 24,
    washTradingMinTxns: 4,
    inactiveMemberDays: 30,
    isolatedBranchMinTxns: 3,
    maxProjectExpiryDays: 365,
    sybilFunnelMinInvitees: 2,
    sybilFunnelMinAmount: 100,
    sybilFunnelWindowDays: 30,
};

export function getThresholds(): Thresholds {
    const config = getLocalConfig();
    return { ...DEFAULT_THRESHOLDS, ...(config.thresholds || {}) };
}

export function updateThresholds(updates: Partial<Thresholds>): Thresholds {
    const config = getLocalConfig();
    const current = { ...DEFAULT_THRESHOLDS, ...(config.thresholds || {}) };
    
    // Support saving old keys by mapping them to new ones if passed
    if (updates.demurrageRate !== undefined) updates.circulationRate = updates.demurrageRate;
    if (updates.demurrageEpochDays !== undefined) updates.circulationEpochDays = updates.demurrageEpochDays;
    
    const merged = { ...current, ...updates };
    config.thresholds = merged;
    saveLocalConfig(config);
    console.log('⚙️ Thresholds updated:', merged);
    return merged;
}

/**
 * Update the backup pull cadence (delta poll seconds and/or full-reconcile minutes).
 * Read live by the backup puller on its next tick, so a change takes effect without a
 * restart. `null` clears an override (falls back to env/default); a number sets it;
 * reconcileMinutes = 0 disables the routine full reconcile. Values are clamped to sane
 * bounds so an operator can't set a 0-second busy loop or a negative interval.
 */
export function updateBackupCadence(updates: { pullSeconds?: number | null; reconcileMinutes?: number | null }): { backupPullSeconds: number | null; backupReconcileMinutes: number | null } {
    const config = getLocalConfig();
    if (updates.pullSeconds !== undefined) {
        config.backupPullSeconds = updates.pullSeconds === null ? null : Math.max(5, Math.round(updates.pullSeconds));
    }
    if (updates.reconcileMinutes !== undefined) {
        config.backupReconcileMinutes = updates.reconcileMinutes === null ? null : Math.max(0, Math.round(updates.reconcileMinutes));
    }
    saveLocalConfig(config);
    console.log('⚙️ Backup cadence updated:', { backupPullSeconds: config.backupPullSeconds, backupReconcileMinutes: config.backupReconcileMinutes });
    return { backupPullSeconds: config.backupPullSeconds ?? null, backupReconcileMinutes: config.backupReconcileMinutes ?? null };
}
