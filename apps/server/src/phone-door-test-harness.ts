/**
 * A real node for the phone's end-to-end door tests (apps/native/utils/__tests__/global-door-e2e.test.ts): the global
 * profile, over HTTPS on a port the OS picks, with the real signature middleware, the real door routes
 * (routes/open-join.ts) and the real door work, so the phone's own code is measured against the node it will meet.
 * Also a community's own node (PHONE_DOOR_PROFILE=community) for utils/__tests__/debts-repayment-e2e.test.ts.
 * A test fixture only: nothing in the server imports it, and no suite runs it on its own.
 *
 * Started by that test with `node --import tsx src/phone-door-test-harness.ts`, in its own data folder
 * (BEANPOOL_DATA_DIR), and killed by its PID. Contacts nothing: every fetch to a host that isn't this machine throws,
 * and says so (`BLOCKED-FETCH`). No provider is asked either: the test's Google key is primed into sso.ts's cache from
 * PHONE_DOOR_GOOGLE_JWK, as the server suites do.
 *
 * It prints `PHONE-DOOR-NODE-PORT <port>` once it listens (and, with PHONE_DOOR_HTTP_PORT set, for an emulator,
 * `PHONE-DOOR-NODE-HTTP-PORT <port>` for plain HTTP on that port). Then one JSON command a line on stdin, each answered
 * on stdout as `PHONE-DOOR-NODE-REPLY {"id":…,"result":…}`:
 *   limiters                    clear the gateway's, the chat's and the door's limiters (every request here comes from one address)
 *   member {key}                the member's row and its open_joins row (door, network hash, how long the hash is kept)
 *   probation {key}             the member's new-account limits, as /api/community/me reports them
 *   prune {key}                 a moderator removes the member (adminPruneUser), as the moderation screen does
 *   status {key, status}        the member's status (`suspended`, `active`), as the server suites set it
 *   doorNumber {name, value}    a `doorNumbers.<name>` override, as an operator sets one in node_config
 *   removedNewcomers {ips}      a 12-words newcomer from each address, removed minutes after joining (design §2.4)
 *   workingOff {key, beans, owed}  a member holding `beans`, confirmed by an admin to work off an `owed`-Bean debt left on
 *                               their names-list entry (fixture rows, as test-names-debts-http's); answers the debt's id
 *   receive {key, beans}        a direct payment to the member (transfer()), whose after-commit hook runs the repayment sweep
 *   debt {key, debtId}          the member's balance and the debt record (repaid, status, how it was settled)
 *   members {members}           member rows (each {key, callsign}, joined 30 days ago), as workingOff writes one: for the
 *                               phone's group chat e2e (utils/__tests__/group-chat-e2e.test.ts)
 *   groupRows {groupId, keys}   active group_members rows written straight in, with no epoch: members a node let in
 *                               without a rotation (a big group for the rotation timing; an old app's join)
 *   rekey {oldKey, newKey}      the admin's re-key, completed (issueRekeyCode + completeRekey), as the admin screen does it
 *   sql {sql, params, all}      one statement on the node's database, for that e2e's assertions and its dishonest-node
 *                               cases (a moved author column, a rolled-back epoch, a junk wrap); `all` answers the rows
 * For apps/native/utils/__tests__/pillar-sync-nearby.test.ts (the phone's sync by area, DESIGN-global-sync-by-area §2.4):
 *   join {key, callsign, area?} a member (active), with an area ({lat, lng}, rounded as the node keeps it) or none
 *   area {key, area}            the member's area set ({lat, lng}) or cleared (null), as POST /api/community/me/area does
 *   listings {rows}             listings, each {id, author, lat, lng, type?, at?}: active, public, changed at `at` (else now)
 *   edit {post, lat?, lng?, status?}  a listing moved or taken off (`cancelled`), changed now
 *   deal {post, buyer, seller, status, at?}  a deal on a listing (a fixture row: requested or pending is a tie of both)
 *   holiday {key}               the member goes on holiday (setHolidayMode): their listings are off the board
 *   postsSql {q, p?}            one statement on the node's database, as a fixture (a conversation, a block)
 *   epoch                       a take-over: the node's identity epoch one higher, as the take-over's role step leaves it
 *   profileSwitch {name, value} a profile switch's override in node_config (`true`/`false`), as an operator sets one
 *   quit                        exit
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.GOOGLE_CLIENT_IDS;
// PHONE_DOOR_PROFILE=community: a community's own node instead (Beans on), for the phone's repayment e2e.
if (process.env.PHONE_DOOR_PROFILE === 'community') delete process.env.NODE_PROFILE;
else process.env.NODE_PROFILE = 'global';
// No release check against GitHub (routes/settings.ts): the guard below would refuse it anyway.
process.env.DISABLE_UPDATE_CHECK = 'true';

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(href).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
        console.error(`BLOCKED-FETCH ${href}`);
        return Promise.reject(new Error(`phone-door-test-harness: no contact with ${host}`));
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
    const { resetChatRateLimit } = await import('./chat-rate-limit.js');
    const { probationState } = await import('./engine/probation.js');
    const { transfer, getBalance, setHolidayMode, bumpGroupsVersion } = await import('./state-engine.js');
    const { setMemberArea } = await import('./engine/member-area.js');
    const { bumpPostsVersion } = await import('./engine/versions.js');
    const { getLocalConfig, updateLocalConfig } = await import('./config/local-config.js');
    const { forgetSyncEpochHeaderValue } = await import('./services/identity-epoch.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');

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
            resetChatRateLimit();
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
        status: ({ key, status }: { key?: string; status?: string }) => {
            if (status !== 'suspended' && status !== 'active') throw new Error(`no status ${String(status)}`);
            db.prepare('UPDATE members SET status = ? WHERE public_key = ?').run(status, String(key));
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
        workingOff: ({ key, beans, owed }: { key?: string; beans?: number; owed?: number }) => {
            const pk = String(key);
            const hex = (n: number) => crypto.randomBytes(n).toString('hex');
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`)
                .run(pk, `Working ${pk.slice(0, 4)}`, new Date(Date.now() - 30 * 86_400_000).toISOString());
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
            if (Number(beans) > 0) transfer('genesis', pk, Number(beans), 'seed', 'direct', true);
            const entry = hex(16);
            const debtId = hex(16);
            db.prepare('INSERT INTO names_entries (id, ciphertext, key_id, created_by) VALUES (?, ?, ?, ?)').run(entry, 'sealed:' + hex(24), hex(32), 'fixture');
            db.prepare('INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)').run(hex(16), pk, entry, 'fixture');
            db.prepare(`INSERT INTO names_debts (id, entry_id, amount, reason, removed_at, repaying_pubkey) VALUES (?, ?, ?, 'account_deleted', ?, ?)`)
                .run(debtId, entry, Number(owed), new Date().toISOString(), pk);
            return debtId;
        },
        receive: ({ key, beans }: { key?: string; beans?: number }) => {
            transfer('genesis', String(key), Number(beans), 'paid by a neighbour', 'direct', true);
            return true;
        },
        debt: ({ key, debtId }: { key?: string; debtId?: string }) => ({
            balance: getBalance(String(key)).balance,
            record: db.prepare('SELECT amount, repaid, status, settled_how FROM names_debts WHERE id = ?').get(String(debtId)) ?? null,
            links: (db.prepare('SELECT COUNT(*) n FROM names_debt_payments WHERE debt_id = ?').get(String(debtId)) as { n: number }).n,
        }),
        members: ({ members }: { members?: { key: string; callsign: string }[] }) => {
            const joined = new Date(Date.now() - 30 * 86_400_000).toISOString();
            for (const m of members ?? []) {
                db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`)
                    .run(String(m.key), String(m.callsign), joined);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(String(m.key));
            }
            return (members ?? []).length;
        },
        groupRows: ({ groupId, keys }: { groupId?: string; keys?: string[] }) => {
            const now = new Date().toISOString();
            const add = db.prepare(`INSERT OR IGNORE INTO group_members (group_id, member_pubkey, role, status, joined_at, role_since, updated_at)
                                    VALUES (?, ?, 'member', 'active', ?, ?, ?)`);
            db.transaction(() => { for (const k of keys ?? []) add.run(String(groupId), String(k), now, now, now); })();
            // As a join does: GET …/members serves a snapshot keyed by the groups version (roster-snapshots.ts).
            bumpGroupsVersion();
            return (keys ?? []).length;
        },
        // The admin's re-key, whole (engine/member-wizards.ts issueRekeyCode + completeRekey, as the admin screen runs them):
        // the member's rows move to the new key, and the old key's invalidated_keys row names it, unattested.
        rekey: ({ oldKey, newKey }: { oldKey?: string; newKey?: string }) => {
            const done = completeRekey(String(oldKey), String(newKey), issueRekeyCode(String(oldKey), '').code, '');
            return { oldPubkey: done.oldPubkey, newPubkey: done.newPubkey };
        },
        sql: ({ sql, params, all }: { sql?: string; params?: unknown[]; all?: boolean }) => {
            const st = db.prepare(String(sql));
            return all ? st.all(...(params ?? [])) : st.run(...(params ?? [])).changes;
        },
        join: ({ key, callsign, area }: { key?: string; callsign?: string; area?: { lat: number; lng: number } | null }) => {
            const pk = String(key);
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`)
                .run(pk, String(callsign ?? `Member ${pk.slice(0, 4)}`), new Date(Date.now() - 30 * 86_400_000).toISOString());
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
            return area ? setMemberArea(pk, area) : null;
        },
        area: ({ key, area }: { key?: string; area?: { lat: number; lng: number } | null }) => setMemberArea(String(key), area ?? null),
        listings: ({ rows }: { rows?: Array<{ id: string; author: string; lat: number | null; lng: number | null; type?: string; at?: string }> }) => {
            const now = new Date().toISOString();
            const insert = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active,
                                       created_at, updated_at, lat, lng) VALUES (?, ?, 'food', ?, '', 5, ?, 'active', 1, ?, ?, ?, ?)`);
            db.transaction(() => {
                for (const r of rows ?? []) insert.run(r.id, r.type ?? 'offer', `Listing ${r.id}`, r.author, r.at ?? now, r.at ?? now, r.lat, r.lng);
            })();
            bumpPostsVersion();
            return (rows ?? []).length;
        },
        // `post`, not `id`: `id` is the command's own.
        edit: ({ post, lat, lng, status }: { post?: string; lat?: number; lng?: number; status?: string }) => {
            const now = new Date().toISOString();
            if (lat !== undefined && lng !== undefined) db.prepare('UPDATE posts SET lat = ?, lng = ?, updated_at = ? WHERE id = ?').run(lat, lng, now, String(post));
            if (status === 'cancelled') db.prepare("UPDATE posts SET status = 'cancelled', active = 0, updated_at = ? WHERE id = ?").run(now, String(post));
            bumpPostsVersion();
            return true;
        },
        deal: ({ post, buyer, seller, status, at }: { post?: string; buyer?: string; seller?: string; status?: string; at?: string }) => {
            db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
                        VALUES (?, ?, ?, ?, 5, ?, ?)`).run(`deal-${String(post)}`, String(post), String(buyer), String(seller), String(status), at ?? new Date().toISOString());
            bumpPostsVersion();
            return true;
        },
        holiday: ({ key }: { key?: string }) => {
            setHolidayMode(String(key), true);
            return true;
        },
        // A write behind the routes that also bumps the posts version (the 304 probes); `sql` above is the plain one.
        postsSql: ({ q, p }: { q?: string; p?: unknown[] }) => {
            const r = db.prepare(String(q)).run(...(Array.isArray(p) ? p : []));
            bumpPostsVersion();
            return Number(r.changes);
        },
        epoch: () => {
            const next = (Number(getLocalConfig().identityEpoch) || 0) + 1;
            updateLocalConfig({ identityEpoch: next, identityEpochSince: new Date().toISOString() } as any);
            forgetSyncEpochHeaderValue();
            return next;
        },
        profileSwitch: ({ name, value }: { name?: string; value?: string }) => {
            db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
                .run(`${NODE_PROFILE_KEY}.${String(name)}`, String(value));
            return true;
        },
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
    console.error('phone-door-test-harness failed to start:', e);
    process.exit(1);
});
