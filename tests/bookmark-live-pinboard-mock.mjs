// In-process Pinboard v1 mock for tests/bookmark-live-preflight-tests.mjs.
// The runner never imports it: a run reaches it only through
// main(argv, { pinboard: { transport, intervalMs, mock: true } }).
//
// Shapes are hand-written from the public API documentation
// (https://pinboard.in/api, read 2026-11-02) in their format=json form, as
// the extension's own parsers read them; nothing here is built from the
// request it answers beyond the stored fields:
//   posts/add     {"result_code":"done"}; replace=no on a stored URL answers
//                 {"result_code":"item already exists"} (the docs only say
//                 "will throw an error"; the extension matches /already exists/)
//   posts/delete  {"result_code":"done"} | {"result_code":"item not found"}
//   posts/get     {"date","user","posts":[{href, description, extended, meta,
//                 hash, time, shared, toread, tags}]} (shared/toread "yes"|"no",
//                 tags one space-separated string); an unknown URL gives posts []
//                 and tags come back with " & < > as entities (seen live
//                 2026-11-04); a tag stored literally as X&quot;y therefore
//                 reads X&amp;quot;y
//   posts/all     with format=json a bare array of the same post objects;
//                 ?tag=<name> lists the posts carrying exactly that stored tag
//                 (hand-written from the live facts, not measured: whether the
//                 real endpoint matches a literal-entity stored name is what
//                 the entity-repair live module measures)
//   tags/get      {"<tag>": count, ...} over the whole account, names verbatim
//                 as stored; a freshly created tag holding a literal entity is
//                 seen live to be missing for a while (entityTagLagMs)
//   user/api_token {"result":"<hex>"}
//   a bad token   HTTP 401 with an HTML body; rate limiting HTTP 429 (HTML)
//   anything else HTTP 404 (HTML)
import { createHash, randomBytes } from 'node:crypto';

const ENTITY_TAG = /&(?:quot|amp|lt|gt|#39);/;
export const PINBOARD_MOCK_ROOT = 'https://api.pinboard.in/v1/';

// latencyMs delays every answer, as the real service does (a few hundred ms),
// for the rehearsal at the real 3 s interval.
// entityTagLagMs: how long after a post was saved a tag holding a literal
// entity code (&quot; &amp; &lt; &gt; &#39;) stays out of tags/get; Infinity
// = never listed. seed() puts a post of the user's own in the account.
export function createPinboardMock({ token, user = String(token || '').split(':')[0], libraryTags = { personal: 3, reading: 1 }, now = () => new Date(), latencyMs = 0, entityTagLagMs = 0 } = {}) {
  const hex = String(token || '').split(':')[1] || '';
  const posts = new Map();
  const calls = [];
  const state = { rateLimitNext: 0 };
  const html = (status, title) => ({ status, contentType: 'text/html; charset=utf-8', body: `<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>` });
  const json = body => ({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
  const stamp = () => now().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tagCounts = () => {
    const counts = { ...libraryTags };
    for (const post of posts.values()) {
      for (const tag of post.tags.split(' ').filter(Boolean)) {
        if (ENTITY_TAG.test(tag) && Date.now() - (post.savedAt || 0) < entityTagLagMs) continue;
        counts[tag] = (counts[tag] || 0) + 1;
      }
    }
    return counts;
  };
  // The read side's spelling of a stored tag string, as seen live: " & < >
  // become entities (so a stored literal &quot; reads &amp;quot;).
  const encodeTags = tags => tags.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const readPost = p => { const { savedAt, ...rest } = p; return { ...rest, tags: encodeTags(p.tags) }; };
  const yesNo = (value, fallback) => (value === 'yes' || value === 'no' ? value : fallback);

  function handle(raw) {
    const url = new URL(raw);
    const path = url.pathname.startsWith('/v1/') ? url.pathname.slice(4).replace(/\/+$/, '') : '';
    const q = url.searchParams;
    calls.push({ path, at: Date.now(), url: q.get('url') || '' });
    if (url.origin + '/v1/' !== PINBOARD_MOCK_ROOT || !path) return html(404, '404 Not Found');
    if (state.rateLimitNext > 0) { state.rateLimitNext--; return html(429, '429 Too Many Requests'); }
    if (q.get('auth_token') !== token) return html(401, '401 Unauthorized');
    switch (path) {
      case 'posts/get': {
        const target = q.get('url');
        const list = target ? (posts.has(target) ? [posts.get(target)] : []) : [...posts.values()].slice(-1);
        // Observed live 2026-11-04: posts/get answers " & < > inside tags as
        // entities (titles and notes come back verbatim).
        return json({ date: list[0]?.time || stamp(), user, posts: list.map(readPost) });
      }
      case 'posts/all': {
        const wanted = q.get('tag');
        const list = [...posts.values()].filter(p => !wanted || p.tags.split(' ').includes(wanted)).map(readPost);
        return json(q.get('meta') === 'no' ? list.map(({ meta, ...rest }) => rest) : list);
      }
      case 'posts/add': {
        const target = q.get('url');
        if (!target) return json({ result_code: 'missing url' });
        if (q.get('replace') === 'no' && posts.has(target)) return json({ result_code: 'item already exists' });
        const before = posts.get(target);
        posts.set(target, {
          href: target, description: q.get('description') || '', extended: q.get('extended') || '',
          meta: randomBytes(16).toString('hex'), hash: createHash('md5').update(target).digest('hex'),
          time: q.get('dt') || before?.time || stamp(), shared: yesNo(q.get('shared'), 'yes'), toread: yesNo(q.get('toread'), 'no'),
          tags: String(q.get('tags') || '').split(/\s+/).filter(Boolean).join(' '), savedAt: Date.now(),
        });
        return json({ result_code: 'done' });
      }
      case 'posts/delete': {
        const target = q.get('url');
        if (!posts.has(target)) return json({ result_code: 'item not found' });
        posts.delete(target);
        return json({ result_code: 'done' });
      }
      case 'tags/get': return json(tagCounts());
      case 'user/api_token': return json({ result: hex.toUpperCase() });
      default: return html(404, '404 Not Found');
    }
  }

  return {
    posts, calls, state,
    // The runner's transport contract: async (url) -> { status, contentType, body }.
    transport: async url => { if (latencyMs > 0) await new Promise(r => setTimeout(r, latencyMs)); return handle(url); },
    rateLimit(n) { state.rateLimitNext = n; },
    // A post of the user's own (old enough for every lag), tags stored as given.
    seed({ url, description = 'seeded', extended = '', tags = '', shared = 'no', toread = 'no' }) {
      posts.set(url, { href: url, description, extended, meta: randomBytes(16).toString('hex'), hash: createHash('md5').update(url).digest('hex'), time: '2020-01-01T00:00:00Z', shared, toread, tags, savedAt: 0 });
    },
  };
}
