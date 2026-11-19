/**
 * Close the class (security inventory risks 2 and 3, 18 Nov): EVERY approval that grants a session or a grant through a
 * number match, in one table. The invariant, per row:
 *
 *   - the phone is handed six digits, drawn from the node's CSPRNG (crypto.randomInt), never fewer;
 *   - ONE wrong try ends it: the right digits typed after a wrong one give nothing, and the page must start again;
 *   - the right digits typed first give the session or the grant, once;
 *   - an app that can show only two digits (`confirm: true`, phones before this) is refused, 426, with nothing handed out;
 *   - an assistant's grant gets only the ticks the phone signed: a tick the page adds after the approval ends it.
 *
 * And a guard over the source: every server file that draws a digit code (randomInt of 100, 10,000, a million, or 10 ** N)
 * must be a row here, in the class and checked, or out of it with the reason written down. A new number match can't be
 * added without this table saying which it is.
 *
 * Module-level (the HTTP flows are test-settings-qr-signin.ts and test-admin-mcp-oauth.ts): a fresh data dir, no server.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-approval-number-match.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStateEngine, grantNodeRole, seedGenesisMember } from './state-engine.js';
import * as pairing from './settings-signin-pairing.js';
import { assistantConsentFields, settingsSigninFields } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { console.error(`  ✗ ${msg}`); process.exitCode = 1; }
}

interface Identity { pub: string; priv: crypto.KeyObject }
function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const NONE = { canPost: false, canModerate: false };

/** One path through the table: make a pairing, approve it as today's app does (or as an older one), type digits. */
interface Approval { pairingId: string; secret: string; code: string | undefined; approve: ReturnType<typeof pairing.approvePairing> }
interface Row {
    name: string;
    /** What it hands out when the right digits are typed. */
    grants: string;
    /** The source file whose digit code this row is. */
    file: string;
    class: 'in' | 'out';
    /** Out of the class: why, in one line. */
    why?: string;
    /** In the class: approve a fresh pairing (`older`: as a phone that can show only two digits). */
    approve?: (older?: boolean) => Approval;
    /** The kind the right digits redeem to. */
    issued?: string;
}

