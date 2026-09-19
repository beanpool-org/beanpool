import { describe, it, expect, vi } from 'vitest';
import { takeProfileFragment } from './profile-link';

function fakeWin(hash: string) {
    const replaceState = vi.fn();
    return { win: { location: { hash, pathname: '/app', search: '' }, history: { state: null, replaceState } } as any, replaceState };
}

describe('/app#profile=<key> (node Settings → View my profile)', () => {
    it('returns the key and takes it out of the address bar', () => {
        const key = 'AB'.repeat(32);
        const { win, replaceState } = fakeWin(`#profile=${key}`);
        expect(takeProfileFragment(win)).toBe(key.toLowerCase());
        expect(replaceState).toHaveBeenCalledWith(null, '', '/app');
    });

    it('ignores anything that is not a public key, but still cleans the address bar', () => {
        const { win, replaceState } = fakeWin('#profile=<script>');
        expect(takeProfileFragment(win)).toBeNull();
        expect(replaceState).toHaveBeenCalled();
    });

    it('leaves other fragments alone', () => {
        const { win, replaceState } = fakeWin('#something');
        expect(takeProfileFragment(win)).toBeNull();
        expect(replaceState).not.toHaveBeenCalled();
    });
});
