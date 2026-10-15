import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { photoStepNote } from '@beanpool/core';

/**
 * Sign-up's "Choose your look" step is never a gate (rehearsal 14 Oct S9; memory onboarding-no-hard-gates): Next was
 * disabled until a picture or avatar was picked. The screens are not rendered here (see vitest.config.ts), so this
 * reads welcome.tsx: Next works with no picture, goes on to the 12 words, and the step says what the node asks for.
 */
const SRC = readFileSync(join(__dirname, '..', '..', 'app', 'welcome.tsx'), 'utf8');
const handler = SRC.slice(SRC.indexOf('async function handleCompleteProfile()'), SRC.indexOf('// --- STEP 2: PROFILE SETUP'));
const step = SRC.slice(SRC.indexOf('// --- STEP 2: PROFILE SETUP'), SRC.indexOf('<AvatarPickerSheet', SRC.indexOf('// --- STEP 2: PROFILE SETUP')));

describe('the phone photo step with no picture picked', () => {
    it('Next is not disabled for want of a picture', () => {
        expect(step).toContain('onPress={handleCompleteProfile}');
        expect(step).not.toMatch(/disabled=\{!pendingAvatar/);
        expect(step).not.toMatch(/!pendingAvatar && styles\.disabledBtn/);
    });

    it('goes on to the 12 words without one', () => {
        expect(handler).not.toMatch(/if \(!pendingIdentity \|\| !pendingAvatar\) return/);
        const noPicture = handler.slice(handler.indexOf('if (!pendingAvatar) {'));
        expect(noPicture.slice(0, noPicture.indexOf('return;'))).toContain("setMode('seedBackup')");
    });

    it('says what the node asks for, by whether Beans are on', () => {
        expect(step).toContain('photoStepNote(joinBeansOn)');
        expect(photoStepNote(true)).toMatch(/before you post/);
        expect(photoStepNote(false)).toMatch(/optional/);
    });
});
