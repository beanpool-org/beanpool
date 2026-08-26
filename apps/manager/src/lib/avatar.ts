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
        return BUNDLED_MAP[id] || null;
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