async function main(): Promise<void> {
    console.log('\n=== Every number-match approval that grants a session or a grant: six digits, one try ===\n');
    initStateEngine();
    const owner = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');

    const settingsApproval = (older = false): Approval => {
        const made = pairing.createPairing({ clientKey: `row-${crypto.randomUUID()}`, requesterAddress: '198.51.100.7' });
        if (!made.ok) throw new Error('create failed');
        const res = pairing.approvePairing({
            pairingId: made.pairingId, memberPubkey: owner.pub,
            ...settingsSigninFields(owner.priv, 'approve', made.pairingId, made.shortCode),
            confirm: older ? true : 'six-digits',
        } as any);
        return { pairingId: made.pairingId, secret: made.secret, code: res.ok ? res.confirmCode : undefined, approve: res };
    };
    const assistantApproval = (older = false, asks = { canPost: true, canModerate: false }): Approval => {
        const made = pairing.createPairing({ clientKey: `row-${crypto.randomUUID()}`, requesterAddress: '198.51.100.8', agent: { name: 'Table', sendsTo: 'assistant.example' } });
        if (!made.ok) throw new Error('create failed');
        (pairing as any).setPairingAsks?.(made.pairingId, made.secret, asks);
        const res = pairing.approvePairing({
            pairingId: made.pairingId, memberPubkey: owner.pub,
            ...(older
                ? { ...settingsSigninFields(owner.priv, 'approve', made.pairingId, made.shortCode), confirm: true }
                : { ...assistantConsentFields(owner.priv, made.pairingId, made.shortCode, asks), confirm: 'six-digits' }),
            agentShown: true,
        } as any);
        return { pairingId: made.pairingId, secret: made.secret, code: res.ok ? res.confirmCode : undefined, approve: res };
    };

    const TABLE: Row[] = [
        { name: 'Settings sign-in by QR', grants: 'a Settings session at the approver\'s role', file: 'settings-signin-pairing.ts', class: 'in', approve: settingsApproval, issued: 'signed-in' },
        { name: 'AI assistant consent (OAuth)', grants: 'an assistant grant that refreshes for 30 days', file: 'settings-signin-pairing.ts', class: 'in', approve: (older) => assistantApproval(older), issued: 'agent-approved' },
        {
            name: 'Device pairing (an account between phone and browser)', grants: 'a member\'s whole account to the browser, or a browser\'s to a phone',
            file: 'pairing-relay.ts', class: 'out',
            why: 'same class (a relayed QR, digits typed on the other screen): SPLIT OFF to the next slice, which moves its four digits and three tries to six and one on the server, both apps and their words together',
        },
        {
            name: 'Re-key by an admin\'s code', grants: 'a new key bound to a member\'s account',
            file: 'engine/rekey-redeem.ts', class: 'out',
            why: 'not this class: the two digits only pick which waiting phone the admin, with the member in front of them, binds; they are unique among that code\'s phones and nobody types a guess (re-key hardening is risk 4\'s lane)',
        },
    ];

    // ── The guard: every digit code in the server is a row ──
    console.log('The guard: every server file that draws a digit code is in the table');
    const drawsDigits = /crypto\.randomInt\(\s*(?:100|1_?000|10_?000|100_?000|1_?000_?000|10\s*\*\*\s*[A-Za-z_0-9]+)\s*\)/;
    const found: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p); continue; }
            if (!/\.ts$/.test(e.name) || /^(test-|bench-)|\.test\.ts$|-test-|test-helper/.test(e.name)) continue;
            if (drawsDigits.test(fs.readFileSync(p, 'utf8'))) found.push(path.relative(here, p));
        }
    };
    walk(here);
    const listed = new Set(TABLE.map(r => r.file));
    const unlisted = found.filter(f => !listed.has(f));
    assert(found.length >= 2 && unlisted.length === 0, `each of ${found.length} files drawing a digit code is a row (${found.join(', ')}); not in the table: ${unlisted.join(', ') || 'none'}`);
    for (const r of TABLE.filter(r => r.class === 'out')) assert(!!r.why && r.why.length > 40, `${r.name}: out of this slice, and why: ${r.why}`);

    // ── The CSPRNG ──
    console.log('\nThe draw: six digits from the node\'s CSPRNG, leading zeros kept');
    const src = fs.readFileSync(path.join(here, 'settings-signin-pairing.ts'), 'utf8');
    assert(/crypto\.randomInt\(10 \*\* PAIRING_CONFIRM_DIGITS\)\)\.padStart\(PAIRING_CONFIRM_DIGITS, '0'\)/.test(src) && !/Math\.random/.test(src),
        'the digits come from crypto.randomInt over the whole range (no modulo, no Math.random), zero-padded');
    assert((pairing as any).PAIRING_CONFIRM_DIGITS === 6 && (pairing as any).PAIRING_CONFIRM_TRIES === 1,
        `six digits, one try (${(pairing as any).PAIRING_CONFIRM_DIGITS} digits, ${(pairing as any).PAIRING_CONFIRM_TRIES} tries)`);
    const draws = Array.from({ length: 2000 }, () => (pairing as any).sixDigits?.() ?? '');
    assert(draws.every(d => /^\d{6}$/.test(d)) && new Set(draws).size >= 1990 && draws.some(d => d.startsWith('0')),
        `2,000 draws: all six digits, ${new Set(draws).size} different, leading zeros kept`);

    // ── Each row in the class ──
    for (const row of TABLE.filter(r => r.class === 'in')) {
        console.log(`\n${row.name} → ${row.grants}`);
        pairing.resetPairingsForTests();
        const a = row.approve!();
        assert(a.approve.ok && /^\d{6}$/.test(a.code ?? ''), `the phone is handed six digits (${a.code})`);

        // A relayed QR: the one who made it guesses. One wrong try ends it; the right digits after it give nothing.
        const wrongOf = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, '0');
        const wrong = pairing.confirmPairing(a.pairingId, a.secret, wrongOf(a.code!));
        const after = pairing.confirmPairing(a.pairingId, a.secret, a.code);
        assert(wrong.kind === 'refused' && after.kind === 'refused',
            `a wrong code fails on the FIRST try and ends the pairing; the right one after it gives nothing (${wrong.kind}, ${after.kind})`);
        assert(pairing.redeemPairing(a.pairingId, a.secret).kind === 'refused', 'the page is told it ended, and starts a new one');

        // Not six digits is a wrong try too, never "try again".
        const b = row.approve!();
        assert(pairing.confirmPairing(b.pairingId, b.secret, b.code!.slice(0, 2)).kind === 'refused', 'two of the digits are a wrong try, not a second chance');

        // The right digits first: the session or the grant, once. Typed as the phone groups them, too.
        const c = row.approve!();
        const right = pairing.confirmPairing(c.pairingId, c.secret, `${c.code!.slice(0, 3)} ${c.code!.slice(3)}`);
        assert(right.kind === row.issued, `the right digits give ${row.grants} (${right.kind})`);
        assert(pairing.confirmPairing(c.pairingId, c.secret, c.code).kind !== row.issued, 'and only once');

        // A phone that can show only two digits is refused before anything is handed out.
        const old = row.approve!(true);
        assert(!old.approve.ok && old.approve.status === 426 && !old.code, `an app that can show only two digits is refused, 426 (${old.approve.ok ? 'ok' : old.approve.status})`);

        if (row.issued === 'agent-approved') {
            const granted = right as { ticks?: { canPost: boolean; canModerate: boolean } };
            assert(granted.ticks?.canPost === true && granted.ticks?.canModerate === false, `the grant carries the ticks the phone signed, and only those (${JSON.stringify(granted.ticks)})`);
            const d = row.approve!();
            const added = pairing.confirmPairing(d.pairingId, d.secret, d.code, Date.now(), { canPost: true, canModerate: true } as any);
            assert(added.kind === 'refused', `a tick the page adds after the approval ends it, nothing granted (${added.kind})`);
            const e = assistantApproval(false, NONE);
            const plain = pairing.confirmPairing(e.pairingId, e.secret, e.code);
            assert(plain.kind === 'agent-approved' && (plain as any).ticks?.canPost === false && (plain as any).ticks?.canModerate === false,
                'nothing ticked on the phone: nothing beyond reading is granted');
        }
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
