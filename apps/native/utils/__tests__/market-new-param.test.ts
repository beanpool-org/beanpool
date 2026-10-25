import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Market ?new= parameter handling', () => {
    it('market.tsx reads ?new=poll and ?new=event, opens matching modal and clears the param', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', '(tabs)', 'market.tsx'), 'utf8');
        expect(src).toMatch(/params\.new\s*===\s*'poll'/);
        expect(src).toMatch(/setShowNewPollModal\s*\(\s*true\s*\)/);
        expect(src).toMatch(/params\.new\s*===\s*'event'/);
        expect(src).toMatch(/setShowNewEventModal\s*\(\s*true\s*\)/);
        expect(src).toMatch(/router\.setParams\(\s*\{\s*new:\s*''\s*\}\s*\)/);
    });
});
