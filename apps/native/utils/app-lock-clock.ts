import { Platform } from 'react-native';
import { bootClockMs } from '../modules/boot-clock';

/**
 * App Lock's clock: what the return lock (utils/return-lock.ts) times the member's absence on, and what the prompt marker
 * (LocalAuth.phoneLockPrompt) stamps its stretches with, so the two compare like with like.
 *
 * The phone's since-boot clock (modules/boot-clock): it keeps counting while the phone sleeps, and nothing in the phone's
 * Settings moves it. The wall clock (Date.now) was used before, and whoever holds an unlocked phone while BeanPool is in
 * the background can set it back (turn off automatic time, pick an earlier time: most phones ask no PIN for that): an
 * hour away then read as a few seconds, and the app opened with no prompt. JS's own performance.now is no substitute:
 * on Android it is CLOCK_MONOTONIC, which stops while the phone is in deep sleep, so a long absence would read short.
 *
 * Only the web build, which has no since-boot clock and where App Lock has nothing to ask, reads the wall clock. A phone
 * that can't read its since-boot clock (a phone app built before the module, a reading that throws or isn't a time) gets
 * no time at all, NaN, never the wall clock: going back to it would switch the fix off with no sign (#1309's deciding
 * review). clockReadFailures counts those readings, and the return lock treats one at the leave, at the return or in
 * between as 15 seconds or more away; returnLockAction answers 'ask' for a time that isn't a number.
 *
 * Every reading also watches the wall clock. wallClockSetBacks counts the times it was seen going backwards from one
 * reading to the next: the return lock treats a set-back while the app was away as 15 seconds or more away. Belt and
 * braces over the since-boot clock, and, in the web build, the one guard against the wall clock being moved.
 */
const isWeb = Platform.OS === 'web';
let lastWall = -Infinity;
let setBacks = 0;
let failures = 0;

/** Milliseconds on App Lock's clock, NaN when a phone can't read it. Only the difference between two readings means anything. */
export function appLockNow(): number {
    const wall = Date.now();
    if (wall < lastWall) setBacks++;
    lastWall = wall;
    if (isWeb) return wall;
    const boot = bootClockMs();
    if (boot !== null) return boot;
    failures++;
    return Number.NaN;
}

/** How many times appLockNow has seen the wall clock go backwards since the app started. */
export function wallClockSetBacks(): number {
    return setBacks;
}

/** How many times appLockNow could not read the phone's since-boot clock since the app started (never in the web build). */
export function clockReadFailures(): number {
    return failures;
}
