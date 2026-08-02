/**
 * Connector publicUrl — derivation, repair, and the operator's ability to just say what it is (#143).
 *
 * THE BUG THIS PINS DOWN. Both derivation sites did `address.split(':')`. That is correct for `host:port` and
 * wrong for a multiaddr, which contains no colon — so the whole address became the "host" and every multiaddr
 * connector was stored with:
 *
 *     publicUrl = "https:///ip4/172.18.0.4/tcp/4001/p2p/12D3Koo…"
 *
 * A multiaddr is the normal way a connector is added, so this was the normal case. Nothing caught it because
 * the only test applied to publicUrl anywhere is non-emptiness, and that string is not empty. It then flows
 * into two places that matter:
 *
 *   - `resolvedHomeNode` on an inbound cross-node purchase, which is RECORDED AGAINST THE VISITOR as the
 *     community their beans live in — the thing "charge home" depends on being right.
 *   - `getPeerOrigins()`, the CORS allowlist.
 *
 * And `loadConnectors` treats a missing publicUrl as "needs migration", so the bad value was regenerated on
 * every boot rather than converging on anything.
 *
 * Run with a throwaway data dir (self-signed TLS):
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-connector-public-url.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!';

import fs from 'node:fs';
import path from 'node:path';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';

const PORT = 8552;
const BASE = `https://localhost:${PORT}`;
const PW = 'TestAdmin123!';
const DATA_DIR = process.env.BEANPOOL_DATA_DIR || '.';
const CONNECTORS_PATH = path.join(DATA_DIR, 'connectors.json');

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function addConnectorOverHttp(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/api/local/connectors`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PW, trustLevel: 'peer', ...body }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, json };
}

async function main() {
    console.log('Running connector publicUrl tests (#143)...\n');

    // State engine first: the connector-manager load path reaches the db, so the schema has to exist before
    // initConnectorManager runs.
    initAdminPassword();
    await initTls();
    initStateEngine();

    // ── 1. THE REPAIR, on load. A connectors.json written by the old derivation must not survive a boot. ──
    //    Seeded before initConnectorManager so this exercises the real migrate-on-load path, and the stub node
    //    is enough because loadConnectors only needs `addEventListener`.
    const legacyAddress = '/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWSsNzGfGcKPJtYXdd6mP2inhccq5wCsM475D9eiHTT27j';
    fs.writeFileSync(CONNECTORS_PATH, JSON.stringify([{
        address: legacyAddress,
        trustLevel: 'peer',
        enabled: true,
        callsign: 'eastgippy',
        publicUrl: `https:///ip4/172.18.0.4/tcp/4001/p2p/12D3KooWSsNzGfGcKPJtYXdd6mP2inhccq5wCsM475D9eiHTT27j`,
        addedAt: 1,
    }], null, 2));

    const cm = await import('./connector-manager.js');
    cm.initConnectorManager({ addEventListener() { /* no-op */ } } as any);

    const repaired = cm.getConnectorByAddress(legacyAddress);
    assert(repaired?.publicUrl === 'https://172.18.0.4',
        `1a. a legacy 'https:///ip4/…' publicUrl is repaired on load to https://172.18.0.4 (got ${repaired?.publicUrl})`);

    // Written BACK, not just recomputed in memory — otherwise every boot repeats the repair and the file on
    // disk stays wrong for anything that reads it directly.
    const onDisk = JSON.parse(fs.readFileSync(CONNECTORS_PATH, 'utf-8'));
    assert(onDisk[0]?.publicUrl === 'https://172.18.0.4',
        `1b. and persisted to connectors.json (got ${onDisk[0]?.publicUrl})`);

    // ── 2. Derivation from each address shape an operator can actually type. ─────────────────────────────
    await startHttpsServer(PORT);

    const ip4 = await addConnectorOverHttp({ address: '/ip4/10.1.2.3/tcp/4001/p2p/12D3KooWDerivIp4', callsign: 'a' });
    assert(ip4.json?.connector?.publicUrl === 'https://10.1.2.3',
        `2a. /ip4/…  derives https://10.1.2.3 (got ${ip4.json?.connector?.publicUrl})`);

    const dns4 = await addConnectorOverHttp({ address: '/dns4/eastgippy.beanpool.org/tcp/443/wss/p2p/12D3KooWDerivDns4', callsign: 'b' });
    assert(dns4.json?.connector?.publicUrl === 'https://eastgippy.beanpool.org',
        `2b. /dns4/… derives https://eastgippy.beanpool.org (got ${dns4.json?.connector?.publicUrl})`);

    // THE p2p PORT IS NEVER CARRIED OVER. 4001 is the libp2p listener; the HTTPS API is not there. Deriving
    // `https://host:4001` would produce a URL that is well-formed and always wrong.
    assert(!String(dns4.json?.connector?.publicUrl).includes('4001')
        && !String(ip4.json?.connector?.publicUrl).includes('4001'),
        '2c. the libp2p port is not carried into the HTTPS origin');

    const hostPort = await addConnectorOverHttp({ address: 'melb.beanpool.org:8449', callsign: 'c' });
    assert(hostPort.json?.connector?.publicUrl === 'https://melb.beanpool.org:8449',
        `2d. host:port keeps a non-4001 port (got ${hostPort.json?.connector?.publicUrl})`);

    const host4001 = await addConnectorOverHttp({ address: 'melb2.beanpool.org:4001', callsign: 'd' });
    assert(host4001.json?.connector?.publicUrl === 'https://melb2.beanpool.org',
        `2e. host:4001 drops the p2p port (got ${host4001.json?.connector?.publicUrl})`);

    // No derivation may ever produce the malformed shape again, whatever the input.
    const allDerived = [ip4, dns4, hostPort, host4001].map(r => String(r.json?.connector?.publicUrl));
    assert(allDerived.every(u => !u.startsWith('https:///')),
        `2f. NONE of the derived values are 'https:///…' (got ${allDerived.join(', ')})`);

    // ── 3. The operator can just say it, and their value wins over any guess. ────────────────────────────
    const stated = await addConnectorOverHttp({
        address: '/ip4/172.18.0.3/tcp/4001/p2p/12D3KooWOperatorStated', callsign: 'e',
        publicUrl: 'https://gippsland.beanpool.org:8448',
    });
    assert(stated.json?.connector?.publicUrl === 'https://gippsland.beanpool.org:8448',
        `3a. an operator-supplied publicUrl wins over derivation (got ${stated.json?.connector?.publicUrl})`);

    // Normalised to a bare origin. A path or trailing slash would silently fail to match an Origin header,
    // because the CORS comparison is an exact string compare.
    const messy = await addConnectorOverHttp({
        address: '/ip4/172.18.0.9/tcp/4001/p2p/12D3KooWMessyUrl', callsign: 'f',
        publicUrl: 'https://bris.beanpool.org:8443/api/federation/?x=1',
    });
    assert(messy.json?.connector?.publicUrl === 'https://bris.beanpool.org:8443',
        `3b. path/query/trailing slash are stripped to the origin (got ${messy.json?.connector?.publicUrl})`);

    // ── 4. Rejected rather than stored. A bad publicUrl is a bad home node and a bad CORS entry. ─────────
    const notUrl = await addConnectorOverHttp({ address: 'x1.beanpool.org:4001', callsign: 'g', publicUrl: 'not a url' });
    assert(notUrl.status === 400, `4a. an unparseable publicUrl is a 400 (got ${notUrl.status})`);

    const ftp = await addConnectorOverHttp({ address: 'x2.beanpool.org:4001', callsign: 'h', publicUrl: 'ftp://x.org' });
    assert(ftp.status === 400, `4b. a non-http(s) scheme is a 400 (got ${ftp.status})`);

    const notString = await addConnectorOverHttp({ address: 'x3.beanpool.org:4001', callsign: 'i', publicUrl: 42 });
    assert(notString.status === 400, `4c. a non-string publicUrl is a 400 (got ${notString.status})`);

    // An omitted publicUrl is NOT an error — it means "derive one", which is the existing behaviour and the
    // path every already-deployed node takes.
    const omitted = await addConnectorOverHttp({ address: 'x4.beanpool.org:4001', callsign: 'j' });
    assert(omitted.status === 200 && omitted.json?.connector?.publicUrl === 'https://x4.beanpool.org',
        `4d. an omitted publicUrl still derives, and is not an error (got ${omitted.status} ${omitted.json?.connector?.publicUrl})`);

    // ── 5. AN UPDATE MUST NOT CLOBBER AN OPERATOR'S STATED URL (review finding). ─────────────────────────
    //    Re-adding the same address is how trust level and enabled are changed, and those calls carry no
    //    publicUrl. Deriving before the duplicate check meant every such call silently replaced a URL the
    //    operator had chosen with a guess — invisible until the day the guess is wrong.
    const stableAddress = '/ip4/172.18.0.3/tcp/4001/p2p/12D3KooWOperatorStated';
    const toggled = await addConnectorOverHttp({ address: stableAddress, callsign: 'e', enabled: false });
    assert(toggled.json?.connector?.publicUrl === 'https://gippsland.beanpool.org:8448',
        `5a. an update that omits publicUrl PRESERVES the operator's value (got ${toggled.json?.connector?.publicUrl})`);
    assert(toggled.json?.connector?.enabled === false, '5b. and the update it was actually making still applied');

    // Supplying one on an update still replaces it — this is the operator changing their mind.
    const changed = await addConnectorOverHttp({
        address: stableAddress, callsign: 'e', enabled: true, publicUrl: 'https://gippsland.beanpool.org:9999',
    });
    assert(changed.json?.connector?.publicUrl === 'https://gippsland.beanpool.org:9999',
        `5c. an update that DOES supply one replaces it (got ${changed.json?.connector?.publicUrl})`);

    // A malformed stored value is still repaired in passing, so a node reconfigured without a restart
    // converges as well — but only because the value was bad, never because a guess was available.
    const legacy = cm.getConnectorByAddress(legacyAddress);
    assert(legacy?.publicUrl === 'https://172.18.0.4', '5d. (the load-time repair from 1a is still in place)');

    // ── 6. IPv6 must be bracketed, or the URL is unparseable (review finding). ───────────────────────────
    const ip6 = await addConnectorOverHttp({ address: '/ip6/2001:db8::1/tcp/4001/p2p/12D3KooWIp6', callsign: 'k' });
    assert(ip6.json?.connector?.publicUrl === 'https://[2001:db8::1]',
        `6a. /ip6/… brackets the literal (got ${ip6.json?.connector?.publicUrl})`);

    // The point of bracketing: an unbracketed IPv6 origin throws in `new URL`, which is what the route's own
    // validator and every consumer of getPeerOrigins() rely on.
    let ip6Parses = true;
    try { new URL(String(ip6.json?.connector?.publicUrl)); } catch { ip6Parses = false; }
    assert(ip6Parses, '6b. and the derived origin actually parses as a URL');
    let unbracketedThrows = false;
    try { new URL('https://2001:db8::1'); } catch { unbracketedThrows = true; }
    assert(unbracketedThrows, '6c. (confirming the premise: the unbracketed form does throw)');

    const ip6HostPort = await addConnectorOverHttp({ address: '[::1]:8443', callsign: 'l' });
    assert(ip6HostPort.json?.connector?.publicUrl === 'https://[::1]:8443',
        `6d. a bracketed host:port is not shredded by the ':' split (got ${ip6HostPort.json?.connector?.publicUrl})`);

    // ── 7. A non-string publicUrl in connectors.json must not take the node down on boot (review finding). ─
    //    connectors.json is operator-editable, so a truthy non-string is reachable: `!c.publicUrl` is false and
    //    the startsWith call would throw during startup.
    fs.writeFileSync(CONNECTORS_PATH, JSON.stringify([
        { address: '/ip4/10.9.9.9/tcp/4001/p2p/12D3KooWJunkUrl', trustLevel: 'peer', enabled: true, publicUrl: true, addedAt: 2 },
    ], null, 2));
    let bootSurvived = true;
    try {
        cm.initConnectorManager({ addEventListener() { /* no-op */ } } as any);
    } catch {
        bootSurvived = false;
    }
    assert(bootSurvived, '7a. a non-string publicUrl does not throw during load');
    assert(cm.getConnectorByAddress('/ip4/10.9.9.9/tcp/4001/p2p/12D3KooWJunkUrl')?.publicUrl === 'https://10.9.9.9',
        '7b. and it is replaced with a derived value');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ ALL CONNECTOR PUBLIC-URL CHECKS PASSED.');
}

main().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
