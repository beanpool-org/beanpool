import { describe, it, expect } from 'vitest';
import { normaliseVersion, isVersionOlder, pickStoreVersion, evaluateUpdate } from '../app-version';

describe('normaliseVersion', () => {
    it("strips Apple's capital V — the bug that made the iOS banner impossible", () => {
        // itunes.apple.com/lookup answers "V1.2.31" for org.beanpool.pillar. The old
        // parser did split('.').map(Number) and read [NaN, 2, 31], then coerced the NaN
        // to 0, so the store always looked like version 0 and the app always looked newer.
        expect(normaliseVersion('V1.2.31')).toBe('1.2.31');
    });

    it('accepts an ordinary version and trims decoration', () => {
        expect(normaliseVersion('1.2.31')).toBe('1.2.31');
        expect(normaliseVersion(' 1.2.31 ')).toBe('1.2.31');
        expect(normaliseVersion('1.2')).toBe('1.2');
    });

    it('refuses anything that is not a version rather than half-parsing it', () => {
        expect(normaliseVersion('coming soon')).toBeNull();
        expect(normaliseVersion('1..31')).toBeNull();
        expect(normaliseVersion('1.2.3.4')).toBeNull();
        expect(normaliseVersion('')).toBeNull();
        expect(normaliseVersion(null)).toBeNull();
        expect(normaliseVersion(undefined)).toBeNull();
        expect(normaliseVersion(12)).toBeNull();
    });

    it('rejects a hyphenated build tag instead of scrubbing it into a real version', () => {
        // Stripping every non-digit would turn "1.2.3-1" into "1.2.31" — a version that
        // exists, is wrong, and would tell someone on 1.2.4 they are 27 releases behind.
        expect(normaliseVersion('1.2.3-1')).toBeNull();
        expect(normaliseVersion('1.2.31-beta')).toBeNull();
        expect(normaliseVersion('1.2.31 (253)')).toBeNull();
    });
});

describe('isVersionOlder', () => {
    it('compares a decorated store version correctly', () => {
        expect(isVersionOlder('1.2.30', 'V1.2.31')).toBe(true);
        expect(isVersionOlder('1.2.31', 'V1.2.31')).toBe(false);
        expect(isVersionOlder('1.2.32', 'V1.2.31')).toBe(false);
    });

    it('orders each segment numerically, not lexically', () => {
        expect(isVersionOlder('1.2.9', '1.2.10')).toBe(true);
        expect(isVersionOlder('1.9.0', '1.10.0')).toBe(true);
        expect(isVersionOlder('2.0.0', '1.99.99')).toBe(false);
        expect(isVersionOlder('1.2', '1.2.1')).toBe(true);
    });

    it('never reports "older" when either side is unparseable', () => {
        // A banner raised by a garbage string is one the user cannot clear.
        expect(isVersionOlder('1.2.31', 'unknown')).toBe(false);
        expect(isVersionOlder('nonsense', '1.2.31')).toBe(false);
    });
});

describe('pickStoreVersion', () => {
    const payload = { android: '1.2.31', ios: 'V1.2.31', checkedAt: '2026-09-06T00:00:00.000Z' };

    it('reads the platform it is running on', () => {
        expect(pickStoreVersion(payload, 'ios')).toBe('1.2.31');
        expect(pickStoreVersion(payload, 'android')).toBe('1.2.31');
    });

    it('has no store to point at on web', () => {
        expect(pickStoreVersion(payload, 'web')).toBeNull();
    });

    it('handles a node that has not looked the versions up yet', () => {
        expect(pickStoreVersion({ android: null, ios: null, checkedAt: null }, 'android')).toBeNull();
        // An older node sends no appVersions field at all.
        expect(pickStoreVersion(undefined, 'android')).toBeNull();
        expect(pickStoreVersion(null, 'ios')).toBeNull();
    });
});

describe('evaluateUpdate', () => {
    it('shows nothing when the installed build is current — the state today', () => {
        // app.json is 1.2.31 and both stores are on 1.2.31.
        expect(evaluateUpdate('1.2.31', '1.2.31', '1.0.75')).toEqual({ kind: 'none' });
    });

    it('offers a dismissible update when the store is ahead', () => {
        expect(evaluateUpdate('1.2.30', '1.2.31', '1.0.75')).toEqual({ kind: 'available', version: '1.2.31' });
    });

    it('requires an update below the node floor, and points at the newest build', () => {
        expect(evaluateUpdate('1.0.70', '1.2.31', '1.0.75')).toEqual({ kind: 'required', version: '1.2.31' });
    });

    it('falls back to the floor itself when no store version is known', () => {
        // An older node sends minAppVersion but no appVersions. The floor is the only thing
        // we can name, and a build old enough to fall below it has an update waiting.
        expect(evaluateUpdate('1.0.70', null, '1.0.75')).toEqual({ kind: 'required', version: '1.0.75' });
    });

    it('says nothing when the node reports neither field', () => {
        expect(evaluateUpdate('1.2.31', null, null)).toEqual({ kind: 'none' });
    });

    it('never demands a version the stores cannot supply', () => {
        // An operator raises MIN_APP_VERSION to 1.9.0 ahead of the release. The newest
        // published build is 1.2.31. Demanding 1.9.0 undismissibly would strand the whole
        // community behind a banner that survives doing exactly what it asked.
        expect(evaluateUpdate('1.2.30', '1.2.31', '1.9.0')).toEqual({ kind: 'available', version: '1.2.31' });
        // And with nothing left to install, it says nothing rather than nagging.
        expect(evaluateUpdate('1.2.31', '1.2.31', '1.9.0')).toEqual({ kind: 'none' });
    });

    it('points a below-floor app at a published build that clears the floor', () => {
        // The floor is 1.2.0 and 1.2.31 is published: following the banner ends the banner.
        expect(evaluateUpdate('1.1.90', '1.2.31', '1.2.0')).toEqual({ kind: 'required', version: '1.2.31' });
    });

    it('does not send you to an intermediate build that still fails the floor', () => {
        // Floor 1.3.0, store 1.2.32: naming 1.2.32 as REQUIRED would promise a fix it cannot
        // deliver, and the banner would come straight back after the update.
        expect(evaluateUpdate('1.2.30', '1.2.32', '1.3.0')).toEqual({ kind: 'available', version: '1.2.32' });
    });

    it('does not raise a banner off a malformed payload', () => {
        expect(evaluateUpdate('1.2.31', 'coming soon', 'soon')).toEqual({ kind: 'none' });
    });
});
