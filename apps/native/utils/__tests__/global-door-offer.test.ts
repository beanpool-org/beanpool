/**
 * Whether the welcome screen offers "Explore BeanPool worldwide" (utils/global-door-offer.ts): only once the
 * global community has answered, this app start, that it is the global community with its door open. Until then,
 * and after any failure, slow answer or other answer, the button is not there and the screen reads as it did
 * before the door existed.
 *
 * Nothing here contacts a node: every answer comes from a fetch stub. The welcome screen can't be rendered here
 * (vitest.config.ts); the last tests read its source to check it is wired to what is tested above them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));

import {
    GLOBAL_DOOR_OFFER_TIMEOUT_MS,
    askGlobalDoorOffer,
    globalDoorOffered,
    forgetGlobalDoorOffer,
} from '../global-door-offer';
import { GLOBAL_NODE_URL, checkGlobalDoor } from '../node-profile';

const INFO_URL = `${GLOBAL_NODE_URL}/api/community/info`;
const GLOBAL_OPEN = { profile: 'global', features: { beans: false, openJoin: true } };
const GLOBAL_SHUT = { profile: 'global', features: { beans: false, openJoin: false } };
const GLOBAL_SILENT = { profile: 'global', features: { beans: false } };
const LOCAL = { profile: 'local', features: { beans: true, openJoin: false } };
const LOCAL_BUT_OPEN = { profile: 'local', features: { beans: true, openJoin: true } };

/** A fetch that answers `body` with `status` from the global community's info address, and fails anything else. */
function answering(body: unknown, status = 200) {
    return vi.fn(async (input: string | URL | Request) => {
        if (String(input) !== INFO_URL) throw new TypeError(`Network request failed: ${String(input)}`);
        return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
    });
}

/** No network at all. */
const offline = () => vi.fn(async () => { throw new TypeError('Network request failed'); });

/** A node that never answers, and ignores being told to stop: only the offer's own clock can end the wait. */
const neverAnswers = () => vi.fn(() => new Promise<Response>(() => {}));

beforeEach(() => {
    forgetGlobalDoorOffer();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('shown only when the global community says it is open', () => {
    it('shows the button when the answer is the global community with its door open', async () => {
        const fetchImpl = answering(GLOBAL_OPEN);
        await expect(askGlobalDoorOffer(fetchImpl)).resolves.toBe(true);
        expect(globalDoorOffered()).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0][0])).toBe(INFO_URL);
    });

    it('hides it when there is no network', async () => {
        await expect(askGlobalDoorOffer(offline())).resolves.toBe(false);
        expect(globalDoorOffered()).toBe(false);
    });

    it('hides it on an error answer', async () => {
        await expect(askGlobalDoorOffer(answering({ error: 'down' }, 503))).resolves.toBe(false);
        expect(globalDoorOffered()).toBe(false);
    });

    it('hides it on an answer that is not an info answer', async () => {
        await expect(askGlobalDoorOffer(answering('<html>parked domain</html>'))).resolves.toBe(false);
        await expect(askGlobalDoorOffer(answering(null))).resolves.toBe(false);
        expect(globalDoorOffered()).toBe(false);
    });

    it('hides it when the node answers as a local community, even one with an open door', async () => {
        await expect(askGlobalDoorOffer(answering(LOCAL))).resolves.toBe(false);
        forgetGlobalDoorOffer();
        await expect(askGlobalDoorOffer(answering(LOCAL_BUT_OPEN))).resolves.toBe(false);
        forgetGlobalDoorOffer();
        await expect(askGlobalDoorOffer(answering({ features: { openJoin: true } }))).resolves.toBe(false);
        expect(globalDoorOffered()).toBe(false);
    });

    it('hides it when the global community has its door shut, or does not say it is open', async () => {
        await expect(askGlobalDoorOffer(answering(GLOBAL_SHUT))).resolves.toBe(false);
        forgetGlobalDoorOffer();
        await expect(askGlobalDoorOffer(answering(GLOBAL_SILENT))).resolves.toBe(false);
        expect(globalDoorOffered()).toBe(false);
    });

    it('never throws, whatever the fetch does', async () => {
        const throwsAtOnce = vi.fn(() => { throw new Error('boom'); }) as unknown as typeof fetch;
        await expect(askGlobalDoorOffer(throwsAtOnce)).resolves.toBe(false);
        forgetGlobalDoorOffer();
        const badBody = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }) as unknown as Response);
        await expect(askGlobalDoorOffer(badBody)).resolves.toBe(false);
        expect(globalDoorOffered()).toBe(false);
    });
});

