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
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-group-picture-default.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initStateEngine, createGroup, getGroup, createTreasury } from './state-engine.js';
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

async function main() {
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
