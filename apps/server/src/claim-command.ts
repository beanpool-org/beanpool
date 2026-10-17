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
 *      Before the QR, a warning when the phone will refuse its address, or it carries none (phoneAddressWarning). A
 *      warning only: a server on a home network, and testing, still work.
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
import { CLAIM_SCRYPT, isPrivateHost, shouldBlockCleartextNodeUrl } from '@beanpool/core';
import { dataDir } from './recover-command.js';
import { ADDRESS_REQUEST_FILE, isAddressLabel, writeAddressRequestFile } from './address-request.js';
import { cleanLabel, REGISTRAR_CONTACT_MAX } from './config/clean-label.js';
import { NODE_HAS_OWNER_SQL } from './engine/owner-sql.js';

const CODE_SHAPE = /^claim-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;
const NAME_WAIT_MS = 3 * 60_000;
/** The node takes the file within ~2 s; past this it is probably not running. */
const PICKUP_WARN_MS = 15_000;

export const CLAIM_USAGE = `Usage: beanpool claim [--name <label> | --address https://your.domain | --no-name] [--direct http(s)://<ip>:<port>]
       beanpool claim --key <64-hex public key> --callsign <name>

The last step of an install: gives this community its address, then shows the one-time claim code and a QR code.
On your phone, scan the QR code, or open BeanPool → Find a community, type this server's address in the search box and
tap "Claim ‹name›": that phone becomes the owner.

  --name <label>      ask for <label>.beanpool.org (3–32 letters, digits or -). Asked for on a terminal.
  --address <url>     your own address (https://…); no beanpool.org name is asked for.
  --no-name           no address now; set one later in Settings.
  --direct <url>      this server's own address (http://<ip>:<port>), for the QR when no name is live yet.
                      Phones take a plain http:// address only on a home network (192.168.…, 10.…),
                      and https:// only by a name, never by a public IP address.
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
        owner = !!conn.prepare(NODE_HAS_OWNER_SQL).get();
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

/** `taken`: the node took the request and keeps asking; false when it never did, and the request was withdrawn. */
type NameOutcome = { kind: 'live'; address: string } | { kind: 'pending' } | { kind: 'timeout'; taken: boolean } | { kind: 'refused'; reason: string };

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
    // Never half-done: a request the node has not taken is withdrawn. The file already gone is the node having taken it.
    let taken = false;
    try { fs.unlinkSync(path.join(dir, ADDRESS_REQUEST_FILE)); } catch (e) { taken = (e as NodeJS.ErrnoException).code === 'ENOENT'; }
    out(`No answer within ${Math.round(waitMs / 1000)} s (last: ${last}).`);
    return { kind: 'timeout', taken };
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
    // A name that is not live yet (awaiting approval, or still asked for by the node): a later QR can carry it. A pending
    // record holds the label and no hostname, so it is named as it was asked for: <label>.beanpool.org.
    const pa = view.address;
    let coming: string | null = !address && held ? (pa?.hostname || (pa?.name ? `${pa.name}.beanpool.org` : held)) : null;
    // Once per address: none at all (the phone then asks, and refuses a public http:// one), or one the phone refuses. An
    // address it takes (http://192.168.…, https by a name) is never warned about, however the command got to it.
    const warnedFor = new Set<string>();
    const warnPhones = (to: string | null) => {
        if ((to && !phoneRefuses(to)) || warnedFor.has(to ?? '')) return;
        warnedFor.add(to ?? '');
        io.out('');
        for (const line of phoneAddressWarning(to, coming)) io.out(line);
    };
    if (!address && !noName && !held) {
        if (name === undefined && io.ask) {
            const typed = (await io.ask("Name for your community's address (<label>.beanpool.org), or Enter to skip: ")).toLowerCase();
            name = typed || undefined;
            if (name === undefined) warnPhones(direct);
        }
        while (name !== undefined) {
            if (!isAddressLabel(name)) {
                io.err(`"${name}" can't be a name: 3–32 letters, digits or -, not starting or ending with -.`);
                if (!io.ask) return 2;
            } else {
                const got = await askForName(dir, name, contact, view.claim.id, io.out);
                if (got.kind === 'live') { address = got.address; io.out(`✓ ${got.address} is live and reaches this server.`); break; }
                // Only a name still being asked for is on its way. What the QR carries meanwhile, the warning or the Address
                // line below says: --direct may not be known yet, and the phone refuses a public http:// one.
                if (got.kind === 'pending' || (got.kind === 'timeout' && got.taken)) coming = `${name}.beanpool.org`;
                if (got.kind === 'pending') {
                    io.out(`${name}.beanpool.org awaits approval by the BeanPool project. It moves over by itself once approved.`);
                    break;
                }
                if (got.kind === 'timeout') {
                    io.out(got.taken
                        ? `The node keeps asking for ${name}.beanpool.org.`
                        : `The node never took the request, so ${name}.beanpool.org was not asked for. Once the node is running (docker compose ps): beanpool claim --name ${name}`);
                    break;
                }
                if (got.kind !== 'refused') break;
                io.err(`The address service refused ${name}.beanpool.org: ${got.reason}`);
                if (!io.ask) { io.err('Nothing was changed.'); return 1; }
            }
            const again = (await io.ask("Another name (<label>.beanpool.org), or Enter to skip: ")).toLowerCase();
            name = again || undefined;
            if (name === undefined) warnPhones(direct);
        }
    }
    if (!address && !direct && io.ask) {
        const typed = await io.ask("This server's direct address for the phone (http://<ip>:<port>), or Enter to let the phone ask: ");
        direct = typed ? origin(typed, false) : null;
        if (typed && !direct) io.err('That is not an http(s)://<ip>:<port> address; the phone will ask for it.');
    }
    address = address || direct;
    // Before the QR.
    warnPhones(address);

    const link = `beanpool://claim?${address ? `node=${encodeURIComponent(address)}&` : ''}id=${view.claim.id}&code=${view.claim.code}`;
    io.out('');
    io.out(`The one-time claim code: ${view.claim.code}`);
    io.out('');
    io.out(await QRCode.toString(link, { type: 'terminal', small: true }));
    if (!address) io.out('The QR code carries no address: the phone will ask for this server\'s address.');
    else io.out(`Address: ${address}${phoneRefuses(address) ? ' (phones will not connect to it: see the warning above)' : ''}`);
    io.out('');
    for (const line of phoneSteps(address)) io.out(line);
    return 0;
}

