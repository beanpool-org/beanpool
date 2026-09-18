/**
 * Address search for the event form's location section. The lookup itself (Nominatim request, 1 s debounce,
 * abort, 1 req/s floor, cache) is @beanpool/core's createAddressLookup, the same one the settings app's node
 * location search uses. The browser sends its own Referer, which is how Nominatim's policy lets a web app
 * identify itself (a page cannot set User-Agent).
 *
 * The search text and the member's IP go to OpenStreetMap, as the settings app's already do. Tapping the map and
 * "My location" never depend on it: a failed search says so in one line and the pin picker carries on.
 */
import { useEffect, useRef, useState } from 'react';
import { createAddressLookup, type AddressLookup, type AddressLookupState, type AddressResult } from '@beanpool/core';

interface AddressSearchProps {
    onPick: (result: AddressResult) => void;
}

export function AddressSearch({ onPick }: AddressSearchProps) {
    const [query, setQuery] = useState('');
    const [state, setState] = useState<AddressLookupState>({ status: 'idle', query: '', results: [] });
    const [open, setOpen] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const lookupRef = useRef<AddressLookup | null>(null);

    useEffect(() => {
        const lookup = createAddressLookup({
            onState: (s) => {
                setState(s);
                if (s.status === 'done') setOpen(true);
            },
        });
        lookupRef.current = lookup;
        return () => { lookup.dispose(); lookupRef.current = null; };
    }, []);

    const results = state.status === 'done' ? state.results : [];
    const showList = open && results.length > 0;

    const pick = (item: AddressResult) => {
        lookupRef.current?.cancel();
        setQuery(item.displayName);
        setOpen(false);
        setSelectedIndex(-1);
        onPick(item);
    };

    return (
        <div className="mb-3" data-testid="event-address-search">
            <label htmlFor="event-address" className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">
                Find an address
            </label>
            <div className="relative">
                <input
                    id="event-address"
                    type="search"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={showList}
                    aria-controls="event-address-results"
                    aria-activedescendant={showList && selectedIndex >= 0 ? `event-address-result-${selectedIndex}` : undefined}
                    enterKeyHint="search"
                    autoComplete="off"
                    placeholder="Street and town, or a place"
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setSelectedIndex(-1);
                        lookupRef.current?.input(e.target.value);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            if (showList && selectedIndex >= 0 && selectedIndex < results.length) pick(results[selectedIndex]);
                            else lookupRef.current?.submit(query);
                        } else if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            if (showList) setSelectedIndex((prev) => (prev + 1) % results.length);
                        } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            if (showList) setSelectedIndex((prev) => (prev <= 0 ? results.length - 1 : prev - 1));
                        } else if (e.key === 'Escape') {
                            setOpen(false);
                            setSelectedIndex(-1);
                        }
                    }}
                    className="w-full py-3 pl-4 pr-10 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-violet-300 shadow-sm transition-all border-nature-200 dark:border-nature-700"
                />
                {state.status === 'searching' && (
                    <span aria-hidden="true" className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 border-violet-300 border-t-violet-600 animate-spin" />
                )}
            </div>
            <p role="status" aria-live="polite" className="m-0">
                {state.status === 'searching' && <span className="sr-only">Searching…</span>}
                {state.status === 'error' && (
                    <span className="block mt-1 text-xs font-semibold text-red-600 dark:text-red-400">
                        Address search isn&apos;t working right now. Tap the map or use My location.
                    </span>
                )}
                {state.status === 'done' && open && results.length === 0 && (
                    <span className="block mt-1 text-xs text-nature-600 dark:text-nature-300">
                        No matches. Try a street and town, or drop a pin.
                    </span>
                )}
            </p>
            {showList && (
                <ul
                    id="event-address-results"
                    role="listbox"
                    aria-label="Address matches"
                    className="list-none m-0 mt-1 p-0 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 divide-y divide-nature-100 dark:divide-nature-700 overflow-hidden"
                >
                    {results.map((item, idx) => (
                        <li
                            key={`${item.lat},${item.lng},${idx}`}
                            id={`event-address-result-${idx}`}
                            role="option"
                            aria-selected={selectedIndex === idx}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pick(item)}
                            className={`min-h-[48px] px-3 py-2 cursor-pointer text-sm ${selectedIndex === idx ? 'bg-violet-50 dark:bg-violet-950/40' : 'hover:bg-nature-50 dark:hover:bg-nature-700'}`}
                        >
                            <div className="font-semibold text-nature-900 dark:text-white break-words">{item.shortName || item.displayName}</div>
                            <div className="text-xs text-nature-500 dark:text-nature-400 line-clamp-2 break-words">{item.displayName}</div>
                        </li>
                    ))}
                </ul>
            )}
            <p className="m-0 mt-1 text-[11px] text-nature-500 dark:text-nature-400">
                Addresses from OpenStreetMap. What you type here is sent to them.
            </p>
        </div>
    );
}
