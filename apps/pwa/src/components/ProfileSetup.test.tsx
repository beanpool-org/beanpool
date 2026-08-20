import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ProfileSetup } from './ProfileSetup';
import * as api from '../lib/api';
import * as identityLib from '../lib/identity';
import type { BeanPoolIdentity } from '../lib/identity';

vi.mock('../lib/api', () => ({
    getMemberProfile: vi.fn(),
    updateMemberProfile: vi.fn(),
    registerMember: vi.fn(),
}));

vi.mock('../lib/identity', () => ({
    updateCallsign: vi.fn(),
}));

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'pk_alice_123',
    privateKey: 'sk_alice_123',
    callsign: 'Alice',
    createdAt: '2025-01-01T00:00:00.000Z',
};

describe('ProfileSetup', () => {
    const onDoneMock = vi.fn();
    const onIdentityUpdatedMock = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        // Ensure navigator.onLine returns true for test environment
        Object.defineProperty(navigator, 'onLine', {
            configurable: true,
            value: true,
        });
    });

    it('handles getMemberProfile rejection gracefully (offline/error fallback)', async () => {
        vi.mocked(api.getMemberProfile).mockRejectedValue(new Error('Network error / offline'));

        render(<ProfileSetup identity={mockIdentity} onDone={onDoneMock} />);

        // Initially shows loading indicator
        expect(screen.getByText('Loading profile...')).toBeInTheDocument();

        // After error in getMemberProfile, loading ends and defaults to step 'name'
        await waitFor(() => {
            expect(screen.queryByText('Loading profile...')).not.toBeInTheDocument();
        });

        expect(screen.getByText('👋 Your name')).toBeInTheDocument();
        const input = screen.getByLabelText('Your name') as HTMLInputElement;
        expect(input.value).toBe('Alice');
    });

    it('loads existing profile and jumps to avatar step if name is valid but avatar is missing', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValue({
            publicKey: 'pk_alice_123',
            avatar: null,
            bio: 'Hello world',
            contact: null,
        });

        render(<ProfileSetup identity={mockIdentity} onDone={onDoneMock} />);

        await waitFor(() => {
            expect(screen.queryByText('Loading profile...')).not.toBeInTheDocument();
        });

        // Should jump directly to avatar step
        expect(screen.getByText('📸 Choose your look')).toBeInTheDocument();
    });

    it('loads existing profile and remains at name step if avatar is already set', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValue({
            publicKey: 'pk_alice_123',
            avatar: 'bundled://bean-green',
            bio: 'Hello world',
            contact: null,
        });

        render(<ProfileSetup identity={mockIdentity} onDone={onDoneMock} />);

        await waitFor(() => {
            expect(screen.queryByText('Loading profile...')).not.toBeInTheDocument();
        });

        // Remains at step 'name'
        expect(screen.getByText('👋 Your name')).toBeInTheDocument();
    });

    it('displays error when handleFinish fails during profile update', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValue({
            publicKey: 'pk_alice_123',
            avatar: 'bundled://bean-green',
            bio: '',
            contact: null,
        });

        vi.mocked(api.updateMemberProfile).mockRejectedValue(new Error('Failed to save profile'));

        render(
            <ProfileSetup
                identity={mockIdentity}
                onDone={onDoneMock}
                onIdentityUpdated={onIdentityUpdatedMock}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('👋 Your name')).toBeInTheDocument();
        });

        // Click Next to step 'avatar'
        fireEvent.click(screen.getByText('Next →'));
        expect(screen.getByText('📸 Choose your look')).toBeInTheDocument();

        // Click Next to step 'guide'
        fireEvent.click(screen.getByText('Next →'));
        expect(screen.getByText('🫘 How BeanPool works')).toBeInTheDocument();

        // Click Done ✓ to attempt finish
        fireEvent.click(screen.getByText('Done ✓'));

        await waitFor(() => {
            expect(screen.getByText('Failed to save profile')).toBeInTheDocument();
        });

        expect(onDoneMock).not.toHaveBeenCalled();
    });
});
