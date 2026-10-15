/**
 * The host lets people in (scratch/global-node/DESIGN-global-member-privacy-fable.md §2.3, §7 slice 3), on the web: the
 * member's three states and the host's panel at 320px with text at 130%, the chat's `waiting_for_host` refusal never
 * read as "only the host and people going", and the form's payload and edit.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventDetail } from './EventCard';
import { EventChat } from './EventChat';
import * as api from '../lib/api';
import {
    eventEditForm, eventEditPayload, hostLetsInDefault, privateNoteHelper, eventLetInState, eventWaitingCount, hostLetsInOffWarning,
} from '../lib/events';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, rsvpEvent: vi.fn(), removeMarketplacePost: vi.fn(), getMarketplacePosts: vi.fn(async () => []), letInToEvent: vi.fn(), getEventChat: vi.fn() };
});

const HOUR = 60 * 60 * 1000;
const start = Date.now() + 48 * HOUR;
const NOTE = 'Blue gate, number 12, code 4321';
const ev: any = {
    id: 'ev-1', type: 'event', category: 'community', title: 'Garden dinner', description: 'Bring a plate', credits: 0, priceType: 'fixed',
    authorPublicKey: 'host-pk', authorCallsign: 'Hana', createdAt: new Date().toISOString(), active: true, status: 'active', repeatable: false,
    lat: -28.65, lng: 153.56, eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 2 * HOUR).toISOString(),
    eventPlaceName: 'Bangalow Hall', eventState: 'scheduled', goingCount: 3, interestedCount: 1, eventHostLetsIn: true,
};
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

function renderAt320(ui: React.ReactElement) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}>{ui}</div>);
}

describe('a member, where the host lets people in (320px, 130%)', () => {
    afterEach(() => { document.documentElement.style.fontSize = ''; });

    it('before Going: told the host lets people in, and not "it shows here once you tap Going"', () => {
        renderAt320(<EventDetail post={{ ...ev, myRsvp: null, myLetIn: null }} identity={identity} onOpenChat={() => {}} />);
        expect(screen.getByTestId('event-let-in-line')).toHaveTextContent('The host lets people in. Tap Going, and the note and the chat open once they do.');
        expect(screen.queryByText(/shows here once you tap Going/)).not.toBeInTheDocument();
        expect(screen.queryByTestId('event-open-chat')).not.toBeInTheDocument();
        expect(screen.getByTestId('event-let-in-line').className).toMatch(/break-words/);
    });
    it('Going and waiting: the waiting words, the chat entry disabled with its own words, no note', () => {
        renderAt320(<EventDetail post={{ ...ev, myRsvp: 'going', myLetIn: false }} identity={identity} onOpenChat={() => {}} />);
        expect(screen.getByTestId('event-let-in-line')).toHaveTextContent("You're going. The host hasn't let you in yet: the note and the chat open when they do.");
        const entry = screen.getByTestId('event-chat-waiting');
        expect(entry).toBeDisabled();
        expect(entry).toHaveTextContent('Chat opens when the host lets you in.');
        expect(entry.className).toMatch(/min-h-\[48px\]/);
        expect(screen.queryByTestId('event-open-chat')).not.toBeInTheDocument();
        expect(screen.queryByTestId('event-private-note')).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain('Only the host and people going');
    });
    it('let in: the note and the chat entry, no waiting words', () => {
        renderAt320(<EventDetail post={{ ...ev, myRsvp: 'going', myLetIn: true, eventPrivateNote: NOTE }} identity={identity} onOpenChat={() => {}} />);
        expect(screen.getByTestId('event-private-note')).toHaveTextContent(NOTE);
        expect(screen.getByTestId('event-open-chat')).toBeInTheDocument();
        expect(screen.queryByTestId('event-let-in-line')).not.toBeInTheDocument();
    });
    it('online: the join link waits like the note, and the hint says so, never "tap Going" or "not added"', () => {
        const online = { ...ev, eventOnline: true, lat: undefined, lng: undefined, eventPlaceName: undefined };
        const before = renderAt320(<EventDetail post={{ ...online, myRsvp: null, myLetIn: null }} identity={identity} onOpenChat={() => {}} />);
        expect(screen.getByTestId('event-join-hint')).toHaveTextContent('The link to join shows here once the host lets you in.');
        expect(screen.queryByText(/once you tap Going/)).not.toBeInTheDocument();
        before.unmount();
        const waiting = renderAt320(<EventDetail post={{ ...online, myRsvp: 'going', myLetIn: false }} identity={identity} onOpenChat={() => {}} />);
        expect(screen.getByTestId('event-join-hint')).toHaveTextContent('The link to join shows here once the host lets you in.');
        expect(screen.queryByText(/has not added a link/)).not.toBeInTheDocument();
        waiting.unmount();
        // Let in: the link, or, where the host really has not added one, that.
        const letIn = renderAt320(<EventDetail post={{ ...online, myRsvp: 'going', myLetIn: true, eventLink: 'https://meet.example/abc' }} identity={identity} onOpenChat={() => {}} />);
        expect(screen.getByTestId('event-join').getAttribute('href')).toBe('https://meet.example/abc');
        letIn.unmount();
        renderAt320(<EventDetail post={{ ...online, myRsvp: 'going', myLetIn: true }} identity={identity} onOpenChat={() => {}} />);
        expect(screen.getByTestId('event-join-hint')).toHaveTextContent('The host has not added a link to join yet.');
    });
    it('where the host does not let people in, everything reads as before', () => {
        const { eventHostLetsIn: _f, ...plain } = ev;
        renderAt320(<EventDetail post={{ ...plain, myRsvp: null }} identity={identity} onOpenChat={() => {}} />);
        expect(screen.getByText(/shows here once you tap Going/)).toBeInTheDocument();
        expect(screen.queryByTestId('event-let-in-line')).not.toBeInTheDocument();
    });
});

describe("the host's panel (320px, 130%)", () => {
    beforeEach(() => { vi.mocked(api.letInToEvent).mockReset(); });
    afterEach(() => { document.documentElement.style.fontSize = ''; vi.restoreAllMocks(); });
    const rsvps = [
        { memberPubkey: 'a', memberCallsign: 'Sam', status: 'going', updatedAt: '', letInAt: null },
        { memberPubkey: 'b', memberCallsign: 'Tia', status: 'going', updatedAt: '', letInAt: null },
        { memberPubkey: 'c', memberCallsign: 'Fred', status: 'going', updatedAt: '', letInAt: '2026-10-15T01:00:00.000Z' },
        { memberPubkey: 'd', memberCallsign: 'Uma', status: 'interested', updatedAt: '', letInAt: null },
    ];
    it('the waiting count; Let in / Let in ✓ beside each Going row; Interested as before; taps send the right thing', async () => {
        const hosted = { ...ev, myRsvp: null, eventPrivateNote: NOTE, eventRsvps: rsvps };
        vi.mocked(api.letInToEvent).mockResolvedValue({ success: true, changed: 1, post: { ...hosted, eventRsvps: rsvps.map(r => r.memberPubkey === 'a' ? { ...r, letInAt: 'now' } : r) } });
        renderAt320(<EventDetail post={hosted} identity={identity} />);
        const panel = screen.getByTestId('event-host-panel');
        expect(within(panel).getByTestId('event-waiting-count')).toHaveTextContent('2 waiting to be let in');
        expect(screen.queryByTestId('event-let-in-line')).not.toBeInTheDocument();
        const buttons = within(panel).getAllByTestId('event-let-in');
        expect(buttons.map(b => b.textContent)).toEqual(['Let in', 'Let in', 'Let in ✓']);
        expect(buttons.map(b => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
        for (const b of buttons) expect(b.className).toMatch(/min-h-\[44px\]/);
        expect(within(panel).getByText('Interested')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Let Sam in' }));
        await waitFor(() => expect(api.letInToEvent).toHaveBeenCalledWith('ev-1', { memberPublicKey: 'a' }, true));
        await waitFor(() => expect(within(panel).getByTestId('event-waiting-count')).toHaveTextContent('1 waiting to be let in'));
        fireEvent.click(screen.getByRole('button', { name: 'Let in. Take it back from Fred' }));
        await waitFor(() => expect(api.letInToEvent).toHaveBeenLastCalledWith('ev-1', { memberPublicKey: 'c' }, false));
    });
    it('Let everyone in asks first, naming the count', async () => {
        const hosted = { ...ev, myRsvp: null, eventRsvps: rsvps };
        vi.mocked(api.letInToEvent).mockResolvedValue({ success: true, changed: 2, post: hosted });
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        renderAt320(<EventDetail post={hosted} identity={identity} />);
        fireEvent.click(screen.getByTestId('event-let-everyone-in'));
        expect(confirm).toHaveBeenLastCalledWith('Let all 2 in? People who tap Going later still wait.');
        expect(api.letInToEvent).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('event-let-everyone-in'));
        await waitFor(() => expect(api.letInToEvent).toHaveBeenCalledWith('ev-1', { everyone: true }, true));
    });
});

describe('the chat, refused while waiting', () => {
    it("shows the waiting words for the node's waiting_for_host, never its 'only the host and people going'", async () => {
        vi.mocked(api.getEventChat).mockRejectedValue(Object.assign(new Error("The host hasn't let you in yet: the chat opens when they do."), { status: 403, code: 'waiting_for_host' }));
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        expect(await screen.findByTestId('event-chat-error')).toHaveTextContent('Chat opens when the host lets you in.');
        expect(document.body.textContent).not.toContain('Only the host and people going');
    });
});

// Marty, 15 Oct (board card privacy-global-calls): when the host opens the chat to everyone going, the chat says so.
describe("the chat's line when the host opens it to everyone going", () => {
    it('is a small centred line in the reader\'s words, with no author and nothing for the host to remove', async () => {
        const base64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
        vi.mocked(api.getEventChat).mockResolvedValue({
            conversation: { id: 'ev-1', type: 'event_thread', participants: ['host-pk', 'me-pk'] } as any,
            messages: [
                { id: 'm1', conversationId: 'ev-1', authorPubkey: 'sam-pk', authorCallsign: 'Sam', ciphertext: base64('Gate is blue'), nonce: 'plaintext-v1', type: 'text', timestamp: new Date().toISOString() },
                { id: 'm2', conversationId: 'ev-1', authorPubkey: 'SYSTEM', authorCallsign: 'System', ciphertext: 'The host opened this chat to everyone going.', nonce: '00000', type: 'system', systemType: 'event_opened_to_going', timestamp: new Date().toISOString() },
            ],
            readOnly: false, readOnlyReason: null, canPost: true, isHost: true, title: 'Garden dinner', eventEndAt: null, eventState: 'scheduled',
            privateNote: null, notice: "Visible to the host, everyone going, and this node's operator.",
        });
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        const line = await screen.findByTestId('event-chat-system-line');
        expect(line).toHaveTextContent('The host opened this chat to everyone going.');
        expect(within(line).queryByRole('button')).toBeNull();
        expect(screen.getAllByRole('button', { name: /Remove message from/ }).map(b => b.getAttribute('aria-label'))).toEqual(['Remove message from Sam']);
        expect(document.body.textContent).not.toContain('SYSTEM');
    });
});

describe('the form', () => {
    it('says, on an edit from ticked to unticked, that everyone going will see the note and the chat so far', () => {
        expect(hostLetsInOffWarning(true, false)).toBe('Everyone going will see the note and the chat so far.');
        expect(hostLetsInOffWarning(true, true)).toBeNull();
        expect(hostLetsInOffWarning(false, false)).toBeNull();
    });

    it('ticks by default where anyone can join in a minute, and says who reads the note', () => {
        expect(hostLetsInDefault({ openMembership: true })).toBe(true);
        expect(hostLetsInDefault(undefined)).toBe(false);
        expect(privateNoteHelper(true, true)).toBe("Anyone can join this community in a minute. Only the people you let in will see this note and the event chat. You let people in from Who's going.");
        expect(privateNoteHelper(false, false)).toBe('Everyone who taps Going sees this.');
        expect(privateNoteHelper(true, false)).toBe('Only the people you let in see this.');
        expect(privateNoteHelper(false, true)).toBe('Everyone who taps Going sees this. Anyone can join this community in a minute.');
    });
    it('an edit sends the tickbox only when it changed', () => {
        const before = eventEditForm(ev);
        expect(before.hostLetsIn).toBe(true);
        expect(eventEditPayload(before, { ...before }).eventHostLetsIn).toBeUndefined();
        expect(eventEditPayload(before, { ...before, hostLetsIn: false }).eventHostLetsIn).toBe(false);
    });
    it('states and counts', () => {
        expect(eventLetInState({ eventHostLetsIn: true, myRsvp: 'going', myLetIn: false }, true)).toBe('open');
        expect(eventWaitingCount(undefined)).toBe(0);
    });
});
