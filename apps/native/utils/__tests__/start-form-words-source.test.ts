/**
 * The start form says "project" or "enterprise", never "initiative" (Fable 5.1 §3.3, §5 S5). Read from both apps' source:
 * drawn in the pseudo-locale the letters are scrambled, so a rendered check could not see the word. The enterprise page's
 * own "Back this initiative" and "Cancel Initiative" are a follow-up (§6.1 Q7), not this form.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const NATIVE_DIR = path.resolve(__dirname, '../..');
const ROOT_DIR = path.resolve(NATIVE_DIR, '../..');

describe('the start form never says initiative (Fable 5.1 §5 S5)', () => {
    it("the phone's start form (app/propose-project.tsx)", () => {
        const source = fs.readFileSync(path.join(NATIVE_DIR, 'app/propose-project.tsx'), 'utf8');
        expect(source).not.toMatch(/initiative/i);
    });

    it("the web's start form (the propose modal in pages/ProjectsPage.tsx)", () => {
        const source = fs.readFileSync(path.join(ROOT_DIR, 'apps/pwa/src/pages/ProjectsPage.tsx'), 'utf8');
        expect(source).not.toMatch(/initiative/i);
    });
});
