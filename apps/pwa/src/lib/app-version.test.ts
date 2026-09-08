import { describe, it, expect } from 'vitest';
import { normaliseVersion, isVersionOlder } from './app-version';

describe('app-version', () => {
    describe('normaliseVersion', () => {
        it('normalises standard semver strings', () => {
            expect(normaliseVersion('1.2.3')).toBe('1.2.3');
            expect(normaliseVersion('1.0')).toBe('1.0');
            expect(normaliseVersion('2')).toBe('2');
        });

        it('strips leading v and V with optional whitespace', () => {
            expect(normaliseVersion('v1.2.3')).toBe('1.2.3');
            expect(normaliseVersion('V 1.2.31')).toBe('1.2.31');
            expect(normaliseVersion(' v0.5.1 ')).toBe('0.5.1');
        });

        it('rejects invalid or non-string versions', () => {
            expect(normaliseVersion(null)).toBeNull();
            expect(normaliseVersion(undefined)).toBeNull();
            expect(normaliseVersion(123)).toBeNull();
            expect(normaliseVersion('')).toBeNull();
            expect(normaliseVersion('1..2')).toBeNull();
            expect(normaliseVersion('beta-1.0')).toBeNull();
            expect(normaliseVersion('1.2.3.4')).toBeNull();
        });

        it('rejects pre-release suffixes and build tags matching native', () => {
            expect(normaliseVersion('1.2.3-1')).toBeNull();
            expect(normaliseVersion('1.2.31-beta')).toBeNull();
            expect(normaliseVersion('1.0.0-rc1')).toBeNull();
            expect(normaliseVersion('1.2.31 (253)')).toBeNull();
        });
    });

    describe('isVersionOlder', () => {
        it('identifies older versions correctly across major, minor, patch', () => {
            expect(isVersionOlder('1.0.0', '2.0.0')).toBe(true);
            expect(isVersionOlder('1.1.0', '1.2.0')).toBe(true);
            expect(isVersionOlder('1.2.3', '1.2.4')).toBe(true);
            expect(isVersionOlder('1.2.15', '1.2.16')).toBe(true);
            expect(isVersionOlder('1.1.99', '1.2.0')).toBe(true);
        });

        it('returns false when local is equal or newer', () => {
            expect(isVersionOlder('1.2.15', '1.2.15')).toBe(false);
            expect(isVersionOlder('1.2.16', '1.2.15')).toBe(false);
            expect(isVersionOlder('2.0.0', '1.9.9')).toBe(false);
            expect(isVersionOlder('1.3.0', '1.2.9')).toBe(false);
        });

        it('handles 2-part and 1-part versions by padding with zeros', () => {
            expect(isVersionOlder('1.2', '1.2.1')).toBe(true);
            expect(isVersionOlder('1.2.0', '1.2')).toBe(false);
            expect(isVersionOlder('1', '1.0.1')).toBe(true);
            expect(isVersionOlder('2', '1.9.9')).toBe(false);
        });

        it('returns false for unparseable versions as a safe fallback (fails open)', () => {
            expect(isVersionOlder('invalid', '1.2.0')).toBe(false);
            expect(isVersionOlder('1.2.0', 'invalid')).toBe(false);
            expect(isVersionOlder('1.2.0', '1.2.1-beta')).toBe(false);
            expect(isVersionOlder('1.2.0-rc1', '1.2.0')).toBe(false);
        });
    });
});
