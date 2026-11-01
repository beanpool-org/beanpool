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
 *   7. MessageRequestsPane and chat/[id].tsx: every accessibilityRole is one Android accepts, so neither screen throws
 *      when it mounts there (PR #2540 review 4396980215)
 *   8. MessageRequestsPane: Block drops the card only when the sender is on the list after it; a block that didn't happen
 *      says so and the card stays (PR #2540 review 4399651364)
 *   9. MessageRequestsPane: the closed-photo line has a gap under it when a caption follows, read at render, not frozen in
 *      the sheet while the preview loads (PR #2540 review 4399651606)
 *  10. MessageRequestsPane: Report always blocks: a line its sender deleted, or a refusal by the node, costs the report and
 *      never the block; Report is dim whenever it is off (the deciding review of #2705)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import React, { createElement } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const alerts = vi.hoisted(() => ({ said: [] as { title: string; body?: string; buttons?: any[] }[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', region: 'region' };
    const el = (tag: string) => function MockHost(props: any) {
        const { children, onPress, accessibilityLabel, accessibilityRole, role, testID } = props;
        const attrs: Record<string, any> = {};
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (role) attrs.role = role;
        if (onPress && !props.disabled) attrs.onClick = onPress;
        if (props.style) attrs['data-style'] = JSON.stringify(props.style);
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
    const { useMemo } = await import('react');
    const ctx = { theme: 'light', colors: lightColors };
    return {
        useTheme: () => ctx,
        // Built once per theme, as the real hook memoizes it (app/ThemeContext.tsx useStyles): a sheet that reads anything
        // else keeps what it read at the first render (PR #2540 review 4399651606).
        useStyles: (make: (c: typeof ctx) => any) => useMemo(() => make(ctx), []),
    };
});

vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: ({ callsign }: any) => createElement('span', { 'data-testid': 'avatar' }, callsign),
}));

const blockMocks = vi.hoisted(() => ({
    blockUser: vi.fn(async () => true),
    isUserBlocked: vi.fn(async () => false),
} as Record<string, any>));

vi.mock('../blocklist', () => ({
    blockUser: (...args: any[]) => blockMocks.blockUser(...args),
    isUserBlocked: (...args: any[]) => blockMocks.isUserBlocked(...args),
}));

const dbMocks = vi.hoisted(() => ({
    decideMessageRequest: vi.fn(),
    ignoreAllMessageRequests: vi.fn(),
    getMessages: vi.fn(async () => [] as any[]),
    reportDmLine: vi.fn(async () => ({ success: true })),
    syncSingleConversation: vi.fn(async () => {}),
    deleteLocalMessage: vi.fn(async () => {}),
} as Record<string, any>));

vi.mock('../db', () => ({
    decideMessageRequest: (...args: any[]) => dbMocks.decideMessageRequest(...args),
    ignoreAllMessageRequests: (...args: any[]) => dbMocks.ignoreAllMessageRequests(...args),
    getMessages: (...args: any[]) => dbMocks.getMessages(...args),
    reportDmLine: (...args: any[]) => dbMocks.reportDmLine(...args),
    syncSingleConversation: (...args: any[]) => dbMocks.syncSingleConversation(...args),
    deleteLocalMessage: (...args: any[]) => dbMocks.deleteLocalMessage(...args),
}));

