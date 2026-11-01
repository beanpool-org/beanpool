import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TagPicker } from '../src/components/TagPicker';
import '../src/index.css';

const q = new URLSearchParams(window.location.search);
if (q.get('dark') === '1') document.documentElement.classList.add('dark', 'dark-theme');
else document.documentElement.classList.remove('dark', 'dark-theme');

function TagPickerHarness() {
    const [tags, setTags] = useState<string[]>(['food.fruit.lemon', 'garden.produce']);
    const [freeTags, setFreeTags] = useState<string[]>(['2nd hand']);
    const view = q.get('view') || 'row';
    const [submits, setSubmits] = useState(0);
    const [pageEscapes, setPageEscapes] = useState(0);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPageEscapes((n) => n + 1); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // As the map's New Post panel is drawn (MapPage.tsx map-new-post-panel), with the enterprise form's <form> round the picker.
    if (view === 'panel') {
        return (
            <div data-testid="panel" className="fixed bottom-2 left-3 right-3 z-[1000] max-h-[60vh] overflow-y-auto backdrop-blur-xl bg-white/80 dark:bg-nature-900/80 rounded-2xl p-4">
                <form onSubmit={(e) => { e.preventDefault(); setSubmits((n) => n + 1); }}>
                    <input aria-label="Title" defaultValue="Meyer Lemons" className="w-full mb-2 border" />
                    <TagPicker value={tags} onChange={setTags} freeTags={freeTags} onFreeTagsChange={setFreeTags} category="food" title="Meyer Lemons" />
                    <button type="submit">Publish</button>
                </form>
                <output data-testid="counts">{`${submits} ${pageEscapes}`}</output>
            </div>
        );
    }

    return (
        <div className="w-[320px] max-w-[320px] min-h-screen p-4 bg-nature-50 dark:bg-nature-950 text-nature-900 dark:text-nature-100 box-border">
            <h1 className="text-base font-semibold mb-2">New Listing</h1>
            <div className="p-3 bg-white dark:bg-nature-900 rounded-lg border border-nature-200 dark:border-nature-800 shadow-sm space-y-3">
                <div>
                    <label className="text-xs font-medium text-nature-600 dark:text-nature-400 block mb-1">Title</label>
                    <div className="p-2 border border-nature-300 dark:border-nature-700 rounded text-sm">Meyer Lemons & Rosemary</div>
                </div>
                <div>
                    <label className="text-xs font-medium text-nature-600 dark:text-nature-400 block mb-1">Category</label>
                    <div className="p-2 border border-nature-300 dark:border-nature-700 rounded text-sm">Food & Drink</div>
                </div>
                <TagPicker
                    value={tags}
                    onChange={setTags}
                    category="food"
                    title="Meyer Lemons & Rosemary"
                    description="Fresh homegrown organic lemons and sprigs of rosemary."
                />
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<TagPickerHarness />);
