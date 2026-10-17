/**
 * `beanpool claim` warns when the phone will refuse the address its QR carries (17 Oct 2026: an AI assistant installed a
 * $6 server, ran `beanpool claim --no-name --direct http://<its IP>:80`, and the phone refused the QR, "The link named an
 * address BeanPool won't use", while the terminal had said nothing).
 *
 * No node runs here: the command reads a data dir this suite writes (state.db with no owner, a claim code waiting), as it
 * reads a real one, and talks through a fake terminal. No name is asked for, so nothing reaches a registrar.
 *   1. A public address over plain http: the warning, before the QR, naming the address and both ways out (a free name,
 *      your own https domain) as equals; the QR still prints (never a refusal) and the Address line points back at it.
 *   2. A home-network address, or an https one: no warning.
 *   3. The warning follows the phone's own rule (@beanpool/core shouldBlockCleartextNodeUrl) on a table of addresses.
 *   4. Enter at the name question, on a server with no https address: the warning at once, before the next question;
 *      once, not again before the QR; a public http:// address typed next still gets its own. With --direct given, Enter
 *      warns only where that address is refused, as --no-name does.
 *   5. --no-name with no address at all, off a terminal: the warning before the QR.
 *   6. A name that is not live yet: the way out is to run the claim again once it is, not to ask for another name. The
 *      node's pending record holds the label and no hostname, and the warning names <label>.beanpool.org.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-claim-address-warning.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { CLAIM_SCRYPT, shouldBlockCleartextNodeUrl } from '@beanpool/core';
import { phoneAddressWarning, runClaim, type ClaimIo } from './claim-command.js';

let run = 0, passed = 0;
function check(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`  ✓ ${msg}`); } else console.log(`  ✗ ${msg}`);
}

const CODE = 'claim-0a1b-2c3d-4e5f-6a7b';
const CODE_ID = '0a1b2c3d';
let dirs = 0;

/** A node's data dir with no owner and the claim code waiting, as claim-code.ts leaves it; `publicAddress` if given. */
function nodeDir(publicAddress?: object): string {
    const dir = path.join(process.env.BEANPOOL_DATA_DIR!, `node-${++dirs}`);
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'state.db'));
    db.exec(`CREATE TABLE members (public_key TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE node_roles (member_pubkey TEXT, role TEXT);
        CREATE TABLE suspended_node_roles (member_pubkey TEXT, role TEXT);
        CREATE TABLE invalidated_keys (public_key TEXT, reason TEXT, rekeyed_to TEXT);
        CREATE TABLE node_config (key TEXT PRIMARY KEY, value TEXT);`);
    if (publicAddress) db.prepare("INSERT INTO node_config (key, value) VALUES ('node_config', ?)").run(JSON.stringify({ publicAddress }));
    db.close();
    const salt = crypto.randomBytes(16).toString('hex');
    const { N, r, p, dkLen } = CLAIM_SCRYPT;
    const key = crypto.scryptSync(crypto.createHash('sha256').update(CODE).digest('hex'), salt, dkLen, { N, r, p }).toString('hex');
    fs.writeFileSync(path.join(dir, 'local-config.json'), JSON.stringify({ claim: { id: CODE_ID, salt, key } }));
    fs.writeFileSync(path.join(dir, 'claim-code.txt'), CODE + '\n');
    return dir;
}

/** A fake terminal: everything said, in order, with each question as a `? ` line; `answers` for the questions. */
async function claim(args: string[], answers: string[] | null = null, dir = nodeDir()) {
    const lines: string[] = [];
    const io: ClaimIo = {
        out: (s) => { lines.push(...s.split('\n')); },
        err: (s) => { lines.push(...s.split('\n')); },
        ask: answers ? async (q) => { lines.push(`? ${q}`); return answers.shift() ?? ''; } : null,
    };
    const code = await runClaim(args, io, dir);
    const at = (pred: (l: string) => boolean) => lines.findIndex(pred);
    // The QR: the first line of terminal blocks after the code.
    const qr = at(l => /[▀▄█]/.test(l));
    const warnings = lines.filter(l => l.startsWith('WARNING:'));
    return { code, lines, text: lines.join('\n'), qr, warnings, at };
}

