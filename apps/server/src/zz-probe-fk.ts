import { initStateEngine } from './state-engine.js';
import { db, createCrowdfundProject, pledgeToProject, deleteCrowdfundProject } from './db/db.js';
import crypto from 'node:crypto';
initStateEngine();
console.log('PROBE foreign_keys =', db.pragma('foreign_keys', { simple: true }));
const C = 'c' + crypto.randomBytes(4).toString('hex'), B = 'b' + crypto.randomBytes(4).toString('hex');
for (const pk of [C, B]) {
    db.prepare("INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(pk, pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 1000, 0)').run(pk);
}
const P = 'p' + crypto.randomBytes(4).toString('hex');
createCrowdfundProject(P, C, 'T', 'd', [], 100000, null);
pledgeToProject(crypto.randomUUID(), P, B, 50, 'm');
console.log('PROBE refs to project =', db.prepare('SELECT COUNT(*) n FROM transactions WHERE project_id=?').get(P));
try { deleteCrowdfundProject(P, C); console.log('PROBE DELETE OK'); }
catch (e: any) { console.log('PROBE DELETE FAILED:', e.message); }
console.log('PROBE project rows left =', db.prepare('SELECT COUNT(*) n FROM projects WHERE id=?').get(P));
console.log('PROBE backer balance =', db.prepare('SELECT balance FROM accounts WHERE public_key=?').get(B));
console.log('PROBE fk_list(transactions) =', JSON.stringify(db.pragma('foreign_key_list(transactions)')));
