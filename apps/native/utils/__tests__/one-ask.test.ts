/**
 * One tap, one ask (max re-check of #3340): a fast double tap on First steps' notifications line or the tool screen's
 * Allow asked the phone twice, and Android put its last pop-up straight after the first. utils/one-ask.ts is the join
 * screen's `answering` for those two taps; both screens ask through it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { oneAskAtATime } from '../one-ask';

/** An ask the test answers by hand, as the phone's pop-up is answered. */
function popUp() {
    const asks: ((answer: string) => void)[] = [];
    const ask = () => new Promise<string>((resolve) => { asks.push(resolve); });
    return { asks, ask };
}

describe('one tap, one ask', () => {
    it('a second tap while the pop-up is out asks nothing; the next tap after its answer asks again', async () => {
        const once = oneAskAtATime();
        const phone = popUp();
        const first = once(phone.ask);
        const second = once(phone.ask);
        expect(phone.asks).toHaveLength(1);
        expect(await second).toBeUndefined();
        phone.asks[0]('denied');
        expect(await first).toBe('denied');
        const third = once(phone.ask);
        expect(phone.asks).toHaveLength(2);
        phone.asks[1]('granted');
        expect(await third).toBe('granted');
    });

    it('an ask that fails lets the next tap ask again', async () => {
        const once = oneAskAtATime();
        await expect(once(async () => { throw new Error('no activity'); })).rejects.toThrow('no activity');
        expect(await once(async () => 'granted')).toBe('granted');
    });

    it('each screen has its own: a tap on one is no wait on the other', async () => {
        const home = oneAskAtATime();
        const tool = oneAskAtATime();
        const phone = popUp();
        void home(phone.ask);
        void tool(phone.ask);
        expect(phone.asks).toHaveLength(2);
    });

    it("First steps' line and the tool screen's Allow both ask through it", () => {
        const root = path.resolve(__dirname, '..', '..');
        const home = fs.readFileSync(path.join(root, 'app/(tabs)/index.tsx'), 'utf8');
        expect(home).toContain('const notifyAsk = useRef(oneAskAtATime()).current;');
        expect(home).toMatch(/else if \(step === 'notify'\) \{\s*void notifyAsk\(\(\) => turnOnNotifications\(/);
        const tool = fs.readFileSync(path.join(root, 'app/tool/[id].tsx'), 'utf8');
        expect(tool).toContain('const notifyAsk = useRef(oneAskAtATime()).current;');
        expect(tool).toMatch(/const allowNotifications = useCallback\(\(\) => notifyAsk\(async \(\) => \{\s*try \{\s*const \{ turnOnNotifications \}/);
    });
});
