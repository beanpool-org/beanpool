/**
 * App Lock's clock (utils/app-lock-clock.ts) and the since-boot clock it reads (modules/boot-clock).
 *
 * The return lock timed the member's absence on the wall clock, which whoever holds an unlocked phone can set back from the
 * phone's Settings (#1307's confirmation review, 2026-09-29). It reads the phone's since-boot clock now, which counts the
 * time the phone slept and which Settings can't move, and watches the wall clock for going backwards. The native module
 * is faked where the app reads it, on globalThis.expo.modules; the return lock's use of this is in return-lock.test.ts.
 *
 * A phone that can't read its since-boot clock gets no time at all (NaN), never the wall clock, and the reading is
 * counted: the return lock asks (#1309's deciding review, inline 4129453720). Only the web build reads the wall clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const platform = vi.hoisted(() => ({ os: 'android' }));
vi.mock('react-native', () => ({ Platform: { get OS() { return platform.os; } } }));

type ExpoGlobalForTests = { expo?: { modules: Record<string, { elapsedMs(): number }> } };
const expoGlobal = globalThis as ExpoGlobalForTests;

const START = new Date('2026-09-29T09:00:00Z');

function withBootClock(elapsedMs: () => number) {
    expoGlobal.expo = { modules: { BeanPoolBootClock: { elapsedMs } } };
}

async function freshClock() {
    vi.resetModules();
    return import('../app-lock-clock');
}

beforeEach(() => {
    platform.os = 'android';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
});
afterEach(() => {
    delete expoGlobal.expo;
    vi.useRealTimers();
});

describe('bootClockMs (modules/boot-clock)', () => {
    it("reads the native module's elapsedMs off globalThis.expo.modules.BeanPoolBootClock", async () => {
        const { bootClockMs, BOOT_CLOCK_MODULE } = await import('../../modules/boot-clock');
        expect(BOOT_CLOCK_MODULE).toBe('BeanPoolBootClock');
        withBootClock(() => 123456.5);
        expect(bootClockMs()).toBe(123456.5);
    });

    it.each([
        ['no Expo modules at all (the web build)', () => { delete expoGlobal.expo; }],
        ['no such module (a dev client built before it)', () => { expoGlobal.expo = { modules: {} }; }],
        ['a reading that throws', () => withBootClock(() => { throw new Error('native'); })],
        ['a reading that is not a number', () => withBootClock(() => Number.NaN)],
    ])('null with %s', async (_name, setUp) => {
        const { bootClockMs } = await import('../../modules/boot-clock');
        setUp();
        expect(bootClockMs()).toBeNull();
    });
});

describe('appLockNow', () => {
    it('reads the since-boot clock, not the wall clock', async () => {
        let boot = 5000;
        withBootClock(() => boot);
        const { appLockNow } = await freshClock();

        expect(appLockNow()).toBe(5000);
        boot += 3600 * 1000;
        vi.setSystemTime(START.getTime() - 3600 * 1000);
        expect(appLockNow()).toBe(5000 + 3600 * 1000);
    });

    it('reads the wall clock in the web build, where there is no since-boot clock and App Lock asks nothing', async () => {
        platform.os = 'web';
        const { appLockNow, clockReadFailures } = await freshClock();

        expect(appLockNow()).toBe(START.getTime());
        expect(clockReadFailures()).toBe(0);
    });

    it('the web build reads the wall clock even with a since-boot clock there', async () => {
        platform.os = 'web';
        withBootClock(() => 5000);
        const { appLockNow } = await freshClock();

        expect(appLockNow()).toBe(START.getTime());
    });

    it.each([
        ['no Expo modules at all', () => { delete expoGlobal.expo; }],
        ['no such module (a dev client built before it)', () => { expoGlobal.expo = { modules: {} }; }],
        ['a reading that throws', () => withBootClock(() => { throw new Error('native'); })],
        ['a reading that is NaN', () => withBootClock(() => Number.NaN)],
        ['a reading that is Infinity', () => withBootClock(() => Number.POSITIVE_INFINITY)],
        ['a reading that is a string', () => withBootClock(() => '5000' as unknown as number)],
    ])('on a phone, %s: no time (NaN), never the wall clock, and the reading counted as failed', async (_name, setUp) => {
        setUp();
        const { appLockNow, clockReadFailures } = await freshClock();

        expect(clockReadFailures()).toBe(0);
        expect(appLockNow()).toBeNaN();
        expect(clockReadFailures()).toBe(1);
        expect(appLockNow()).toBeNaN();
        expect(clockReadFailures()).toBe(2);
    });

    it.each(['ios', 'android'])('%s: a reading that fails once is counted once, and the next good reading reads the clock', async (os) => {
        platform.os = os;
        let fail = false;
        withBootClock(() => { if (fail) throw new Error('native'); return 5000; });
        const { appLockNow, clockReadFailures } = await freshClock();

        expect(appLockNow()).toBe(5000);
        fail = true;
        expect(appLockNow()).toBeNaN();
        fail = false;
        expect(appLockNow()).toBe(5000);
        expect(clockReadFailures()).toBe(1);
    });
});

describe('wallClockSetBacks: the wall clock seen going backwards from one reading to the next', () => {
    it.each([
        ['with the since-boot clock', true],
        ['without it', false],
    ])('%s', async (_name, hasBootClock) => {
        if (hasBootClock) withBootClock(() => 1);
        const { appLockNow, wallClockSetBacks } = await freshClock();

        appLockNow();
        expect(wallClockSetBacks()).toBe(0);
        vi.setSystemTime(START.getTime() + 60 * 1000);
        appLockNow();
        expect(wallClockSetBacks()).toBe(0);
        appLockNow();
        expect(wallClockSetBacks()).toBe(0);

        vi.setSystemTime(START.getTime() + 60 * 1000 - 1);
        expect(wallClockSetBacks()).toBe(0);
        appLockNow();
        expect(wallClockSetBacks()).toBe(1);
        appLockNow();
        expect(wallClockSetBacks()).toBe(1);

        vi.setSystemTime(START.getTime() - 3600 * 1000);
        appLockNow();
        expect(wallClockSetBacks()).toBe(2);
    });
});
