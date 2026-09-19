import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OwnerPhoneUnlock, loopbackQrHost, type OwnerPhoneSession } from './OwnerPhoneUnlock';

const qrFor = (serverUrl: string) => `beanpool-unlock:v1?u=${encodeURIComponent(serverUrl)}&s=${'p'.repeat(64)}&p=takeover`;
const session = (serverUrl: string): OwnerPhoneSession => ({
    sessionId: 'p'.repeat(64), expiresAt: Date.now() + 600_000, qr: qrFor(serverUrl), link: 'beanpool://unlock-keys?x',
    owners: ['@anna'], envelope: { envelopeId: 'e'.repeat(32), sealedAt: '2026-09-19T10:00:00.000Z' },
});

describe('OwnerPhoneUnlock: an address a phone cannot reach', () => {
    it('knows this computer\'s own addresses', () => {
        expect(loopbackQrHost(qrFor('https://localhost:8443'))).toBe('localhost');
        expect(loopbackQrHost(qrFor('https://127.0.0.1:8443'))).toBe('127.0.0.1');
        expect(loopbackQrHost(qrFor('https://[::1]:8443'))).toBe('::1');
        expect(loopbackQrHost(qrFor('https://standby.example.org'))).toBeNull();
        expect(loopbackQrHost(qrFor('https://192.168.1.20:8443'))).toBeNull();
        expect(loopbackQrHost('beanpool-unlock:v1?x')).toBeNull();
    });

    it('says so above the QR when the code points at localhost', () => {
        render(<OwnerPhoneUnlock session={session('https://localhost:8443')} purpose="restore" />);
        const alert = screen.getByRole('alert');
        expect(alert.textContent).toMatch(/localhost, this computer's own address: a phone can't reach it/);
        expect(alert.textContent).toMatch(/open the backup with the recovery code/);
    });

    it('says nothing when the code points at a public address', () => {
        render(<OwnerPhoneUnlock session={session('https://standby.example.org')} purpose="takeover" />);
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
