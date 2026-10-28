/**
 * PWA avatar URL resolver.
 * 
 * Maps bundled:// protocol references (stored in the ledger) to local
 * static asset paths served from /avatars/. Falls through for regular
 * URLs, data URIs, and null values.
 *
 * When url is absent and a pubkey is provided (Marty's addition, Pictures S4),
 * resolves deterministically to the pubkey's ready-made preset avatar.
 */
import { avatarPresetForPubkey } from '@beanpool/core';

const BUNDLED_MAP: Record<string, string> = {
    'bean-green':  '/avatars/avatar_bean_green.webp',
    'bean-purple': '/avatars/avatar_bean_purple.webp',
    'leaf':        '/avatars/avatar_leaf.webp',
    'sprout':      '/avatars/avatar_sprout.webp',
    'sun':         '/avatars/avatar_sun.webp',
    'moon':        '/avatars/avatar_moon.webp',
    'wave':        '/avatars/avatar_wave.webp',
    'mountain':    '/avatars/avatar_mountain.webp',
    'fire':        '/avatars/avatar_fire.webp',
    'crystal':     '/avatars/avatar_crystal.webp',
    'sunflower':   '/avatars/avatar_sunflower.webp',
    'mushroom':    '/avatars/avatar_mushroom.webp',
    'honeybee':    '/avatars/avatar_honeybee.webp',
    'butterfly':   '/avatars/avatar_butterfly.webp',
    'wind':        '/avatars/avatar_wind.webp',
    'rocket':      '/avatars/avatar_rocket.webp',
    'atom':        '/avatars/avatar_atom.webp',
    'planet':      '/avatars/avatar_planet.webp',
    'robot':       '/avatars/avatar_robot.webp',
    'bolt':        '/avatars/avatar_bolt.webp',
    'satellite':   '/avatars/avatar_satellite.webp',
    'solartree':   '/avatars/avatar_solartree.webp',
    'portal':      '/avatars/avatar_portal.webp',
    'cybereye':    '/avatars/avatar_cybereye.webp',
};

export function resolveAvatarUrl(url: string | null | undefined, pubkey?: string | null): string | null {
    if (!url || !url.trim()) {
        if (pubkey && pubkey.trim()) {
            const presetId = avatarPresetForPubkey(pubkey);
            return BUNDLED_MAP[presetId] || null;
        }
        return null;
    }
    if (url.startsWith('bundled://')) {
        const id = url.replace('bundled://', '').split('?')[0];
        return BUNDLED_MAP[id] || null;
    }
    // SECURITY (PWA-2): the result feeds both <img src> and a CSS url(), and the
    // value is server-controlled. Only allow inert, trusted sources — same-origin
    // paths, https, and raster (non-SVG) data URIs — and reject any value with
    // characters that could break out of a CSS url(...) or HTML attribute context
    // (which also blocks javascript:/other-scheme beacons and SVG-script payloads).
    const isAllowedSource =
        url.startsWith('/') ||
        url.startsWith('https://') ||
        /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(url);
    if (!isAllowedSource) return null;
    if (/["'()\\\s<>]/.test(url)) return null;
    return url;
}

export const resolveImageUrl = resolveAvatarUrl;
