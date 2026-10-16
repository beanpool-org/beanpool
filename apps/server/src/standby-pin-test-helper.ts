/**
 * For suites (not a suite itself): a standby pinned to its main server as `beanpool pair` leaves it
 * (services/standby-main.ts), written straight into the data dir. Takes a PeerId, or a multiaddr ending /p2p/<PeerId>
 * (how a suite named its main server while that was a `mirror` link). The data dir is BEANPOOL_DATA_DIR at the call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STANDBY_MAIN_FILE, writeStandbyMain } from './services/standby-main.js';

function peerIdIn(peerIdOrAddress: string): string {
    const m = peerIdOrAddress.match(/\/p2p\/([^/]+)$/);
    return m ? m[1] : peerIdOrAddress;
}

function dataDir(dir?: string): string {
    return dir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

export function pinMainServerForTests(peerIdOrAddress: string, opts: { dir?: string; communityId?: string | null; url?: string | null } = {}): void {
    const dir = dataDir(opts.dir);
    fs.mkdirSync(dir, { recursive: true });
    writeStandbyMain({
        v: 1, peerId: peerIdIn(peerIdOrAddress), communityId: opts.communityId ?? null, url: opts.url ?? null,
        pairedAt: Date.now(), how: 'shell',
    }, dir);
}

export function unpinMainServerForTests(dir?: string): void {
    fs.rmSync(path.join(dataDir(dir), STANDBY_MAIN_FILE), { force: true });
}
