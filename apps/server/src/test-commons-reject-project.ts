/**
 * Integration test suite for POST /api/local/admin/commons/reject endpoint.
 *
 * Verifies:
 * 1. Admin rejection updates project status to 'rejected' in state engine.
 * 2. Rejected project is excluded from active projects list in GET /api/commons/projects.
 * 3. Requesting rejection without authentication returns 401.
 * 4. Requesting rejection without projectId returns 400.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-commons-reject-project.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestRejectAdmin123!';

import { initTls } from './services/tls.js';
import { initStateEngine, createProject, getAllProjects } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';

const PORT = 8557;
const BASE = `https://localhost:${PORT}`;
const PW = 'TestRejectAdmin123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function seedMember(pk: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, pk.slice(0, 8));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

async function main() {
    console.log('Running commons reject project endpoint integration tests...\n');
    initAdminPassword();

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const proposer = 'proposer-' + Date.now();
    seedMember(proposer);

    const project = createProject(proposer, 'Community Park Cleanup', 'Buying supplies for cleanup', 150);
    assert(project !== null, 'Project created successfully');
    const projectId = project!.id;

    // 1. Test rejection without admin authentication -> 401
    const unauthRes = await fetch(`${BASE}/api/local/admin/commons/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
    });
    assert(unauthRes.status === 401, `Unauthenticated request returns 401 (got ${unauthRes.status})`);

    // 2. Test rejection without projectId -> 400
    const missingIdRes = await fetch(`${BASE}/api/local/admin/commons/reject`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-admin-password': PW,
        },
        body: JSON.stringify({}),
    });
    assert(missingIdRes.status === 400, `Request without projectId returns 400 (got ${missingIdRes.status})`);

    // 3. Test rejection for non-existent project -> 404
    const nonExistentRes = await fetch(`${BASE}/api/local/admin/commons/reject`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-admin-password': PW,
        },
        body: JSON.stringify({ projectId: 'non-existent-project-id' }),
    });
    assert(nonExistentRes.status === 404, `Request for non-existent projectId returns 404 (got ${nonExistentRes.status})`);

    // 4. Test successful project rejection by admin
    const rejectRes = await fetch(`${BASE}/api/local/admin/commons/reject`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-admin-password': PW,
        },
        body: JSON.stringify({ projectId }),
    });
    assert(rejectRes.status === 200, `Authenticated rejection returns 200 (got ${rejectRes.status})`);
    const rejectBody = await rejectRes.json() as any;
    assert(rejectBody.success === true, 'Response indicates success: true');

    // Verify state engine reflects rejection
    const allProjects = getAllProjects();
    const rejectedProj = allProjects.find(p => p.id === projectId);
    assert(rejectedProj?.status === 'rejected', 'Project status in state engine is updated to "rejected"');

    // 5. Test public GET /api/commons/projects filters out rejected project
    const getRes = await fetch(`${BASE}/api/commons/projects`);
    assert(getRes.status === 200, `GET /api/commons/projects returns 200 (got ${getRes.status})`);
    const getBody = await getRes.json() as any;
    const foundInPublic = getBody.projects?.some((p: any) => p.id === projectId);
    assert(!foundInPublic, 'Rejected project is excluded from GET /api/commons/projects');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Commons reject project checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
