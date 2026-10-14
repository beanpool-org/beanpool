/**
 * `beanpool claim` (node sign-in step 8, stage B2): the last step of an install. It sets the community's address first,
 * then shows the one-time claim code and a QR the phone scans, so the installer leaves the terminal with the name live
 * and the phone as owner.
 *
 *   1. Refused when the community already has an owner or has no claim code (claim-code.ts): `beanpool recover` then.
 *   2. The address: `--name <label>` (or asked, on a terminal) hands <label>.beanpool.org to the running node, which
 *      claims it with its own key (address-request.ts, services/public-address-agent.ts). `--address https://…` (your
 *      own domain) or `--no-name` skips it: nothing here needs the BeanPool project's registrar, DNS or tunnels, and a
 *      registrar that is down or refuses only means the QR carries the server's direct address.
 *   3. The code, from data/claim-code.txt, and a QR of beanpool://claim?node=<address>&id=<codeId>&code=<code>. The
 *      terminal is the operator's own shell, the same trust as `cat` on the file; nothing here writes the node's log.
 *
 * Its own process beside the node, as `beanpool recover` is: it reads local-config.json and state.db (read-only) and
 * writes neither; the name goes to the node in a file the node takes.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import { CLAIM_SCRYPT } from '@beanpool/core';
import { dataDir } from './recover-command.js';
import { ADDRESS_REQUEST_FILE, isAddressLabel, writeAddressRequestFile } from './address-request.js';
import { cleanLabel, REGISTRAR_CONTACT_MAX } from './config/clean-label.js';

const CODE_SHAPE = /^claim-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;
const NAME_WAIT_MS = 3 * 60_000;
/** The node takes the file within ~2 s; past this it is probably not running. */
const PICKUP_WARN_MS = 15_000;

export const CLAIM_USAGE = `Usage: beanpool claim [--name <label> | --address https://your.domain | --no-name] [--direct http(s)://<ip>:<port>]
       beanpool claim --key <64-hex public key> --callsign <name>

The last step of an install: gives this community its address, then shows the one-time claim code and a QR code.
Open BeanPool on your phone → Claim a community, or scan the QR code: that phone becomes the owner.

  --name <label>      ask for <label>.beanpool.org (3–32 letters, digits or -). Asked for on a terminal.
  --address <url>     your own address (https://…); no beanpool.org name is asked for.
  --no-name           no address now; set one later in Settings.
  --direct <url>      this server's own address (http://<ip>:<port>), for the QR when no name is live yet.
  --contact <email>   a contact for the BeanPool project, if the name awaits approval.
  --key, --callsign   make that key the owner from here, without a phone claim (it joins with that callsign).

Refused when the community already has an owner: use beanpool recover then.`;

interface NodeView {
    owner: boolean;
    claim: { id: string; code: string } | null;
    address: { name?: string; status?: string; hostname?: string; mode?: string } | null;
    request: { name: string; refused?: string | null } | null;
    communityName: string | null;
}

