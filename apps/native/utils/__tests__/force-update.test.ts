/**
 * The full-screen "Update required" (utils/force-update.ts): what the community's answer means, and the safe moments it
 * may go up at. The node's half is apps/server/src/test-app-floors.ts.
 *
 * Nothing here contacts a node: the gate's clock and its question to the community are the test's.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    evaluateForceUpdate, createForceUpdateGate, checkCommunityForUpdate, appVersionHeaderValue,
    SAFE_RETURN_MS, DECIDE_WITHIN_MS, type ForceUpdateDecision,
} from '../force-update';

/** A node's health answer: Android's and iOS's floors, and the store versions it has seen. */
function health(opts: {
    android?: { min: string | null; blocking: boolean } | undefined;
    ios?: { min: string | null; blocking: boolean } | undefined;
    stores?: { android?: string | null; ios?: string | null } | undefined;
} = {}) {
    return {
        minAppVersion: '1.0.75',
        appFloors: {
            ...(opts.android !== undefined ? { android: opts.android } : {}),
            ...(opts.ios !== undefined ? { ios: opts.ios } : {}),
        },
        appVersions: { android: opts.stores?.android ?? null, ios: opts.stores?.ios ?? null, checkedAt: '2026-10-01T00:00:00.000Z' },
    };
}

const BLOCKING = health({ android: { min: '1.2.60', blocking: true }, ios: { min: '1.2.60', blocking: true }, stores: { android: '1.2.61', ios: '1.2.60' } });

describe('evaluateForceUpdate: what the answer means', () => {
    it('blocks an app below an enforced floor once the grace date has passed, and points at the store build', () => {
        expect(evaluateForceUpdate('1.2.57', BLOCKING, 'android')).toEqual({ kind: 'block', version: '1.2.61' });
        expect(evaluateForceUpdate('1.2.57', BLOCKING, 'ios')).toEqual({ kind: 'block', version: '1.2.60' });
    });

    it('lets an app at or above the floor carry on', () => {
        expect(evaluateForceUpdate('1.2.60', BLOCKING, 'android')).toEqual({ kind: 'clear' });
        expect(evaluateForceUpdate('1.3.0', BLOCKING, 'ios')).toEqual({ kind: 'clear' });
    });

    it('before the grace date: banner only, never the block', () => {
        const grace = health({ android: { min: '1.2.60', blocking: false }, stores: { android: '1.2.61' } });
        expect(evaluateForceUpdate('1.2.57', grace, 'android')).toEqual({ kind: 'clear' });
    });

    it('per platform: iOS held for its store while Android blocks', () => {
        // The node holds iOS's floor (min null) while Apple reviews 1.2.60; Android's store already has it.
        const lag = health({ android: { min: '1.2.60', blocking: true }, ios: { min: null, blocking: false }, stores: { android: '1.2.60', ios: '1.2.58' } });
        expect(evaluateForceUpdate('1.2.57', lag, 'android')).toEqual({ kind: 'block', version: '1.2.60' });
        expect(evaluateForceUpdate('1.2.57', lag, 'ios')).toEqual({ kind: 'clear' });
    });

    it('never holds anyone to a build the store does not have, whatever the node says', () => {
        // A node that (wrongly, or from before the hold) says block with a store below its floor.
        const behind = health({ android: { min: '1.3.0', blocking: true }, stores: { android: '1.2.61' } });
        expect(evaluateForceUpdate('1.2.57', behind, 'android')).toEqual({ kind: 'clear' });
        // And with no store version known at all.
        const unknownStore = health({ android: { min: '1.2.60', blocking: true }, stores: { android: null } });
        expect(evaluateForceUpdate('1.2.57', unknownStore, 'android')).toEqual({ kind: 'clear' });
    });

    it('unknown or unparseable versions never force anything', () => {
        expect(evaluateForceUpdate('nonsense', BLOCKING, 'android')).toEqual({ kind: 'clear' });
        expect(evaluateForceUpdate(undefined, BLOCKING, 'android')).toEqual({ kind: 'clear' });
        expect(evaluateForceUpdate('1.2.57', health({ android: { min: 'soon', blocking: true }, stores: { android: '1.2.61' } }), 'android')).toEqual({ kind: 'clear' });
        expect(evaluateForceUpdate('1.2.57', health({ android: { min: '1.2.60', blocking: true }, stores: { android: 'coming soon' } }), 'android')).toEqual({ kind: 'clear' });
        // `blocking` must be exactly true.
        expect(evaluateForceUpdate('1.2.57', health({ android: { min: '1.2.60', blocking: 'yes' as unknown as boolean }, stores: { android: '1.2.61' } }), 'android')).toEqual({ kind: 'clear' });
    });

    it('an older node with no floors has answered, and never blocks', () => {
        expect(evaluateForceUpdate('1.0.1', { minAppVersion: '1.2.60', appVersions: { android: '1.2.61' } }, 'android')).toEqual({ kind: 'clear' });
        expect(evaluateForceUpdate('1.0.1', health(), 'android')).toEqual({ kind: 'clear' });
    });

    it('no answer at all is unknown, not clear', () => {
        expect(evaluateForceUpdate('1.2.57', null, 'android')).toEqual({ kind: 'unknown' });
        expect(evaluateForceUpdate('1.2.57', 'oops', 'android')).toEqual({ kind: 'unknown' });
    });

    it('the web build has no store and is never blocked', () => {
        expect(evaluateForceUpdate('1.2.57', BLOCKING, 'web')).toEqual({ kind: 'clear' });
    });
});

