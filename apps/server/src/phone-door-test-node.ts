/**
 * A real node for the phone's end-to-end door tests (apps/native/utils/__tests__/global-door-e2e.test.ts): the global
 * profile, over HTTPS on a port the OS picks, with the real signature middleware, the real door routes
 * (routes/open-join.ts) and the real door work, so the phone's own code is measured against the node it will meet.
 * A test fixture only: nothing in the server imports it, and no suite runs it on its own.
 *
 * Started by that test with `node --import tsx src/phone-door-test-node.ts`, in its own data folder
 * (BEANPOOL_DATA_DIR), and killed by its PID. Contacts nothing: every fetch to a host that isn't this machine throws,
 * and says so (`BLOCKED-FETCH`). No provider is asked either: the test's Google key is primed into sso.ts's cache from
 * PHONE_DOOR_GOOGLE_JWK, as the server suites do.
 *
 * It prints `PHONE-DOOR-NODE-PORT <port>` once it listens (and, with PHONE_DOOR_HTTP_PORT set, for an emulator,
 * `PHONE-DOOR-NODE-HTTP-PORT <port>` for plain HTTP on that port). Then one JSON command a line on stdin, each answered
 * on stdout as `PHONE-DOOR-NODE-REPLY {"id":…,"result":…}`:
 *   limiters                    clear the gateway's and the door's limiters (every request here comes from one address)
 *   member {key}                the member's row and its open_joins row (door, network hash, how long the hash is kept)
 *   probation {key}             the member's new-account limits, as /api/community/me reports them
 *   prune {key}                 a moderator removes the member (adminPruneUser), as the moderation screen does
 *   doorNumber {name, value}    a `doorNumbers.<name>` override, as an operator sets one in node_config
 *   removedNewcomers {ips}      a 12-words newcomer from each address, removed minutes after joining (design §2.4)
 *   quit                        exit
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.GOOGLE_CLIENT_IDS;
process.env.NODE_PROFILE = 'global';

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(href).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
        console.error(`BLOCKED-FETCH ${href}`);
        return Promise.reject(new Error(`phone-door-test-node: no contact with ${host}`));
    }
    return realFetch(input, init);
}) as typeof fetch;

async function main(): Promise<void> {
    // Loaded after the environment above is set: these modules read it as they load.
    const readline = await import('node:readline');
    const crypto = await import('node:crypto');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, adminPruneUser, broadcast } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { startHttpServer } = await import('./http-server.js');
    const { openJoinAddressHash, registerOpenJoin, wordsJoinHash } = await import('./engine/open-join.js');
    const { limiterKeyForIp } = await import('./client-ip.js');
    const { db } = await import('./db/db.js');
    const { _resetJwksCacheForTests } = await import('./sso.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { probationState } = await import('./engine/probation.js');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);

    const jwk = process.env.PHONE_DOOR_GOOGLE_JWK;
    if (jwk) _resetJwksCacheForTests('google', { keys: [JSON.parse(jwk)], expiresAt: Date.now() + 3600_000 });

    console.log(`PHONE-DOOR-NODE-PORT ${port}`);
    // The emulator's session: plain HTTP on a port it names, reached through `adb reverse` (a dev client takes no
    // self-signed certificate). The API is the same Koa app (http-server.ts hands /api to it).
    if (process.env.PHONE_DOOR_HTTP_PORT) {
        const httpPort = await startHttpServer(Number(process.env.PHONE_DOOR_HTTP_PORT));
        console.log(`PHONE-DOOR-NODE-HTTP-PORT ${httpPort}`);
    }

    const commands: Record<string, (args: any) => unknown> = {
        limiters: () => {
            resetGatewayRateLimit();
            pruneAuthAttempts(Date.now() + 120_000);
            return true;
        },
        member: ({ key }) => ({
            member: db.prepare('SELECT public_key, callsign, status, invited_by FROM members WHERE public_key = ?').get(key) ?? null,
            join: db.prepare('SELECT provider, join_hash, ip_hash, ip_kept_until, joined_at FROM open_joins WHERE member_pubkey = ?').get(key) ?? null,
        }),
        probation: ({ key }) => probationState(String(key)),
        prune: ({ key }) => {
            adminPruneUser(String(key), 'owner:password');
            return true;
        },
        // For the emulator's busy-level screens: a door number (`doorNumbers.<name>`, as an operator would set it), and a
        // 12-words newcomer removed minutes after joining from each of these addresses (design §2.4), so the next 12-words
        // join from one of them is asked `removedNetworkLevel`.
        doorNumber: ({ name, value }: { name?: string; value?: string }) => {
            db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
                .run(`doorNumbers.${String(name)}`, String(value));
            return true;
        },
        removedNewcomers: ({ ips }: { ips?: string[] }) => (ips ?? []).map((ip) => {
            const key = crypto.randomBytes(32).toString('hex');
            const ipHash = openJoinAddressHash(limiterKeyForIp(ip));
            const outcome = registerOpenJoin(broadcast, { publicKey: key, callsign: `Gone ${key.slice(0, 4)}`, provider: 'words', joinHash: wordsJoinHash(), ipHash });
            if (outcome.ok) adminPruneUser(key, 'owner:password');
            return { ip, joined: outcome.ok };
        }),
        quit: () => process.exit(0),
    };

    const lines = readline.createInterface({ input: process.stdin });
    lines.on('line', (line) => {
        let id: unknown = null;
        try {
            const msg = JSON.parse(line) as { id?: unknown; cmd?: string; key?: string };
            id = msg.id ?? null;
            const run = commands[String(msg.cmd)];
            if (!run) throw new Error(`no command ${String(msg.cmd)}`);
            console.log(`PHONE-DOOR-NODE-REPLY ${JSON.stringify({ id, result: run(msg) })}`);
        } catch (e) {
            console.log(`PHONE-DOOR-NODE-REPLY ${JSON.stringify({ id, error: (e as Error)?.message ?? String(e) })}`);
        }
    });
    // The test went away without saying quit: so does this node.
    lines.on('close', () => process.exit(0));
}

main().catch((e) => {
    console.error('phone-door-test-node failed to start:', e);
    process.exit(1);
});
