/**
 * What a restore checks before it replaces anything, and the one reader of a backup's tar.gz (Fable's backups review,
 * 2026-10-01, scratch/reviews/FABLE-sec-backups.md: the gzip bomb, the busybox hard link, the untrusted state.db).
 *
 * ## The archive is read by its headers, never by `tar`
 *
 * A restore archive is attacker-controlled input, and so is the one inside a sealed file: opening it proves only that
 * someone holding a key locked it. It used to be listed with `tar -tv` (a member whose line began `l` or `h` refused)
 * and unpacked with `tar -xzf`. That rested on GNU tar's listing, and the server image's tar is busybox's
 * (node:22-alpine). Measured 2026-10-01 in alpine:3.21, BusyBox v1.37.0: busybox lists a hard link as a plain file
 * (`-rw-r--r-- 0/0 0 … ./images/leak -> ../secret`), and unpacks it as a link to `../secret`, OUTSIDE the folder it
 * was unpacking into: the member came out holding the secret's bytes. From `data/.restore-tmp` that is
 * `data/local-config.json` or `data/libp2p_key`, which the restore then copies into the image store. And `tar -xzf`
 * unpacks without a limit: the 500 MB cap was on the upload, and gzip packs a thousand to one.
 *
 * So the archive is read here, a 512-byte header at a time (ustar, with the pax and GNU long-name headers GNU tar,
 * bsdtar and busybox write), straight out of a gunzip stream, and:
 *   - only plain files and folders are let in: a link of either kind, a device, a fifo, anything else refuses the
 *     whole archive, whatever a tar's listing would have shown;
 *   - a member's name is refused when it is absolute, starts with a drive letter, or has a `..` segment, in every
 *     spelling it carries (the header's, a GNU long name, a pax path), so no tar reading the same bytes can take a
 *     name this did not check;
 *   - what the members add up to is capped ({@link RESTORE_ARCHIVE_LIMITS}, and the room the data volume has left),
 *     and so is how many there are. A member is refused by the size its header gives, before a byte of it is
 *     written; every byte gunzip produces counts against a ceiling as well, so padding and headers cannot run on;
 *   - files are created new (`O_EXCL`, which never follows a link) under a folder the caller has just made, where
 *     nothing but what this wrote exists.
 * A refusal throws; the caller removes the folder, so the data volume is as it was.
 *
 * ## The database is checked before it goes in
 *
 * {@link checkRestoreDatabase}: it must be a SQLite file that passes `PRAGMA integrity_check`, and every trigger and
 * view in it must be one this server's own database has. Why that list: boot makes every trigger this server has
 * (69 on 2026-10-01, and no views) from db/schema.sql, with `CREATE TRIGGER IF NOT EXISTS`, and from db.ts
 * (the plain tables' stamps, members_touch_updated_at, posts_cleanup_on_group_delete), so the live database's
 * sqlite_master IS the list this version knows. A name it does not have refuses the backup. A known name whose text
 * differs is dropped from the copy, and the restart makes it again from this version's code: `IF NOT EXISTS` would
 * otherwise keep whatever body the file brought, and posts_touch_updated_at is even put back from the database's own
 * text (state-engine.ts backfillSearchKeywords). A trigger fires below the ledger's JavaScript guards, so one the
 * backup brought could rewrite balances on every ordinary write after the restore.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';

export interface ArchiveLimits {
    /** What the members' contents may add up to, unpacked. */
    maxBytes: number;
    /** How many files and folders an archive may hold. */
    maxMembers: number;
}

/**
 * A restore upload is capped at 500 MB, and a real node's backup unpacks to a few times that at most: its photos are
 * already compressed, and a database gzips to about a third of itself. A gzip bomb unpacks a thousandfold. A node's
 * store holds a file per photo and attachment; a quarter of a million is far past any community's, and far short of
 * running a volume out of inodes.
 */
export const RESTORE_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = { maxBytes: 4 * 1024 ** 3, maxMembers: 250_000 };

/** What an unpacked archive always leaves free on its volume, for the server still running on it. */
const ROOM_KEPT_FREE = 256 * 1024 ** 2;

const BLOCK = 512;
/** One pax header or GNU long name: metadata, never this big in a tar anyone wrote. */
const MAX_METADATA = 1024 ** 2;
/** All of them in one archive. */
const METADATA_BUDGET = 64 * 1024 ** 2;
const MAX_NAME = 4096;
/** A member's contents are copied in pieces of at most this. */
const PIECE = 1024 ** 2;

