/**
 * The node takes a pledge only while an enterprise is active (#1374 NB, 2026-10-02). The enterprise screen showed the
 * pledge box on a funded enterprise too, and a member who filled it in got "Pledge Failed" with the node's refusal. Now
 * a funded or closed enterprise shows a plain sentence where the box was, and its Commons card no longer says "Pledge
 * Beans".
 *
 * The screens cannot be rendered here (see vitest.config.ts): their wiring is read from their source.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deadlineDaysRemaining } from '@beanpool/core';
import { isPastDeadline, pledgeClosedLine, pledgeReturnLine } from '../enterprise-pledge';
import { enterpriseCardStatus } from '../enterprise-card';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CLOSED = "This project's deadline has passed: it takes no more pledges.";

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const source = (rel: string) => code(fs.readFileSync(path.resolve(__dirname, '../../app', rel), 'utf-8'));
/** From `start` to the first `end` after it. */
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}

describe('pledgeClosedLine: the node takes a pledge only while an enterprise is active', () => {
    it('is null for an active enterprise, or one whose status is not known', () => {
        expect(pledgeClosedLine('active')).toBeNull();
        expect(pledgeClosedLine(undefined)).toBeNull();
        expect(pledgeClosedLine(null)).toBeNull();
    });

    it('says a funded enterprise has reached its goal, one winding up that it is, and any other state closed', () => {
        expect(pledgeClosedLine('funded')).toBe('This enterprise has reached its goal, so it isn’t taking more pledges.');
        expect(pledgeClosedLine('winding_up')).toBe('This enterprise is winding up, so it isn’t taking pledges.');
        for (const s of ['completed', 'suspended', 'disabled', 'pruned']) {
            expect(pledgeClosedLine(s)).toBe('This enterprise has closed, so it isn’t taking pledges.');
        }
    });

    it('says "project" for a project (group decisions pick 8)', () => {
        expect(pledgeClosedLine('funded', 'bounded')).toBe('This project has reached its goal, so it isn’t taking more pledges.');
        expect(pledgeClosedLine('winding_up', 'bounded')).toBe('This project is winding up, so it isn’t taking pledges.');
        expect(pledgeClosedLine('completed', 'bounded')).toBe('This project has closed, so it isn’t taking pledges.');
        expect(pledgeClosedLine('completed', 'ongoing')).toBe('This enterprise has closed, so it isn’t taking pledges.');
    });

    it('says a project whose deadline has passed is no longer taking pledges', () => {
        const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        expect(pledgeClosedLine('active', 'bounded', past)).toBe("This project's deadline has passed: it takes no more pledges.");

        // An hour after the deadline's instant is still its end date: the badge says "Ends today", and pledges are open.
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        expect(pledgeClosedLine('active', 'bounded', oneHourAgo)).toBeNull();
    });

    it("stays open all through its end date: 23 h 59 m after the deadline's instant open, 24 h after closed", () => {
        const now = Date.now();
        const ago = (ms: number) => new Date(now - ms).toISOString();
        expect(isPastDeadline(ago(DAY - MINUTE), now)).toBe(false);
        expect(pledgeClosedLine('active', 'bounded', ago(DAY - MINUTE), now)).toBeNull();
        expect(isPastDeadline(ago(DAY), now)).toBe(true);
        expect(pledgeClosedLine('active', 'bounded', ago(DAY), now)).toBe(CLOSED);
    });
});