vi.mock('../../components/ReportMessageSheet', () => ({
    ReportMessageSheet: ({ onSubmit }: any) => createElement('button', {
        'data-testid': 'report-sheet-submit', onClick: () => { onSubmit('Harassment').catch(() => {}); },
    }, 'Submit'),
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
                onBack: () => {},
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
                onBack: () => {},
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
                onBack: () => {},
                onAccepted: () => {},
                onChanged: () => {},
            })
        );

        const openBtn = screen.getByTestId('request-card-open');
        expect(await screen.findByText(/Photo: shown when you accept/)).toBeTruthy();
        expect(openBtn.getAttribute('aria-label')).toBe('Bob. Photo: shown when you accept. Check this out. Open the chat to read it.');
    });

    // Review 4399651606: the gap under the closed-photo line was read from `preview` inside the sheet, which is built once,
    // while the preview is still loading, so a photo's caption always touched the line above it.
    const flatStyle = (el: Element) => Object.assign({}, ...[JSON.parse(el.getAttribute('data-style') || '{}')].flat(Infinity).filter(Boolean));
    it('puts a gap under the closed-photo line when a caption follows it, and none when it does not', async () => {
        dbMocks.getMessages.mockResolvedValueOnce([
            { id: 'm2', type: 'image', text: 'Check this out', authorPubkey: 'bob-pubkey', timestamp: '2026-10-27T00:00:00Z' } as any,
        ]);
        const props = { count: 1, identity: { publicKey: 'me-pubkey' }, onOpen: () => {}, onBack: () => {}, onAccepted: () => {}, onChanged: () => {} };
        render(createElement(MessageRequestsPane, { ...props, entries: [entry] }));
        const withCaption = await screen.findByText(/Photo: shown when you accept/);
        expect(screen.getByText('Check this out')).toBeTruthy();
        expect(flatStyle(withCaption).marginBottom).toBe(4);
        cleanup();

        dbMocks.getMessages.mockResolvedValueOnce([
            { id: 'm3', type: 'image', text: '', authorPubkey: 'bob-pubkey', timestamp: '2026-10-27T00:00:00Z' } as any,
        ]);
        render(createElement(MessageRequestsPane, { ...props, entries: [entry] }));
        const alone = await screen.findByText(/Photo: shown when you accept/);
        expect(flatStyle(alone).marginBottom ?? 0).toBe(0);
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
            onBack: () => {},
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

        fireEvent.click(screen.getByTestId('request-decline'));
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
        expect(alerts.said[0].title).toBe('Connect to your community to accept or decline.');
        cleanup();

        dbMocks.decideMessageRequest.mockRejectedValueOnce(new Error('Network request failed'));
        renderCard();
        fireEvent.click(screen.getByTestId('request-decline'));
        await waitFor(() => expect(alerts.said.length).toBe(2));
        expect(alerts.said[1].title).toBe('Connect to your community to accept or decline.');
    });

    // Review 4399651364: blockUser answers false rather than throwing (no account on the phone, the list not written, the
    // sender already on it), and a card that ignores the answer shows a block that didn't happen as one that did.
    const reportFrom = async (onChanged: () => void) => {
        dbMocks.getMessages.mockResolvedValueOnce([{ id: 'line-1', senderId: 'bob-pubkey', text: 'Buy my crypto', rawTimestamp: '2026-10-27T00:00:00Z', metadata: {} }]);
        renderCard({ onChanged });
        await screen.findByText('Buy my crypto');
        fireEvent.click(screen.getByTestId('request-report'));
    };

    it('a request has three buttons: Accept, Decline, Report', () => {
        renderCard();
        for (const name of ['Accept', 'Decline', 'Report']) expect(screen.getByRole('button', { name })).toBeTruthy();
        expect(screen.queryByTestId('request-block')).toBeNull();
    });

    it('Report: reports the line it shows with its words, blocks its sender, files no second report, and the card drops on OK', async () => {
        const onChanged = vi.fn();
        await reportFrom(onChanged);
        fireEvent.click(await screen.findByTestId('report-sheet-submit'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(dbMocks.reportDmLine).toHaveBeenCalledWith('conv-req-1', 'line-1', 'Buy my crypto', 'Harassment');
        expect(blockMocks.blockUser).toHaveBeenCalledWith('bob-pubkey');
        expect(alerts.said[0].title).toBe('Reported');
        expect(onChanged).not.toHaveBeenCalled();
        alerts.said[0].buttons?.[0].onPress();
        await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    });

    it('a report the node did not take blocks nobody, and the card stays', async () => {
        dbMocks.reportDmLine.mockRejectedValueOnce(new Error('Network request failed'));
        const onChanged = vi.fn();
        await reportFrom(onChanged);
        fireEvent.click(await screen.findByTestId('report-sheet-submit'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(blockMocks.blockUser).not.toHaveBeenCalled();
        expect(onChanged).not.toHaveBeenCalled();
    });

    it('a report over the hourly limit still blocks, and says the report did not go: the limit never costs a member their block', async () => {
        dbMocks.reportDmLine.mockRejectedValueOnce(Object.assign(new Error('You have sent a lot of reports recently. Please try again in an hour.'), { status: 429 }));
        const onChanged = vi.fn();
        await reportFrom(onChanged);
        fireEvent.click(await screen.findByTestId('report-sheet-submit'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(blockMocks.blockUser).toHaveBeenCalledWith('bob-pubkey');
        expect(alerts.said[0].title).toBe('You have sent a lot of reports recently, so this one did not go. They are blocked.');
        alerts.said[0].buttons?.[0].onPress();
        await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    });

    it("a block that didn't happen: says the report went and the block did not, and the card stays", async () => {
        blockMocks.blockUser.mockResolvedValueOnce(false);
        blockMocks.isUserBlocked.mockResolvedValueOnce(false);
        const onChanged = vi.fn();
        await reportFrom(onChanged);
        fireEvent.click(await screen.findByTestId('report-sheet-submit'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(blockMocks.isUserBlocked).toHaveBeenCalledWith('bob-pubkey');
        expect(alerts.said[0].title).toBe('Reported, but not blocked. Please try again.');
        expect(onChanged).not.toHaveBeenCalled();
    });

    // The deciding review of #2705: a delete leaves the request waiting and the newest row a tombstone. Handed over, the node
    // answers 400 disclosure_form, which threw before the block; on main, Block worked here.
    const DELETED = { id: 'line-1', senderId: 'bob-pubkey', type: 'removed', text: 'This message was deleted', metadata: { removed: true } };
    const opacityOf = (el: Element) => Object.assign({}, ...[JSON.parse(el.getAttribute('data-style') || '{}')].flat(Infinity).filter(Boolean)).opacity;

    it('a request whose line its sender deleted: Report blocks them, files no report, says so, and the card drops', async () => {
        dbMocks.getMessages.mockResolvedValueOnce([DELETED]);
        const onChanged = vi.fn();
        renderCard({ onChanged });
        await screen.findByText('This message was deleted');
        fireEvent.click(screen.getByTestId('request-report'));
        fireEvent.click(await screen.findByTestId('report-sheet-submit'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(dbMocks.reportDmLine).not.toHaveBeenCalled();
        expect(blockMocks.blockUser).toHaveBeenCalledWith('bob-pubkey');
        expect(alerts.said[0].title).toBe('That message was deleted, so no report went. They are blocked.');
        alerts.said[0].buttons?.[0].onPress();
        await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    });

    it('hands over the request\'s line, not the newest row: a failed line of mine after it is not theirs to report', async () => {
        dbMocks.getMessages.mockResolvedValueOnce([
            { id: 'line-1', senderId: 'bob-pubkey', text: 'Buy my crypto', rawTimestamp: '2026-10-27T00:00:00Z', metadata: {} },
            { id: 'mine', senderId: 'me-pubkey', text: 'No thanks', rawTimestamp: '2026-10-27T00:01:00Z', sendState: 'failed', metadata: {} },
        ]);
        renderCard();
        await screen.findByText('No thanks');
        fireEvent.click(screen.getByTestId('request-report'));
        fireEvent.click(await screen.findByTestId('report-sheet-submit'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(dbMocks.reportDmLine).toHaveBeenCalledWith('conv-req-1', 'line-1', 'Buy my crypto', 'Harassment');
    });

    it('a report the node refuses still blocks, and says the report did not go', async () => {
        dbMocks.reportDmLine.mockRejectedValueOnce(refusal('That message is not there.', { status: 404, code: 'not_found', nodeAnswered: true }));
        const onChanged = vi.fn();
        await reportFrom(onChanged);
        fireEvent.click(await screen.findByTestId('report-sheet-submit'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(blockMocks.blockUser).toHaveBeenCalledWith('bob-pubkey');
        expect(alerts.said[0].title).toBe('Your community did not take the report. They are blocked.');
        alerts.said[0].buttons?.[0].onPress();
        await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    });

    it('over the limit with a block that did not happen: never says it was reported', async () => {
        dbMocks.reportDmLine.mockRejectedValueOnce(Object.assign(new Error('Too many'), { status: 429 }));
        blockMocks.blockUser.mockResolvedValueOnce(false);
        blockMocks.isUserBlocked.mockResolvedValueOnce(false);
        const onChanged = vi.fn();
        await reportFrom(onChanged);
        fireEvent.click(await screen.findByTestId('report-sheet-submit'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(alerts.said[0].title).toBe('That did not go through. Please try again.');
        expect(onChanged).not.toHaveBeenCalled();
    });

    it('Report is dim and off while the preview loads, and live once it has', async () => {
        let finish: (lines: any[]) => void = () => {};
        dbMocks.getMessages.mockReturnValueOnce(new Promise((r) => { finish = r; }));
        renderCard();
        const report = screen.getByTestId('request-report');
        expect(opacityOf(report)).toBe(0.7);
        fireEvent.click(report);
        expect(screen.queryByTestId('report-sheet-submit')).toBeNull();
        finish([{ id: 'line-1', senderId: 'bob-pubkey', text: 'Buy my crypto', metadata: {} }]);
        await screen.findByText('Buy my crypto');
        expect(opacityOf(screen.getByTestId('request-report'))).toBeUndefined();
    });

    it('no line here and no word from the node: Report stays dim and off, for it can\'t yet tell deleted from not here yet', async () => {
        dbMocks.syncSingleConversation.mockResolvedValueOnce(false);
        dbMocks.getMessages.mockResolvedValueOnce([]);
        renderCard();
        await screen.findByText('Open the chat to read it.');
        const report = screen.getByTestId('request-report');
        expect(opacityOf(report)).toBe(0.7);
        fireEvent.click(report);
        expect(screen.queryByTestId('report-sheet-submit')).toBeNull();
    });

    it('no line here and the node has answered: Report is live, and blocks', async () => {
        dbMocks.syncSingleConversation.mockResolvedValueOnce(true);
        dbMocks.getMessages.mockResolvedValueOnce([]);
        renderCard();
        await screen.findByText('Open the chat to read it.');
        expect(opacityOf(screen.getByTestId('request-report'))).toBeUndefined();
        fireEvent.click(screen.getByTestId('request-report'));
        fireEvent.click(await screen.findByTestId('report-sheet-submit'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(blockMocks.blockUser).toHaveBeenCalledWith('bob-pubkey');
    });

    it('a sender already on the list: reported, and the card drops', async () => {
        blockMocks.blockUser.mockResolvedValueOnce(false);
        blockMocks.isUserBlocked.mockResolvedValueOnce(true);
        await reportFrom(vi.fn());
        fireEvent.click(await screen.findByTestId('report-sheet-submit'));
        await waitFor(() => expect(alerts.said.length).toBe(1));
        expect(alerts.said[0].title).toBe('Reported');
    });

    it('offers Decline all when count >= 6 and calls ignoreAllMessageRequests on confirm', async () => {
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
                onBack: () => {},
                onAccepted: () => {},
                onChanged,
            })
        );

        const ignoreAllBtn = screen.getByRole('button', { name: 'Decline all' });
        expect(ignoreAllBtn).toBeTruthy();

        fireEvent.click(ignoreAllBtn);
        expect(alerts.said.length).toBe(1);
        expect(alerts.said[0].title).toContain('Decline all 6 requests?');

        // Confirm ignore all
        const confirmBtn = alerts.said[0].buttons?.find(b => b.text === 'Decline all');
        expect(confirmBtn).toBeDefined();
        await confirmBtn.onPress();

        expect(dbMocks.ignoreAllMessageRequests).toHaveBeenCalledTimes(1);
        expect(onChanged).toHaveBeenCalled();
    });
});

// Android's BaseViewManager hands accessibilityRole to AccessibilityRole.fromValue, which throws
// "Invalid accessibility role value" for anything outside this enum (ReactAccessibilityDelegate.kt, RN 0.83.10).
// The TS type ends in `| string` and react-native-web maps anything, so only a device would catch it.
// Landmark roles like region and status go on `role=`, which Android reads through its own Role enum.
describe('accessibility roles Android accepts', () => {
    const ANDROID_ACCESSIBILITY_ROLES = new Set([
        'none', 'button', 'dropdownlist', 'togglebutton', 'link', 'search', 'image', 'imagebutton', 'keyboardkey',
        'text', 'adjustable', 'summary', 'header', 'alert', 'checkbox', 'combobox', 'menu', 'menubar', 'menuitem',
        'progressbar', 'radio', 'radiogroup', 'scrollbar', 'spinbutton', 'switch', 'tab', 'tablist', 'timer', 'list',
        'grid', 'pager', 'scrollview', 'horizontalscrollview', 'viewgroup', 'webview', 'drawerlayout',
        'slidingdrawer', 'iconmenu', 'toolbar',
    ]);
    const files = ['components/MessageRequestsPane.tsx', 'app/chat/[id].tsx'];

    it.each(files)('%s gives accessibilityRole only values Android accepts', (rel) => {
        const src = fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');
        const used = [...src.matchAll(/accessibilityRole=\{?["']([^"']+)["']/g)].map(m => m[1]);
        expect(used.length).toBeGreaterThan(0);
        expect(used.filter(r => !ANDROID_ACCESSIBILITY_ROLES.has(r.toLowerCase()))).toEqual([]);
    });

    it('the Requests pane keeps its landmark, on role=', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../components/MessageRequestsPane.tsx'), 'utf-8');
        expect(src).toMatch(/role="region"\s*\n\s*accessibilityLabel=\{t\('Message requests'\)\}/);
    });
});
