/**
 * The jury on a Decision card (slice J3, jury-card.ts): Check the draw over what the node served, and the card's words.
 * The served jury is built here the way the server builds it (decisions-engine juryForReader): the pool, the facts, and
 * after close the walk split into `voted` and `didNotServe`, each entry with `drawnAs`.
 */
import { describe, expect, it } from 'vitest';
import {
    checkServedJury, communityShapeLines, isJuryVote, juryCheckLine, juryClosedLists, juryDecidesLine, juryDraw, juryOffersVote, juryOutcomeLine,
    juryPoolLine, juryRuleLine, jurySeatLines, jurySeatView, juryTurnoutLine, juryTurnoutOf, removalDeciderLine, type ServedJury,
} from '../index.js';

const key = (i: number) => i.toString(16).padStart(64, '0');
const POOL = Array.from({ length: 40 }, (_, i) => key(i + 1));
const SUBJECT = key(999);
const DAY = '2026-11-03';

/** A jury as the node serves it: open, or closed with the walk's first `walked` split into the two lists. */
function served(opts: { closed?: boolean; subject?: string | null; root?: string } = {}): ServedJury {
    const drawFor = opts.root ?? opts.subject ?? SUBJECT;
    const drawn = juryDraw({ pool: POOL, subject: drawFor, snapshotDate: DAY, size: 12, standsAside: k => k === POOL[3] || k === POOL[7] });
    const walked = drawn.order.slice(0, drawn.jury.length + drawn.stoodAside.length);
    const entry = (k: string) => ({ publicKey: k, callsign: `M${POOL.indexOf(k) + 1}`, drawnAs: k });
    const base: ServedJury = {
        decisionId: 'd1', subject: opts.root ? null : drawFor, ...(opts.root ? { root: opts.root, branch: [] } : {}), snapshotDate: DAY,
        rosterHash: drawn.rosterHash, poolSize: POOL.length, size: 12, mustVote: 9, minYes: 6,
        pool: [...POOL].sort().map(k => ({ publicKey: k, callsign: `M${POOL.indexOf(k) + 1}` })), you: null,
    };
    if (!opts.closed) return base;
    const voted = walked.filter(k => drawn.jury.includes(k)).slice(0, 9);
    return { ...base, voted: voted.map(entry), didNotServe: walked.filter(k => !voted.includes(k)).map(entry) };
}

describe('Check the draw', () => {
    it('an honest open jury checks out on its pool, and says the names come at the close', () => {
        const check = checkServedJury(served());
        expect(check).toEqual({ ok: true, closed: false });
        expect(juryCheckLine(check)).toBe('The draw checks out: the pool is the one this vote recorded. Once it closes, you can check who was drawn.');
    });

    it('an honest closed jury checks out over who voted and who didn\'t serve, in any order and either list', () => {
        const jury = served({ closed: true });
        expect(checkServedJury(jury)).toEqual({ ok: true, closed: true });
        // The lists are a partition of the walk, not an order: moving a name across them still checks out.
        const moved = { ...jury, voted: jury.voted!.slice(1), didNotServe: [jury.voted![0], ...jury.didNotServe!].reverse() };
        expect(checkServedJury(moved).ok).toBe(true);
        expect(juryCheckLine(checkServedJury(jury))).toBe('The draw checks out: everyone listed was drawn in order from the pool this vote recorded.');
    });

    it('a tampered pool shows the hash sentence', () => {
        const jury = served({ closed: true });
        const pool = jury.pool.map((e, i) => (i === 5 ? { ...e, publicKey: key(5000) } : e));
        const check = checkServedJury({ ...jury, pool });
        expect(check).toEqual({ ok: false, problem: 'hash' });
        expect(juryCheckLine(check)).toBe("The list the node served doesn't match its own hash.");
        // A member missing from the pool, open or closed, is the same sentence.
        expect(checkServedJury({ ...served(), pool: served().pool.slice(1) })).toEqual({ ok: false, problem: 'hash' });
    });

    it('a dropped name shows the order sentence', () => {
        const jury = served({ closed: true });
        const first = jury.voted![0].publicKey;
        const dropped = { ...jury, voted: jury.voted!.filter(e => e.publicKey !== first) };
        const check = checkServedJury(dropped);
        expect(check).toEqual({ ok: false, problem: 'order' });
        expect(juryCheckLine(check)).toBe("The names the node served aren't the first ones the draw picks.");
        // So is a name added that the draw never reached.
        const added = { ...jury, didNotServe: [...jury.didNotServe!, { publicKey: POOL[39], callsign: 'M40', drawnAs: POOL[39] }] };
        const reached = new Set([...jury.voted!, ...jury.didNotServe!].map(e => e.publicKey));
        if (!reached.has(POOL[39])) expect(checkServedJury(added)).toEqual({ ok: false, problem: 'order' });
    });

    it('a juror who moved to a new key checks out by drawnAs, and fails without it', () => {
        const jury = served({ closed: true });
        const moved = { ...jury, voted: jury.voted!.map((e, i) => (i === 0 ? { publicKey: key(7777), callsign: e.callsign, drawnAs: e.publicKey } : e)) };
        expect(checkServedJury(moved).ok).toBe(true);
        const noDrawnAs = { ...moved, voted: moved.voted.map((e, i) => (i === 0 ? { publicKey: e.publicKey, callsign: e.callsign } : e)) };
        expect(checkServedJury(noDrawnAs)).toEqual({ ok: false, problem: 'order' });
    });

    it("a branch's jury checks out with its root's key, and not with another", () => {
        const root = key(4242);
        const jury = served({ closed: true, root });
        expect(checkServedJury(jury).ok).toBe(true);
        expect(checkServedJury({ ...jury, root: SUBJECT }).ok).toBe(false);
    });

    it('says what the pool was drawn from, on the UTC day the vote recorded', () => {
        expect(juryPoolLine({ poolSize: 140, snapshotDate: DAY })).toBe('Drawn from 140 members who could serve on 3 Nov.');
        expect(juryPoolLine({ poolSize: 140, snapshotDate: 'nope' })).toBe('Drawn from 140 members who could serve.');
    });
});

