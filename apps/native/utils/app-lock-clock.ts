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
 * Where the app has no since-boot clock (the web build, a dev client built before the module) this is the wall clock.
 *
 * Every reading also watches the wall clock. wallClockSetBacks counts the times it was seen going backwards from one
 * reading to the next: the return lock treats a set-back while the app was away as 15 seconds or more away. Belt and
 * braces over the since-boot clock, and, where there is none, the one guard against the wall clock being moved.
 */
let lastWall = -Infinity;
let setBacks = 0;

/** Milliseconds on App Lock's clock. Only the difference between two readings means anything. */
export function appLockNow(): number {
    const wall = Date.now();
    if (wall < lastWall) setBacks++;
    lastWall = wall;
    return bootClockMs() ?? wall;
}

/** How many times appLockNow has seen the wall clock go backwards since the app started. */
export function wallClockSetBacks(): number {
    return setBacks;
}
