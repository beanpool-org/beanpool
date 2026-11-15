/**
 * Account Protection's Refresh on the phone (recovery without a typed name, slice S4), in a build without a key vault: the
 * community's status says which sign-ins' copies its server finds from the sign-in alone (`findableSso`), core's
 * signInsToRefresh turns that into the sign-ins to refresh, and the panel draws one Refresh for each, which runs the
 * ordinary Connect (`onProtectSso`). The server's half, with every kind of copy through the real route, is
 * apps/server/src/test-recovery-findable.ts; the Connect's own answers (findable at once, a refusal said in words) are in
 * sso-sheet-connect.no-vault.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';

// Host components as plain tags, so the tree can be walked without a device (vitest.config.ts).
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    StyleSheet: { create: <T,>(s: T) => s },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    TouchableOpacity: 'TouchableOpacity',
}));

// The provider buttons draw SVG logos; only their titles matter here.
vi.mock('../../components/SsoButton', () => {
    const button = (name: string) => (props: { title: string; onPress: () => void }) =>
        React.createElement('SsoButton', { name, onPress: props.onPress }, props.title);
    return { AppleButton: button('apple'), GoogleButton: button('google'), FacebookButton: button('facebook') };
});

// At the vault the row's "Who can open it" holds its own state; only that it draws matters here.
vi.mock('../../components/WhoCanOpen', () => ({
    WhoCanOpen: (props: { children: unknown }) => React.createElement('WhoCanOpen', null, props.children as any),
}));

import { SIGN_IN_REFRESH_WORDS, signInsToRefresh, t } from '@beanpool/core';
import { KeeperProtectionPanel } from '../../components/KeeperProtectionPanel';
import { protectionFrom } from '../protection-state';
import type { KeeperEnrolmentResult } from '../keeper-enrolment';

type Host = { type: string; props: Record<string, any>; children: Node[] };
type Node = Host | string;

/** Expands function components (the panel has no hooks without the tick) down to host elements. */
function render(node: unknown): Node[] {
    if (node === null || node === undefined || typeof node === 'boolean') return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(render);
    const el = node as React.ReactElement<Record<string, any>>;
    if (el.type === React.Fragment) return render(el.props.children);
    if (typeof el.type === 'function') return render((el.type as (p: unknown) => unknown)(el.props));
    return [{ type: el.type as string, props: el.props, children: render(el.props.children) }];
}
function all(nodes: Node[], pick: (n: Host) => boolean): Host[] {
    const out: Host[] = [];
    const walk = (n: Node) => {
        if (typeof n === 'string') return;
        if (pick(n)) out.push(n);
        n.children.forEach(walk);
    };
    nodes.forEach(walk);
    return out;
}
const textIn = (n: Node): string => (typeof n === 'string' ? n : n.children.map(textIn).join(''));
const allText = (nodes: Node[]): string => nodes.map(textIn).join('\n');

/** The community's status as the phone keeps it (settings.tsx fetchCommunityProtectionStatus): its two lists. */
function fromStatus(status: { enrolledSso: string[]; findableSso?: string[] }): KeeperEnrolmentResult {
    return {
        enrolled: status.enrolledSso.map(() => 'sso' as const), generation: 1, skipped: [], available: status.enrolledSso.length,
        enrolledSso: status.enrolledSso, ...(status.findableSso ? { findableSso: status.findableSso } : {}), threshold: 1, isSingleBlob: true,
    };
}

/** Account Protection's panel as Settings draws it, from that result. */
function panel(result: KeeperEnrolmentResult, opts: { hasWords?: boolean; copiesAt?: 'vault' | 'community' } = {}) {
    const onProtectSso = vi.fn();
    const nodes = render(React.createElement(KeeperProtectionPanel, {
        protection: protectionFrom(result), hasWords: opts.hasWords ?? true, onProtectSso, onDisconnectSso: vi.fn(),
        copiesAt: opts.copiesAt ?? 'community', refreshSso: signInsToRefresh(result),
    }));
    const refreshButtons = all(nodes, (n) => n.type === 'TouchableOpacity' && typeof n.props.testID === 'string' && n.props.testID.startsWith('refresh-'));
    const connectAgain = all(nodes, (n) => n.type === 'TouchableOpacity' && textIn(n) === t('Connect again'));
    const line = allText(nodes).includes(t(SIGN_IN_REFRESH_WORDS.line));
    return { nodes, onProtectSso, refreshButtons, connectAgain, line };
}

