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
import { updateGroup, getGroupPicture } from '@beanpool/engine';
import { db } from './db/db.js';
import { registerTreasuryRoutes } from './routes/treasury.js';

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
    const handlers: Record<string, Function> = {};
    const router = {
        post: (p: string, h: Function) => { handlers[p] = h; },
        get: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
    };
    registerTreasuryRoutes(router);

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

    await handlers['/api/treasury'](fakeCtx);
    assert(fakeCtx.status === 200, `createEnterpriseHandler succeeded (status: ${fakeCtx.status})`);
    assert(fakeCtx.body?.success === true, `createEnterpriseHandler returned success: true`);

    const treasuryRow = db.prepare('SELECT avatar_url, avatar_ref FROM treasuries WHERE name = ?').get('Mullum Bakery') as any;
    assert(
        treasuryRow?.avatar_url === 'bundled://bean-green' || treasuryRow?.avatar_ref === 'bundled://bean-green',
        `created enterprise avatar defaulted to bundled://bean-green (avatar_url: ${treasuryRow?.avatar_url}, avatar_ref: ${treasuryRow?.avatar_ref})`
    );

    // 4. Ingest / direct treasury row with no avatar is untouched
    const ingestTreasury = createTreasury('Ingest Enterprise', '', 0, {
        systemCreated: true,
        purpose: 'Ingested via sync',
    });
    const ingestRow = db.prepare('SELECT avatar_url, avatar_ref FROM treasuries WHERE public_key = ?').get(ingestTreasury.publicKey) as any;
    assert(
        !ingestRow?.avatar_url && !ingestRow?.avatar_ref,
        `ingest row with empty avatar remains empty (avatar_url: ${ingestRow?.avatar_url}, avatar_ref: ${ingestRow?.avatar_ref})`
    );

    console.log(`\n${passed}/${run} tests passed.`);
    if (passed !== run) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Test failed with unhandled error:', err);
    process.exit(1);
});