const PUBLIC = 'http://203.0.113.7';
/** The warning's lines, the first naming what is wrong. */
const BLOCK = phoneAddressWarning(null).length;

async function main(): Promise<void> {
    console.log('\n1. A public address over plain http');
    const pub = await claim(['--no-name', '--direct', `${PUBLIC}:80`]);
    const w = pub.at(l => l.startsWith('WARNING:'));
    check(pub.code === 0, `never a refusal: the command still finishes (${pub.code})`);
    check(pub.qr > 0 && pub.text.includes(`The one-time claim code: ${CODE}`), 'the code and its QR still print');
    check(pub.warnings.length === 1 && pub.warnings[0].includes(`phones will not connect to ${PUBLIC}.`), `the warning names the address: ${pub.warnings[0]}`);
    check(w >= 0 && w < pub.qr && w < pub.at(l => l.startsWith('The one-time claim code')), 'the warning comes before the code and the QR');
    const after = pub.lines.slice(w, w + BLOCK).join('\n');
    check(after.includes('beanpool claim --name <name>') && after.includes('beanpool claim --address https://'),
        'both ways out, side by side: a free name and your own https domain');
    check(/only on a home network/.test(after), 'it says where plain http:// still works');
    check(pub.text.includes(`Address: ${PUBLIC} (phones will not connect to it: see the warning above)`), 'the Address line under the QR points back at it');

    console.log('\n2. A home-network or an https address: no warning');
    const lan = await claim(['--no-name', '--direct', 'http://192.168.1.20:8080']);
    check(lan.code === 0 && lan.warnings.length === 0 && lan.text.includes('Address: http://192.168.1.20:8080\n'), 'http://192.168.1.20:8080: none');
    const own = await claim(['--address', 'https://beans.example.org']);
    check(own.code === 0 && own.warnings.length === 0 && own.text.includes('Address: https://beans.example.org'), '--address https://beans.example.org: none');
    const live = await claim([], null, nodeDir({ name: 'mullum', status: 'live', hostname: 'mullum.beanpool.org' }));
    check(live.code === 0 && live.warnings.length === 0 && live.text.includes('Address: https://mullum.beanpool.org'), 'a live name already held: none');
    const httpsDirect = await claim(['--no-name', '--direct', 'https://203.0.113.7:8443']);
    check(httpsDirect.warnings.length === 0, 'https://203.0.113.7:8443 (the server itself, over https): none');

    console.log('\n3. The phone\'s own rule decides');
    const table = ['http://203.0.113.7:8080', 'http://beans.example.org', 'http://172.32.0.1', 'http://10.0.0.5', 'http://172.16.4.4:8080',
        'http://127.0.0.1:8080', 'http://beanpool.local', 'http://raspberrypi:8080', 'http://[fd00::1]:8080', 'https://beans.example.org'];
    let agree = 0;
    for (const address of table) {
        const r = await claim(['--no-name', '--direct', address]);
        if ((r.warnings.length === 1) === shouldBlockCleartextNodeUrl(address)) agree++;
        else console.log(`    ${address}: warned ${r.warnings.length}, phone refuses ${shouldBlockCleartextNodeUrl(address)}`);
    }
    check(agree === table.length, `warned exactly where the phone refuses (${agree}/${table.length})`);
    check(table.filter(shouldBlockCleartextNodeUrl).length === 3, 'the table holds both kinds (3 refused, 7 not)');

    console.log('\n4. Enter at the name question');
    const skip = await claim([], ['', '']);
    const nameQ = skip.at(l => l.startsWith('? Name for your community'));
    const directQ = skip.at(l => l.startsWith("? This server's direct address"));
    const sw = skip.at(l => l.startsWith('WARNING:'));
    check(nameQ >= 0 && directQ > nameQ && sw > nameQ && sw < directQ, 'the warning comes at once, before the next question');
    check(skip.warnings.length === 1 && /with no https address, phones will not reach this server/.test(skip.warnings[0]), `said once, not again before the QR: ${skip.warnings.length}`);
    check(skip.lines.slice(sw, sw + BLOCK).join('\n').includes('beanpool claim --name <name>'), 'it offers the name it just skipped, and your own domain');
    const typed = await claim([], ['', `${PUBLIC}:80`]);
    check(typed.warnings.length === 2 && typed.warnings[1].includes(`phones will not connect to ${PUBLIC}.`)
        && typed.at(l => l === typed.warnings[1]) < typed.qr, 'a public http:// address typed next gets its own, before the QR');
    const lanTyped = await claim([], ['', 'http://192.168.1.20:8080']);
    check(lanTyped.warnings.length === 1, 'a home-network address typed next: only the one said at Enter');
    // --direct already on the command line: Enter decides nothing about the address, so the outcome is --no-name's.
    const lanDirect = await claim(['--direct', 'http://192.168.1.20:8080'], ['']);
    check(lanDirect.code === 0 && lanDirect.warnings.length === 0 && lanDirect.text.includes('Address: http://192.168.1.20:8080\n'),
        `--direct http://192.168.1.20:8080, Enter: none (${lanDirect.warnings.length})`);
    const httpsDirectEnter = await claim(['--direct', 'https://203.0.113.7:8443'], ['']);
    check(httpsDirectEnter.warnings.length === 0, `--direct https://203.0.113.7:8443, Enter: none (${httpsDirectEnter.warnings.length})`);
    const pubDirect = await claim(['--direct', `${PUBLIC}:80`], ['']);
    const pdw = pubDirect.at(l => l.startsWith('WARNING:'));
    check(pubDirect.warnings.length === 1 && pubDirect.warnings[0].includes(`phones will not connect to ${PUBLIC}.`)
        && pdw > pubDirect.at(l => l.startsWith('? Name for your community')) && pdw < pubDirect.qr,
        `--direct ${PUBLIC}:80, Enter: the one warning, naming the address (${pubDirect.warnings.length})`);
    // Enter at "Another name" (after a name that can't be one) is the same skip.
    const lanAgain = await claim(['--direct', 'http://192.168.1.20:8080'], ['x', '']);
    check(lanAgain.at(l => l.startsWith('? Another name')) >= 0 && lanAgain.warnings.length === 0,
        `--direct http://192.168.1.20:8080, Enter at "Another name": none (${lanAgain.warnings.length})`);
    const noneAgain = await claim([], ['x', '', '']);
    check(noneAgain.warnings.length === 1 && noneAgain.at(l => l.startsWith('WARNING:')) < noneAgain.at(l => l.startsWith("? This server's direct address")),
        `no --direct, Enter at "Another name": the warning at once (${noneAgain.warnings.length})`);

    console.log('\n5. --no-name with no address, off a terminal');
    const none = await claim(['--no-name']);
    check(none.code === 0 && none.warnings.length === 1 && none.at(l => l.startsWith('WARNING:')) < none.qr && /phone will ask/.test(none.text),
        'the warning before the QR, which carries no address');

    console.log('\n6. A name that is not live yet');
    const pending = await claim(['--direct', `${PUBLIC}:80`], null, nodeDir({ name: 'mullum', mode: 'tunnel', status: 'pending' }));
    const pw = pending.at(l => l.startsWith('WARNING:'));
    const tail = pending.lines.slice(pw, pw + BLOCK).join('\n');
    check(pending.code === 0 && pw >= 0 && pw < pending.qr, 'warned before the QR');
    check(tail.includes('once mullum.beanpool.org is live, run beanpool claim again') && !tail.includes('--name <name>') && tail.includes('--address https://'),
        'the way out is to wait for the name (or your own domain), not to ask for another');

    console.log('\n7. The words');
    const lines = [...phoneAddressWarning(PUBLIC), ...phoneAddressWarning(null), ...phoneAddressWarning(PUBLIC, 'x.beanpool.org')];
    check(lines.every(l => l.length <= 120), 'every line fits a wide terminal (≤ 120 characters)');
    check(lines.every(l => !/beanpool\.org (?:is )?(?:required|needed)/i.test(l)), 'nothing says a beanpool.org name is required');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
