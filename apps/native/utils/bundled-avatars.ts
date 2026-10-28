/**
 * Bundled avatar registry for BeanPool on the phone.
 *
 * Sourced from `@beanpool/core`'s universal AVATAR_PRESETS, mapped to local
 * require'd 512x512 WebP image assets.
 *
 * For ledger storage, we store the `id` as a reference (e.g., "bundled://bean-green")
 * to avoid bloating the ledger with redundant image data.
 */
import { ImageSourcePropType } from 'react-native';
import { AVATAR_PRESETS, type AvatarPreset, word, type WordKey } from '@beanpool/core';

// Ensure Node test runners (Vitest) can require .webp without failing on unknown extension
if (typeof process !== 'undefined' && process.versions?.node) {
    try {
        const Module = require('node:module');
        const Loader = Module.getBuiltinModule ? Module.getBuiltinModule('node:module') : Module;
        if (Loader?._extensions && !Loader._extensions['.webp']) {
            Loader._extensions['.webp'] = (m: { exports: unknown }) => { m.exports = 1; };
        }
    } catch {}
}

export interface BundledAvatar extends AvatarPreset {
    source: ImageSourcePropType;
}

const SOURCES: Record<string, ImageSourcePropType> = {
    'bean-green':  require('../assets/images/avatars/avatar_bean_green.webp'),
    'bean-purple': require('../assets/images/avatars/avatar_bean_purple.webp'),
    'leaf':        require('../assets/images/avatars/avatar_leaf.webp'),
    'sprout':      require('../assets/images/avatars/avatar_sprout.webp'),
    'sun':         require('../assets/images/avatars/avatar_sun.webp'),
    'moon':        require('../assets/images/avatars/avatar_moon.webp'),
    'wave':        require('../assets/images/avatars/avatar_wave.webp'),
    'mountain':    require('../assets/images/avatars/avatar_mountain.webp'),
    'fire':        require('../assets/images/avatars/avatar_fire.webp'),
    'crystal':     require('../assets/images/avatars/avatar_crystal.webp'),
    'sunflower':   require('../assets/images/avatars/avatar_sunflower.webp'),
    'mushroom':    require('../assets/images/avatars/avatar_mushroom.webp'),
    'honeybee':    require('../assets/images/avatars/avatar_honeybee.webp'),
    'butterfly':   require('../assets/images/avatars/avatar_butterfly.webp'),
    'wind':        require('../assets/images/avatars/avatar_wind.webp'),
    'rocket':      require('../assets/images/avatars/avatar_rocket.webp'),
    'atom':        require('../assets/images/avatars/avatar_atom.webp'),
    'planet':      require('../assets/images/avatars/avatar_planet.webp'),
    'robot':       require('../assets/images/avatars/avatar_robot.webp'),
    'bolt':        require('../assets/images/avatars/avatar_bolt.webp'),
    'satellite':   require('../assets/images/avatars/avatar_satellite.webp'),
    'solartree':   require('../assets/images/avatars/avatar_solartree.webp'),
    'portal':      require('../assets/images/avatars/avatar_portal.webp'),
    'cybereye':    require('../assets/images/avatars/avatar_cybereye.webp'),
};

/** Sourced from core's AVATAR_PRESETS, with native word() keys satisfying native words catalog. */
const NATIVE_LABELS: Record<string, WordKey> = {
    'bean-green':  word('Green Bean', 'avatar'),
    'bean-purple': word('Purple Bean', 'avatar'),
    'leaf':        word('Leaf', 'avatar'),
    'sprout':      word('Sprout', 'avatar'),
    'sun':         word('Sun', 'avatar'),
    'moon':        word('Moon', 'avatar'),
    'wave':        word('Wave', 'avatar'),
    'mountain':    word('Mountain', 'avatar'),
    'fire':        word('Fire', 'avatar'),
    'crystal':     word('Crystal', 'avatar'),
    'sunflower':   word('Sunflower', 'avatar'),
    'mushroom':    word('Mushroom', 'avatar'),
    'honeybee':    word('Honeybee', 'avatar'),
    'butterfly':   word('Butterfly', 'avatar'),
    'wind':        word('Wind', 'avatar'),
    'rocket':      word('Rocket', 'avatar'),
    'atom':        word('Quantum Atom', 'avatar'),
    'planet':      word('Ringed Planet', 'avatar'),
    'robot':       word('Cyber Mech', 'avatar'),
    'bolt':        word('Lightning', 'avatar'),
    'satellite':   word('Satellite', 'avatar'),
    'solartree':   word('Solar Tree', 'avatar'),
    'portal':      word('Stargate', 'avatar'),
    'cybereye':    word('Cyber Eye', 'avatar'),
};

export const BUNDLED_AVATARS: BundledAvatar[] = AVATAR_PRESETS.map((p) => ({
    ...p,
    label: NATIVE_LABELS[p.id] ?? p.label,
    source: SOURCES[p.id],
}));

/**
 * Resolve a bundled avatar ID to its require'd image source.
 * Returns null if the ID doesn't match any bundled avatar.
 */
export function resolveBundledAvatar(id: string | null | undefined): ImageSourcePropType | null {
    if (!id || typeof id !== 'string') return null;
    const cleaned = id.replace('bundled://', '').split('?')[0];
    return Object.prototype.hasOwnProperty.call(SOURCES, cleaned) ? SOURCES[cleaned] : null;
}