/** A gate with a clock the test moves and a community whose answer the test sets, with how long it takes. */
function harness(start: ForceUpdateDecision | Error = { kind: 'clear' }) {
    let t = 1_000_000;
    let answer: ForceUpdateDecision | Error = start;
    let takes = 200;
    const shown: Array<{ version: string } | null> = [];
    const check = vi.fn(async () => {
        t += takes;
        if (answer instanceof Error) throw answer;
        return answer;
    });
    const gate = createForceUpdateGate({ now: () => t, check, show: (b) => shown.push(b) });
    return {
        gate, check, shown,
        set answer(a: ForceUpdateDecision | Error) { answer = a; },
        set takes(ms: number) { takes = ms; },
        advance(ms: number) { t += ms; },
        get current() { return shown.length ? shown[shown.length - 1] : null; },
    };
}

const BLOCK: ForceUpdateDecision = { kind: 'block', version: '1.2.61' };

describe('the safe moments', () => {
    it('cold start: the block goes up', async () => {
        const h = harness(BLOCK);
        await h.gate.start('active');
        expect(h.check).toHaveBeenCalledTimes(1);
        expect(h.current).toEqual({ version: '1.2.61' });
    });

    it('cold start: an app that may carry on sees nothing', async () => {
        const h = harness({ kind: 'clear' });
        await h.gate.start('active');
        expect(h.shown).toEqual([]);
    });

    it('never mid-use: a floor raised while the app is in front changes nothing, and nothing is asked', async () => {
        const h = harness({ kind: 'clear' });
        await h.gate.start('active');
        h.answer = BLOCK;
        // In use for an hour: no AppState change, no question, no block.
        h.advance(60 * 60 * 1000);
        expect(h.check).toHaveBeenCalledTimes(1);
        expect(h.shown).toEqual([]);
    });

    it('a short trip away is not a safe moment; five minutes or more is', async () => {
        const h = harness({ kind: 'clear' });
        await h.gate.start('active');
        h.answer = BLOCK;

        await h.gate.appStateChanged('background');
        h.advance(SAFE_RETURN_MS - 1000);
        await h.gate.appStateChanged('active');
        expect(h.check).toHaveBeenCalledTimes(1);
        expect(h.shown).toEqual([]);

        await h.gate.appStateChanged('background');
        h.advance(SAFE_RETURN_MS);
        await h.gate.appStateChanged('active');
        expect(h.check).toHaveBeenCalledTimes(2);
        expect(h.current).toEqual({ version: '1.2.61' });
    });

    it('away is timed from the first leave: inactive then background then back', async () => {
        const h = harness({ kind: 'clear' });
        await h.gate.start('active');
        h.answer = BLOCK;
        await h.gate.appStateChanged('inactive');
        h.advance(SAFE_RETURN_MS / 2);
        await h.gate.appStateChanged('background');
        h.advance(SAFE_RETURN_MS / 2);
        await h.gate.appStateChanged('active');
        expect(h.current).toEqual({ version: '1.2.61' });
    });

    it('a slow answer waits for the next safe moment rather than cover what the member has started', async () => {
        const h = harness(BLOCK);
        h.takes = DECIDE_WITHIN_MS + 1;
        await h.gate.start('active');
        expect(h.shown).toEqual([]);

        h.takes = 300;
        await h.gate.appStateChanged('background');
        h.advance(SAFE_RETURN_MS);
        await h.gate.appStateChanged('active');
        expect(h.current).toEqual({ version: '1.2.61' });
    });

    it('an answer that lands after the app has left does not put the block up', async () => {
        let release!: (d: ForceUpdateDecision) => void;
        let t = 0;
        const shown: unknown[] = [];
        const gate = createForceUpdateGate({
            now: () => t,
            check: () => new Promise<ForceUpdateDecision>(r => { release = r; }),
            show: (b) => shown.push(b),
        });
        const asked = gate.start('active');
        await gate.appStateChanged('background');
        t += 1000;
        release(BLOCK);
        await asked;
        expect(shown).toEqual([]);
    });

    it('an app the phone started in the background: its first time in front is the cold start', async () => {
        const h = harness(BLOCK);
        await h.gate.start('background');
        expect(h.check).not.toHaveBeenCalled();
        h.advance(5000);
        await h.gate.appStateChanged('active');
        expect(h.current).toEqual({ version: '1.2.61' });
    });

    it('no answer (offline, no community) never puts it up', async () => {
        const h = harness({ kind: 'unknown' });
        await h.gate.start('active');
        expect(h.shown).toEqual([]);
        const e = harness(new Error('network down'));
        await e.gate.start('active');
        expect(e.shown).toEqual([]);
    });

    it('a clock it cannot read makes no safe moment of a return', async () => {
        let t = 0;
        const check = vi.fn(async () => BLOCK);
        const shown: unknown[] = [];
        const gate = createForceUpdateGate({ now: () => t, check, show: (b) => shown.push(b) });
        await gate.start('background');
        // First time in front: asked, but its answer can't be timed, so it isn't shown.
        t = Number.NaN;
        await gate.appStateChanged('active');
        expect(shown).toEqual([]);
        await gate.appStateChanged('background');
        await gate.appStateChanged('active');
        expect(check).toHaveBeenCalledTimes(1);
        expect(shown).toEqual([]);
    });
});

