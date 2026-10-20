import { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getBundledGuide, guideInLanguage, loadLocalGuide, refreshGuideFromWebsite, type LoadedGuide } from './guide';
import { guideTitlesFor } from './guide-titles';
import { useWords } from '../components/LanguageProvider';

// Shared by the BeanPool sheet and every guide page it opens. The website is checked when the sheet opens,
// at most once every 10 minutes, so a member who opened it offline gets the newer copy later in the session.
const RECHECK_MS = 10 * 60 * 1000;
let sessionGuide: LoadedGuide | null = null;
let lastCheckAt = 0;
const listeners = new Set<(g: LoadedGuide) => void>();

function publish(next: LoadedGuide) {
    sessionGuide = next;
    listeners.forEach(l => l(next));
}

async function startRefresh() {
    if (Date.now() - lastCheckAt < RECHECK_MS) return;
    lastCheckAt = Date.now();
    const local = await loadLocalGuide(AsyncStorage);
    if (!sessionGuide || local.guide.version > sessionGuide.guide.version) publish(local);
    const remote = await refreshGuideFromWebsite(local.guide, AsyncStorage, fetch);
    if (remote) publish({ guide: remote, source: 'website' });
}

/**
 * The members' guide: the bundled copy at once, then the cached or a newer website copy when there is one; its titles,
 * summaries and help lines in the member's language wherever that language's titles file (bundled: utils/guide-titles.ts)
 * has a current translation, else English (core's guideInLanguage). Re-renders when the member picks another language.
 */
export function useGuide(): LoadedGuide {
    const [loaded, setLoaded] = useState<LoadedGuide>(() => sessionGuide ?? { guide: getBundledGuide(), source: 'bundled' });
    const { lang } = useWords();
    useEffect(() => {
        listeners.add(setLoaded);
        if (sessionGuide) setLoaded(sessionGuide);
        startRefresh().catch(() => { /* keep what is on screen */ });
        return () => { listeners.delete(setLoaded); };
    }, []);
    return useMemo(() => {
        let titles: unknown = null;
        try { titles = guideTitlesFor(lang); } catch { /* the English titles */ }
        return { ...loaded, guide: guideInLanguage(loaded.guide, lang, titles) };
    }, [loaded, lang]);
}
