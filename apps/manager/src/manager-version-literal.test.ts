import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('No hardcoded version literal 1.4.2 in manager sources', () => {
    it('fails if literal 1.4.2 comes back in manager source code', () => {
        const thisDir = path.dirname(fileURLToPath(import.meta.url));
        const srcDir = thisDir; // apps/manager/src

        function walk(dir: string): string[] {
            const files: string[] = [];
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    files.push(...walk(full));
                } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
                    // Do not check this test file itself for its own match assertion
                    if (full === fileURLToPath(import.meta.url)) continue;
                    files.push(full);
                }
            }
            return files;
        }

        const allFiles = walk(srcDir);
        const violations: Array<{ file: string; line: number; text: string }> = [];

        for (const file of allFiles) {
            const content = fs.readFileSync(file, 'utf-8');
            const lines = content.split('\n');
            lines.forEach((line, index) => {
                if (line.includes('1.4.2')) {
                    violations.push({
                        file: path.relative(srcDir, file),
                        line: index + 1,
                        text: line.trim(),
                    });
                }
            });
        }

        expect(violations).toEqual([]);
    });
});
