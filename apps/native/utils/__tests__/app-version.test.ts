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
        expect(evaluateUpdate('1.0.70', null, '1.0.75')).toEqual({ kind: 'required', version: '1.0.75' });
    });

    it('says nothing when the node reports neither field', () => {
        expect(evaluateUpdate('1.2.31', null, null)).toEqual({ kind: 'none' });
    });

    it('still requires a floor set above every published build', () => {
        // An operator who raises MIN_APP_VERSION past what the stores have shipped strands
        // their own community on an undismissible banner. That is their decision to make and
        // to undo — the client does not second-guess the floor, which is why the default
        // (1.0.75) sits far below anything in the field.
        expect(evaluateUpdate('1.2.31', '1.2.31', '1.9.0')).toEqual({ kind: 'required', version: '1.9.0' });
    });

    it('does not raise a banner off a malformed payload', () => {
        expect(evaluateUpdate('1.2.31', 'coming soon', 'soon')).toEqual({ kind: 'none' });
    });
});
