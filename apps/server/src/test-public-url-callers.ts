/**
 * One resolver for this community's public address (state-engine.ts resolvePublicNodeUrl, #1112's note): every caller's
 * output, in every configuration below, is what it was before the callers shared it.
 *
 * Before, three helpers worked it out, each its own way:
 *   A. state-engine.ts resolvePublicNodeUrl: the directory's `publicUrl` (getDirectoryInfo) and this community's own
 *      names (engine/own-addresses.ts item 1)
 *   B. services/identity-epoch.ts ownPublicEpochUrl: where the split-brain check asks for this server's statement
 *   C. routes/federation-purchase.ts and routes/federation-commission.ts ourPublicUrl (two copies): the
 *      `buyerHomeNode` a cross-community purchase or commission sends
 * Now each is resolvePublicNodeUrl with its rules (PUBLIC_URL_RULES.community, .identityEpoch, .buyerHomeNode).
 *
 *   1. the table: each configuration (a registrar name by tunnel and direct, a claim still pending, the fleet's
 *      CF_RECORD_NAME bare, with a scheme or a trailing slash, http or https, a custom domain with a port, a
 *      plain-string publicAddress, a lost name, loopback, PUBLIC_IP, a config that can't be read) gives each caller the
 *      output written in the table, and the helper as it was on origin/main (copied below, verbatim) gave the same.
 *      Where they differ it is a stored hostname no registrar writes (a scheme, trailing slashes, or nothing but a
 *      scheme), and the row names both outputs
 *   2. own-addresses item 1 is the community output's host (no port), and a loopback name there names no community
 *   3. each caller calls the resolver with its own rules, and none keeps a copy
 *   4. an own address as the node stores it (`beanpool claim --ip` / `--address`, services/public-address-agent.ts
 *      storeOwnAddress): an IP in publicAddress is this node's own address and the directory's publicUrl; a domain given
 *      later takes over as the publicUrl, and the IP stays this community's
 *   5. CF_RECORD_NAME stays a published own name whenever set (rename S1, design
 *      scratch/fable-design/DESIGN-rename-primary-name-fable.md §2): beside every stored address, in every spelling, and
 *      the outputs in 1 stay as they were. Blank adds nothing; marked lost, it is refused
 *   6. the owner's main address (several-addresses S1, design scratch/fable-design/DESIGN-several-addresses-fable.md §2.1):
 *      once chosen, every reader of "where it lives" names it (primaryAddress and /api/community/info, which invites and
 *      share links carry; the directory push; the search canonical; the community card; the assistant's origin, welcome
 *      and addressHost; the home other servers know it by), its port kept; a choice that may not be main (not published,
 *      a number beside a name, a name waiting for approval, a home-network address beside one the Internet can reach)
 *      moves none of them; a home-network address may be main only while the community has nothing the Internet reaches
 *
 * Other code that reads the address for another purpose, and is NOT this resolver's caller (left as it was):
 *   - routes/messaging.ts (a relayed message's `senderNodeUrl`): CF_RECORD_NAME, else the community's name squashed
 *     into `<name>.beanpool.org`, a guess that can name another community's address
 *   - routes/backup.ts resolvePrimaryUrl (the backup enrolment URL): CF_RECORD_NAME, else the request's own host
 *   - http-server.ts (the redirect to CF_RECORD_NAME), index.ts (its start-up line), routes/settings.ts (the node label)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-public-url-callers.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audienceOf } from '@beanpool/core';
import {
    initStateEngine, getNodeConfig, updateNodeConfig, getDirectoryInfo, lostRegistrarHosts, resolvePublicNodeUrl,
    PUBLIC_URL_RULES, type NodeConfig,
} from './state-engine.js';
import { audienceStanding, configuredAddresses, forgetOwnAddresses, knowsItsNames, primaryAddress, publishedAddresses } from './engine/own-addresses.js';
import { ownPublicEpochUrl, IDENTITY_EPOCH_PATH } from './services/identity-epoch.js';
import { storeOwnAddress } from './services/public-address-agent.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const show = (v: unknown) => JSON.stringify(v);

// ── Before: the three helpers as they were on origin/main (1a76788c), verbatim but for the config read passed in ──

function beforeCommunity(config: NodeConfig): string | null {
    const lost = lostRegistrarHosts(config);
    const usable = (host: string | null): string | null => {
        if (!host) return null;
        const clean = host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        if (!clean) return null;
        const h = audienceOf(clean);
        return h && lost.has(h) ? null : clean;
    };
    let host: string | null = null;
    const pa: any = config.publicAddress;
    if (pa) {
        if (typeof pa === 'string' && pa.trim()) {
            host = usable(pa.trim());
        } else if (typeof pa === 'object') {
            if (typeof pa.hostname === 'string' && pa.hostname.trim()) {
                host = usable(pa.hostname.trim());
            } else if (typeof pa.name === 'string' && pa.name.trim()) {
                const n = pa.name.trim();
                host = usable(n.includes('.') ? n : `${n}.beanpool.org`);
            }
        }
    }
    if (!host && process.env.CF_RECORD_NAME && process.env.CF_RECORD_NAME.trim()) {
        const cf = process.env.CF_RECORD_NAME.trim();
        host = usable(cf.includes('.') ? cf : `${cf}.beanpool.org`);
    }
    return host ? `https://${host}` : null;
}

function beforeIdentityEpoch(readConfig: () => NodeConfig): string | null {
    let host: string | null = null;
    let lost = new Set<string>();
    try {
        const config = readConfig();
        lost = lostRegistrarHosts(config);
        const pa = (config as any)?.publicAddress;
        if (pa && typeof pa.hostname === 'string' && pa.hostname.trim() && !lost.has(audienceOf(pa.hostname.trim()) ?? '')) host = pa.hostname.trim();
    } catch { /* no node_config yet */ }
    if (!host && process.env.CF_RECORD_NAME && !lost.has(audienceOf(process.env.CF_RECORD_NAME.trim()) ?? '')) host = process.env.CF_RECORD_NAME.trim();
    if (!host) return null;
    return `https://${host.replace(/^https?:\/\//, '').replace(/\/+$/, '')}${IDENTITY_EPOCH_PATH}`;
}

