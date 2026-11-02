/**
 * The web app's "Also show this on the global community" (slice G3), as the phone's: off by default, nothing asked until the member
 * taps, a stranger offered the door, and the row's words for each state. A community that names no global has none of it.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShowOnGlobalHostRow, ShowOnGlobalTick, showEventOnGlobal } from './ShowOnGlobalRow';
import { useCommunityInfo } from '../lib/features';
import * as copies from '../lib/show-on-global';

vi.mock('../lib/features', async () => ({ ...(await vi.importActual('../lib/features')), useCommunityInfo: vi.fn() }));
vi.mock('../lib/show-on-global', async () => ({
    ...(await vi.importActual('../lib/show-on-global')),
    askGlobalStanding: vi.fn(), copyPairOf: vi.fn(), forgetGlobalStanding: vi.fn(), readGlobalStanding: vi.fn(), showPostOnGlobal: vi.fn(), stopShowing: vi.fn(),
}));

const me: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
const local = { profile: 'local', globalCommunityUrl: 'https://global.example.org', addresses: [] };
const listing: any = { id: 'home-1', type: 'offer', status: 'active', authorPublicKey: 'me-pk', tags: [], photos: [] };
const LABEL = 'Also show this on the global community';

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCommunityInfo).mockReturnValue(local as any);
    vi.mocked(copies.readGlobalStanding).mockReturnValue('unknown');
    vi.mocked(copies.copyPairOf).mockResolvedValue(null);
    vi.stubGlobal('alert', vi.fn());
});

describe('the composer\'s tick', () => {
    const tick = (props: Partial<Parameters<typeof ShowOnGlobalTick>[0]> = {}) => {
        const onChange = vi.fn();
        render(<ShowOnGlobalTick enabled checked={false} onChange={onChange} identity={me} {...props} />);
        return onChange;
    };

    it('is off, and drawing it asks nobody anything', () => {
        tick();
        expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
        expect(screen.getByText(LABEL)).toBeTruthy();
        expect(copies.askGlobalStanding).not.toHaveBeenCalled();
    });

    it('ticks once global says this key is a member, and only then', async () => {
        vi.mocked(copies.askGlobalStanding).mockResolvedValue('member');
        const onChange = tick();
        fireEvent.click(screen.getByRole('checkbox'));
        await waitFor(() => expect(onChange).toHaveBeenCalledWith(true));
        expect(copies.askGlobalStanding).toHaveBeenCalledTimes(1);
    });

    it('a stranger there is offered the door, in a tab of its own and with what to use at it', async () => {
        vi.mocked(copies.askGlobalStanding).mockResolvedValue('stranger');
        const onChange = tick();
        fireEvent.click(screen.getByRole('checkbox'));
        const door = await screen.findByTestId('show-on-global-join');
        expect(onChange).not.toHaveBeenCalled();
        const link = door.querySelector('a') as HTMLAnchorElement;
        expect(link.href).toBe('https://global.example.org/');
        expect(link.target).toBe('_blank');
        expect(link.rel).toContain('noreferrer');
        expect(door.textContent).toContain('12 words');
    });

    it('global not answering says so, and stays off', async () => {
        vi.mocked(copies.askGlobalStanding).mockResolvedValue('unknown');
        const onChange = tick();
        fireEvent.click(screen.getByRole('checkbox'));
        await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
        expect(vi.mocked(alert).mock.calls[0][0]).toContain("can't be reached");
        expect(onChange).not.toHaveBeenCalled();
    });

    it('an answer landing once the form has gone ticks nothing', async () => {
        let answer: (s: 'member') => void = () => {};
        vi.mocked(copies.askGlobalStanding).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
        const onChange = vi.fn();
        const { unmount } = render(<ShowOnGlobalTick enabled checked={false} onChange={onChange} identity={me} />);
        fireEvent.click(screen.getByRole('checkbox'));
        unmount();
        await act(async () => { answer('member'); });
        expect(onChange).not.toHaveBeenCalled();
    });

    it('goes off when the form moves away from what it is for', () => {
        const onChange = tick({ enabled: false, checked: true });
        expect(onChange).toHaveBeenCalledWith(false);
        expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('an online event is told why not', () => {
        tick({ enabled: false, online: true });
        expect(screen.getByTestId('show-on-global-online').textContent).toContain("Online events can't be shown");
    });

    it('says what goes of a listing, and of a Need', () => {
        tick({ listing: true });
        expect(document.body.textContent).toContain('To buy or take it, they ask to join.');
        document.body.innerHTML = '';
        tick({ listing: true, need: true });
        expect(document.body.textContent).toContain('To answer it, they ask to join.');
    });

    it('a community that names no global has no tick, nor the global community itself', () => {
        vi.mocked(useCommunityInfo).mockReturnValue({ profile: 'local', addresses: [] } as any);
        const { container, unmount } = render(<ShowOnGlobalTick enabled checked={false} onChange={() => {}} identity={me} />);
        expect(container.textContent).toBe('');
        unmount();
        vi.mocked(useCommunityInfo).mockReturnValue({ profile: 'global', globalCommunityUrl: 'https://global.example.org' } as any);
        expect(render(<ShowOnGlobalTick enabled checked={false} onChange={() => {}} identity={me} />).container.textContent).toBe('');
    });

    it('no key in this browser, no tick', () => {
        expect(render(<ShowOnGlobalTick enabled checked={false} onChange={() => {}} identity={null} />).container.textContent).toBe('');
    });
});

describe('the row on a member\'s own page', () => {
    const row = (post = listing, extra: { enabled?: boolean; listing?: boolean } = {}) => render(<ShowOnGlobalHostRow post={post} identity={me} enabled listing {...extra} />);

    it('offers the same tick for a post made without it, and says what goes', async () => {
        vi.mocked(copies.askGlobalStanding).mockResolvedValue('member');
        vi.mocked(copies.showPostOnGlobal).mockResolvedValue(null);
        row();
        fireEvent.click(await screen.findByTestId('show-on-global-act'));
        await waitFor(() => expect(copies.showPostOnGlobal).toHaveBeenCalledTimes(1));
        expect(alert).not.toHaveBeenCalled();
    });

    it('shown: says so, and offers to stop', async () => {
        vi.mocked(copies.copyPairOf).mockResolvedValue({ copyId: 'c', resting: false } as any);
        vi.mocked(copies.stopShowing).mockResolvedValue(true);
        row();
        expect(await screen.findByText('Shown on the global community')).toBeTruthy();
        fireEvent.click(screen.getByText('Stop showing'));
        await waitFor(() => expect(copies.stopShowing).toHaveBeenCalledWith('home-1', me));
    });

    it('a stop that reached nobody says the copy is still up', async () => {
        vi.mocked(copies.copyPairOf).mockResolvedValue({ copyId: 'c', resting: false } as any);
        vi.mocked(copies.stopShowing).mockResolvedValue(false);
        row();
        fireEvent.click(await screen.findByText('Stop showing'));
        await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
        expect(vi.mocked(alert).mock.calls[0][0]).toContain('as soon as it can');
    });

    it('resting: a listing\'s words and an event\'s, and either can still be stopped', async () => {
        vi.mocked(copies.copyPairOf).mockResolvedValue({ copyId: 'c', resting: true } as any);
        const first = row();
        expect(await screen.findByText("It comes down while this is off the board here, and goes back up when it's on again.")).toBeTruthy();
        first.unmount();
        row({ ...listing, type: 'event' }, { listing: false });
        expect(await screen.findByText("It comes down while you're on holiday, and goes back up when you're back.")).toBeTruthy();
        expect(screen.getByText('Stop showing')).toBeTruthy();
    });

    it('a listing off the board is offered nothing, and what it has running stays to stop', async () => {
        const off = { ...listing, status: 'paused' };
        const { container, unmount } = row(off);
        await act(async () => {});
        expect(container.textContent).toBe('');
        unmount();
        vi.mocked(copies.copyPairOf).mockResolvedValue({ copyId: 'c', resting: true } as any);
        row(off);
        expect(await screen.findByText('Stop showing')).toBeTruthy();
    });

    it('a stranger there gets the door', async () => {
        vi.mocked(copies.readGlobalStanding).mockReturnValue('stranger');
        row();
        expect(await screen.findByTestId('show-on-global-join')).toBeTruthy();
    });

    it('not enabled, nothing is read and nothing is drawn', async () => {
        const { container } = row(listing, { enabled: false });
        await act(async () => {});
        expect(container.textContent).toBe('');
        expect(copies.copyPairOf).not.toHaveBeenCalled();
    });
});

describe('coming back from the door', () => {
    const atTheDoor = async () => {
        vi.mocked(copies.readGlobalStanding).mockReturnValue('stranger');
        const drawn = render(<ShowOnGlobalTick enabled checked={false} onChange={() => {}} identity={me} />);
        return { drawn, door: (await screen.findByTestId('show-on-global-join')).querySelector('a') as HTMLAnchorElement };
    };
    /** The tab goes behind global's and comes back, as a browser says so. */
    const tabBack = async (state: 'visible' | 'hidden' = 'visible') => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    };

    it('drawing the door and the tab coming back ask nothing: only a member who tapped it is asked after', async () => {
        await atTheDoor();
        await tabBack();
        await act(async () => { window.dispatchEvent(new Event('focus')); });
        expect(copies.askGlobalStanding).not.toHaveBeenCalled();
    });

    it('tapping it asks nothing yet, nor does the tab going behind', async () => {
        const { door } = await atTheDoor();
        fireEvent.click(door);
        await tabBack('hidden');
        expect(copies.askGlobalStanding).not.toHaveBeenCalled();
    });

    it('joined there, the row is the tick again as the tab comes back, by itself', async () => {
        vi.mocked(copies.askGlobalStanding).mockResolvedValue('member');
        const { door } = await atTheDoor();
        fireEvent.click(door);
        await tabBack('hidden');
        await tabBack();
        expect(copies.askGlobalStanding).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('show-on-global-join')).toBeNull();
        expect(screen.getByRole('checkbox')).toBeTruthy();
        await tabBack();
        expect(copies.askGlobalStanding).toHaveBeenCalledTimes(1);
    });

    it('so does the host\'s page', async () => {
        vi.mocked(copies.askGlobalStanding).mockResolvedValue('member');
        vi.mocked(copies.readGlobalStanding).mockReturnValue('stranger');
        render(<ShowOnGlobalHostRow post={listing} identity={me} enabled listing />);
        fireEvent.click((await screen.findByTestId('show-on-global-join')).querySelector('a') as HTMLAnchorElement);
        await tabBack();
        expect(await screen.findByTestId('show-on-global-act')).toBeTruthy();
    });

    it('the tab and the window both saying it came back are one ask', async () => {
        let answer: (s: 'member') => void = () => {};
        vi.mocked(copies.askGlobalStanding).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
        const { door } = await atTheDoor();
        fireEvent.click(door);
        await tabBack();
        await act(async () => { window.dispatchEvent(new Event('focus')); });
        expect(copies.askGlobalStanding).toHaveBeenCalledTimes(1);
        await act(async () => { answer('member'); });
    });

    it('a window that comes back by focus alone counts', async () => {
        vi.mocked(copies.askGlobalStanding).mockResolvedValue('member');
        const { door } = await atTheDoor();
        fireEvent.click(door);
        await act(async () => { window.dispatchEvent(new Event('focus')); });
        expect(copies.askGlobalStanding).toHaveBeenCalledTimes(1);
    });

    it('back before joining stays at the door, and the next time back asks once more', async () => {
        vi.mocked(copies.askGlobalStanding).mockResolvedValueOnce('stranger').mockResolvedValueOnce('member');
        const { door } = await atTheDoor();
        fireEvent.click(door);
        await tabBack();
        expect(screen.getByTestId('show-on-global-join')).toBeTruthy();
        await tabBack();
        expect(copies.askGlobalStanding).toHaveBeenCalledTimes(2);
        expect(screen.queryByTestId('show-on-global-join')).toBeNull();
    });

    it('the tap lets go of the kept answer, so a reload isn\'t the door for the rest of the day', async () => {
        const { door } = await atTheDoor();
        fireEvent.click(door);
        expect(copies.forgetGlobalStanding).toHaveBeenCalledWith('me-pk');
    });

    it('a row that has gone asks nothing', async () => {
        const { drawn, door } = await atTheDoor();
        fireEvent.click(door);
        drawn.unmount();
        await tabBack();
        await act(async () => { window.dispatchEvent(new Event('focus')); });
        expect(copies.askGlobalStanding).not.toHaveBeenCalled();
    });
});

describe('what the tap sends on', () => {
    it('a line the member is owed comes as one alert; a copy that went up says nothing', async () => {
        vi.mocked(copies.showPostOnGlobal).mockResolvedValueOnce(null);
        await showEventOnGlobal(listing, me);
        expect(alert).not.toHaveBeenCalled();
        vi.mocked(copies.showPostOnGlobal).mockResolvedValueOnce("Your community isn't in the directory, so this shows there without its name.");
        await showEventOnGlobal(listing, me);
        expect(vi.mocked(alert).mock.calls[0][0]).toContain('directory');
    });
});
