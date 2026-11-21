# Wikimedia Commons answers (test-commons-pictures.ts)

Real answers from `https://commons.wikimedia.org/w/api.php` (action=query, prop=imageinfo|categories,
iiprop=url|size|mime|extmetadata, iiurlwidth=960), captured 22 Nov 2026 by the director for the Learn web pictures design
(scratch/fable-design/DESIGN-learn-web-pictures-fable.md §9 slice 2). Trimmed to the fields the node reads: each page's title,
`imageinfo` (size, mime, the 960 px copy's address and size, the original's address, the file page) with the extmetadata keys
LicenseShortName, License, LicenseUrl, AttributionRequired, Artist, UsageTerms, Restrictions, Categories, Copyrighted, NonFree,
and `categories`. Nothing else is changed: the licence table is pinned to these strings, never to strings from the docs.

| File | LicenseShortName | License | In | Expected |
|---|---|---|---|---|
| Roughtail rock agama (Stellagama stellio brachydactyla).jpg | CC BY-SA 4.0 | cc-by-sa-4.0 | batch1.json | taken |
| Sanderling Westkapelle 02.jpg | CC BY 4.0 | cc-by-4.0 | batch1.json | taken (no `categories`: the answer's `continue.clcontinue` cut them; extmetadata Categories still lists them) |
| Kartagina Apoloninove terme.jpg, Kartagina amfiteater.jpg | CC0 | cc0 | cc0.json | taken |
| Przełęcz Karkonoska - panorama.jpg (PD-self) | Public domain | pd | batch1.json | taken |
| "A Russian Honeymoon" … LCCN2006682502.jpg (PD-old-100) | Public domain | pd | batch1.json | taken |
| "Hundreaaorsnotti", Bolette C. Pavels Larsen, 1997.ogg | CC BY-SA 3.0 | cc-by-sa-3.0 | batch1.json | refused: 3.0, not a still picture (application/ogg), and up for deletion ("Category:Deletion requests November 2026") |

Commons hosts no non-commercial file (they are deleted), so the suite's non-commercial, no-derivatives, GFDL and
disagreeing rows are made up there and labelled synthetic.
