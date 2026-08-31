import { normaliseChannelInput } from './src/engine/creator-channels.js';
const cases: [string,string][] = [
  ['instagram','https://www.instagram.com/P/Cxyz123/'],
  ['instagram','https://www.instagram.com/Reel/xyz/'],
  ['instagram','https://www.instagram.com/Stories/someone/123/'],
  ['facebook','https://www.facebook.com/Groups/1234567/'],
  ['facebook','https://www.facebook.com/Share/p/AbCd/'],
  ['facebook','https://www.facebook.com/People/Some-Name/6155/'],
  ['website','https://example.com/x?utm_source=a'],
  ['rss','https://example.com/?utm_source=a'],
  ['youtube','https://www.youtube.com/@Foo/videos'],
  ['instagram','https://www.instagram.com/Mullum/tagged/'],
];
for (const [p, raw] of cases) {
  try { const r = normaliseChannelInput(p as any, raw); console.log(`OK  ${p} ${raw} -> ${r.url} | ${r.handle}`); }
  catch (e: any) { console.log(`ERR ${p} ${raw} -> ${e.code}`); }
}
