/**
 * Group picture defaults & Treasury logo default (Pictures S4, §4.2, §4.3, §6).
 *
 * 1. createGroup fills the category emblem when avatarUrl is absent:
 *    - social -> bundled://sunflower
 *    - general -> bundled://bean-green
 *    - working_group -> bundled://solartree
 *    - guild -> bundled://crystal
 * 2. updateGroup refuses clearing avatarUrl to nothing ("A group keeps a picture").
 * 3. Treasury create with no avatar/photos defaults to bundled://bean-green.
 * 4. Sync/ingest rows arriving with no avatar are left untouched (never defaulted).
 * 5. Over a real HTTPS round trip, judged by what the node would keep (groupPictureColumnsOf), not by emptiness: a member's
 *    avatar URL sent at create gives the category's emblem, never a group with no picture; sent at update (as whitespace,
 *    null and '' are) it is refused and the picture stays. A member who is not a convenor gets 403 for any of them, as for
 *    any other edit, never the picture rule.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-group-picture-default.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createGroup, getGroup, createTreasury, joinGroup } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { updateGroup, getGroupPicture, getMemberPhoto } from '@beanpool/engine';
import { db } from './db/db.js';
import { createTreasuryRoutes } from './routes/treasury.js';

let run = 0;
let passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

async function dispatch(router: any, method: string, path: string, ctx: any) {
    const matched = router.match(path, method);
    const layer = matched.pathAndMethod.find((l: any) => l.methods.includes(method));
    if (!layer) throw new Error(`No route found for ${method} ${path}`);
    const fn = layer.stack[layer.stack.length - 1];
    await fn(ctx);
    return ctx;
}

interface Identity {
    pub: string;
    priv: crypto.KeyObject;
}

function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        priv: privateKey,
    };
}

function seedMember(pk: string, callsign: string) {
    db.prepare(`
        INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
        VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')
    `).run(pk, callsign);
}

async function send(base: string, method: string, path: string, body: unknown, signer: Identity): Promise<{ status: number; body: any }> {
    const bodyString = JSON.stringify(body);
    const ts = String(Date.now());
    const nonce = crypto.randomUUID();
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': signer.pub,
            'X-Signature': crypto.sign(null, Buffer.from(canonical), signer.priv).toString('base64'),
            'X-Timestamp': ts,
            'X-Nonce': nonce,
        },
        body: bodyString,
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json };
}

async function main() {
    await initTls();
    initStateEngine();

    const founder = keypair();
    seedMember(founder.pub, 'Alice');

    // 1. Group creation defaults to category emblem when avatarUrl is absent
    const socialGroup = createGroup({
        name: 'Social Club',
        createdBy: founder.pub,
        category: 'social',
    });
    const socialPic = getGroupPicture(db, socialGroup.id);
    assert(socialPic === 'bundled://sunflower', `social group defaulted to bundled://sunflower (got: ${socialPic})`);

    const generalGroup = createGroup({
        name: 'General Discussion',
        createdBy: founder.pub,
        category: 'general',
    });
    const generalPic = getGroupPicture(db, generalGroup.id);
    assert(generalPic === 'bundled://bean-green', `general group defaulted to bundled://bean-green (got: ${generalPic})`);

    const workingGroup = createGroup({
        name: 'Garden Working Group',
        createdBy: founder.pub,
        category: 'working_group',
    });
    const workingPic = getGroupPicture(db, workingGroup.id);
    assert(workingPic === 'bundled://solartree', `working_group defaulted to bundled://solartree (got: ${workingPic})`);

    const guildGroup = createGroup({
        name: 'Artisan Guild',
        createdBy: founder.pub,
        category: 'guild',
    });
    const guildPic = getGroupPicture(db, guildGroup.id);
    assert(guildPic === 'bundled://crystal', `guild defaulted to bundled://crystal (got: ${guildPic})`);

    // 2. updateGroup refuses clearing picture to nothing
    let updateFailed = false;
    try {
        updateGroup(db, socialGroup.id, founder.pub, { avatarUrl: '' });
    } catch (err: any) {
        updateFailed = true;
        assert(err.message.includes('A group keeps a picture'), `clearing picture to empty rejected: ${err.message}`);
    }
    assert(updateFailed, 'updateGroup threw error when clearing picture to empty string');

    let updateNullFailed = false;
    try {
        updateGroup(db, socialGroup.id, founder.pub, { avatarUrl: null as any });
    } catch (err: any) {
        updateNullFailed = true;
        assert(err.message.includes('A group keeps a picture'), `clearing picture to null rejected: ${err.message}`);
    }
    assert(updateNullFailed, 'updateGroup threw error when clearing picture to null');

    // 3. Treasury create route with no avatar/photos defaults to bundled://bean-green
    const router = createTreasuryRoutes({ checkAdminAuth: async () => false } as any);

    const fakeCtx: any = {
        state: { actor: founder.pub },
        requestBody: {
            name: 'Mullum Bakery',
            purpose: 'Baking sourdough bread for community',
            lifecycle: 'ongoing',
        },
        status: 200,
        body: {},
    };

    await dispatch(router, 'POST', '/api/treasury', fakeCtx);
    assert(fakeCtx.status === 200, `createEnterpriseHandler succeeded (status: ${fakeCtx.status})`);
    assert(fakeCtx.body?.success === true, `createEnterpriseHandler returned success: true`);

    const bakeryPhoto = getMemberPhoto(db, fakeCtx.body.publicKey);
    assert(
        bakeryPhoto === 'bundled://bean-green',
        `created enterprise avatar defaulted to bundled://bean-green (got: ${bakeryPhoto})`
    );

    // 4. Ingest / direct treasury row with no avatar is untouched
    const ingestTreasury = createTreasury('Ingest Enterprise', '', 0, {
        systemCreated: true,
        purpose: 'Ingested via sync',
    });
    const ingestPhoto = getMemberPhoto(db, ingestTreasury.publicKey);
    assert(
        !ingestPhoto,
        `ingest row with empty avatar remains empty (got: ${ingestPhoto})`
    );

    // 5. Over HTTPS: a value the node keeps as none never leaves a group without a picture
    const PORT = await startHttpsServer(0);
    const BASE = `https://localhost:${PORT}`;
    const starter = keypair();
    const neighbour = keypair();
    seedMember(starter.pub, 'Bea');
    seedMember(neighbour.pub, 'Cal');
    const memberAvatar = `/api/avatar/${starter.pub}?size=thumb&v=abcd1234`;
    const absoluteAvatar = `https://localhost:${PORT}${memberAvatar}`;

    {
        const made = await send(BASE, 'POST', '/api/groups', { name: 'Potters', category: 'guild', avatarUrl: memberAvatar }, starter);
        assert(made.status === 201, `POST /api/groups with a member's avatar URL → 201 (got ${made.status} ${made.body?.error ?? ''})`);
        const pic = made.body?.id ? getGroupPicture(db, made.body.id) : null;
        assert(pic === 'bundled://crystal', `and the group has its category's emblem, not no picture (got: ${pic})`);
        assert(typeof made.body?.avatarUrl === 'string' && made.body.avatarUrl.length > 0,
            `and the answer carries its picture URL (got: ${made.body?.avatarUrl})`);

        const absolute = await send(BASE, 'POST', '/api/groups', { name: 'Weavers', category: 'social', avatarUrl: absoluteAvatar }, starter);
        const absPic = absolute.body?.id ? getGroupPicture(db, absolute.body.id) : null;
        assert(absolute.status === 201 && absPic === 'bundled://sunflower',
            `POST with a member's absolute avatar URL → 201 and the emblem (got ${absolute.status}, ${absPic})`);
    }

    const chosen = 'bundled://honeybee';
    const library = createGroup({ name: 'Seed Library', createdBy: starter.pub, category: 'general', avatarUrl: chosen });
    joinGroup(library.id, neighbour.pub);
    const libraryPath = `/api/groups/${encodeURIComponent(library.id)}`;
    assert(getGroupPicture(db, library.id) === chosen, `fixture: the group holds its chosen picture (${getGroupPicture(db, library.id)})`);

    for (const [label, value] of [
        ["a member's avatar URL", memberAvatar],
        ["a member's absolute avatar URL", absoluteAvatar],
        ['whitespace', '   '],
        ['an empty string', ''],
        ['null', null],
    ] as const) {
        const r = await send(BASE, 'PATCH', libraryPath, { avatarUrl: value }, starter);
        assert(r.status === 400 && /A group keeps a picture/.test(r.body?.error ?? ''),
            `a convenor's PATCH with ${label} → 400 "A group keeps a picture" (got ${r.status} ${r.body?.error ?? ''})`);
        assert(getGroupPicture(db, library.id) === chosen, `and the picture stays (got: ${getGroupPicture(db, library.id)})`);
    }

    {
        const r = await send(BASE, 'PATCH', libraryPath, { avatarUrl: 'bundled://sunflower' }, starter);
        assert(r.status === 200 && getGroupPicture(db, library.id) === 'bundled://sunflower',
            `a convenor's PATCH with another picture → 200 and it is set (got ${r.status}, ${getGroupPicture(db, library.id)})`);
    }

    for (const [label, value] of [["a member's avatar URL", memberAvatar], ['an empty string', '']] as const) {
        const r = await send(BASE, 'PATCH', libraryPath, { avatarUrl: value }, neighbour);
        assert(r.status === 403, `a member who is not a convenor PATCHing ${label} → 403, as for any edit (got ${r.status} ${r.body?.error ?? ''})`);
        assert(getGroupPicture(db, library.id) === 'bundled://sunflower', `and the picture stays (got: ${getGroupPicture(db, library.id)})`);
    }
    {
        const r = await send(BASE, 'PATCH', libraryPath, { name: 'Renamed' }, neighbour);
        assert(r.status === 403, `(the same member renaming it → 403, the answer the picture now shares; got ${r.status})`);
    }

    console.log(`\n${passed}/${run} tests passed.`);
    if (passed !== run) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error('Test failed with unhandled error:', err);
    process.exit(1);
});