/**
 * https:// to a public IPv4 address: the phone checks the certificate (it has no trust override), and a node has none a
 * phone trusts for an IP. Its own is self-signed for beanpool.local and 127.0.0.1 (services/tls.ts makeServerPair); a
 * Let's Encrypt one is for its hostname. A home-network IP is left alone, as for http.
 */
function httpsToPublicIp(to: string): boolean {
    const ip = /^https:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\/?$/i.exec(to)?.[1];
    return !!ip && !isPrivateHost(ip);
}

/** Whether the phone won't reach `to`: refused outright (a public http:// address), or failing TLS (https by public IP). */
export function phoneRefuses(to: string): boolean {
    return shouldBlockCleartextNodeUrl(to) || httpsToPublicIp(to);
}

/**
 * What the owner is told when the phone won't reach the address the QR gives it (17 Oct 2026: an AI assistant installed
 * a $6 server, ran `beanpool claim --no-name --direct http://<its IP>:80`, and the phone refused the QR: "The link named
 * an address BeanPool won't use"). The phone reaches a server on the internet only over https, by @beanpool/core's
 * shouldBlockCleartextNodeUrl, the rule read here too, so a home-network address (http://192.168.…) is never warned
 * about; over https, only by a name (httpsToPublicIp). `to` is the address the QR carries, null when it carries none;
 * `coming` is a name that is not live yet.
 * The two ways out stand as equals, a free <name>.beanpool.org or the owner's own domain, and neither is required.
 */
export function phoneAddressWarning(to: string | null, coming: string | null = null): string[] {
    return [
        to ? `WARNING: phones will not connect to ${to}.` : 'WARNING: with no https address, phones will not reach this server over the internet.',
        ...(to && httpsToPublicIp(to) ? [
            'A phone checks an https:// server\'s certificate, and this server has none a phone trusts for an IP address:',
            'https works by a name. Give this community an address phones can reach:',
        ] : [
            'The BeanPool app reaches a server on the internet only over https: a plain http:// address works',
            'only on a home network (192.168.…, 10.…). Give this community an address phones can reach:',
        ]),
        coming
            ? `  the name you asked for:  once ${coming} is live, run beanpool claim again; its QR code carries it`
            : '  a free name:      beanpool claim --name <name>   (<name>.beanpool.org: no ports to open, no DNS to set up)',
        '  your own domain:  beanpool claim --address https://your.domain   (a domain of yours serving this server over https)',
    ];
}

/**
 * The steps on the member's phone, named as the phone shows them: the QR opens apps/native/app/claim-community.tsx
 * (titled "Claim ‹name›" once it knows the server, "Claim a community" while it asks for the address); by hand it is
 * Find a community (app/find-community.tsx, reached from Home's "Communities near you"), whose search box offers
 * "Claim ‹name›" for a typed address with no owner. test-claim-cli checks each label is still in those files.
 */
function phoneSteps(address: string | null): string[] {
    const finish = 'fill in "Your name here" and tap "Claim and become owner".';
    return [
        address
            ? `On your phone, scan this QR code. BeanPool opens "Claim ‹name›" with the code filled in: ${finish}`
            : `On your phone, scan this QR code. BeanPool opens "Claim a community" with the code filled in: type this server's address under "Server address", tap "Check this server", ${finish}`,
        `Or open BeanPool → Find a community ("Communities near you" on Home), type ${address ?? "this server's address"} in the search box, tap "Claim ‹name›", type the code under "Claim code", ${finish}`,
        'That phone becomes the owner. The code works once.',
    ];
}
