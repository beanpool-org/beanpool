/**
 * The showcase render tests' press loop: every button on screen, pressed once, and each time a press opens the 🏘️
 * Local community sheet, every one of the sheet's own buttons, the sheet opened afresh by that same press for each, its
 * scrim's Close last. Review of #1852, finding 3: pressed in DOM order the scrim's Close came first and shut the sheet,
 * and a key of label and text took the sheet's Start for the strip's, so no sheet's Start or Near you was ever pressed.
 *
 *   const { pressed, sheetPresses } = await pressEverything(host, press, { key: b => `${b.getAttribute('aria-label')}:${b.textContent}` });
 *
 * `key` says which buttons count as the same one (an element, or its label and text when the screen draws it anew);
 * `skip` leaves a button out (the strip's ✕, pressed last by the test).
 */
const SHEET = '[data-testid="local-community-sheet"]';

export async function pressEverything(
    host: HTMLElement,
    press: (el: Element) => Promise<void>,
    { key, skip, limit = 300 }: { key: (b: Element) => unknown; skip?: (b: Element) => boolean; limit?: number },
): Promise<{ pressed: Set<unknown>; sheetPresses: string[] }> {
    const sheetModal = () => host.querySelector(SHEET)?.closest('[data-modal]') ?? null;
    /** The open sheet's buttons: its own first, in order, then the scrim's Close. */
    const sheetButtons = () => {
        const modal = sheetModal();
        if (!modal) return [];
        const all = Array.from(modal.querySelectorAll('button'));
        const own = all.filter(b => b.closest(SHEET));
        return [...own, ...all.filter(b => !own.includes(b))];
    };
    const screenButtons = () => {
        const modal = sheetModal();
        return Array.from(host.querySelectorAll('button')).filter(b => !(modal && modal.contains(b)) && !skip?.(b));
    };
    const pressed = new Set<unknown>();
    const sheetPresses: string[] = [];
    for (let i = 0; i < limit; i++) {
        const next = screenButtons().find(b => !pressed.has(key(b)));
        if (!next) break;
        const k = key(next);
        pressed.add(k);
        await press(next);
        const count = sheetButtons().length;
        for (let j = 0; j < count; j++) {
            if (!sheetModal()) {
                const again = screenButtons().find(b => key(b) === k);
                if (!again) break;
                await press(again);
            }
            const b = sheetButtons()[j];
            if (!b) break;
            sheetPresses.push(`${String(k)} → ${b.getAttribute('aria-label') ?? b.textContent}`);
            await press(b);
        }
        // Never leave a sheet open over the next press.
        if (sheetModal()) await press(sheetButtons().pop()!);
    }
    return { pressed, sheetPresses };
}
