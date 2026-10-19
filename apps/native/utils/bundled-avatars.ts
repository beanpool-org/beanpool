/**
 * Bundled avatar registry for the "Who Are You?" onboarding gate.
 * 
 * These are pre-built 512x512 icons that new users can select as their
 * profile picture without needing camera/gallery access. They're themed
 * to BeanPool's organic community aesthetic.
 * 
 * For ledger storage, we store the `id` as a reference (e.g., "bundled://bean-green")
 * to avoid bloating the ledger with redundant image data.
 */
import { ImageSourcePropType } from 'react-native';
import { word, type WordKey } from '@beanpool/core';

export interface BundledAvatar {
    id: string;
    /** Its name, as a word() key: the picker reads it to TalkBack through t(), in the member's language (its context keeps 'Sun' or 'Fire' apart from the same word elsewhere). */
    label: WordKey;
    source: ImageSourcePropType;
}

export const BUNDLED_AVATARS: BundledAvatar[] = [
    { id: 'bean-green',   label: word('Green Bean', 'avatar'),    source: require('../assets/images/avatars/avatar_bean_green.jpg') },
    { id: 'bean-purple',  label: word('Purple Bean', 'avatar'),   source: require('../assets/images/avatars/avatar_bean_purple.jpg') },
    { id: 'leaf',         label: word('Leaf', 'avatar'),          source: require('../assets/images/avatars/avatar_leaf.jpg') },
    { id: 'sprout',       label: word('Sprout', 'avatar'),        source: require('../assets/images/avatars/avatar_sprout.jpg') },
    { id: 'sun',          label: word('Sun', 'avatar'),           source: require('../assets/images/avatars/avatar_sun.jpg') },
    { id: 'moon',         label: word('Moon', 'avatar'),          source: require('../assets/images/avatars/avatar_moon.jpg') },
    { id: 'wave',         label: word('Wave', 'avatar'),          source: require('../assets/images/avatars/avatar_wave.jpg') },
    { id: 'mountain',     label: word('Mountain', 'avatar'),      source: require('../assets/images/avatars/avatar_mountain.jpg') },
    { id: 'fire',         label: word('Fire', 'avatar'),          source: require('../assets/images/avatars/avatar_fire.jpg') },
    { id: 'crystal',      label: word('Crystal', 'avatar'),       source: require('../assets/images/avatars/avatar_crystal.jpg') },
    { id: 'sunflower',    label: word('Sunflower', 'avatar'),     source: require('../assets/images/avatars/avatar_sunflower.jpg') },
    { id: 'mushroom',     label: word('Mushroom', 'avatar'),      source: require('../assets/images/avatars/avatar_mushroom.jpg') },
    { id: 'honeybee',     label: word('Honeybee', 'avatar'),      source: require('../assets/images/avatars/avatar_honeybee.jpg') },
    { id: 'butterfly',    label: word('Butterfly', 'avatar'),     source: require('../assets/images/avatars/avatar_butterfly.jpg') },
    { id: 'wind',         label: word('Wind', 'avatar'),          source: require('../assets/images/avatars/avatar_wind.jpg') },
    { id: 'rocket',       label: word('Rocket', 'avatar'),        source: require('../assets/images/avatars/avatar_rocket.jpg') },
    { id: 'atom',         label: word('Quantum Atom', 'avatar'),  source: require('../assets/images/avatars/avatar_atom.jpg') },
    { id: 'planet',       label: word('Ringed Planet', 'avatar'), source: require('../assets/images/avatars/avatar_planet.jpg') },
    { id: 'robot',        label: word('Cyber Mech', 'avatar'),    source: require('../assets/images/avatars/avatar_robot.jpg') },
    { id: 'bolt',         label: word('Lightning', 'avatar'),     source: require('../assets/images/avatars/avatar_bolt.jpg') },
    { id: 'satellite',    label: word('Satellite', 'avatar'),     source: require('../assets/images/avatars/avatar_satellite.jpg') },
    { id: 'solartree',    label: word('Solar Tree', 'avatar'),    source: require('../assets/images/avatars/avatar_solartree.jpg') },
    { id: 'portal',       label: word('Stargate', 'avatar'),      source: require('../assets/images/avatars/avatar_portal.jpg') },
    { id: 'cybereye',     label: word('Cyber Eye', 'avatar'),     source: require('../assets/images/avatars/avatar_cybereye.jpg') },
];

/**
 * Resolve a bundled avatar ID to its require'd image source.
 * Returns null if the ID doesn't match any bundled avatar.
 */
export function resolveBundledAvatar(id: string): ImageSourcePropType | null {
    const cleaned = id.replace('bundled://', '').split('?')[0];
    const avatar = BUNDLED_AVATARS.find(a => a.id === cleaned);
    return avatar?.source ?? null;
}
