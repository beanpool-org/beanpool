import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { ProjectsPage } from './ProjectsPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getTreasuries, getDecisions, getCommonsBalance, getGroups, createEnterprise } from '../lib/api';

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
    getYourGroups: vi.fn(async () => ({ items: [] })),
    getCommunityMe: vi.fn(async () => ({ tier: 'member', features: null })),
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
import { resetReaderFeaturesOnce } from '../lib/features';

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
    resetReaderFeaturesOnce();
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

        // Propose modal is open. Logo is mandatory, button reads "Choose a logo" until chosen
        const proposeModal = screen.getByRole('dialog', { name: /Start an enterprise/i });
        expect(proposeModal).toBeInTheDocument();
        expect(within(proposeModal).getByRole('button', { name: /Choose a logo/i })).toBeInTheDocument();
        fireEvent.click(within(proposeModal).getByRole('button', { name: /Select Green Bean avatar/i }));
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
        expect(within(proposeModal).getByRole('button', { name: /Choose a logo/i })).toBeInTheDocument();
        fireEvent.click(within(proposeModal).getByRole('button', { name: /Select Green Bean avatar/i }));
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

        // Picking Project updates title and submit text requires logo
        fireEvent.click(within(proposeModal).getByRole('button', { name: /🌱 Project/i }));
        expect(within(proposeModal).getByRole('heading', { level: 2 })).toHaveTextContent(/Start a project/i);
        expect(within(proposeModal).getByRole('button', { name: /Choose a logo/i })).toBeInTheDocument();
        fireEvent.click(within(proposeModal).getByRole('button', { name: /Select Green Bean avatar/i }));
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

    it('dialog accessibility: Tab loops inside, Shift+Tab loops backwards', async () => {
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        const opener = screen.getByRole('button', { name: /Start something/i });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: /Start something/i });
        expect(dialog).toBeInTheDocument();

        const closeBtn = within(dialog).getByRole('button', { name: /Close/i });
        const eventBtn = within(dialog).getByRole('button', { name: /^Event/i });

        // Shift+Tab on first button (Close) wraps to last button (Event)
        closeBtn.focus();
        expect(document.activeElement).toBe(closeBtn);
        fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(eventBtn);

        // Tab on last button (Event) wraps to first button (Close)
        fireEvent.keyDown(window, { key: 'Tab', shiftKey: false });
        expect(document.activeElement).toBe(closeBtn);
    });

    // The deciding review of #2471 (finding 3): focus goes back to "＋ Start something" unless the pick hands off to a dialog that
    // takes focus itself, never to <body> (dialog-focus.ts). Create a Group takes none, so focus is on the opener under it.
    it('dialog focus: Chat group (a form that takes no focus) leaves focus on the opener, not on <body>', async () => {
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        const opener = screen.getByRole('button', { name: /Start something/i });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: /Start something/i });
        // A real click focuses the row first (jsdom's click doesn't); the row then leaves the page with the sheet.
        const chatRow = within(dialog).getByRole('button', { name: /^Chat group/i });
        chatRow.focus();
        fireEvent.click(chatRow);

        expect(screen.getByRole('dialog', { name: /Create a Group/i })).toBeInTheDocument();
        expect(document.activeElement).toBe(opener);
    });

    it('dialog focus: a refused Decision (no completed trade yet) sends focus back to the opener, not to <body>', async () => {
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
        vi.mocked(getDecisions).mockResolvedValue({ decisions: [], myPoolVoting: null, canPropose: false } as any);
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getDecisions).toHaveBeenCalled());

        const opener = screen.getByRole('button', { name: /Start something/i });
        opener.focus();
        fireEvent.click(opener);
        const dialog = screen.getByRole('dialog', { name: /Start something/i });
        const decisionRow = within(dialog).getByRole('button', { name: /^Decision/i });
        decisionRow.focus();
        fireEvent.click(decisionRow);

        expect(alertSpy).toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: /Start something/i })).toBeNull();
        expect(document.activeElement).toBe(opener);
        alertSpy.mockRestore();
    });

    it('empty-state "+ Propose a Project" button resets lifecycle to bounded even after bridge set it to empty', async () => {
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        // 1. Open Chat group and click bridge to set newLifecycle = ''
        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        const dialog = screen.getByRole('dialog', { name: /Start something/i });
        fireEvent.click(within(dialog).getByRole('button', { name: /^Chat group/i }));

        const groupModal = screen.getByRole('dialog', { name: /Create a Group/i });
        const bridge = within(groupModal).getByText(/Start a project or an enterprise →/i);
        fireEvent.click(bridge);

        // Propose modal is open unselected
        let proposeModal = screen.getByRole('dialog', { name: /Start a project or an enterprise/i });
        expect(within(proposeModal).getByRole('button', { name: /Choose a project or an enterprise first/i })).toBeDisabled();

        // Close propose modal
        fireEvent.click(within(proposeModal).getByRole('button', { name: /Close dialog/i }));
        expect(screen.queryByRole('dialog', { name: /Start a project or an enterprise/i })).toBeNull();

        // 2. Click empty-state "Start a project" on the Projects chip (Fable 5.1 §3.1, §5 S5)
        fireEvent.click(screen.getByRole('button', { name: /🌱 Projects/ }));
        const emptyProposeBtn = screen.getByRole('button', { name: /Start a project/i });
        fireEvent.click(emptyProposeBtn);

        // Modal should open with "Start a project" and submit asks for logo
        proposeModal = screen.getByRole('dialog', { name: /Start a project/i });
        expect(proposeModal).toBeInTheDocument();
        expect(within(proposeModal).getByRole('button', { name: /Choose a logo/i })).toBeInTheDocument();
        fireEvent.click(within(proposeModal).getByRole('button', { name: /Select Green Bean avatar/i }));
        expect(within(proposeModal).getByRole('button', { name: /Start the project 🌱/i })).toBeInTheDocument();
    });

    it('decision refusal alert: indicates trade when beans on', async () => {
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
        vi.mocked(getDecisions).mockResolvedValue({ decisions: [], myPoolVoting: null, canPropose: false } as any);

        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getDecisions).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        const dialog = screen.getByRole('dialog', { name: /Start something/i });
        fireEvent.click(within(dialog).getByRole('button', { name: /^Decision/i }));

        expect(alertSpy).toHaveBeenCalledWith('You can propose a Decision once you have completed a trade.');
        alertSpy.mockRestore();
    });

    it('decision refusal alert: indicates node admins when beans off', async () => {
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
        vi.mocked(communityInfoOnce).mockResolvedValue({
            memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local',
            features: { beans: false, decisions: true },
        } as any);
        vi.mocked(getDecisions).mockResolvedValue({ decisions: [], myPoolVoting: null, canPropose: false } as any);

        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        const dialog = screen.getByRole('dialog', { name: /Start something/i });
        await waitFor(() => expect(within(dialog).getByText(/Node admins propose here/i)).toBeInTheDocument());
        fireEvent.click(within(dialog).getByRole('button', { name: /^Decision/i }));

        expect(alertSpy).toHaveBeenCalledWith('Node admins propose here.');
        alertSpy.mockRestore();
    });

    it('decision row in preview mode opens LocalCommunitySheet and switches to Decide section', async () => {
        const info = {
            memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global' as const,
            features: { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true },
        };
        vi.mocked(communityInfoOnce).mockResolvedValue(info as any);

        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(screen.getByTestId('commons-section-tabs')).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        const dialog = screen.getByRole('dialog', { name: /Start something/i });
        fireEvent.click(within(dialog).getByRole('button', { name: /^Decision/i }));

        // LocalCommunitySheet is open explaining where decisions live
        expect(await screen.findByTestId('local-community-sheet')).toBeInTheDocument();
        // Section switched to Decide preview
        expect(screen.getByTestId('decide-preview')).toBeInTheDocument();
    });

    it('Pictures S4: Start modal requires logo (label LOGO, Start button says "Choose a logo" until picked, sends avatar)', async () => {
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        const dialog = screen.getByRole('dialog', { name: /Start something/i });
        fireEvent.click(within(dialog).getByRole('button', { name: /^Project/i }));

        const modal = screen.getByRole('dialog', { name: /Start a project/i });
        expect(modal).toBeInTheDocument();

        // Label must be LOGO (no '(optional)')
        expect(within(modal).getByText(/^LOGO$/i)).toBeInTheDocument();
        expect(within(modal).queryByText(/LOGO \(optional\)/i)).toBeNull();

        // Start button reads "Choose a logo" and is disabled until logo is chosen
        const submitBtn = within(modal).getByRole('button', { name: /Choose a logo/i });
        expect(submitBtn).toBeDisabled();

        // Fill in required fields
        fireEvent.change(within(modal).getByPlaceholderText(/e\.g\. Community Tool Shed/i), { target: { value: 'Local Garden' } });
        fireEvent.change(within(modal).getByPlaceholderText(/State clearly what this enterprise exists to do/i), { target: { value: 'Grow food together' } });
        fireEvent.change(within(modal).getByPlaceholderText(/e\.g\. 500/i), { target: { value: '100' } });

        // Still disabled because no logo
        expect(submitBtn).toBeDisabled();

        // Select a preset avatar (e.g. Green Bean)
        const presetBtn = within(modal).getByRole('button', { name: /Select Green Bean avatar/i });
        fireEvent.click(presetBtn);

        // Now button becomes enabled and reads "Start the project 🌱"
        const startBtn = within(modal).getByRole('button', { name: /Start the project 🌱/i });
        expect(startBtn).not.toBeDisabled();

        fireEvent.click(startBtn);
        await waitFor(() => {
            expect(createEnterprise).toHaveBeenCalledWith(expect.objectContaining({
                name: 'Local Garden',
                avatar: 'bundled://bean-green',
                photos: ['bundled://bean-green'],
            }));
        });
    });

    it('Pictures S4: keyboard form submit without logo fails with "Choose a logo"', async () => {
        render(<ProjectsPage identity={mockIdentity} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: /Start something/i }));
        const dialog = screen.getByRole('dialog', { name: /Start something/i });
        fireEvent.click(within(dialog).getByRole('button', { name: /^Project/i }));

        const modal = screen.getByRole('dialog', { name: /Start a project/i });
        expect(modal).toBeInTheDocument();

        // Fill in required fields without picking logo
        fireEvent.change(within(modal).getByPlaceholderText(/e\.g\. Community Tool Shed/i), { target: { value: 'Local Garden' } });
        fireEvent.change(within(modal).getByPlaceholderText(/State clearly what this enterprise exists to do/i), { target: { value: 'Grow food together' } });
        fireEvent.change(within(modal).getByPlaceholderText(/e\.g\. 500/i), { target: { value: '100' } });

        // Submit form via submit event (keyboard Enter)
        const form = modal.querySelector('form')!;
        fireEvent.submit(form);

        // The line above the form says it; the Start button says the same words and stays off.
        await waitFor(() => {
            const lines = within(modal).getAllByText('Choose a logo').filter((el) => el.closest('button') === null);
            expect(lines).toHaveLength(1);
        });
        expect(within(modal).getByRole('button', { name: 'Choose a logo' })).toBeDisabled();
        expect(createEnterprise).not.toHaveBeenCalled();
    });
});
