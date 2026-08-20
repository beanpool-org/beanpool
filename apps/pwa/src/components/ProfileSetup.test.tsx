import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ProfileSetup from './ProfileSetup';
import * as api from '../lib/api';
import * as identityLib from '../lib/identity';
import type { BeanPoolIdentity } from '../lib/identity';

// Mock API and identity modules
vi.mock('../lib/api', () => ({
    getMemberProfile: vi.fn(),
    updateMemberProfile: vi.fn(),
    registerMember: vi.fn(),
}));

vi.mock('../lib/identity', () => ({
    updateCallsign: vi.fn(),
}));

vi.mock('./OnboardingGuide', () => ({
    OnboardingGuide: () => <div data-testid="onboarding-guide">Onboarding Guide Component</div>,
}));

describe('ProfileSetup Component', () => {
    const mockIdentity: BeanPoolIdentity = {
        publicKey: 'pub123',
        privateKey: 'priv123',
        callsign: 'Alice',
        createdAt: '2025-01-01T00:00:00.000Z',
    };

    const mockOnDone = vi.fn();
    const mockOnIdentityUpdated = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        Object.defineProperty(navigator, 'onLine', {
            configurable: true,
            value: true,
        });
    });

    it('renders loading state initially and then shows step 1 (name)', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValueOnce(null as any);

        render(
            <ProfileSetup
                identity={mockIdentity}
                onDone={mockOnDone}
                onIdentityUpdated={mockOnIdentityUpdated}
            />
        );

        expect(screen.getByText(/Loading profile.../i)).toBeInTheDocument();

        await waitFor(() => {
            expect(screen.getByText(/👋 Your name/i)).toBeInTheDocument();
        });

        expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
        expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    });

    it('opens directly at step 2 (avatar) if name is ok but avatar is missing', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValueOnce({
            publicKey: 'pub123',
            avatar: null,
            bio: 'Hello world',
            contact: { value: 'alice@example.com', visibility: 'community' },
        });

        render(
            <ProfileSetup
                identity={mockIdentity}
                onDone={mockOnDone}
                onIdentityUpdated={mockOnIdentityUpdated}
            />
        );

        await waitFor(() => {
            expect(screen.getByText(/📸 Choose your look/i)).toBeInTheDocument();
        });

        expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    });

    it('validates name input and handles step 1 navigation and cancel button', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValueOnce(null as any);

        render(
            <ProfileSetup
                identity={mockIdentity}
                onDone={mockOnDone}
                onIdentityUpdated={mockOnIdentityUpdated}
            />
        );

        await waitFor(() => {
            expect(screen.getByText(/👋 Your name/i)).toBeInTheDocument();
        });

        const nameInput = screen.getByRole('textbox', { name: /Your name/i });
        const nextButton = screen.getByRole('button', { name: /Next →/i });

        // Enter short name (< 2 chars)
        fireEvent.change(nameInput, { target: { value: 'A' } });
        expect(nextButton).toBeDisabled();

        // Enter valid name
        fireEvent.change(nameInput, { target: { value: 'Bob' } });
        expect(nextButton).toBeEnabled();

        // Click next -> go to avatar step
        fireEvent.click(nextButton);
        expect(screen.getByText(/📸 Choose your look/i)).toBeInTheDocument();

        // Click back -> go back to name step
        const backButton = screen.getByRole('button', { name: /← Back/i });
        fireEvent.click(backButton);
        expect(screen.getByText(/👋 Your name/i)).toBeInTheDocument();

        // Click cancel -> trigger onDone
        const cancelButton = screen.getByRole('button', { name: /Cancel/i });
        fireEvent.click(cancelButton);
        expect(mockOnDone).toHaveBeenCalledTimes(1);
    });

    it('handles camera and gallery button triggers in step 2', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValueOnce(null as any);

        render(
            <ProfileSetup
                identity={mockIdentity}
                onDone={mockOnDone}
                onIdentityUpdated={mockOnIdentityUpdated}
            />
        );

        await waitFor(() => {
            expect(screen.getByText(/👋 Your name/i)).toBeInTheDocument();
        });

        fireEvent.click(screen.getByRole('button', { name: /Next →/i }));

        await waitFor(() => {
            expect(screen.getByText(/📸 Choose your look/i)).toBeInTheDocument();
        });

        const cameraBtn = screen.getByRole('button', { name: /📸 Camera/i });
        const galleryBtn = screen.getByRole('button', { name: /🖼️ Gallery/i });

        const fileInputs = document.querySelectorAll('input[type="file"]');
        expect(fileInputs.length).toBe(2);

        const cameraClickSpy = vi.spyOn(fileInputs[1] as HTMLInputElement, 'click');
        const galleryClickSpy = vi.spyOn(fileInputs[0] as HTMLInputElement, 'click');

        fireEvent.click(cameraBtn);
        expect(cameraClickSpy).toHaveBeenCalled();

        fireEvent.click(galleryBtn);
        expect(galleryClickSpy).toHaveBeenCalled();
    });

    it('navigates from avatar step to guide step when avatar exists and completes profile save', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValueOnce({
            publicKey: 'pub123',
            avatar: 'https://example.com/avatar.jpg',
            bio: 'Existing bio',
            contact: null,
        });

        vi.mocked(api.updateMemberProfile).mockResolvedValueOnce({
            success: true,
            profile: {
                publicKey: 'pub123',
                avatar: 'https://example.com/avatar.jpg',
                bio: 'Existing bio',
                contact: null,
            },
        });

        vi.mocked(identityLib.updateCallsign).mockResolvedValueOnce({
            ...mockIdentity,
            callsign: 'Bob',
        });

        vi.mocked(api.registerMember).mockResolvedValueOnce({
            success: true,
            member: {
                publicKey: 'pub123',
                callsign: 'Bob',
                joinedAt: '2025-01-01',
                invitedBy: '',
                inviteCode: '',
            },
        });

        render(
            <ProfileSetup
                identity={mockIdentity}
                onDone={mockOnDone}
                onIdentityUpdated={mockOnIdentityUpdated}
            />
        );

        // First step (name) is shown initially since avatar is already valid
        await waitFor(() => {
            expect(screen.getByText(/👋 Your name/i)).toBeInTheDocument();
        });

        // Change callsign to Bob
        const nameInput = screen.getByRole('textbox', { name: /Your name/i });
        fireEvent.change(nameInput, { target: { value: 'Bob' } });

        // Move to Avatar step
        fireEvent.click(screen.getByRole('button', { name: /Next →/i }));

        await waitFor(() => {
            expect(screen.getByText(/📸 Choose your look/i)).toBeInTheDocument();
        });

        // Next button to guide step
        const nextToGuideBtn = screen.getByRole('button', { name: /Next →/i });
        expect(nextToGuideBtn).toBeEnabled();
        fireEvent.click(nextToGuideBtn);

        // Guide step
        await waitFor(() => {
            expect(screen.getByText(/🫘 How BeanPool works/i)).toBeInTheDocument();
            expect(screen.getByTestId('onboarding-guide')).toBeInTheDocument();
        });

        // Click Done
        const doneBtn = screen.getByRole('button', { name: /Done ✓/i });
        fireEvent.click(doneBtn);

        await waitFor(() => {
            expect(api.updateMemberProfile).toHaveBeenCalledWith('pub123', {
                avatar: 'https://example.com/avatar.jpg',
                bio: 'Existing bio',
                contact: null,
            });
            expect(identityLib.updateCallsign).toHaveBeenCalledWith('Bob');
            expect(api.registerMember).toHaveBeenCalledWith('pub123', 'Bob');
            expect(mockOnIdentityUpdated).toHaveBeenCalledWith({
                ...mockIdentity,
                callsign: 'Bob',
            });
            expect(mockOnDone).toHaveBeenCalledTimes(1);
        });
    });

    it('shows offline error message when submitting while offline', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValueOnce({
            publicKey: 'pub123',
            avatar: 'https://example.com/avatar.jpg',
            bio: '',
            contact: null,
        });

        render(
            <ProfileSetup
                identity={mockIdentity}
                onDone={mockOnDone}
                onIdentityUpdated={mockOnIdentityUpdated}
            />
        );

        await waitFor(() => {
            expect(screen.getByText(/👋 Your name/i)).toBeInTheDocument();
        });

        // Go to Avatar step -> Guide step
        fireEvent.click(screen.getByRole('button', { name: /Next →/i }));
        await waitFor(() => expect(screen.getByText(/📸 Choose your look/i)).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: /Next →/i }));
        await waitFor(() => expect(screen.getByText(/🫘 How BeanPool works/i)).toBeInTheDocument());

        // Simulate offline
        Object.defineProperty(navigator, 'onLine', {
            configurable: true,
            value: false,
        });

        fireEvent.click(screen.getByRole('button', { name: /Done ✓/i }));

        expect(screen.getByText(/You need to be online to save your profile./i)).toBeInTheDocument();
        expect(api.updateMemberProfile).not.toHaveBeenCalled();
    });

    it('displays error message if saving profile fails', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValueOnce({
            publicKey: 'pub123',
            avatar: 'https://example.com/avatar.jpg',
            bio: '',
            contact: null,
        });

        vi.mocked(api.updateMemberProfile).mockRejectedValueOnce(new Error('Server failed to save profile'));

        render(
            <ProfileSetup
                identity={mockIdentity}
                onDone={mockOnDone}
                onIdentityUpdated={mockOnIdentityUpdated}
            />
        );

        await waitFor(() => {
            expect(screen.getByText(/👋 Your name/i)).toBeInTheDocument();
        });

        // Go to Avatar step -> Guide step
        fireEvent.click(screen.getByRole('button', { name: /Next →/i }));
        await waitFor(() => expect(screen.getByText(/📸 Choose your look/i)).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: /Next →/i }));
        await waitFor(() => expect(screen.getByText(/🫘 How BeanPool works/i)).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: /Done ✓/i }));

        await waitFor(() => {
            expect(screen.getByText(/Server failed to save profile/i)).toBeInTheDocument();
        });
    });
});
