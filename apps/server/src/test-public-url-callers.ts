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
import { configuredAddresses, forgetOwnAddresses, knowsItsNames } from './engine/own-addresses.js';
import { ownPublicEpochUrl, IDENTITY_EPOCH_PATH } from './services/identity-epoch.js';

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
    updateNodeConfig({ publicAddress: row.publicAddress, registrarNames: (row.lost ?? []).map(lostEntry) } as any);
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
    assert(read('state-engine.ts').includes('publicUrl: resolvePublicNodeUrl(PUBLIC_URL_RULES.community, config)'), "state-engine.ts getDirectoryInfo: the community rules");

    console.log('\nThe table (for the PR):');
    console.log(table.join('\n'));
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
