import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_NAME_RE, compareBackupNames } from '../shared/backup-format.js';

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

function checkName(name: string): string {
    if (!BACKUP_NAME_RE.test(name)) throw new Error(`${JSON.stringify(name)} is not a backup name.`);
    return name;
}

/**
 * A directory as a backup store: for tests, for a rehearsal with a disk as the "other provider", and on the image until
 * the store's client exists (the state partition, `/var/lib/beanpool-vault/backups`). There it shares the partition
 * with a new image waiting for the monthly restart, so `maxBytes` bounds it: after each backup the oldest go until the
 * rest fit, and the newest always stays.
 */
export class LocalDirectoryStore implements BackupStore {
    private readonly maxBytes: number | null;

    constructor(private readonly dir: string, opts: { maxBytes?: number } = {}) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.maxBytes = opts.maxBytes ?? null;
    }

    async put(name: string, bytes: Uint8Array): Promise<void> {
        const file = path.join(this.dir, checkName(name));
        try {
            writeFileSync(`${file}.part`, bytes, { mode: 0o600 });
            renameSync(`${file}.part`, file);
        } catch (e) {
            // A partial file (a full disk) takes no room from what comes next.
            rmSync(`${file}.part`, { force: true });
            throw e;
        }
        if (this.maxBytes !== null) this.keepWithin(this.maxBytes);
    }

    /** The oldest backups go until the rest take no more than `maxBytes`; the newest always stays. */
    private keepWithin(maxBytes: number): void {
        const backups = readdirSync(this.dir).filter(n => BACKUP_NAME_RE.test(n)).sort(compareBackupNames)
            .map(name => ({ name, size: statSync(path.join(this.dir, name)).size }));
        let total = backups.reduce((sum, b) => sum + b.size, 0);
        for (const b of backups.slice(0, -1)) {
            if (total <= maxBytes) break;
            rmSync(path.join(this.dir, b.name), { force: true });
            total -= b.size;
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
