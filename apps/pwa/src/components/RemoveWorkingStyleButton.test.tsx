/**
 * "Remove my working style" on the web's cards (DESIGN-archetype-across-fable.md §3, S3): one confirm in plain words, then
 * the browser's copy goes, the community is told, and the page takes the result off its screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { QuizResult } from '@beanpool/core';
import { resetAccountEpochForTest } from '../lib/account-epoch';
import { keepQuizResult, readWorkingStyle } from '../lib/working-style';
import * as api from '../lib/api';
import { RemoveWorkingStyleButton } from './RemoveWorkingStyleButton';

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    checkMembership: vi.fn(async () => ({ isMember: true, callsign: 'Alice' })),
    updateMemberProfile: vi.fn(async () => ({ success: true })),
    getMemberProfile: vi.fn(async () => ({ publicKey: 'me', archetype: JSON.stringify({ primary: 'sage', secondary: 'weaver', mode: 'quick', takenOn: '2026-11-01' }) })),
}));

const ME = 'me';
const SENTENCE = 'This takes your working style off this device and out of every community on it. A retake brings it back.';
const taken: QuizResult = { primary: 'sage', secondary: 'weaver', mode: 'quick', scores: { sage: 3 } as QuizResult['scores'], takenOn: '2026-11-01' };

beforeEach(() => {
    localStorage.clear();
    resetAccountEpochForTest();
    vi.mocked(api.updateMemberProfile).mockClear();
    keepQuizResult(ME, taken);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('RemoveWorkingStyleButton', () => {
    it('says what it does, in a button 44 px tall', () => {
        render(<RemoveWorkingStyleButton publicKey={ME} onRemoved={() => {}} />);
        const button = screen.getByRole('button', { name: 'Remove my working style' });
        expect(button.className).toContain('min-h-[44px]');
    });

    it('asks once, in plain words; a cancel removes nothing', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        const onRemoved = vi.fn();
        render(<RemoveWorkingStyleButton publicKey={ME} onRemoved={onRemoved} />);
        fireEvent.click(screen.getByRole('button', { name: 'Remove my working style' }));
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm).toHaveBeenCalledWith(SENTENCE);
        expect(onRemoved).not.toHaveBeenCalled();
        expect(readWorkingStyle(ME)).not.toBeNull();
        expect(api.updateMemberProfile).not.toHaveBeenCalled();
    });

    it('a yes takes the copy off, tells the community with a null, and the page takes the result off its screen', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const onRemoved = vi.fn();
        render(<RemoveWorkingStyleButton publicKey={ME} onRemoved={onRemoved} />);
        fireEvent.click(screen.getByRole('button', { name: 'Remove my working style' }));
        await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
        expect(readWorkingStyle(ME)).toBeNull();
        expect(api.updateMemberProfile).toHaveBeenCalledWith(ME, { archetype: null });
    });
});

describe('the web\'s three cards carry it', () => {
    const page = (name: string) => readFileSync(resolve(__dirname, '../pages', name), 'utf8');
    it.each(['ProfilePage.tsx', 'SettingsPage.tsx', 'PublicProfilePage.tsx'])('%s has the button on the card, and shows the result through the removal', (file) => {
        const source = page(file);
        expect(source).toContain('<RemoveWorkingStyleButton');
        expect(source).toContain('shownWorkingStyle(');
        expect(source).not.toMatch(/readWorkingStyle\(identity\.publicKey\)\)\)/);
    });
});
