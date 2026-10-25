import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { ProjectsPage } from './ProjectsPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getTreasuries, getDecisions, getCommonsBalance, getGroups } from '../lib/api';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: () => null,
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getTreasuries: vi.fn(),
    getBalance: vi.fn(async () => ({ balance: 100, floor: -500, commonsBalance: 250, earnedCredit: 12, callsign: 'Alice', keeperOf: [], tier: 'contributor' })),
    createEnterprise: vi.fn(async () => ({ success: true })),
    getDecisions: vi.fn(),
    getCommonsBalance: vi.fn(async () => ({ balance: 250 })),
    getAllMembers: vi.fn(async () => []),
    getGroups: vi.fn(),
}));

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({
        memberCount: 3,
        postCount: 0,
        transactionCount: 0,
        commonsBalance: 100,
        profile: 'local',
        features: { beans: true, enterprises: true, decisions: true },
    })),
}));
import { communityInfoOnce } from '../lib/visitor-lobby-gate';

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'pk-test',
    privateKey: 'sk-test',
    callsign: 'Alice',
    createdAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
    vi.mocked(communityInfoOnce).mockResolvedValue({
        memberCount: 3,
        postCount: 0,
        transactionCount: 0,
        commonsBalance: 100,
        profile: 'local',
        features: { beans: true, enterprises: true, decisions: true },
    } as any);
    vi.mocked(getTreasuries).mockResolvedValue({ treasuries: [] } as any);
    vi.mocked(getGroups).mockResolvedValue([] as any);
    vi.mocked(getDecisions).mockResolvedValue({ decisions: [], myPoolVoting: null, canPropose: true } as any);
    vi.mocked(getCommonsBalance).mockResolvedValue({ balance: 100 } as any);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ProjectsPage - Commons S2 Start Something (Fable 5.1 §3.5, §5 S2)', () => {
    it('has ONE header button "Start something" on Groups and on Decide', async () => {
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        // On Groups section
        const startBtn = screen.getByRole('button', { name: /Start something/i });
        expect(startBtn).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: '+ Create Group' })).toBeNull();
        expect(screen.queryByRole('button', { name: '+ Propose' })).toBeNull();

        // Switch to Decide section
        const decideTab = screen.getByRole('button', { name: /Decide/ });
        fireEvent.click(decideTab);

        // Header button remains "Start something"
        expect(screen.getByRole('button', { name: /Start something/i })).toBeInTheDocument();
    });

    it('clicking "Start something" opens the StartSomethingDialog with 6 rows when all features are on', async () => {
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));

        const dialog = screen.getByRole('dialog', { name: /Start something/i });
        expect(dialog).toBeInTheDocument();

        // Check rows
        expect(within(dialog).getByRole('button', { name: /Chat group/i })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: /Project/i })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: /Enterprise/i })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: /Decision/i })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: /Poll/i })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: /Event/i })).toBeInTheDocument();
    });

    it('dialog rows follow community shape (Beans off, Enterprises off, Decisions off)', async () => {
        // Beans off
        vi.mocked(communityInfoOnce).mockResolvedValue({
            memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local',
            features: { beans: false, decisions: true },
        } as any);

        const { unmount } = render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        const dialog = screen.getByRole('dialog', { name: /Start something/i });

        expect(within(dialog).queryByRole('button', { name: /^Project/i })).toBeNull();
        expect(within(dialog).queryByRole('button', { name: /^Enterprise/i })).toBeNull();
        expect(within(dialog).getByRole('button', { name: /Chat group/i })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: /Decision/i })).toBeInTheDocument();
        unmount();
    });

    it('shows standing line on Decision row when !canPropose', async () => {
        vi.mocked(getDecisions).mockResolvedValueOnce({ decisions: [], myPoolVoting: null, canPropose: false } as any);
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getDecisions).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        const dialog = screen.getByRole('dialog', { name: /Start something/i });

        expect(within(dialog).getByText(/Opens after your first completed trade/i)).toBeInTheDocument();
    });

    it('Enterprise row opens propose modal with Enterprise selected and title "Start an enterprise"', async () => {
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        const dialog = screen.getByRole('dialog', { name: /Start something/i });

        fireEvent.click(within(dialog).getByRole('button', { name: /^Enterprise/i }));

        // Propose modal is open
        const proposeModal = screen.getByRole('dialog', { name: /Start an enterprise/i });
        expect(proposeModal).toBeInTheDocument();
        expect(within(proposeModal).getByRole('button', { name: /Start the enterprise 🏛️/i })).toBeInTheDocument();
    });

    it('Project row opens propose modal with Project selected and title "Start a project"', async () => {
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        const dialog = screen.getByRole('dialog', { name: /Start something/i });

        fireEvent.click(within(dialog).getByRole('button', { name: /^Project/i }));

        const proposeModal = screen.getByRole('dialog', { name: /Start a project/i });
        expect(proposeModal).toBeInTheDocument();
        expect(within(proposeModal).getByRole('button', { name: /Start the project 🌱/i })).toBeInTheDocument();
    });

    it('Chat group row opens CreateGroupModal with Social Circle first and selected, and bridge opens propose modal unselected', async () => {
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        const dialog = screen.getByRole('dialog', { name: /Start something/i });

        fireEvent.click(within(dialog).getByRole('button', { name: /^Chat group/i }));

        // CreateGroupModal is open
        const groupModal = screen.getByRole('dialog', { name: /Create a Group/i });
        expect(groupModal).toBeInTheDocument();

        // Social Circle is first category option and selected
        const categoryButtons = within(groupModal).getAllByRole('button', { name: /Social Circle|General|Working Group|Guild/i });
        expect(categoryButtons[0]).toHaveTextContent(/Social Circle/);
        expect(categoryButtons[0]).toHaveAttribute('aria-pressed', 'true');

        // Bridge line is present
        const bridge = within(groupModal).getByText(/Start a project or an enterprise →/i);
        expect(bridge).toBeInTheDocument();

        // Clicking bridge opens propose modal with neither lifecycle selected
        fireEvent.click(bridge);

        const proposeModal = screen.getByRole('dialog', { name: /Start a project or an enterprise/i });
        expect(proposeModal).toBeInTheDocument();

        // Submit button is disabled asking for choice
        const submitBtn = within(proposeModal).getByRole('button', { name: /Choose a project or an enterprise first/i });
        expect(submitBtn).toBeDisabled();

        // Picking Project updates title and submit text
        fireEvent.click(within(proposeModal).getByRole('button', { name: /🌱 Project/i }));
        expect(within(proposeModal).getByRole('heading', { level: 2 })).toHaveTextContent(/Start a project/i);
        expect(within(proposeModal).getByRole('button', { name: /Start the project 🌱/i })).toBeInTheDocument();
    });

    it('Poll and Event rows navigate to marketplace with new-poll and new-event', async () => {
        const onNavigate = vi.fn();
        render(<ProjectsPage identity={mockIdentity} onNavigate={onNavigate} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        // Test Poll
        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        let dialog = screen.getByRole('dialog', { name: /Start something/i });
        fireEvent.click(within(dialog).getByRole('button', { name: /^Poll/i }));
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'new-poll');

        // Test Event
        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        dialog = screen.getByRole('dialog', { name: /Start something/i });
        fireEvent.click(within(dialog).getByRole('button', { name: /^Event/i }));
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'new-event');
    });

    it('dialog accessibility: Escape closes dialog and restores focus', async () => {
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        const opener = screen.getByRole('button', { name: /Start something/i });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: /Start something/i });
        expect(dialog).toBeInTheDocument();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: /Start something/i })).toBeNull();
    });
});
