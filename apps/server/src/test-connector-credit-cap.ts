/**
 * Credit-cap operator route (#143) — the control that lets a community choose how much credit it extends to
 * a peer, and the last blocker between the settlement code and a real cross-node trade.
 *
 * WHY THIS SUITE EXISTS. `settlementCapacity` fail-closes when no cap is configured, with a message telling the
 * operator to "choose a limit in Settings first" — and `setConnectorCreditCap` was called by nothing but its own
 * unit tests. So on every deployed node, every cross-node purchase refused, pointing at a control that did not
 * exist. Built, tested, unreachable: the same failure as the federation flags missing from docker-compose.
 *
 * WHY IT GOES OVER THE WIRE. The #144 review caught a route that 403'd on every real request while its own
 * 36 checks passed, because those checks drove the router handler directly and never crossed the signature
 * middleware. This suite starts a real HTTPS server and makes real requests, so "the operator can actually do
 * this" is what is being asserted — not "the function works when called".
 *
 * Run with a throwaway data dir (self-signed TLS):
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-connector-credit-cap.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { getConnectorCreditCap, getConnectorByAddress } from './connector-manager.js';
import { settlementCapacity } from './federation-bridge.js';

const PORT = 8551;
const BASE = `https://localhost:${PORT}`;
const PW = 'TestAdmin123!';

// A multiaddr with a peer id, because that is the shape a real connector carries and `peerIdFromAddress`
// reads the last /p2p/ component out of it.
const PEER_ID = '12D3KooWGippslandTestPeerIdPlaceholder00000000';
const ADDRESS = `/ip4/172.18.0.4/tcp/4001/p2p/${PEER_ID}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, json };
}

const setCap = (body: Record<string, unknown>) => post('/api/local/connectors/credit-cap', body);

async function main() {
    console.log('Running credit-cap operator route tests (#143)...\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // ── The operator's own path: add the peer, then choose a limit for it. ────────────────────────────────
    const added = await post('/api/local/connectors', {
        password: PW, address: ADDRESS, trustLevel: 'peer', callsign: 'eastgippy', enabled: true,
    });
    assert(added.status === 200, `setup: peer connector added over HTTP (got ${added.status})`);
    assert(getConnectorByAddress(ADDRESS) !== null, 'setup: the connector is readable back by address');

    // ── 1. THE GAP THIS CLOSES. Before a cap is chosen, settlement refuses — and that refusal is correct. ──
    const before = settlementCapacity(PEER_ID, ADDRESS, 5);
    assert(before.ok === false && before.reason === 'no_cap_configured',
        `1. with no cap chosen, settlement refuses with no_cap_configured (got ok=${before.ok} reason=${before.reason})`);

    // ── 2. Auth. The cap decides how much credit this community hands out, so it is admin-gated. ──────────
    const noPw = await setCap({ address: ADDRESS, cap: 100 });
    assert(noPw.status === 401, `2a. a missing password is rejected (got ${noPw.status})`);
    assert(getConnectorCreditCap(ADDRESS) === null, '2b. a rejected request sets nothing');

    const badPw = await setCap({ password: 'nope', address: ADDRESS, cap: 100 });
    assert(badPw.status === 401, `2c. a wrong password is rejected (got ${badPw.status})`);
    assert(getConnectorCreditCap(ADDRESS) === null, '2d. still nothing set');

    // ── 3. Shape. ─────────────────────────────────────────────────────────────────────────────────────────
    const noAddr = await setCap({ password: PW, cap: 100 });
    assert(noAddr.status === 400, `3a. a missing address is a 400 (got ${noAddr.status})`);

    const unknown = await setCap({ password: PW, address: '/ip4/10.0.0.9/tcp/4001/p2p/12D3KooWNotAConnector', cap: 100 });
    assert(unknown.status === 404, `3b. an address that is not one of our connectors is a 404 (got ${unknown.status})`);

    // THE OMISSION GUARD. An absent `cap` must not clear the cap, because clearing refuses every future
    // settlement with this peer — a client that dropped the field, or a truncated body, would otherwise freeze
    // a trading relationship silently. `null` clears (tested at 6); missing is a mistake.
    const absent = await setCap({ password: PW, address: ADDRESS });
    assert(absent.status === 400 && /required/i.test(absent.json?.error ?? ''),
        `3c. an ABSENT cap is a 400, not a silent clear (got ${absent.status} ${absent.json?.error ?? ''})`);

    const stringCap = await setCap({ password: PW, address: ADDRESS, cap: '100' });
    assert(stringCap.status === 400, `3d. a string cap is a 400, not coerced (got ${stringCap.status})`);
    assert(getConnectorCreditCap(ADDRESS) === null, '3e. none of the malformed requests set a cap');

    const negative = await setCap({ password: PW, address: ADDRESS, cap: -50 });
    assert(negative.status === 400, `3f. a negative cap is rejected, not coerced (got ${negative.status})`);

    const nan = await setCap({ password: PW, address: ADDRESS, cap: Number.NaN });
    // NaN does not survive JSON.stringify — it arrives as null, which is the documented "clear" value. This is
    // asserted rather than ignored so the behaviour is on the record: it clears, and clearing is already safe.
    assert(nan.status === 200, `3g. NaN arrives as JSON null and is treated as a clear (got ${nan.status})`);

    // ── 4. The happy path, and the thing it unblocks. ─────────────────────────────────────────────────────
    const set = await setCap({ password: PW, address: ADDRESS, cap: 100 });
    assert(set.status === 200 && set.json?.creditCap === 100,
        `4a. a cap of 100 is accepted and echoed back (got ${set.status} cap=${set.json?.creditCap})`);
    assert(getConnectorCreditCap(ADDRESS) === 100, '4b. the cap is readable back through the accessor');

    const after = settlementCapacity(PEER_ID, ADDRESS, 5);
    assert(after.ok === true,
        `4c. THE POINT: with a cap chosen, a 5-bean settlement is now permitted (got ok=${after.ok} reason=${after.reason})`);

    const over = settlementCapacity(PEER_ID, ADDRESS, 101);
    assert(over.ok === false,
        `4d. and the cap actually bounds it — 101 against a cap of 100 is refused (got ok=${over.ok})`);

    // ── 5. ZERO IS A REAL CAP, NOT AN ABSENT ONE. "Stay connected, extend no credit" is a position an
    //      operator may hold, and it must not collapse into "no cap configured", which is a different state
    //      with a different message. `creditCap ?? null` preserves 0 — this is the check that keeps it that way.
    const zero = await setCap({ password: PW, address: ADDRESS, cap: 0 });
    assert(zero.status === 200 && zero.json?.creditCap === 0, `5a. a cap of 0 is accepted (got ${zero.status} cap=${zero.json?.creditCap})`);
    assert(getConnectorCreditCap(ADDRESS) === 0, '5b. 0 survives the accessor and is not flattened to null');
    const atZero = settlementCapacity(PEER_ID, ADDRESS, 5);
    assert(atZero.ok === false && atZero.reason !== 'no_cap_configured',
        `5c. at a cap of 0 a purchase is refused for want of HEADROOM, not for want of a cap `
        + `(got reason=${atZero.reason})`);

    // ── 6. Clearing is deliberate and returns the pair to fail-closed. ───────────────────────────────────
    const cleared = await setCap({ password: PW, address: ADDRESS, cap: null });
    assert(cleared.status === 200 && cleared.json?.creditCap === null,
        `6a. an explicit null clears the cap (got ${cleared.status} cap=${cleared.json?.creditCap})`);
    assert(getConnectorCreditCap(ADDRESS) === null, '6b. the cap is gone');
    const reclosed = settlementCapacity(PEER_ID, ADDRESS, 5);
    assert(reclosed.ok === false && reclosed.reason === 'no_cap_configured',
        `6c. and settlement is fail-closed again — clearing is a working off-switch (got reason=${reclosed.reason})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ ALL CREDIT-CAP ROUTE CHECKS PASSED.');
}

main().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