function beforeBuyerHomeNode(readConfig: () => NodeConfig): string | null {
    try {
        const hostname = ((readConfig() as any)?.publicAddress?.hostname ?? '').trim();
        return hostname ? `https://${hostname}` : null;
    } catch {
        return null;
    }
}

// ── The table ──────────────────────────────────────────────────────────────────────────────

const REG = 'riverbend.beanpool.org';
const FLEET = 'mullum.beanpool.org';
const EPOCH = IDENTITY_EPOCH_PATH;

interface Outputs { community: string | null; epoch: string | null; buyer: string | null }
interface Row {
    name: string;
    publicAddress: unknown;
    /** Registrar names marked lost (lostRegistrarHosts). */
    lost?: string[];
    env?: { CF_RECORD_NAME?: string; PUBLIC_IP?: string };
    want: Outputs;
    /** Only where the helper before gave something else: what it gave. */
    before?: Partial<Outputs>;
}

const tunnel = { name: 'riverbend', mode: 'tunnel', hostname: REG, status: 'live', tunnelToken: 'tok', origin: 'http://127.0.0.1:8080' };
const direct = { name: 'riverbend', mode: 'direct', hostname: REG, status: 'live' };
const pending = { name: 'riverbend', mode: 'tunnel', status: 'pending' };
/** A hostname with no registrar name beside it (a registrar name would count as one of this community's names too). */
const bare = (hostname: string) => ({ mode: 'direct', hostname, status: 'live' });
const all = (url: string | null): Outputs => ({ community: url, epoch: url && `${url}${EPOCH}`, buyer: url });

