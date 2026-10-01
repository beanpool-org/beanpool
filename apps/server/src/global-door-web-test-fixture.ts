/**
 * A real node on the global profile for the web app's two-doors browser check (apps/pwa/e2e/global-door-check.mjs,
 * slice S5 of scratch/global-node/DESIGN-global-two-doors-fable.md). Not a suite: the check starts it, drives the web app
 * it serves in Chromium, and stops it by its PID. Everything a member's browser meets is this server's real code: the
 * signature middleware, the door's routes (#1425), the door work's check, the limiters, the web app's document policy.
 *
 * Localhost only. It contacts nobody: a fetch to any host but this machine is refused and logged (`BLOCKED-FETCH`), the
 * node's own background check for a newer release is answered here, and the providers' signing keys are the check's own
 * (`FIXTURE_JWKS`), primed into the key cache so no provider is asked.
 *
 * Env (set by the check): BEANPOOL_DATA_DIR (a fresh folder), FIXTURE_ROOT (a folder whose `public/` holds the web app
 * build: the server serves `./public` when it exists), FIXTURE_JWKS (`{ "google": <public JWK with kid> }`).
 *
 * Says `FIXTURE_READY {"port":N}` on stdout once listening. Takes one JSON request a line on stdin and answers one
 * `FIXTURE_ANSWER {"id":…,"ok":…,"result"|"error":…}` line:
 *   { op: 'sql', sql, params?, all? }   a statement on the node's database (`all`: rows back)
 *   { op: 'doorNumber', name, value }   a `node_config` row `doorNumbers.<name>` (null deletes it), read per request
 *   { op: 'resetLimits' }               the gateway, auth and door limiters start again
 *
 * Run by the check as: node --import tsx src/global-door-web-test-fixture.ts (cwd apps/server).
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.APPLE_CLIENT_IDS;
delete process.env.BEANPOOL_VAULT_TICKET_KEYS;

import readline from 'node:readline';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    // The node's own background check for a newer release (routes/settings.ts), answered here as other suites do.
    if (url.origin === 'https://api.github.com') {
        return new Response(JSON.stringify({ tag_name: 'v0.0.1', html_url: '', body: '', published_at: '' }), { status: 200 });
    }
    if (!LOOPBACK.has(url.hostname)) {
        console.error(`BLOCKED-FETCH ${url.origin}`);
        throw new Error(`global-door-web-test-fixture: no requests leave this machine (${url.origin})`);
    }
    return realFetch(input, init);
}) as typeof fetch;

function say(line: string): void {
    process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
    const root = process.env.FIXTURE_ROOT;
    if (!root) throw new Error('FIXTURE_ROOT is not set');
    // The server serves ./public when there is one (https-server.ts PUBLIC_DIR), read as it loads: so before it loads.
    process.chdir(root);

    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, seedGenesisMember } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { _resetJwksCacheForTests, _clearNoncesForTests } = await import('./sso.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { DOOR_NUMBERS_PREFIX } = await import('./engine/door-signal.js');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    _resetJwksCacheForTests();
    const jwks = JSON.parse(process.env.FIXTURE_JWKS || '{}') as Record<string, Record<string, unknown>>;
    for (const [provider, jwk] of Object.entries(jwks)) {
        _resetJwksCacheForTests(provider as 'google', { keys: [{ alg: 'RS256', use: 'sig', ...jwk } as any], expiresAt: Date.now() + 24 * 3600_000 });
    }
    _clearNoncesForTests();
    // As the global node runs: its profile switches (openJoin on, ssoRequiredForJoin off: both doors open).
    process.env.NODE_PROFILE = 'global';
    seedGenesisMember('f'.repeat(64), 'Olive');

    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
        let id: unknown = null;
        try {
            const req = JSON.parse(line);
            id = req.id;
            let result: unknown = null;
            switch (req.op) {
                case 'sql': {
                    const stmt = db.prepare(String(req.sql));
                    const params = Array.isArray(req.params) ? req.params : [];
                    result = req.all ? stmt.all(...params) : stmt.run(...params);
                    break;
                }
                case 'doorNumber': {
                    const key = `${DOOR_NUMBERS_PREFIX}${String(req.name)}`;
                    if (req.value === null) db.prepare('DELETE FROM node_config WHERE key = ?').run(key);
                    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(req.value));
                    break;
                }
                case 'resetLimits':
                    resetGatewayRateLimit();
                    pruneAuthAttempts(Date.now() + 3600_000);
                    break;
                default:
                    throw new Error(`no op ${String(req.op)}`);
            }
            say(`FIXTURE_ANSWER ${JSON.stringify({ id, ok: true, result })}`);
        } catch (e) {
            say(`FIXTURE_ANSWER ${JSON.stringify({ id, ok: false, error: (e as Error)?.message || String(e) })}`);
        }
    });
    say(`FIXTURE_READY ${JSON.stringify({ port })}`);
}

main().catch((e) => {
    console.error('global-door-web-test-fixture failed to start:', e);
    process.exit(1);
});