function readJson(file: string): any {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** What the node holds now, read without writing anything. */
export function readNodeView(dir = dataDir()): NodeView | { missing: string } {
    const dbPath = path.join(dir, 'state.db');
    if (!fs.existsSync(dbPath)) return { missing: `No node database at ${dbPath}. Run this inside the node's container, or set BEANPOOL_DATA_DIR.` };
    const config = readJson(path.join(dir, 'local-config.json')) || {};
    const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
    let owner = false, address: NodeView['address'] = null;
    try {
        conn.pragma('busy_timeout = 10000');
        // As engine/node-roles.ts nodeHasOwner reads it.
        owner = !!conn.prepare(`SELECT 1 FROM node_roles nr JOIN members m ON nr.member_pubkey = m.public_key
            WHERE nr.role = 'owner' AND m.status = 'active' UNION ALL SELECT 1 FROM suspended_node_roles WHERE role = 'owner' LIMIT 1`).get();
        const row = conn.prepare("SELECT value FROM node_config WHERE key = 'node_config'").get() as { value: string } | undefined;
        const pa = row ? (JSON.parse(row.value || '{}') as any).publicAddress : null;
        address = pa && typeof pa === 'object' ? pa : null;
    } finally {
        conn.close();
    }
    let claim: NodeView['claim'] = null;
    const c = config.claim;
    if (!owner && c && !c.claimedBy && typeof c.key === 'string' && typeof c.salt === 'string' && typeof c.id === 'string') {
        let code = '';
        try { code = fs.readFileSync(path.join(dir, 'claim-code.txt'), 'utf8').trim().toLowerCase(); } catch { /* none */ }
        if (CODE_SHAPE.test(code)) {
            // The file's code is the one the node waits for: K = scrypt(sha256(code), salt), as claim-code.ts claimKeyOf.
            const { N, r, p, dkLen } = CLAIM_SCRYPT;
            const k = crypto.scryptSync(crypto.createHash('sha256').update(code).digest('hex'), c.salt, dkLen, { N, r, p });
            if (k.toString('hex') === c.key) claim = { id: c.id, code };
        }
    }
    const req = config.addressRequest;
    return {
        owner, claim, address,
        request: req && typeof req.name === 'string' ? { name: req.name, refused: req.refused ?? null } : null,
        communityName: config.communityName || config.callsign || null,
    };
}

function heldAddress(view: NodeView): string | null {
    const pa = view.address;
    return pa && (pa.status === 'live' || pa.status === 'pending') ? (pa.hostname || pa.name || 'an address') : null;
}

/** A plain http(s) origin, or null. */
function origin(raw: string | undefined, httpsOnly: boolean): string | null {
    if (!raw) return null;
    try {
        const u = new URL(raw);
        if (u.protocol !== 'https:' && (httpsOnly || u.protocol !== 'http:')) return null;
        if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
        return u.origin;
    } catch {
        return null;
    }
}

/** Whether https://<hostname> reaches this node: its claim route answers with this code's id. */
async function nameReachesThisNode(hostname: string, codeId: string): Promise<boolean> {
    // A suite points this one fetch at its own server (NODE_ENV=test only): it cannot make <name>.beanpool.org resolve.
    const base = process.env.NODE_ENV === 'test' && process.env.BEANPOOL_CLAIM_CHECK_ORIGIN ? process.env.BEANPOOL_CLAIM_CHECK_ORIGIN : `https://${hostname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(`${base}/api/local/claim`, { signal: controller.signal });
        const body = await res.json().catch(() => null) as any;
        return !!body && body.unclaimed === true && body.codeId === codeId;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

type NameOutcome = { kind: 'live'; address: string } | { kind: 'pending' | 'timeout' } | { kind: 'refused'; reason: string };

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

async function askForName(dir: string, name: string, contact: string | null, codeId: string, out: (s: string) => void): Promise<NameOutcome> {
    writeAddressRequestFile(dir, { name, contact, at: Date.now() });
    out(`Asking for ${name}.beanpool.org. This can take a minute…`);
    const started = Date.now();
    let warned = false, last = 'no answer from the node yet';
    const waitMs = process.env.NODE_ENV === 'test' && Number(process.env.BEANPOOL_CLAIM_NAME_WAIT_MS) > 0 ? Number(process.env.BEANPOOL_CLAIM_NAME_WAIT_MS) : NAME_WAIT_MS;
    while (Date.now() - started < waitMs) {
        await pause(1000);
        const fileWaiting = fs.existsSync(path.join(dir, ADDRESS_REQUEST_FILE));
        if (fileWaiting) {
            if (!warned && Date.now() - started > PICKUP_WARN_MS) {
                warned = true;
                out('The node has not picked the name up yet. Is it running? (docker compose ps)');
            }
            continue;
        }
        const view = readNodeView(dir);
        if ('missing' in view) continue;
        const pa = view.address;
        if (pa?.name === name && pa.status === 'live' && pa.hostname) {
            last = `the address service says ${pa.hostname} is live; waiting for it to reach this server`;
            if (await nameReachesThisNode(pa.hostname, codeId)) return { kind: 'live', address: `https://${pa.hostname}` };
            continue;
        }
        if (pa?.name === name && pa.status === 'pending') return { kind: 'pending' };
        if (view.request?.name === name && view.request.refused) return { kind: 'refused', reason: view.request.refused };
        last = view.request?.name === name ? 'the node is asking the address service' : last;
    }
    // Never half-done: a request the node has not taken is withdrawn.
    try { fs.rmSync(path.join(dir, ADDRESS_REQUEST_FILE), { force: true }); } catch { /* gone */ }
    out(`No answer within ${Math.round(waitMs / 1000)} s (last: ${last}).`);
    return { kind: 'timeout' };
}

function flag(args: string[], name: string): string | undefined {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
}

export interface ClaimIo {
    out: (s: string) => void;
    err: (s: string) => void;
    /** A question on a terminal; null when there is none. */
    ask: ((q: string) => Promise<string>) | null;
}

export function terminalIo(): ClaimIo {
    const tty = !!process.stdin.isTTY;
    return {
        out: (s) => console.log(s),
        err: (s) => console.error(s),
        ask: tty ? async (q) => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            try { return (await rl.question(q)).trim(); } finally { rl.close(); }
        } : null,
    };
}

