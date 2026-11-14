import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TagPicker } from '../src/components/TagPicker';
import '../src/index.css';

// The web Tags field with this community's typed tags fed in (slice F3): nothing here talks to a node.
const q = new URLSearchParams(window.location.search);
if (q.get('dark') === '1') document.documentElement.classList.add('dark', 'dark-theme');
else document.documentElement.classList.remove('dark', 'dark-theme');

const USED = [
    { tag: 'handmade', listings: 12 }, { tag: 'hand tools', listings: 3 }, { tag: 'handed down from my grandmother', listings: 1 },
    { tag: 'limones', listings: 0, mergeInto: 'food.fruit.lemon' },
];
const load = () => Promise.resolve(USED);

function Harness() {
    const [tags, setTags] = useState<string[]>(['garden.produce']);
    const [freeTags, setFreeTags] = useState<string[]>(['2nd hand']);
    return (
        <div className="w-[320px] max-w-[320px] min-h-screen p-4 bg-nature-50 dark:bg-nature-950 text-nature-900 dark:text-nature-100 box-border">
            <TagPicker value={tags} onChange={setTags} freeTags={freeTags} onFreeTagsChange={setFreeTags} category="food" title="Meyer Lemons" communityTags={load} />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