const TABLE: Row[] = [
    { name: 'nothing set', publicAddress: null, want: all(null) },
    { name: 'a registrar name, by tunnel', publicAddress: tunnel, want: all(`https://${REG}`) },
    { name: 'a registrar name, direct', publicAddress: direct, want: all(`https://${REG}`) },
    { name: 'a registrar name and the fleet name: the registrar name', publicAddress: tunnel, env: { CF_RECORD_NAME: FLEET }, want: all(`https://${REG}`) },
    { name: 'a claim still pending (a name, no hostname)', publicAddress: pending, want: { community: `https://${REG}`, epoch: null, buyer: null } },
    { name: 'a claim still pending and the fleet name', publicAddress: pending, env: { CF_RECORD_NAME: FLEET },
        want: { community: `https://${REG}`, epoch: `https://${FLEET}${EPOCH}`, buyer: null } },
    { name: 'a pending claim with an empty hostname', publicAddress: { ...pending, hostname: '' }, want: { community: `https://${REG}`, epoch: null, buyer: null } },
    { name: "the fleet's CF_RECORD_NAME only", publicAddress: null, env: { CF_RECORD_NAME: FLEET },
        want: { community: `https://${FLEET}`, epoch: `https://${FLEET}${EPOCH}`, buyer: null } },
    { name: 'CF_RECORD_NAME a bare name: in the zone for the community, as set for the epoch check', publicAddress: null, env: { CF_RECORD_NAME: 'mullum' },
        want: { community: `https://${FLEET}`, epoch: `https://mullum${EPOCH}`, buyer: null } },
    { name: 'CF_RECORD_NAME with https:// and a trailing slash', publicAddress: null, env: { CF_RECORD_NAME: `https://${FLEET}/` },
        want: { community: `https://${FLEET}`, epoch: `https://${FLEET}${EPOCH}`, buyer: null } },
    { name: 'CF_RECORD_NAME with http://: https out', publicAddress: null, env: { CF_RECORD_NAME: `http://${FLEET}` },
        want: { community: `https://${FLEET}`, epoch: `https://${FLEET}${EPOCH}`, buyer: null } },
    { name: 'CF_RECORD_NAME blank', publicAddress: null, env: { CF_RECORD_NAME: '   ' }, want: all(null) },
    { name: 'a hostname padded with spaces', publicAddress: { ...tunnel, hostname: `  ${REG}  ` }, want: all(`https://${REG}`) },
    { name: 'a custom domain', publicAddress: bare('coop.example.org'), want: all('https://coop.example.org') },
    { name: 'a custom domain with a port', publicAddress: bare('coop.example.org:8443'), want: all('https://coop.example.org:8443') },
    { name: 'a plain-string publicAddress: the community only', publicAddress: 'coop.example.org', want: { community: 'https://coop.example.org', epoch: null, buyer: null } },
    { name: 'a hostname that is not a string', publicAddress: { hostname: 42 }, want: all(null) },
    { name: 'the registrar name lost, the fleet name set: the purchase still sends the lost one', publicAddress: tunnel, lost: [REG], env: { CF_RECORD_NAME: FLEET },
        want: { community: `https://${FLEET}`, epoch: `https://${FLEET}${EPOCH}`, buyer: `https://${REG}` } },
    { name: 'the registrar name lost, nothing else', publicAddress: tunnel, lost: [REG], want: { community: null, epoch: null, buyer: `https://${REG}` } },
    { name: 'a pending claim whose name is lost', publicAddress: pending, lost: [REG], want: all(null) },
    { name: 'the fleet name lost (never in practice: a fleet name is reserved)', publicAddress: null, lost: [FLEET], env: { CF_RECORD_NAME: FLEET }, want: all(null) },
    { name: 'a loopback hostname: localhost', publicAddress: bare('localhost'), want: all('https://localhost') },
    { name: 'a loopback hostname: 127.0.0.1', publicAddress: bare('127.0.0.1'), want: all('https://127.0.0.1') },
    { name: 'CF_RECORD_NAME localhost: in the zone for the community', publicAddress: null, env: { CF_RECORD_NAME: 'localhost' },
        want: { community: 'https://localhost.beanpool.org', epoch: `https://localhost${EPOCH}`, buyer: null } },
    { name: 'PUBLIC_IP alone is no public address', publicAddress: null, env: { PUBLIC_IP: '203.0.113.7' }, want: all(null) },
    { name: 'PUBLIC_IP (IPv6) beside a registrar name changes nothing', publicAddress: tunnel, env: { PUBLIC_IP: '2001:db8::7' }, want: all(`https://${REG}`) },
    // An own address (`beanpool claim --ip` / `--address`, services/public-address-agent.ts storeOwnAddress).
    { name: 'this server\'s own IP address', publicAddress: { mode: 'ip', hostname: '203.0.113.5', status: 'live', since: '2026-10-18T00:00:00.000Z' },
        want: all('https://203.0.113.5') },
    { name: 'the owner\'s own domain', publicAddress: { mode: 'own', hostname: 'beans.example.org', status: 'live', since: '2026-10-18T00:00:00.000Z' },
        want: all('https://beans.example.org') },
    { name: 'an own IP address and the fleet name: the IP', publicAddress: { mode: 'ip', hostname: '203.0.113.5', status: 'live' }, env: { CF_RECORD_NAME: FLEET },
        want: all('https://203.0.113.5') },

    // Stored hostnames no registrar writes (it answers a bare `<name>.beanpool.org`): the purchase's copy kept them as
    // they were, and the epoch check made a URL with no host of one that was only a scheme. Now every rule takes a
    // scheme and trailing slashes off, and a host that is nothing else is none.
    { name: 'a hostname with http:// and trailing slashes', publicAddress: { ...tunnel, hostname: `http://${REG}//` }, want: all(`https://${REG}`),
        before: { buyer: `https://http://${REG}//` } },
    { name: 'a hostname with https:// and a trailing slash', publicAddress: { ...tunnel, hostname: `https://${REG}/` }, want: all(`https://${REG}`),
        before: { buyer: `https://https://${REG}/` } },
    { name: 'a hostname that is only a scheme, the fleet name set', publicAddress: { ...tunnel, hostname: 'https://' }, env: { CF_RECORD_NAME: FLEET },
        want: { community: `https://${FLEET}`, epoch: `https://${FLEET}${EPOCH}`, buyer: null },
        before: { epoch: `https:///api/node/identity-epoch`, buyer: 'https://https://' } },
];