// A project that ends short of its goal gives its backers their Beans back a week after its end date, unless the end date
// moves before then (Marty, board, 27 Oct 2026). The screen says so plainly, and once they have gone back, that they went
// back. The same rule as the web app's (apps/pwa/src/lib/enterprise-pledge.ts).
describe('pledgeReturnLine: what the project screen says happens to the Beans if the goal is not reached', () => {
    // 10:00 UTC is the same calendar day on every clock from UTC-10 to UTC+13, so these read the same wherever they run.
    const NOW = Date.parse('2026-11-20T10:00:00.000Z');
    const project = { goalAmount: 100, currentAmount: 45, status: 'active' };

    it('before its end date is over: if the goal isn’t reached by then, everyone’s Beans go back a week after it', () => {
        expect(pledgeReturnLine({ ...project, deadlineAt: '2026-11-30T10:00:00.000Z' }, NOW))
            .toBe('If the goal isn’t reached by 30 Nov 2026, everyone’s Beans go back on 7 Dec 2026.');
        // On its end date it still takes pledges, and says the same.
        expect(pledgeReturnLine({ ...project, deadlineAt: '2026-11-20T10:00:00.000Z' }, NOW + 5 * HOUR))
            .toBe('If the goal isn’t reached by 20 Nov 2026, everyone’s Beans go back on 27 Nov 2026.');
        // And to a project nobody has backed yet: it is what a backer is promised.
        expect(pledgeReturnLine({ ...project, currentAmount: 0, deadlineAt: '2026-11-30T10:00:00.000Z' }, NOW))
            .toBe('If the goal isn’t reached by 30 Nov 2026, everyone’s Beans go back on 7 Dec 2026.');
    });

    it('in the week after its end date: they go back on the day, unless the end date moves before then', () => {
        expect(pledgeReturnLine({ ...project, deadlineAt: '2026-11-17T10:00:00.000Z' }, NOW))
            .toBe('The goal wasn’t reached by 17 Nov 2026. Everyone’s Beans go back on 24 Nov 2026, unless the end date moves before then.');
    });

    it('from the day they are due until the node has returned them: they are going back', () => {
        expect(pledgeReturnLine({ ...project, deadlineAt: '2026-11-13T10:00:00.000Z' }, NOW))
            .toBe('The goal wasn’t reached by 13 Nov 2026, so everyone’s Beans are going back.');
    });

    it('once the node has returned them: they went back, on the day it did', () => {
        expect(pledgeReturnLine({ ...project, currentAmount: 0, deadlineAt: '2026-11-10T10:00:00.000Z', pledgesReturnedAt: '2026-11-17T10:00:30.000Z' }, NOW))
            .toBe('The goal wasn’t reached by 10 Nov 2026, so everyone’s Beans went back on 17 Nov 2026.');
    });

    it('says nothing once its end date is over with nothing pledged: nothing is held to go back', () => {
        expect(pledgeReturnLine({ ...project, currentAmount: 0, deadlineAt: '2026-11-17T10:00:00.000Z' }, NOW)).toBeNull();
        expect(pledgeReturnLine({ ...project, currentAmount: 0, deadlineAt: '2026-11-01T10:00:00.000Z' }, NOW)).toBeNull();
    });

    it('says nothing for a project that reached its goal, an enterprise with no goal, or a project with no end date', () => {
        const ahead = '2026-11-30T10:00:00.000Z';
        expect(pledgeReturnLine({ ...project, currentAmount: 100, deadlineAt: ahead }, NOW)).toBeNull();
        expect(pledgeReturnLine({ ...project, status: 'funded', deadlineAt: ahead }, NOW)).toBeNull();
        expect(pledgeReturnLine({ ...project, status: 'completed', deadlineAt: ahead }, NOW)).toBeNull();
        expect(pledgeReturnLine({ ...project, goalAmount: null, deadlineAt: ahead }, NOW)).toBeNull();
        expect(pledgeReturnLine({ ...project, goalAmount: 0, deadlineAt: ahead }, NOW)).toBeNull();
        for (const deadlineAt of [null, undefined, '', 'not a date']) expect(pledgeReturnLine({ ...project, deadlineAt }, NOW), String(deadlineAt)).toBeNull();
    });

    it('moves on exactly when pledges stop (the badge says Expired) and when the return falls due (core isPledgeReturnDue)', () => {
        const deadline = '2026-11-10T10:00:00.000Z';
        const at = Date.parse(deadline);
        expect(pledgeReturnLine({ ...project, deadlineAt: deadline }, at + DAY - 1)).toMatch(/^If the goal isn’t reached by /);
        expect(pledgeReturnLine({ ...project, deadlineAt: deadline }, at + DAY)).toMatch(/unless the end date moves before then\.$/);
        expect(pledgeReturnLine({ ...project, deadlineAt: deadline }, at + 7 * DAY - 1)).toMatch(/unless the end date moves before then\.$/);
        expect(pledgeReturnLine({ ...project, deadlineAt: deadline }, at + 7 * DAY)).toMatch(/so everyone’s Beans are going back\.$/);
    });
});

