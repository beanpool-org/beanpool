import { describe, it, expect, afterEach } from 'vitest';
import {
    configureGroupPictureKeys,
    groupPictureUrlOf,
    isSelfAvatarUrl,
    isSelfGroupPictureUrl,
} from '../avatar-url.js';

describe("a group's own picture URL (#1486)", () => {
    afterEach(() => configureGroupPictureKeys(null));

    it('is made from the reference alone: none, a shipped name, or the route with its version and key', () => {
        expect(groupPictureUrlOf('g-1', null)).toBeNull();
        expect(groupPictureUrlOf('g-1', '')).toBeNull();
        expect(groupPictureUrlOf('g-1', 'bundled://leaf')).toBe('bundled://leaf');
        expect(groupPictureUrlOf('g-1', 'a1b2c3d4')).toBe('/api/groups/g-1/picture?v=a1b2c3d4');
        configureGroupPictureKeys((id, version) => `key-${id}-${version}`);
        expect(groupPictureUrlOf('g-1', 'a1b2c3d4')).toBe('/api/groups/g-1/picture?v=a1b2c3d4&k=key-g-1-a1b2c3d4');
        expect(groupPictureUrlOf('g 1/x', 'a1b2c3d4')).toBe('/api/groups/g%201%2Fx/picture?v=a1b2c3d4&k=key-g 1/x-a1b2c3d4');
    });

    it('is told apart from anything else when an editor sends it back', () => {
        for (const own of [
            '/api/groups/g-1/picture?v=a1b2c3d4&k=AAAAAAAAAAAAAAAAAAAAAA',
            '/api/groups/g-1/picture',
            'https://other.example/api/groups/g-1/picture?v=a1b2c3d4&_v=123',
            '  /api/groups/g-1/picture?v=a1b2c3d4  ',
        ]) expect(isSelfGroupPictureUrl(own), own).toBe(true);
        for (const other of [
            'data:image/jpeg;base64,QUJD', 'bundled://leaf', '/api/groups/g-1', '/api/groups/g-1/members',
            '/api/avatar/abc?size=thumb&v=a1b2c3d4', '/api/groups/g-1/picture/more', null, 42,
        ]) expect(isSelfGroupPictureUrl(other), String(other)).toBe(false);
        expect(isSelfAvatarUrl('/api/groups/g-1/picture?v=a1b2c3d4')).toBe(false);
    });
});
