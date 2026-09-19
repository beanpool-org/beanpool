import { useEffect, useState } from 'react';
import { fetchPulseFeed } from './pulse';
import { learnVideosFromFeed, type LearnVideo } from './guide';

// The videos in this community's Pulse → Learn lane, for the guide's "Watch" links. Videos are extra: a guide page
// is complete without one, so this never blocks a page and an empty list (offline, no community) just hides the link.
// Asked for once per session, when the first guide page opens. Each item keeps its `source`: findGuideVideo only
// links BeanPool's own (curated) videos, never an item a member's channel added to Learn.
let videos: LearnVideo[] | null = null;
let pending: Promise<LearnVideo[]> | null = null;

async function loadLearnVideos(): Promise<LearnVideo[]> {
    if (videos) return videos;
    pending ??= fetchPulseFeed({ category: 'learn', limit: 50 })
        .then(res => learnVideosFromFeed(res.items))
        .catch(() => [] as LearnVideo[])
        .then(list => {
            // An empty answer is not remembered, so a page opened later (back online) can try again.
            if (list.length > 0) videos = list;
            pending = null;
            return list;
        });
    return pending;
}

export function useLearnVideos(): LearnVideo[] {
    const [list, setList] = useState<LearnVideo[]>(() => videos ?? []);
    useEffect(() => {
        let alive = true;
        loadLearnVideos().then(v => { if (alive) setList(v); }).catch(() => {});
        return () => { alive = false; };
    }, []);
    return list;
}
