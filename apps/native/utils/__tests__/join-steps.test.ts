/**
 * The join's step bar (slice S3, DESIGN-onboarding-home-landing-fable.md §3.1): one dot per screen the member will actually
 * see on this phone, per way in. The front door, Your invite and the ways back have no dot.
 *
 * One row per path the brief names (invite found, invite typed, look around, restore) plus the claim, and the screens each
 * path draws are read from welcome.tsx, so a step bar added to a screen that is no join step (or taken off one that is) is
 * caught here.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));

import { afterNotify, afterWayBack, joinSteps, stepDot, wayBackButton, type JoinStep } from '../join-steps';
import { resumePlan, type OnboardingFlow, type PendingOnboarding } from '../onboarding-state';
import { GLOBAL_NODE_URL } from '../global-node-url';

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

    // Slice N1j (DESIGN-notify-and-backup-asks-fable-amend2.md §2, §4.2): on a phone that has to ask, the notifications screen
    // is the join's last step, so every screen counts it: an invite or a door is five screens and four dots (the front door
    // none), a claim three dots (the owner's card none). Android 8 to 12 never shows it: the rows above stand there.
    it('on a phone that has to ask: four dots on an invite and a door, three on a claim, the notifications screen last', () => {
        const NOTIFY_ROWS: Array<{ flow: OnboardingFlow; wayBack: boolean; dots: Partial<Record<JoinStep, string>> }> = [
            { flow: 'invite', wayBack: true, dots: { name: '1/4', photo: '2/4', wayBack: '3/4', notify: '4/4' } },
            { flow: 'global', wayBack: true, dots: { name: '1/4', photo: '2/4', wayBack: '3/4', notify: '4/4' } },
            { flow: 'claim', wayBack: true, dots: { photo: '1/3', wayBack: '2/3', notify: '3/3' } },
            // A way back already kept (S4): skipped, one dot fewer, the notifications screen still last.
            { flow: 'global', wayBack: false, dots: { name: '1/3', photo: '2/3', notify: '3/3' } },
        ];
        for (const r of NOTIFY_ROWS) {
            const steps = joinSteps(r.flow, { wayBack: r.wayBack, notify: true });
            expect(steps[steps.length - 1], `${r.flow}: last`).toBe('notify');
            for (const [step, dot] of Object.entries(r.dots) as Array<[JoinStep, string]>) {
                const d = stepDot(steps, step);
                expect(d ? `${d.at}/${d.of}` : null, `${r.flow} ${step}`).toBe(dot);
            }
            expect(steps.length).toBe(Object.keys(r.dots).length);
            // Without the screen (Android 8 to 12, a phone that already allows or said no): no notify dot.
            expect(joinSteps(r.flow, { wayBack: r.wayBack })).not.toContain('notify');
        }
        // Every join screen's bar counts it, from the same reading of the phone (welcome.tsx `notifyDue`).
        for (const mode of ["create') {", "globalJoin'", "profileSetup'", "seedBackup'"]) {
            expect(screen(mode), mode).toMatch(/<StepBar[^>]*\bnotify=\{notifyDue\}/);
        }
        // The notifications screen is its own component, whose bar is the last dot.
        expect(screen("notify'")).toContain('<NotifyStep');
        const notifyStep = fs.readFileSync(path.join(__dirname, '..', '..', 'components/welcome/NotifyStep.tsx'), 'utf8');
        expect(notifyStep).toMatch(/<StepBar step="notify" flow=\{flow\} wayBack=\{wayBack\} notify busy=\{busy\}/);
    });

    it('after the way back: the notifications screen where it shows; after it, a claim\'s owner\'s card, else Home', () => {
        expect(afterWayBack('invite', true)).toBe('notify');
        expect(afterWayBack('claim', true)).toBe('notify');
        expect(afterWayBack('invite', false)).toBe('home');
        expect(afterWayBack('global', false)).toBe('home');
        expect(afterWayBack('claim', false)).toBe('ownerCard');
        expect(afterNotify('invite')).toBe('home');
        expect(afterNotify('global')).toBe('home');
        expect(afterNotify('claim')).toBe('ownerCard');
        // The way back's button: Later until kept, then Next where the notifications screen follows (never Let's go then).
        expect(wayBackButton(false, afterWayBack('invite', true))).toBe('later');
        expect(wayBackButton(true, afterWayBack('invite', true))).toBe('next');
        expect(wayBackButton(true, afterWayBack('invite', false))).toBe('letsGo');
        expect(wayBackButton(true, afterWayBack('claim', false))).toBe('next');
        // The way back's button hands over through one place that reads the phone again, never straight to Home.
        const wayBack = screen("seedBackup'");
        expect(wayBack).toContain('const next = afterWayBack(joinFlow, notifyDue);');
        expect(wayBack).toContain('void handOverFromWayBack();');
        expect(wayBack).not.toContain('void handleConfirmSeed()');
    });

    // §4.3: a join a 1.4.7 phone left part-way resumes on a screen of the new path, with its own dot; nothing stored is
    // rewritten (no conversion code). How it Works (`onboardingGuide`) resumes on the way back, the step before it (S5).
    it('a 1.4.7 join left at any step resumes on a screen with its dot, on every door', () => {
        const KEY = 'ab'.repeat(32);
        const STORED = { publicKey: KEY, privateKey: '07'.repeat(32), callsign: 'Sam', createdAt: '2026-09-26T00:00:00Z' } as never;
        const MODE_STEP: Record<string, JoinStep> = { create: 'name', globalJoin: 'name', profileSetup: 'photo', seedBackup: 'wayBack' };
        const rows: Array<{ flow: OnboardingFlow; step: PendingOnboarding['step']; dot: string }> = [
            { flow: 'invite', step: 'create', dot: '1/3' },
            { flow: 'invite', step: 'profileSetup', dot: '2/3' },
            { flow: 'invite', step: 'seedBackup', dot: '3/3' },
            { flow: 'invite', step: 'onboardingGuide', dot: '3/3' },
            { flow: 'global', step: 'profileSetup', dot: '2/3' },
            { flow: 'global', step: 'seedBackup', dot: '3/3' },
            { flow: 'global', step: 'onboardingGuide', dot: '3/3' },
            { flow: 'claim', step: 'profileSetup', dot: '1/2' },
            { flow: 'claim', step: 'seedBackup', dot: '2/2' },
            { flow: 'claim', step: 'onboardingGuide', dot: '2/2' },
        ];
        for (const r of rows) {
            const record = {
                step: r.step, flow: r.flow, callsign: 'Sam', redeemed: true, newKey: KEY,
                inviteCode: r.flow === 'invite' ? 'BP-ABCD-1234' : '',
                anchorUrl: r.flow === 'invite' ? 'https://riverside.example' : r.flow === 'claim' ? 'https://beans.example.org' : GLOBAL_NODE_URL,
            } as PendingOnboarding;
            const plan = resumePlan(record, STORED);
            expect(plan.action, `${r.flow} at ${r.step}`).toBe('resume');
            if (plan.action !== 'resume') continue;
            const step = MODE_STEP[plan.mode];
            const src = screen(plan.mode === 'create' ? "create') {" : `${plan.mode}'`);
            expect(src.match(/<StepBar\s+step="(\w+)"/)?.[1], `${r.flow} at ${r.step}: the screen it resumes on`).toBe(step);
            const dot = stepDot(joinSteps(plan.flow), step);
            expect(dot ? `${dot.at}/${dot.of}` : null, `${r.flow} at ${r.step}`).toBe(r.dot);
        }
    });
});
