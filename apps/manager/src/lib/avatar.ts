/**
 * Manager avatar URL resolver.
 * 
 * Maps bundled:// protocol references (stored in member profiles/ledger) to
 * static asset paths served from /avatars/.
 */

const BUNDLED_MAP: Record<string, string> = {
    'bean-green':  '/avatars/avatar_bean_green.jpg',
    'bean-purple': '/avatars/avatar_bean_purple.jpg',
    'leaf':        '/avatars/avatar_leaf.jpg',
    'sprout':      '/avatars/avatar_sprout.jpg',
    'sun':         '/avatars/avatar_sun.jpg',
    'moon':        '/avatars/avatar_moon.jpg',
    'wave':        '/avatars/avatar_wave.jpg',
    'mountain':    '/avatars/avatar_mountain.jpg',
    'fire':        '/avatars/avatar_fire.jpg',
    'crystal':     '/avatars/avatar_crystal.jpg',
    'sunflower':   '/avatars/avatar_sunflower.jpg',
    'mushroom':    '/avatars/avatar_mushroom.jpg',
    'honeybee':    '/avatars/avatar_honeybee.jpg',
    'butterfly':   '/avatars/avatar_butterfly.jpg',
    'wind':        '/avatars/avatar_wind.jpg',
    'rocket':      '/avatars/avatar_rocket.jpg',
    'atom':        '/avatars/avatar_atom.jpg',
    'planet':      '/avatars/avatar_planet.jpg',
    'robot':       '/avatars/avatar_robot.jpg',
    'bolt':        '/avatars/avatar_bolt.jpg',
    'satellite':   '/avatars/avatar_satellite.jpg',
    'solartree':   '/avatars/avatar_solartree.jpg',
    'portal':      '/avatars/avatar_portal.jpg',
    'cybereye':    '/avatars/avatar_cybereye.jpg',
};

export function resolveAvatarUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    if (url.startsWith('bundled://')) {
        const id = url.replace('bundled://', '').split('?')[0];
        return Object.prototype.hasOwnProperty.call(BUNDLED_MAP, id) ? BUNDLED_MAP[id] : null;
    }
    if (Object.prototype.hasOwnProperty.call(BUNDLED_MAP, url)) {
        return BUNDLED_MAP[url];
    }
    const isAllowedSource =
        url.startsWith('/') ||
        url.startsWith('https://') ||
        url.startsWith('http://') ||
        /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(url);
    if (!isAllowedSource) return null;
    if (/["'()\\\s<>]/.test(url)) return null;
    return url;
}

const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : null;

export function isShortEmoji(str: string | null | undefined): boolean {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (!trimmed || trimmed.length > 32) return false;
    if (/[a-zA-Z0-9:/\\._?&=#%<>]/.test(trimmed)) return false;
    if (graphemeSegmenter) {
        const segments = Array.from(graphemeSegmenter.segment(trimmed));
        if (segments.length > 2) return false;
    }
    return /^[\p{Extended_Pictographic}\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Component}\uFE0E\uFE0F\u200D\s]+$/u.test(trimmed);
}
