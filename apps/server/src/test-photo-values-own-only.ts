/**
 * Issue #2082: A stored photo value must be a data: image, a bundled:// name, or one of this node's own photo paths/keys.
 * Outside URLs (https://, http://, //host, javascript:) must be refused at the routes.
 *
 * Route checks:
 *   - POST /api/profile/update { avatar }
 *   - POST /api/enterprise { avatar, photos }
 *   - POST /api/local/admin/treasury { avatar }
 *   - POST /api/crowdfund/projects { photos }
 *   - POST /api/crowdfund/projects/update { photos }
 *   - POST /api/groups { avatarUrl }
 *   - PATCH /api/groups/:id { avatarUrl }
 *   - POST /api/pricing-guide/admin/item { thumbnailUrl }
 *   - POST /api/marketplace/posts { photos }
 *   - POST /api/marketplace/posts/update { photos }
 *   - POST /api/join/knock { avatar }
 *
 * Setup patterned after apps/server/src/test-photo-pixel-cap-attachment-read.ts.
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-photo-values-own-only.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'ENFORCE_READ_AUTH', 'ENFORCE_WS_AUTH', 'ENFORCE_LEDGER_AUTH', 'NODE_PROFILE', 'PRIVATE_PREVIEW']) delete process.env[k];
if (process.env.READ_AUTH === 'off') process.env.ENFORCE_READ_AUTH = 'false';
process.env.DISABLE_UPDATE_CHECK = 'true';

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { AVATAR_FORMAT_ERROR } from './engine/avatar.js';
import { POST_PHOTO_FORMAT_ERROR } from './engine/posts.js';

let run = 0, passed = 0;
const fails: string[] = [];
function check(id: string, cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ [${id}] ${msg}`); } else { fails.push(id); console.error(`✗ [${id}] ${msg}`); }
}
let BASE = '';
const DAY = 86400_000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
type Id = { pk: string; privateKey: crypto.KeyObject };
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now(); const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return { 'X-Public-Key': id.pk, 'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'), 'X-Timestamp': String(ts), 'X-Nonce': nonce };
}
let beforeCall: () => void = () => {};
async function req(method: string, p: string, id?: Id, body?: any, extraHeaders?: Record<string, string>): Promise<{ status: number; body: any }> {
    beforeCall();
    const s = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
        ...(id ? signedHeaders(method, p, s, id) : {}),
        ...(extraHeaders || {}),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : s });
    const t = await res.text(); let json: any; try { json = JSON.parse(t); } catch { json = t; }
    return { status: res.status, body: json };
}

const errorOf = (r: { body: any }) => String(r.body?.message ?? r.body?.error ?? '');

const OUTSIDE_URLS = [
    'https://evil.com/tracker.png',
    'http://insecure.org/pic.jpg',
    '//protocol-relative.net/asset.png',
    'javascript:alert(1)',
    'https://evil.com/other-path',
];

async function main(): Promise<void> {
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');

    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };
    await initTls();
    se.initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const member = (callsign: string): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, 'seed', ?)`).run(id.pk, callsign, new Date(Date.now() - 60 * DAY).toISOString(), `INV-${callsign.toUpperCase()}`);
        setMemberPhoto(db, id.pk, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };

    const adminHeaders = ownerTokenHeaders('admin');
    const alice = member('PhotoAlice');
    const bob = member('PhotoBob');

    // ── 1. POST /api/profile/update ──
    for (const url of OUTSIDE_URLS) {
        const res = await req('POST', '/api/profile/update', alice, { avatar: url });
        check('profile-outside', res.status === 400 && res.body?.error === 'avatar_invalid' && res.body?.message === AVATAR_FORMAT_ERROR, `profile update refuses outside url ${url} → 400 avatar_invalid (got ${res.status} ${JSON.stringify(res.body)})`);
    }
    // Acceptable values
    const profData = await req('POST', '/api/profile/update', alice, { avatar: TINY_PNG });
    check('profile-data', profData.status === 200, `profile update accepts data: PNG → 200 (got ${profData.status})`);
    const profBundled = await req('POST', '/api/profile/update', alice, { avatar: 'bundled://default' });
    check('profile-bundled', profBundled.status === 200, `profile update accepts bundled:// avatar → 200 (got ${profBundled.status})`);
    const profSelf = await req('POST', '/api/profile/update', alice, { avatar: `/api/avatar/${alice.pk}` });
    check('profile-self', profSelf.status === 200, `profile update accepts /api/avatar/:pk → 200 (got ${profSelf.status})`);
    const profSelfAbs = await req('POST', '/api/profile/update', alice, { avatar: `${BASE}/api/avatar/${alice.pk}` });
    check('profile-self-abs', profSelfAbs.status === 200, `profile update accepts absolute own avatar URL → 200 (got ${profSelfAbs.status})`);
    const profClear = await req('POST', '/api/profile/update', alice, { avatar: '' });
    check('profile-clear', profClear.status === 200, `profile update accepts empty string (clear) → 200 (got ${profClear.status})`);
    // Restore Alice's avatar for subsequent routes (e.g. marketplace)
    await req('POST', '/api/profile/update', alice, { avatar: TINY_PNG });

    // ── 2. POST /api/enterprise (createEnterpriseHandler) ──
    for (const url of OUTSIDE_URLS) {
        const resAv = await req('POST', '/api/enterprise', alice, { name: 'Ent Out', avatar: url, purpose: 'Test' });
        check('enterprise-outside-avatar', resAv.status === 400 && errorOf(resAv) === AVATAR_FORMAT_ERROR, `enterprise refuses outside avatar url ${url} → 400 (got ${resAv.status} ${JSON.stringify(resAv.body)})`);
        const resPhotos = await req('POST', '/api/enterprise', alice, { name: 'Ent Out', photos: [url], purpose: 'Test' });
        check('enterprise-outside-photos', resPhotos.status === 400 && errorOf(resPhotos) === AVATAR_FORMAT_ERROR, `enterprise refuses outside photos url ${url} → 400 (got ${resPhotos.status} ${JSON.stringify(resPhotos.body)})`);
    }
    const entData = await req('POST', '/api/enterprise', alice, { name: 'Ent Data', avatar: TINY_PNG, purpose: 'Test' });
    check('enterprise-data', entData.status === 200 && !!entData.body?.publicKey, `enterprise accepts data: PNG → 200 (got ${entData.status})`);
    const entBundled = await req('POST', '/api/enterprise', alice, { name: 'Ent Bundled', avatar: 'bundled://default', purpose: 'Test' });
    check('enterprise-bundled', entBundled.status === 200 && !!entBundled.body?.publicKey, `enterprise accepts bundled:// avatar → 200 (got ${entBundled.status})`);
    const entSelf = await req('POST', '/api/enterprise', alice, { name: 'Ent Self', avatar: `/api/avatar/${alice.pk}`, purpose: 'Test' });
    check('enterprise-self', entSelf.status === 200 && !!entSelf.body?.publicKey, `enterprise accepts own photo path → 200 (got ${entSelf.status})`);
    const entSelfAbs = await req('POST', '/api/enterprise', bob, { name: 'Ent Self Abs', avatar: `${BASE}/api/avatar/${bob.pk}`, purpose: 'Test' });
    check('enterprise-self-abs', entSelfAbs.status === 200 && !!entSelfAbs.body?.publicKey, `enterprise accepts absolute own avatar URL → 200 (got ${entSelfAbs.status})`);
    const entPhotosAbs = await req('POST', '/api/enterprise', bob, { name: 'Ent Photos Abs', photos: [`${BASE}/api/avatar/${bob.pk}`], purpose: 'Test' });
    check('enterprise-photos-abs', entPhotosAbs.status === 200 && !!entPhotosAbs.body?.publicKey, `enterprise accepts absolute own photos URL → 200 (got ${entPhotosAbs.status})`);

    // ── 3. POST /api/local/admin/treasury ──
    for (const url of OUTSIDE_URLS) {
        const res = await req('POST', '/api/local/admin/treasury', undefined, { name: 'Admin Ent', avatar: url }, adminHeaders);
        check('admin-treasury-outside', res.status === 400 && errorOf(res) === AVATAR_FORMAT_ERROR, `admin treasury refuses outside avatar url ${url} → 400 (got ${res.status} ${JSON.stringify(res.body)})`);
    }
    const admData = await req('POST', '/api/local/admin/treasury', undefined, { name: 'Admin Data', avatar: TINY_PNG }, adminHeaders);
    check('admin-treasury-data', admData.status === 200 && !!admData.body?.publicKey, `admin treasury accepts data: PNG → 200 (got ${admData.status})`);
    const admBundled = await req('POST', '/api/local/admin/treasury', undefined, { name: 'Admin Bundled', avatar: 'bundled://default' }, adminHeaders);
    check('admin-treasury-bundled', admBundled.status === 200 && !!admBundled.body?.publicKey, `admin treasury accepts bundled:// → 200 (got ${admBundled.status})`);
    const admSelf = await req('POST', '/api/local/admin/treasury', undefined, { name: 'Admin Self', avatar: `/api/avatar/${alice.pk}` }, adminHeaders);
    check('admin-treasury-self', admSelf.status === 200 && !!admSelf.body?.publicKey, `admin treasury accepts own photo path → 200 (got ${admSelf.status})`);
    const admSelfAbs = await req('POST', '/api/local/admin/treasury', undefined, { name: 'Admin Self Abs', avatar: `${BASE}/api/avatar/${alice.pk}` }, adminHeaders);
    check('admin-treasury-self-abs', admSelfAbs.status === 200 && !!admSelfAbs.body?.publicKey, `admin treasury accepts absolute own avatar URL → 200 (got ${admSelfAbs.status})`);

    // ── 4. POST /api/crowdfund/projects & POST /api/crowdfund/projects/update ──
    for (const url of OUTSIDE_URLS) {
        const res = await req('POST', '/api/crowdfund/projects', alice, {
            creatorPubkey: alice.pk,
            title: 'Crowdfund Out',
            description: 'desc',
            goalAmount: 100,
            photos: [url],
        });
        check('crowdfund-outside-photos', res.status === 400 && errorOf(res) === AVATAR_FORMAT_ERROR, `crowdfund create refuses outside photos url ${url} → 400 (got ${res.status} ${JSON.stringify(res.body)})`);
    }
    const cfOk = await req('POST', '/api/crowdfund/projects', alice, {
        creatorPubkey: alice.pk,
        title: 'Crowdfund Ok',
        description: 'desc',
        goalAmount: 100,
        photos: [TINY_PNG],
    });
    const cfId = cfOk.body?.project?.id;
    check('crowdfund-data', cfOk.status === 200 && !!cfId, `crowdfund create accepts data: PNG → 200 (got ${cfOk.status} ${JSON.stringify(cfOk.body)})`);
    const cfAbs = await req('POST', '/api/crowdfund/projects', alice, {
        creatorPubkey: alice.pk,
        title: 'Crowdfund Abs',
        description: 'desc',
        goalAmount: 100,
        photos: [`${BASE}/api/avatar/${alice.pk}`],
    });
    check('crowdfund-abs', cfAbs.status === 200 && !!cfAbs.body?.project?.id, `crowdfund create accepts absolute own photo URL → 200 (got ${cfAbs.status})`);
    if (cfId) {
        for (const url of OUTSIDE_URLS) {
            const resUp = await req('POST', '/api/crowdfund/projects/update', alice, {
                id: cfId,
                title: 'Crowdfund Ok',
                goalAmount: 100,
                photos: [url],
            });
            check('crowdfund-update-outside', resUp.status === 400 && errorOf(resUp) === AVATAR_FORMAT_ERROR, `crowdfund update refuses outside photos url ${url} → 400 (got ${resUp.status} ${JSON.stringify(resUp.body)})`);
        }
        const cfUpData = await req('POST', '/api/crowdfund/projects/update', alice, {
            id: cfId,
            title: 'Crowdfund Ok',
            goalAmount: 100,
            photos: [TINY_PNG],
        });
        check('crowdfund-update-data', cfUpData.status === 200, `crowdfund update accepts data: PNG → 200 (got ${cfUpData.status})`);
        const cfUpSelf = await req('POST', '/api/crowdfund/projects/update', alice, {
            id: cfId,
            title: 'Crowdfund Ok',
            goalAmount: 100,
            photos: [`/api/avatar/${alice.pk}`],
        });
        check('crowdfund-update-self', cfUpSelf.status === 200, `crowdfund update accepts own photo path → 200 (got ${cfUpSelf.status})`);
        const cfUpSelfAbs = await req('POST', '/api/crowdfund/projects/update', alice, {
            id: cfId,
            title: 'Crowdfund Ok',
            goalAmount: 100,
            photos: [`${BASE}/api/avatar/${alice.pk}`],
        });
        check('crowdfund-update-self-abs', cfUpSelfAbs.status === 200, `crowdfund update accepts absolute own photo URL → 200 (got ${cfUpSelfAbs.status})`);
    }

    // ── 5. POST /api/groups & PATCH /api/groups/:id ──
    for (const url of OUTSIDE_URLS) {
        const res = await req('POST', '/api/groups', alice, { name: 'Group Out', avatarUrl: url });
        check('groups-outside-avatar', res.status === 400 && errorOf(res) === AVATAR_FORMAT_ERROR, `groups create refuses outside avatar url ${url} → 400 (got ${res.status} ${JSON.stringify(res.body)})`);
    }
    const grpOk = await req('POST', '/api/groups', alice, { name: 'Group Ok', avatarUrl: TINY_PNG });
    const gid = grpOk.body?.id ?? grpOk.body?.group?.id;
    check('groups-data', grpOk.status === 201 && !!gid, `groups create accepts data: PNG → 201 (got ${grpOk.status})`);
    const grpBundled = await req('POST', '/api/groups', alice, { name: 'Group Bundled', avatarUrl: 'bundled://default' });
    check('groups-bundled', grpBundled.status === 201 && !!(grpBundled.body?.id ?? grpBundled.body?.group?.id), `groups create accepts bundled:// → 201 (got ${grpBundled.status})`);
    const grpSelf = await req('POST', '/api/groups', alice, { name: 'Group Self', avatarUrl: `/api/groups/grp1/picture` });
    check('groups-self', grpSelf.status === 201 && !!(grpSelf.body?.id ?? grpSelf.body?.group?.id), `groups create accepts own group picture path → 201 (got ${grpSelf.status})`);
    const grpSelfAbs = await req('POST', '/api/groups', alice, { name: 'Group Self Abs', avatarUrl: `${BASE}/api/groups/grp1/picture` });
    check('groups-self-abs', grpSelfAbs.status === 201 && !!(grpSelfAbs.body?.id ?? grpSelfAbs.body?.group?.id), `groups create accepts absolute own group picture URL → 201 (got ${grpSelfAbs.status})`);

    if (gid) {
        for (const url of OUTSIDE_URLS) {
            const resPatch = await req('PATCH', `/api/groups/${gid}`, alice, { avatarUrl: url });
            check('groups-patch-outside', resPatch.status === 400 && errorOf(resPatch) === AVATAR_FORMAT_ERROR, `groups patch refuses outside avatar url ${url} → 400 (got ${resPatch.status} ${JSON.stringify(resPatch.body)})`);
        }
        const patchData = await req('PATCH', `/api/groups/${gid}`, alice, { avatarUrl: TINY_PNG });
        check('groups-patch-data', patchData.status === 200, `groups patch accepts data: PNG → 200 (got ${patchData.status})`);
        const patchSelf = await req('PATCH', `/api/groups/${gid}`, alice, { avatarUrl: `/api/groups/${gid}/picture` });
        check('groups-patch-self', patchSelf.status === 200, `groups patch accepts own group picture path → 200 (got ${patchSelf.status})`);
        const patchSelfAbs = await req('PATCH', `/api/groups/${gid}`, alice, { avatarUrl: `${BASE}/api/groups/${gid}/picture` });
        check('groups-patch-self-abs', patchSelfAbs.status === 200, `groups patch accepts absolute own group picture URL → 200 (got ${patchSelfAbs.status})`);
    }

    // ── 6. POST /api/pricing-guide/admin/item ──
    for (const url of OUTSIDE_URLS) {
        const res = await req('POST', '/api/pricing-guide/admin/item', undefined, {
            category: 'produce',
            emoji: '🍎',
            name: 'Apple Out',
            priceBeans: 5,
            thumbnailUrl: url,
        }, adminHeaders);
        check('pricing-guide-outside', res.status === 400 && errorOf(res) === AVATAR_FORMAT_ERROR, `pricing guide item refuses outside thumbnail url ${url} → 400 (got ${res.status} ${JSON.stringify(res.body)})`);
    }
    const pgData = await req('POST', '/api/pricing-guide/admin/item', undefined, {
        category: 'produce',
        emoji: '🍎',
        name: 'Apple Data',
        priceBeans: 5,
        thumbnailUrl: TINY_PNG,
    }, adminHeaders);
    check('pricing-guide-data', pgData.status === 200, `pricing guide item accepts data: PNG → 200 (got ${pgData.status})`);
    const pgSelf = await req('POST', '/api/pricing-guide/admin/item', undefined, {
        category: 'produce',
        emoji: '🍎',
        name: 'Apple Self',
        priceBeans: 5,
        thumbnailUrl: '/api/marketplace/posts/fake1/photos/0',
    }, adminHeaders);
    check('pricing-guide-self', pgSelf.status === 200, `pricing guide item accepts own post photo path → 200 (got ${pgSelf.status})`);
    const pgSelfAbs = await req('POST', '/api/pricing-guide/admin/item', undefined, {
        category: 'produce',
        emoji: '🍎',
        name: 'Apple Self Abs',
        priceBeans: 5,
        thumbnailUrl: `${BASE}/api/marketplace/posts/fake1/photos/0`,
    }, adminHeaders);
    check('pricing-guide-self-abs', pgSelfAbs.status === 200, `pricing guide item accepts absolute own post photo path → 200 (got ${pgSelfAbs.status})`);

    // ── 7. POST /api/marketplace/posts & POST /api/marketplace/posts/update ──
    for (const url of OUTSIDE_URLS) {
        const res = await req('POST', '/api/marketplace/posts', alice, {
            type: 'offer',
            category: 'goods',
            title: 'Offer Out',
            description: 'desc',
            credits: 10,
            priceType: 'fixed',
            authorPublicKey: alice.pk,
            photos: [url],
        });
        check('posts-outside-photos', res.status === 400 && errorOf(res) === POST_PHOTO_FORMAT_ERROR, `marketplace post refuses outside photo url ${url} → 400 (got ${res.status} ${JSON.stringify(res.body)})`);
    }
    const postOk = await req('POST', '/api/marketplace/posts', alice, {
        type: 'offer',
        category: 'food',
        title: 'Offer Ok',
        description: 'desc',
        credits: 0,
        priceType: 'fixed',
        authorPublicKey: alice.pk,
        lat: -28.55,
        lng: 153.5,
        photos: [TINY_PNG],
    });
    const postId = postOk.body?.post?.id;
    if (postId) {
        for (const url of OUTSIDE_URLS) {
            const resUp = await req('POST', '/api/marketplace/posts/update', alice, {
                id: postId,
                authorPublicKey: alice.pk,
                photos: [url],
            });
            check('posts-update-outside', resUp.status === 400 && errorOf(resUp) === POST_PHOTO_FORMAT_ERROR, `post update refuses outside photo url ${url} → 400 (got ${resUp.status} ${JSON.stringify(resUp.body)})`);
        }
        // Update keeping its own photo URL
        const resOwn = await req('POST', '/api/marketplace/posts/update', alice, {
            id: postId,
            authorPublicKey: alice.pk,
            photos: [`/api/marketplace/posts/${postId}/photos/0`],
        });
        check('posts-update-own', resOwn.status === 200, `post update accepts its own photo path → 200 (got ${resOwn.status})`);
        const resOwnAbs = await req('POST', '/api/marketplace/posts/update', alice, {
            id: postId,
            authorPublicKey: alice.pk,
            photos: [`${BASE}/api/marketplace/posts/${postId}/photos/0`],
        });
        check('posts-update-own-abs', resOwnAbs.status === 200, `post update accepts absolute its own photo path → 200 (got ${resOwnAbs.status})`);
        // Update with new data: PNG
        const resNewData = await req('POST', '/api/marketplace/posts/update', alice, {
            id: postId,
            authorPublicKey: alice.pk,
            photos: [TINY_PNG],
        });
        check('posts-update-data', resNewData.status === 200, `post update accepts new data: PNG → 200 (got ${resNewData.status})`);
    }

    // ── 8. POST /api/join/knock ──
    const knocker = newId();
    for (const url of OUTSIDE_URLS) {
        const resKnock = await req('POST', '/api/join/knock', knocker, {
            callsign: 'Knocker1',
            message: 'Hello, please let me join.',
            avatar: url,
        });
        check('knock-outside', resKnock.status === 400 && errorOf(resKnock) === 'The picture must be a JPEG, PNG, WebP or GIF image.', `knock refuses outside avatar url ${url} → 400 (got ${resKnock.status} ${JSON.stringify(resKnock.body)})`);
    }
    const knockData = await req('POST', '/api/join/knock', knocker, {
        callsign: 'Knocker1',
        message: 'Hello, please let me join.',
        avatar: TINY_PNG,
    });
    check('knock-data', knockData.status === 201 && knockData.body?.knock?.status === 'pending', `knock accepts data: PNG → 201 (got ${knockData.status})`);

    const knocker2 = newId();
    const knockBundled = await req('POST', '/api/join/knock', knocker2, {
        callsign: 'Knocker2',
        message: 'Hello, please let me join.',
        avatar: 'bundled://default',
    });
    check('knock-bundled', knockBundled.status === 201 && knockBundled.body?.knock?.status === 'pending', `knock accepts bundled:// → 201 (got ${knockBundled.status})`);

    // ── 9. POST /api/treasury/:treasury/event (and offer/need) ──
    const treasuryPk = entData.body?.publicKey;
    if (treasuryPk) {
        for (const url of OUTSIDE_URLS) {
            const resEvent = await req('POST', `/api/treasury/${treasuryPk}/event`, alice, {
                title: 'Community Event Out',
                description: 'desc',
                photos: [url],
            });
            check('treasury-event-outside-photos', resEvent.status === 400 && errorOf(resEvent) === 'Each photo must be a JPEG, PNG or WebP image', `treasury event refuses outside photo url ${url} → 400 (got ${resEvent.status} ${JSON.stringify(resEvent.body)})`);
        }
        const evData = await req('POST', `/api/treasury/${treasuryPk}/event`, alice, {
            title: 'Community Event Data',
            description: 'desc',
            photos: [TINY_PNG],
            lat: -28.55,
            lng: 153.5,
            eventStartAt: new Date(Date.now() + 30 * 3600 * 1000).toISOString(),
            eventPlaceName: 'Community Garden',
        });
        check('treasury-event-data', evData.status === 200 && !!evData.body?.post?.id, `treasury event accepts data: PNG → 200 (got ${evData.status})`);

        // Offer & Need
        for (const url of OUTSIDE_URLS) {
            const resOffer = await req('POST', `/api/treasury/${treasuryPk}/offer`, alice, {
                title: 'Treasury Offer Out',
                category: 'goods',
                photos: [url],
            });
            check('treasury-offer-outside-photos', resOffer.status === 400 && errorOf(resOffer) === 'Each photo must be a JPEG, PNG or WebP image', `treasury offer refuses outside photo url ${url} → 400`);
        }
        const offerData = await req('POST', `/api/treasury/${treasuryPk}/offer`, alice, {
            title: 'Treasury Offer Data',
            category: 'goods',
            photos: [TINY_PNG],
        });
        check('treasury-offer-data', offerData.status === 200 && !!offerData.body?.post?.id, `treasury offer accepts data: PNG → 200 (got ${offerData.status})`);

        for (const url of OUTSIDE_URLS) {
            const resNeed = await req('POST', `/api/treasury/${treasuryPk}/need`, alice, {
                title: 'Treasury Need Out',
                category: 'supplies',
                photos: [url],
            });
            check('treasury-need-outside-photos', resNeed.status === 400 && errorOf(resNeed) === 'Each photo must be a JPEG, PNG or WebP image', `treasury need refuses outside photo url ${url} → 400`);
        }
        const needData = await req('POST', `/api/treasury/${treasuryPk}/need`, alice, {
            title: 'Treasury Need Data',
            category: 'supplies',
            photos: [TINY_PNG],
        });
        check('treasury-need-data', needData.status === 200 && !!needData.body?.post?.id, `treasury need accepts data: PNG → 200 (got ${needData.status})`);
    }

    console.log(`\n${passed}/${run} passed; failing: ${[...new Set(fails)].join(' ') || 'none'}`);
    process.exit(fails.length ? 1 : 0);
}

setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120_000).unref();
main().catch(e => { console.error('DRIVER ERROR', e); process.exit(3); });
