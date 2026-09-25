/**
 * The account-protection sheet (components/SsoEnrolSheet.tsx) starts its sign-in once each time it opens.
 *
 * Its effect used to start one whenever `visible`, `provider` or `identity` changed while it was open. At onboarding
 * step 3 the identity is welcome's `pendingIdentity`, and welcome's resume effect sets a new copy of it each time it
 * runs. It ran on every link the app received, including `beanpool://foreground` right after each Android sign-in,
 * so a member who had just picked their account was sent to Google, or Facebook, a second time. On main this already
 * happened to Facebook.
 *
 * The screen cannot be rendered here (see vitest.config.ts): `sheet` below is the effect as React runs it, driven by
 * the function the sheet calls, and the last test checks that the sheet does call it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { signInOnOpen } from '../sso-sheet-opening';

type Identity = { publicKey: string };

/** SsoEnrolSheet's auto-start effect: it runs when `visible`, `provider` or `identity` changed since the last render. */
function sheet() {
    let started = false;
    let starts = 0;
    let deps: unknown[] | null = null;
    return {
        render(visible: boolean, provider: string, identity: Identity | null) {
            const next = [visible, provider, identity];
            if (deps && next.every((d, i) => d === deps![i])) return;
            deps = next;
            const step = signInOnOpen(started, visible, !!identity);
            started = step.started;
            if (step.start) starts++;
        },
        get starts() { return starts; },
    };
}

const member = (): Identity => ({ publicKey: 'aa'.repeat(32) });

describe('the sheet starts its sign-in once per opening', () => {
    it('opening it starts the sign-in', () => {
        const s = sheet();
        s.render(false, 'google', member());
        expect(s.starts).toBe(0);
        s.render(true, 'google', member());
        expect(s.starts).toBe(1);
    });

    it('a new copy of the same identity while it is open does not start another (step 3 after a sign-in link)', () => {
        const s = sheet();
        s.render(true, 'facebook', member());
        for (let i = 0; i < 3; i++) s.render(true, 'facebook', member());
        expect(s.starts).toBe(1);
    });

    it('opening it again starts again', () => {
        const s = sheet();
        const id = member();
        s.render(true, 'google', id);
        s.render(false, 'google', id);
        s.render(true, 'google', id);
        expect(s.starts).toBe(2);
    });

    it('opened before the identity is there: starts when it arrives, once', () => {
        const s = sheet();
        s.render(true, 'google', null);
        expect(s.starts).toBe(0);
        s.render(true, 'google', member());
        s.render(true, 'google', member());
        expect(s.starts).toBe(1);
    });

    it('never starts while closed', () => {
        const s = sheet();
        s.render(false, 'google', null);
        s.render(false, 'google', member());
        s.render(false, 'facebook', member());
        expect(s.starts).toBe(0);
    });
});

describe('components/SsoEnrolSheet.tsx', () => {
    it('decides with signInOnOpen', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../components/SsoEnrolSheet.tsx'), 'utf-8');
        expect(src).toMatch(/signInOnOpen\(startedThisOpening\.current, visible, !!identity\)/);
    });
});
