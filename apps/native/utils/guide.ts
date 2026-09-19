// The members' guide and manual in the app ("BeanPool: help and how it works").
//
// One source: packages/beanpool-guide/content. Its build writes the guide.json bundled here, the SAME file the web
// app bundles, and the same bytes to beanpool.org/guide/guide.json. The logic (validation, the offline copy, the
// website update, search, related pages, Learn videos) is shared with the web app in @beanpool/core member-guide.ts;
// this file only adds the copy built into this app.

import bundledGuide from '@beanpool/guide/generated/guide.json';
import { validateGuide, type Guide } from '@beanpool/core';

export {
    GUIDE_SCHEMA, GUIDE_URL, GUIDE_CACHE_KEY, GUIDE_SLUGS, GUIDE_ABOUT_SECTION,
    validateGuide, newerGuide, refreshGuideFromWebsite, findGuidePage, findGuideSection, sectionPages,
    manualSections, relatedPages, splitBold, searchGuide, findGuideVideo,
    BEANPOOL_WEBSITE_URL, beanPoolSettingsEntries, beanPoolSheetEntries,
} from '@beanpool/core';
export type {
    Guide, GuidePage, GuideSection, GuideBlock, GuideSource, LoadedGuide, GuideStorage, GuideSearchResult, LearnVideo,
} from '@beanpool/core';
import { loadLocalGuide as loadLocal, type GuideStorage, type LoadedGuide } from '@beanpool/core';

const BUNDLED = validateGuide(bundledGuide);

/** The copy shipped inside this build of the app. */
export function getBundledGuide(): Guide {
    // The package's own tests validate this file, and this app's tests validate it with this function.
    if (!BUNDLED) throw new Error('The bundled members\' guide is invalid');
    return BUNDLED;
}

/** Bundled copy, or the cached website copy when that is newer. Never throws, never touches the network. */
export function loadLocalGuide(storage: GuideStorage, bundled: Guide = getBundledGuide()): Promise<LoadedGuide> {
    return loadLocal(storage, bundled);
}
