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

export interface BundledAvatar {
    id: string;
    label: string;
    source: ImageSourcePropType;
}

export const BUNDLED_AVATARS: BundledAvatar[] = [
    { id: 'bean-green',   label: 'Green Bean',    source: require('../assets/images/avatars/avatar_bean_green.jpg') },
    { id: 'bean-purple',  label: 'Purple Bean',   source: require('../assets/images/avatars/avatar_bean_purple.jpg') },
    { id: 'leaf',         label: 'Leaf',          source: require('../assets/images/avatars/avatar_leaf.jpg') },
    { id: 'sprout',       label: 'Sprout',        source: require('../assets/images/avatars/avatar_sprout.jpg') },
    { id: 'sun',          label: 'Sun',           source: require('../assets/images/avatars/avatar_sun.jpg') },
    { id: 'moon',         label: 'Moon',          source: require('../assets/images/avatars/avatar_moon.jpg') },
    { id: 'wave',         label: 'Wave',          source: require('../assets/images/avatars/avatar_wave.jpg') },
    { id: 'mountain',     label: 'Mountain',      source: require('../assets/images/avatars/avatar_mountain.jpg') },
    { id: 'fire',         label: 'Fire',          source: require('../assets/images/avatars/avatar_fire.jpg') },
    { id: 'crystal',      label: 'Crystal',       source: require('../assets/images/avatars/avatar_crystal.jpg') },
    { id: 'sunflower',    label: 'Sunflower',     source: require('../assets/images/avatars/avatar_sunflower.jpg') },
    { id: 'mushroom',     label: 'Mushroom',      source: require('../assets/images/avatars/avatar_mushroom.jpg') },
    { id: 'honeybee',     label: 'Honeybee',      source: require('../assets/images/avatars/avatar_honeybee.jpg') },
    { id: 'butterfly',    label: 'Butterfly',     source: require('../assets/images/avatars/avatar_butterfly.jpg') },
    { id: 'wind',         label: 'Wind',          source: require('../assets/images/avatars/avatar_wind.jpg') },
    { id: 'rocket',       label: 'Rocket',        source: require('../assets/images/avatars/avatar_rocket.jpg') },
    { id: 'atom',         label: 'Quantum Atom',  source: require('../assets/images/avatars/avatar_atom.jpg') },
    { id: 'planet',       label: 'Ringed Planet', source: require('../assets/images/avatars/avatar_planet.jpg') },
    { id: 'robot',        label: 'Cyber Mech',    source: require('../assets/images/avatars/avatar_robot.jpg') },
    { id: 'bolt',         label: 'Lightning',     source: require('../assets/images/avatars/avatar_bolt.jpg') },
    { id: 'satellite',    label: 'Satellite',     source: require('../assets/images/avatars/avatar_satellite.jpg') },
    { id: 'solartree',    label: 'Solar Tree',    source: require('../assets/images/avatars/avatar_solartree.jpg') },
    { id: 'portal',       label: 'Stargate',      source: require('../assets/images/avatars/avatar_portal.jpg') },
    { id: 'cybereye',     label: 'Cyber Eye',     source: require('../assets/images/avatars/avatar_cybereye.jpg') },
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
