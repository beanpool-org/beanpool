/**
 * Integration test suite for POST /api/commons/projects/update and POST /api/commons/projects/delete endpoints.
 *
 * Verifies:
 * 1. POST /api/commons/projects/update allows project owners to update title, description, and requestedAmount.
 * 2. POST /api/commons/projects/update rejects updates by non-owners (400).
 * 3. POST /api/commons/projects/update validates required fields (400 on missing title, projectId, etc.).
 * 4. POST /api/commons/projects/delete allows project owners to delete proposed projects.
 * 5. POST /api/commons/projects/delete rejects deletion by non-owners (400).
 * 6. POST /api/commons/projects/delete validates required fields (400 on missing projectId).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-commons-projects-update-delete.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createProject, getAllProjects } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db, getCrowdfundProjects, getCrowdfundProject } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';

let PORT = 0; // the port startHttpsServer(0) bound
let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function makeMember(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pubKeyHex, callsign);
    setMemberPhoto(db, pubKeyHex, 'data:image/png;base64,iVBORw0KGgo=');
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

function makeStranger() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { pubKeyHex, privateKey };
}

async function signedFetch(method: 'GET' | 'POST', path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const signPath = path.split('?')[0];
    const canonical = `${method}\n${signPath}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

async function main() {
    console.log('Running commons projects update and delete integration tests...\n');

    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    const proposer = makeMember('proposer');
    const attacker = makeMember('attacker');

    // Create a commons project
    const project = createProject(proposer.pubKeyHex, 'Library Renovation', 'Funding books and seats', 500);
    assert(project !== null, 'Project created successfully');
    const projectId = project!.id;

    // 0a. Non-member is refused access to /api/treasuries and /api/enterprises (401 unauthenticated, 403 signed non-member)
    const unauthTreasuriesRes = await fetch(`${BASE}/api/treasuries`);
    assert(unauthTreasuriesRes.status === 401, `Unauthenticated request refused from /api/treasuries (got ${unauthTreasuriesRes.status})`);
    const unauthEnterprisesRes = await fetch(`${BASE}/api/enterprises`);
    assert(unauthEnterprisesRes.status === 401, `Unauthenticated request refused from /api/enterprises (got ${unauthEnterprisesRes.status})`);

    const stranger = makeStranger();
    const strangerTreasuriesRes = await signedFetch('GET', '/api/treasuries', stranger);
    assert(strangerTreasuriesRes.status === 403, `Non-member stranger refused from /api/treasuries (got ${strangerTreasuriesRes.status})`);
    const strangerEnterprisesRes = await signedFetch('GET', '/api/enterprises', stranger);
    assert(strangerEnterprisesRes.status === 403, `Non-member stranger refused from /api/enterprises (got ${strangerEnterprisesRes.status})`);

    // 0b. Another member sees live project in /api/treasuries and /api/enterprises by default
    const memberTreasuriesRes = (await signedFetch('GET', '/api/treasuries', attacker)).body;
    const projectInTreasuries = memberTreasuriesRes?.treasuries?.find((t: any) => t.publicKey === projectId);
    assert(!!projectInTreasuries, 'Another member sees live project in /api/treasuries');
    assert(projectInTreasuries?.lifecycle === 'bounded', 'Project has lifecycle bounded in /api/treasuries');
    assert(projectInTreasuries?.goalAmount === 500, 'Project has goalAmount 500 in /api/treasuries');

    const memberEnterprisesRes = (await signedFetch('GET', '/api/enterprises', attacker)).body;
    const projectInEnterprises = memberEnterprisesRes?.treasuries?.find((t: any) => t.publicKey === projectId);
    assert(!!projectInEnterprises, 'Another member sees live project in /api/enterprises');

    // 0c. Suspended project shows only to its keepers, not other members
    const suspProj = createProject(proposer.pubKeyHex, 'Suspended Project', 'Temporarily suspended', 200);
    assert(suspProj !== null, 'Suspended project created');
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(suspProj!.id);

    const attackerSuspCheck = (await signedFetch('GET', '/api/treasuries', attacker)).body;
    assert(!attackerSuspCheck?.treasuries?.some((t: any) => t.publicKey === suspProj!.id), 'Other member does not see suspended project in /api/treasuries');
    const attackerSuspCheckEnt = (await signedFetch('GET', '/api/enterprises', attacker)).body;
    assert(!attackerSuspCheckEnt?.treasuries?.some((t: any) => t.publicKey === suspProj!.id), 'Other member does not see suspended project in /api/enterprises');

    const keeperSuspCheck = (await signedFetch('GET', '/api/treasuries', proposer)).body;
    assert(keeperSuspCheck?.treasuries?.some((t: any) => t.publicKey === suspProj!.id), 'Keeper sees their own suspended project in /api/treasuries');
    const keeperSuspCheckEnt = (await signedFetch('GET', '/api/enterprises', proposer)).body;
    assert(keeperSuspCheckEnt?.treasuries?.some((t: any) => t.publicKey === suspProj!.id), 'Keeper sees their own suspended project in /api/enterprises');

    // 0d. Pruned project stays absent for everyone
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(suspProj!.id);
    const attackerPrunedCheck = (await signedFetch('GET', '/api/treasuries', attacker)).body;
    assert(!attackerPrunedCheck?.treasuries?.some((t: any) => t.publicKey === suspProj!.id), 'Other member does not see pruned project in /api/treasuries');
    const keeperPrunedCheck = (await signedFetch('GET', '/api/treasuries', proposer)).body;
    assert(!keeperPrunedCheck?.treasuries?.some((t: any) => t.publicKey === suspProj!.id), 'Keeper does not see pruned project in /api/treasuries');

    // 1. Test POST /api/commons/projects/update: Rejects non-owner update
    const nonOwnerUpdateRes = await signedFetch('POST', '/api/commons/projects/update', attacker, {
        proposerPubkey: attacker.pubKeyHex,
        projectId,
        title: 'Hacked Title',
        description: 'Hacked Description',
        requestedAmount: 1000,
    });
    assert(nonOwnerUpdateRes.status === 400, `Non-owner update returns 400 (got ${nonOwnerUpdateRes.status})`);

    // 2. Test POST /api/commons/projects/update: Rejects missing fields
    const missingFieldsUpdateRes = await signedFetch('POST', '/api/commons/projects/update', proposer, {
        proposerPubkey: proposer.pubKeyHex,
        projectId,
        // missing title and requestedAmount
    });
    assert(missingFieldsUpdateRes.status === 400, `Missing fields update returns 400 (got ${missingFieldsUpdateRes.status})`);

    // 3. Test POST /api/commons/projects/update: Owner successfully updates project
    const ownerUpdateRes = await signedFetch('POST', '/api/commons/projects/update', proposer, {
        proposerPubkey: proposer.pubKeyHex,
        projectId,
        title: 'Library & Media Center Renovation',
        description: 'Updated funding for books, seats and digital displays',
        requestedAmount: 600,
    });
    assert(ownerUpdateRes.status === 200, `Owner update returns 200 (got ${ownerUpdateRes.status})`);
    assert(ownerUpdateRes.body?.success === true, 'Update response indicates success: true');

    // Verify state engine reflects updated values
    const allProjectsAfterUpdate = getAllProjects();
    const updatedProj = allProjectsAfterUpdate.find(p => p.id === projectId);
    assert(updatedProj?.title === 'Library & Media Center Renovation', 'Project title updated in state engine');
    assert(updatedProj?.requestedAmount === 600, 'Project requestedAmount updated in state engine');

    // 4. Test POST /api/commons/projects/delete: Rejects non-owner delete
    const nonOwnerDeleteRes = await signedFetch('POST', '/api/commons/projects/delete', attacker, {
        proposerPubkey: attacker.pubKeyHex,
        projectId,
    });
    assert(nonOwnerDeleteRes.status === 400, `Non-owner delete returns 400 (got ${nonOwnerDeleteRes.status})`);

    // 5. Test POST /api/commons/projects/delete: Rejects missing projectId
    const missingIdDeleteRes = await signedFetch('POST', '/api/commons/projects/delete', proposer, {
        proposerPubkey: proposer.pubKeyHex,
    });
    assert(missingIdDeleteRes.status === 400, `Missing projectId delete returns 400 (got ${missingIdDeleteRes.status})`);

    // 6. Test POST /api/commons/projects/delete: Owner successfully deletes project
    const ownerDeleteRes = await signedFetch('POST', '/api/commons/projects/delete', proposer, {
        proposerPubkey: proposer.pubKeyHex,
        projectId,
    });
    assert(ownerDeleteRes.status === 200, `Owner delete returns 200 (got ${ownerDeleteRes.status})`);
    assert(ownerDeleteRes.body?.success === true, 'Delete response indicates success: true');

    // Verify state engine reflects deletion
    const allProjectsAfterDelete = getAllProjects();
    const deletedProj = allProjectsAfterDelete.find(p => p.id === projectId);
    assert(!deletedProj, 'Project is no longer present or active in state engine after deletion');

    // Verify crowdfund db functions and API do not resurrect pruned/deleted projects (Pass 3 fix)
    const cfProjectsAfterDelete = getCrowdfundProjects();
    assert(!cfProjectsAfterDelete.some(p => p.id === projectId), 'Deleted project is not returned by getCrowdfundProjects()');

    const cfProjAfterDelete = getCrowdfundProject(projectId);
    assert(cfProjAfterDelete === undefined, 'Deleted project returns undefined from getCrowdfundProject(id)');

    // Read by a member (another than its proposer): the crowdfunds and the enterprises are members' reads (2026-10-01).
    const cfGetRes = await signedFetch('GET', `/api/crowdfund/projects/${projectId}`, attacker);
    assert(cfGetRes.status === 404, `GET /api/crowdfund/projects/:id returns 404 after deletion (got ${cfGetRes.status})`);

    // Verify /api/treasuries and /api/enterprises exclude deleted project for everyone
    const treasuriesRes = (await signedFetch('GET', '/api/treasuries', attacker)).body;
    assert(!treasuriesRes.treasuries.some((t: any) => t.publicKey === projectId), 'Deleted project is not in /api/treasuries');
    const enterprisesRes = (await signedFetch('GET', '/api/enterprises', attacker)).body;
    assert(!enterprisesRes.treasuries.some((t: any) => t.publicKey === projectId), 'Deleted project is not in /api/enterprises');
    const keeperTreasuriesRes = (await signedFetch('GET', '/api/treasuries', proposer)).body;
    assert(!keeperTreasuriesRes.treasuries.some((t: any) => t.publicKey === projectId), 'Keeper does not see deleted project in /api/treasuries');

    // 7. Test POST /api/commons/projects/delete: Deleting non-existent/already deleted project returns 404
    const repeatDeleteRes = await signedFetch('POST', '/api/commons/projects/delete', proposer, {
        proposerPubkey: proposer.pubKeyHex,
        projectId,
    });
    assert(repeatDeleteRes.status === 404, `Deleting non-existent project returns 404 (got ${repeatDeleteRes.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Commons projects update and delete checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
