import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_NAME_RE, backupBytes, backupsPastBudget, compareBackupNames } from '../shared/backup-format.js';

/**
 * Where backups go (key vault design §4): the vault's own directory, and object storage at a second provider in
 * another country (s3-store.ts, set by two custodians: shared/settings.ts). Every file is sealed and signed before it
 * gets here (shared/backup-format.ts), so a store is trusted with nothing but keeping the bytes. This interface is all
 * the vault needs of either.
 */
export interface BackupStore {
    put(name: string, bytes: Uint8Array): Promise<void>;
    get(name: string): Promise<Buffer>;
    /** Every backup name in the store. */
    list(): Promise<string[]>;
    delete(name: string): Promise<void>;
}

/** A backup larger than the store's whole budget: not written, and nothing already there removed for it. */
export class BackupTooLarge extends Error {
    constructor(readonly bytes: number, readonly maxBytes: number) {
        super(`too large: ${bytes} bytes > budget ${maxBytes}`);
    }
}

function checkName(name: string): string {
    if (!BACKUP_NAME_RE.test(name)) throw new Error(`${JSON.stringify(name)} is not a backup name.`);
    return name;
}

/**
 * A directory as a backup store: the vault's own copy of its backups (on the image, the state partition,
 * `/var/lib/beanpool-vault/backups`; each is copied off the box too once a store is set), and tests. It shares the partition
 * with a new image waiting for the monthly restart, so `maxBytes` bounds it (backupsPastBudget, the rule root's monthly
 * step applies too): a backup larger than the whole budget is refused (BackupTooLarge) and nothing is removed for it,
 * so the last good one stays; after each backup written, anything named later goes, then the oldest until the rest
 * fit, and never the one written.
 */
export class LocalDirectoryStore implements BackupStore {
    private readonly maxBytes: number | null;

    constructor(private readonly dir: string, opts: { maxBytes?: number } = {}) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.maxBytes = opts.maxBytes ?? null;
    }

    async put(name: string, bytes: Uint8Array): Promise<void> {
        const file = path.join(this.dir, checkName(name));
        if (this.maxBytes !== null && bytes.length > this.maxBytes) throw new BackupTooLarge(bytes.length, this.maxBytes);
        try {
            writeFileSync(`${file}.part`, bytes, { mode: 0o600 });
            renameSync(`${file}.part`, file);
        } catch (e) {
            // A partial file (a full disk) takes no room from what comes next.
            rmSync(`${file}.part`, { force: true });
            throw e;
        }
        if (this.maxBytes !== null) this.keepWithin(this.maxBytes, name);
    }

    /**
     * What the budget lets go (backupsPastBudget), with `written` as the newest name there can be: anything named after
     * it (planted, or written while the clock was ahead) goes, as root's step would remove it too. What was just
     * written goes only if its blocks alone are past the budget; that is then a refusal, and older backups stay.
     */
    private keepWithin(maxBytes: number, written: string): void {
        const backups = readdirSync(this.dir).filter(n => BACKUP_NAME_RE.test(n))
            .map(name => ({ name, st: lstatSync(path.join(this.dir, name)) }))
            .filter(b => b.st.isFile())
            .map(b => ({ name: b.name, size: b.st.size, blocks: b.st.blocks }));
        const past = backupsPastBudget(backups, maxBytes, { latest: written });
        for (const name of past) rmSync(path.join(this.dir, name), { force: true });
        if (past.includes(written)) {
            const b = backups.find(x => x.name === written) as { size: number; blocks: number };
            throw new BackupTooLarge(backupBytes(b), maxBytes);
        }
    }

    async get(name: string): Promise<Buffer> {
        return readFileSync(path.join(this.dir, checkName(name)));
    }

    async list(): Promise<string[]> {
        return readdirSync(this.dir).filter(n => BACKUP_NAME_RE.test(n)).sort(compareBackupNames);
    }

    async delete(name: string): Promise<void> {
        rmSync(path.join(this.dir, checkName(name)), { force: true });
    }
}
