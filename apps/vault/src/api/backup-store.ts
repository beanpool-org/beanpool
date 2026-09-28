import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_NAME_RE } from '../shared/backup-format.js';

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

/** A directory as a backup store: for tests, and for a rehearsal with a disk as the "other provider". */
export class LocalDirectoryStore implements BackupStore {
    constructor(private readonly dir: string) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    async put(name: string, bytes: Uint8Array): Promise<void> {
        const file = path.join(this.dir, checkName(name));
        writeFileSync(`${file}.part`, bytes, { mode: 0o600 });
        renameSync(`${file}.part`, file);
    }

    async get(name: string): Promise<Buffer> {
        return readFileSync(path.join(this.dir, checkName(name)));
    }

    async list(): Promise<string[]> {
        return readdirSync(this.dir).filter(n => BACKUP_NAME_RE.test(n)).sort();
    }

    async delete(name: string): Promise<void> {
        rmSync(path.join(this.dir, checkName(name)), { force: true });
    }
}
