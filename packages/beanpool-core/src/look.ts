/**
 * The look a member picks in Settings → Appearance, and the one function both apps use to turn it into a colour set
 * (DESIGN-themes-fable.md §4, with Marty and Damo's decisions of 12 Nov 2026).
 *
 * Four choices, in the order the list shows them:
 *
 *   member sees      stored value   what is drawn
 *   Same as phone    `system`       Light when the device is light, Classic when it is dark
 *   Classic          `dark`         BeanPool Classic in dark: the olive pages (the colour set `dark`)
 *   Light            `light`        BeanPool Classic in light (the colour set `light`)
 *   Dark             `night`        charcoal and blue, always dark (the colour set `night`)
 *
 * The stored values are the colour sets' own names plus `system`, so `light`, `dark` and `system` mean what they always
 * meant on both apps and nothing stored is read as anything else or rewritten: a stored `dark` was Classic's dark before
 * this file, and is Classic now. (The word "dark" in code is Classic's dark column; what a member calls Dark is `night`.
 * See the header of brand-colours.ts.)
 *
 * Classic is the default on both apps (DEFAULT_LOOK). A value that is missing, or that this build does not know (a newer
 * build's, or junk), reads as Classic: it is a no-choice, and it is never "fixed" in storage. The choice is per device,
 * the same in every community, and never leaves it: no node stores it and no owner sets it.
 *
 * No English here: the names and lines are the apps' words (word() keys in each app's Settings). The web's
 * public/theme-boot.js cannot import this file, so it carries a copy of `resolveLook`, and the web's theme-boot.test.ts
 * runs the real file against this function for every stored state.
 *
 * Pure: no I/O, no Node built-ins, no regular expressions (the barrel is bundled for the phone).
 */

import { DEFAULT_BRAND_SET, type BrandSet } from './brand-colours.js';

/** What can be stored and chosen: follow the device, or one colour set. */
export type LookChoice = 'system' | BrandSet;

/**
 * Every choice, in the order Settings lists them: Same as phone, Classic, Light, Dark. The list is exactly these four;
 * a fifth look is a decision, so a test pins the list.
 */
export const LOOK_CHOICES: readonly LookChoice[] = ['system', 'dark', 'light', 'night'];

/** What a device with no choice stored gets: BeanPool Classic. Never written to storage (a change of default must reach it). */
export const DEFAULT_LOOK: LookChoice = DEFAULT_BRAND_SET;

/** A stored value as a choice, or null when it is not one this build knows (missing, junk, a newer build's). */
export function parseLook(raw: unknown): LookChoice | null {
    return typeof raw === 'string' && (LOOK_CHOICES as readonly string[]).includes(raw) ? (raw as LookChoice) : null;
}

/**
 * The colour set to draw. `deviceIsDark` is whether the phone or the browser is set to dark; with nothing known it is
 * false (a device that does not say is not dark). Anything that is not a choice is Classic.
 */
export function resolveLook(stored: unknown, deviceIsDark: boolean): BrandSet {
    const choice = parseLook(stored) ?? DEFAULT_LOOK;
    if (choice === 'system') return deviceIsDark ? 'dark' : 'light';
    return choice;
}

/**
 * The sets whose colours a row's swatch shows: Same as phone shows both of its two (the light page and the dark one),
 * every other row shows its own. Read each set's dots from `brandSwatch(set, app)`.
 */
export function lookSwatchSets(choice: LookChoice): BrandSet[] {
    return choice === 'system' ? ['light', 'dark'] : [choice];
}