describe('The enterprise screen: a sentence, not a pledge box, when pledges are closed', () => {
    const screen = () => source('treasury-detail.tsx');
    const funding = () => slice(screen(), 'const isFunded = current >= goal', '})()}');

    it('asks the rule with the enterprise\'s status and deadline', () => {
        expect(funding()).toContain('const pledgesClosed = pledgeClosedLine(detail?.status, detail?.lifecycle, detail?.deadlineAt);');
    });

    it('shows the sentence when pledges are closed, and the box with its PLEDGE BEANS button only when they are open', () => {
        const body = funding();
        const closed = slice(body, '{pledgesClosed ? (', ') : (');
        expect(closed).toContain('{pledgesClosed}');
        expect(closed).not.toContain('handlePledge');
        expect(closed).not.toContain('PLEDGE BEANS');
        const open = body.slice(body.indexOf(') : (', body.indexOf('{pledgesClosed ? (')));
        expect(open).toContain('onPress={handlePledge}');
        expect(open).toContain('PLEDGE BEANS');
        // The only pledge button on the screen is that one.
        expect(screen().split('onPress={handlePledge}').length - 1).toBe(1);
    });

    it('in preview (Example Valley\'s enterprise) the box is the marker: no pledge handler, no amount, before either branch', () => {
        const body = funding();
        const preview = slice(body, '{isEffectivePreview ? (', ') : (<>');
        expect(preview).toContain('<LocalCommunityMark variant="action" feature="enterprises"');
        expect(preview).not.toContain('handlePledge');
        expect(preview).not.toContain('TextInput');
        expect(preview).not.toContain('PLEDGE BEANS');
        expect(body.indexOf('{isEffectivePreview ? (')).toBeLessThan(body.indexOf('{pledgesClosed ? ('));
    });
});

describe('The Commons card says "Pledge Beans" only while the enterprise takes pledges', () => {
    const project = { balance: 5, liveOffers: 0, goalAmount: 20, currentAmount: 5, lifecycle: 'bounded', status: 'active', paused: false, keepers: [] };

    it('an active project short of its goal takes pledges', () => {
        expect(enterpriseCardStatus(project).takesPledges).toBe(true);
    });

    it('a funded, winding-up or closed one does not, nor one with no goal', () => {
        expect(enterpriseCardStatus({ ...project, status: 'funded' }).takesPledges).toBe(false);
        expect(enterpriseCardStatus({ ...project, currentAmount: 20 }).takesPledges).toBe(false);
        expect(enterpriseCardStatus({ ...project, status: 'winding_up' }).takesPledges).toBe(false);
        expect(enterpriseCardStatus({ ...project, status: 'completed' }).takesPledges).toBe(false);
        expect(enterpriseCardStatus({ ...project, goalAmount: null }).takesPledges).toBe(false);
        const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        expect(enterpriseCardStatus({ ...project, deadlineAt: past }).takesPledges).toBe(false);
    });

    describe('closes exactly when the deadline badge says Expired (its number below 0), never before', () => {
        const NOW = Date.parse('2026-10-26T09:30:00.000Z');
        afterEach(() => { vi.useRealTimers(); });

        it('the card and the pledge box ask the rule the badge counts with', () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(NOW);
            for (let minutes = -3 * 24 * 60; minutes <= 3 * 24 * 60; minutes += 7) {
                const deadlineAt = new Date(NOW - minutes * MINUTE).toISOString();
                const expired = deadlineDaysRemaining(deadlineAt) < 0;
                expect(isPastDeadline(deadlineAt), deadlineAt).toBe(expired);
                expect(pledgeClosedLine('active', 'bounded', deadlineAt), deadlineAt).toBe(expired ? CLOSED : null);
                expect(enterpriseCardStatus({ ...project, deadlineAt }).takesPledges, deadlineAt).toBe(!expired);
            }
        });
    });

    it('the card shows its Pledge Beans line from takesPledges', () => {
        // The card is its own component (the Commons list and its preview draw the same one: review of #2063, B2).
        const card = code(fs.readFileSync(path.resolve(__dirname, '../../components/EnterpriseCard.tsx'), 'utf-8'));
        expect(card).toContain('{takesPledges && (');
        expect(card).not.toContain('{hasGoal && !isFunded && (');
        expect(source('(tabs)/projects.tsx')).toContain('const renderEnterpriseItem = ({ item }: { item: TreasurySummary }) => <EnterpriseCard item={item} />;');
        expect(source('(tabs)/projects.tsx')).not.toContain('Pledge Beans');
    });
});

describe("The phone's three deadline badges count with core's deadlineDaysRemaining, the pledge gate's own rule", () => {
    // The card and the Yours row are rendered in enterprise-deadline-badge-render.test.ts; the screen is read here.
    it.each([
        ['components/EnterpriseCard.tsx', 'function getDaysRemaining('],
        ['components/YoursEnterpriseRow.tsx', 'function getDaysRemaining('],
        ['app/treasury-detail.tsx', 'const getDaysRemaining = ('],
    ])('%s: no arithmetic of its own', (file, start) => {
        const badge = slice(code(fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf-8')), start, "tn(days, '{n} days left', '{n} days left')");
        expect(badge).toContain('const days = deadlineDaysRemaining(deadline);');
        expect(badge).toContain("if (days < 0) return { text: t('Expired'), expired: true };");
        expect(badge).toContain("if (days === 0) return { text: t('Ends today'), expired: false };");
        expect(badge).not.toMatch(/Math\.|getTime\(|Date\.now\(|new Date\(/);
    });
});
