/**
 * Notices from the address service, the node's side (registrar slice S2, scratch/global-node/DESIGN-registrar-trust-fable.md
 * §3.2): the registrar's /status carries the notices its admin sent this key; the node keeps them for Settings, tells its
 * owners once per notice, and sends back `seen` (the highest id it has) so they are never carried again.
 *
 *  1. Every /status sends `seen` (signed with the query) once the node has had a notice, and the answer's `notices` are
 *     kept, newest first, out of the answer the callers store.
 *  2. Exactly one owner alert (`reg.notice`) per notice id, however many answers carry it (the registrar carries a notice
 *     until `seen` reaches it), two answers at once included; in the server's own words by level, never the notice's.
 *  3. What can't be shown safely is not kept: a reply link anywhere but the address service's own /reply/, words with a
 *     control or reordering character, too long, a name that is no name. Its id still counts as had (`seen` moves past
 *     it), so the registrar stops carrying it.
 *  4. A standby takes none and sends no `seen`: its main server's owners must hear them.
 *  5. The agent's tick (reconcile) takes them too, and the address it stores carries no `notices`.
 *  6. Settings shows them under Public address: the words as text, a Reply link only when kept, nothing when there are none.
 *  7. A burst is bounded as every server alert is: three told in the hour, the rest folded.
 *  8. Kept on this server only: classified per-server, and never in a backup file's local config or the stager's copy
 *     (each holds a live one-use reply link; #2151 review 4306271971).
 *
 * On origin/main a77b76d1 every section fails: /status sends no `seen`, nothing is kept and nothing told (no reg.notice).
 *
 * One server in this process; its registrar a mock (REGISTRAR_URL): nothing here reaches the live registrar.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-registrar-notices.ts
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { initStateEngine, getNodeConfig, updateNodeConfig } from './state-engine.js';
import { startP2P } from './p2p.js';
import { addressStatus } from './services/registrar-client.js';
import { reconcile } from './services/public-address-agent.js';
import { registrarNotices, noticeSeenMark } from './services/registrar-notices.js';
import { setSecurityAlertHandler, REGISTRAR_NOTICE_WORDS, type SecurityNote } from './services/security-signal.js';
import * as alerts from './services/alerts.js';
import { getLocalConfig, updateLocalConfig } from './config/local-config.js';
import { setNodeRole } from './config/node-role.js';

const DATA = process.env.BEANPOOL_DATA_DIR;
if (!DATA) { console.error('Set BEANPOOL_DATA_DIR to a throwaway directory'); process.exit(1); }
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.ALERTS_WEBHOOK_URL;

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
async function until(cond: () => boolean, ms = 3_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (!cond()) { if (Date.now() > end) return false; await sleep(20); }
    return true;
}

// ── The mock registrar: /status answers `status` plus whatever notices the test puts out ─────────────────────────────

const reg = { asked: [] as URLSearchParams[], notices: [] as any[], status: { status: 'live', name: 'kestrel', hostname: 'kestrel.beanpool.org', mode: 'tunnel', tunnelToken: 'T-k' } as any };
let base = '';
async function startRegistrar(): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const u = new URL(req.url || '/', 'http://registrar');
        const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (!req.headers['x-bp-pubkey'] || !req.headers['x-bp-signature']) return send(401, { error: 'unsigned' });
        if (u.pathname !== '/api/registrar/status') return send(404, { error: 'not found' });
        // A query the node sent is signed with it (x-bp-signature-query), as the registrar reads only a signed one.
        if (u.search && !req.headers['x-bp-signature-query']) return send(400, { error: 'query not signed' });
        reg.asked.push(u.searchParams);
        send(200, { ...reg.status, ...(reg.notices.length ? { notices: reg.notices } : {}) });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    process.env.REGISTRAR_URL = base;
    return server;
}

const token = (c: string) => c.repeat(43);
const notice = (id: number, over: Record<string, unknown> = {}) => ({ id, at: 1_760_000_000 + id, level: 'info', text: `Notice number ${id}.`, name: 'kestrel', ...over });
const lastSeen = () => reg.asked.at(-1)?.get('seen') ?? null;

async function main(): Promise<void> {
    initStateEngine();
    const p2p = await startP2P(0, 0);
    const registrar = await startRegistrar();
    // Every note a security source makes, recorded, then told by the real alert book as the server tells it.
    const notes: SecurityNote[] = [];
    setSecurityAlertHandler((n) => { notes.push(n); alerts.raiseSecurity(n).catch(() => {}); });
    const noted = (key = 'reg.notice') => notes.filter((n) => n.key === key);
    const told = () => (alerts.getAlertsStatus().history as Array<{ key: string; detail: string; priority: number; count?: number }>).filter((e) => e.key === 'reg.notice');
    // The book keeps one line for the same words told again, with its count ("×3").
    const toldTimes = () => told().reduce((n, e) => n + (e.count ?? 1), 0);
    const fresh = () => {
        notes.length = 0;
        reg.asked.length = 0;
        reg.notices = [];
        alerts.resetAlertsForTests();
        updateLocalConfig({ registrarNotices: null, registrarNoticeSeen: null });
    };

    try {
        await section('1. /status sends seen once a notice is had; the notices are kept, out of the answer', async () => {
            fresh();
            await addressStatus('kestrel');
            assert(lastSeen() === null && reg.asked.at(-1)?.get('name') === 'kestrel', `no notice had: no seen, the name as before (${reg.asked.at(-1)})`);
            reg.notices = [notice(3), notice(5, { level: 'warning', link: `${base}/reply/${token('a')}` })];
            const answer = await addressStatus('kestrel');
            assert(answer.status === 'live' && answer.tunnelToken === 'T-k', 'the answer is as before');
            assert(!('notices' in answer), 'and carries no notices to the callers that store it');
            const kept = registrarNotices();
            assert(kept.map((n) => n.id).join() === '5,3', `kept newest first (${kept.map((n) => n.id)})`);
            assert(kept[0].level === 'warning' && kept[0].link === `${base}/reply/${token('a')}` && kept[0].text === 'Notice number 5.' && kept[0].name === 'kestrel',
                `as sent (${JSON.stringify(kept[0])})`);
            assert(noticeSeenMark() === 5, `the mark is the highest id (${noticeSeenMark()})`);
            reg.notices = [];
            await addressStatus('kestrel');
            assert(lastSeen() === '5' && reg.asked.at(-1)?.get('name') === 'kestrel', `the next /status says seen=5, with its name (${reg.asked.at(-1)})`);
            await addressStatus();
            assert(lastSeen() === '5', 'without a name too');
        });

        await section('2. exactly one owner alert per notice id, in the server\'s own words', async () => {
            fresh();
            reg.notices = [notice(3), notice(5, { level: 'warning', text: 'Secret words <b>only Settings</b> shows.' })];
            for (let i = 0; i < 3; i++) await addressStatus('kestrel');
            await Promise.all([addressStatus('kestrel'), addressStatus('kestrel')]);
            assert(noted().length === 2, `noted twice for two notices over five answers, two at once (${noted().length})`);
            assert(await until(() => told().length === 2), `the alert book told 2 (${told().length})`);
            const byLevel = told().map((e) => e.detail).sort();
            assert(byLevel.join('|') === [REGISTRAR_NOTICE_WORDS.info, REGISTRAR_NOTICE_WORDS.warning].sort().join('|'), `in the server's words by level (${byLevel})`);
            assert(told().some((e) => e.priority === 4) && told().some((e) => e.priority === 3), 'a warning high, information default');
            const everything = JSON.stringify(alerts.getAlertsStatus()) + fs.readdirSync(DATA!).filter((f) => f.startsWith('alerts')).map((f) => fs.readFileSync(path.join(DATA!, f), 'utf8')).join('');
            assert(!everything.includes('Secret words') && !everything.includes('Notice number'), 'the notice\'s own words reach no alert, no channel queue, no alert file');
            // A new one later: told once more.
            reg.notices = [notice(3), notice(5), notice(7, { level: 'action' })];
            await addressStatus('kestrel');
            await addressStatus('kestrel');
            assert(noted().length === 3 && noted().filter((n) => n.detail === REGISTRAR_NOTICE_WORDS.action).length === 1, `the third notice told once (${noted().length})`);
            // Read back after a restart (the book from disk, the notices from local-config): nothing is told again.
            alerts.rereadAlertsForTests();
            await addressStatus('kestrel');
            assert(noted().length === 3, 'carried again after a re-read: not told again');
        });

        await section('3. what can\'t be shown safely is not kept, and the registrar still hears it was had', async () => {
            fresh();
            reg.notices = [
                notice(10, { link: `https://evil.example/reply/${token('b')}` }),
                notice(11, { link: `${base}/reply/${token('c')}?x=1` }),
                notice(12, { text: `Hidden${String.fromCodePoint(0x202e)}reversed` }),
                notice(13, { text: 'x'.repeat(501) }),
                notice(14, { name: 'Not A Name' }),
                notice(15, { level: 'shouting' }),
                { id: 'sixteen', text: 'no id' },
                notice(17, { text: 'Line one\r\nLine two' }),
            ];
            await addressStatus('kestrel');
            const kept = new Map(registrarNotices().map((n) => [n.id, n]));
            assert([...kept.keys()].sort((a, b) => a - b).join() === '10,11,15,17', `kept 10, 11, 15, 17 (${[...kept.keys()]})`);
            assert(kept.get(10)?.link === null && kept.get(11)?.link === null, 'a link anywhere but the address service\'s own /reply/<token> is dropped');
            assert(kept.get(15)?.level === 'info', 'an unknown level reads as information');
            assert(kept.get(17)?.text === 'Line one\nLine two', 'lines kept');
            assert(noted().length === 4, `told only what was kept (${noted().length})`);
            reg.notices = [];
            await addressStatus('kestrel');
            assert(lastSeen() === '17', `seen moves past what was not kept (${lastSeen()})`);
            // A list that is no list: nothing.
            reg.notices = 'nonsense' as any;
            await addressStatus('kestrel');
            assert(noted().length === 4, 'a malformed notices field changes nothing');
            // Carried first without its link (another check-in made it), then with: the link is added, nothing told again.
            reg.notices = [notice(20)];
            await addressStatus('kestrel');
            reg.notices = [notice(20, { link: `${base}/reply/${token('d')}` })];
            await addressStatus('kestrel');
            assert(registrarNotices().find((n) => n.id === 20)?.link === `${base}/reply/${token('d')}` && noted().length === 5, 'its link added, told once');
        });

        await section('4. a standby takes none and sends no seen', async () => {
            fresh();
            updateLocalConfig({ registrarNoticeSeen: 30 });
            setNodeRole('backup');
            try {
                reg.notices = [notice(31)];
                await addressStatus('kestrel');
                assert(lastSeen() === null, 'no seen from a standby');
                assert(registrarNotices().length === 0 && noted().length === 0, 'nothing kept, nothing told');
            } finally { setNodeRole('primary'); }
            await addressStatus('kestrel');
            assert(noted().length === 1 && lastSeen() === '30', 'the main server takes it');
        });

        await section('5. the agent\'s tick takes them, and stores no notices in the address', async () => {
            fresh();
            updateNodeConfig({ publicAddress: { status: 'live', name: 'kestrel', hostname: 'kestrel.beanpool.org', mode: 'tunnel', tunnelToken: 'T-k' } } as any);
            reg.notices = [notice(40, { level: 'action', link: `${base}/reply/${token('e')}` })];
            await reconcile();
            assert(registrarNotices().some((n) => n.id === 40) && noted().length === 1, 'kept and told from the agent\'s check');
            const pa = (getNodeConfig() as any).publicAddress;
            assert(pa?.status === 'live' && !('notices' in pa), `the stored address carries no notices (${JSON.stringify(pa)})`);
            assert(!JSON.stringify(getLocalConfig()).includes('"notices"'), 'nor anything else stored as the answer came');
        });

        await section('6. Settings shows them under Public address', async () => {
            const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'static', 'settings.js'), 'utf-8');
            const start = src.indexOf('const NOTICE_LEVELS = {');
            const fn = src.indexOf('function renderAddressNotices(list)');
            let depth = 0, end = src.indexOf('{', fn);
            for (let i = end; i < src.length; i++) {
                if (src[i] === '{') depth++;
                else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
            }
            const box: any = { innerHTML: '', style: {} };
            const esc = (s: unknown) => String(s || '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' } as any)[c]);
            const ctx = vm.createContext({ document: { getElementById: (id: string) => (id === 'pubaddr-notices' ? box : null) }, esc, Date, Array });
            vm.runInContext(src.slice(start, end) + '\nthis.renderAddressNotices = renderAddressNotices;', ctx);
            ctx.renderAddressNotices([
                { id: 2, at: 1_760_000_000, level: 'action', text: 'Blocked by mistake?\n<script>alert(1)</script>', name: 'kestrel', link: 'https://beanpool.org/reply/' + token('f') },
                { id: 1, at: 1_759_000_000, level: 'info', text: 'Your name is set up.', name: 'kestrel', link: null },
            ]);
            const html = box.innerHTML as string;
            assert(box.style.display === '' && /From your address service/.test(html), 'shown, under its heading');
            assert(html.includes('&lt;script&gt;') && !html.includes('<script>'), 'the words as text, never markup');
            assert((html.match(/>Reply</g) || []).length === 1 && html.includes(`href="https://beanpool.org/reply/${token('f')}"`) && html.includes('rel="noopener noreferrer"'),
                'one Reply link, the kept one, opened with no referrer');
            assert(/Action needed/.test(html) && /Information/.test(html), 'each with its level in words');
            ctx.renderAddressNotices([]);
            assert(box.style.display === 'none' && box.innerHTML === '', 'nothing while there are none');
        });

        await section('7. a burst is bounded as every server alert is', async () => {
            fresh();
            reg.notices = [50, 51, 52, 53, 54].map((id) => notice(id));
            await addressStatus('kestrel');
            assert(noted().length === 5, `each noted once (${noted().length})`);
            await sleep(200);
            assert(toldTimes() === 3 && told().length === 1, `three told in the hour (one line, ×3), the rest folded for the hour's line (${JSON.stringify(told())})`);
            assert(registrarNotices().length === 5, 'all five in Settings');
        });

        await section('8. kept on this server only: never copied, never in a backup file or the stager\'s copy', async () => {
            const { LOCAL_CONFIG_FIELDS } = await import('./engine/replication-manifest.js');
            assert(LOCAL_CONFIG_FIELDS.registrarNotices?.kind === 'per-server' && LOCAL_CONFIG_FIELDS.registrarNoticeSeen?.kind === 'per-server',
                'both fields are per-server in the replication manifest');
            fresh();
            reg.notices = [notice(60, { link: `${base}/reply/${token('f')}` })];
            await addressStatus('kestrel');
            const kept = getLocalConfig();
            assert(kept.registrarNotices?.[0]?.link && kept.registrarNoticeSeen === 60, 'a notice with its link is kept here');
            const { redactLocalConfig } = await import('./config/local-config.js');
            const redacted = redactLocalConfig(kept) as any;
            assert(!('registrarNotices' in redacted) && !('registrarNoticeSeen' in redacted) && !JSON.stringify(redacted).includes('/reply/'),
                'a backup file\'s local config leaves the notices and their links out');
            const stager = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'services/stager.ts'), 'utf8');
            assert(/CREDENTIALS_LEFT_OUT = \[[^\]]*'registrarNotices'[^\]]*'registrarNoticeSeen'/.test(stager), 'the stager\'s copy leaves them out');
        });
    } catch (e: any) {
        assert(false, `the suite ran to the end (${e?.stack || e})`);
    } finally {
        registrar.close();
        await Promise.resolve(p2p.stop()).catch(() => {});
    }
    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
