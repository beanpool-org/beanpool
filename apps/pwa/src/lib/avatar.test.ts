import { describe, it, expect } from 'vitest';
import { resolveAvatarUrl } from './avatar';

/**
 * What the node sends for a member's photo in every list (the member list since #1475; group rosters, the convenor and
 * inviter, enterprises, deals and crowdfunds since #1478) is its URL, relative to the node that serves this app:
 * `/api/avatar/<key>?size=thumb&v=<version>`, and on the global node `&k=<member-only key>` too. It is used as it is.
 */
describe('resolveAvatarUrl', () => {
    const pk = 'ab'.repeat(32);

    it("passes the node's photo URL through unchanged, its version and member-only key included", () => {
        expect(resolveAvatarUrl(`/api/avatar/${pk}?size=thumb&v=1a2b3c4d`)).toBe(`/api/avatar/${pk}?size=thumb&v=1a2b3c4d`);
        const keyed = `/api/avatar/${pk}?size=thumb&v=1a2b3c4d&k=AbCdEfGhIjKlMnOpQrSt_-`;
        expect(resolveAvatarUrl(keyed)).toBe(keyed);
    });

    it("passes a group's own picture URL through unchanged, its version and key included (#1486)", () => {
        // The node sends a group's picture the same way, relative and keyed on every node: /api/groups/<id>/picture.
        const keyed = '/api/groups/g-seeds/picture?v=1a2b3c4d&k=GrOuPkEyGrOuPkEyGrOu_-';
        expect(resolveAvatarUrl(keyed)).toBe(keyed);
    });

    it('maps a shipped picture to the app\'s own file, and reads nothing as no photo', () => {
        expect(resolveAvatarUrl('bundled://leaf')).toBe('/avatars/avatar_leaf.jpg');
        expect(resolveAvatarUrl(null)).toBeNull();
        expect(resolveAvatarUrl(undefined)).toBeNull();
        expect(resolveAvatarUrl('')).toBeNull();
    });

    it('still shows a photo an older node sends inline', () => {
        const inline = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
        expect(resolveAvatarUrl(inline)).toBe(inline);
    });
});
