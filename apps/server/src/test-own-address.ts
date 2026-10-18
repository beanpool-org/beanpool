/**
 * An address of the server's own (design scratch/global-node/DESIGN-https-anywhere-fable.md §3, §4, S2): its public IP
 * (`beanpool claim --ip`) or the owner's own domain (`--address`), as the node stores it (services/public-address-agent.ts
 * storeOwnAddress) from the command's file or from Settings (POST /api/local/admin/public-address/own).
 *
 *   1. /own { ip }: the IP is the community's address (publicAddress { mode: 'ip', hostname }) and in the owner-confirmed
 *      list; members' signatures for it are this community's (`own`), it is published, primary, the directory's
 *      publicUrl, and a certificate identifier; the certificate scheduler looks at it at once, not in an hour; the
 *      registrar is asked nothing, not by the route and not by the agent's tick.
 *   2. Refused, nothing changed: an admin who is not an owner; no address, or both; a home-network, loopback or carrier-NAT
 *      IP; an IPv6 address sent as `ip`; a beanpool.org name (the global node's among them), a `.local` one, an IP sent as
 *      a domain; on a standby.
 *   3. { domain } later: a name beats an IP. The domain becomes the community's address and primary; the IP stays this
 *      community's and published. An IP given after it never displaces it. A home-network name listed on the server
 *      (`.local`, `.lan`) never beats the IP: nobody outside can reach it.
 *   4. The registrar's routes leave an own address alone: Take offline is refused (nothing is released unnamed), and a
 *      BeanPool name the registrar says this key holds replaces it as the community's address with nothing of it mixed
 *      in, while the IP and the domain stay accepted.
 *   5. Removed in Settings → Network: an own address that was the community's address stops being that too. With none
 *      left, a public IP is primary before a home-network name published ahead of it.
 *   6. The command's file (address-request.ts kinds ip and domain): taken within the node's tick and stored; one that
 *      can't be this server's address is not, and the log says why.
 *   7. Given again after its order failed (`beanpool claim --ip` run again once port 80 is open): ordered at once, past
 *      the back-off, its count started again; not twice within a minute; and the CA is still asked unconfirmed at most
 *      once a day.
 *   8. A name the server is given (CF_RECORD_NAME, a domain or a bare fleet label) is never replaced by an own address:
 *      the IP or domain, from /own or the command's file, is kept beside it, and the name stays this community's (no
 *      421 for members' apps signing for it), published, primary and the directory's publicUrl. A name set on the server
 *      after an own address became the community's is this community's too.
 *   9. Moving the community's live own address to another of its kind (a domain to another domain, an IP to another IP)
 *      asks for the owner's fresh proof, as the claim route does over a live name (design case 18, B3): refused with no
 *      code, nothing changed; moved with a current one, the old address still accepted. The same one again, an IP kept
 *      beside a domain, the first address and a first name over an IP stay plain. One refused anyway (the list is full)
 *      is refused for that, with no code asked for.
 *
 * No real registrar, CA or BeanPool node: the registrar is a fake HTTP server here, and the certificate scheduler's order
 * is a stand-in that records what it was asked for and fails.
 *
 * Run: BEANPOOL_SUITE_ENV_PASSWORD=1 BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-own-address.ts
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import Koa from 'koa';
import type { AddressInfo } from 'node:net';

for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'BEANPOOL_ADDRESSES', 'NODE_ROLE', 'PUBLIC_ADDRESS_NAME', 'PUBLIC_ADDRESS_AUTO']) delete process.env[k];
process.env.ACME_DIRECTORY_URL = 'http://127.0.0.1:9/directory';   // never reached: the order is a stand-in below

const { startP2P } = await import('./p2p.js');
const se = await import('./state-engine.js');
const { createPublicAddressRoutes } = await import('./routes/public-address.js');
const { createAppAddressesRoutes } = await import('./routes/app-addresses.js');
const own = await import('./engine/own-addresses.js');
const agent = await import('./services/public-address-agent.js');
const { writeAddressRequestFile, ADDRESS_REQUEST_FILE } = await import('./address-request.js');
const schedule = await import('./services/acme/schedule.js');
const { readState: readAcmeState } = await import('./services/acme/store.js');
const { setNodeRole } = await import('./config/node-role.js');
const { dataDir } = await import('./recover-command.js');
const { updateLocalConfig } = await import('./config/local-config.js');
const { generateTotpSecret, generateTotpCode, forgetUsedTotpCodesForTests } = await import('./totp.js');

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
    if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const show = (v: unknown) => JSON.stringify(v);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── The fake registrar: counts every request; /status answers what `registrar` says ──
const registrar = { calls: [] as string[], status: { status: 'none' } as Record<string, unknown> };
const fakeRegistrar = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        registrar.calls.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url?.startsWith('/api/registrar/status') ? registrar.status : { status: 'released' }));
    });
});
await new Promise<void>((r) => fakeRegistrar.listen(0, '127.0.0.1', () => r()));
process.env.REGISTRAR_URL = `http://127.0.0.1:${(fakeRegistrar.address() as AddressInfo).port}`;

se.initStateEngine();
await startP2P(0, 0);   // the node's identity, which signs what it sends the registrar

// The certificate scheduler, running as on a node, with an order that records its identifier and asks no CA. With
// `selfCheck` set, the order's self-check fails with those words and asks the scheduler whether to go to the CA anyway
// (its answers in `askedAnyway`, by identifier), as order.ts does.
const ordered: string[] = [];
let selfCheck: string | null = null;
const askedAnyway: [string, boolean][] = [];
schedule._setScheduleHooksForTests({ order: async (target, opts) => {
    ordered.push(target.host);
    if (selfCheck !== null) {
        const anyway = !!opts.orderUnconfirmed?.(selfCheck);
        askedAnyway.push([target.host, anyway]);
        if (!anyway) throw new Error(selfCheck);
    }
    throw new Error('no CA in this suite');
} });
schedule.startAcmeScheduler();
/** Every tick under way finished, then one more: what the scheduler makes of each identifier with nothing handed over. */
async function settledTick(): Promise<Awaited<ReturnType<typeof schedule.runAcmeTick>>> {
    for (let i = 0; i < 200; i++) {
        const t = await schedule.runAcmeTick();
        if (t.skipped !== 'running') return t;
        await pause(25);
    }
    throw new Error('the certificate scheduler never finished its tick');
}

