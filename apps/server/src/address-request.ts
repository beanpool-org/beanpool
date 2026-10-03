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

/** In the node: the file's request, and the file gone; null when there is none. An unreadable file is removed. */
export function takeAddressRequestFile(dir: string): AddressRequestFile | null {
    const file = path.join(dir, ADDRESS_REQUEST_FILE);
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
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
