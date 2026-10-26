/**
 * The ready-made pictures (presets) offered across BeanPool for member avatars
 * and enterprise logos, on the phone and the web.
 *
 * Stored as a `bundled://<id>` reference (isBundledAvatar in avatar-url.ts).
 */
import { word, type WordKey } from './words.js';

export interface AvatarPreset {
    id: string;
    /** Its name, as a word() key: read to screen readers through t(), in the member's language. */
    label: WordKey;
}

export const AVATAR_PRESETS: readonly AvatarPreset[] = [
    { id: 'bean-green',   label: word('Green Bean', 'avatar') },
    { id: 'bean-purple',  label: word('Purple Bean', 'avatar') },
    { id: 'leaf',         label: word('Leaf', 'avatar') },
    { id: 'sprout',       label: word('Sprout', 'avatar') },
    { id: 'sun',          label: word('Sun', 'avatar') },
    { id: 'moon',         label: word('Moon', 'avatar') },
    { id: 'wave',         label: word('Wave', 'avatar') },
    { id: 'mountain',     label: word('Mountain', 'avatar') },
    { id: 'fire',         label: word('Fire', 'avatar') },
    { id: 'crystal',      label: word('Crystal', 'avatar') },
    { id: 'sunflower',    label: word('Sunflower', 'avatar') },
    { id: 'mushroom',     label: word('Mushroom', 'avatar') },
    { id: 'honeybee',     label: word('Honeybee', 'avatar') },
    { id: 'butterfly',    label: word('Butterfly', 'avatar') },
    { id: 'wind',         label: word('Wind', 'avatar') },
    { id: 'rocket',       label: word('Rocket', 'avatar') },
    { id: 'atom',         label: word('Quantum Atom', 'avatar') },
    { id: 'planet',       label: word('Ringed Planet', 'avatar') },
    { id: 'robot',        label: word('Cyber Mech', 'avatar') },
    { id: 'bolt',         label: word('Lightning', 'avatar') },
    { id: 'satellite',    label: word('Satellite', 'avatar') },
    { id: 'solartree',    label: word('Solar Tree', 'avatar') },
    { id: 'portal',       label: word('Stargate', 'avatar') },
    { id: 'cybereye',     label: word('Cyber Eye', 'avatar') },
] as const;

export type AvatarPresetId = (typeof AVATAR_PRESETS)[number]['id'];

/**
 * Returns the preset definition if `idOrUri` is a known preset, else null.
 * Accepts either the raw ID (e.g. "leaf") or the bundled protocol URI ("bundled://leaf").
 */
export function findAvatarPreset(idOrUri: string | null | undefined): AvatarPreset | null {
    if (!idOrUri) return null;
    const cleanId = idOrUri.replace('bundled://', '').split('?')[0];
    return AVATAR_PRESETS.find(p => p.id === cleanId) ?? null;
}

/**
 * Maps a public key deterministically to one of the 24 avatar preset IDs.
 * Stable, client-only: wherever an entity has no picture, this provides
 * a colorful deterministic preset rather than a bare initial-letter disc (Pictures S4).
 */
export function avatarPresetForPubkey(pubkey: string | null | undefined): AvatarPresetId {
    if (!pubkey || !pubkey.trim()) {
        return AVATAR_PRESETS[0].id;
    }
    const clean = pubkey.trim();
    // 32-bit FNV-1a hash
    let hash = 0x811c9dc5;
    for (let i = 0; i < clean.length; i++) {
        hash ^= clean.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    const index = Math.abs(hash >>> 0) % AVATAR_PRESETS.length;
    return AVATAR_PRESETS[index].id;
}

/**
 * Returns bundled://<id> for a public key deterministically.
 */
export function bundledAvatarForPubkey(pubkey: string | null | undefined): string {
    return `bundled://${avatarPresetForPubkey(pubkey)}`;
}

/**
 * Category emblems for groups (Pictures S4, §4.3):
 * - social -> sunflower
 * - general -> bean-green
 * - working_group -> solartree
 * - guild -> crystal
 */
export function defaultGroupEmblem(category: string | null | undefined): AvatarPresetId {
    switch (category) {
        case 'social':
            return 'sunflower';
        case 'working_group':
            return 'solartree';
        case 'guild':
            return 'crystal';
        case 'general':
        default:
            return 'bean-green';
    }
}

export function bundledGroupEmblem(category: string | null | undefined): string {
    return `bundled://${defaultGroupEmblem(category)}`;
}