let role: 'owner' | 'admin' = 'owner';
// `fresh`: as the real checkAdminAuth for the password sent with a current code (the owner's fresh proof). Off, the
// session alone: a change that asks for the proof wants a `code` with the request (section 9).
let fresh = true;
const deps = {
    checkAdminAuth: async (ctx: any) => {
        ctx.state.adminRole = role;
        ctx.state.actor = `the ${role} in this suite`;
        if (fresh) ctx.state.secondFactorJustVerified = true;
        return true;
    },
} as any;
const app = new Koa();
app.use(async (ctx: any, next) => {
    if (ctx.method === 'POST') {
        const text = await new Promise<string>((resolve) => { let d = ''; ctx.req.on('data', (c: Buffer) => { d += c; }); ctx.req.on('end', () => resolve(d)); });
        try { ctx.requestBody = JSON.parse(text || '{}'); } catch { ctx.requestBody = {}; }
    }
    await next();
});
for (const router of [createPublicAddressRoutes(deps), createAppAddressesRoutes(deps)]) app.use(router.routes()).use(router.allowedMethods());
const server = http.createServer(app.callback());
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function post(p: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const pa = () => (se.getNodeConfig() as any).publicAddress;
const owned = () => own.ownerConfirmedAddresses();
const IP = '203.0.113.5';
const DOMAIN = 'beans.example.org';

try {
    console.log('\n1. /own { ip }: the community\'s address, with nothing asked of the registrar');
    check('precondition: a node that knows none of its names', !own.knowsItsNames() && own.primaryAddress() === null);
    const r1 = await post('/api/local/admin/public-address/own', { ip: IP });
    check('200, the address and its kind', r1.status === 200 && r1.body?.address === IP && r1.body?.kind === 'ip' && r1.body?.communityAddress === true, show(r1));
    check('publicAddress is { mode: ip, hostname, status: live, since }', pa()?.mode === 'ip' && pa()?.hostname === IP && pa()?.status === 'live'
        && Number.isFinite(Date.parse(pa()?.since)) && pa()?.tunnelToken === undefined && pa()?.name === undefined, show(pa()));
    check('…and it is in the owner-confirmed list, which only an owner shortens', show(owned()) === show([IP]), show(owned()));
    check('a member\'s signature for the IP is this community\'s', own.audienceStanding(IP) === 'own');
    check('…and one for any other host is another community\'s (the node knows its name now)', own.audienceStanding('198.51.100.7') === 'foreign'
        && own.audienceStanding('localhost') === 'foreign');
    check('published, primary, and the directory\'s publicUrl', show(own.publishedAddresses()) === show([IP]) && own.primaryAddress() === IP
        && se.getDirectoryInfo().publicUrl === `https://${IP}`, show({ published: own.publishedAddresses(), primary: own.primaryAddress(), url: se.getDirectoryInfo().publicUrl }));
    check('a certificate identifier', own.tlsIdentifiers().includes(IP), show(own.tlsIdentifiers()));
    for (let i = 0; i < 50 && !ordered.includes(IP); i++) await pause(100);
    check('the certificate scheduler looked at it at once (an order, not the next hourly tick)', ordered.includes(IP), show(ordered));
    await agent.reconcile();
    check('the registrar was asked nothing: not by the route, not by the agent\'s tick', registrar.calls.length === 0, show(registrar.calls));
    const again = await post('/api/local/admin/public-address/own', { ip: IP });
    check('the same IP again: 200, nothing written', again.status === 200 && pa()?.hostname === IP && show(owned()) === show([IP]), show(again));

    console.log('\n2. Refused, and nothing changed');
    const before = show(se.getNodeConfig());
    role = 'admin';
    const asAdmin = await post('/api/local/admin/public-address/own', { ip: '198.51.100.7' });
    check('an admin who is not an owner: 403', asAdmin.status === 403, show(asAdmin));
    role = 'owner';
    const refusals: [string, unknown, RegExp][] = [
        ['no address', {}, /Send \{ "ip"/],
        ['both', { ip: '198.51.100.7', domain: DOMAIN }, /Send \{ "ip"/],
        ['a home-network IP', { ip: '192.168.1.20' }, /home network/],
        ['this machine', { ip: '127.0.0.1' }, /home network or this machine/],
        ['a carrier-NAT IP', { ip: '100.64.0.9' }, /not a public IP address/],
        // core's isPublicIpv4, the phone's rule too: a number the phone refuses as a community's address is never stored here.
        ['a benchmarking-network IP', { ip: '198.18.0.1' }, /not a public IP address/],
        ['the last benchmarking-network IP', { ip: '198.19.255.254' }, /not a public IP address/],
        ['an IPv6 address as ip', { ip: '2001:db8::7' }, /not an IPv4 address/],
        ['not an address at all', { ip: 'yes please' }, /not an IPv4 address/],
        ['a beanpool.org name', { domain: 'riverbend.beanpool.org' }, /BeanPool name/],
        ['the global node', { domain: 'global.beanpool.org' }, /BeanPool name/],
        ['a .local name', { domain: 'beanpool.local' }, /home network/],
        ['a name under a test domain', { domain: 'beans.test' }, /not a name a public certificate authority can check/],
        ['an IP sent as a domain', { domain: '198.51.100.7' }, /not a name/],
    ];
    for (const [what, body, words] of refusals) {
        const r = await post('/api/local/admin/public-address/own', body);
        check(`${what}: 400, saying why`, r.status === 400 && words.test(r.body?.error ?? ''), show(r));
    }
    setNodeRole('backup');
    const onStandby = await post('/api/local/admin/public-address/own', { ip: '198.51.100.7' });
    setNodeRole('primary');
    check('on a standby: 409, set it on the main server', onStandby.status === 409 && /main server/.test(onStandby.body?.error ?? ''), show(onStandby));
    check('nothing changed by any of them', show(se.getNodeConfig()) === before);

    console.log('\n3. A name beats an IP');
    // Names on the home network the operator lists beside it: nobody outside can reach them, so newcomers are never sent there.
    process.env.BEANPOOL_ADDRESSES = 'beanpool.local,nas.lan';
    own.forgetOwnAddresses();
    check('precondition: a .local and a .lan name in BEANPOOL_ADDRESSES are published beside the IP', show(own.publishedAddresses())
        === show([IP, 'beanpool.local', 'nas.lan']), show(own.publishedAddresses()));
    check('…and leave the IP primary, where /api/community/info sends newcomers', own.primaryAddress() === IP, String(own.primaryAddress()));
    const r3 = await post('/api/local/admin/public-address/own', { domain: 'Beans.Example.org.' });
    check('/own { domain }: 200, the domain as signatures carry it, the community\'s address', r3.status === 200 && r3.body?.address === DOMAIN
        && r3.body?.kind === 'own' && r3.body?.communityAddress === true, show(r3));
    check('publicAddress is { mode: own, hostname: the domain }', pa()?.mode === 'own' && pa()?.hostname === DOMAIN, show(pa()));
    check('the domain is primary, and the directory\'s publicUrl', own.primaryAddress() === DOMAIN && se.getDirectoryInfo().publicUrl === `https://${DOMAIN}`
        && r3.body?.primaryAddress === DOMAIN, show({ primary: own.primaryAddress(), url: se.getDirectoryInfo().publicUrl }));
    check('the IP is still this community\'s, and still published', own.audienceStanding(IP) === 'own' && own.audienceStanding(DOMAIN) === 'own'
        && own.publishedAddresses().includes(IP) && own.publishedAddresses().includes(DOMAIN), show(own.publishedAddresses()));
    const ip2 = '198.51.100.20';
    const r3b = await post('/api/local/admin/public-address/own', { ip: ip2 });
    check('an IP given after the domain never displaces it', r3b.status === 200 && r3b.body?.communityAddress === false && pa()?.hostname === DOMAIN
        && own.primaryAddress() === DOMAIN, show({ r3b, pa: pa() }));
    check('…it is this community\'s too, and published', own.audienceStanding(ip2) === 'own' && owned().includes(ip2), show(owned()));
    check('…and both IPs and the domain are certificate identifiers', [IP, DOMAIN, ip2].every((h) => own.tlsIdentifiers().includes(h)), show(own.tlsIdentifiers()));
    check('the domain beside the IP and the home-network names: the domain primary', own.primaryAddress() === DOMAIN
        && own.publishedAddresses().includes('beanpool.local'), show({ primary: own.primaryAddress(), published: own.publishedAddresses() }));
    delete process.env.BEANPOOL_ADDRESSES;
    own.forgetOwnAddresses();

    console.log('\n4. The registrar\'s routes leave an own address alone');
    const off = await post('/api/local/admin/public-address/offline', {});
    check('Take offline: 409, nothing to release, saying where an own address is removed', off.status === 409
        && /not a BeanPool name/.test(off.body?.error ?? '') && /Settings → Network/.test(off.body?.error ?? ''), show(off));
    check('…the registrar was asked nothing, and the address stands', registrar.calls.length === 0 && pa()?.hostname === DOMAIN, show(registrar.calls));
    registrar.status = { status: 'live', name: 'riverbend', hostname: 'riverbend.beanpool.org', mode: 'direct' };
    const st = await fetch(`${base}/api/local/admin/public-address/status`).then((r) => r.json()) as any;
    const after = pa();
    check('Settings\' status read: the BeanPool name this key holds is stored as the community\'s address', st?.success === true
        && after?.name === 'riverbend' && after?.hostname === 'riverbend.beanpool.org', show(after));
    check('…with nothing of the own address mixed in (no mode own, no since)', after?.mode === 'direct' && after?.since === undefined, show(after));
    check('…the BeanPool name is primary now', own.primaryAddress() === 'riverbend.beanpool.org', String(own.primaryAddress()));
    check('…and the domain and both IPs stay this community\'s, published', [DOMAIN, IP, ip2].every((h) => own.audienceStanding(h) === 'own'
        && own.publishedAddresses().includes(h)), show(own.publishedAddresses()));
    const r4 = await post('/api/local/admin/public-address/own', { ip: '198.51.100.30' });
    check('/own while a BeanPool name is held: kept beside it, the registrar\'s record untouched', r4.status === 200 && r4.body?.communityAddress === false
        && show(pa()) === show(after) && owned().includes('198.51.100.30'), show({ r4, pa: pa() }));

    console.log('\n5. Removed in Settings → Network');
    // A node with no BeanPool name again, as a new install is: no stored address and no record of names.
    se.updateNodeConfig({ publicAddress: null, registrarNames: [] } as any);
    registrar.status = { status: 'none' };
    await post('/api/local/admin/public-address/own', { domain: DOMAIN });
    check('precondition: the domain is the community\'s address again', pa()?.mode === 'own' && pa()?.hostname === DOMAIN, show(pa()));
    const rm = await post('/api/local/admin/app-addresses/remove', { address: DOMAIN });
    check('removed: 200, off the list, and no longer the community\'s address', rm.status === 200 && !owned().includes(DOMAIN) && pa() === null, show({ status: rm.status, pa: pa() }));
    check('…members\' apps signing for it are refused now; the IPs stay', own.audienceStanding(DOMAIN) === 'foreign' && own.audienceStanding(IP) === 'own');
    const rmIp = await post('/api/local/admin/app-addresses/remove', { address: ip2 });
    check('an own address that is not the community\'s address: off the list, publicAddress untouched', rmIp.status === 200 && !owned().includes(ip2) && pa() === null);
    // With no community address left, a home-network name listed on the server comes first among the published ones.
    process.env.BEANPOOL_ADDRESSES = 'beanpool.local';
    own.forgetOwnAddresses();
    check('a .local name published ahead of the IPs: the public IP is primary, not the name', own.publishedAddresses()[0] === 'beanpool.local'
        && own.primaryAddress() === IP, show({ primary: own.primaryAddress(), published: own.publishedAddresses() }));
    delete process.env.BEANPOOL_ADDRESSES;
    own.forgetOwnAddresses();

    console.log('\n6. The command\'s file');
    const dir = dataDir();
    const fileGone = () => !fs.existsSync(path.join(dir, ADDRESS_REQUEST_FILE));
    writeAddressRequestFile(dir, { kind: 'ip', host: '198.51.100.40', at: Date.now() });
    await agent.checkAddressRequest();
    check('an ip request: taken and stored as the community\'s address', fileGone() && pa()?.mode === 'ip' && pa()?.hostname === '198.51.100.40'
        && own.audienceStanding('198.51.100.40') === 'own', show(pa()));
    writeAddressRequestFile(dir, { kind: 'domain', host: 'coop.example.net', at: Date.now() });
    await agent.checkAddressRequest();
    check('a domain request: taken, stored, and it beats the IP', fileGone() && pa()?.mode === 'own' && pa()?.hostname === 'coop.example.net'
        && own.primaryAddress() === 'coop.example.net', show(pa()));
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    const beforeBad = show(se.getNodeConfig());
    try {
        writeAddressRequestFile(dir, { kind: 'ip', host: '10.0.0.5', at: Date.now() });
        await agent.checkAddressRequest();
    } finally { console.warn = realWarn; }
    check('a home-network IP: taken, not stored, and the log says why', fileGone() && show(se.getNodeConfig()) === beforeBad
        && warns.some((w) => w.includes('10.0.0.5') && /home network/.test(w)), show(warns));
    check('the registrar was asked nothing about any own address', registrar.calls.every((c) => c.startsWith('GET /api/registrar/status')), show(registrar.calls));

    console.log('\n7. Handing the address over again is a retry: the back-off is set aside, the once-a-day CA limit is not');
    const H = '198.51.100.60';
    const orders = () => ordered.filter((h) => h === H).length;
    const acmeState = () => readAcmeState(dir, H);
    const anywayFor = () => show(askedAnyway.filter(([h]) => h === H).map(([, a]) => a));
    await settledTick();   // the ticks section 6's addresses started
    const t0 = Date.now();
    selfCheck = 'port 80 is shut';
    const g1 = await post('/api/local/admin/public-address/own', { ip: H });
    const s1 = await settledTick();
    check('precondition: given with port 80 shut, one order; the CA asked anyway, once', g1.status === 200 && orders() === 1
        && anywayFor() === show([true]), show({ g1, orders: orders(), askedAnyway }));
    check('…it failed: one failure, the next try in an hour, and a tick with nothing handed over waits for it', acmeState().failures === 1
        && acmeState().nextAttemptAt >= t0 + 59 * 60_000 && s1.outcomes[H] === 'waiting', show({ st: acmeState(), s1 }));
    await post('/api/local/admin/public-address/own', { ip: H });
    await settledTick();
    check('given again within the minute (the command run twice): no second order', orders() === 1, show(ordered));
    // The owner opens port 80 and runs the command again, two minutes on: still inside the hour the failure set.
    selfCheck = null;
    schedule._setScheduleHooksForTests({ now: () => Date.now() + 2 * 60_000 });
    await post('/api/local/admin/public-address/own', { ip: H });
    const s2 = await settledTick();
    check('given again two minutes on: ordered at once, not after the hour', orders() === 2, show(ordered));
    check('…the count starts again (one failure, not two), and with nothing handed over the next tick waits', acmeState().failures === 1
        && acmeState().nextAttemptAt >= t0 + 61 * 60_000 && s2.outcomes[H] === 'waiting', show({ st: acmeState(), s2 }));
    // Port 80 shut again, another two minutes on: ordered, but the CA was asked unconfirmed four minutes ago.
    selfCheck = 'port 80 is shut';
    schedule._setScheduleHooksForTests({ now: () => Date.now() + 4 * 60_000 });
    await post('/api/local/admin/public-address/own', { ip: H });
    await settledTick();
    check('given again with the self-check failing: ordered, and the CA is not asked anyway twice in a day', orders() === 3
        && anywayFor() === show([true, false]), show({ orders: orders(), askedAnyway }));

    console.log('\n8. A name the server is given (CF_RECORD_NAME) is never replaced by an own address');
    // A server set up as the README says, with no BeanPool name and nothing given yet.
    const OWN = '/api/local/admin/public-address/own';
    const NAME = 'bean.mycommunity.org';
    se.updateNodeConfig({ publicAddress: null, registrarNames: [], ownerAddresses: [] } as any);
    process.env.CF_RECORD_NAME = NAME;
    own.forgetOwnAddresses();
    check('precondition: the name is this community\'s, primary and the directory\'s publicUrl', own.audienceStanding(NAME) === 'own'
        && own.primaryAddress() === NAME && se.getDirectoryInfo().publicUrl === `https://${NAME}`);
    const IP8 = '203.0.113.9';
    const r8 = await post(OWN, { ip: IP8 });
    check('/own { ip }: 200, kept beside the name, not the community\'s address', r8.status === 200 && r8.body?.communityAddress === false
        && pa() === null && owned().includes(IP8), show({ r8, pa: pa() }));
    check('the name is still this community\'s: members\' apps signing for it are accepted (no 421)', own.audienceStanding(NAME) === 'own');
    check('…still published, primary, the directory\'s publicUrl and a certificate identifier', own.publishedAddresses().includes(NAME)
        && own.primaryAddress() === NAME && r8.body?.primaryAddress === NAME && se.getDirectoryInfo().publicUrl === `https://${NAME}`
        && own.tlsIdentifiers().includes(NAME), show({ published: own.publishedAddresses(), primary: own.primaryAddress(), url: se.getDirectoryInfo().publicUrl }));
    check('the IP is this community\'s too, published, and a certificate identifier', own.audienceStanding(IP8) === 'own'
        && own.publishedAddresses().includes(IP8) && own.tlsIdentifiers().includes(IP8), show(own.tlsIdentifiers()));
    const D8 = 'coop8.example.net';
    const r8d = await post(OWN, { domain: D8 });
    check('/own { domain } beside it: kept beside, the name still primary and the directory\'s publicUrl', r8d.status === 200
        && r8d.body?.communityAddress === false && pa() === null && own.audienceStanding(D8) === 'own' && own.primaryAddress() === NAME
        && se.getDirectoryInfo().publicUrl === `https://${NAME}`, show({ r8d, pa: pa() }));
    writeAddressRequestFile(dir, { kind: 'ip', host: '203.0.113.10', at: Date.now() });
    await agent.checkAddressRequest();
    check('beanpool claim --ip on such a server: kept beside, the name still this community\'s and primary', fileGone() && pa() === null
        && own.audienceStanding('203.0.113.10') === 'own' && own.audienceStanding(NAME) === 'own' && own.primaryAddress() === NAME, show(pa()));
    // A bare fleet label, as the fleet's nodes set it: `<label>.beanpool.org`.
    process.env.CF_RECORD_NAME = 'valleyfolk';
    own.forgetOwnAddresses();
    const r8l = await post(OWN, { ip: '203.0.113.11' });
    check('a bare label: kept beside it, valleyfolk.beanpool.org still this community\'s and primary', r8l.status === 200
        && r8l.body?.communityAddress === false && own.audienceStanding('valleyfolk.beanpool.org') === 'own'
        && own.primaryAddress() === 'valleyfolk.beanpool.org', show({ r8l, primary: own.primaryAddress() }));
    // The name set on the server after an own address became the community's.
    delete process.env.CF_RECORD_NAME;
    se.updateNodeConfig({ publicAddress: null, ownerAddresses: [] } as any);
    own.forgetOwnAddresses();
    await post(OWN, { ip: IP8 });
    check('precondition: with no name, the IP is the community\'s address', pa()?.mode === 'ip' && pa()?.hostname === IP8, show(pa()));
    process.env.CF_RECORD_NAME = NAME;
    own.forgetOwnAddresses();
    check('a name set on the server later is this community\'s, published, primary and a certificate identifier; the IP stays',
        own.audienceStanding(NAME) === 'own' && own.publishedAddresses().includes(NAME) && own.primaryAddress() === NAME
        && own.tlsIdentifiers().includes(NAME) && own.audienceStanding(IP8) === 'own',
        show({ published: own.publishedAddresses(), primary: own.primaryAddress() }));
    delete process.env.CF_RECORD_NAME;
    own.forgetOwnAddresses();

    console.log('\n9. Moving the live own address to another of its kind asks for the owner\'s fresh proof');
    // The node's 2FA is on, and the owner's session alone is not the proof: a change that asks for it wants a current code.
    const secret = generateTotpSecret();
    updateLocalConfig({ totpEnabled: true, totpSecret: secret } as any);
    forgetUsedTotpCodesForTests();
    fresh = false;
    se.updateNodeConfig({ publicAddress: null, registrarNames: [], ownerAddresses: [] } as any);
    own.forgetOwnAddresses();
    const COOP = 'coop.example.net';
    const OTHER = 'elsewhere.example.net';
    const first = await post(OWN, { domain: COOP });
    check('the first domain with no code: 200, the community\'s address, plain', first.status === 200 && first.body?.communityAddress === true, show(first));
    check('precondition: a domain is the community\'s address, primary and the directory\'s publicUrl', pa()?.mode === 'own' && pa()?.hostname === COOP
        && own.primaryAddress() === COOP && se.getDirectoryInfo().publicUrl === `https://${COOP}`, show(pa()));
    const before9 = show(se.getNodeConfig());
    const noCode = await post(OWN, { domain: OTHER });
    check('another domain with no code: 401, asking for one', noCode.status === 401 && noCode.body?.totpRequired === true, show(noCode));
    check('…nothing changed: the community\'s address, the list, where newcomers and the directory are sent', show(se.getNodeConfig()) === before9
        && own.primaryAddress() === COOP && se.getDirectoryInfo().publicUrl === `https://${COOP}` && own.audienceStanding(OTHER) === 'foreign',
        show({ pa: pa(), primary: own.primaryAddress() }));
    const withCode = await post(OWN, { domain: OTHER, code: generateTotpCode(secret) });
    check('with a current code: 200, the community\'s address, primary and the directory\'s publicUrl', withCode.status === 200
        && withCode.body?.communityAddress === true && pa()?.hostname === OTHER && own.primaryAddress() === OTHER
        && se.getDirectoryInfo().publicUrl === `https://${OTHER}`, show({ withCode, pa: pa() }));
    check('…and the domain it replaced stays this community\'s: members\' apps holding it keep working', own.audienceStanding(COOP) === 'own');
    const sameAgain = await post(OWN, { domain: OTHER });
    check('the same domain again with no code: 200, plain', sameAgain.status === 200 && pa()?.hostname === OTHER, show(sameAgain));
    const IP9 = '198.51.100.70';
    const beside = await post(OWN, { ip: IP9 });
    check('an IP beside the domain with no code: 200, kept beside, plain', beside.status === 200 && beside.body?.communityAddress === false
        && pa()?.hostname === OTHER && own.audienceStanding(IP9) === 'own', show(beside));
    // An IP as the community's address: the domain removed in Settings, then an IP given with none.
    await post('/api/local/admin/app-addresses/remove', { address: OTHER });
    const firstIp = await post(OWN, { ip: IP9 });
    check('with none, the first IP with no code: 200, the community\'s address, plain', firstIp.status === 200 && firstIp.body?.communityAddress === true
        && pa()?.mode === 'ip' && pa()?.hostname === IP9, show({ firstIp, pa: pa() }));
    const IP9B = '198.51.100.71';
    const before9b = show(se.getNodeConfig());
    const ipNoCode = await post(OWN, { ip: IP9B });
    check('another IP with no code: 401, nothing changed', ipNoCode.status === 401 && ipNoCode.body?.totpRequired === true
        && show(se.getNodeConfig()) === before9b && own.audienceStanding(IP9B) === 'foreign' && se.getDirectoryInfo().publicUrl === `https://${IP9}`, show(ipNoCode));
    forgetUsedTotpCodesForTests();
    const ipCode = await post(OWN, { ip: IP9B, code: generateTotpCode(secret) });
    check('with a current code: 200, the community\'s address and the directory\'s publicUrl; the IP it replaced stays this community\'s',
        ipCode.status === 200 && pa()?.hostname === IP9B && se.getDirectoryInfo().publicUrl === `https://${IP9B}` && own.audienceStanding(IP9) === 'own',
        show({ ipCode, pa: pa() }));
    // A full list: the address is refused for that before any code is asked for, so none is spent on it.
    const fullList = Array.from({ length: own.MAX_OWNER_ADDRESSES - 2 }, (_, i) => `198.51.100.${100 + i}`);
    se.updateNodeConfig({ ownerAddresses: [...owned(), ...fullList] } as any);
    own.forgetOwnAddresses();
    const full = await post(OWN, { ip: '198.51.100.99' });
    check('another IP with the list full: 400 for that, no code asked for, nothing changed', full.status === 400
        && /already has 20 addresses/.test(full.body?.error ?? '') && full.body?.totpRequired === undefined && pa()?.hostname === IP9B, show(full));
    se.updateNodeConfig({ ownerAddresses: owned().filter((a) => !fullList.includes(a)) } as any);
    own.forgetOwnAddresses();
    const nameOverIp = await post(OWN, { domain: 'third.example.org' });
    check('a first name over an IP with no code: 200, plain, as a first claim is', nameOverIp.status === 200 && pa()?.mode === 'own'
        && pa()?.hostname === 'third.example.org', show(nameOverIp));
    fresh = true;
} catch (e) {
    failed++;
    console.log(`  ❌ the suite threw: ${(e as Error).stack}`);
} finally {
    schedule._setScheduleHooksForTests({ order: null, now: null });
    server.close();
    fakeRegistrar.close();
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
