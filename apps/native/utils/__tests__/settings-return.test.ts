import { describe, it, expect } from 'vitest';
import { linkRoutePath, isReturnFromSettings } from '../settings-return';

describe('links node Settings sends the member back with', () => {
    it('normalises the route whatever Android or iOS adds to it', () => {
        for (const p of ['beanpool://foreground', 'beanpool://foreground/', '/foreground', 'foreground?x=1', 'beanpool://foreground#y']) {
            expect(linkRoutePath(p)).toBe('foreground');
        }
        expect(linkRoutePath('beanpool://public-profile?publicKey=ab')).toBe('public-profile');
    });

    it('closes the in-app browser for "Back to the app" and "View my profile" only', () => {
        expect(isReturnFromSettings('beanpool://foreground')).toBe(true);
        expect(isReturnFromSettings(`beanpool://public-profile?publicKey=${'ab'.repeat(32)}`)).toBe(true);
        expect(isReturnFromSettings('beanpool://auth/github?code=1')).toBe(false);
        expect(isReturnFromSettings('beanpool://invite?code=BP-ABCD-EFGH')).toBe(false);
        expect(isReturnFromSettings('beanpool://public-profile-evil')).toBe(false);
    });
});