function lostEntry(address: string) {
    const at = new Date().toISOString();
    return {
        address, role: 'current', status: 'live', reason: null, since: at, formerSince: null, heldUntil: null,
        releasedByUsAt: null, renamedByUsAt: null, lost: { since: at, why: 'another-key', holderKey: null },
    };
}

function apply(row: Row): void {
    delete process.env.CF_RECORD_NAME;
    delete process.env.PUBLIC_IP;
    for (const [k, v] of Object.entries(row.env ?? {})) process.env[k] = v;
    updateNodeConfig({ publicAddress: row.publicAddress, registrarNames: (row.lost ?? []).map(lostEntry), mainAddress: null } as any);
    forgetOwnAddresses();
}

async function main(): Promise<void> {
    delete process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL;
    delete process.env.BEANPOOL_ADDRESSES;
    initStateEngine();

    console.log('\n--- 1. the table: every caller, every configuration, before and after ---');
    const table: string[] = ['| configuration | directory publicUrl + own names (community) | identity-epoch check | buyerHomeNode |', '|---|---|---|---|'];
    for (const row of TABLE) {
        apply(row);
        const got: Outputs = {
            community: getDirectoryInfo().publicUrl,
            epoch: ownPublicEpochUrl(),
            buyer: resolvePublicNodeUrl(PUBLIC_URL_RULES.buyerHomeNode),
        };
        const was: Outputs = {
            community: beforeCommunity(getNodeConfig()),
            epoch: beforeIdentityEpoch(getNodeConfig),
            buyer: beforeBuyerHomeNode(getNodeConfig),
        };
        for (const k of ['community', 'epoch', 'buyer'] as const) {
            assert(got[k] === row.want[k], `${row.name}: ${k} is ${show(row.want[k])} (got ${show(got[k])})`);
            const wasWant = row.before && k in row.before ? row.before[k] : row.want[k];
            assert(was[k] === wasWant, `${row.name}: ${k} was ${show(wasWant)} before${wasWant === row.want[k] ? ', the same' : ''} (got ${show(was[k])})`);
        }
        // The default rules are the community's: what own-addresses and the directory ask for.
        assert(resolvePublicNodeUrl() === got.community, `${row.name}: the default rules are the community's`);
        table.push(`| ${row.name} | ${show(got.community)} | ${show(got.epoch)} | ${show(got.buyer)}${row.before ? ` (before: ${show({ ...was })})` : ''} |`);
    }

    // A node_config that can't be read: the purchase's copy answered null, the epoch check went on to CF_RECORD_NAME.
    process.env.CF_RECORD_NAME = FLEET;
    const unreadable = (): NodeConfig => { throw new Error('no node_config yet'); };
    assert(beforeBuyerHomeNode(unreadable) === null && resolvePublicNodeUrl(PUBLIC_URL_RULES.buyerHomeNode, null) === null,
        'a config that cannot be read: buyerHomeNode null, before and after');
    assert(beforeIdentityEpoch(unreadable) === `https://${FLEET}${EPOCH}`
        && resolvePublicNodeUrl(PUBLIC_URL_RULES.identityEpoch, null) === `https://${FLEET}`,
        'a config that cannot be read: the epoch check still asks at CF_RECORD_NAME, before and after');
    assert(resolvePublicNodeUrl(PUBLIC_URL_RULES.community, null) === `https://${FLEET}`, 'a config that cannot be read: the community rules go on to CF_RECORD_NAME');
    delete process.env.CF_RECORD_NAME;

    // The epoch check's test address still wins over everything.
    apply(TABLE[1]);
    process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL = 'https://127.0.0.1:9/test-epoch';
    assert(ownPublicEpochUrl() === 'https://127.0.0.1:9/test-epoch', "the suites' epoch address is used as set");
    delete process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL;

    console.log('\n--- 2. own-addresses item 1 ---');
    for (const row of TABLE) {
        apply(row);
        const item1 = configuredAddresses().find((a) => a.source === 'public-address')?.address ?? null;
        const want = row.want.community ? audienceOf(row.want.community) : null;
        assert(item1 === want, `${row.name}: item 1 is ${show(want)} (got ${show(item1)})`);
    }
    apply(TABLE.find((r) => r.name === 'a loopback hostname: localhost')!);
    assert(!knowsItsNames(), 'a loopback name as the public address names no community (the node still knows none of its names)');
    apply(TABLE.find((r) => r.name === 'a custom domain with a port')!);
    assert(knowsItsNames(), 'a custom domain names it');

    console.log('\n--- 3. each caller uses the resolver with its rules, and no copy is left ---');
    const src = path.dirname(fileURLToPath(import.meta.url));
    const read = (f: string) => fs.readFileSync(path.join(src, f), 'utf8');
    for (const f of ['routes/federation-purchase.ts', 'routes/federation-commission.ts']) {
        const s = read(f);
        assert(s.split('resolvePublicNodeUrl(PUBLIC_URL_RULES.buyerHomeNode)').length === 2, `${f}: buyerHomeNode is resolvePublicNodeUrl(PUBLIC_URL_RULES.buyerHomeNode)`);
        assert(!/ourPublicUrl|publicAddress\?\.hostname/.test(s), `${f}: no copy of the helper left`);
    }
    const epochSrc = read('services/identity-epoch.ts');
    assert(epochSrc.includes('resolvePublicNodeUrl(PUBLIC_URL_RULES.identityEpoch)') && !/pa\.hostname|lostRegistrarHosts/.test(epochSrc),
        'services/identity-epoch.ts: the resolver with PUBLIC_URL_RULES.identityEpoch, no copy left');
    assert(read('engine/own-addresses.ts').includes('resolvePublicNodeUrl(PUBLIC_URL_RULES.community, config)'), 'engine/own-addresses.ts: the community rules');
    // The directory's publicUrl follows the owner's main address (several-addresses S1, §6 below): mainPublicUrl, which is
    // this resolver's community answer unchanged while no main is chosen (the table in 1 is that case).
    assert(read('state-engine.ts').includes('publicUrl: mainPublicUrl()'), "state-engine.ts getDirectoryInfo: the main address (mainPublicUrl)");
    assert(read('engine/own-addresses.ts').includes('const url = resolvePublicNodeUrl(PUBLIC_URL_RULES.community);\n    const main = chosenMainAddress();'),
        'engine/own-addresses.ts mainPublicUrl: the community rules, then the owner\'s main');

    console.log('\n--- 4. an own address as the node stores it (beanpool claim --ip / --address) ---');
    apply({ name: 'nothing set', publicAddress: null, want: all(null) });
    updateNodeConfig({ ownerAddresses: [] } as any);
    forgetOwnAddresses();
    const ip = storeOwnAddress('203.0.113.5', 'this suite');
    const stored = (getNodeConfig() as any).publicAddress;
    assert(ip.ok && stored?.mode === 'ip' && stored?.hostname === '203.0.113.5', `the IP is stored in publicAddress as { mode: 'ip', hostname } (${show(stored)})`);
    assert(getDirectoryInfo().publicUrl === 'https://203.0.113.5', `the directory's publicUrl is https://203.0.113.5 (got ${show(getDirectoryInfo().publicUrl)})`);
    assert(ownPublicEpochUrl() === `https://203.0.113.5${EPOCH}` && resolvePublicNodeUrl(PUBLIC_URL_RULES.buyerHomeNode) === 'https://203.0.113.5',
        'the identity-epoch check and buyerHomeNode name it too');
    assert(configuredAddresses().find((a) => a.source === 'public-address')?.address === '203.0.113.5' && audienceStanding('203.0.113.5') === 'own',
        'it is this node\'s own address (item 1), and a signature for it is this community\'s');
    const domain = storeOwnAddress('beans.example.org', 'this suite');
    assert(domain.ok && getDirectoryInfo().publicUrl === 'https://beans.example.org' && audienceStanding('203.0.113.5') === 'own',
        `a domain given later is the directory's publicUrl, and the IP stays this community's (${show(getDirectoryInfo().publicUrl)})`);

    console.log('\n--- 4b. while a name waits, only an address the Internet can reach stands in for it ---');
    for (const home of ['192.168.1.20', 'beans.local']) {
        apply({ name: 'a claim still pending', publicAddress: pending, want: all(null) });
        updateNodeConfig({ ownerAddresses: [home] } as any);
        forgetOwnAddresses();
        assert(resolvePublicNodeUrl(PUBLIC_URL_RULES.community) === `https://${REG}`, `a home address ${home} is not where the directory and the card are sent (got ${show(resolvePublicNodeUrl(PUBLIC_URL_RULES.community))})`);
    }
    updateNodeConfig({ ownerAddresses: ['203.0.113.5'] } as any);
    forgetOwnAddresses();
    assert(resolvePublicNodeUrl(PUBLIC_URL_RULES.community) === 'https://203.0.113.5', `a public address kept from before the claim still stands in (got ${show(resolvePublicNodeUrl(PUBLIC_URL_RULES.community))})`);
    updateNodeConfig({ ownerAddresses: [] } as any);
    forgetOwnAddresses();

    console.log('\n--- 5. CF_RECORD_NAME stays a published own name whenever set (rename S1) ---');
    const STORED: [string, unknown][] = [
        ['a registrar name by tunnel', tunnel], ['a registrar name, direct', direct], ['a claim still pending', pending],
        ['an own IP', { mode: 'ip', hostname: '203.0.113.5', status: 'live' }], ['an own domain', { mode: 'own', hostname: 'beans.example.org', status: 'live' }],
        ['nothing', null],
    ];
    const SPELLED = [FLEET, 'mullum', `https://${FLEET}/`, `http://${FLEET}`, `  ${FLEET}  `];
    for (const [what, publicAddress] of STORED) {
        for (const cf of SPELLED) {
            apply({ name: what, publicAddress, env: { CF_RECORD_NAME: cf }, want: all(null) });
            updateNodeConfig({ ownerAddresses: [] } as any);
            forgetOwnAddresses();
            const entry = configuredAddresses().find((a) => a.address === FLEET);
            assert(entry?.source === 'public-address' && !entry.former && !entry.lost, `beside ${what}, CF_RECORD_NAME ${show(cf)} is item 1 (${show(entry)})`);
            assert(entry?.hardCoded === true, `beside ${what}, it is marked hard-coded: no claim of it is held (${show(entry)})`);
            assert(publishedAddresses().includes(FLEET), `beside ${what}, it is published (${show(publishedAddresses())})`);
            assert(audienceStanding(FLEET) === 'own', `beside ${what}, a signature for it is this community's (got ${audienceStanding(FLEET)})`);
        }
    }
    for (const [what, publicAddress] of STORED) {
        apply({ name: what, publicAddress, env: { CF_RECORD_NAME: '   ' }, want: all(null) });
        assert(!configuredAddresses().some((a) => a.address === FLEET), `CF_RECORD_NAME blank beside ${what}: nothing added`);
        apply({ name: what, publicAddress, lost: [FLEET], env: { CF_RECORD_NAME: FLEET }, want: all(null) });
        assert(!publishedAddresses().includes(FLEET) && audienceStanding(FLEET) === 'foreign', `the name marked lost beside ${what}: never published, refused (got ${audienceStanding(FLEET)})`);
    }
    apply({ name: 'both', publicAddress: tunnel, env: { CF_RECORD_NAME: FLEET }, want: all(null) });
    assert(primaryAddress() === REG, `the live registrar name is still the main one (${primaryAddress()})`);
    assert(getDirectoryInfo().publicUrl === `https://${REG}`, `and the directory's publicUrl is unchanged (${getDirectoryInfo().publicUrl})`);
    {
        const { appAddressesReport } = await import('./routes/app-addresses.js');
        const row = (host: string) => (appAddressesReport().addresses as any[]).find((r) => r.address === host);
        assert(row(FLEET)?.hardCoded === true, `the Addresses report marks the fleet name hard-coded (${show(row(FLEET))})`);
        assert(!row(REG)?.hardCoded, `and not the claimed name (${show(row(REG))})`);
        const record = (status: string) => {
            updateNodeConfig({ registrarNames: [{ ...lostEntry(FLEET), role: 'former', status, lost: null }] } as any);
            forgetOwnAddresses();
        };
        record('live');
        assert(!configuredAddresses().find((a) => a.address === FLEET)?.hardCoded, 'a fleet name this key holds at the registrar is not hard-coded: Make main is its way back');
        record('released');
        assert(configuredAddresses().find((a) => a.address === FLEET)?.hardCoded === true, 'one it has let go is');
    }
    assert(configuredAddresses().filter((a) => a.source === 'public-address').map((a) => a.address).join() === `${REG},${FLEET}`,
        `each once, the stored name first (${show(configuredAddresses())})`);

    console.log('\n--- 6. the owner\'s main address: every reader follows it ---');
    {
        const { mainPublicUrl, chosenMainAddress } = await import('./engine/own-addresses.js');
        const { webAppCanonicalUrl } = await import('./web-app-robots.js');
        const { communityCard } = await import('./routes/community-card.js');
        const { ownOrigin, nodeUrlFor } = await import('./agent/mcp-route.js');
        const { ownNodeHome } = await import('./engine/node-key.js');
        const { AGENT_TOOLS } = await import('./agent/tools.js');
        // The assistant's overview names the address host (agent/tools.ts node_overview).
        const statusTool = AGENT_TOOLS.find((t) => t.name === 'node_overview');
        assert(!!statusTool, 'the assistant\'s node_overview tool is there');
        const addressHost = async (): Promise<string | null> => {
            const out: any = await statusTool!.run({ role: 'owner' } as any, {}, 'this suite');
            return out?.result?.addressHost ?? null;
        };
        /** Every reader, as host[:port] or a URL. */
        const readers = async () => ({
            primary: primaryAddress(), directory: getDirectoryInfo().publicUrl, mainUrl: mainPublicUrl(), canonical: webAppCanonicalUrl(),
            card: communityCard().host, origin: ownOrigin(), assistant: nodeUrlFor({ req: {}, host: 'unused' }), home: ownNodeHome(),
            addressHost: await addressHost(),
        });
        const at = (host: string, home = host) => ({
            primary: host.replace(/:\d+$/, ''), directory: `https://${host}`, mainUrl: `https://${host}`, canonical: `https://${host}/app`,
            card: host, origin: `https://${host}`, assistant: `https://${host}`, home,
            addressHost: host.replace(/:\d+$/, ''),
        });
        const choose = (main: string | null, row: Row, owned: string[] = []) => {
            apply(row);
            updateNodeConfig({ ownerAddresses: owned, mainAddress: main } as any);
            forgetOwnAddresses();
        };
        const OWN = 'beans.example.org';
        const named = TABLE.find((r) => r.name === 'a registrar name, by tunnel')!;

        choose(null, named, [OWN]);
        const unchosen = await readers();
        assert(show(unchosen) === show(at(REG)), `no main chosen: every reader names the live registrar name, as before (${show(unchosen)})`);

        choose(OWN, named, [OWN]);
        assert(chosenMainAddress() === OWN, 'the own domain is the chosen main');
        const chosen = await readers();
        assert(show(chosen) === show(at(OWN)), `the own domain chosen over a live registrar name: every reader names it (${show(chosen)}; before S1 the name always won)`);
        assert(publishedAddresses().includes(REG), 'and the registrar name is still published');

        choose(REG, named, [OWN]);
        assert(show(await readers()) === show(at(REG)), `and back: the registrar name chosen, every reader names it (${show(await readers())})`);

        // A port survives: the main address is the stored domain on 8443.
        choose('coop.example.org', TABLE.find((r) => r.name === 'a custom domain with a port')!, [OWN]);
        assert(show(await readers()) === show(at('coop.example.org:8443')), `a main on a port keeps its port in every reader (${show(await readers())})`);

        // Choices that may not be main move nothing: every reader stays as with no choice.
        for (const [why, main, owned] of [
            ['an address that is not published', 'elsewhere.example.org', [OWN]],
            ['a number beside a name', '203.0.113.5', [OWN, '203.0.113.5']],
        ] as [string, string, string[]][]) {
            choose(main, named, owned);
            assert(chosenMainAddress() === null && show(await readers()) === show(at(REG)), `${why} as the main moves no reader (${show(await readers())})`);
        }
        // A registrar name still waiting for approval has no route: a choice of it moves nothing either.
        choose(REG, named, [OWN]);
        updateNodeConfig({ registrarNames: [{ ...lostEntry(REG), lost: null, status: 'pending' }] } as any);
        forgetOwnAddresses();
        assert(chosenMainAddress() === null && primaryAddress() !== REG, `a main with no route (the current registrar name not live) is not the main (${show(chosenMainAddress())}, ${show(primaryAddress())})`);

        // A number may be main while the community has no name.
        const ownIp = TABLE.find((r) => r.name === "this server's own IP address")!;
        choose('203.0.113.5', ownIp, ['203.0.113.5']);
        assert(chosenMainAddress() === '203.0.113.5' && primaryAddress() === '203.0.113.5', `a number is main while there is no name (${show(primaryAddress())})`);

        // The main answers from outside (design §2.1): an address on the home network is never main while the community has
        // one the Internet can reach (review 4580901278). Beside a live registrar name, every reader stays on the name.
        for (const home of ['nas.local', 'beans.lan', 'beans.home', 'beans.home.arpa', 'beans', '192.168.1.20', '10.0.0.5', '[fd00::1]']) {
            choose(home, named, [OWN, home]);
            assert(publishedAddresses().includes(home) && chosenMainAddress() === null && show(await readers()) === show(at(REG)),
                `a home-network address (${home}) as the main beside a live name moves no reader (${show(chosenMainAddress())}, ${show(await readers())})`);
        }
        // Beside the server's public number too: a home-network number never stands above a public one.
        choose('192.168.1.20', ownIp, ['203.0.113.5', '192.168.1.20']);
        assert(chosenMainAddress() === null && primaryAddress() === '203.0.113.5' && show(await readers()) === show(at('203.0.113.5')),
            `a home-network number as the main beside the public number moves no reader (${show(chosenMainAddress())}, ${show(await readers())})`);
        // With nothing the Internet can reach, a home-network address may be main: it is the only way in.
        choose('nas.local', TABLE.find((r) => r.name === 'nothing set')!, ['beans.lan', 'nas.local']);
        assert(chosenMainAddress() === 'nas.local' && primaryAddress() === 'nas.local', `a home-network address is main while the community has nothing the Internet can reach (${show(primaryAddress())})`);
        // Chosen then, it stops being main the moment an internet address is listed: the name wins, as before a choice.
        choose('nas.local', named, ['beans.lan', 'nas.local']);
        assert(chosenMainAddress() === null && primaryAddress() === REG, `a home-network main chosen before the community had a name gives way to the name (${show(primaryAddress())})`);
        updateNodeConfig({ ownerAddresses: [], mainAddress: null } as any);
        forgetOwnAddresses();
    }

    console.log('\nThe table (for the PR):');
    console.log(table.join('\n'));
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
