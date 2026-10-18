/**
 * The stuck-pending bug, the node's side (F4 of scratch/global-node/DESIGN-registrar-trust-fable.md §5.2; temp,
 * aitest1017, 17 Oct). The node gave every registrar call 5 s; a claim makes the name at Cloudflare in about seven calls,
 * so on a slow day it timed out, the registrar left the row pending, and the node then read "pending" as "awaiting
 * approval": it stored it, ended the install's request and never asked again, while nobody was going to approve it.
 *
 *  1. A claim or heal waits 25 s (one that takes 8 s succeeds), and so does a release (Cloudflare work too: review of
 *     #2125); status and holder still give up at 5 s.
 *  2. A status answer pending + reason 'provisioning' is "not yet": the same tick asks again with a heal of the name
 *     (never a claim), stores the live answer and runs its tunnel, and only then ends `beanpool claim`'s request — with
 *     or without one, however the name was claimed. A heal that fails leaves it pending; the next tick asks again.
 *     'awaiting-approval' (and an older registrar's pending with no reason) is waited on as before.
 *  3. A heal answering live with no token (the claim made the tunnel meanwhile): the token is read from /status.
 *  4. A claim that got no answer in time, /holder saying this key holds it pending, nothing else held here: asked for
 *     again at once (a heal), stored, its tunnel run — once more after the registrar's own work if the first ask finds
 *     it still busy (503). Another address held here, or the name already live: said, as before.
 *  5. The quiet tick: live with its token and nothing pending asks every 15 min, not every 5; anything else every tick.
 *  6. Settings says "Setting up" for 'provisioning', "Awaiting approval" only for a claim that awaits it.
 *  7. Probation (registrar slice S3): a live answer with `probation: true` is stored and the directory push waits; the
 *     first live answer without it lists the community at once (one push to a local registry fixture), not at the next
 *     timed push 12 hours on.
 *
 * On origin/main 583a6cb0 sections 1–5 fail (the claim throws at 5 s; a provisioning answer is stored and the agent stops;
 * /holder's pending is only said; tickDue does not exist) and 6 shows "Awaiting approval".
 *
 * One server in this process; its registrar a mock (REGISTRAR_URL), its cloudflared the fake: nothing here reaches the
 * live registrar, Cloudflare or Docker.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-registrar-provisioning.ts
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { initStateEngine, getNodeConfig, updateNodeConfig } from './state-engine.js';
import { startP2P } from './p2p.js';
import { claimAddress, healAddress, addressStatus, askNameHolder, releaseAddress, MAKE_BUDGET_MS, CALL_BUDGET_MS } from './services/registrar-client.js';
import { noteUnansweredClaim, setTunnelConnectorForTests, resetTunnelConnectorForTests, tunnelConnectorForTests, syncTunnel } from './services/tunnel-connector.js';
import { reconcile, tick, tickDue, QUIET_TICK_MS, TICK_MS } from './services/public-address-agent.js';
import { getLocalConfig, updateLocalConfig } from './config/local-config.js';
import { useFakeCloudflared } from './tunnel-test-fake.js';

const DATA = process.env.BEANPOOL_DATA_DIR;
if (!DATA) { console.error('Set BEANPOOL_DATA_DIR to a throwaway directory'); process.exit(1); }
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.PUBLIC_ADDRESS_NAME;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
async function section(name: string, body: () => Promise<void>): Promise<void> {
    console.log(`\n— ${name} —`);
    try { await body(); } catch (e: any) { assert(false, `section "${name}" ran to the end (${e?.stack || e})`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (!cond()) { if (Date.now() > end) return false; await sleep(20); }
    return true;
}

// ── The mock registrar ───────────────────────────────────────────────────────────────────────

interface Call { path: string; body: any; name: string | null }
type Answer = any | [number, any] | Promise<any>;
const reg = {
    calls: [] as Call[],
    status: (_name: string | null): Answer => ({ status: 'none' }),
    claim: (b: any): Answer => live(b.name, `T-claim-${b.name}`),
    heal: (b: any): Answer => live(b.name, `T-heal-${b.name}`),
    holder: (b: any): Answer => ({ name: b?.name, held: 'free' }),
    release: (b: any): Answer => ({ status: 'released', name: b?.name }),
};
const callsTo = (p: string) => reg.calls.filter((c) => c.path === `/api/registrar/${p}`);

async function startRegistrar(): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        let text = '';
        req.on('data', (c) => { text += c; });
        req.on('end', () => {
            const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (!req.headers['x-bp-pubkey'] || !req.headers['x-bp-signature']) return send(401, { error: 'unsigned' });
            const u = new URL(req.url || '/', 'http://registrar');
            const body = text ? JSON.parse(text) : null;
            reg.calls.push({ path: u.pathname, body, name: u.searchParams.get('name') });
            const answer = (out: Answer): void => void Promise.resolve(out).then((o) => (Array.isArray(o) ? send(o[0], o[1]) : send(200, o)));
            const p = u.pathname.replace('/api/registrar/', '');
            if (p === 'status') return answer(reg.status(u.searchParams.get('name')));
            if (p === 'claim') return answer(reg.claim(body));
            if (p === 'heal') return answer(reg.heal(body));
            if (p === 'holder') return answer(reg.holder(body));
            if (p === 'offline' || p === 'release') return answer(reg.release(body));
            send(404, { error: 'not found' });
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    process.env.REGISTRAR_URL = `http://127.0.0.1:${(server.address() as any).port}`;
    return server;
}

const live = (name: string, token?: string) => ({ status: 'live', name, hostname: `${name}.beanpool.org`, mode: 'tunnel', ...(token ? { tunnelToken: token } : {}) });
const provisioning = (name: string) => ({ status: 'pending', reason: 'provisioning', name, hostname: `${name}.beanpool.org`, mode: 'tunnel', since: 1 });
const later = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));
const pa = () => (getNodeConfig() as any).publicAddress;
const request = (name: string) => updateLocalConfig({ addressRequest: { name, mode: 'tunnel', contact: null, requestedAt: Date.now(), refused: null } });
const reset = async () => {
    updateNodeConfig({ publicAddress: null } as any);
    updateLocalConfig({ addressRequest: null });
    await syncTunnel();
    reg.status = () => ({ status: 'none' });
    reg.claim = (b) => live(b.name, `T-claim-${b.name}`);
    reg.heal = (b) => live(b.name, `T-heal-${b.name}`);
    reg.holder = (b) => ({ name: b?.name, held: 'free' });
    reg.release = (b) => ({ status: 'released', name: b?.name });
};

async function main(): Promise<void> {
    initStateEngine();
    const p2p = await startP2P(0, 0);
    const registrar = await startRegistrar();
    // The retry after a busy ask-again waits 300 ms here, not the registrar's 35 s.
    await useFakeCloudflared(path.join(DATA!, 'fake-cloudflared'), { pollStartingMs: 40, pollConnectedMs: 80, reclaimRetryMs: 300 });
    const runsOn = (token: string) => until(() => tunnelConnectorForTests().runningToken === token);

    try {
        await section('1. a claim, heal or release waits 25 s; the rest still 5 s', async () => {
            assert(MAKE_BUDGET_MS === 25_000 && CALL_BUDGET_MS === 5_000, `budgets 25 s and 5 s (${MAKE_BUDGET_MS}, ${CALL_BUDGET_MS})`);
            reg.claim = (b) => later(8_000, live(b.name, 'T-slow'));
            const t0 = Date.now();
            let claimed: any;
            try { claimed = await claimAddress('slowpoke', 'tunnel', 'http://127.0.0.1:8080'); } catch (e: any) { claimed = { error: e.message }; }
            assert(claimed?.status === 'live' && claimed.tunnelToken === 'T-slow' && Date.now() - t0 >= 7_900,
                `a claim answered after 8 s succeeds (${JSON.stringify(claimed)}, ${Date.now() - t0} ms)`);
            reg.heal = (b) => later(6_000, live(b.name));
            let healed: any;
            try { healed = await healAddress('slowpoke', 'http://127.0.0.1:8080'); } catch (e: any) { healed = { error: e.message }; }
            assert(healed?.status === 'live', `a heal answered after 6 s succeeds (${JSON.stringify(healed)})`);
            reg.release = (b) => later(6_000, { status: 'released', name: b?.name });
            let released: any;
            try { released = await releaseAddress('slowpoke'); } catch (e: any) { released = { error: e.message }; }
            assert(released?.status === 'released' && released.name === 'slowpoke', `a release answered after 6 s succeeds (${JSON.stringify(released)})`);
            reg.status = () => later(6_000, live('slowpoke'));
            let st: any;
            const s0 = Date.now();
            try { st = await addressStatus('slowpoke'); } catch (e: any) { st = { error: e.message }; }
            assert(/timed out after 5s/.test(st?.error || '') && Date.now() - s0 < 5_900, `a status answered after 6 s still times out at 5 s (${st?.error}, ${Date.now() - s0} ms)`);
            reg.holder = () => later(6_000, { held: 'free' });
            let h: any;
            try { h = await askNameHolder('slowpoke'); } catch (e: any) { h = { error: e.message }; }
            assert(/timed out after 5s/.test(h?.error || ''), `so does /holder (${h?.error})`);
            await sleep(1_200);   // the late answers land on nobody
            await reset();
        });

        await section('2. pending + provisioning: the same tick asks again with a heal; the request stands until live', async () => {
            request('temp');
            reg.status = (name) => provisioning(name || 'temp');
            reg.heal = (b) => live(b.name, 'T-temp');
            const h0 = callsTo('heal').length, c0 = callsTo('claim').length;
            await reconcile();
            const heals = callsTo('heal').slice(h0);
            assert(heals.length === 1 && heals[0].body?.name === 'temp', `one heal of temp (${JSON.stringify(heals.map((c) => c.body))})`);
            assert(heals[0]?.body?.origin === `http://127.0.0.1:${Number(process.env.PORT_HTTP ?? 8080)}`, `carrying this server's loopback (${heals[0]?.body?.origin})`);
            assert(callsTo('claim').length === c0, 'never a claim');
            assert(pa()?.name === 'temp' && pa()?.status === 'live' && pa()?.tunnelToken === 'T-temp', `the live answer is stored (${JSON.stringify(pa())})`);
            assert(!('reason' in (pa() || {})), `with no "provisioning" left on it (${pa()?.reason})`);
            assert(await runsOn('T-temp'), 'its tunnel runs');
            assert(getLocalConfig().addressRequest == null, 'and the request from beanpool claim is done, now that the name is live');
            await reset();

            // The heal fails (the registrar is still busy with it): stored as pending, the request stands, the next tick asks again.
            request('temp');
            reg.status = (name) => provisioning(name || 'temp');
            reg.heal = () => [503, { error: 'cleaning up this name\'s earlier routing at Cloudflare; try again shortly' }];
            await reconcile();
            assert(pa()?.status === 'pending' && pa()?.reason === 'provisioning', `pending, still being made (${pa()?.status}/${pa()?.reason})`);
            assert(getLocalConfig().addressRequest?.name === 'temp', 'the request stands: nothing has been given yet');
            reg.heal = (b) => live(b.name, 'T-temp2');
            const h1 = callsTo('heal').length;
            await reconcile();
            assert(callsTo('heal').length === h1 + 1 && pa()?.status === 'live' && pa()?.tunnelToken === 'T-temp2', `the next tick asks again, and it is live (${pa()?.status})`);
            assert(getLocalConfig().addressRequest == null, 'then the request is done');
            await reset();

            // Claimed in Settings (no env, no request): stored pending provisioning, the refresh heals it all the same.
            updateNodeConfig({ publicAddress: { ...provisioning('owner-pick'), origin: 'http://127.0.0.1:8080' } } as any);
            reg.status = (name) => provisioning(name || 'owner-pick');
            reg.heal = (b) => live(b.name, 'T-owner-pick');
            await reconcile();
            assert(pa()?.name === 'owner-pick' && pa()?.status === 'live' && pa()?.tunnelToken === 'T-owner-pick', `a Settings claim's provisioning name is healed by the refresh (${pa()?.status})`);
            await reset();

            // A gated claim awaits approval: no heal, no claim, the request is done (as before). So is an older
            // registrar's pending with no reason.
            for (const reason of ['awaiting-approval', undefined]) {
                request('sydney');
                reg.status = () => ({ status: 'pending', name: 'sydney', hostname: 'sydney.beanpool.org', mode: 'tunnel', ...(reason ? { reason } : {}) });
                const h2 = callsTo('heal').length, c2 = callsTo('claim').length;
                await reconcile();
                assert(callsTo('heal').length === h2 && callsTo('claim').length === c2, `${reason ?? 'no reason'}: nothing asked again`);
                assert(pa()?.status === 'pending' && getLocalConfig().addressRequest == null, `${reason ?? 'no reason'}: stored pending, the request done`);
                await reset();
            }
        });

        await section('3. a heal answering live with no token: the token comes from /status', async () => {
            let made = false;
            reg.status = (name) => (made ? live(name || 'raced', 'T-raced') : provisioning(name || 'raced'));
            reg.heal = (b) => { made = true; return live(b.name); };   // the claim made the tunnel meanwhile: the heal made nothing
            updateNodeConfig({ publicAddress: { ...provisioning('raced'), origin: 'http://127.0.0.1:8080' } } as any);
            await reconcile();
            assert(pa()?.status === 'live' && pa()?.tunnelToken === 'T-raced', `stored live with the token /status has (${pa()?.status} ${pa()?.tunnelToken})`);
            assert(await runsOn('T-raced'), 'and its tunnel runs');
            await reset();
        });

        await section('4. an unanswered claim the registrar holds pending for this key: asked for again at once', async () => {
            const timedOut = new Error('Registrar request timed out after 25s');
            reg.holder = (b) => ({ name: b?.name, held: 'you', state: 'pending', since: 1 });
            reg.heal = (b) => live(b.name, 'T-lost');
            const h0 = callsTo('heal').length;
            await noteUnansweredClaim('lost-answer', timedOut);
            assert(callsTo('heal').length === h0 + 1 && callsTo('heal').at(-1)?.body?.name === 'lost-answer', 'a heal of the name, at once');
            assert(pa()?.name === 'lost-answer' && pa()?.status === 'live' && pa()?.tunnelToken === 'T-lost', `stored live (${JSON.stringify(pa())})`);
            assert(await runsOn('T-lost'), 'its tunnel runs');
            await reset();

            // Gated: the heal answers it awaits approval, stored so (Settings shows it, the refresh picks the approval up).
            reg.holder = (b) => ({ name: b?.name, held: 'you', state: 'pending', since: 1 });
            reg.heal = (b) => ({ status: 'pending', reason: 'awaiting-approval', name: b.name, hostname: `${b.name}.beanpool.org`, mode: 'tunnel', changed: [] });
            await noteUnansweredClaim('perth', timedOut);
            assert(pa()?.name === 'perth' && pa()?.status === 'pending' && pa()?.reason === 'awaiting-approval', `a gated one is stored awaiting approval (${pa()?.status}/${pa()?.reason})`);
            await reset();

            // The first ask finds the claim still being made (503): asked once more after the registrar's own work.
            let n = 0;
            reg.holder = (b) => ({ name: b?.name, held: 'you', state: 'pending', since: 1 });
            reg.heal = (b) => (++n === 1 ? [503, { error: 'cleaning up' }] : live(b.name, 'T-second'));
            await noteUnansweredClaim('busy-one', timedOut);
            assert(n === 2 && pa()?.name === 'busy-one' && pa()?.tunnelToken === 'T-second', `two asks, the second stored (${n}, ${pa()?.name})`);
            await reset();

            // Another live address held here: not re-claimed, only said (the owner's choice stands until they claim).
            updateNodeConfig({ publicAddress: live('kept-here', 'T-kept') } as any);
            reg.holder = (b) => ({ name: b?.name, held: 'you', state: 'pending', since: 1 });
            const h1 = callsTo('heal').length, k1 = callsTo('holder').length;
            await noteUnansweredClaim('other-pick', timedOut);
            assert(callsTo('holder').length === k1 + 1, 'who holds it was asked');
            assert(callsTo('heal').length === h1 && pa()?.name === 'kept-here', `another held address: nothing asked again, nothing changed (${pa()?.name})`);
            await reset();

            // Held live already: said, as before (Settings' status read stores it).
            reg.holder = (b) => ({ name: b?.name, held: 'you', state: 'live', since: 1 });
            const h2 = callsTo('heal').length;
            await noteUnansweredClaim('done-already', timedOut);
            assert(callsTo('heal').length === h2 && pa() == null, 'held live: nothing asked again here');
            // And no timeout, no ask at all.
            reg.holder = (b) => ({ name: b?.name, held: 'you', state: 'pending', since: 1 });
            const k0 = callsTo('holder').length;
            await noteUnansweredClaim('refused', Object.assign(new Error('name taken'), { status: 409 }));
            assert(callsTo('holder').length === k0 && pa() == null, 'a claim refused outright: nothing asked');
            await reset();
        });

        await section('5. the quiet tick: live and nothing pending asks every 15 min, anything else every 5', async () => {
            assert(TICK_MS === 5 * 60_000 && QUIET_TICK_MS === 15 * 60_000, `ticks 5 and 15 min (${TICK_MS}, ${QUIET_TICK_MS})`);
            updateNodeConfig({ publicAddress: { ...live('quiet', 'T-quiet'), origin: 'http://127.0.0.1:8080' } } as any);
            reg.status = (name) => live(name || 'quiet', 'T-quiet');
            const asks = () => callsTo('status').length;
            const t0 = Date.now();
            const s0 = asks();
            await tick(t0);
            await tick(t0 + TICK_MS);
            await tick(t0 + 2 * TICK_MS);
            assert(asks() === s0 + 1, `live with its token: one ask in the first 10 minutes (${asks() - s0})`);
            await tick(t0 + 3 * TICK_MS);
            assert(asks() === s0 + 2, `and the next at 15 (${asks() - s0})`);
            assert(!tickDue(t0 + 4 * TICK_MS) && tickDue(t0 + 6 * TICK_MS), 'then again 15 min later');
            // Anything not quiet asks every tick.
            updateLocalConfig({ addressRequest: { name: 'quiet', mode: 'tunnel', contact: null, requestedAt: Date.now(), refused: null } });
            assert(tickDue(t0 + 3 * TICK_MS + 1), 'a request standing: due');
            updateLocalConfig({ addressRequest: null });
            updateNodeConfig({ publicAddress: { ...live('quiet'), origin: 'http://127.0.0.1:8080' } } as any);
            assert(tickDue(t0 + 3 * TICK_MS + 1), 'live with no token yet: due');
            updateNodeConfig({ publicAddress: provisioning('quiet') } as any);
            assert(tickDue(t0 + 3 * TICK_MS + 1), 'pending: due');
            updateNodeConfig({ publicAddress: { ...live('quiet'), status: 'paused', reason: 'impostor' } } as any);
            assert(tickDue(t0 + 3 * TICK_MS + 1), 'paused: due');
            updateNodeConfig({ publicAddress: { ...live('direct-one'), mode: 'direct' } } as any);
            assert(!tickDue(t0 + 3 * TICK_MS + 1), 'a live direct name (no token to wait for) is quiet');
            await reset();
        });

        await section('6. Settings: "Setting up" for provisioning, "Awaiting approval" only for a claim that awaits it', async () => {
            const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'static', 'settings.js'), 'utf-8');
            const start = src.indexOf('function renderPublicAddress(d)');
            let depth = 0, end = src.indexOf('{', start);
            for (let i = end; i < src.length; i++) {
                if (src[i] === '{') depth++;
                else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
            }
            const els: Record<string, any> = {};
            for (const id of ['pubaddr-display', 'pubaddr-token-row', 'pubaddr-claim-form', 'pubaddr-offline-btn', 'pubaddr-token']) els[id] = { innerHTML: '', value: '', style: {} };
            const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
            const ctx = vm.createContext({ document: { getElementById: (id: string) => els[id] || null }, esc });
            vm.runInContext(src.slice(start, end) + '\nthis.renderPublicAddress = renderPublicAddress;', ctx);
            const shown = (d: any) => { ctx.renderPublicAddress(d); return els['pubaddr-display'].innerHTML as string; };
            const making = shown({ status: 'pending', reason: 'provisioning', name: 'temp' });
            assert(/Setting up/.test(making) && /temp\.beanpool\.org/.test(making) && /still making it/.test(making) && /under a minute/.test(making),
                `provisioning: "Setting up temp.beanpool.org — still making it, under a minute" (${making})`);
            assert(!/Awaiting approval/.test(making), 'and never "Awaiting approval"');
            const gated = shown({ status: 'pending', reason: 'awaiting-approval', name: 'sydney' });
            assert(/Awaiting approval/.test(gated) && !/Setting up/.test(gated), `awaiting-approval: "Awaiting approval" (${gated})`);
            assert(/Awaiting approval/.test(shown({ status: 'pending', name: 'old' })), 'a pending answer with no reason (an older registrar): as before');
        });

        await section('7. probation: the directory push waits while the registrar says probation, and goes once it ends', async () => {
            await reset();
            // A local directory registry: nothing here reaches the real one.
            const pushes: any[] = [];
            const dir = http.createServer((req, res) => {
                let text = '';
                req.on('data', (c) => { text += c; });
                req.on('end', () => { pushes.push(JSON.parse(text)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); });
            });
            await new Promise<void>((r) => dir.listen(0, '127.0.0.1', () => r()));
            process.env.DIRECTORY_REGISTRY_URL = `http://127.0.0.1:${(dir.address() as any).port}/v1/directory-register`;
            try {
                updateLocalConfig({ communityName: 'Probation Town' });
                const { initDirectoryPublisher, directoryHeldBack } = await import('./services/directory-publisher.js');
                const onProbation = { ...live('newtown', 'T-new'), probation: true };
                updateNodeConfig({ publicAddress: onProbation } as any);
                reg.status = () => onProbation;
                assert(initDirectoryPublisher() === true, 'the publisher runs');
                await reconcile();
                assert(pa()?.probation === true && directoryHeldBack() === 'probation', `stored with probation: the directory waits (${JSON.stringify(pa())})`);
                assert(pushes.length === 0, 'nothing pushed while on probation');
                // The registrar verifies the name: its next answer says nothing of probation.
                reg.status = () => live('newtown', 'T-new');
                await reconcile();
                assert(pa()?.status === 'live' && pa()?.probation === undefined && directoryHeldBack() === null, 'stored without probation: nothing holds it back');
                assert(await until(() => pushes.length === 1), `listed at once (${pushes.length} pushes)`);
                assert(pushes[0]?.callsign === 'Probation Town', 'the community, by its name');
                // Later answers without it push nothing more (the timer's own pushes are 12 hours apart).
                await reconcile();
                await sleep(300);
                assert(pushes.length === 1, 'pushed once');
            } finally {
                dir.close();
                delete process.env.DIRECTORY_REGISTRY_URL;
            }
        });
    } catch (e: any) {
        assert(false, `the suite ran to the end (${e?.stack || e})`);
    } finally {
        await resetTunnelConnectorForTests().catch(() => {});
        setTunnelConnectorForTests(undefined);
        registrar.close();
        await Promise.resolve(p2p.stop()).catch(() => {});
    }
    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
