/**
 * A per-owner break-glass code (docs/admin-surface.md §2.2): `bg-` and 16 hex digits in four groups, 64 random bits,
 * shown once when an owner key is enrolled. It does one thing, enrol a new admin key: admin-auth.ts checks it on the
 * enrol routes and nowhere else.
 *
 * Stored in node_roles.break_glass_hash as `scrypt$<salt>$<hash>`: scrypt with the admin password's parameters
 * (config/local-config.ts hashPassword: Node's defaults N = 2^14, r = 8, p = 1, 64 bytes out, a fresh 32-byte salt per
 * code) over the SHA-256 of the code. Until 2026-10-01 the row held that SHA-256 alone, unsalted (Fable's security
 * review, MEDIUM 1): from a copy of the database (a standby, an opened backup) a code was a 2^63 plain SHA-256 search.
 *
 * The SHA-256 inside is what lets every old row be upgraded at boot (upgradeBreakGlassHashes), although nobody holds
 * the codes: scrypt over an old row's digest is exactly what a new code's row holds. So the weak form leaves the database
 * at the first boot of this version, rather than on each code's next use, which for a code kept in a drawer may be never.
 * A row in the old form can still arrive later (a take-over bundle or a restore from a server that ran an older version):
 * it is still accepted, and rewritten in the new form the first time its code is used (admin-key-auth.ts
 * verifyBreakGlassCode), and at the next boot either way.
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

const SCRYPT_PREFIX = 'scrypt$';
const CODE_SHAPE = /^bg-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;
const LEGACY_SHAPE = /^[0-9a-f]{64}$/;

/** A new code, e.g. bg-a1b2-c3d4-e5f6-7890. */
export function generateBreakGlassCode(): string {
    const raw = crypto.randomBytes(8).toString('hex');
    return `bg-${raw.match(/.{4}/g)!.join('-')}`;
}

function normalise(code: string): string {
    return String(code).trim().toLowerCase();
}

/**
 * Whether `code` has a break-glass code's shape. Only such a string is ever hashed: every check is an scrypt per owner,
 * so a password or junk is turned away without one.
 */
export function isBreakGlassCodeShape(code: unknown): boolean {
    return typeof code === 'string' && CODE_SHAPE.test(normalise(code));
}

/** The old stored form, and what the scrypt runs over. */
function digestOf(code: string): string {
    return crypto.createHash('sha256').update(normalise(code)).digest('hex');
}

function scryptRecord(digest: string): string {
    const salt = crypto.randomBytes(32).toString('hex');
    return `${SCRYPT_PREFIX}${salt}$${crypto.scryptSync(digest, salt, 64).toString('hex')}`;
}

/** What node_roles.break_glass_hash holds for `code`. Synchronous: only an enrolment, or a boot, writes one. */
export function hashBreakGlassCode(code: string): string {
    return scryptRecord(digestOf(code));
}

/** Whether a stored value is in the old form (unsalted SHA-256 hex). */
export function isLegacyBreakGlassHash(stored: unknown): boolean {
    return typeof stored === 'string' && LEGACY_SHAPE.test(stored);
}

/**
 * Check `code` against one stored value. 'legacy' is a match against a row still in the old form, which the caller
 * rewrites. The scrypt runs on the libuv threadpool, as the password's does (verifyPasswordAsync).
 */
export async function breakGlassCodeMatches(code: string, stored: string): Promise<'match' | 'legacy' | 'no'> {
    if (!isBreakGlassCodeShape(code) || typeof stored !== 'string') return 'no';
    const digest = digestOf(code);
    if (isLegacyBreakGlassHash(stored)) {
        const a = Buffer.from(digest, 'hex');
        const b = Buffer.from(stored, 'hex');
        return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'legacy' : 'no';
    }
    if (!stored.startsWith(SCRYPT_PREFIX)) return 'no';
    const [salt, hash] = stored.slice(SCRYPT_PREFIX.length).split('$');
    if (!salt || !hash || !/^[0-9a-f]+$/.test(hash)) return 'no';
    const expected = Buffer.from(hash, 'hex');
    const derived = await new Promise<Buffer | null>((resolve) => {
        crypto.scrypt(digest, salt, expected.length, (err, out) => resolve(err ? null : out));
    });
    return derived && derived.length === expected.length && crypto.timingSafeEqual(derived, expected) ? 'match' : 'no';
}

/**
 * Boot: rewrite every break-glass hash still in the old form, in node_roles and, on a main server, in
 * suspended_node_roles (a role held aside by a suspension, given back with its hash). A standby's suspended_node_roles
 * rows are its main server's copy, which never carries the hash (engine/replication-manifest.ts), and a write there would
 * restamp them. Returns how many rows were rewritten.
 */
export function upgradeBreakGlassHashes(db: Database.Database, opts: { suspendedToo: boolean }): number {
    let n = 0;
    const tables = opts.suspendedToo ? ['node_roles', 'suspended_node_roles'] : ['node_roles'];
    for (const table of tables) {
        const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
        if (!hasTable) continue;
        const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
        if (!cols.includes('break_glass_hash')) continue;
        const rows = (db.prepare(`SELECT rowid AS id, break_glass_hash AS h FROM ${table} WHERE break_glass_hash IS NOT NULL`).all() as { id: number; h: string }[])
            .filter(r => isLegacyBreakGlassHash(r.h));
        if (!rows.length) continue;
        const update = db.prepare(`UPDATE ${table} SET break_glass_hash = ? WHERE rowid = ? AND break_glass_hash = ?`);
        db.transaction(() => {
            for (const r of rows) n += update.run(scryptRecord(r.h), r.id, r.h).changes;
        })();
    }
    return n;
}
