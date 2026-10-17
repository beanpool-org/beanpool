/**
 * NAT-4, the phone's cleartext rule, in the one copy the phone (apps/native/utils/node-url.ts re-exports it) and
 * `beanpool claim` (its warning before the QR) both read. The table is what each side relies on: a public address over
 * plain http is refused, a home-network one and anything over https is not.
 */
import { describe, it, expect } from 'vitest';
import { isPrivateHost, shouldBlockCleartextNodeUrl } from '../index.js';

/** [address, refused] */
const CLEARTEXT_TABLE: Array<[string, boolean]> = [
    // A public server over plain http: a rented server (17 Oct), by IP and by name, any port, any case.
    ['http://203.0.113.7', true],
    ['http://203.0.113.7:80', true],
    ['HTTP://203.0.113.7:8080', true],
    ['ws://203.0.113.7:8080/ws', true],
    ['http://mullum.beanpool.org', true],
    ['http://beans.example.org:8080', true],
    ['http://172.32.0.1', true],
    ['http://172.15.0.1', true],
    ['http://localhost.attacker.example', true],
    // Over https: always.
    ['https://203.0.113.7', false],
    ['https://mullum.beanpool.org', false],
    ['wss://beans.example.org/ws', false],
    // A home network, loopback and the like: cleartext stays allowed.
    ['http://192.168.1.20:8080', false],
    ['http://10.0.0.5', false],
    ['http://172.16.0.1', false],
    ['http://172.31.255.255:8080', false],
    ['http://127.0.0.1:8080', false],
    ['http://169.254.10.1', false],
    ['http://localhost', false],
    ['http://localhost:8080', false],
    ['http://beanpool.localhost', false],
    ['http://beanpool.local:8080', false],
    ['http://node.lan', false],
    ['http://box.home', false],
    ['http://srv.internal', false],
    ['http://[fd00::1]:8080', false],
    ['http://raspberrypi:8080', false],
    ['', false],
];

describe('shouldBlockCleartextNodeUrl', () => {
    it.each(CLEARTEXT_TABLE)('%s → refused %s', (url, refused) => {
        expect(shouldBlockCleartextNodeUrl(url)).toBe(refused);
    });
});

describe('isPrivateHost', () => {
    it('home-network, loopback and single-label hosts are private; a public IP or a dotted name is not', () => {
        for (const h of ['192.168.0.1', '10.1.2.3:80', '172.20.0.1', '127.0.0.1', '169.254.0.1', 'localhost', 'LOCALHOST:8080', 'x.local', '[::1]', 'nas', ''])
            expect(isPrivateHost(h), h).toBe(true);
        for (const h of ['203.0.113.7', '8.8.8.8:53', '172.32.0.1', 'mullum.beanpool.org', 'example.com:8080'])
            expect(isPrivateHost(h), h).toBe(false);
    });
});
