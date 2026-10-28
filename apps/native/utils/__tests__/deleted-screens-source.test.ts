/**
 * Source and routing checks for deleted legacy screens:
 * apps/native/app/project-detail.tsx and apps/native/app/edit-project.tsx (Fable 5.1 §5 S6, §4.1).
 *
 * S6 requires:
 * 1. Both files deleted from disk.
 * 2. No file imports or routes to the two deleted screens.
 * 3. Deep links targeting them redirect cleanly to the new Commons screen (/(tabs)/projects).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redirectSystemPath } from '../../app/+native-intent';

const NATIVE_DIR = path.resolve(__dirname, '../..');
const ROOT_DIR = path.resolve(NATIVE_DIR, '../..');

describe('deleted legacy project screens (Fable 5.1 §5 S6)', () => {
    it('app/project-detail.tsx and app/edit-project.tsx are deleted from disk', () => {
        expect(fs.existsSync(path.join(NATIVE_DIR, 'app/project-detail.tsx')), 'app/project-detail.tsx must be deleted').toBe(false);
        expect(fs.existsSync(path.join(NATIVE_DIR, 'app/edit-project.tsx')), 'app/edit-project.tsx must be deleted').toBe(false);
    });

    it('no source file imports or routes to the deleted project screens', () => {
        const scanDirs = [
            path.join(NATIVE_DIR, 'app'),
            path.join(NATIVE_DIR, 'components'),
            path.join(NATIVE_DIR, 'utils'),
            path.join(ROOT_DIR, 'apps/pwa/src'),
            path.join(ROOT_DIR, 'packages/beanpool-core/src'),
        ];

        const targetPatterns = [
            /['"](?:\.\.?\/)+project-detail['"]/,
            /['"](?:\.\.?\/)+edit-project['"]/,
            /['"]\/project-detail['"]/,
            /['"]\/edit-project['"]/,
        ];

        const offending: string[] = [];

        function scan(dir: string) {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
                    scan(full);
                } else if (/\.(tsx?|jsx?|mjs)$/.test(entry.name)) {
                    if (entry.name === 'deleted-screens-source.test.ts') continue;
                    const content = fs.readFileSync(full, 'utf8');
                    for (const pat of targetPatterns) {
                        if (pat.test(content)) {
                            offending.push(`${path.relative(ROOT_DIR, full)} matches ${pat}`);
                        }
                    }
                }
            }
        }

        for (const d of scanDirs) scan(d);
        expect(offending, 'No code should import or navigate to project-detail or edit-project').toEqual([]);
    });

    it('deep links to project-detail or edit-project land on Commons (/(tabs)/projects)', () => {
        // Cold start (initial: true)
        expect(redirectSystemPath({ path: 'beanpool://project-detail', initial: true })).toBe('/(tabs)/projects');
        expect(redirectSystemPath({ path: 'beanpool://edit-project', initial: true })).toBe('/(tabs)/projects');
        expect(redirectSystemPath({ path: 'beanpool:///project-detail', initial: true })).toBe('/(tabs)/projects');
        expect(redirectSystemPath({ path: 'beanpool:///edit-project', initial: true })).toBe('/(tabs)/projects');
        expect(redirectSystemPath({ path: 'beanpool://project-detail?publicKey=abc', initial: true })).toBe('/(tabs)/projects');
        expect(redirectSystemPath({ path: 'beanpool://edit-project?id=123', initial: true })).toBe('/(tabs)/projects');

        // Warm navigation (initial: false)
        expect(redirectSystemPath({ path: 'beanpool://project-detail', initial: false })).toBe('/(tabs)/projects');
        expect(redirectSystemPath({ path: 'beanpool://edit-project', initial: false })).toBe('/(tabs)/projects');
        expect(redirectSystemPath({ path: 'beanpool:///project-detail', initial: false })).toBe('/(tabs)/projects');
        expect(redirectSystemPath({ path: 'beanpool:///edit-project', initial: false })).toBe('/(tabs)/projects');
        expect(redirectSystemPath({ path: '/project-detail', initial: false })).toBe('/(tabs)/projects');
        expect(redirectSystemPath({ path: '/edit-project', initial: false })).toBe('/(tabs)/projects');
    });
});
