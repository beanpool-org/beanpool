/**
 * Hand `link` to the browser's own share sheet where there is one, and copy it where there is not (components/SharePost.tsx,
 * components/InviteAndShare.tsx): 'shared', 'copied', 'cancelled' (they closed the sheet) or 'failed'.
 */
export async function handOver(title: string, link: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (typeof nav.share === 'function') {
        try {
            await nav.share({ title, text: title, url: link });
            return 'shared';
        } catch (e) {
            if ((e as Error)?.name === 'AbortError') return 'cancelled';
        }
    }
    try {
        await navigator.clipboard.writeText(link);
        return 'copied';
    } catch {
        const el = document.createElement('textarea');
        el.value = link;
        document.body.appendChild(el);
        el.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        document.body.removeChild(el);
        return ok ? 'copied' : 'failed';
    }
}
