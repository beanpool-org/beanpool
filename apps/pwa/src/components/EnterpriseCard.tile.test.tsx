import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { bundledAvatarForPubkey } from '@beanpool/core';
import { EnterpriseCard } from './EnterpriseCard';
import { resolveAvatarUrl } from '../lib/avatar';

const treasuryNoAvatar = {
    id: 'ent-1',
    publicKey: 'e'.repeat(64),
    name: 'Tool Library',
    purpose: 'Share tools across town',
    avatar: null,
    avatarUrl: null,
    status: 'active',
    balance: 50,
    memberCount: 5,
} as any;

// Pictures S4 (Marty: no picture yet → the ready-made picture its key picks, never a bare initial): an enterprise with
// no logo draws its key's preset, as the phone's card does; the category tile is the last rung, for a picture that fails.
describe('EnterpriseCard with no logo', () => {
    it("draws the ready-made picture its key picks, not the category tile", () => {
        render(<EnterpriseCard treasury={treasuryNoAvatar} />);
        const img = screen.getByAltText('Tool Library');
        expect(img.getAttribute('src')).toBe(resolveAvatarUrl(bundledAvatarForPubkey(treasuryNoAvatar.publicKey)));
        expect(screen.queryByTestId('category-tile')).toBeNull();
    });

    it('renders category tile disc when the ready-made picture fails to load', () => {
        render(<EnterpriseCard treasury={treasuryNoAvatar} />);
        fireEvent.error(screen.getByAltText('Tool Library'));
        expect(screen.getByTestId('category-tile')).toBeInTheDocument();
        expect(screen.queryByAltText('Tool Library')).toBeNull();
    });
});
