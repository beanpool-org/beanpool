/**
 * A name asked for at install: `beanpool claim --name <label>` hands <label>.beanpool.org to the running node.
 *
 * The command is its own process beside the node (`docker compose exec`), and the node rewrites local-config.json whole
 * on every save (config/local-config.ts saveLocalConfig, read-modify-write), so the command never writes that file: it
 * leaves data/address-request.json, whole or not at all (a 0600 temp file renamed over it), as `beanpool recover` leaves
 * its notice. The node takes the file within a few seconds (services/public-address-agent.ts), keeps the request in its
 * own local config (`addressRequest`, per-server: never in a backup, a staging copy or a standby) and claims the name
 * with its own key through claimAddress → persistAddress, as it does for PUBLIC_ADDRESS_NAME. No route takes a request:
 * only the server's shell can leave the file.
 *
 * No database or config import here: the command loads this.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ADDRESS_REQUEST_FILE = 'address-request.json';
/** The command's file is a few hundred bytes; anything bigger is not one. */
const MAX_REQUEST_BYTES = 4096;

/** The registrar's names (apps/registrar NAME_RE): 3–32, a–z 0–9 and -, no hyphen at either end. */
const LABEL_SHAPE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export interface AddressRequestFile {
    name: string;
    contact?: string | null;
    at: number;
}

export function isAddressLabel(name: unknown): name is string {
    return typeof name === 'string' && LABEL_SHAPE.test(name);
}

/** Left by the command. Throws naming the file. */
export function writeAddressRequestFile(dir: string, req: AddressRequestFile): void {
    const target = path.join(dir, ADDRESS_REQUEST_FILE);
    const tmp = path.join(dir, `.${ADDRESS_REQUEST_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
        fs.writeFileSync(tmp, JSON.stringify(req), { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmp, target);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* never made */ }
        throw new Error(`could not write ${target} (${(e as NodeJS.ErrnoException).code || 'error'})`);
    }
}

let lastAside = '';

/** Anything at the path that is not the command's file (a pipe, a link, a directory, a device, too big): moved aside, logged once. */
function setAside(file: string, what: string): null {
    const aside = `${path.join(path.dirname(file), '.' + ADDRESS_REQUEST_FILE)}.rejected-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    let moved = true;
    try { fs.renameSync(file, aside); } catch { moved = false; }
    const line = `[PublicAddr] ${file} is ${what}, not a request from beanpool claim: ${moved ? `moved to ${aside}` : 'left (it could not be moved)'}`;
    if (line.replace(/rejected-\S+/, '') !== lastAside) console.warn(line);
    lastAside = line.replace(/rejected-\S+/, '');
    return null;
}

/**
 * In the node: the file's request, and the file gone; null when there is none. Only a small regular file is read, opened
 * without following a link or waiting on a pipe (it runs on the node's 2 s tick: a read that blocks stops the node); an
 * unreadable one is removed, anything else moved aside (setAside).
 */
export function takeAddressRequestFile(dir: string): AddressRequestFile | null {
    const file = path.join(dir, ADDRESS_REQUEST_FILE);
    let st: fs.Stats;
    try { st = fs.lstatSync(file); } catch { return null; }
    if (!st.isFile()) return setAside(file, st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : st.isFIFO() ? 'a named pipe' : 'not a regular file');
    if (st.size > MAX_REQUEST_BYTES) return setAside(file, `${st.size} bytes`);
    let text: string;
    let fd = -1;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const open = fs.fstatSync(fd);
        // Swapped between the lstat and the open: still never read.
        if (!open.isFile() || open.size > MAX_REQUEST_BYTES) { fs.closeSync(fd); fd = -1; return setAside(file, 'not a regular file'); }
        const buf = Buffer.alloc(MAX_REQUEST_BYTES + 1);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        if (n > MAX_REQUEST_BYTES) { fs.closeSync(fd); fd = -1; return setAside(file, 'too big'); }
        text = buf.subarray(0, n).toString('utf8');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        if (fd >= 0) { try { fs.closeSync(fd); } catch { /* closed */ } fd = -1; }
        return setAside(file, `unreadable (${(e as NodeJS.ErrnoException).code || 'error'})`);
    } finally {
        if (fd >= 0) fs.closeSync(fd);
    }
    try { fs.unlinkSync(file); } catch { /* gone already */ }
    try {
        const req = JSON.parse(text);
        if (!req || !isAddressLabel(req.name)) return null;
        return { name: req.name, contact: typeof req.contact === 'string' ? req.contact : null, at: Number(req.at) || Date.now() };
    } catch {
        return null;
    }
}
