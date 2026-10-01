import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppVersionsCard } from './AppVersionsCard';
import * as nodeClient from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';
import type { AppPlatformVersions, AppVersionsResponse } from '../../lib/node-client';

vi.mock('../../lib/node-client', async () => {
    const actual = await vi.importActual('../../lib/node-client');
    return { ...actual, fetchAppVersions: vi.fn() };
});

const node: NodeProfile = { id: 'node-1', name: 'Node Alpha', url: 'https://alpha.beanpool.org', adminPassword: 'pw-alpha' };

function platform(p: Partial<AppPlatformVersions>): AppPlatformVersions {
    return { floor: '1.2.60', store: '1.2.61', enforced: '1.2.60', held: false, from: null, fromInvalid: false, blocking: true, versions: [], ...p };
}

function answer(android: Partial<AppPlatformVersions>, ios: Partial<AppPlatformVersions>) {
    const res: AppVersionsResponse = {
        since: '2026-09-20T00:00:00.000Z', windowDays: 30, minAppVersion: '1.0.75', minAppVersionFrom: null,
        storeCheckedAt: '2026-10-01T00:00:00.000Z', platforms: { android: platform(android), ios: platform(ios) },
    };
    vi.mocked(nodeClient.fetchAppVersions).mockResolvedValue(res);
}

describe('AppVersionsCard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("asks this node with its own sign-in, and shows that it is counting meanwhile", () => {
        vi.mocked(nodeClient.fetchAppVersions).mockImplementation(() => new Promise(() => {}));
        render(<AppVersionsCard node={node} />);
        expect(screen.getByRole('heading', { name: /Phone app versions/i })).toBeInTheDocument();
        expect(screen.getByText('Counting…')).toBeInTheDocument();
        expect(nodeClient.fetchAppVersions).toHaveBeenCalledWith('https://alpha.beanpool.org', 'pw-alpha', undefined);
    });

    it('shows each platform\'s versions with member counts, and how many are below the floor', async () => {
        answer(
            { versions: [{ version: '1.2.61', members: 7 }, { version: '1.2.60', members: 3 }, { version: '1.2.58', members: 2 }, { version: '1.2.9', members: 1 }] },
            { versions: [{ version: '1.2.60', members: 4 }] },
        );
        render(<AppVersionsCard node={node} />);
        const android = await screen.findByTestId('app-versions-android');
        // 1.2.58 and 1.2.9 are below 1.2.60 (1.2.9 numerically, not as text).
        expect(screen.getByTestId('app-versions-android-below')).toHaveTextContent('3 members of 13 below 1.2.60');
        const rows = within(android).getAllByRole('row');
        expect(rows).toHaveLength(5);
        expect(rows[3]).toHaveTextContent('1.2.58 · below the floor');
        expect(rows[1]).not.toHaveTextContent('below the floor');
        expect(screen.getByTestId('app-versions-iphone-below')).toHaveTextContent('0 members of 4 below 1.2.60');
        expect(screen.getByText(/Members seen since/)).toBeInTheDocument();
    });

    it('names no member: the answer has none to name', async () => {
        answer({ versions: [{ version: '1.2.61', members: 1 }] }, {});
        render(<AppVersionsCard node={node} />);
        const card = await screen.findByTestId('app-versions-card');
        expect(card).toHaveTextContent('never who');
    });

    it('says a floor the store has not reached yet stops nobody (iOS review lag)', async () => {
        answer({}, { floor: '1.3.0', store: '1.2.61', enforced: null, held: true, blocking: false });
        render(<AppVersionsCard node={node} />);
        const iphone = await screen.findByTestId('app-versions-iphone');
        expect(iphone).toHaveTextContent('Floor 1.3.0 is waiting for the App Store, which has 1.2.61. No app is stopped until the App Store has 1.3.0.');
    });

    it('says when a grace date is still ahead, and when the store version is unknown', async () => {
        answer({ blocking: false, from: '2026-10-15T00:00:00.000Z' }, { store: null, enforced: null, blocking: false });
        render(<AppVersionsCard node={node} />);
        const android = await screen.findByTestId('app-versions-android');
        expect(android).toHaveTextContent(/show a banner now, and stop at their next start from/);
        expect(screen.getByTestId('app-versions-iphone')).toHaveTextContent("not enforced yet: this server hasn't read the App Store's version");
    });

    it('says a grace date that is not a date turns the block off', async () => {
        answer({ fromInvalid: true, blocking: false }, {});
        render(<AppVersionsCard node={node} />);
        const android = await screen.findByTestId('app-versions-android');
        expect(android).toHaveTextContent("isn't a date, so no app is stopped until it is fixed");
    });

    it('an answer of another shape is said in words, never read (it took the whole Home section down)', async () => {
        vi.mocked(nodeClient.fetchAppVersions).mockResolvedValue({ ok: true } as unknown as AppVersionsResponse);
        render(<AppVersionsCard node={node} />);
        expect(await screen.findByRole('alert')).toHaveTextContent("doesn't count app versions yet");
    });

    it('shows a node that cannot answer, in words', async () => {
        vi.mocked(nodeClient.fetchAppVersions).mockRejectedValue(new Error("This node's build doesn't count app versions yet. Update it to see them."));
        render(<AppVersionsCard node={node} />);
        expect(await screen.findByRole('alert')).toHaveTextContent("doesn't count app versions yet");
    });
});