describe('the jury card', () => {
    it('knows a jury vote by its params or its tally', () => {
        expect(isJuryVote({ params: { decider: 'jury' } })).toBe(true);
        expect(isJuryVote({ params: { decider: 'everyone' }, tally: { decider: 'jury' } })).toBe(true);
        expect(isJuryVote({ params: { decider: 'everyone' } })).toBe(false);
        expect(isJuryVote({ params: null, tally: null })).toBe(false);
    });

    it('counts jurors, never a split, and never NaN', () => {
        const turnout = juryTurnoutOf({ turnout: { voted: 7, size: 12, mustVote: 9 } })!;
        expect(juryTurnoutLine(turnout)).toBe('7 of 12 jurors have voted');
        expect(juryTurnoutLine({ voted: 1, size: 12, mustVote: 9 })).toBe('1 of 12 jurors has voted');
        expect(juryTurnoutLine({ voted: 0, size: 12, mustVote: 9 })).toBe('0 of 12 jurors have voted');
        expect(juryRuleLine(turnout, 6, 'Dave')).toBe('9 of the jury must vote. Removing Dave takes two-thirds of the votes cast, and at least 6 Yes.');
        // A tally without turnout (a node from before) gives nothing to count, rather than a NaN.
        expect(juryTurnoutOf({})).toBeNull();
        expect(juryTurnoutOf({ turnout: { voted: NaN, size: 12, mustVote: 9 } })).toBeNull();
        for (const line of [juryTurnoutLine(turnout), juryRuleLine(turnout, 6, 'Dave'), juryDecidesLine(12, '2026-11-10T09:00:00.000Z')]) {
            expect(line).not.toMatch(/NaN|undefined/);
        }
        expect(juryDecidesLine(12, '2026-11-10T09:00:00.000Z')).toBe('A jury of 12 members, drawn at random, decides by 10 Nov.');
        expect(juryDecidesLine(12, null)).toBe('A jury of 12 members, drawn at random, decides.');
    });

    it('offers the vote to a seated juror only; a member not drawn, passed over or stepped aside reads the same', () => {
        const at = { isSubject: false, hasVoted: false };
        expect(jurySeatView({ you: null }, at)).toBe('not_on_it');
        expect(juryOffersVote(jurySeatView({ you: null }, at))).toBe(false);
        expect(jurySeatView({ you: 'seated', answerBy: '2026-11-07T00:00:00.000Z' }, at)).toBe('ask');
        expect(jurySeatView({ you: 'seated', answerBy: null }, at)).toBe('serving');
        expect(jurySeatView({ you: 'seated', answerBy: '2026-11-07T00:00:00.000Z' }, { isSubject: false, hasVoted: true })).toBe('voted');
        expect(jurySeatView({ you: 'not_seated' }, at)).toBe('not_seated');
        expect(jurySeatView({ you: null }, { isSubject: true, hasVoted: false })).toBe('subject');
        for (const v of ['ask', 'serving', 'voted'] as const) expect(juryOffersVote(v)).toBe(true);
        for (const v of ['not_on_it', 'not_seated', 'subject'] as const) expect(juryOffersVote(v)).toBe(false);
        expect(jurySeatLines('not_on_it', { name: 'Dave' })).toEqual(['Only the jury votes on this. Anyone can check how it was drawn.']);
    });

    it("a juror is asked to serve or step aside by their date, and told when the vote closes in under two days", () => {
        const now = Date.parse('2026-11-04T00:00:00.000Z');
        const lines = jurySeatLines('ask', { name: 'Dave', answerBy: '2026-11-07T00:00:00.000Z', closesAt: '2026-11-11T00:00:00.000Z', now });
        expect(lines[0]).toBe("You were drawn for this jury. Read the case and Dave's answer, then vote.");
        expect(lines[1]).toMatch(/^Answer by .+: serve, or step aside\. If you don't answer, your seat goes to the next member drawn\.$/);
        expect(lines).toContain("Step aside if you know them too well to judge, or can't give it the time. Nobody is told why.");
        expect(lines).not.toContain('This vote closes in less than two days.');
        const late = jurySeatLines('ask', { name: 'Dave', answerBy: '2026-11-05T00:00:00.000Z', closesAt: '2026-11-05T00:00:00.000Z', now });
        expect(late).toContain('This vote closes in less than two days.');
        expect(jurySeatLines('voted', { name: 'Dave' }).join(' ')).not.toMatch(/Step aside/);
    });

    it('says how a closed jury ended (design §9)', () => {
        const turnout = { voted: 10, size: 12, mustVote: 9 };
        expect(juryOutcomeLine({ status: 'execution_pending_grace' }, { quorumMet: true, yesWeight: 9, turnout }, 'Dave')).toBe('The jury voted to remove Dave (9 of 12).');
        expect(juryOutcomeLine({ status: 'failed' }, { quorumMet: true, yesWeight: 5, turnout }, 'Dave')).toBe('The jury kept Dave.');
        expect(juryOutcomeLine({ status: 'failed' }, { quorumMet: false, yesWeight: 5, turnout: { ...turnout, voted: 7 } }, 'Dave')).toBe('7 of 12 jurors voted, too few to decide. Dave is back.');
        expect(juryOutcomeLine({ status: 'admin_halted' }, { quorumMet: false, turnout }, 'Dave')).toBeNull();
    });

    it('names who voted and who did not serve after close, and never why', () => {
        const lists = juryClosedLists(served({ closed: true }))!;
        expect(lists.voted).toMatch(/^Voted: M\d+(, M\d+){8}$/);
        expect(lists.didNotServe).toMatch(/^Didn't serve: M\d+/);
        expect(juryClosedLists(served())).toBeNull();
        expect(juryClosedLists({ voted: [], didNotServe: [{ publicKey: key(3), callsign: null }] })).toEqual(expect.objectContaining({
            voted: 'Voted: nobody', didNotServe: `Didn't serve: ${key(3).slice(0, 8)}`,
        }));
    });
});

describe('Who decides a removal, under How this community works', () => {
    it('says the rule from the node, and nothing from a node that does not say', () => {
        expect(removalDeciderLine({ decisions: true, removalDecider: 'automatic' })).toBe('**Removals:** decided by everyone who can vote until 100 members could serve on a jury, then by a jury drawn at random');
        expect(removalDeciderLine({ decisions: true, removalDecider: 'everyone' })).toBe('**Removals:** decided by everyone who can vote');
        expect(removalDeciderLine({ decisions: true, removalDecider: 'jury' })).toBe('**Removals:** decided by a jury drawn at random; while fewer than 36 members could serve on one, by everyone who can vote');
        expect(removalDeciderLine({ decisions: true })).toBeNull();
        expect(removalDeciderLine({ decisions: false, removalDecider: 'jury' })).toBeNull();
    });

    it('draws the line under Decisions while they are on, and not when they are off', () => {
        const on = communityShapeLines({ beans: true, decisions: true, door: 'members', removalDecider: 'automatic' });
        const at = on.findIndex(l => l.startsWith('**Decisions:**'));
        expect(on[at + 1]).toMatch(/^\*\*Removals:\*\* decided by everyone who can vote until 100/);
        expect(communityShapeLines({ beans: true, decisions: false, door: 'members', removalDecider: 'automatic' }).join('\n')).not.toMatch(/Removals/);
        expect(communityShapeLines({ beans: true, decisions: true, door: 'members' }).join('\n')).not.toMatch(/Removals/);
    });
});
