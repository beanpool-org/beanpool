/**
 * The picture behind the phone's top bar (the bean, the help, the invite and the Settings icons), one per colour set
 * (colour themes, slice T5; Marty, 12 Nov 2026: "no green in Dark").
 *
 * Classic and Light draw the leafy neon-vines banner they always have. Dark (`night`) draws its charcoal one, baked from the
 * same art by scripts/bake-dark-doodle.mjs: the same bytes as the web's `vines-banner-night.jpg`, so the phone and the web
 * agree. Keyed by the set, not by the scheme: Classic and Dark are both dark by scheme. `Record<BrandSet, ...>` means a new
 * set cannot ship without a banner chosen for it (naming the neon one is a choice, made in the open).
 *
 * Each entry is a function so the picture is loaded when the header draws, as the header always did, not when this file is
 * imported. A value this build does not know falls back to Classic's, as resolveSet does for a stored look it does not know.
 */
import type { BrandSet } from '@beanpool/core';

const BANNERS: Record<BrandSet, () => number> = {
    light: () => require('../assets/images/neon-vines-banner.jpg'),
    dark: () => require('../assets/images/neon-vines-banner.jpg'),
    night: () => require('../assets/images/vines-banner-night.jpg'),
};

export function headerBanner(set: BrandSet | undefined): number {
    return (BANNERS[set as BrandSet] ?? BANNERS.dark)();
}
