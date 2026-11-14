/**
 * The forum's search on the phone (slice F6; scratch/fable-design/DESIGN-forums-fable.md §8): the node's route as it is
 * (apps/server/src/routes/forum.ts GET /api/forum/search, engine/forum-search.ts), the shape it answers, as the web app reads
 * it (apps/pwa/src/lib/forum.ts searchForum). Its own file, beside slice F3's utils/forum.ts, so the two build apart.
 *
 * Every word typed must be found, newest first, 20 a page; never a post the member may not read. Each call is one of the
 * member's 100 searches a day: the node refuses past them with 429 `searches_per_day`, in the member's language. Nothing is
 * kept on the phone: a search is asked when the member presses Search, and its hits live as long as the screen does.
 */
import { signedRequestWithMethod } from './db';

export interface ForumSearchWriter { publicKey: string; name: string }
/** A hit: the post, its topic's title ('' for a topic its writer removed, its replies kept), its words around the find. */
export interface ForumSearchHit {
    topicId: string; sectionId: string; title: string; postId: string; number: number; writer: ForumSearchWriter; createdAt: string; excerpt: string;
}
export interface ForumSearchPage { hits: ForumSearchHit[]; next: number | null }

/** One page of a search, from `offset`; refused with the node's words, `status` and `code` (db.ts signedRequestWithMethod). */
export function searchForum(q: string, offset = 0): Promise<ForumSearchPage> {
    return signedRequestWithMethod('GET', `/api/forum/search?q=${encodeURIComponent(q)}${offset ? `&offset=${offset}` : ''}`, undefined, { withStatus: true });
}
