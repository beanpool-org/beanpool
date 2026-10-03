/** Node sign-in step 7b-1: the profile screen takes an automation token, masked, and checks its shape before saving. */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditNodeModal } from './EditNodeModal';
import { AddNodeModal } from './AddNodeModal';
import { guardTokenFetch } from '../../lib/token-guard';
import * as nodeClient from '../../lib/node-client';

const TOKEN = `bp_${'c3'.repeat(6)}_${'9d'.repeat(32)}`;
const node = { id: 'node-1', name: 'Primary Node', url: 'https://primary.example', adminPassword: 'pass123' };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the token field', () => {
    it('is masked, saves the token with the profile, and says the password is not sent', async () => {
        const onSave = vi.fn();
        render(<EditNodeModal node={node} onClose={vi.fn()} onSave={onSave} />);
        const field = screen.getByLabelText('Automation token') as HTMLInputElement;
        expect(field.type).toBe('password');
        fireEvent.change(field, { target: { value: TOKEN } });
        expect(screen.getByText('Not sent while a token is set.')).toBeTruthy();
        await userEvent.click(screen.getByText('Save Settings'));
        expect(onSave).toHaveBeenCalledWith('node-1', expect.objectContaining({ automationToken: TOKEN, adminPassword: 'pass123' }));
    });

    it('refuses something that is not a token, and saves nothing', async () => {
        const onSave = vi.fn();
        render(<EditNodeModal node={node} onClose={vi.fn()} onSave={onSave} />);
        fireEvent.change(screen.getByLabelText('Automation token'), { target: { value: 'my-password' } });
        expect(screen.getByRole('alert').textContent).toMatch(/starts bp_/);
        await userEvent.click(screen.getByText('Save Settings'));
        expect(onSave).not.toHaveBeenCalled();
    });

    it('says where a token comes from', () => {
        render(<EditNodeModal node={node} onClose={vi.fn()} onSave={vi.fn()} />);
        expect(screen.getByText('Where do I get one?')).toBeTruthy();
        expect(document.body.textContent).toMatch(/Automation tokens, made from your phone/);
    });

    it('test connection uses the token alone', async () => {
        const spy = vi.spyOn(nodeClient, 'fetchDiagnostics').mockResolvedValue({ status: 'ok', communityName: 'X' } as never);
        render(<EditNodeModal node={node} onClose={vi.fn()} onSave={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Automation token'), { target: { value: TOKEN } });
        await userEvent.click(screen.getByText('⚡ Test Connection'));
        expect(spy).toHaveBeenCalledWith('https://primary.example', TOKEN);
    });

    it('shows the scope once a node has said it', async () => {
        const inner = vi.fn(async () => new Response(JSON.stringify({ code: 'token_not_allowed', scope: 'read', error: 'x' }), { status: 403 }));
        vi.stubGlobal('fetch', guardTokenFetch(inner as unknown as typeof fetch));
        await nodeClient.freezeNodeUser('https://primary.example', 'abc', true, TOKEN).catch(() => {});
        render(<EditNodeModal node={{ ...node, automationToken: TOKEN }} onClose={vi.fn()} onSave={vi.fn()} />);
        expect(document.querySelector('[data-token-scope]')?.textContent).toMatch(/read: it can look/);
    });

    it('a new node can be added with a token', async () => {
        const onAdd = vi.fn();
        render(<AddNodeModal onClose={vi.fn()} onAdd={onAdd} />);
        fireEvent.change(screen.getByPlaceholderText('e.g. Byron Community Node'), { target: { value: 'Byron' } });
        fireEvent.change(screen.getByPlaceholderText(/https:\/\/node2/), { target: { value: 'https://byron.example' } });
        fireEvent.change(screen.getByLabelText('Automation token'), { target: { value: TOKEN } });
        fireEvent.submit(screen.getByLabelText('Automation token').closest('form')!);
        expect(onAdd).toHaveBeenCalledWith('Byron', 'https://byron.example', undefined, TOKEN);
    });
});