/** An archive or database a restore will not use. `httpStatus` when the answer is not a 500. */
export class RestoreRefused extends Error {
    constructor(message: string, readonly httpStatus?: number) {
        super(message);
        this.name = 'RestoreRefused';
    }
}

const LINKS = 'Invalid backup archive: links are not permitted';
const UNSAFE = 'Invalid backup archive: unsafe member path';
const damaged = (what: string) => new RestoreRefused(`Invalid backup archive: ${what}`);

function isZeros(b: Buffer): boolean {
    for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
    return true;
}

function sizeWords(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${bytes} bytes`;
}

/** What gunzip hands over, taken by exact lengths, with every byte it produces counted against a ceiling. */
class Unpacked {
    private queue: Buffer[] = [];
    private queued = 0;
    private ended = false;
    private produced = 0;

    constructor(private readonly source: AsyncIterator<Buffer>, private readonly ceiling: number, private readonly tooBig: () => Error) {}

    private async pull(): Promise<boolean> {
        if (this.ended) return false;
        const next = await this.source.next();
        if (next.done) {
            this.ended = true;
            return false;
        }
        const chunk = next.value;
        this.produced += chunk.length;
        if (this.produced > this.ceiling) throw this.tooBig();
        if (chunk.length > 0) {
            this.queue.push(chunk);
            this.queued += chunk.length;
        }
        return true;
    }

    /** Exactly `n` bytes (n > 0). Null when the archive has ended before the first of them; a throw when part-way. */
    async exactly(n: number): Promise<Buffer | null> {
        while (this.queued < n && await this.pull()) { /* until there are n, or no more */ }
        if (this.queued === 0) return null;
        if (this.queued < n) throw damaged('it is cut short');
        return this.take(n);
    }

    /** Between one and `n` bytes, to copy a member's contents a piece at a time. */
    async upTo(n: number): Promise<Buffer> {
        while (this.queued === 0) {
            if (!(await this.pull())) throw damaged('it is cut short');
        }
        return this.take(Math.min(n, this.queued));
    }

    async skip(n: number): Promise<void> {
        let left = n;
        while (left > 0) left -= (await this.upTo(Math.min(left, PIECE))).length;
    }

    /** Whether everything after here is zeros, as a tar's end is padded. Reads to the end (under the ceiling). */
    async onlyZerosLeft(): Promise<boolean> {
        for (;;) {
            if (!this.queue.every(isZeros)) return false;
            this.queue = [];
            this.queued = 0;
            if (!(await this.pull())) return true;
        }
    }

    private take(n: number): Buffer {
        const first = this.queue[0];
        if (first.length >= n) {
            if (first.length === n) this.queue.shift();
            else this.queue[0] = first.subarray(n);
            this.queued -= n;
            return first.subarray(0, n);
        }
        const out = Buffer.allocUnsafe(n);
        let at = 0;
        while (at < n) {
            const chunk = this.queue[0];
            const k = Math.min(chunk.length, n - at);
            chunk.copy(out, at, 0, k);
            at += k;
            if (k === chunk.length) this.queue.shift();
            else this.queue[0] = chunk.subarray(k);
        }
        this.queued -= n;
        return out;
    }
}

/** A NUL-terminated header field. */
function text(header: Buffer, offset: number, length: number): string {
    const raw = header.subarray(offset, offset + length);
    const nul = raw.indexOf(0);
    return (nul === -1 ? raw : raw.subarray(0, nul)).toString('utf8');
}

/** An octal header field. Base-256 (GNU's form for 8 GB and more) is past any limit here, so it is refused. */
function octal(header: Buffer, offset: number, length: number): number {
    if (header[offset] & 0x80) throw new RestoreRefused('Invalid backup archive: a member is larger than any backup', 413);
    const digits = text(header, offset, length).trim();
    if (digits === '') return 0;
    if (!/^[0-7]+$/.test(digits)) throw damaged('a header is not a tar header');
    const value = parseInt(digits, 8);
    if (!Number.isSafeInteger(value)) throw damaged('a header is not a tar header');
    return value;
}

/** A header's checksum: the sum of its bytes with the checksum field read as spaces (either signedness, as tars do). */
function checksumMatches(header: Buffer): boolean {
    let unsigned = 0;
    let signed = 0;
    for (let i = 0; i < BLOCK; i++) {
        const b = i >= 148 && i < 156 ? 0x20 : header[i];
        unsigned += b;
        signed += b > 127 ? b - 256 : b;
    }
    const stored = octal(header, 148, 8);
    return stored === unsigned || stored === signed;
}

/** The name in the header itself: POSIX ustar joins its prefix field on; the old GNU format keeps other data there. */
function headerName(header: Buffer): string {
    const name = text(header, 0, 100);
    const posix = header.subarray(257, 263).toString('latin1') === 'ustar\0';
    const prefix = posix ? text(header, 345, 155) : '';
    return prefix ? `${prefix}/${name}` : name;
}

/** A pax header's records: `<length> <key>=<value>\n`, each. */
function paxRecords(body: Buffer): Map<string, string> {
    const records = new Map<string, string>();
    let at = 0;
    while (at < body.length) {
        if (body[at] === 0) break;
        const space = body.indexOf(0x20, at);
        const length = space === -1 ? NaN : Number(body.subarray(at, space).toString('latin1'));
        if (!Number.isSafeInteger(length) || length <= space - at + 1 || at + length > body.length || body[at + length - 1] !== 0x0a) {
            throw damaged('a pax header is not readable');
        }
        const record = body.subarray(space + 1, at + length - 1).toString('utf8');
        const eq = record.indexOf('=');
        if (eq <= 0) throw damaged('a pax header is not readable');
        records.set(record.slice(0, eq), record.slice(eq + 1));
        at += length;
    }
    return records;
}

/** A member's path as segments, or a refusal: absolute, a drive letter, a `..` anywhere, a NUL. `./` and `.` drop out. */
function segmentsOf(name: string): string[] {
    if (name.length > MAX_NAME || name.includes('\0')) throw new RestoreRefused(UNSAFE);
    if (path.isAbsolute(name) || path.win32.isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new RestoreRefused(UNSAFE);
    const segments = name.split('/').filter((s) => s !== '' && s !== '.');
    if (segments.some((s) => s === '..')) throw new RestoreRefused(UNSAFE);
    return segments;
}

/** Bytes free to this process on the volume holding `dir`, or null when that cannot be read. */
function freeBytes(dir: string): number | null {
    try {
        const s = fs.statfsSync(dir);
        return s.bavail * s.bsize;
    } catch {
        return null;
    }
}

async function writeMember(from: Unpacked, root: string, segments: string[], size: number): Promise<void> {
    const target = path.join(root, ...segments);
    let fd: number;
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        // O_CREAT|O_EXCL: a name that already exists (a second member of the same name, a folder) is refused, and it
        // never follows a link. Nothing but this function writes under `root`, and it writes no links.
        fd = fs.openSync(target, 'wx', 0o600);
    } catch (e: any) {
        if (['EEXIST', 'EISDIR', 'ENOTDIR'].includes(e?.code)) throw damaged('a member appears twice, or as both a file and a folder');
        throw e;
    }
    try {
        let left = size;
        while (left > 0) {
            const piece = await from.upTo(Math.min(left, PIECE));
            for (let at = 0; at < piece.length;) at += fs.writeSync(fd, piece, at);
            left -= piece.length;
        }
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Read a backup's tar.gz from end to end, checking every member (see the top of this file), and when `into` is given,
 * unpack it there. `into` must be a folder the caller has just made, empty. Returns every member's path (`./`
 * dropped; a folder ends with `/`). Throws {@link RestoreRefused} on anything it will not take.
 */
async function readArchive(tarGzPath: string, limits: ArchiveLimits, into?: string): Promise<string[]> {
    const room = into ? freeBytes(into) : null;
    const byRoom = room !== null && room - ROOM_KEPT_FREE < limits.maxBytes;
    const maxBytes = byRoom ? Math.max(0, room! - ROOM_KEPT_FREE) : limits.maxBytes;
    const tooBig = () => new RestoreRefused(
        `Backup archive too large: it unpacks to more than ${sizeWords(maxBytes)}`
        + `${byRoom ? ', the room this server has left for it' : ''}. Nothing was changed.`, 413);
    // Every byte gunzip produces: the members' contents, a header and at most a block of padding for each, the metadata,
    // and the zeros at the end (GNU tar pads to 10 KiB).
    const ceiling = maxBytes + (limits.maxMembers + 1) * 2 * BLOCK + METADATA_BUDGET + 1024 ** 2;

    const source = fs.createReadStream(tarGzPath);
    const gunzip = zlib.createGunzip({ chunkSize: 256 * 1024 });
    source.on('error', (e) => gunzip.destroy(e));
    source.pipe(gunzip);
    const from = new Unpacked(gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>, ceiling, tooBig);

    const listing: string[] = [];
    let members = 0;
    let bytes = 0;
    let metadata = 0;
    let pax: Map<string, string> | null = null;
    let longName: string | null = null;
    try {
        for (;;) {
            const header = await from.exactly(BLOCK);
            // An archive with no end blocks simply stops after its last member, which tars accept.
            if (!header) break;
            if (isZeros(header)) {
                // The end. Anything but zeros after it is data a tar reading on would find and this did not check.
                if (!(await from.onlyZerosLeft())) throw damaged('there is more after its end');
                break;
            }
            if (!checksumMatches(header)) throw damaged('a header is not a tar header');
            const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
            const size = octal(header, 124, 12);
            const padding = (BLOCK - (size % BLOCK)) % BLOCK;

            // Metadata for the next member: a pax header (x), a pax global header (g), a GNU long name (L).
            if (type === 'x' || type === 'g' || type === 'L') {
                metadata += size;
                if (size > MAX_METADATA || metadata > METADATA_BUDGET) throw damaged('a header is too large');
                let body: Buffer = Buffer.alloc(0);
                if (size > 0) {
                    const read = await from.exactly(size);
                    if (!read) throw damaged('it is cut short');
                    body = read;
                }
                if (padding) await from.skip(padding);
                if (type === 'L') {
                    longName = text(body, 0, body.length);
                } else {
                    const records = paxRecords(body);
                    if (type === 'x') pax = records;
                    // A global header naming paths or sizes would apply to every member after it: no tar we write makes one.
                    else if (['path', 'linkpath', 'size'].some((k) => records.has(k))) throw damaged('a global header renames its members');
                }
                continue;
            }
            // A hard link (1), a symbolic link (2), a GNU long link name (K).
            if (type === '1' || type === '2' || type === 'K') throw new RestoreRefused(LINKS);
            let directory = type === '5';
            if (!directory && type !== '0' && type !== '7') {
                throw new RestoreRefused('Invalid backup archive: only plain files and folders are permitted');
            }

            // Every spelling of the name must be safe; the last one is the one a tar goes by.
            const names = [headerName(header), longName, pax?.get('path')].filter((n): n is string => typeof n === 'string');
            const segmentsByName = names.map(segmentsOf);
            const name = names[names.length - 1];
            const segments = segmentsByName[segmentsByName.length - 1];
            const paxSize = pax?.get('size');
            // The header's size is the one read here; a pax size that differs would let a tar that honours it see other members.
            if (paxSize !== undefined && Number(paxSize) !== size) throw damaged('a member gives two sizes');
            pax = null;
            longName = null;
            // An old tar marks a folder by its trailing slash alone.
            if (!directory && name.endsWith('/')) {
                if (size !== 0) throw damaged('a folder has contents');
                directory = true;
            }

            if (++members > limits.maxMembers) {
                throw new RestoreRefused(`Backup archive refused: it holds more than ${limits.maxMembers} files and folders. Nothing was changed.`, 413);
            }
            if (directory) {
                if (segments.length) {
                    listing.push(`${segments.join('/')}/`);
                    if (into) {
                        try {
                            fs.mkdirSync(path.join(into, ...segments), { recursive: true, mode: 0o700 });
                        } catch (e: any) {
                            if (['EEXIST', 'ENOTDIR'].includes(e?.code)) throw damaged('a member appears as both a file and a folder');
                            throw e;
                        }
                    }
                }
                await from.skip(size + padding);
                continue;
            }
            if (!segments.length) throw damaged('a file has no name');
            // Refused by what the header says it holds, before a byte of it is written.
            bytes += size;
            if (bytes > maxBytes) throw tooBig();
            // macOS tar packs a file's extended attributes as a `._<name>` member beside it (AppleDouble), which its own
            // extract turns back into attributes. Never a file of a backup (no name this server writes starts `._`), so
            // it is read past, counted but never written, as a tar on the Mac would.
            if (segments[segments.length - 1].startsWith('._')) {
                await from.skip(size + padding);
                continue;
            }
            listing.push(segments.join('/'));
            if (into) await writeMember(from, into, segments, size);
            else await from.skip(size);
            if (padding) await from.skip(padding);
        }
        if (pax || longName !== null) throw damaged('it is cut short');
    } catch (e: any) {
        if (e instanceof RestoreRefused) throw e;
        if (typeof e?.code === 'string' && e.code.startsWith('Z_')) throw damaged('it is not a readable .tar.gz');
        throw e;
    } finally {
        source.destroy();
        gunzip.destroy();
    }
    return listing;
}

/**
 * Check every member of a backup's tar.gz without unpacking anything. Returns every member's path (`./` dropped; a
 * folder ends with `/`).
 */
export function listBackupArchive(tarGzPath: string, limits: ArchiveLimits = RESTORE_ARCHIVE_LIMITS): Promise<string[]> {
    return readArchive(tarGzPath, limits);
}

/**
 * Check and unpack a backup's tar.gz into `into`, a folder the caller has just made, in one pass. On a refusal
 * something may already be in `into`: the caller removes it, and nothing outside it has been touched.
 */
export function extractBackupArchive(tarGzPath: string, into: string, limits: ArchiveLimits = RESTORE_ARCHIVE_LIMITS): Promise<string[]> {
    return readArchive(tarGzPath, limits, path.resolve(into));
}

type SchemaObject = { type: string; name: string; sql: string | null };

function triggersAndViews(handle: Database.Database): SchemaObject[] {
    return handle.prepare(`SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') ORDER BY type, name`).all() as SchemaObject[];
}

