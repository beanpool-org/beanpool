/**
 * Close the doors (removal by vote, slice S3: scratch/fable-design/DESIGN-removal-by-vote-fable.md §2, §9 row S3, and
 * Amendment A point 1). Where the community votes, removing a member is its vote alone: an admin pauses, and the pause
 * opens the vote. Every door that removed someone without it is closed there, and each one that stays is shown working.
 *
 * Boots the real server; every request goes over HTTPS through the real signature middleware and real admin sessions: an
 * admin's key session, an owner's, and the password with a 2FA code.
 *
 *  1. Prune, votes on: an admin's key, the password and an owner's key are each refused 400 in words that say what to do
 *     instead (pause them; the community's vote decides), an owner's of another owner before any fresh proof is asked.
 *     Nothing changes: the member stays active and no Bean moves. The engine refuses underneath, whatever route reaches
 *     it (adminPruneUser by an admin, an owner, the password: a burst's removal included).
 *  2. Offboard, votes on: refused outside a removal the community voted for (400 in words; an owner's before any fresh
 *     proof is asked; the engine underneath in the same words), and its preview too, which then logs no look at the
 *     member's balance. Inside one's grace window (Hal, paused, the vote passed): the preview
 *     answers and names the removal, and the offboarding settles Hal's Beans exactly as chosen (a gift to Gil), completes
 *     the removal now as Accelerate does (the Decision executed, Hal removed) and moves nothing else. The owners are not
 *     told an admin removed someone: the community did.
 *  3. Proposing a removal: a member with standing and an admin are refused 400 in words, and nothing is written. Other
 *     Decisions about a member still open; a pause still opens the node's own removal vote.
 *  4. An open removal a member proposed before this version still ends: one passes, waits out its grace window and the
 *     member is removed at its end; one the community turns down just fails, the member untouched.
 *  5. What stays: the owner's prune branch (design §10 Q5, until slice S5), still the owner's alone; Accelerate on a passed
 *     removal; and the admin brake (Q12): a plain admin halts a passed removal and the member is back.
 *  6. The sweep: every admin route that removes or offboards someone, each with a fresh member of its own, on this node
 *     where the community votes: what each answers, and nothing changed where it refused.
 *  7. Votes off (the operator's switch, Q11): an admin removes directly, and offboards without a vote; the owners are told
 *     of each, as an admin's removal.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-removal-doors.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
}

function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

type Answer = { status: number; text: string; body: any };

async function answerOf(res: Response): Promise<Answer> {
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body };
}

/** A member's signed request. */
async function signed(method: 'GET' | 'POST', p: string, id: Id, payload?: unknown): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return answerOf(await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...signedHeaders(method, p, body, id) },
        ...(body ? { body } : {}),
    }));
}

/** An admin route under `session`'s headers (a key session, or the password with a 2FA code). */
async function admin(method: 'GET' | 'POST', p: string, session: Record<string, string>, payload?: unknown): Promise<Answer> {
    return answerOf(await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...session },
        ...(method === 'POST' ? { body: JSON.stringify(payload ?? {}) } : {}),
    }));
}

const ADMIN_PW = 'Removal-Doors-Admin-Pw-31!';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** What a refusal here says: removing someone is the community's vote, and to pause them instead. */
const SAYS_VOTE = /community.s vote/i;
const SAYS_PAUSE = /pause/i;

