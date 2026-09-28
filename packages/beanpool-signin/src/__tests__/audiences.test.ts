import { describe, expect, it } from 'vitest';
import {
    BEANPOOL_APPLE_BUNDLE_ID,
    BEANPOOL_APPLE_SERVICES_ID,
    BEANPOOL_FACEBOOK_APP_ID,
    BEANPOOL_GITHUB_CLIENT_IDS,
    BEANPOOL_GOOGLE_CLIENT_IDS,
    configuredAudiences,
    SsoVerificationError,
    webClientIds,
} from '../index.js';

/** Which client ids are accepted. With no settings (the key vault): BeanPool's own, and nothing else. */
describe('audiences', () => {
    it('with no settings, accepts BeanPool\'s own ids only', () => {
        expect(configuredAudiences('google')).toEqual([...BEANPOOL_GOOGLE_CLIENT_IDS]);
        expect(configuredAudiences('apple')).toEqual([BEANPOOL_APPLE_BUNDLE_ID, BEANPOOL_APPLE_SERVICES_ID]);
        expect(configuredAudiences('facebook')).toEqual([BEANPOOL_FACEBOOK_APP_ID]);
        expect(configuredAudiences('github')).toEqual([...BEANPOOL_GITHUB_CLIENT_IDS]);
        expect(webClientIds()).toEqual({
            google: BEANPOOL_GOOGLE_CLIENT_IDS[0],
            apple: BEANPOOL_APPLE_SERVICES_ID,
            facebook: BEANPOOL_FACEBOOK_APP_ID,
        });
    });

    it('adds a node\'s one extra Facebook or GitHub id, and swaps its Apple Services ID', () => {
        const settings = { facebookAppId: ' 123 ', githubClientId: 'gh-own', appleServicesId: 'org.example.signin' };
        expect(configuredAudiences('facebook', settings)).toEqual([BEANPOOL_FACEBOOK_APP_ID, '123']);
        expect(configuredAudiences('github', settings)).toEqual([...BEANPOOL_GITHUB_CLIENT_IDS, 'gh-own']);
        expect(configuredAudiences('apple', settings)).toEqual([BEANPOOL_APPLE_BUNDLE_ID, 'org.example.signin']);
        // The same id twice is listed once.
        expect(configuredAudiences('apple', { appleServicesId: BEANPOOL_APPLE_BUNDLE_ID })).toEqual([BEANPOOL_APPLE_BUNDLE_ID]);
    });

    it('lets a replacement list replace the defaults, trimmed, blank meaning the defaults', () => {
        expect(configuredAudiences('google', { replace: { google: ' a , ,  b ' } })).toEqual(['a', 'b']);
        expect(configuredAudiences('google', { replace: { google: '   ' } })).toEqual([...BEANPOOL_GOOGLE_CLIENT_IDS]);
        // A browser signs in to Apple only with a Services ID the node still accepts.
        expect(webClientIds({ replace: { apple: 'com.operator.app' } }).apple).toBeNull();
    });

    it('refuses a provider it does not know by name', () => {
        expect(() => configuredAudiences('twitter' as never)).toThrow(SsoVerificationError);
        expect(() => configuredAudiences('twitter' as never)).toThrow("Unknown sign-in provider 'twitter'.");
    });
});
