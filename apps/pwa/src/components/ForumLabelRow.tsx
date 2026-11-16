import { useEffect, useState } from 'react';
import { FORUM_LABEL_WORDS, forumLabelWhyLine, forumWriterLine, t, type ForumLabelChoice, type ForumLabelState } from '@beanpool/core';
import { findListedCommunities, readForumLabel, setForumLabel, type DirectoryPick } from '../lib/forum-label';

/**
 * Settings → Legal & Privacy on the worldwide community: what shows beside the member's name on its forum (slice F10 apps;
 * DESIGN-forums-fable.md §12; lib/forum-label.ts). Three choices: Don't show · their community · I'm waiting to join one. The
 * community is picked from the directory by name; its note is asked of that community and handed to the forum. A tap applies
 * at once; a refusal is said under the choices and changes nothing. Shown only where the forum is public (SettingsPage), and
 * only once the forum has answered what is chosen now.
 */
export function ForumLabelRow({ myName }: { myName: string }) {
    const [state, setState] = useState<ForumLabelState | null>(null);
    const [picking, setPicking] = useState(false);
    const [q, setQ] = useState('');
    const [found, setFound] = useState<DirectoryPick[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        void readForumLabel().then((s) => { if (alive) setState(s); });
        return () => { alive = false; };
    }, []);
    useEffect(() => {
        const asked = q.trim();
        if (!picking || asked.length < 2) { setFound(null); return; }
        let alive = true;
        const timer = setTimeout(() => void findListedCommunities(asked).then((rows) => { if (alive) setFound(rows); }), 300);
        return () => { alive = false; clearTimeout(timer); };
    }, [picking, q]);

    if (!state) return null;

    async function choose(choice: ForumLabelChoice) {
        setBusy(true);
        setError(null);
        const done = await setForumLabel(choice);
        setBusy(false);
        if (!done.ok) { setError(done.error); return; }
        setState(done.state);
        setPicking(false);
        setQ('');
    }

    const options: Array<{ show: ForumLabelState['show']; label: string; onPick: () => void }> = [
        { show: 'none', label: t(FORUM_LABEL_WORDS.none), onPick: () => { setPicking(false); void choose({ show: 'none' }); } },
        { show: 'community', label: state.community?.name ?? t(FORUM_LABEL_WORDS.pick), onPick: () => setPicking(true) },
        { show: 'waiting', label: t(FORUM_LABEL_WORDS.waiting), onPick: () => { setPicking(false); void choose({ show: 'waiting' }); } },
    ];
    const why = forumLabelWhyLine(state);

    return (
        <div className="p-4" data-testid="settings-forum-label">
            <span className="block text-text-primary font-bold text-[15px]">🏷️ <>{t(FORUM_LABEL_WORDS.title)}</></span>
            <span className="block text-text-muted text-[12px] mt-0.5">{t(FORUM_LABEL_WORDS.hint)}</span>
            <div role="radiogroup" aria-label={t(FORUM_LABEL_WORDS.title)} className="mt-3 space-y-1.5">
                {options.map((o) => {
                    const selected = state.show === o.show;
                    return (
                        <button key={o.show} type="button" role="radio" aria-checked={selected} disabled={busy} onClick={o.onPick}
                            data-testid={`forum-label-${o.show}`}
                            className={`w-full min-h-[48px] flex items-center gap-2.5 px-3 py-2 rounded-xl border-2 text-left cursor-pointer transition-colors ${selected
                                ? 'border-nature-900 dark:border-white bg-nature-100 dark:bg-nature-800'
                                : 'border-nature-200 dark:border-nature-800 bg-transparent'}`}>
                            <span className="flex-1 min-w-0 text-[14px] leading-tight font-bold text-nature-900 dark:text-white break-words">{o.label}</span>
                            <span aria-hidden="true" className="shrink-0 w-4 text-center text-base font-bold text-nature-900 dark:text-white">{selected ? '✓' : ''}</span>
                        </button>
                    );
                })}
            </div>
            {picking && (
                <div className="mt-2 space-y-1.5" data-testid="forum-label-picker">
                    <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t(FORUM_LABEL_WORDS.find)} aria-label={t(FORUM_LABEL_WORDS.find)}
                        autoFocus className="w-full min-h-[44px] px-3 rounded-xl border border-nature-200 dark:border-nature-700 bg-transparent text-text-primary text-[14px]" />
                    {found?.length === 0 && <p className="m-0 px-1 text-[12px] text-text-muted">{t(FORUM_LABEL_WORDS.noMatch)}</p>}
                    {found?.map((c) => (
                        <button key={c.key} type="button" disabled={busy} onClick={() => void choose({ show: 'community', address: c.url })}
                            className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-nature-200 dark:border-nature-800 bg-transparent text-left text-[14px] font-semibold text-text-primary break-words cursor-pointer">
                            {c.name}
                        </button>
                    ))}
                </div>
            )}
            {busy && <p className="m-0 mt-2 text-[12px] text-text-muted" role="status">{t(FORUM_LABEL_WORDS.asking)}</p>}
            {(error ?? why) && <p className="m-0 mt-2 text-[12px] font-semibold text-text-primary" role="alert">{error ?? why}</p>}
            {state.label && myName && (
                <p className="m-0 mt-2 text-[12px] text-text-muted" data-testid="forum-label-shown">{t(FORUM_LABEL_WORDS.shown, { line: forumWriterLine({ name: myName, label: state.label }, myName) })}</p>
            )}
        </div>
    );
}
