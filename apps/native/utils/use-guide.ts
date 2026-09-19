import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getBundledGuide, loadLocalGuide, refreshGuideFromWebsite, type LoadedGuide } from './guide';

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

/** The members' guide: the bundled copy at once, then the cached or a newer website copy when there is one. */
export function useGuide(): LoadedGuide {
    const [loaded, setLoaded] = useState<LoadedGuide>(() => sessionGuide ?? { guide: getBundledGuide(), source: 'bundled' });
    useEffect(() => {
        listeners.add(setLoaded);
        if (sessionGuide) setLoaded(sessionGuide);
        startRefresh().catch(() => { /* keep what is on screen */ });
        return () => { listeners.delete(setLoaded); };
    }, []);
    return loaded;
}