async function main() {
    console.log('Close the doors: where the community votes, only its vote removes a member...\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const de = await import('./decisions-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { db } = await import('./db/db.js');
    const { setSwitchOverride } = await import('./config/node-profile.js');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { ownerSessionHeaders, turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const { executeOffboard } = await import('./engine/member-wizards.js');
    const { setSecurityAlertHandler } = await import('./services/security-signal.js');
    const { wrapCreatePost } = await import('./post-test-helper.js');
    const createPost = wrapCreatePost(se.createPost);
    // An open removal a member proposed before this version (decisions-from-before-test-fixture.ts). Where the fixture is
    // not there (a run against the code before it), the proposal itself makes one.
    const fixture: any = await import('./decisions-from-before-test-fixture.js').catch(() => ({}));
    const proposedBefore = (opts: { authorPubkey: string; title: string; description: string; subject: string }) =>
        typeof fixture.removalProposedFromBefore === 'function'
            ? fixture.removalProposedFromBefore(opts)
            : de.createDecision({ ...opts, touches: 'member', effect: 'remove_member' });

    await initTls();
    se.initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    const twoFa = turnOn2faForTests(ADMIN_PW);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    // What the owners are told (services/security-signal.ts): an admin's removals are counted, the community's are not.
    const ownersTold: Array<{ key: string; actorRole?: string }> = [];
    setSecurityAlertHandler((note: any) => { ownersTold.push(note); });
    const adminRemovals = () => ownersTold.filter((n) => n.key === 'sec.members').length;

    // ── The people ──────────────────────────────────────────────────────────────────────────────────────────────────
    const gen = keypair('GenesisGwen');
    se.seedGenesisMember(gen.pubKeyHex, gen.callsign);
    const seedMember = (callsign: string, invitedBy = gen.pubKeyHex, beans = 50): Id => {
        const id = keypair(callsign);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(id.pubKeyHex, callsign, ago(30 * DAY), invitedBy, `INV-${callsign.toUpperCase()}`);
        setMemberPhoto(db, id.pubKeyHex, AVATAR);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pubKeyHex);
        if (beans > 0) se.transfer('genesis', id.pubKeyHex, beans, `seed ${callsign}`, 'direct', true);
        return id;
    };
    const otto = seedMember('OwnerOtto');       // a second owner
    grantNodeRole(otto.pubKeyHex, 'owner', gen.pubKeyHex);
    const ada = seedMember('AdminAda');         // a plain admin
    grantNodeRole(ada.pubKeyHex, 'admin', gen.pubKeyHex);
    const voters = ['VoterVi', 'VoterWu', 'VoterXo', 'VoterYa', 'VoterZed'].map(n => seedMember(n));
    const gil = seedMember('GiftGil');          // the member a removed member's Beans are given to
    const tia = seedMember('TraderTia');        // a member with standing: she has completed a trade

    const gwenSession = ownerSessionHeaders(gen.pubKeyHex);
    const adaSession = (() => {
        const { handshakeToken } = mintHandshakeToken(ada.pubKeyHex, 'admin');
        const s = consumeHandshakeToken(handshakeToken);
        if (!s.ok || !s.sessionId) throw new Error(`could not open Ada's key session: ${s.error}`);
        return { 'X-Admin-Session': s.sessionId };
    })();
    const password = () => twoFa.headers();

    const row = (id: Id): any => db.prepare('SELECT status, credit_frozen FROM members WHERE public_key = ?').get(id.pubKeyHex);
    const statusOf = (id: Id) => row(id)?.status as string | undefined;
    const accountsNow = () => JSON.stringify(db.prepare('SELECT public_key, balance FROM accounts ORDER BY public_key').all());
    const exactBalance = (id: Id) => (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(id.pubKeyHex) as { balance: number } | undefined)?.balance;
    const decision = (id: string): any => db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    const removalRows = () => (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE effect = 'remove_member'").get() as { n: number }).n;
    const looksAt = (id: Id) => (db.prepare('SELECT COUNT(*) AS n FROM health_access_log WHERE subject_pubkey = ?').get(id.pubKeyHex) as { n: number }).n;
    const fresh = () => { resetAdminAuthTarpit(); resetAdminRateLimit(); };
    /** Pause `who` through the route an admin uses, and return the vote it opens. */
    const pause = async (who: Id, reason = 'Took deposits for work never done, three times') => {
        fresh();
        const r = await admin('POST', `/api/local/admin/users/${who.pubKeyHex}/suspend`, adaSession, { reason });
        if (r.status !== 200) throw new Error(`could not pause ${who.callsign}: ${r.status} ${r.text}`);
        return r.body.decision as { id: string };
    };
    /** The community votes on Decision `id` (Yes, or No), it closes now, and the tick runs at the real time. */
    const voteAndClose = (id: string, yes: boolean) => {
        for (const v of voters) de.castDecisionVote(id, v.pubKeyHex, yes);
        db.prepare('UPDATE decisions SET closes_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
        de.tickDecisions();
    };
    /** Whatever an engine call throws, as its words and status; '' when it doesn't. */
    const refusalOf = (fn: () => unknown): { message: string; status?: number } => {
        try { fn(); return { message: '' }; } catch (e: any) { return { message: e?.message || String(e), status: e?.status }; }
    };

    // ── 1. Prune, where the community votes ──────────────────────────────────────────────────────────────────────────
    console.log('── 1. Prune ──');
    const pam = seedMember('PlainPam');
    const accountsBefore = accountsNow();
    for (const [who, session] of [['an admin', adaSession], ['the password', password()], ['an owner', gwenSession]] as const) {
        fresh();
        const r = await admin('POST', `/api/local/admin/users/${pam.pubKeyHex}/prune`, session, {});
        assert(r.status === 400 && r.body?.code === 'removal_is_the_vote' && SAYS_VOTE.test(r.body?.error ?? '') && SAYS_PAUSE.test(r.body?.error ?? ''),
            `${who} pruning Pam is refused 400, in words that say to pause her and let the community's vote decide (${r.status} ${r.text.slice(0, 200)})`);
    }
    assert(statusOf(pam) === 'active' && accountsNow() === accountsBefore, `Pam is still active and no Bean moved (${statusOf(pam)})`);
    fresh();
    const ownerOnOwner = await admin('POST', `/api/local/admin/users/${otto.pubKeyHex}/prune`, gwenSession, {});
    assert(ownerOnOwner.status === 400 && ownerOnOwner.body?.code === 'removal_is_the_vote',
        `an owner pruning another owner is refused the same way, before any fresh proof is asked (${ownerOnOwner.status} ${ownerOnOwner.text.slice(0, 160)})`);
    assert(statusOf(otto) === 'active', 'and Otto is still an owner, active');
    // The engine refuses underneath, whatever route reaches it.
    for (const [who, actor] of [['an admin', ada.pubKeyHex], ['the password', 'owner:password'], ['an owner', gen.pubKeyHex]] as const) {
        const refused = refusalOf(() => se.adminPruneUser(pam.pubKeyHex, actor));
        assert(refused.status === 400 && SAYS_VOTE.test(refused.message), `adminPruneUser by ${who} is refused in the engine too (${refused.status}: ${refused.message})`);
    }
    assert(statusOf(pam) === 'active' && accountsNow() === accountsBefore, 'still nothing changed');

    // ── 2. Offboard, outside and inside a removal the community voted for ────────────────────────────────────────────
    console.log('\n── 2. Offboard ──');
    const olly = seedMember('OffboardOlly');
    const accountsBeforeOlly = accountsNow();
    fresh();
    const ollyPreview = await admin('GET', `/api/local/admin/members/${olly.pubKeyHex}/offboard/preview`, adaSession);
    assert(ollyPreview.status === 400 && SAYS_VOTE.test(ollyPreview.body?.error ?? '') && ollyPreview.body?.balance === undefined,
        `the offboarding preview of Olly, whom no vote removes, is refused 400 in words and shows no balance (${ollyPreview.status} ${ollyPreview.text.slice(0, 200)})`);
    assert(looksAt(olly) === 0, `and no look at Olly's balance is logged (${looksAt(olly)})`);
    for (const [resolution, extra] of [['donate_to_commons', {}], ['gift_to_member', { giftRecipientPubkey: gil.pubKeyHex }]] as const) {
        fresh();
        const r = await admin('POST', `/api/local/admin/members/${olly.pubKeyHex}/offboard`, adaSession, { resolution, ...extra });
        assert(r.status === 400 && r.body?.code === 'removal_is_the_vote' && SAYS_VOTE.test(r.body?.error ?? ''),
            `offboarding Olly (${resolution}) is refused 400 in words (${r.status} ${r.text.slice(0, 200)})`);
    }
    assert(statusOf(olly) === 'active' && accountsNow() === accountsBeforeOlly, `Olly is still active and no Bean moved (${statusOf(olly)})`);
    fresh();
    const ottoOff = await admin('POST', `/api/local/admin/members/${otto.pubKeyHex}/offboard`, gwenSession, { resolution: 'donate_to_commons' });
    assert(ottoOff.status === 400 && ottoOff.body?.code === 'removal_is_the_vote' && statusOf(otto) === 'active',
        `offboarding an owner is refused the same way, before any fresh proof is asked (${ottoOff.status} ${ottoOff.text.slice(0, 160)})`);
    const engineOff = refusalOf(() => executeOffboard(olly.pubKeyHex, { resolution: 'donate_to_commons' }, ada.pubKeyHex));
    assert(engineOff.status === 400 && /^Offboarding settles a removal the community voted for/.test(engineOff.message) && statusOf(olly) === 'active',
        `the offboarding engine refuses underneath, in the same words (${engineOff.status}: ${engineOff.message.slice(0, 80)})`);

    const hal = seedMember('HalfwayHal', gen.pubKeyHex, 37.5);
    const halVote = await pause(hal);
    assert(decision(halVote.id)?.author_pubkey === 'SYSTEM' && decision(halVote.id)?.effect === 'remove_member' && statusOf(hal) === 'disabled',
        `Ada pauses Hal, and the node opens the community's vote on removing him (${decision(halVote.id)?.author_pubkey} ${decision(halVote.id)?.effect})`);
    voteAndClose(halVote.id, true);
    assert(decision(halVote.id)?.status === 'execution_pending_grace', `the community votes Yes: Hal's removal waits out its grace window (${decision(halVote.id)?.status})`);
    fresh();
    const halPreview = await admin('GET', `/api/local/admin/members/${hal.pubKeyHex}/offboard/preview`, adaSession);
    assert(halPreview.status === 200 && halPreview.body?.balance === 37.5 && halPreview.body?.settlesRemoval?.decisionId === halVote.id,
        `in it, the preview answers with his balance and names the removal it settles (${halPreview.status} ${JSON.stringify(halPreview.body?.settlesRemoval)})`);
    const gilBefore = exactBalance(gil)!, halBefore = exactBalance(hal)!, commonsBefore = se.getCommonsBalanceExact();
    const adminRemovalsBefore = adminRemovals();
    fresh();
    const halOff = await admin('POST', `/api/local/admin/members/${hal.pubKeyHex}/offboard`, adaSession, { resolution: 'gift_to_member', giftRecipientPubkey: gil.pubKeyHex });
    assert(halOff.status === 200 && statusOf(hal) === 'pruned', `Ada offboards Hal in his grace window, giving his Beans to Gil (${halOff.status} ${halOff.text.slice(0, 160)}; ${statusOf(hal)})`);
    assert(exactBalance(gil) === gilBefore + halBefore && exactBalance(hal) === 0 && se.getCommonsBalanceExact() === commonsBefore,
        `Gil gets exactly Hal's ${halBefore} Beans, Hal holds none, the Commons is unchanged (${exactBalance(gil)}, ${exactBalance(hal)}, ${se.getCommonsBalanceExact()})`);
    const halDone = decision(halVote.id);
    assert(halDone?.status === 'executed' && /offboard/i.test(halDone?.execution_reason ?? ''),
        `the removal is complete: its Decision is executed, as Accelerate leaves one, and says the offboarding settled it (${halDone?.status}: ${halDone?.execution_reason})`);
    assert(adminRemovals() === adminRemovalsBefore, `the owners are not told an admin removed a member: the community did (${adminRemovals() - adminRemovalsBefore} counted)`);
    de.tickDecisions(Date.now() + 8 * DAY);
    assert(decision(halVote.id)?.status === 'executed' && exactBalance(gil) === gilBefore + halBefore, 'a tick after the grace window\'s end changes nothing more');

    // ── 3. Proposing a removal ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. Proposing a removal ──');
    const roz = seedMember('ReportedRoz');
    {
        const tiaPost = createPost('offer', 'food', 'Tia\'s eggs', 'A dozen eggs, fresh', 5, 'fixed', tia.pubKeyHex)!.id;
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, completed_at)
                    VALUES (?, ?, ?, ?, 5, 'completed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(crypto.randomUUID(), tiaPost, gil.pubKeyHex, tia.pubKeyHex);
    }
    const before3 = removalRows();
    for (const [who, author] of [['Tia, a member who has completed a trade', tia], ['Ada, an admin', ada]] as const) {
        const r = await signed('POST', '/api/commons/decisions', author, {
            title: 'Remove ReportedRoz', description: 'She keeps taking deposits for work she never does', touches: 'member', effect: 'remove_member', subject: roz.pubKeyHex,
        });
        assert(r.status === 400 && SAYS_PAUSE.test(r.body?.error ?? '') && /report/i.test(r.body?.error ?? ''),
            `${who} proposing Roz's removal is refused 400, in words that say a pause opens it and to report her (${r.status} ${r.text.slice(0, 200)})`);
    }
    assert(removalRows() === before3 && statusOf(roz) === 'active', `nothing is written, and Roz is untouched (${removalRows() - before3} new)`);
    const engineRefusal = refusalOf(() => de.createDecision({
        authorPubkey: ada.pubKeyHex, title: 'Remove ReportedRoz', description: 'Proposed straight to the engine', touches: 'member', effect: 'remove_member', subject: roz.pubKeyHex,
    }));
    assert(SAYS_PAUSE.test(engineRefusal.message) && removalRows() === before3, `the engine refuses it underneath (${engineRefusal.message})`);
    const freeze = await signed('POST', '/api/commons/decisions', tia, {
        title: 'Freeze ReportedRoz\'s credit', description: 'Until the deposits are sorted out', touches: 'member', effect: 'freeze_credit', subject: roz.pubKeyHex,
    });
    assert(freeze.status === 200 && freeze.body?.decision?.effect === 'freeze_credit', `a member still proposes other Decisions about a member (${freeze.status} ${freeze.text.slice(0, 120)})`);
    const rozVote = await pause(roz, 'Reported by three members for deposits never returned');
    assert(decision(rozVote.id)?.author_pubkey === 'SYSTEM' && decision(rozVote.id)?.effect === 'remove_member' && JSON.parse(decision(rozVote.id)?.params ?? '{}').rule === 2,
        'and an admin\'s pause still opens the node\'s own vote on removing her');

    // ── 4. A removal a member proposed before this version ───────────────────────────────────────────────────────────
    console.log('\n── 4. An open removal from before ──');
    const ned = seedMember('NoShowNed'), noa = seedMember('NoaStays');
    const nedVote = proposedBefore({ authorPubkey: ada.pubKeyHex, title: 'Remove NoShowNed', description: 'Gone a year, owes the Commons', subject: ned.pubKeyHex });
    const noaVote = proposedBefore({ authorPubkey: gil.pubKeyHex, title: 'Remove NoaStays', description: 'A grudge, not a reason', subject: noa.pubKeyHex });
    assert(decision(nedVote.id)?.status === 'open' && decision(nedVote.id)?.author_pubkey === ada.pubKeyHex, 'an open removal Ada proposed before the upgrade is there');
    voteAndClose(nedVote.id, true);
    assert(decision(nedVote.id)?.status === 'execution_pending_grace' && statusOf(ned) === 'disabled' && row(ned)?.credit_frozen === 1,
        `it passes and waits out its grace window, Ned paused and his credit frozen (${decision(nedVote.id)?.status} ${statusOf(ned)})`);
    voteAndClose(noaVote.id, false);
    assert(decision(noaVote.id)?.status === 'failed' && statusOf(noa) === 'active', `the one the community turns down just fails, Noa untouched (${decision(noaVote.id)?.status} ${statusOf(noa)})`);
    // A tick a week ahead: Ned's grace window has ended (and every vote still open closes, Roz's pause vote with it).
    de.tickDecisions(Date.now() + 8 * DAY);
    assert(decision(nedVote.id)?.status === 'executed' && statusOf(ned) === 'pruned', `at its end the tick removes Ned (${decision(nedVote.id)?.status} ${statusOf(ned)})`);

    // ── 5. What stays ────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. What stays ──');
    const root = seedMember('BranchRoot'), leaf = seedMember('BranchLeaf');
    db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(root.pubKeyHex, leaf.pubKeyHex);
    fresh();
    const branchByAdmin = await admin('POST', `/api/local/admin/branches/${root.pubKeyHex}/prune`, adaSession, {});
    assert(branchByAdmin.status === 403 && statusOf(root) === 'active', `an admin can't prune a branch, as before (${branchByAdmin.status})`);
    fresh();
    const branchByOwner = await admin('POST', `/api/local/admin/branches/${root.pubKeyHex}/prune`, gwenSession, {});
    assert(branchByOwner.status === 200 && statusOf(root) === 'pruned' && statusOf(leaf) === 'pruned',
        `the owner's prune branch still removes a whole invite branch where the community votes, until the branch vote (${branchByOwner.status} ${branchByOwner.text.slice(0, 160)}; ${statusOf(root)}, ${statusOf(leaf)})`);
    const root2 = seedMember('BranchRootTwo');
    const branchEngine = refusalOf(() => se.adminPruneBranch(root2.pubKeyHex, ada.pubKeyHex));
    assert(branchEngine.status === 400 && SAYS_VOTE.test(branchEngine.message) && statusOf(root2) === 'active',
        `underneath, the branch is an owner's door only: an admin reaching adminPruneBranch is refused (${branchEngine.status}: ${branchEngine.message.slice(0, 60)})`);

    const ace = seedMember('AcceleratedAce');
    const aceVote = await pause(ace);
    voteAndClose(aceVote.id, true);
    fresh();
    const accel = await admin('POST', `/api/local/admin/decisions/${aceVote.id}/accelerate`, adaSession, {});
    assert(accel.status === 200 && statusOf(ace) === 'pruned' && decision(aceVote.id)?.status === 'executed',
        `Ada speeds up Ace's passed removal: the community's vote carries it out (${accel.status} ${accel.text.slice(0, 120)}; ${statusOf(ace)})`);

    const hank = seedMember('HaltedHank');
    const hankVote = await pause(hank);
    voteAndClose(hankVote.id, true);
    fresh();
    const halt = await admin('POST', `/api/local/admin/decisions/${hankVote.id}/halt`, adaSession, { reason: 'The deposits were refunded in full yesterday' });
    assert(halt.status === 200 && statusOf(hank) === 'active' && row(hank)?.credit_frozen === 0 && decision(hankVote.id)?.status === 'admin_halted',
        `a plain admin halts Hank's passed removal with a public reason, and he is back (${halt.status}; ${statusOf(hank)}, ${decision(hankVote.id)?.status})`);

    // ── 6. The sweep ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. The sweep: every admin route that removes or offboards someone ──');
    const openVote = await pause(seedMember('SweepPaused'));
    type Door = { route: string; method: 'GET' | 'POST'; session: () => Record<string, string>; body?: (pk: string) => unknown; status: number; path: (pk: string) => string };
    const doors: Door[] = [
        { route: 'prune, an admin', method: 'POST', path: pk => `/api/local/admin/users/${pk}/prune`, session: () => adaSession, status: 400 },
        { route: 'prune, the password', method: 'POST', path: pk => `/api/local/admin/users/${pk}/prune`, session: password, status: 400 },
        { route: 'prune, an owner', method: 'POST', path: pk => `/api/local/admin/users/${pk}/prune`, session: () => gwenSession, status: 400 },
        { route: 'offboard, donate', method: 'POST', path: pk => `/api/local/admin/members/${pk}/offboard`, session: () => adaSession, body: () => ({ resolution: 'donate_to_commons' }), status: 400 },
        { route: 'offboard, gift', method: 'POST', path: pk => `/api/local/admin/members/${pk}/offboard`, session: () => adaSession, body: () => ({ resolution: 'gift_to_member', giftRecipientPubkey: gil.pubKeyHex }), status: 400 },
        { route: 'offboard, write off, the password', method: 'POST', path: pk => `/api/local/admin/members/${pk}/offboard`, session: password, body: () => ({ resolution: 'write_off_commons' }), status: 400 },
        { route: 'offboard, nothing to settle, an owner', method: 'POST', path: pk => `/api/local/admin/members/${pk}/offboard`, session: () => gwenSession, body: () => ({ resolution: 'prune_zero_balance' }), status: 400 },
        { route: 'offboard preview', method: 'GET', path: pk => `/api/local/admin/members/${pk}/offboard/preview`, session: () => adaSession, status: 400 },
        { route: 'status pruned', method: 'POST', path: pk => `/api/local/admin/users/${pk}/status`, session: () => adaSession, body: () => ({ status: 'pruned' }), status: 400 },
        { route: 'prune branch, an admin', method: 'POST', path: pk => `/api/local/admin/branches/${pk}/prune`, session: () => adaSession, status: 403 },
        { route: 'burst removal (no open door here)', method: 'POST', path: pk => `/api/local/admin/members/${pk}/burst/remove`, session: () => gwenSession, body: pk => ({ members: [pk], count: 1 }), status: 404 },
        { route: 'accelerate an open vote', method: 'POST', path: () => `/api/local/admin/decisions/${openVote.id}/accelerate`, session: () => adaSession, status: 400 },
    ];
    for (const [i, door] of doors.entries()) {
        const target = seedMember(`SweepTarget${i}`);
        const snapshot = () => JSON.stringify([row(target), accountsNow(), removalRows(), looksAt(target), decision(openVote.id)?.status]);
        const before = snapshot();
        fresh();
        const r = await admin(door.method, door.path(target.pubKeyHex), door.session(), door.body?.(target.pubKeyHex));
        assert(r.status === door.status && snapshot() === before,
            `${door.route}: ${r.status} (expected ${door.status}), and nothing changed (${r.text.slice(0, 140)})`);
    }
    const proposal = seedMember('SweepProposal');
    const beforeProposal = removalRows();
    const proposed = await signed('POST', '/api/commons/decisions', ada, {
        title: 'Remove SweepProposal', description: 'A removal proposed outright', touches: 'member', effect: 'remove_member', subject: proposal.pubKeyHex,
    });
    assert(proposed.status === 400 && removalRows() === beforeProposal && statusOf(proposal) === 'active', `propose a removal: ${proposed.status}, and nothing written`);
    const paused = seedMember('SweepPause');
    const accountsBeforePause = accountsNow();
    const pauseVote = await pause(paused);
    assert(statusOf(paused) === 'disabled' && decision(pauseVote.id)?.status === 'open' && accountsNow() === accountsBeforePause,
        'pause: the door that stays, which opens the vote and moves no Bean');

    // ── 7. Votes off ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. Votes off (the operator\'s switch) ──');
    setSwitchOverride('decisions', false);
    const vera = seedMember('VotesOffVera'), vic = seedMember('VotesOffVic');
    const toldBeforeVera = adminRemovals();
    fresh();
    const veraPruned = await admin('POST', `/api/local/admin/users/${vera.pubKeyHex}/prune`, adaSession, {});
    assert(veraPruned.status === 200 && statusOf(vera) === 'pruned', `with community votes off, an admin removes Vera directly (${veraPruned.status} ${veraPruned.text.slice(0, 120)})`);
    assert(adminRemovals() === toldBeforeVera + 1, `and the owners are told an admin removed a member (${adminRemovals() - toldBeforeVera})`);
    fresh();
    const vicPreview = await admin('GET', `/api/local/admin/members/${vic.pubKeyHex}/offboard/preview`, adaSession);
    assert(vicPreview.status === 200 && vicPreview.body?.balance === 50 && !vicPreview.body?.settlesRemoval,
        `the offboarding preview answers with no removal to settle (${vicPreview.status} ${JSON.stringify(vicPreview.body?.settlesRemoval)})`);
    const commonsBeforeVic = se.getCommonsBalanceExact();
    fresh();
    const vicOff = await admin('POST', `/api/local/admin/members/${vic.pubKeyHex}/offboard`, adaSession, { resolution: 'donate_to_commons' });
    assert(vicOff.status === 200 && statusOf(vic) === 'pruned' && se.getCommonsBalanceExact() === commonsBeforeVic + 50,
        `and offboards Vic, his 50 Beans to the Commons (${vicOff.status} ${vicOff.text.slice(0, 120)}; ${statusOf(vic)})`);
    assert(adminRemovals() === toldBeforeVera + 2, `that is an admin's removal the owners are told of too (${adminRemovals() - toldBeforeVera})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        console.error(`❌ ${run - passed} check(s) failed`);
        process.exit(1);
    }
    console.log('⭐️ Where the community votes, only its vote removes a member; the doors that stay still open.');
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
