/**
 * The phone's since-boot clock (android/.../BootClockModule.kt, ios/BootClockModule.swift): milliseconds since the phone
 * last started, counting the time it slept, and nothing in the phone's Settings can move it. Only the difference between
 * two readings means anything. App Lock times the member's absence with it: utils/app-lock-clock.ts.
 *
 * null where the app has no such clock: the web build, and a phone app built before this module was added (a dev
 * client). App Lock then reads the wall clock.
 *
 * Read off globalThis.expo.modules, the host object the Expo runtime puts every native module on (requireOptionalNativeModule
 * looks there first; LocalAuth.ts's expo-local-authentication import has made sure it is there before any reading). Not
 * through expo-modules-core: it does not load in the node test runner (vitest.config.ts), and LocalAuth.ts, which every
 * phone-lock test loads, reads this clock.
 */
export const BOOT_CLOCK_MODULE = 'BeanPoolBootClock';

type BootClock = { elapsedMs(): number };

export function bootClockMs(): number | null {
    const clock = (globalThis as { expo?: { modules?: Record<string, BootClock | undefined> } }).expo?.modules?.[BOOT_CLOCK_MODULE];
    if (!clock) return null;
    try {
        const ms = clock.elapsedMs();
        return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
    } catch {
        return null;
    }
}
