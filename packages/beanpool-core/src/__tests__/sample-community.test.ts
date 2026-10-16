import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    SAMPLE_COMMUNITY, SAMPLE_ID_PREFIX, isSampleId, sampleEnterpriseCards, sampleEnterpriseDetail, sampleEnterpriseLedger, sampleRowNote,
    type SampleDecision,
} from '../sample-community.js';
import { PER_COUNTERPARTY_VOLUME_CAP, PROTOCOL_CONSTANTS, TIER_LEVELS, earnedCreditFromValue, memberLevel, tierIndexForCredit } from '../protocol.js';
import { monthlyCirculation } from '../circulation.js';
import { parseInviteTicketText } from '../request-signing.js';
import {
    LOCAL_COMMUNITY_LINES, LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_STRIP, SHOWCASE_FEATURES, featureMode, featureModeFor,
    readsOwnData,
} from '../features.js';

/** Every [path, value] in a value, depth first. */
function walk(value: unknown, path = '$'): [string, unknown][] {
    if (value && typeof value === 'object') {
        return [[path, value], ...Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => walk(v, `${path}.${k}`))];
    }
    return [[path, value]];
}
const strings = (value: unknown) => walk(value).filter(([, v]) => typeof v === 'string') as [string, string][];

describe('the sample community (design §2): Example Valley, frozen', () => {
    it('is frozen all the way down', () => {
        const objects = walk(SAMPLE_COMMUNITY).filter(([, v]) => v && typeof v === 'object');
        expect(objects.length).toBeGreaterThan(10);
        for (const [path, v] of objects) expect(Object.isFrozen(v), path).toBe(true);
        expect(() => { (SAMPLE_COMMUNITY as any).balance = 1_000_000; }).toThrow();
        expect(() => { (SAMPLE_COMMUNITY.transactions as any).push({}); }).toThrow();
        expect(SAMPLE_COMMUNITY.balance).toBe(85);
    });

    it('holds the design\'s numbers: 85 Beans, room 285 down to −200, level 2 of 4, six rows, three deals, pool 640', () => {
        const s = SAMPLE_COMMUNITY;
        expect(s.name).toBe('Example Valley');
        expect([s.balance, s.floor, s.roomToSpend, s.liveOffers, s.level, s.levels, s.pool]).toEqual([85, -200, 285, 1, 2, 4, 640]);
        expect(s.roomToSpend).toBe(s.balance - s.floor);
        expect(s.transactions.map(t => t.amount)).toEqual([12, -20, -40, 30, 5, -18]);
        expect(s.deals.map(d => d.status).sort()).toEqual(['done', 'held', 'waiting-on-you']);
        expect(s.enterprises).toHaveLength(1);
        expect(s.enterprises[0]).toMatchObject({ name: 'Example Valley Bakery', keepers: 3, season: 120 });
        expect(s.decisions[0]).toMatchObject({ fromPool: 40, closesInDays: 3, totalVoters: 9, yesWeight: 12, noWeight: 2 });
    });

    it('its Levels card adds up with the tiers the screens use: 200 trust is level 2 of 4, earned from the value traded', () => {
        const s = SAMPLE_COMMUNITY;
        expect([s.trust, s.valueTraded, s.partners, s.rating, s.reviews]).toEqual([200, 582, 5, 4.8, 5]);
        // The trust backs the floor, and the tiers read it as level 2 of 4 (what memberLevel gives a screen).
        expect(s.trust).toBe(PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR - s.floor);
        expect(TIER_LEVELS).toHaveLength(s.levels);
        expect(tierIndexForCredit(s.trust)).toBe(s.level - 1);
        expect(memberLevel({ floor: s.floor, tierCredit: s.trust })).toEqual({ index: s.level - 1, credit: s.trust });
        expect(s.trust).toBeLessThan(TIER_LEVELS[s.level].minCredit);
        // All of it earned by trading: the curve gives exactly the trust for the value traded, and one Bean less falls short.
        expect(earnedCreditFromValue(s.valueTraded)).toBe(s.trust);
        expect(earnedCreditFromValue(s.valueTraded - 1)).toBeLessThan(s.trust);
        // Value with any one partner counts up to the cap, so that much value needs at least this many partners.
        expect(s.partners).toBeGreaterThanOrEqual(Math.ceil(s.valueTraded / PER_COUNTERPARTY_VOLUME_CAP));
        expect(s.rating).toBeGreaterThan(0);
        expect(s.rating).toBeLessThanOrEqual(5);
        expect(Number.isInteger(s.reviews) && s.reviews > 0).toBe(true);
    });

    it('every id is a sample id, and every sample id is unique', () => {
        const ids = walk(SAMPLE_COMMUNITY).filter(([p]) => /\.id$/.test(p)).map(([, v]) => v);
        // The community, 6 rows, 3 deals, the enterprise, its listing, the project, the Decision, 3 invites, the invite
        // tree's 3, and the P&L rows (the Bakery's 2, the project's 1: review of #2063, N5).
        expect(ids.length).toBe(1 + 6 + 3 + 1 + 1 + 1 + 1 + 3 + 3 + 2 + 1);
        for (const id of ids) {
            expect(typeof id === 'string' && id.startsWith(SAMPLE_ID_PREFIX), String(id)).toBe(true);
            expect(isSampleId(id), String(id)).toBe(true);
        }
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('has no @, no URL, no key and no real-looking name anywhere', () => {
        const all = strings(SAMPLE_COMMUNITY);
        expect(all.length).toBeGreaterThan(20);
        for (const [path, v] of all) {
            expect(v, path).not.toMatch(/@/);
            expect(v, path).not.toMatch(/https?:|www\.|:\/\/|\.(com|org|net|au|io|nz|uk)\b/i);
            expect(v, path).not.toMatch(/[0-9a-f]{32,}/i);
            expect(v, path).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
        }
        // Who a row is with, whose ledger it is, and who is in the invite tree: never a person's name.
        const PEOPLE = new Set(['a neighbour', 'the Commons', 'the Example Valley Bakery', 'an example member']);
        for (const [path, v] of all.filter(([p]) => /\.who$/.test(p))) expect(PEOPLE.has(v), `${path}: ${v}`).toBe(true);
        expect(SAMPLE_COMMUNITY.member).toBe('an example member');
        // No capitalised word but the sentence's first and the sample's own, so nothing reads as a person or a place.
        const ALLOWED = new Set(['Example', 'Valley', 'Bakery', 'Commons', 'Beans']);
        for (const [path, v] of all.filter(([p]) => !/\.id$/.test(p))) {
            const words = v.split(/\s+/).slice(1).filter(w => /^[A-Z]/.test(w));
            for (const w of words) expect(ALLOWED.has(w.replace(/[^A-Za-z]/g, '')), `${path}: "${w}" in "${v}"`).toBe(true);
        }
    });
});

describe('the sample agrees with itself and with the real screens\' rules (global-previews audit, fix 10; PHONE §3 item 4)', () => {
    const s = SAMPLE_COMMUNITY;

    it('no circulation fee row: a member at 85 Beans never pays one', () => {
        expect(monthlyCirculation(s.balance)).toBe(0);
        for (const t of s.transactions) expect((t as { kind: string }).kind, t.id).not.toBe('fee');
        expect(s.transactions.some(t => /fee/i.test(t.what))).toBe(false);
        expect(s.transactions).toHaveLength(6);
    });

    it('deals and ledger agree: the done deal the member sold is the Ledger\'s +30 row; one waits on them (requested); one holds their Beans', () => {
        const byStatus = Object.fromEntries(s.deals.map(d => [d.status, d]));
        expect(byStatus['waiting-on-you']).toMatchObject({ state: 'requested', side: 'bought' });
        expect(byStatus.held).toMatchObject({ state: 'pending', side: 'bought' });
        expect(byStatus.done).toMatchObject({ state: 'completed', side: 'sold' });
        const row = s.transactions.find(t => t.what === byStatus.done.what)!;
        expect(row).toBeDefined();
        expect(row.amount).toBe(byStatus.done.amount);
        expect(row.kind).toBe('deal');
        expect(row.daysAgo).toBe(byStatus.done.daysAgo);
        // In Escrow is what the held deal holds, and only that: a requested deal holds nothing yet.
        expect(s.inEscrow).toBe(byStatus.held.amount);
        expect(s.inEscrow).toBe(s.deals.filter(d => d.state === 'pending' && d.side === 'bought').reduce((n, d) => n + d.amount, 0));
        // And the hold is a row, as on a node (escrow.ts moves the Beans out to trust on approval): "Held in trust ·
        // Fixing a bike puncture −20 · yesterday". Only a held deal has one; the requested deal has moved nothing.
        const holds = s.transactions.filter(t => t.kind === 'hold');
        expect(holds).toHaveLength(1);
        expect(holds[0]).toMatchObject({ what: byStatus.held.what, amount: -byStatus.held.amount, daysAgo: byStatus.held.daysAgo });
        expect(sampleRowNote(holds[0])).toBe('Held in trust · Fixing a bike puncture');
        expect(holds[0].daysAgo).toBe(1);
        expect(s.transactions.some(t => t.what === byStatus['waiting-on-you'].what)).toBe(false);
        expect(-holds.reduce((n, t) => n + t.amount, 0)).toBe(s.inEscrow);
        for (const t of s.transactions.filter(x => x.kind !== 'hold')) expect(sampleRowNote(t)).toBe(t.what);
        // Newest first.
        const ages = s.transactions.map(t => t.daysAgo);
        expect(ages).toEqual([...ages].sort((a, b) => a - b));
    });

    it('the Decision is a pool grant, so quadratic as the node makes it: turnout in voters, the tally in weights, and they add up', () => {
        const d = s.decisions[0];
        // franchiseForTouch('pool') === 'quadratic_trade' (apps/server decisions-engine; the server's test-sample-id-guard
        // checks this pair through it). The type pins it too: a pool grant can't be one member, one vote.
        expect(d).toMatchObject({ touches: 'pool', effect: 'grant_enterprise', franchise: 'quadratic_trade', closesInDays: 3 });
        // @ts-expect-error a Decision that touches the pool is never one member, one vote
        const oneMemberOneVote: SampleDecision['franchise'] = '1m1v';
        expect(oneMemberOneVote).not.toBe(d.franchise);
        // Each vote as the node casts it on a quadratic Decision: N votes weigh N and cost N² voice credits.
        for (const v of d.votes) {
            expect(Number.isInteger(v.weight) && v.weight >= 1, JSON.stringify(v)).toBe(true);
            expect(v.creditsUsed, JSON.stringify(v)).toBe(v.weight ** 2);
        }
        // Turnout, in voters (tallyDecision: votes.length against getQuorumRequired, at least 3): 9 of 6 needed, Met.
        expect(d.totalVoters).toBe(d.votes.length);
        expect(d.quorumRequired).toBe(Math.max(3, Math.ceil(d.quorumRatio * d.electorate)));
        expect(d.quorumMet).toBe(d.totalVoters >= d.quorumRequired);
        expect([d.totalVoters, d.quorumRequired, d.quorumMet]).toEqual([9, 6, true]);
        // The example member is on the roll and hasn't voted (Vote is theirs), so fewer voters than the electorate.
        expect(d.totalVoters).toBeLessThan(d.electorate);
        // The tally, in weights: Yes 12 (86%) · No 2 · needs 60%. Weights, not voters: some voters cast more than one.
        const weightOf = (support: 0 | 1) => d.votes.filter(v => v.support === support).reduce((n, v) => n + v.weight, 0);
        expect([d.yesWeight, d.noWeight]).toEqual([weightOf(1), weightOf(0)]);
        expect([d.yesWeight, d.noWeight]).toEqual([12, 2]);
        expect(d.yesWeight + d.noWeight).toBeGreaterThan(d.totalVoters);
        const support = d.yesWeight / (d.yesWeight + d.noWeight);
        expect(d.thresholdRequired).toBe(0.6);
        expect(Math.round(support * 100)).toBe(86);
        expect(support).toBeGreaterThanOrEqual(d.thresholdRequired);
        // Ties fail; so it passes as it stands (tallyDecision's rule).
        expect(d.passed).toBe(d.quorumMet && support >= d.thresholdRequired && d.yesWeight > d.noWeight);
        expect(d.passed).toBe(true);
        // What the example member could spend on it: 582 voice credits, so at most 24 votes (24² = 576 ≤ 582 < 625).
        const most = Math.floor(Math.sqrt(s.voiceCredits));
        expect(most).toBe(24);
        expect(most ** 2).toBeLessThanOrEqual(s.voiceCredits);
        expect((most + 1) ** 2).toBeGreaterThan(s.voiceCredits);
        // The grant goes to the sample project, from the pool, and is what the project still needs.
        const p = s.projects.find(x => x.id === d.subject)!;
        expect(p).toBeDefined();
        expect(d.fromPool).toBeLessThanOrEqual(s.pool);
        expect(p.pledged + d.fromPool).toBe(p.goal);
    });

    it('voice credits are the value traded, as the node counts them', () => {
        expect(s.voiceCredits).toBe(s.valueTraded);
        expect(Math.floor(Math.sqrt(s.voiceCredits))).toBe(24);
    });

    it('the enterprise: credit line, live offers, surplus, ceiling, P&L, a listing, and a lifecycle with pause and wind-up', () => {
        const e = s.enterprises[0];
        expect(e.pnl).toEqual({ days: 30, cameIn: 180, wentOut: 60, net: 120, rows: e.pnl.rows });
        expect(e.pnl.rows.map(r => [r.what, r.amount, r.daysAgo])).toEqual([['Sourdough orders', 180, 3], ['Organic flour and seeds', -60, 10]]);
        expect(e.pnl.net).toBe(e.pnl.cameIn - e.pnl.wentOut);
        expect(e.season).toBe(e.pnl.net);
        expect(e.liveOffers).toBe(e.listings.length);
        expect(e.listings[0]).toMatchObject({ type: 'offer', price: 12 });
        expect(e.earnedSurplus).toBeLessThanOrEqual(e.balance);
        expect(e.balance).toBeLessThanOrEqual(e.capitalCeiling);
        expect(e.creditLine).toBeGreaterThan(0);
        expect(e.lifecycle).toEqual({ status: 'active', mayPause: true, mayWindUp: true });
        expect(e.keepers).toBe(3);
    });

    it('one crowdfund project for the Projects chip: a goal, what is pledged, days to go', () => {
        expect(s.projects).toHaveLength(1);
        const p = s.projects[0];
        expect(p.pledged).toBeLessThan(p.goal);
        expect(p.daysToGo).toBeGreaterThan(0);
        expect(p.backers).toBeGreaterThan(0);
    });

    it('invites: one waiting, and the one each of the two members under "an example member" joined by', () => {
        expect(s.invites.map(i => i.status)).toEqual(['pending', 'used', 'used']);
        const tree = s.inviteTree;
        expect(tree.who).toBe(s.member);
        expect(tree.invited).toHaveLength(2);
        for (const m of tree.invited) expect(m.invited).toEqual([]);
        // Each member in the tree joined by exactly one of the member's invites, on the day they joined, within the
        // 30 days an invite lasts, and after the member themself joined.
        const used = s.invites.filter(i => i.status === 'used');
        expect(used.map(i => i.usedBy).sort()).toEqual(tree.invited.map(m => m.id).sort());
        for (const m of tree.invited) {
            const by = used.find(i => i.usedBy === m.id)!;
            expect(by, m.id).toBeDefined();
            expect(by.usedDaysAgo, m.id).toBe(m.joinedDaysAgo);
            expect(by.usedDaysAgo!, m.id).toBeLessThanOrEqual(by.daysAgo);
            expect(by.daysAgo - by.usedDaysAgo!, m.id).toBeLessThan(30);
            expect(by.daysAgo, m.id).toBeLessThan(tree.joinedDaysAgo);
        }
        // A waiting invite has no one who used it, and is still good.
        const waiting = s.invites.find(i => i.status === 'pending')!;
        expect(waiting.usedBy).toBeUndefined();
        expect(waiting.daysAgo).toBeLessThan(30);
        // Newest first.
        const ages = s.invites.map(i => i.daysAgo);
        expect(ages).toEqual([...ages].sort((a, b) => a - b));
        // Every reference to another sample object is a sample id too.
        for (const v of [...used.map(i => i.usedBy), s.decisions[0].subject]) expect(isSampleId(v), String(v)).toBe(true);
    });

    it('an example invite code is obviously not a code: no node mints or reads its shape, and it names no address', () => {
        const codes = s.invites.map(i => i.code);
        expect(new Set(codes).size).toBe(codes.length);
        for (const code of codes) {
            expect(code).toMatch(/^EXAMPLE-\d{4}$/);
            // Not the node's code (@beanpool/engine generateShortCode: INV- and two groups of 4 from an alphabet with
            // no 0, 1, I or O), not an offline ticket (BP-), and not a ticket's signed text.
            expect(code).not.toMatch(/^(INV|BP)-/i);
            expect(code).not.toMatch(/(?:INV|BP)-[A-Z0-9]{4}-[A-Z0-9]{4}/i);
            expect(parseInviteTicketText(code)).toBeNull();
            // 8 letters and digits once the dashes go would read as INV-XXXX-XXXX in the phone's normaliser: never 8.
            // (The web's join box rewrites any code that isn't INV- as a ticket, BP-EXAM-PLE1, which a node refuses as
            // malformed: apps/pwa/src/components/ShowcasePreviews.test.tsx runs every spelling through the node's own check.)
            expect(code.replace(/[^a-zA-Z0-9]/g, '').length).not.toBe(8);
            expect(code).not.toMatch(/[/:.?=&#@]/);
            expect(isSampleId(code)).toBe(false);
        }
    });

    it('every sentence a screen draws is marked for translation, and is still the English it was', async () => {
        const src = readFileSync(fileURLToPath(new URL('../sample-community.ts', import.meta.url)), 'utf8');
        const words = new Set([...src.matchAll(/word\('((?:[^'\\]|\\.)*)'\)/g)].map(m => m[1].replace(/\\'/g, '\'')));
        const drawn = strings(SAMPLE_COMMUNITY).filter(([p]) => /\.(name|member|what|who|question|title|intendedFor)$/.test(p));
        expect(drawn.length).toBeGreaterThan(20);
        for (const [path, v] of drawn) expect(words.has(v), `${path}: "${v}" is not marked with word()`).toBe(true);
        // Ids and codes are not words.
        for (const [path, v] of strings(SAMPLE_COMMUNITY).filter(([p]) => /\.(id|code|subject|usedBy)$/.test(p))) {
            expect(words.has(v), path).toBe(false);
        }
    });
});

describe('the enterprise page and the Commons card in preview: one adapter for both apps (review of #2063, N5)', () => {
    const e = SAMPLE_COMMUNITY.enterprises[0];
    const p = SAMPLE_COMMUNITY.projects[0];
    const NOW = Date.parse('2026-10-17T00:00:00.000Z');

    it('the rows are the sample\'s and add up: the Bakery came in 180, went out 60, net 120; the project\'s pledges are what it raised', () => {
        expect(e.pnl.rows.filter(r => r.amount > 0).reduce((n, r) => n + r.amount, 0)).toBe(e.pnl.cameIn);
        expect(-e.pnl.rows.filter(r => r.amount < 0).reduce((n, r) => n + r.amount, 0)).toBe(e.pnl.wentOut);
        expect(e.pnl.cameIn - e.pnl.wentOut).toBe(e.pnl.net);
        expect(e.pnl.net).toBe(e.season);
        expect(p.rows.reduce((n, r) => n + r.amount, 0)).toBe(p.pledged);
        for (const r of [...e.pnl.rows, ...p.rows]) {
            expect(isSampleId(r.id), r.id).toBe(true);
            expect(r.daysAgo).toBeLessThanOrEqual(e.pnl.days);
        }
    });

    it('the ledger works back from what it holds: each running balance, the starting balance and the totals agree', () => {
        for (const [id, balance, rows] of [[e.id, e.balance, e.pnl.rows], [p.id, p.pledged, p.rows]] as const) {
            const l = sampleEnterpriseLedger(id, NOW);
            expect(l.entries.map(x => x.id)).toEqual(rows.map(r => r.id));
            expect(l.summary.endingBalance).toBe(balance);
            expect(l.entries[0].runningBalance).toBe(balance);
            for (let i = 1; i < l.entries.length; i++) expect(l.entries[i].runningBalance).toBe(l.entries[i - 1].runningBalance - l.entries[i - 1].netAmount);
            const last = l.entries[l.entries.length - 1];
            expect(l.summary.startingBalance).toBe(last.runningBalance - last.netAmount);
            expect(l.summary.startingBalance + l.summary.netChange).toBe(balance);
            expect(l.summary.transactionCount).toBe(rows.length);
            for (const x of l.entries) {
                expect(x.counterpartyName).toBe('a neighbour');
                expect(isSampleId(x.counterparty)).toBe(true);
                expect(Date.parse(x.timestamp)).toBeLessThan(NOW);
            }
        }
        expect(sampleEnterpriseLedger(e.id, NOW).summary).toMatchObject({ totalIncome: 180, totalSpend: 60, netChange: 120, startingBalance: 40, endingBalance: 160 });
    });

    it('the cards and the page carry the sample\'s numbers, every id a sample id, a neighbour for every keeper', () => {
        const [bakery, project] = sampleEnterpriseCards(NOW);
        expect(bakery).toMatchObject({ publicKey: e.id, name: e.name, balance: 160, creditLine: 200, liveOffers: 1, earnedSurplus: 90, workingCapitalCeiling: 500, lifecycle: 'ongoing' });
        expect(project).toMatchObject({ publicKey: p.id, name: p.title, goalAmount: 120, currentAmount: 80, lifecycle: 'bounded' });
        expect(Date.parse(project.deadlineAt!) - NOW).toBe(p.daysToGo * 24 * 60 * 60 * 1000);
        expect(bakery.keepers).toHaveLength(e.keepers);
        expect(bakery.keepers.map(k => k.role)).toEqual(['lead', 'keeper', 'keeper']);
        expect(sampleEnterpriseDetail(e.id, NOW).posts.map((x: { title: string; price: number }) => [x.title, x.price])).toEqual([[e.listings[0].title, 12]]);
        expect(sampleEnterpriseDetail(p.id, NOW)).toMatchObject({ publicKey: p.id, backersCount: p.backers, posts: [] });
        for (const [path, v] of strings([sampleEnterpriseCards(NOW), sampleEnterpriseDetail(e.id, NOW), sampleEnterpriseDetail(p.id, NOW), sampleEnterpriseLedger(e.id, NOW), sampleEnterpriseLedger(p.id, NOW)])) {
            if (/(publicKey|pubkey|\.id|counterparty)$/.test(path)) expect(isSampleId(v), `${path} ${v}`).toBe(true);
        }
    });
});

describe('isSampleId: what the server\'s write guard refuses', () => {
    it('takes the sample shape only', () => {
        for (const v of ['sample-tx-bread', 'sample-1', 'sample-decision-compost-bay']) expect(isSampleId(v), v).toBe(true);
        for (const v of ['sample-', 'Sample-tx', 'sample tx', 'a sample-tx', 'sample-tx bread', 'sample-Tx', 'sample--x', 'resample-1', '', 42, null, undefined, {}, ['sample-1']]) {
            expect(isSampleId(v), JSON.stringify(v)).toBe(false);
        }
    });
});

describe('feature modes (design §4): live, preview, read-only, hidden', () => {
    it('the mode table, all eight rows', () => {
        const rows: [boolean, boolean, boolean, string][] = [
            // showcase, node, effective → mode
            [false, false, false, 'hidden'],
            [true, false, false, 'preview'],
            [false, true, false, 'read-only'],
            [true, true, false, 'read-only'],
            [false, true, true, 'live'],
            [true, true, true, 'live'],
            [false, false, true, 'live'],
            [true, false, true, 'live'],
        ];
        for (const [showcase, node, effective, mode] of rows) {
            expect(featureMode({ showcase, node, effective }), JSON.stringify({ showcase, node, effective })).toBe(mode);
        }
    });

    it('reads the node\'s and the reader\'s features: a missing switch is on, a missing showcase is today\'s hiding', () => {
        const local = { beans: true, escrow: true, enterprises: true, decisions: true, invites: true };
        const global = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false };
        for (const f of SHOWCASE_FEATURES) {
            expect(featureModeFor(f, local), f).toBe('live');
            expect(featureModeFor(f, local, local), f).toBe('live');
            // A global node from before the switch: hidden, as today.
            expect(featureModeFor(f, global), f).toBe('hidden');
            expect(featureModeFor(f, { ...global, showcase: true }), f).toBe('preview');
            expect(featureModeFor(f, { ...global, showcase: true }, global), f).toBe('preview');
            // On for the node, off for this reader (BeanID later): read-only, with or without the showcase.
            expect(featureModeFor(f, { ...local, showcase: true }, { ...local, [f]: false }), f).toBe('read-only');
            expect(featureModeFor(f, local, { ...local, [f]: false }), f).toBe('read-only');
            // A local node whose operator turned one off: hidden.
            expect(featureModeFor(f, { ...local, [f]: false }), f).toBe('hidden');
            // Off for the node, on for this reader (§4's BeanID row, pick 6: a verified member's Beans flip on): the
            // reader's set decides, so live, with or without the showcase.
            expect(featureModeFor(f, { ...global, showcase: true }, { ...global, [f]: true }), f).toBe('live');
            expect(featureModeFor(f, global, { ...global, [f]: true }), f).toBe('live');
            // Signed out, the node's set stands in for the reader's.
            expect(featureModeFor(f, { ...global, showcase: true }, undefined), f).toBe('preview');
            expect(featureModeFor(f, { ...global, showcase: true }, null), f).toBe('preview');
        }
        // An old server's features without decisions or invites: on, as the apps read them.
        expect(featureModeFor('decisions', { beans: true })).toBe('live');
        expect(featureModeFor('invites', null)).toBe('live');
    });
});

describe('readsOwnData: a marked feature reads nothing of the reader\'s (design §6 W2)', () => {
    it('reads once the mode is known, except in preview', () => {
        expect(readsOwnData(undefined)).toBe(false);
        expect(readsOwnData('preview')).toBe(false);
        // Live, read-only and hidden read as before: a local node makes the same requests.
        expect(readsOwnData('live')).toBe(true);
        expect(readsOwnData('read-only')).toBe(true);
        expect(readsOwnData('hidden')).toBe(true);
    });
});

describe('the marker and the sheet words (design §1, §2)', () => {
    it('one sheet line and guide page per feature, and the three ways forward', () => {
        for (const f of SHOWCASE_FEATURES) {
            expect(LOCAL_COMMUNITY_SHEET.features[f].length, f).toBeGreaterThan(20);
            expect(LOCAL_COMMUNITY_SHEET.guide[f], f).toMatch(/^[a-z0-9-]+$/);
            expect(LOCAL_COMMUNITY_STRIP.lead[f], f).toMatch(/^(An e|E)xample [^.]+\.$/);
        }
        expect([LOCAL_COMMUNITY_SHEET.start, LOCAL_COMMUNITY_SHEET.nearYou, LOCAL_COMMUNITY_SHEET.howItWorks])
            .toEqual(['Start a community', 'Communities near you', 'How it works']);
        expect(LOCAL_COMMUNITY_SHEET.title).toBe('Why this lives in a local community');
    });

    it('How it works opens a page in the guide; on the Ledger sheet, the page on Beans and the global community', () => {
        const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../beanpool-guide/content/manifest.json', import.meta.url)), 'utf8'));
        const pages = new Set<string>(manifest.sections.flatMap((s: { pages: string[] }) => s.pages));
        for (const f of SHOWCASE_FEATURES) expect(pages.has(LOCAL_COMMUNITY_SHEET.guide[f]), `${f} → ${LOCAL_COMMUNITY_SHEET.guide[f]}`).toBe(true);
        expect(LOCAL_COMMUNITY_SHEET.guide.beans).toBe('beans-and-the-global-community');
    });

    it('never locks, never talks tiers or nodes, never shows a Ʀ', () => {
        const all = [...strings(LOCAL_COMMUNITY_SHEET), ...strings(LOCAL_COMMUNITY_STRIP), ...strings(LOCAL_COMMUNITY_LINES)];
        for (const [path, v] of all) {
            expect(v, path).not.toMatch(/🔒|lock|unlock|tier|upgrade|premium|\bnode\b|Ʀ/i);
        }
        for (const line of [LOCAL_COMMUNITY_LINES.price, LOCAL_COMMUNITY_LINES.poll, LOCAL_COMMUNITY_LINES.invites, LOCAL_COMMUNITY_LINES.profile]) {
            expect(line.startsWith('🏘️ ')).toBe(true);
        }
    });

    // The strip's web budget at 320 px and 130% text (scratch/global-node/COPY-showcase-strips-fable.md): about 26
    // characters a line, so a one-line bold lead and a body of at most three lines. The pill above already says
    // Local community, so the strip need not.
    it('each strip fits its budget at 320 px / 130%: a lead of one line, a body of three, a collapsed row of one', () => {
        for (const f of SHOWCASE_FEATURES) {
            expect(LOCAL_COMMUNITY_STRIP.lead[f].length, f).toBeLessThanOrEqual(24);
            expect(typeof LOCAL_COMMUNITY_STRIP.body[f], f).toBe('string');
            expect(LOCAL_COMMUNITY_STRIP.body[f].length, f).toBeGreaterThan(20);
            expect(LOCAL_COMMUNITY_STRIP.body[f].length, f).toBeLessThanOrEqual(80);
        }
        expect(LOCAL_COMMUNITY_STRIP.collapsed.length).toBeLessThanOrEqual(24);
        expect(LOCAL_COMMUNITY_STRIP.collapsed.startsWith('🏘️ ')).toBe(true);
    });

    it('no strip promises Beans, or anything else, arriving here', () => {
        for (const [path, v] of strings(LOCAL_COMMUNITY_STRIP)) {
            expect(v, path).not.toMatch(/\b(here|global|once|soon|later|yet|arrive|arrives|coming|switch(es)? on)\b/i);
        }
    });

    it('the words are frozen', () => {
        for (const o of [LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_SHEET.features, LOCAL_COMMUNITY_SHEET.guide, LOCAL_COMMUNITY_STRIP, LOCAL_COMMUNITY_STRIP.lead, LOCAL_COMMUNITY_STRIP.body, LOCAL_COMMUNITY_LINES, SHOWCASE_FEATURES]) {
            expect(Object.isFrozen(o)).toBe(true);
        }
    });
});
