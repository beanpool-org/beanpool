import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NOTIFY_CHOICES } from '@beanpool/core';
import { OnboardingModule } from './OnboardingModule';
import * as nodeClient from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';

vi.mock('../../lib/node-client', async () => {
    const actual = await vi.importActual('../../lib/node-client');
    return {
        ...actual,
        fetchOnboardingFunnel: vi.fn(),
    };
});

describe('OnboardingModule', () => {
    const mockProfiles: NodeProfile[] = [
        {
            id: 'node-1',
            name: 'Node Alpha',
            url: 'https://alpha.beanpool.org',
            automationToken: 'token-alpha',
        },
        {
            id: 'node-2',
            name: 'Node Beta',
            url: 'https://beta.beanpool.org',
            automationToken: 'token-beta',
        },
    ];

    const mockSelectNode = vi.fn();

    const renderModule = () => render(
        <OnboardingModule
            profiles={mockProfiles}
            activeProfileId="node-1"
            onSelectNode={mockSelectNode}
        />
    );

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders loading state initially and fetches onboarding funnel data', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockImplementation(
            () => new Promise(() => {}) // pending promise
        );

        renderModule();

        expect(screen.getByRole('heading', { name: /Onboarding/i })).toBeInTheDocument();
        expect(screen.getByText(/How many people tried to join Node Alpha/i)).toBeInTheDocument();
        expect(screen.getByText('Reading the funnel…')).toBeInTheDocument();
        expect(nodeClient.fetchOnboardingFunnel).toHaveBeenCalledWith(
            'https://alpha.beanpool.org',
            'token-alpha',
            30
        );
    });

    it('renders error state when funnel fetch fails', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockRejectedValue(
            new Error('Network error reaching node')
        );

        renderModule();

        await waitFor(() => {
            expect(screen.getByText("Couldn't read this node")).toBeInTheDocument();
        });
        expect(screen.getByText('Network error reaching node')).toBeInTheDocument();
    });

    it('renders empty state when profiles array is empty', () => {
        render(
            <OnboardingModule
                profiles={[]}
                activeProfileId=""
                onSelectNode={mockSelectNode}
            />
        );

        expect(screen.getByText('No Node Profiles Available')).toBeInTheDocument();
        expect(
            screen.getByText(/Configure or select a sovereign node profile in Fleet Settings/i)
        ).toBeInTheDocument();
    });

    it('says plainly when nobody joined and when no step has been counted per person', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({ days: 30, rows: [] });

        renderModule();

        await waitFor(() => {
            expect(screen.getByText(/Nobody joined in this window/i)).toBeInTheDocument();
        });
        expect(screen.getByText(/Nothing counted once per person yet/i)).toBeInTheDocument();
    });

    /**
     * The cohort: one group of people, followed. "Joined" is the base and is 100%; the rows
     * under it are subsets of that same group, so their percentages are shares of it.
     */
    it('renders the cohort with Joined as 100% and the follow-ups as shares of it', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [
                { day: '2026-09-01', event: 'member_created', variant: '', count: 8 },
                { day: '2026-09-01', event: 'cohort_photo', variant: '', count: 6 },
                { day: '2026-09-01', event: 'cohort_posted', variant: '', count: 2 },
                { day: '2026-09-02', event: 'member_created', variant: '', count: 2 },
            ],
        });

        renderModule();

        await waitFor(() => {
            expect(screen.getByText('Joined')).toBeInTheDocument();
        });

        const row = (label: string) =>
            screen.getByText(label).closest('div.p-3') as HTMLElement;

        // 10 joined across the two days, and every rate below is a share of that.
        expect(row('Joined')).toHaveTextContent('10');
        expect(row('Joined')).toHaveTextContent('100%');
        expect(row('Has a photo')).toHaveTextContent('6');
        expect(row('Has a photo')).toHaveTextContent('60%');
        expect(row('Has posted')).toHaveTextContent('2');
        expect(row('Has posted')).toHaveTextContent('20%');

        // The screen says out loud that the in-app steps are not tied to these people.
        expect(screen.getByText(/cannot link these/i)).toBeInTheDocument();
    });

    /**
     * The in-app steps count only rows a client deduplicated per person. The old
     * one-per-showing rows are what produced "56 showings from 20 joins, shown as 350%";
     * they cannot be corrected after the fact, so they are named and left out.
     */
    it('adds up only the per-person in-app reports, and names the day they start from', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [
                { day: '2026-09-01', event: 'member_created', variant: '', count: 20 },
                // Old, one-per-showing: 56 reports from 20 people. Ignored.
                { day: '2026-09-01', event: 'protection_shown', variant: 'C', count: 56 },
                { day: '2026-09-01', event: 'guide_complete', variant: '', count: 9 },
                // New, one per person.
                { day: '2026-09-10', event: 'protection_shown', variant: 'once', count: 7 },
                { day: '2026-09-11', event: 'protection_choice', variant: 'once:words', count: 3 },
                { day: '2026-09-11', event: 'protection_choice', variant: 'once:skip', count: 1 },
                { day: '2026-09-12', event: 'guide_complete', variant: 'once', count: 4 },
            ],
        });

        renderModule();

        await waitFor(() => {
            expect(screen.getByText('Saw the protection screen')).toBeInTheDocument();
        });

        const row = (label: string) =>
            screen.getByText(label).closest('div.p-3') as HTMLElement;

        expect(row('Saw the protection screen')).toHaveTextContent('7');
        expect(row('Saw the protection screen')).not.toHaveTextContent('56');
        // Both sub-types of the same step add up into one figure for the step.
        expect(row('Chose how to be protected')).toHaveTextContent('4');
        // guide_complete counts the join's last step: the phone's way-back step (Safety Backup) since slice S5.
        expect(row('Way back step done')).toHaveTextContent('4');
        expect(row('Way back step done')).toHaveTextContent('Phone: Safety Backup finished. Web: How it Works finished');
        expect(screen.queryByText('Finished the guide')).toBeNull();

        // The earliest per-person day, not the earliest day in the window.
        expect(screen.getByText(/Counted once per person since/i)).toHaveTextContent('2026-09-10');
        // 56 + 9 older reports, named rather than silently dropped.
        expect(screen.getByText(/older reports are left out/i)).toHaveTextContent('65');
    });

    /**
     * The join's notifications screen (slice N1c, DESIGN-notify-and-backup-asks-fable-amend2.md §4.4): four numbers,
     * shown, turned on, later, the phone said no. Counts only. ONE table over every kind of stored row: each row is
     * drawn alone, and all four numbers are read, so a row that lands in the wrong number, or in none, is red.
     */
    describe("the join's notifications screen: four numbers", () => {
        const NOTIFY_LABELS = {
            shown: 'Saw the notifications screen',
            on: 'Turned notifications on',
            later: 'Chose Later',
            no: 'The phone said no',
        } as const;
        type Lands = keyof typeof NOTIFY_LABELS | null;

        const TABLE: [label: string, event: string, variant: string, lands: Lands][] = [
            ['the screen drawn, once per person', 'notify_shown', 'once', 'shown'],
            ['turned on: the phone said yes', 'notify_choice', 'once:on', 'on'],
            ['later', 'notify_choice', 'once:later', 'later'],
            ['the phone said no', 'notify_choice', 'once:no', 'no'],
            ['the screen drawn, not per person', 'notify_shown', '', null],
            ['an answer, not per person', 'notify_choice', 'on', null],
            ['an answer with no answer in it', 'notify_choice', 'once', null],
            ['an answer that is not one of the three', 'notify_choice', 'once:yes', null],
            ["another step's answer that reads like one", 'protection_choice', 'once:no', null],
            ["another step's answer", 'protection_choice', 'once:skip', null],
            ['the way back step done', 'guide_complete', 'once', null],
            ['a join', 'member_created', '', null],
        ];

        const countIn = (label: string) =>
            (screen.getByText(label).closest('div.p-3') as HTMLElement).querySelector('.text-lg')?.textContent;

        it.each(TABLE)('%s', async (_label, event, variant, lands) => {
            vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
                days: 30,
                rows: [{ day: '2026-11-22', event, variant, count: 3 }],
            });

            renderModule();

            await screen.findByText(NOTIFY_LABELS.shown);
            for (const [key, label] of Object.entries(NOTIFY_LABELS)) {
                expect([label, countIn(label)]).toEqual([label, key === lands ? '3' : '0']);
            }
        });

        it('the table lands in each of the four numbers, and core has exactly the three answers it labels', () => {
            for (const key of Object.keys(NOTIFY_LABELS)) expect(TABLE.some(r => r[3] === key)).toBe(true);
            expect([...NOTIFY_CHOICES]).toEqual(['on', 'later', 'no']);
        });

        it('adds each answer up across days, apart from the others, under the steps before it', async () => {
            vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
                days: 30,
                rows: [
                    { day: '2026-11-22', event: 'guide_complete', variant: 'once', count: 12 },
                    { day: '2026-11-22', event: 'notify_shown', variant: 'once', count: 6 },
                    { day: '2026-11-23', event: 'notify_shown', variant: 'once', count: 4 },
                    { day: '2026-11-22', event: 'notify_choice', variant: 'once:on', count: 3 },
                    { day: '2026-11-23', event: 'notify_choice', variant: 'once:on', count: 2 },
                    { day: '2026-11-23', event: 'notify_choice', variant: 'once:later', count: 4 },
                    { day: '2026-11-23', event: 'notify_choice', variant: 'once:no', count: 1 },
                ],
            });

            renderModule();

            await screen.findByText(NOTIFY_LABELS.shown);
            expect(countIn(NOTIFY_LABELS.shown)).toBe('10');
            expect(countIn(NOTIFY_LABELS.on)).toBe('5');
            expect(countIn(NOTIFY_LABELS.later)).toBe('4');
            expect(countIn(NOTIFY_LABELS.no)).toBe('1');
            expect(countIn('Way back step done')).toBe('12');

            // In the steps inside the app, after the way back, in the join's order; counted people, never who.
            const section = screen.getByRole('region', { name: 'Steps inside the app' });
            const order = within(section).getAllByText(/^(Way back step done|Saw the notifications screen|Turned notifications on|Chose Later|The phone said no)$/)
                .map(el => el.textContent);
            expect(order).toEqual(['Way back step done', ...Object.values(NOTIFY_LABELS)]);
            expect(within(section).getByText(NOTIFY_LABELS.no).closest('div.p-3')).toHaveTextContent(
                "Tapped Turn on notifications, then said no to the phone's own question",
            );
            expect(within(section).getByText(NOTIFY_LABELS.later).closest('div.p-3')).toHaveTextContent(
                'Not a no: they can still turn them on, and the app may ask again',
            );
            expect(within(section).getByText(NOTIFY_LABELS.shown).closest('div.p-3')).toHaveTextContent(
                'In the join, after the way back; shown only on a phone that has to ask',
            );
            expect(screen.getByText(/Counted once per person since/i)).toHaveTextContent('2026-11-22');
        });
    });

    it('keeps codes as their own box, counted as attempts rather than people', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [
                { day: '2026-09-01', event: 'invite_attempt', variant: '', count: 10 },
                { day: '2026-09-01', event: 'invite_reentry', variant: '', count: 1 },
                { day: '2026-09-01', event: 'invite_failed', variant: 'invalid', count: 2 },
                { day: '2026-09-01', event: 'invite_failed', variant: 'expired', count: 1 },
                { day: '2026-09-01', event: 'member_created', variant: '', count: 6 },
            ],
        });

        renderModule();

        await waitFor(() => {
            expect(screen.getByText('Entered an invite code')).toBeInTheDocument();
        });

        expect(screen.getByText(/Attempts, not people/i)).toBeInTheDocument();
        expect(screen.getByText('Code not recognised')).toBeInTheDocument();
        expect(screen.getByText('Code had expired')).toBeInTheDocument();
        expect(screen.getByText(/already-a-member re-entry/i)).toBeInTheDocument();
    });

    /**
     * The open door (the global node's sign-in join): tries are counted as they happen, the people who
     * came in are a subset of Joined, and each refusal is named in plain words.
     */
    it('shows the open door: tries, who came in by provider, and why people were turned away', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            openDoor: true,
            rows: [
                { day: '2026-09-01', event: 'member_created', variant: '', count: 9 },
                { day: '2026-09-01', event: 'open_join_attempt', variant: 'google', count: 5 },
                { day: '2026-09-02', event: 'open_join_attempt', variant: 'apple', count: 2 },
                { day: '2026-09-01', event: 'cohort_open_door', variant: 'google', count: 3 },
                { day: '2026-09-02', event: 'cohort_open_door', variant: 'apple', count: 1 },
                { day: '2026-09-01', event: 'open_join_failed', variant: 'rate_limited', count: 2 },
                { day: '2026-09-02', event: 'open_join_failed', variant: 'already_joined', count: 1 },
                { day: '2026-09-02', event: 'open_join_failed', variant: 'door_key_missing', count: 3 },
                { day: '2026-09-02', event: 'open_join_failed', variant: 'ticket_signature', count: 4 },
            ],
        });

        renderModule();

        const section = await screen.findByRole('region', { name: 'Open door' });
        const box = (label: string) => within(section).getByText(label).closest('div') as HTMLElement;
        expect(box('Tried to join this way')).toHaveTextContent('7');
        expect(box('Joined this way')).toHaveTextContent('4');
        expect(within(section).getByText('Google 3 · Apple 1')).toBeInTheDocument();
        expect(within(section).getByText(/It is/)).toHaveTextContent('It is open here.');

        const reason = (label: string) => within(section).getByText(label).closest('li') as HTMLElement;
        expect(reason('Too many new accounts from one network')).toHaveTextContent('2');
        expect(reason('That sign-in already joined here')).toHaveTextContent('1');
        expect(reason("This server can't check sign-ins: its open-door key is missing")).toHaveTextContent('3');
        expect(within(section).queryByText('door_key_missing')).not.toBeInTheDocument();
        expect(reason('Key vault ticket not signed by a key this server lists')).toHaveTextContent('4');
        expect(within(section).queryByText('ticket_signature')).not.toBeInTheDocument();
        expect(within(section).queryByText(/Nobody used the open door/i)).not.toBeInTheDocument();
        expect(within(section).queryByText(/Nobody was turned away/i)).not.toBeInTheDocument();
    });

    it('says plainly when nobody used the open door, and that it is shut', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({ days: 30, rows: [], openDoor: false });

        renderModule();

        const section = await screen.findByRole('region', { name: 'Open door' });
        expect(within(section).getByText('Nobody used the open door in this window.')).toBeInTheDocument();
        expect(within(section).getByText(/It is/)).toHaveTextContent('It is shut here, so people join only with an invite.');
        expect(within(section).getByText('Tried to join this way').closest('div')).toHaveTextContent('0');
        expect(within(section).getByText('Joined this way').closest('div')).toHaveTextContent('0');
        expect(within(section).getByText('Nobody was turned away in this window.')).toBeInTheDocument();
    });

    /** The 12-words door and the door's work (server: engine/door-signal.ts, services/door-work.ts): named too, never as codes. */
    it('names the 12-words door, the ceilings and the door work in plain words', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            openDoor: true,
            rows: [
                { day: '2026-10-01', event: 'open_join_attempt', variant: 'words', count: 6 },
                { day: '2026-10-01', event: 'cohort_open_door', variant: 'words', count: 4 },
                { day: '2026-10-01', event: 'cohort_open_door', variant: 'google', count: 1 },
                { day: '2026-10-01', event: 'open_join_failed', variant: 'network_busy_words', count: 2 },
                { day: '2026-10-01', event: 'open_join_failed', variant: 'network_busy', count: 1 },
                { day: '2026-10-01', event: 'open_join_failed', variant: 'work_required', count: 1 },
                { day: '2026-10-01', event: 'open_join_failed', variant: 'work_invalid', count: 1 },
                { day: '2026-10-01', event: 'open_join_failed', variant: 'work_expired', count: 1 },
                { day: '2026-10-01', event: 'open_join_failed', variant: 'work_spent', count: 1 },
            ],
        });

        renderModule();

        const section = await screen.findByRole('region', { name: 'Open door' });
        expect(within(section).getByText('12 words 4 · Google 1')).toBeInTheDocument();
        const reason = (label: string) => within(section).getByText(label).closest('li') as HTMLElement;
        expect(reason('Too many 12-words accounts from one network (the sign-in way stayed open)')).toHaveTextContent('2');
        expect(reason('Too many new accounts from one network')).toHaveTextContent('1');
        expect(reason('Setting up was needed and none was sent (an older app on a busy network)')).toHaveTextContent('1');
        expect(reason("Setting up didn't check out")).toHaveTextContent('1');
        expect(reason('Setting up took over ten minutes')).toHaveTextContent('1');
        expect(reason('Setting up was used twice')).toHaveTextContent('1');
        for (const code of ['network_busy', 'network_busy_words', 'work_required', 'work_invalid', 'work_expired', 'work_spent', 'words']) {
            expect(within(section).queryByText(code)).not.toBeInTheDocument();
        }
    });

    it('says neither open nor shut for a node too old to send it', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({ days: 30, rows: [] });

        renderModule();

        const section = await screen.findByRole('region', { name: 'Open door' });
        expect(within(section).queryByText(/It is (open|shut)/)).not.toBeInTheDocument();
        expect(within(section).getByText('Nobody used the open door in this window.')).toBeInTheDocument();
    });

    /**
     * Both were stale: keeper recovery is gone, so nothing lands in the keepers panel and
     * nothing "arrives with Phase A" any more. Leaving either on screen tells an operator
     * something untrue about their own community.
     */
    it('no longer shows the keepers panel or the Phase A hints', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [
                { day: '2026-09-01', event: 'member_created', variant: '', count: 4 },
                { day: '2026-09-01', event: 'protection_shown', variant: 'A', count: 5 },
            ],
        });

        renderModule();

        await waitFor(() => {
            expect(screen.getByText('Joined')).toBeInTheDocument();
        });

        expect(screen.queryByText(/Keepers at signup/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/had a spare to offer/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/no longer grow/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Phase A/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/not measured yet/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Actually got started/i)).not.toBeInTheDocument();
    });

    it('allows switching lookback window days and changing target node', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [],
        });

        renderModule();

        await waitFor(() => {
            expect(nodeClient.fetchOnboardingFunnel).toHaveBeenCalledWith(
                'https://alpha.beanpool.org',
                'token-alpha',
                30
            );
        });

        const window7Btn = screen.getByRole('button', { name: '7 days' });
        await userEvent.click(window7Btn);

        expect(nodeClient.fetchOnboardingFunnel).toHaveBeenCalledWith(
            'https://alpha.beanpool.org',
            'token-alpha',
            7
        );

        const nodeSelect = screen.getByRole('combobox', {
            name: "Choose which node's funnel to show",
        });
        await userEvent.selectOptions(nodeSelect, 'node-2');

        expect(mockSelectNode).toHaveBeenCalledWith('node-2');
    });

    it("reads a node's funnel with that profile's own token and the days, and nothing else", async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [],
        });

        render(
            <OnboardingModule
                profiles={mockProfiles}
                activeProfileId="node-2"
                onSelectNode={mockSelectNode}
            />
        );

        await waitFor(() => {
            expect(nodeClient.fetchOnboardingFunnel).toHaveBeenCalledWith(
                'https://beta.beanpool.org',
                'token-beta',
                30
            );
        });
    });
});
