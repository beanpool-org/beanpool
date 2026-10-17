/**
 * What the global community's door said, this app start (utils/global-door-offer.ts), as the first screen's
 * "Explore BeanPool worldwide" and the BeanPool sheet's global row draw it (DESIGN-global-entry-fable.md §B.2, P2).
 *
 * Before P2 the offer was a yes or a no, and a no took the button away: offline, slow, shut or in a preview, a new member
 * saw an invite-only app with nothing to say why (§1.2). Now each answer is a state the screens draw a line for, and none
 * of them hides anything: `open`, `closed` (shut, or not the global community at that address), `preview`,
 * `unreachable` (no answer, an error answer, a body that isn't an info answer, or nothing within five seconds), and
 * `unknown` before the first answer.
 *
 * Nothing here contacts a node: every answer comes from a fetch stub. The welcome screen itself can't be rendered here
 * (its doors are: welcome-doors-render.test.ts); the last tests read its source to check it is wired to what is tested
 * above them.
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
    globalDoorOffer,
    forgetGlobalDoorOffer,
    rememberGlobalDoor,
} from '../global-door-offer';
import { GLOBAL_NODE_URL, checkGlobalDoor } from '../node-profile';

const INFO_URL = `${GLOBAL_NODE_URL}/api/community/info`;
const GLOBAL_OPEN = { profile: 'global', features: { beans: false, openJoin: true } };
const GLOBAL_OPEN_WORDS = { profile: 'global', features: { beans: false, openJoin: true, wordsDoor: true } };
const GLOBAL_SHUT = { profile: 'global', features: { beans: false, openJoin: false } };
const GLOBAL_SILENT = { profile: 'global', features: { beans: false } };
const GLOBAL_PREVIEW = { profile: 'global', features: { beans: false, openJoin: true, privatePreview: true } };
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

const stateOf = async (fetchImpl: typeof fetch) => (await askGlobalDoorOffer(fetchImpl)).state;

beforeEach(() => {
    forgetGlobalDoorOffer();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('each answer is a state, and none of them hides the door', () => {
    it('open: the global community with its door open', async () => {
        const fetchImpl = answering(GLOBAL_OPEN);
        await expect(askGlobalDoorOffer(fetchImpl)).resolves.toEqual({ state: 'open', wordsDoor: false });
        expect(globalDoorOffer()).toEqual({ state: 'open', wordsDoor: false });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0][0])).toBe(INFO_URL);
    });

    it('open, with the 12-words way in where the door says so (the sheet row names both ways)', async () => {
        await expect(askGlobalDoorOffer(answering(GLOBAL_OPEN_WORDS))).resolves.toEqual({ state: 'open', wordsDoor: true });
    });

    it('preview: the global community in a private preview', async () => {
        await expect(stateOf(answering(GLOBAL_PREVIEW))).resolves.toBe('preview');
        expect(globalDoorOffer()).toEqual({ state: 'preview', wordsDoor: false });
    });

    it('closed: the global community with its door shut, or not saying it is open', async () => {
        await expect(stateOf(answering(GLOBAL_SHUT))).resolves.toBe('closed');
        forgetGlobalDoorOffer();
        await expect(stateOf(answering(GLOBAL_SILENT))).resolves.toBe('closed');
        expect(globalDoorOffer().state).toBe('closed');
    });

    it('closed: whatever answers at the address is not the global community, even a local one with an open door', async () => {
        await expect(stateOf(answering(LOCAL))).resolves.toBe('closed');
        forgetGlobalDoorOffer();
        await expect(stateOf(answering(LOCAL_BUT_OPEN))).resolves.toBe('closed');
        forgetGlobalDoorOffer();
        // An answer that names no profile reads as a local community (node-profile.ts readNodeProfile).
        await expect(stateOf(answering({ features: { openJoin: true } }))).resolves.toBe('closed');
    });

    it('unreachable: no network', async () => {
        await expect(stateOf(offline())).resolves.toBe('unreachable');
        expect(globalDoorOffer()).toEqual({ state: 'unreachable', wordsDoor: false });
    });

    it('unreachable: an error answer', async () => {
        await expect(stateOf(answering({ error: 'down' }, 503))).resolves.toBe('unreachable');
    });

    it('unreachable: an answer that is not an info answer', async () => {
        await expect(stateOf(answering('<html>parked domain</html>'))).resolves.toBe('unreachable');
        await expect(stateOf(answering(null))).resolves.toBe('unreachable');
    });

    it('never throws, whatever the fetch does', async () => {
        const throwsAtOnce = vi.fn(() => { throw new Error('boom'); }) as unknown as typeof fetch;
        await expect(stateOf(throwsAtOnce)).resolves.toBe('unreachable');
        forgetGlobalDoorOffer();
        const badBody = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }) as unknown as Response);
        await expect(stateOf(badBody)).resolves.toBe('unreachable');
    });

    it('only an open door names the 12-words way: a shut or preview door with wordsDoor on says nothing of it', async () => {
        await expect(askGlobalDoorOffer(answering({ profile: 'global', features: { openJoin: false, wordsDoor: true } })))
            .resolves.toEqual({ state: 'closed', wordsDoor: false });
        forgetGlobalDoorOffer();
        await expect(askGlobalDoorOffer(answering({ profile: 'global', features: { openJoin: true, privatePreview: true, wordsDoor: true } })))
            .resolves.toEqual({ state: 'preview', wordsDoor: false });
    });
});

describe('a slow answer is unreachable', () => {
    it(`gives up after ${GLOBAL_DOOR_OFFER_TIMEOUT_MS / 1000} s, even on a node that ignores being told to stop`, async () => {
        vi.useFakeTimers();
        let settled: string | undefined;
        askGlobalDoorOffer(neverAnswers()).then(v => { settled = v.state; });
        await vi.advanceTimersByTimeAsync(GLOBAL_DOOR_OFFER_TIMEOUT_MS - 1);
        expect(settled).toBeUndefined();
        expect(globalDoorOffer().state).toBe('unknown');
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe('unreachable');
        expect(globalDoorOffer().state).toBe('unreachable');
    });

    it('is a short check: five seconds at most', () => {
        expect(GLOBAL_DOOR_OFFER_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    });

    it('an answer that comes after it gave up changes nothing', async () => {
        vi.useFakeTimers();
        let answer!: (r: Response) => void;
        const late = vi.fn(() => new Promise<Response>(resolve => { answer = resolve; }));
        const offered = askGlobalDoorOffer(late);
        await vi.advanceTimersByTimeAsync(GLOBAL_DOOR_OFFER_TIMEOUT_MS);
        await expect(offered).resolves.toEqual({ state: 'unreachable', wordsDoor: false });
        answer({ ok: true, status: 200, json: async () => GLOBAL_OPEN } as unknown as Response);
        await vi.advanceTimersByTimeAsync(0);
        expect(globalDoorOffer().state).toBe('unreachable');
    });
});

describe('asked once per app start for an answer, and again after none', () => {
    it('keeps an open answer for the session: no second request', async () => {
        const fetchImpl = answering(GLOBAL_OPEN);
        await askGlobalDoorOffer(fetchImpl);
        await expect(stateOf(fetchImpl)).resolves.toBe('open');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('keeps a shut, preview or local answer for the session too: each was an answer, not a failure', async () => {
        const shut = answering(GLOBAL_SHUT);
        await askGlobalDoorOffer(shut);
        await expect(stateOf(answering(GLOBAL_OPEN))).resolves.toBe('closed');
        expect(shut).toHaveBeenCalledTimes(1);
        forgetGlobalDoorOffer();
        const preview = answering(GLOBAL_PREVIEW);
        await askGlobalDoorOffer(preview);
        await expect(stateOf(answering(GLOBAL_OPEN))).resolves.toBe('preview');
        expect(preview).toHaveBeenCalledTimes(1);
        forgetGlobalDoorOffer();
        await askGlobalDoorOffer(answering(LOCAL));
        await expect(stateOf(answering(GLOBAL_OPEN))).resolves.toBe('closed');
    });

    it('asks again after no answer (the screen coming back into view), and draws what it hears then', async () => {
        await expect(stateOf(offline())).resolves.toBe('unreachable');
        const back = answering(GLOBAL_OPEN);
        await expect(stateOf(back)).resolves.toBe('open');
        expect(back).toHaveBeenCalledTimes(1);
        expect(globalDoorOffer().state).toBe('open');
    });

    it('asks again after a timeout', async () => {
        vi.useFakeTimers();
        const first = askGlobalDoorOffer(neverAnswers());
        await vi.advanceTimersByTimeAsync(GLOBAL_DOOR_OFFER_TIMEOUT_MS);
        await expect(first).resolves.toEqual({ state: 'unreachable', wordsDoor: false });
        vi.useRealTimers();
        await expect(stateOf(answering(GLOBAL_PREVIEW))).resolves.toBe('preview');
    });

    it('two asks at once share one request', async () => {
        const fetchImpl = answering(GLOBAL_OPEN);
        const [a, b] = await Promise.all([askGlobalDoorOffer(fetchImpl), askGlobalDoorOffer(fetchImpl)]);
        expect([a.state, b.state]).toEqual(['open', 'open']);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

describe('a door screen\'s fresh answer replaces the kept one', () => {
    it('the door said open after the offer heard nothing: home and the sheet draw open', async () => {
        await expect(stateOf(offline())).resolves.toBe('unreachable');
        rememberGlobalDoor({ ok: true, profile: { profile: 'global', features: { openJoin: true, wordsDoor: true } } as any });
        expect(globalDoorOffer()).toEqual({ state: 'open', wordsDoor: true });
        // Kept for the session, as any answer: no ask goes out.
        const fetchImpl = answering(GLOBAL_SHUT);
        await expect(stateOf(fetchImpl)).resolves.toBe('open');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('the door said shut, or a preview, after the offer heard open', async () => {
        await askGlobalDoorOffer(answering(GLOBAL_OPEN));
        rememberGlobalDoor({ ok: false, reason: 'door_closed' });
        expect(globalDoorOffer().state).toBe('closed');
        rememberGlobalDoor({ ok: false, reason: 'private_preview' });
        expect(globalDoorOffer().state).toBe('preview');
    });

    it('the door got no answer (or threw): unreachable, asked again next time', async () => {
        await askGlobalDoorOffer(answering(GLOBAL_OPEN));
        rememberGlobalDoor(null);
        expect(globalDoorOffer().state).toBe('unreachable');
        await expect(stateOf(answering(GLOBAL_PREVIEW))).resolves.toBe('preview');
    });

    it('an offer ask still out when the door answered can never write over it', async () => {
        let answer!: (r: Response) => void;
        const slow = vi.fn(() => new Promise<Response>(resolve => { answer = resolve; }));
        const pending = askGlobalDoorOffer(slow);
        rememberGlobalDoor({ ok: false, reason: 'private_preview' });
        answer({ ok: true, status: 200, json: async () => GLOBAL_OPEN } as unknown as Response);
        await expect(pending).resolves.toEqual({ state: 'preview', wordsDoor: false });
        expect(globalDoorOffer().state).toBe('preview');
    });
});

describe('no network call blocks the first render', () => {
    it('what to draw right now is known without waiting: unknown until an answer', () => {
        expect(globalDoorOffer()).toEqual({ state: 'unknown', wordsDoor: false });
    });

    it('asking returns at once while the node has not answered, and the screen still reads unknown', () => {
        const fetchImpl = neverAnswers();
        const pending = askGlobalDoorOffer(fetchImpl);
        expect(pending).toBeInstanceOf(Promise);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(globalDoorOffer().state).toBe('unknown');
    });
});

describe('the tap-time check stays, as the second guard', () => {
    it('refuses a node that is not global at the tap, even after the offer said open', async () => {
        await expect(stateOf(answering(GLOBAL_OPEN))).resolves.toBe('open');
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
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');
    const src = () => read('app/welcome.tsx');
    /** Code only: what a comment says is not on the screen. */
    const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const home = () => {
        const s = src();
        const start = s.indexOf('// --- MAIN WELCOME SCREEN');
        const end = s.indexOf('const styles = StyleSheet.create(');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        return code(s.slice(start, end));
    };

    it('draws the two doors on every home, whatever the door said: nothing wraps them in a condition', () => {
        const h = home();
        const doors = h.match(/^( *)(.*)<WelcomeDoors door=\{globalDoor\} joinWithInvite=\{\(\) => setMode\('create'\)\} openGlobalDoor=\{openGlobalDoor\} styles=\{styles\} \/>$/m);
        expect(doors).not.toBeNull();
        // On a line of its own: no `{x && (`, no ternary, in front of it.
        expect(doors![2]).toBe('');
        expect(h.match(/<WelcomeDoors /g)).toHaveLength(1);
        // Right under the title, before the sentence about BeanPool and the rest.
        const title = h.indexOf("{t('Welcome to BeanPool')}");
        const at = h.indexOf('<WelcomeDoors ');
        expect(title).toBeGreaterThan(-1);
        expect(at).toBeGreaterThan(title);
        expect(h.slice(title, at)).not.toMatch(/<Text|<Pressable|<View/);
        for (const after of ["{t('Trade skills, goods and favours", "Clipboard.isPasteButtonAvailable", "onPress={() => setMode('member')}"]) {
            expect(h.indexOf(after), after).toBeGreaterThan(at);
        }
        // The buttons themselves are the component's alone.
        expect(h).not.toMatch(/Explore BeanPool worldwide|Join with an invite/);
        expect(src().match(/openGlobalDoor=\{openGlobalDoor\}/g)).toHaveLength(1);
    });

    it('nothing waits for the door: no fade, no pinning, no layout read for it', () => {
        const s = src();
        for (const gone of ['Animated', 'homeTop', 'offerFade', 'globalOffer', 'onLayout={(e) => { if (!global']) {
            expect(s, gone).not.toContain(gone);
        }
    });

    it('starts from what is already known, and asks the node after drawing, never before', () => {
        const s = src();
        expect(s).toMatch(/const \[globalDoor, setGlobalDoor\] = useState<GlobalDoorState>\(\(\) => globalDoorOffer\(\)\.state\);/);
        expect(s).toMatch(/askGlobalDoorOffer\(\)\.then\(offer => \{ if \(!cancelled\) setGlobalDoor\(offer\.state\); \}\);/);
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

    it('keeps the tap-time check: the door still asks fresh, refuses anything but an open global community, and its answer is what home draws next', () => {
        const s = src();
        const open = s.slice(s.indexOf('function openGlobalDoor('), s.indexOf('function leaveGlobalDoor('));
        expect(open).toMatch(/setGlobalPhase\('checking'\);\s*setMode\('globalJoin'\);/);
        const door = s.slice(s.indexOf("if (mode !== 'globalJoin' || globalPhase !== 'checking') return;"), s.indexOf('async function handleCreate('));
        expect(door).toMatch(/checkGlobalDoor\(\)/);
        expect(door).toMatch(/\.then\(check => \{\s*\/\/[^\n]*\n\s*rememberGlobalDoor\(check\);/);
        expect(door).toMatch(/\.catch\(\(\) => \{\s*rememberGlobalDoor\(null\);/);
        expect(door).toMatch(/if \(!check\.ok\) \{\s*setGlobalMessage\(GLOBAL_DOOR_MESSAGES\[check\.reason\]\);\s*setGlobalPhase\('unavailable'\);/);
    });

    it('the door screen for an account remembers its fresh answer too, so the sheet\'s row reads it on the way back', () => {
        const s = read('app/join-global.tsx');
        const door = s.slice(s.indexOf("if (phase !== 'checking') return;"), s.indexOf('// The 12-words door'));
        expect(door).toMatch(/\.then\(check => \{\s*\/\/[^\n]*\n\s*rememberGlobalDoor\(check\);/);
        expect(door).toMatch(/\.catch\(\(\) => \{\s*rememberGlobalDoor\(null\);/);
    });
});
