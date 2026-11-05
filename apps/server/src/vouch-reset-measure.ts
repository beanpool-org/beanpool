/**
 * The vouching reset's measure (R0, scratch/fable-design/DESIGN-invites-and-names-list-amend2-fable.md §1.1): run on each
 * node (mullum, castlemaine, Byron, global, test) BEFORE the release that resets vouching is deployed there, with the
 * node up. Read-only: it opens state.db read-only and writes nothing. It prints seven counts, numbers only, never a name
 * or a key, the same ones the boot reads first (db/vouch-reset.ts countVouchReset):
 *   A appointed vouchers · B vouched members · C vouched invites unused and in date · D vouched invites redeemed ·
 *   E people below zero (stored balance) · F people who would lose credit they are using · G open voucher Decisions.
 * F or G above zero: STOP, no deploy (exit code 2). Otherwise exit code 0.
 *
 * One line, from the director's machine (the release's image, pulled but not started, against the running node's data;
 * <user>@<host> and <tag> as deploy.sh names them, the folder deploy.sh's PROJECT_DIR):
 *   ssh <user>@<host> 'cd ~/BeanPool && sudo docker run --rm --entrypoint node -v "$PWD/data:/data" ghcr.io/beanpool-org/beanpool-node:<tag> apps/server/dist/vouch-reset-measure.js /data/state.db'
 * Locally, against a copy of a data dir: node --import tsx apps/server/src/vouch-reset-measure.ts <dir>/state.db
 *
 * It never imports db/db.ts, which opens the database read-write and runs the boot's migrations as it loads.
 */

import Database from 'better-sqlite3';
import { countVouchReset, countsLine, oldVouchColumns } from './db/vouch-reset.js';

function main(): number {
    const file = process.argv[2] || (process.env.BEANPOOL_DATA_DIR ? `${process.env.BEANPOOL_DATA_DIR}/state.db` : '/data/state.db');
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        const old = oldVouchColumns(db);
        const c = countVouchReset(db);
        console.log(`Vouching reset measure, ${new Date().toISOString()}`);
        if (old.members.length === 0 && !old.inviteLevel) console.log('This database is already reset: none of the four vouch columns is here.');
        console.log(`A members with the appointed-voucher switch on: ${c.appointedVouchers}`);
        console.log(`B members with a vouch: ${c.vouchedMembers}`);
        console.log(`C invites with a vouch, unused and in date: ${c.vouchedInvitesOpen}`);
        console.log(`D invites redeemed with a vouch: ${c.vouchedInvitesRedeemed}`);
        console.log(`E people whose stored balance is below zero: ${c.belowZero}`);
        console.log(`F people with a vouch below the line they keep without it: ${c.wouldLoseCredit}`);
        console.log(`G Decisions that could still give or take away vouching: ${c.openVoucherDecisions}`);
        console.log(countsLine(c));
        const stop = c.wouldLoseCredit > 0 || c.openVoucherDecisions > 0;
        console.log(stop ? 'STOP: F or G is above zero. Do not deploy the reset to this node.' : 'OK: F and G are 0. The reset can deploy to this node.');
        return stop ? 2 : 0;
    } finally {
        db.close();
    }
}

process.exit(main());
