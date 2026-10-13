/**
 * A member's own invites, conversation list and trades go to that member alone, whatever ENFORCE_READ_AUTH says.
 *
 * Each of these three reads refused another reader only `if (ENFORCE_READ_AUTH && actor !== publicKey)`, so on a node
 * whose operator set ENFORCE_READ_AUTH=false anyone, unsigned too, read them for any key:
 *   - GET /api/invite/mine/:publicKey: every invite the member made, the unused codes among them (a key to join the
 *     node) and who joined with each used one (measured 2026-10-14, scratch/reviews/sonnet-etag-addedby-check.md (a));
 *   - GET /api/messages/conversations/:publicKey: who the member talks with, and every chat's id;
 *   - GET /api/marketplace/transactions?publicKey=: who the member traded with, for how much.
 * /api/community/me and the ledger reads already held whatever the flag says; these now do the same.
 *
 * Boots the real server, through the real middleware, with ENFORCE_READ_AUTH as the run sets it: the plain run leaves it
 * unset (on, the default), the readauth-off variant (scripts/server-suites.mjs) sets it to 'false'. Each read is made
 * by the owner (200, everything), another member, a signed key that is no member here, a visitor and nobody (unsigned):
 * all refused, with nothing of the owner's in the answer, and the same answer whether the key asked about is the
 * owner's or no member's at all.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-own-reads-any-read-auth.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';

const READ_AUTH_ON = process.env.ENFORCE_READ_AUTH !== 'false'; // https-server.ts's rule: unset means ON
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

function signedHeaders(method: string, path: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

async function get(path: string, id?: Id): Promise<{ status: number; text: string }> {
    const res = await fetch(`${BASE}${path}`, { headers: id ? signedHeaders('GET', path, '', id) : {} });
    return { status: res.status, text: await res.text() };
}

async function main() {
    console.log(`A member's own invites, chats and trades reach only them, read auth ${READ_AUTH_ON ? 'ON' : 'OPTED OUT'}...\n`);
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const row = (callsign: string, visitor = false): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_visitor)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?, ?)`)
            .run(id.pubKeyHex, callsign, `INV-${callsign.toUpperCase()}`, visitor ? 1 : 0);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const owner = row('owner');
    const other = row('otherMember');
    const joiner = row('joiner');
    const visitor = row('visitor', true);
    const nonMember = keypair(); // signs, but has no row here
    const nobodyKey = keypair().pubKeyHex; // a key asked about that is no member here

    // What the owner holds: an unused invite, a used one, a DM with the other member, a trade with them.
    const UNUSED = 'INV-OWNR-UNUSED1';
    const USED = 'INV-OWNR-USEDXX1';
    db.prepare(`INSERT INTO invite_codes (code, created_by) VALUES (?, ?)`).run(UNUSED, owner.pubKeyHex);
    db.prepare(`INSERT INTO invite_codes (code, created_by, used_by, used_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(USED, owner.pubKeyHex, joiner.pubKeyHex);
    const DM = `own-reads-dm-${crypto.randomUUID()}`;
    db.prepare(`INSERT INTO conversations (id, type, post_id, name, created_by) VALUES (?, 'dm', NULL, NULL, ?)`).run(DM, owner.pubKeyHex);
    for (const pk of [owner.pubKeyHex, other.pubKeyHex]) {
        db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(DM, pk);
    }
    const POST = 'own-reads-post-1';
    const TRADE = 'own-reads-trade-1';
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status)
                VALUES (?, 'offer', 'misc', 'test', 'test', 5, ?, 'completed')`).run(POST, owner.pubKeyHex);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status)
                VALUES (?, ?, ?, ?, 5, 'completed')`).run(TRADE, POST, other.pubKeyHex, owner.pubKeyHex);

    const ROUTES: { label: string; path: (pk: string) => string; secrets: string[] }[] = [
        { label: 'invites', path: pk => `/api/invite/mine/${pk}`, secrets: [UNUSED, USED, joiner.pubKeyHex] },
        { label: 'conversation list', path: pk => `/api/messages/conversations/${pk}`, secrets: [DM] },
        { label: 'trades', path: pk => `/api/marketplace/transactions?publicKey=${pk}`, secrets: [TRADE, POST] },
    ];
    const carries = (text: string, secrets: string[]) => secrets.filter(s => text.includes(s));

    for (const route of ROUTES) {
        console.log(`\n── ${route.label} ──`);
        const own = await get(route.path(owner.pubKeyHex), owner);
        assert(own.status === 200, `the owner reads their own ${route.label} → 200 (got ${own.status})`);
        assert(carries(own.text, route.secrets).length === route.secrets.length,
            `…with everything in it (has ${carries(own.text, route.secrets).length}/${route.secrets.length})`);

        const readers: [string, Id | undefined, number][] = [
            ['another member', other, 403],
            ['a signed key that is no member here', nonMember, 403],
            ['a visitor', visitor, 403],
            ['nobody (unsigned)', undefined, 401],
        ];
        for (const [who, id, want] of readers) {
            const r = await get(route.path(owner.pubKeyHex), id);
            assert(r.status === want, `${who} reading the owner's ${route.label} → ${want} (got ${r.status})`);
            assert(carries(r.text, route.secrets).length === 0, `…and is sent none of it (saw ${carries(r.text, route.secrets).join(', ') || 'none'})`);
            const none = await get(route.path(nobodyKey), id);
            assert(none.status === r.status && none.text === r.text,
                `…the same answer as for a key that is no member here, so it says nothing about the key (${r.status} ${r.text.slice(0, 80)} | ${none.status} ${none.text.slice(0, 80)})`);
        }
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log(`⭐️ Own invites, chats and trades reach only their owner, read auth ${READ_AUTH_ON ? 'on' : 'opted out'}.`);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