describe('once it is up', () => {
    it('every return asks again, and an answer that no longer blocks takes it down', async () => {
        const h = harness(BLOCK);
        await h.gate.start('active');
        expect(h.current).toEqual({ version: '1.2.61' });

        // Off to the store and back in 20 seconds, without updating: still blocked.
        await h.gate.appStateChanged('background');
        h.advance(20_000);
        await h.gate.appStateChanged('active');
        expect(h.check).toHaveBeenCalledTimes(2);
        expect(h.current).toEqual({ version: '1.2.61' });

        // The operator lowers the floor: the next return takes it down.
        h.answer = { kind: 'clear' };
        await h.gate.appStateChanged('background');
        h.advance(10_000);
        await h.gate.appStateChanged('active');
        expect(h.current).toBeNull();
    });

    it('no answer keeps it as it is: unknown neither raises nor lowers', async () => {
        const h = harness(BLOCK);
        await h.gate.start('active');
        h.answer = { kind: 'unknown' };
        await h.gate.appStateChanged('background');
        h.advance(SAFE_RETURN_MS * 2);
        await h.gate.appStateChanged('active');
        expect(h.current).toEqual({ version: '1.2.61' });
    });

    it('a newer store build updates the version it names', async () => {
        const h = harness(BLOCK);
        await h.gate.start('active');
        h.answer = { kind: 'block', version: '1.2.62' };
        await h.gate.appStateChanged('background');
        await h.gate.appStateChanged('active');
        expect(h.current).toEqual({ version: '1.2.62' });
    });
});

describe('checkCommunityForUpdate: asking the active community', () => {
    const base = { localVersion: '1.2.57', platform: 'android' };

    it('asks the active community for its health and reads the answer', async () => {
        const fetchJson = vi.fn(async () => BLOCKING);
        const d = await checkCommunityForUpdate({ ...base, anchorUrl: async () => 'https://mullum.test', fetchJson });
        expect(fetchJson).toHaveBeenCalledWith('https://mullum.test/api/community/health', expect.any(Number));
        expect(d).toEqual({ kind: 'block', version: '1.2.61' });
    });

    it('no community on the phone, or no answer: unknown', async () => {
        expect(await checkCommunityForUpdate({ ...base, anchorUrl: async () => null, fetchJson: vi.fn() })).toEqual({ kind: 'unknown' });
        expect(await checkCommunityForUpdate({ ...base, anchorUrl: async () => 'https://mullum.test', fetchJson: async () => { throw new Error('timeout'); } }))
            .toEqual({ kind: 'unknown' });
        expect(await checkCommunityForUpdate({ ...base, anchorUrl: async () => { throw new Error('storage'); }, fetchJson: vi.fn() })).toEqual({ kind: 'unknown' });
    });

    it('an answer about a community the member switched away from meanwhile says nothing', async () => {
        let anchor = 'https://mullum.test';
        const d = await checkCommunityForUpdate({
            ...base,
            anchorUrl: async () => anchor,
            fetchJson: async () => { anchor = 'https://bellingen.test'; return BLOCKING; },
        });
        expect(d).toEqual({ kind: 'unknown' });
    });
});

describe('appVersionHeaderValue: the version the app names itself with', () => {
    it('on a phone: "<version> <platform>"', () => {
        expect(appVersionHeaderValue('1.2.57', 'android')).toBe('1.2.57 android');
        expect(appVersionHeaderValue('1.2.57', 'ios')).toBe('1.2.57 ios');
    });
    it('nothing from the web build, or for a version that is not one', () => {
        expect(appVersionHeaderValue('1.2.57', 'web')).toBeNull();
        expect(appVersionHeaderValue('1.2.57-dev', 'android')).toBeNull();
        expect(appVersionHeaderValue(undefined, 'ios')).toBeNull();
    });
});
