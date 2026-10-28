// @vitest-environment jsdom
/**
 * Message requests on the phone: MessageRequestsPane and chat/[id].tsx waiting & cancel behaviour.
 *
 * Checks:
 *   1. MessageRequestsPane: renders requests with Accept and Ignore; calls decideMessageRequest
 *   2. MessageRequestsPane: offers Ignore all when count >= 6; calls ignoreAllMessageRequests
 *   3. chat/[id].tsx: in mine-waiting mode, replaces composer with waiting line and Cancel request button
 *   4. chat/[id].tsx: tapping Cancel request calls decideMessageRequest(id, 'cancel')
 *   5. chat/[id].tsx: failed message bubble with __sendError shows server's words in Alert
 *   6. MessageRequestsPane: a request the node no longer has drops its card; any other refusal says the web's words
 *      (PR #2540 review 4395541944)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { createElement } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const alerts = vi.hoisted(() => ({ said: [] as { title: string; body?: string; buttons?: any[] }[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', region: 'region' };
    const el = (tag: string) => function MockHost(props: any) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID } = props;
        const attrs: Record<string, any> = {};
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (onPress && !props.disabled) attrs.onClick = onPress;
        return createElement(tag, attrs, children);
    };
    return {
        View: el('div'),
        Text: el('span'),
        Pressable: el('button'),
        TouchableOpacity: el('button'),
        ScrollView: el('div'),
        TextInput: el('input'),
        Animated: {
            ScrollView: el('div'),
            FlatList: el('div'),
            View: el('div'),
            Value: class { interpolate() { return 0; } },
        },
        StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
        Alert: {
            alert: (title: string, body?: string, buttons?: any[]) => {
                alerts.said.push({ title, body, buttons });
            },
        },
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        Keyboard: { dismiss: vi.fn() },
    };
});

vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return {
        useTheme: () => ctx,
        useStyles: (make: (c: typeof ctx) => any) => make(ctx),
    };
});

vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: ({ callsign }: any) => createElement('span', { 'data-testid': 'avatar' }, callsign),
}));

vi.mock('../blocklist', () => ({
    blockUser: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
    decideMessageRequest: vi.fn(),
    ignoreAllMessageRequests: vi.fn(),
    getMessages: vi.fn(async () => [] as any[]),
    syncSingleConversation: vi.fn(async () => {}),
    deleteLocalMessage: vi.fn(async () => {}),
} as Record<string, any>));

vi.mock('../db', () => ({
    decideMessageRequest: (...args: any[]) => dbMocks.decideMessageRequest(...args),
    ignoreAllMessageRequests: (...args: any[]) => dbMocks.ignoreAllMessageRequests(...args),
    getMessages: (...args: any[]) => dbMocks.getMessages(...args),
    syncSingleConversation: (...args: any[]) => dbMocks.syncSingleConversation(...args),
    deleteLocalMessage: (...args: any[]) => dbMocks.deleteLocalMessage(...args),
}));

import { MessageRequestsPane } from '../../components/MessageRequestsPane';

describe('MessageRequestsPane on phone', () => {
    beforeEach(() => {
        alerts.said = [];
        vi.clearAllMocks();
    });

    afterEach(() => {
        cleanup();
    });

    const entry = {
        id: 'conv-req-1',
        name: 'Bob',
        peerCallsign: 'Bob',
        participants: ['me-pubkey', 'bob-pubkey'],
        request: { state: 'pending', from: 'bob-pubkey', at: '2026-10-27T00:00:00Z' },
    };

    it('renders empty message when count is 0', () => {
        render(
            createElement(MessageRequestsPane, {
                entries: [],
                count: 0,
                identity: { publicKey: 'me-pubkey' },
                onOpen: () => {},
                onAccepted: () => {},
                onChanged: () => {},
            })
        );
        expect(screen.getByText(/No requests/)).toBeTruthy();
    });

    it('renders requests with Accept and Ignore buttons and triggers decideMessageRequest', async () => {
        dbMocks.getMessages.mockResolvedValueOnce([
            { id: 'm1', text: 'Hello from Bob', authorPubkey: 'bob-pubkey', timestamp: '2026-10-27T00:00:00Z' } as any,
        ]);
        dbMocks.decideMessageRequest.mockResolvedValueOnce({ success: true });

        const onAccepted = vi.fn();
        render(
            createElement(MessageRequestsPane, {
                entries: [entry],
                count: 1,
                identity: { publicKey: 'me-pubkey' },
                onOpen: () => {},
                onAccepted,
                onChanged: () => {},
            })
        );

        expect(await screen.findByText('1 person wants to message you')).toBeTruthy();
        const openBtn = screen.getByTestId('request-card-open');
        // The name is drawn twice on the card (the name line and the avatar), so ask for all of them.
        expect(screen.getAllByText('Bob').length).toBeGreaterThan(0);
        expect(await screen.findByText('Hello from Bob')).toBeTruthy();
        expect(openBtn.getAttribute('aria-label')).toBe('Bob. Hello from Bob. Open the chat to read it.');

        const acceptBtn = screen.getByTestId('request-accept');
        expect(acceptBtn.textContent).toContain('Accept');
        fireEvent.click(acceptBtn);

        await waitFor(() => {
            expect(dbMocks.decideMessageRequest).toHaveBeenCalledWith('conv-req-1', 'accept');
        });
        expect(onAccepted).toHaveBeenCalledWith(entry);
    });

    it('sets accessibilityLabel with who, photo preview line, and open state', async () => {
        dbMocks.getMessages.mockResolvedValueOnce([
            { id: 'm2', type: 'image', text: 'Check this out', authorPubkey: 'bob-pubkey', timestamp: '2026-10-27T00:00:00Z' } as any,
        ]);

        render(
            createElement(MessageRequestsPane, {
                entries: [entry],
                count: 1,
                identity: { publicKey: 'me-pubkey' },
                onOpen: () => {},
                onAccepted: () => {},
                onChanged: () => {},
            })
        );

        const openBtn = screen.getByTestId('request-card-open');
        expect(await screen.findByText(/Photo: shown when you accept/)).toBeTruthy();
        expect(openBtn.getAttribute('aria-label')).toBe('Bob. Photo: shown when you accept. Check this out. Open the chat to read it.');
    });

    // Review 4395541944: a refused Accept or Ignore said only "That did not go through. Please try again." and kept the card,
    // so a request its opener cancelled stayed on the list and every retry said the same. The web drops the card on
    // request_not_found and otherwise says decisionFailureWords. The phone's errors carry `nodeAnswered` (utils/db
    // _signedRequest), not the web's `unsaid`.
    const refusal = (message: string, extra: Record<string, unknown>) => Object.assign(new Error(message), extra);
    const renderCard = (over: { onAccepted?: () => void; onChanged?: () => void } = {}) => render(
        createElement(MessageRequestsPane, {
            entries: [entry],
            count: 1,
            identity: { publicKey: 'me-pubkey' },
            onOpen: () => {},
            onAccepted: over.onAccepted ?? (() => {}),
            onChanged: over.onChanged ?? (() => {}),
        })
    );

    it('a request its opener cancelled: Accept drops the card with the next list, and says nothing', async () => {
        dbMocks.decideMessageRequest.mockRejectedValueOnce(refusal('There is no message request for you in this chat.', { status: 404, code: 'request_not_found', nodeAnswered: true }));
        const onAccepted = vi.fn();
        const onChanged = vi.fn();
        renderCard({ onAccepted, onChanged });

        fireEvent.click(screen.getByTestId('request-accept'));
        await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
        expect(onAccepted).not.toHaveBeenCalled();
        expect(alerts.said).toEqual([]);
    });

    it('a request its opener cancelled: Ignore drops the card too', async () => {
        dbMocks.decideMessageRequest.mockRejectedValueOnce(refusal('There is no message request for you in this chat.', { status: 404, code: 'request_not_found', nodeAnswered: true }));
        const onChanged = vi.fn();
        renderCard({ onChanged });

        fireEvent.click(screen.getByTestId('request-ignore'));
        await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
        expect(alerts.said).toEqual([]);
    });

    it('the node refusing in its own words: those words, and the card stays', async () => {
        dbMocks.decideMessageRequest.mockRejectedValueOnce(refusal('This community is read-only for now.', { status: 503, code: 'standby', nodeAnswered: true }));
        const onChanged = vi.fn();
        renderCard({ onChanged });

        fireEvent.click(screen.getByTestId('request-accept'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(alerts.said[0].title).toBe('This community is read-only for now.');
        expect(onChanged).not.toHaveBeenCalled();
    });

    it("a page that was not the node's (a proxy's 502), or no answer at all: the community out of reach, never the page's words", async () => {
        dbMocks.decideMessageRequest.mockRejectedValueOnce(refusal('Server returned 502', { status: 502, nodeAnswered: false }));
        renderCard();
        fireEvent.click(screen.getByTestId('request-accept'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(alerts.said[0].title).toBe('Connect to your community to accept or ignore.');
        cleanup();

        dbMocks.decideMessageRequest.mockRejectedValueOnce(new Error('Network request failed'));
        renderCard();
        fireEvent.click(screen.getByTestId('request-ignore'));
        await waitFor(() => expect(alerts.said.length).toBe(2));
        expect(alerts.said[1].title).toBe('Connect to your community to accept or ignore.');
    });

    it('offers Ignore all when count >= 6 and calls ignoreAllMessageRequests on confirm', async () => {
        const entries = Array.from({ length: 6 }, (_, i) => ({
            id: `conv-${i}`,
            name: `User ${i}`,
            participants: ['me-pubkey', `user-${i}`],
            request: { state: 'pending', from: `user-${i}`, at: '2026-10-27T00:00:00Z' },
        }));

        dbMocks.ignoreAllMessageRequests.mockResolvedValueOnce({ success: true, ignored: 6 });
        const onChanged = vi.fn();

        render(
            createElement(MessageRequestsPane, {
                entries,
                count: 6,
                identity: { publicKey: 'me-pubkey' },
                onOpen: () => {},
                onAccepted: () => {},
                onChanged,
            })
        );

        const ignoreAllBtn = screen.getByRole('button', { name: 'Ignore all' });
        expect(ignoreAllBtn).toBeTruthy();

        fireEvent.click(ignoreAllBtn);
        expect(alerts.said.length).toBe(1);
        expect(alerts.said[0].title).toContain('Ignore all 6 requests?');

        // Confirm ignore all
        const confirmBtn = alerts.said[0].buttons?.find(b => b.text === 'Ignore all');
        expect(confirmBtn).toBeDefined();
        await confirmBtn.onPress();

        expect(dbMocks.ignoreAllMessageRequests).toHaveBeenCalledTimes(1);
        expect(onChanged).toHaveBeenCalled();
    });
});
