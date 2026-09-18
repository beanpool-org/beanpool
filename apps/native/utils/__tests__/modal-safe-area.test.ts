import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pageSheetTopInset } from '../modal-safe-area';

const NATIVE_ROOT = join(__dirname, '..', '..');

describe('pageSheetTopInset', () => {
    it('gives the whole status-bar inset on Android, where a pageSheet is full-screen and edge-to-edge', () => {
        expect(pageSheetTopInset('android', 24)).toBe(24);
        expect(pageSheetTopInset('android', 52)).toBe(52);
    });

    it('is zero on a phone with no status-bar inset', () => {
        expect(pageSheetTopInset('android', 0)).toBe(0);
    });

    it('is zero on iOS, where the page sheet already starts below the status bar', () => {
        expect(pageSheetTopInset('ios', 59)).toBe(0);
    });
});

/**
 * The screens are not rendered here (see vitest.config.ts), so this reads their source: each header that was
 * drawn under the status bar must take its top padding from the inset, not a fixed number.
 */
describe('pageSheet modal headers are driven by the safe-area inset', () => {
    const FIXED = [
        'components/NewEventModal.tsx',
        'components/NewPollModal.tsx',
        'components/RadiusPickerModal.tsx',
        'components/ArchetypeQuizModal.tsx',
    ];

    for (const file of FIXED) {
        it(file, () => {
            const src = readFileSync(join(NATIVE_ROOT, file), 'utf8');
            expect(src).toMatch(/const topInset = pageSheetTopInset\(Platform\.OS, useSafeAreaInsets\(\)\.top\);/);
            expect(src).toMatch(/styles\.header,[\s\S]{0,80}paddingTop: HEADER_PAD_TOP \+ topInset/);
        });
    }

    it('every pageSheet Modal in the app handles the top inset', () => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                if (name === 'node_modules' || name === '__tests__') continue;
                const p = join(dir, name);
                if (statSync(p).isDirectory()) walk(p);
                else if (p.endsWith('.tsx')) files.push(p);
            }
        };
        walk(join(NATIVE_ROOT, 'app'));
        walk(join(NATIVE_ROOT, 'components'));

        const unhandled = files
            .filter(f => /presentationStyle="pageSheet"/.test(readFileSync(f, 'utf8')))
            .filter(f => {
                const src = readFileSync(f, 'utf8');
                const usesHelper = /pageSheetTopInset\(/.test(src);
                // react-native-safe-area-context's SafeAreaView measures natively, so it is right on both
                // platforms (PricingGuideModal). react-native's own SafeAreaView is not: a no-op on Android.
                const usesContextSafeArea = /import \{[^}]*\bSafeAreaView\b[^}]*\} from 'react-native-safe-area-context'/.test(src)
                    && /edges=\{\[[^\]]*'top'/.test(src);
                return !usesHelper && !usesContextSafeArea;
            })
            .map(f => relative(NATIVE_ROOT, f));
        expect(unhandled).toEqual([]);
    });
});
