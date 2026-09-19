/**
 * Trust tiers — one source of truth (core TIER_LEVELS / getTier).
 *
 * Proves that the two places the server hands a tier (or a tier input) to someone else agree with the
 * member's own tier from getMemberTrustProfile:
 *   1. A post's authorEnergyCycled is the author's tier credit (CREDIT_BASE_FLOOR − floor), so
 *      tierForCredit(authorEnergyCycled) is the author's real tier. Before: it was the earned lane alone,
 *      so a granted Elder's cards said Newcomer.
 *   2. The admin member list (/api/local/admin/data) reports the same tier. Before: it read the granted
 *      column only and called any appointed voucher an Elder.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-trust-tiers-one-source.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestTiersOneSource123!';

import { tierForCredit } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, getMemberTrustProfile, getPosts } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';

const PORT = 8674;
const BASE = `https://localhost:${PORT}`;
const PW = 'TestTiersOneSource123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function seedMember(pk: string, granted = 0) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, earned_credit) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`).run(pk, pk, granted);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}
function seedOffer(id: string, author: string) {
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active) VALUES (?, 'offer', 'misc', 'test', 'test', 10, ?, 'active', 1)`).run(id, author);
}

async function main() {
    console.log('Running trust tiers one-source test...\n');
    initAdminPassword();
    await initTls();
    initStateEngine();

    // Granted credit sitting on each side of every boundary, plus a vouched-only member and a voucher.
    const cases: Array<[string, number]> = [
        ['tier-g0', 0], ['tier-g199', 199], ['tier-g200', 200], ['tier-g599', 599],
        ['tier-g600', 600], ['tier-g1399', 1399], ['tier-g1400', 1400],
    ];
    for (const [pk, granted] of cases) { seedMember(pk, granted); seedOffer(`post-${pk}`, pk); }
    seedMember('tier-voucher');
    db.prepare(`UPDATE members SET can_vouch = 1 WHERE public_key = 'tier-voucher'`).run();
    seedMember('tier-vouched');
    db.prepare(`UPDATE members SET elder_vouched_by = 'tier-voucher', vouch_credit = 100 WHERE public_key = 'tier-vouched'`).run();
    seedOffer('post-tier-vouched', 'tier-vouched');

    // 1. Post author tier input
    for (const [pk, granted] of [...cases, ['tier-vouched', 100] as [string, number]]) {
        const post = getPosts({ id: `post-${pk}` })[0];
        const own = getMemberTrustProfile(pk);
        assert(post?.authorEnergyCycled === -own.floor, `${pk}: post carries the author's tier credit ${-own.floor} (got ${post?.authorEnergyCycled})`);
        assert(tierForCredit(post?.authorEnergyCycled ?? NaN).name === own.tier.name,
            `${pk} (credit ${granted}): card tier ${tierForCredit(post?.authorEnergyCycled ?? NaN).name} = own tier ${own.tier.name}`);
    }
    assert(tierForCredit(getPosts({ id: 'post-tier-g1400' })[0].authorEnergyCycled!).name === 'Elder', 'a granted Elder shows as Elder on their cards');

    // 2. Admin member list
    await startHttpsServer(PORT);
    const res = await fetch(`${BASE}/api/local/admin/data`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': PW },
    });
    assert(res.status === 200, `admin data returns 200 (got ${res.status})`);
    const body = await res.json() as any;
    const byPk = new Map<string, any>((body.members ?? []).map((m: any) => [m.publicKey, m]));
    for (const pk of [...cases.map(c => c[0]), 'tier-vouched', 'tier-voucher']) {
        const own = getMemberTrustProfile(pk).tier.name;
        assert(byPk.get(pk)?.tier === own, `admin list: ${pk} is ${own} (got ${byPk.get(pk)?.tier})`);
    }
    assert(byPk.get('tier-voucher')?.canVouch === true && byPk.get('tier-voucher')?.tier === 'Newcomer',
        'an appointed voucher with no credit is a Newcomer who can vouch — vouching is not a tier');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
