/**
 * The join's step bar (slice S3, DESIGN-onboarding-home-landing-fable.md §3.1): one dot per screen the member will actually
 * see on this phone, per way in. The front door, Your invite and the ways back have no dot.
 *
 * One row per path the brief names (invite found, invite typed, look around, restore) plus the claim, and the screens each
 * path draws are read from welcome.tsx, so a step bar added to a screen that is no join step (or taken off one that is) is
 * caught here.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { joinSteps, stepDot, type JoinStep } from '../join-steps';
import type { OnboardingFlow } from '../onboarding-state';

const welcome = fs.readFileSync(path.join(__dirname, '..', '..', 'app/welcome.tsx'), 'utf8');

/** The source of one screen: from its `if (mode === '<mode>'` at the render's indent to the next screen's. */
function screen(mode: string): string {
    const start = welcome.indexOf(`\n    if (mode === '${mode}`);
    expect(start, mode).toBeGreaterThan(-1);
    const next = welcome.indexOf('\n    if (mode === ', start + 10);
    return welcome.slice(start, next === -1 ? undefined : next);
}

/** Each path: the join it is (null: no join, so no bar), and the dots each of its screens shows, in order. */
const PATHS: Array<{ path: string; flow: OnboardingFlow | null; screens: Array<{ mode: string; step: JoinStep | null; dot: string | null }> }> = [
    {
        path: 'an invite found on the phone (a link, the referrer, the clipboard at "I have an invite")',
        flow: 'invite',
        screens: [
            { mode: "home'", step: null, dot: null },
            { mode: "create') {", step: 'name', dot: '1/3' },
            { mode: "profileSetup'", step: 'photo', dot: '2/3' },
            { mode: "seedBackup'", step: 'wayBack', dot: '3/3' },
        ],
    },
    {
        path: 'an invite typed or scanned on Your invite',
        flow: 'invite',
        screens: [
            { mode: "home'", step: null, dot: null },
            { mode: "create' && !inviteCode.trim()", step: null, dot: null },
            { mode: "create') {", step: 'name', dot: '1/3' },
            { mode: "profileSetup'", step: 'photo', dot: '2/3' },
            { mode: "seedBackup'", step: 'wayBack', dot: '3/3' },
        ],
    },
    {
        path: 'No invite? Look around: the global door chooses the name',
        flow: 'global',
        screens: [
            { mode: "home'", step: null, dot: null },
            { mode: "globalJoin'", step: 'name', dot: '1/3' },
            { mode: "profileSetup'", step: 'photo', dot: '2/3' },
            { mode: "seedBackup'", step: 'wayBack', dot: '3/3' },
        ],
    },
    {
        path: "I've used BeanPool before: the ways back are no join",
        flow: null,
        screens: [
            { mode: "home'", step: null, dot: null },
            { mode: "member'", step: null, dot: null },
            { mode: "recover'", step: null, dot: null },
            { mode: "ssoRecover'", step: null, dot: null },
        ],
    },
    {
        path: 'a claim: its own screen, then the photo and the way back; the owner\'s card has no dot',
        flow: 'claim',
        screens: [
            { mode: "profileSetup'", step: 'photo', dot: '1/2' },
            { mode: "seedBackup'", step: 'wayBack', dot: '2/2' },
            { mode: "ownerCard'", step: null, dot: null },
        ],
    },
];

describe('the step bar: one dot per screen the join shows', () => {
    for (const p of PATHS) {
        it(p.path, () => {
            const steps = p.flow ? joinSteps(p.flow) : [];
            for (const s of p.screens) {
                const src = screen(s.mode);
                const bar = src.match(/<StepBar\s+step="(\w+)"/);
                expect(bar?.[1] ?? null, `${s.mode}: its step bar`).toBe(s.step);
                if (!s.step) continue;
                const dot = stepDot(steps, s.step);
                expect(dot ? `${dot.at}/${dot.of}` : null, `${s.mode}: its dot`).toBe(s.dot);
            }
            // As many dots as screens with a dot: none left out, none for a screen the path never shows.
            expect(steps.length).toBe(p.screens.filter((s) => s.dot).length);
        });
    }

    it('a step a join does not have, or a join of one step, draws no dots', () => {
        expect(stepDot(['photo', 'wayBack'], 'name')).toBeNull();
        expect(stepDot(['photo'], 'photo')).toBeNull();
        expect(stepDot([], 'wayBack')).toBeNull();
    });

    it('the bar has no step on a screen that is no join step', () => {
        for (const mode of ["home'", "member'", "recover'", "ssoRecover'", "confirmReplace'", "ownerCard'", "create' && !inviteCode.trim()"]) {
            expect(screen(mode), mode).not.toContain('<StepBar');
        }
    });
});