describe('a slow answer means hidden', () => {
    it(`gives up after ${GLOBAL_DOOR_OFFER_TIMEOUT_MS / 1000} s, even on a node that ignores being told to stop`, async () => {
        vi.useFakeTimers();
        let settled: boolean | undefined;
        askGlobalDoorOffer(neverAnswers()).then(v => { settled = v; });
        await vi.advanceTimersByTimeAsync(GLOBAL_DOOR_OFFER_TIMEOUT_MS - 1);
        expect(settled).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(false);
        expect(globalDoorOffered()).toBe(false);
    });

    it('is a short check: five seconds at most', () => {
        expect(GLOBAL_DOOR_OFFER_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    });

    it('an answer that comes after it gave up does not bring the button back', async () => {
        vi.useFakeTimers();
        let answer!: (r: Response) => void;
        const late = vi.fn(() => new Promise<Response>(resolve => { answer = resolve; }));
        const offered = askGlobalDoorOffer(late);
        await vi.advanceTimersByTimeAsync(GLOBAL_DOOR_OFFER_TIMEOUT_MS);
        await expect(offered).resolves.toBe(false);
        answer({ ok: true, status: 200, json: async () => GLOBAL_OPEN } as unknown as Response);
        await vi.advanceTimersByTimeAsync(0);
        expect(globalDoorOffered()).toBe(false);
    });
});

describe('asked once per app start, and again after a failure', () => {
    it('keeps an open answer for the session: no second request', async () => {
        const fetchImpl = answering(GLOBAL_OPEN);
        await askGlobalDoorOffer(fetchImpl);
        await expect(askGlobalDoorOffer(fetchImpl)).resolves.toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('keeps a shut or local answer for the session too: it was an answer, not a failure', async () => {
        const shut = answering(GLOBAL_SHUT);
        await askGlobalDoorOffer(shut);
        await expect(askGlobalDoorOffer(answering(GLOBAL_OPEN))).resolves.toBe(false);
        expect(shut).toHaveBeenCalledTimes(1);
        forgetGlobalDoorOffer();
        await askGlobalDoorOffer(answering(LOCAL));
        await expect(askGlobalDoorOffer(answering(GLOBAL_OPEN))).resolves.toBe(false);
    });

    it('asks again after a failure (the welcome screen coming back into view), and shows the button then', async () => {
        await expect(askGlobalDoorOffer(offline())).resolves.toBe(false);
        const back = answering(GLOBAL_OPEN);
        await expect(askGlobalDoorOffer(back)).resolves.toBe(true);
        expect(back).toHaveBeenCalledTimes(1);
        expect(globalDoorOffered()).toBe(true);
    });

    it('asks again after a timeout', async () => {
        vi.useFakeTimers();
        const first = askGlobalDoorOffer(neverAnswers());
        await vi.advanceTimersByTimeAsync(GLOBAL_DOOR_OFFER_TIMEOUT_MS);
        await expect(first).resolves.toBe(false);
        vi.useRealTimers();
        await expect(askGlobalDoorOffer(answering(GLOBAL_OPEN))).resolves.toBe(true);
    });

    it('two asks at once share one request', async () => {
        const fetchImpl = answering(GLOBAL_OPEN);
        const [a, b] = await Promise.all([askGlobalDoorOffer(fetchImpl), askGlobalDoorOffer(fetchImpl)]);
        expect([a, b]).toEqual([true, true]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

describe('no network call blocks the first render', () => {
    it('what to show right now is known without waiting: hidden until an answer', () => {
        expect(globalDoorOffered()).toBe(false);
    });

    it('asking returns at once while the node has not answered, and the screen still reads hidden', () => {
        const fetchImpl = neverAnswers();
        const pending = askGlobalDoorOffer(fetchImpl);
        expect(pending).toBeInstanceOf(Promise);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(globalDoorOffered()).toBe(false);
    });
});

describe('the tap-time check stays, as the second guard', () => {
    it('refuses a node that is not global at the tap, even after the offer said open', async () => {
        await expect(askGlobalDoorOffer(answering(GLOBAL_OPEN))).resolves.toBe(true);
        // Between the offer and the tap, the address came to answer as a local community.
        const atTap = answering(LOCAL_BUT_OPEN);
        await expect(checkGlobalDoor(GLOBAL_NODE_URL, atTap)).resolves.toEqual({ ok: false, reason: 'not_global' });
        // Asked fresh at the tap, never from the offer's answer.
        expect(atTap).toHaveBeenCalledTimes(1);
    });

    it('refuses a shut door at the tap, even after the offer said open', async () => {
        await askGlobalDoorOffer(answering(GLOBAL_OPEN));
        await expect(checkGlobalDoor(GLOBAL_NODE_URL, answering(GLOBAL_SHUT))).resolves.toEqual({ ok: false, reason: 'door_closed' });
    });
});

describe('the welcome screen', () => {
    const src = () => fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf-8');
    const home = () => {
        const s = src();
        const start = s.indexOf('// --- MAIN WELCOME SCREEN');
        const end = s.indexOf('const styles = StyleSheet.create(');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        return s.slice(start, end);
    };
    /** Code only: what a comment says is not on the screen. */
    const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /** The home screen split at the offer: [before it, the offer, after it]. */
    const aroundOffer = () => {
        const h = code(home());
        const start = h.indexOf('{globalOffer && (');
        expect(start).toBeGreaterThan(-1);
        const end = h.indexOf('</Animated.View>', start);
        expect(end).toBeGreaterThan(start);
        return [h.slice(0, start), h.slice(start, end), h.slice(end)];
    };

    it('draws the Explore button only inside the offer, and nowhere else on the screen', () => {
        const [before, offer, after] = aroundOffer();
        expect(offer).toMatch(/onPress=\{openGlobalDoor\}[^>]*>\s*<Text style=\{styles\.memberBtnText\} numberOfLines=\{1\} adjustsFontSizeToFit minimumFontScale=\{0\.6\}>🌍 Explore BeanPool worldwide</);
        for (const rest of [before, after]) {
            expect(rest).not.toMatch(/openGlobalDoor/);
            expect(rest).not.toMatch(/Explore BeanPool worldwide/);
        }
        expect(src().match(/onPress=\{openGlobalDoor\}/g)).toHaveLength(1);
    });

    it('the hint follows: "No invite? Explore…" only with the button, and the invite hint promises nothing else', () => {
        const [before, offer, after] = aroundOffer();
        expect(offer).toMatch(/No invite\? Explore BeanPool worldwide and find a community near you\./);
        expect(before).not.toMatch(/Explore|worldwide|global community/i);
        expect(after).not.toMatch(/Explore|worldwide|global community/i);
        // What the screen says with no offer: the invite, and where to find one, as before the door existed.
        expect(before).toMatch(/No invite yet\? Ask a friend on BeanPool, or find a community near you at\{' '\}/);
        expect(before).toMatch(/openLink\('https:\/\/beanpool\.org'\)/);
    });

    it('starts hidden from what is already known, and asks the node after drawing, never before', () => {
        const s = src();
        expect(s).toMatch(/const \[globalOffer, setGlobalOffer\] = useState\(globalDoorOffered\);/);
        expect(s).toMatch(/askGlobalDoorOffer\(\)\.then\(/);
        expect(s).not.toMatch(/await askGlobalDoorOffer/);
    });

    it('asks while home is in view, and again when the app comes back to the front', () => {
        const s = src();
        const start = s.indexOf('useFocusEffect(useCallback(() => {');
        expect(start).toBeGreaterThan(-1);
        const effect = s.slice(start, s.indexOf('}, [mode]));', start));
        expect(effect).toMatch(/if \(mode !== 'home'\) return;/);
        expect(effect).toMatch(/askGlobalDoorOffer\(\)\.then\(/);
        expect(effect).toMatch(/AppState\.addEventListener\('change'/);
    });

    it('keeps the tap-time check: the door still asks fresh and refuses anything but an open global community', () => {
        const s = src();
        const open = s.slice(s.indexOf('function openGlobalDoor('), s.indexOf('function leaveGlobalDoor('));
        expect(open).toMatch(/setGlobalPhase\('checking'\);\s*setMode\('globalJoin'\);/);
        const door = s.slice(s.indexOf("if (mode !== 'globalJoin' || globalPhase !== 'checking') return;"), s.indexOf('async function handleCreate('));
        expect(door).toMatch(/checkGlobalDoor\(\)/);
        expect(door).toMatch(/if \(!check\.ok\) \{\s*setGlobalMessage\(GLOBAL_DOOR_MESSAGES\[check\.reason\]\);\s*setGlobalPhase\('unavailable'\);/);
    });
});