function quoteName(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The database a restore is about to put in place, checked while the live one is still open (see the top of this file).
 * `candidate` must sit alone in a folder of its own, so no `-wal` or `-journal` the archive brought is read with it: what
 * is checked is exactly the file that is copied into place. Throws {@link RestoreRefused} (400) when it is not a
 * database, fails `PRAGMA integrity_check`, or carries a trigger or view `live` does not have. Returns the known ones it
 * dropped because their text differs from `live`'s; the restart makes them again from this version's code.
 */
export function checkRestoreDatabase(candidate: string, live: Database.Database): { remade: string[] } {
    const refuse = (why: string) => new RestoreRefused(`This backup's state.db ${why}. Nothing was changed.`, 400);
    const head = Buffer.alloc(16);
    const fd = fs.openSync(candidate, 'r');
    try {
        fs.readSync(fd, head, 0, 16, 0);
    } finally {
        fs.closeSync(fd);
    }
    if (head.toString('latin1') !== 'SQLite format 3\0') throw refuse('is not a SQLite database');

    let handle: Database.Database;
    try {
        handle = new Database(candidate, { fileMustExist: true });
    } catch (e: any) {
        throw refuse(`does not open as a database (${e?.message || e})`);
    }
    try {
        // Nothing in the file's schema runs with this connection's trust while it is looked at.
        handle.pragma('trusted_schema = OFF');
        let result: { integrity_check: string }[];
        try {
            result = handle.pragma('integrity_check') as { integrity_check: string }[];
        } catch (e: any) {
            throw refuse(`fails SQLite's integrity check (${e?.message || e})`);
        }
        if (!(result.length === 1 && result[0]?.integrity_check === 'ok')) {
            throw refuse(`fails SQLite's integrity check: ${result.slice(0, 3).map((r) => r.integrity_check).join('; ')}`);
        }

        const known = new Map(triggersAndViews(live).map((o) => [`${o.type} ${o.name}`, o.sql]));
        let carried: SchemaObject[];
        try {
            carried = triggersAndViews(handle);
        } catch (e: any) {
            throw refuse(`has a schema this server cannot read (${e?.message || e})`);
        }
        const unknown = carried.filter((o) => !known.has(`${o.type} ${o.name}`));
        if (unknown.length > 0) {
            const named = unknown.slice(0, 3).map((o) => `${o.type} "${o.name}"`).join(', ') + (unknown.length > 3 ? ', …' : '');
            throw refuse(`carries ${unknown.length === 1 ? 'a' : unknown.length} ${unknown.length === 1 ? unknown[0].type : 'triggers or views'} `
                + `this server's own database does not have (${named}): it was changed after the backup was made, `
                + 'or made by a newer version of BeanPool');
        }
        const remade = carried.filter((o) => known.get(`${o.type} ${o.name}`) !== o.sql);
        for (const o of remade) handle.exec(`DROP ${o.type === 'view' ? 'VIEW' : 'TRIGGER'} ${quoteName(o.name)}`);
        // Into the file itself before it is copied, whatever journal mode it was made in.
        if (remade.length > 0) handle.pragma('wal_checkpoint(TRUNCATE)');
        return { remade: remade.map((o) => `${o.type} ${o.name}`) };
    } finally {
        handle.close();
    }
}
