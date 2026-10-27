import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { backToEnglish, bypassing, showIn, xx } from '../words-w2.test-support';
import { ProjectsPage } from './ProjectsPage';
import { getTreasuries, getDecisions, getCommonsBalance, getGroups } from '../lib/api';

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({
        memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 100, profile: 'local',
        features: { beans: true, enterprises: true, decisions: true },
    })),
}));

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getTreasuries: vi.fn(),
    getBalance: vi.fn(async () => ({ balance: 100, floor: -500, commonsBalance: 250, earnedCredit: 12, callsign: 'Me', keeperOf: [], tier: 'contributor' })),
    createEnterprise: vi.fn(async () => ({ success: true })),
    getDecisions: vi.fn(),
    getCommonsBalance: vi.fn(async () => ({ balance: 250 })),
    getAllMembers: vi.fn(async () => []),
    getGroups: vi.fn(),
    getYourGroups: vi.fn(async () => ({ items: [] })),
}));

const ME: any = { publicKey: 'me-pk', privateKey: 'k', callsign: 'Me', createdAt: '2026-09-01T00:00:00Z' };

beforeEach(() => {
    vi.mocked(getTreasuries).mockResolvedValue({ treasuries: [] } as any);
    vi.mocked(getGroups).mockResolvedValue([] as any);
    vi.mocked(getDecisions).mockResolvedValue({ decisions: [], myPoolVoting: { voiceCredits: 9.6, hasCompletedTrade: true }, canPropose: true } as any);
    vi.mocked(getCommonsBalance).mockResolvedValue({ balance: 250 } as any);
});

afterEach(() => {
    cleanup();
    backToEnglish();
    vi.restoreAllMocks();
});

describe('ProjectsPage Start Something in pseudo-locale (words §5 S2)', () => {
    it('Start something button and dialog rows come through t()', async () => {
        await showIn('xx');
        render(<ProjectsPage identity={ME} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        const startBtn = screen.getByRole('button', { name: (n) => n.includes(xx('Start something')) });
        expect(startBtn).toBeInTheDocument();

        fireEvent.click(startBtn);

        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByText(xx('Start something'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('Chat group'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('A place to talk with some people. Holds no Beans.'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('Project'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('A goal in Beans, a leader, usually an end date.'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('Enterprise'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('Keeps going and trades. Its keepers run it.'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('Decision'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('A binding vote for the whole community.'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('In the Market'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('Poll'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('A quick question for everyone. Open vote.'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx('Event'))).toBeInTheDocument();
        expect(within(dialog).getByText(xx("A time and a place. People say they're going."))).toBeInTheDocument();

        expect(bypassing(dialog)).toEqual([]);
    });

    it('propose modal titles and submit buttons by kind come through t()', async () => {
        await showIn('xx');
        render(<ProjectsPage identity={ME} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());

        // Open Enterprise
        fireEvent.click(screen.getByRole('button', { name: (n) => n.includes(xx('Start something')) }));
        let dialog = screen.getByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: (n) => n.includes(xx('Enterprise')) }));

        let proposeModal = screen.getByRole('dialog');
        expect(within(proposeModal).getByRole('heading', { level: 2 }).textContent).toBe(xx('Start an enterprise'));
        expect(within(proposeModal).getByRole('button', { name: xx('Choose a logo') })).toBeDisabled();
        fireEvent.click(within(within(proposeModal).getByRole('region', { name: xx('Or choose an avatar:') })).getAllByRole('button')[0]);
        expect(within(proposeModal).getByRole('button', { name: xx('Start the enterprise 🏛️') })).toBeInTheDocument();
        fireEvent.click(within(proposeModal).getByRole('button', { name: xx('Close dialog') }));

        // Open Project
        fireEvent.click(screen.getByRole('button', { name: (n) => n.includes(xx('Start something')) }));
        dialog = screen.getByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: (n) => n.includes(xx('Project')) }));

        proposeModal = screen.getByRole('dialog');
        expect(within(proposeModal).getByRole('heading', { level: 2 }).textContent).toBe(xx('Start a project'));
        // The form keeps its draft between opens, the logo chosen above with it, so Start reads as the kind's.
        expect(within(proposeModal).getByRole('button', { name: xx('Remove photo') })).toBeInTheDocument();
        expect(within(proposeModal).getByRole('button', { name: xx('Start the project 🌱') })).toBeInTheDocument();
        fireEvent.click(within(proposeModal).getByRole('button', { name: xx('Close dialog') }));

        // Open via group bridge
        fireEvent.click(screen.getByRole('button', { name: (n) => n.includes(xx('Start something')) }));
        dialog = screen.getByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: (n) => n.includes(xx('Chat group')) }));

        const groupModal = screen.getByRole('dialog');
        fireEvent.click(within(groupModal).getByText((n) => n.includes(xx('Start a project or an enterprise →'))));

        proposeModal = screen.getByRole('dialog');
        expect(within(proposeModal).getByRole('heading', { level: 2 }).textContent).toBe(xx('Start a project or an enterprise'));
        expect(within(proposeModal).getByRole('button', { name: xx('Choose a project or an enterprise first') })).toBeInTheDocument();
    });
});
