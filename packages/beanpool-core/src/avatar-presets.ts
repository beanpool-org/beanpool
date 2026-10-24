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
