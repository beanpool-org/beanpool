/**
 * The node takes a pledge only while an enterprise is active (#1374 NB, 2026-10-02). The enterprise screen showed the
 * pledge box on a funded enterprise too, and a member who filled it in got "Pledge Failed" with the node's refusal. Now
 * a funded or closed enterprise shows a plain sentence where the box was, and its Commons card no longer says "Pledge
 * Beans".
 *
 * The screens cannot be rendered here (see vitest.config.ts): their wiring is read from their source.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pledgeClosedLine } from '../enterprise-pledge';
import { enterpriseCardStatus } from '../enterprise-card';

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
});

describe('The enterprise screen: a sentence, not a pledge box, when pledges are closed', () => {
    const screen = () => source('treasury-detail.tsx');
    const funding = () => slice(screen(), 'const isFunded = current >= goal', '})()}');

    it('asks the rule with the enterprise\'s status', () => {
        expect(funding()).toContain('const pledgesClosed = pledgeClosedLine(detail?.status);');
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
    });

    it('the card shows its Pledge Beans line from takesPledges', () => {
        const card = source('(tabs)/projects.tsx');
        expect(card).toContain('{takesPledges && (');
        expect(card).not.toContain('{hasGoal && !isFunded && (');
    });
});
