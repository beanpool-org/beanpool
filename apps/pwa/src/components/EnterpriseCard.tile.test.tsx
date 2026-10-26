import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { EnterpriseCard } from './EnterpriseCard';

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

describe('EnterpriseCard category tile', () => {
    it('renders category tile disc when enterprise has no avatar', () => {
        render(<EnterpriseCard treasury={treasuryNoAvatar} />);
        expect(screen.getByTestId('category-tile')).toBeInTheDocument();
    });
});
