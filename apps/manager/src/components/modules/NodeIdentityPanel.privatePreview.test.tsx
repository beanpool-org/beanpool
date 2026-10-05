/**
 * The node's info shows the server's PRIVATE_PREVIEW setting read-only, from its public /api/community/info
 * (`features.privatePreview`; absent = off), in one plain line. A node that can't be read shows no line.
 */
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeIdentityPanel } from './NodeIdentityPanel';
import type { NodeProfile } from '../../lib/profiles';
import { fetchNodePrivatePreview, type DiagnosticsResponse } from '../../lib/node-client';

const node: NodeProfile = { id: 'pp-node', name: 'Global', url: 'https://global.test', adminPassword: 'pw' };
const diag = { status: 'healthy', callsign: 'global', communityName: 'Global' } as unknown as DiagnosticsResponse;

function stubInfo(info: unknown | Error) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).includes('/api/community/info')) {
            if (info instanceof Error) throw info;
            return { ok: true, json: async () => info };
        }
        return { ok: true, json: async () => ({}) };
    }));
}

async function renderPanel() {
    await act(async () => {
        render(<NodeIdentityPanel activeNode={node} diag={diag} onRefreshDiag={vi.fn()} />);
    });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('private preview in the node info', () => {
    it('on: one plain line, read-only', async () => {
        stubInfo({ profile: 'global', features: { openJoin: false, privatePreview: true } });
        await renderPanel();
        const line = await screen.findByTestId('private-preview-line');
        expect(line.textContent).toBe("Private preview: on. Only members, and people the owner or an admin invites, can get in. Set in the server's settings.");
        expect(line.querySelector('input, button, select')).toBeNull();
    });

    it('off when the node says nothing about it', async () => {
        stubInfo({ profile: 'global', features: { openJoin: true } });
        await renderPanel();
        expect((await screen.findByTestId('private-preview-line')).textContent).toBe("Private preview: off. Set in the server's settings.");
    });

    it('no line when the node cannot be read', async () => {
        stubInfo(new Error('offline'));
        await renderPanel();
        expect(screen.queryByTestId('private-preview-line')).toBeNull();
        await expect(fetchNodePrivatePreview('https://global.test')).resolves.toBeNull();
    });
});
