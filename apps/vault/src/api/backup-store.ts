import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_NAME_RE, backupsPastBudget, compareBackupNames } from '../shared/backup-format.js';

/**
 * Where backups go (key vault design §4): object storage at a second provider in another country. Every file is
 * sealed and signed before it gets here (shared/backup-format.ts), so the store is trusted with nothing but keeping
 * the bytes. The real store's client and credentials come later; this interface is all the vault needs of it.
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
 * A directory as a backup store: for tests, for a rehearsal with a disk as the "other provider", and on the image until
 * the store's client exists (the state partition, `/var/lib/beanpool-vault/backups`). There it shares the partition
 * with a new image waiting for the monthly restart, so `maxBytes` bounds it (backupsPastBudget, the rule root's monthly
 * step applies too): a backup larger than the whole budget is refused (BackupTooLarge) and nothing is removed for it,
 * so the last good one stays; after each backup written, the oldest go until the rest fit, and never the one written.
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

    /** What the budget lets go (backupsPastBudget), but never `written`, the backup just made. */
    private keepWithin(maxBytes: number, written: string): void {
        const backups = readdirSync(this.dir).filter(n => BACKUP_NAME_RE.test(n))
            .map(name => ({ name, st: lstatSync(path.join(this.dir, name)) }))
            .filter(b => b.st.isFile())
            .map(b => ({ name: b.name, size: b.st.size, blocks: b.st.blocks }));
        for (const name of backupsPastBudget(backups, maxBytes)) {
            if (name !== written) rmSync(path.join(this.dir, name), { force: true });
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
