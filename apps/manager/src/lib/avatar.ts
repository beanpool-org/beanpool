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
