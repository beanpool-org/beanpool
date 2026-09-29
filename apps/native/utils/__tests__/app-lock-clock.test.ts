/**
 * App Lock's clock (utils/app-lock-clock.ts) and the since-boot clock it reads (modules/boot-clock).
 *
 * The return lock timed the member's absence on the wall clock, which whoever holds an unlocked phone can set back from the
 * phone's Settings (#1307's confirmation review, 2026-09-29). It reads the phone's since-boot clock now, which counts the
 * time the phone slept and which Settings can't move, and watches the wall clock for going backwards. The native module
 * is faked where the app reads it, on globalThis.expo.modules; the return lock's use of this is in return-lock.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

    it('reads the wall clock where there is no since-boot clock', async () => {
        const { appLockNow } = await freshClock();

        expect(appLockNow()).toBe(START.getTime());
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