describe("Account Protection's Refresh, closed over every kind of copy", () => {
    // The status each kind of copy gets from a server with S4 (test-recovery-findable.ts proves these answers), and one
    // from a server without it.
    it.each([
        ['made before S0', { enrolledSso: ['google'], findableSso: [] }, true],
        ['made after S0', { enrolledSso: ['google'], findableSso: ['google'] }, false],
        ['healed by the scan', { enrolledSso: ['google'], findableSso: ['google'] }, false],
        ['refreshed', { enrolledSso: ['google'], findableSso: ['google'] }, false],
        ['at a server from before S4 (no findableSso)', { enrolledSso: ['google'] }, false],
    ])('a copy %s: Refresh %s', (_kind, status, shown) => {
        const p = panel(fromStatus(status));
        expect(p.refreshButtons.map((b) => b.props.testID)).toEqual(shown ? ['refresh-google'] : []);
        expect(p.line).toBe(shown);
    });
});

describe('the Refresh row', () => {
    it('is shown once, under the sign-in it is for, in place of Connect again', () => {
        const p = panel(fromStatus({ enrolledSso: ['google', 'facebook'], findableSso: ['facebook'] }));
        expect(p.refreshButtons.map((b) => b.props.testID)).toEqual(['refresh-google']);
        expect(p.refreshButtons[0].props.accessibilityLabel).toBe(t(SIGN_IN_REFRESH_WORDS.label, { provider: 'Google' }));
        expect(textIn(p.refreshButtons[0])).toBe(t(SIGN_IN_REFRESH_WORDS.button));
        // Facebook, findable, keeps its Connect again; Google's is the Refresh.
        expect(p.connectAgain).toHaveLength(1);
        expect(allText(p.nodes).split(t(SIGN_IN_REFRESH_WORDS.line)).length - 1).toBe(1);
    });

    it('runs the ordinary Connect for that sign-in, nothing else', () => {
        const p = panel(fromStatus({ enrolledSso: ['google'], findableSso: [] }));
        p.refreshButtons[0].props.onPress();
        expect(p.onProtectSso).toHaveBeenCalledTimes(1);
        expect(p.onProtectSso).toHaveBeenCalledWith('google', false);
    });

    it('is hidden once the copy is findable', () => {
        const p = panel(fromStatus({ enrolledSso: ['google'], findableSso: ['google'] }));
        expect(p.refreshButtons).toHaveLength(0);
        expect(p.line).toBe(false);
        expect(p.connectAgain).toHaveLength(1);
    });

    it('is offered on a phone without the 12 words too: it asks for none, and the copy is its only way back', () => {
        const p = panel(fromStatus({ enrolledSso: ['google'], findableSso: [] }), { hasWords: false });
        expect(p.refreshButtons.map((b) => b.props.testID)).toEqual(['refresh-google']);
        expect(p.connectAgain).toHaveLength(0);
    });

    it('is never drawn at the vault, whose copies are not the community\'s', () => {
        const p = panel(fromStatus({ enrolledSso: ['google'], findableSso: [] }), { copiesAt: 'vault' });
        expect(p.refreshButtons).toHaveLength(0);
        expect(p.line).toBe(false);
    });

    it('stays after a Connect that failed: the sheet said why, and the community still has the old copy', () => {
        // The sheet never reports a failed Connect to Settings (components/SsoEnrolSheet.tsx: onEnrolled only on success),
        // so the result Settings draws from is the status it read before.
        const before = fromStatus({ enrolledSso: ['google'], findableSso: [] });
        const p = panel(before);
        expect(p.refreshButtons.map((b) => b.props.testID)).toEqual(['refresh-google']);
    });
});