/** The command. Returns the exit code: 0 done, 1 refused (nothing changed), 2 usage. */
export async function runClaim(args: string[], io: ClaimIo = terminalIo(), dir = dataDir()): Promise<number> {
    const known = new Set(['--name', '--address', '--no-name', '--direct', '--contact', '--key', '--callsign']);
    for (let i = 0; i < args.length; i++) {
        if (!known.has(args[i])) { io.err(CLAIM_USAGE); return 2; }
        if (args[i] !== '--no-name') {
            if (!args[i + 1] || args[i + 1].startsWith('--')) { io.err(CLAIM_USAGE); return 2; }
            i++;
        }
    }
    let name = flag(args, '--name')?.toLowerCase();
    const ownAddress = flag(args, '--address');
    const noName = args.includes('--no-name');
    const directRaw = flag(args, '--direct');
    const contact = cleanLabel(flag(args, '--contact'), REGISTRAR_CONTACT_MAX) ?? null;
    if ([name !== undefined, ownAddress !== undefined, noName].filter(Boolean).length > 1) { io.err(CLAIM_USAGE); return 2; }
    if (args.includes('--key') !== args.includes('--callsign')) { io.err(CLAIM_USAGE); return 2; }
    if (name !== undefined && !isAddressLabel(name)) { io.err(`"${name}" can't be a name: 3–32 letters, digits or -, not starting or ending with -.`); return 2; }
    const own = ownAddress !== undefined ? origin(ownAddress, true) : null;
    if (ownAddress !== undefined && !own) { io.err(`--address takes an https:// address with nothing after the host, e.g. https://beans.example.org`); return 2; }
    let direct = directRaw !== undefined ? origin(directRaw, false) : null;
    if (directRaw !== undefined && !direct) { io.err('--direct takes http(s)://<ip or host>:<port>'); return 2; }

    const view = readNodeView(dir);
    if ('missing' in view) { io.err(`Nothing was changed. ${view.missing}`); return 1; }
    if (view.owner) { io.err('Nothing was changed. This community already has an owner. To add one from the server: beanpool recover --key <member public key | @callsign>'); return 1; }
    if (!view.claim) { io.err('Nothing was changed. This community has no claim code waiting. Restart the node to make one, or add an owner with: beanpool recover --key <member public key | @callsign>'); return 1; }
    const held = heldAddress(view);
    if (name !== undefined && held) { io.err(`Nothing was changed. This community already has an address (${held}). Change it in Settings → Address, signed in as an owner.`); return 1; }

    if (args.includes('--key')) {
        const { claimFromShell } = await import('./claim-shell-owner.js');
        return claimFromShell(flag(args, '--key')!, flag(args, '--callsign')!, view.claim.id, io, dir);
    }

    let address: string | null = own;
    if (!address && held && view.address?.status === 'live' && view.address.hostname) address = `https://${view.address.hostname}`;
    if (!address && !noName && !held) {
        if (name === undefined && io.ask) {
            const typed = (await io.ask("Name for your community's address (<label>.beanpool.org), or Enter to skip: ")).toLowerCase();
            name = typed || undefined;
        }
        while (name !== undefined) {
            if (!isAddressLabel(name)) {
                io.err(`"${name}" can't be a name: 3–32 letters, digits or -, not starting or ending with -.`);
                if (!io.ask) return 2;
            } else {
                const got = await askForName(dir, name, contact, view.claim.id, io.out);
                if (got.kind === 'live') { address = got.address; io.out(`✓ ${got.address} is live and reaches this server.`); break; }
                if (got.kind === 'pending') {
                    io.out(`${name}.beanpool.org awaits approval by the BeanPool project. It moves over by itself once approved; until then the phone uses this server's direct address.`);
                    break;
                }
                if (got.kind === 'timeout') { io.out('The phone will use this server\'s direct address for now; the name keeps being asked for by the node.'); break; }
                if (got.kind !== 'refused') break;
                io.err(`The address service refused ${name}.beanpool.org: ${got.reason}`);
                if (!io.ask) { io.err('Nothing was changed.'); return 1; }
            }
            const again = (await io.ask("Another name (<label>.beanpool.org), or Enter to skip: ")).toLowerCase();
            name = again || undefined;
        }
    }
    if (!address && !direct && io.ask) {
        const typed = await io.ask("This server's direct address for the phone (http://<ip>:<port>), or Enter to let the phone ask: ");
        direct = typed ? origin(typed, false) : null;
        if (typed && !direct) io.err('That is not an http(s)://<ip>:<port> address; the phone will ask for it.');
    }
    address = address || direct;

    const link = `beanpool://claim?${address ? `node=${encodeURIComponent(address)}&` : ''}id=${view.claim.id}&code=${view.claim.code}`;
    io.out('');
    io.out(`The one-time claim code: ${view.claim.code}`);
    io.out('');
    io.out(await QRCode.toString(link, { type: 'terminal', small: true }));
    if (!address) io.out('The QR code carries no address: the phone will ask for this server\'s address.');
    else io.out(`Address: ${address}`);
    io.out('Open BeanPool on your phone → Claim a community, or scan this. The code works once.');
    return 0;
}
