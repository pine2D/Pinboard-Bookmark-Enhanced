// Bookmark service protocol adapters. No DOM or storage: the worker supplies a
// dispatch-time connection guard and persists any Read Later list identity.
// API contracts: linkding.link/api and Karakeep's published /api/v1 OpenAPI.
function pbpBookmarkServiceError(code, status) {
  const error = Object.assign(new Error(code), { code });
  if (Number.isInteger(status)) error.status = status;
  return error;
}

// Contract rows: design 4.4. Only an explicit non-JSON Content-Type counts as a
// web page; a missing one stays on the non-gateway side.
function pbpBookmarkContentKind(headers) {
  const type = String(headers?.get?.("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!type) return "none";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  return type === "application/json" || type.endsWith("+json") ? "json" : "other";
}

// service: the adapter's own service. A 401/403 page names a gateway only when
// the server itself never answers that way: linkding (DRF) always rejects a
// token with JSON, so any other type is in front of it; Karakeep (Hono, no
// app.onError) rejects with plain text, so only an HTML page is a gateway.
function pbpBookmarkResponseFailure(response, phase, service) {
  const status = response.status;
  const challenged = String(response.headers?.get?.("cf-mitigated") || "").trim().toLowerCase() === "challenge";
  const kind = pbpBookmarkContentKind(response.headers);
  if (challenged) return "gateway_challenge";
  if (phase === "body") return kind === "html" || kind === "other" ? "not_api" : "invalid_response";
  if (status === 401 && /^basic(?:\s|$)/i.test(String(response.headers?.get?.("WWW-Authenticate") || "").trim())) return "gateway_basic";
  if ((status === 401 || status === 403) && (kind === "html" || (kind === "other" && service !== "karakeep"))) return "gateway_denied";
  if (status === 401 || status === 403) return "auth";
  // A reverse proxy's body-size limit (nginx client_max_body_size) refuses
  // the request before the server sees it; the same save always meets it.
  if (status === 413) return "payload_too_large";
  // Both servers answer a missing record with JSON, so a 404 web page means
  // the URL does not reach the API at all.
  if (status === 404 && kind === "html") return "not_api";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "server" : "remote";
}

function pbpBookmarkRecordId(value) {
  const id = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw pbpBookmarkServiceError("invalid_request");
  return id;
}

function pbpBookmarkWebUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch (_) { return ""; }
}

function pbpBookmarkNormalize(service, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw pbpBookmarkServiceError("invalid_response");
  let id;
  try { id = pbpBookmarkRecordId(value.id); } catch (_) { throw pbpBookmarkServiceError("invalid_response"); }
  const url = pbpBookmarkWebUrl(service === "linkding" ? value.url : value.content?.url);
  const tags = service === "linkding" ? value.tag_names : value.tags?.map(tag => tag?.name);
  if (!url || !Array.isArray(tags) || tags.some(tag => typeof tag !== "string") ||
      (service === "karakeep" && value.content?.type !== "link")) throw pbpBookmarkServiceError("invalid_response");
  return {
    id, url,
    title: typeof value.title === "string" && value.title ? value.title :
      (service === "karakeep" && typeof value.content?.title === "string" ? value.content.title : ""),
    titleFromContent: service === "karakeep" && !value.title && !!value.content?.title,
    notes: String((service === "linkding" ? value.notes : value.note) ?? ""),
    summary: String((service === "linkding" ? value.description : value.summary) ?? ""),
    tags: [...new Set(tags.filter(tag=>tag.trim()))],
    toread: service === "linkding" && value.unread === true,
    private: service !== "linkding" || value.shared !== true,
    archived: (service === "linkding" ? value.is_archived : value.archived) === true,
    time: String((service === "linkding" ? value.date_added : value.createdAt) || ""),
    // The server's own last-modified stamp, as it wrote it (linkding
    // date_modified, Karakeep modifiedAt; null when the answer has none).
    modified: (value => typeof value === "string" ? value : null)(service === "linkding" ? value.date_modified : value.modifiedAt),
    // The stamp the loaded state carries: linkding's only. Karakeep moves
    // modifiedAt when its crawler finishes the page (a couple of seconds after
    // a create, longer for a slow page; seen live 2026-11-04), which is no edit.
    versionStamp: service === "linkding" && typeof value.date_modified === "string" ? value.date_modified : null,
    nativeTags: service === "karakeep" ? value.tags.map(tag => ({id:pbpBookmarkRecordId(tag.id),name:tag.name})) : []
  };
}

// What a form loaded the bookmark as, compared before an update is sent
// (user decision 2026-11-02): linkding's last-modified stamp, plus the fields
// an update writes back: title, notes, tags and Read Later. Karakeep's
// modifiedAt is left out (user decision 2026-11-04): its crawler moves it
// with no edit, which stopped an update made just after a save. Its AI tags
// (attached without touching modifiedAt, workers/inference/tagging.ts) and
// its Read Later list are in the fields anyway. Only the server's own values:
// never a local clock. Tags, title and notes go in as digests, so the state
// stays a few dozen characters however long they are (a full tag list
// outgrew the message and draft limits and stopped every update). A title
// Karakeep took from the crawled page counts as none: the crawler fills it
// in after a save, which is no edit either. The "2"
// prefix marks this form: a cached state from before it is read again
// (pbpStatusCacheFormPosts) rather than compared.
const PBP_BOOKMARK_VERSION_FORM = "2";
function pbpBookmarkVersion(bookmark) {
  const tags = [...(bookmark?.tags || [])].sort();
  return PBP_BOOKMARK_VERSION_FORM + JSON.stringify([typeof bookmark?.versionStamp === "string" ? bookmark.versionStamp.slice(0, 64) : null,
    tags.length, pbpBookmarkTagDigest(JSON.stringify(tags)), bookmark?.toread === true,
    pbpBookmarkTagDigest(JSON.stringify([bookmark?.titleFromContent ? "" : String(bookmark?.title ?? ""), String(bookmark?.notes ?? "")]))]);
}
// Two 32-bit FNV-1a passes with different offsets: stable across workers and
// pages, synchronous, and a change to any tag changes it.
function pbpBookmarkTagDigest(text) {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193) >>> 0;
    b = (b ^ (b >>> 15)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

// The current save planner/UI consumes this projection. Provider-specific IDs
// stay in bookmark; no provider credential is ever shaped like a Pinboard key.
function pbpBookmarkAsPost(bookmark) {
  return {
    href: bookmark.url, description: bookmark.title, extended: bookmark.notes, summary: bookmark.summary,
    tags: pbpBookmarkFormatTags(bookmark.tags), tagNames:bookmark.tags.slice(), shared: bookmark.private ? "no" : "yes",
    toread: bookmark.toread ? "yes" : "no", time: bookmark.time,
    bookmarkId: bookmark.id, version: pbpBookmarkVersion(bookmark)
  };
}

function pbpCreateBookmarkServiceClient(config) {
  const {service, beforeRequest, onResponseOk, fetchImpl = globalThis.fetch} = config || {};
  const base = pbpBookmarkEndpoint(config?.baseUrl);
  if (!["karakeep", "linkding"].includes(service) || !base || typeof beforeRequest !== "function" || typeof fetchImpl !== "function") {
    throw pbpBookmarkServiceError("invalid_request");
  }
  const root = base + (service === "linkding" ? "api/" : "api/v1/");
  const listMarker = "Pinboard Bookmark Enhanced: Read Later";
  let readLaterListId = config.readLaterListId || "";
  const guard = async () => {
    const auth = await beforeRequest();
    if (!auth || typeof auth.token !== "string" || !auth.token) throw pbpBookmarkServiceError("account_changed");
    if (auth.headers !== undefined && !Array.isArray(auth.headers)) throw pbpBookmarkServiceError("invalid_request");
    return auth;
  };
  // Fire-and-forget success signal (the worker lifts an offline-queue pause);
  // never awaited, never allowed to fail the request.
  const responseOk = () => {
    if (typeof onResponseOk !== "function") return;
    try { onResponseOk(); }
    catch (error) { console.warn("[bookmark-services] onResponseOk failed:", error?.name, error?.message); }
  };
  const request = async (path, method = "GET", body) => {
    const url = new URL(path, root);
    if (!url.href.startsWith(root) || url.username || url.password || url.hash) throw pbpBookmarkServiceError("invalid_response");
    const auth = await guard();
    let response;
    try {
      // Gateway headers first, application headers last so they always win.
      const headers = new Headers();
      for (const [name, value] of auth.headers || []) headers.append(name, value);
      headers.set("Authorization", (service === "linkding" ? "Token " : "Bearer ") + auth.token);
      headers.set("Accept", "application/json");
      if (body !== undefined) headers.set("Content-Type", "application/json");
      response = await fetchImpl(url.href, {
        method, headers, ...(body === undefined ? {} : {body:JSON.stringify(body)}),
        credentials:"omit", redirect:"manual", signal:AbortSignal.timeout(20000)
      });
    } catch (error) {
      console.warn("[bookmark-services] fetch failed:", error?.name, error?.message);
      await guard();
      throw pbpBookmarkServiceError(error?.name === "TimeoutError" ? "timeout" : "network");
    }
    await guard();
    if (response.type === "opaqueredirect") throw pbpBookmarkServiceError("gateway_redirect");
    if (!response.ok) {
      const error = pbpBookmarkServiceError(pbpBookmarkResponseFailure(response, "status", service), response.status);
      // A 429's Retry-After: offline replay holds the record until then.
      const retryAfter = response.status === 429 ? pbpRetryAfterDelay(response.headers?.get?.("Retry-After")) : undefined;
      if (retryAfter !== undefined) error.retryAfter = retryAfter;
      throw error;
    }
    if (response.status === 204) { responseOk(); return {status:204, data:null}; }
    let data;
    let text;
    try { text = await response.text(); }
    catch (error) {
      // Name and message only: never the body, token or header values.
      console.warn("[bookmark-services] body read failed:", error?.name, error?.message);
      throw pbpBookmarkServiceError(error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "timeout" : pbpBookmarkResponseFailure(response, "body", service));
    }
    if (text.length > 4 * 1024 * 1024) throw pbpBookmarkServiceError("invalid_response");
    try { data = JSON.parse(text); }
    catch (error) {
      // V8's SyntaxError message quotes the start of the body, so log the name only.
      console.warn("[bookmark-services] body parse failed:", error?.name);
      throw pbpBookmarkServiceError(pbpBookmarkResponseFailure(response, "body", service));
    }
    await guard();
    responseOk();
    return {status:response.status, data};
  };
  const validList = list => list && list.type === "manual" && list.public === false &&
    list.hasCollaborators === false && list.userRole === "owner";
  // Our private manual lists, found by the marker in their description.
  const markedLists = async () => {
    const {data} = await request("lists");
    if (!Array.isArray(data?.lists)) throw pbpBookmarkServiceError("invalid_response");
    return data.lists.filter(list => validList(list) && list.description === listMarker);
  };
  // Read-only: the id of the one marked list, or "" for none or several.
  // Nothing is created, changed or stored.
  const findReadLaterList = async () => {
    if (service !== "karakeep") return "";
    const found = await markedLists();
    return found.length === 1 ? pbpBookmarkRecordId(found[0].id) : "";
  };
  const ensureReadLaterList = async create => {
    if (readLaterListId) {
      const id = pbpBookmarkRecordId(readLaterListId);
      let list;
      try { list = (await request("lists/" + id)).data; }
      catch (error) { if (error.status !== 404) throw error; }
      if (validList(list) && list.id === id) return id;
      // A deleted/public/shared list is no longer our private Read Later list.
      // Never mutate it. Retire the binding; a direct later action may create
      // a private replacement, while ordinary lookup/delete can still work.
      if (typeof config.saveReadLaterList !== "function") throw pbpBookmarkServiceError("read_later_list");
      await config.saveReadLaterList("");
      readLaterListId = "";
      await guard();
    }
    if (!create) return "";
    // More than one of ours is never guessed between; the user deletes extras.
    let list = await markedLists();
    if (list.length > 1) throw pbpBookmarkServiceError("read_later_list");
    list = list[0];
    // icon is a character Karakeep shows as-is: U+1F516, the bookmark emoji.
    if (!list) list = (await request("lists", "POST", {name:config.readLaterListName || "Read later",icon:"\u{1F516}",description:listMarker,type:"manual"})).data;
    if (!validList(list)) throw pbpBookmarkServiceError("read_later_list");
    readLaterListId = pbpBookmarkRecordId(list.id);
    if (typeof config.saveReadLaterList !== "function") throw pbpBookmarkServiceError("local_store");
    await config.saveReadLaterList(readLaterListId);
    await guard();
    return readLaterListId;
  };
  // {bookmark, metadata}: the stored bookmark (or null) and, for linkding, the
  // page's title and description as its server read them (routes.py check():
  // website_loader's WebsiteMetadata, each a string or null; null as a whole
  // when the answer carries none). Karakeep's check reads no page: null.
  const check = async url => {
    if (!pbpBookmarkWebUrl(url)) throw pbpBookmarkServiceError("invalid_request");
    if (service === "linkding") {
      const {data} = await request("bookmarks/check/?url=" + encodeURIComponent(url));
      if (!data || !Object.hasOwn(data,"bookmark")) throw pbpBookmarkServiceError("invalid_response");
      const meta = data.metadata;
      const text = value => typeof value === "string" ? value : null;
      return {bookmark:data.bookmark === null ? null : pbpBookmarkNormalize(service,data.bookmark),
        metadata:meta && typeof meta === "object" && !Array.isArray(meta) ? {title:text(meta.title),description:text(meta.description)} : null};
    }
    return {bookmark:await lookup(url), metadata:null};
  };
  const lookup = async url => {
    if (!pbpBookmarkWebUrl(url)) throw pbpBookmarkServiceError("invalid_request");
    if (service === "linkding") return (await check(url)).bookmark;
    const {data} = await request("bookmarks/check-url?url=" + encodeURIComponent(url));
    if (!data || !Object.hasOwn(data,"bookmarkId")) throw pbpBookmarkServiceError("invalid_response");
    if (data.bookmarkId === null) return null;
    const id = pbpBookmarkRecordId(data.bookmarkId);
    const bookmark = pbpBookmarkNormalize(service,(await request("bookmarks/" + id)).data);
    if (bookmark.id !== id) throw pbpBookmarkServiceError("invalid_response");
    if (readLaterListId) {
      const listId = await ensureReadLaterList(false);
      if (listId) {
        const lists = (await request("bookmarks/" + id + "/lists")).data;
        if (!Array.isArray(lists?.lists)) throw pbpBookmarkServiceError("invalid_response");
        bookmark.toread = lists.lists.some(list => list.id === listId);
      }
    }
    return bookmark;
  };
  const setReadLater = async (bookmark, enabled) => {
    const id = pbpBookmarkRecordId(bookmark.id);
    if (service === "linkding") {
      await request("bookmarks/" + id + "/", "PATCH", {unread:enabled === true});
      return true;
    }
    const listId = await ensureReadLaterList(enabled === true);
    if (!listId) return true;
    try { await request("lists/" + listId + "/bookmarks/" + id, enabled ? "PUT" : "DELETE"); }
    catch (error) {
      // The documented DELETE 400 means the membership is already absent.
      if (enabled || error.status !== 400) throw error;
    }
    return true;
  };
  // options.htmlSnapshot false: a linkding create skips the server's own HTML
  // snapshot (disable_html_snapshot), for SingleFile to upload one instead.
  const save = async (fields, existing, options = {}) => {
    if (!fields || !pbpBookmarkWebUrl(fields.url) || !Array.isArray(fields.tags) ||
        fields.tags.some(tag => typeof tag !== "string" || !tag.trim())) throw pbpBookmarkServiceError("invalid_request");
    let tags = [...new Set(fields.tags)];
    if (service === "linkding") {
      // A string Description is one the extension can vouch for (an AI summary,
      // the page's meta description or the fact it has none, the user's own
      // text); undefined means it could not tell. A new bookmark sends a known
      // one and asks linkding not to scrape; an unknown one is left to the
      // server, which then fills it in from the page itself.
      const described = typeof fields.summary === "string";
      const body = {...(existing ? {} : {url:fields.url}), title:fields.title || "", notes:fields.notes || "",tag_names:tags,
        ...(!existing ? described ? {description:pbpBookmarkDescriptionText(fields.summary)} : {}
          // The reader shows a stored Description as one line, the popup with
          // its line breaks (shared.js pbpBookmarkDescriptionChanged), so a
          // multi-line value the user left alone is never flattened, and only
          // the text the user saw is written.
          : described && pbpBookmarkDescriptionChanged(fields.summary, existing.summary)
            ? {description:pbpBookmarkDescriptionText(fields.summary)} : {}),
        ...(typeof fields.toread === "boolean" ? {unread:fields.toread} : {}),
        ...(!existing ? {shared:config.sharingEnabled === true && fields.sharedExplicit === true && fields.private === false}
          : config.sharingEnabled === true && fields.sharedExplicit === true && typeof fields.private === "boolean" && fields.private !== existing.private ? {shared:!fields.private} : {})};
      let data;
      try {
        const query = [...(described ? ["disable_scraping"] : []), ...(options.htmlSnapshot === false ? ["disable_html_snapshot"] : [])];
        ({data} = await request(existing ? "bookmarks/" + pbpBookmarkRecordId(existing.id) + "/"
          : "bookmarks/" + (query.length ? "?" + query.join("&") : ""), existing ? "PATCH" : "POST", body));
      } catch (error) {
        // Django answers PostgreSQL's DataError with a 500: with a tag longer
        // than linkding's column that is the rejection, so name the tag and
        // retry nothing. A proxy's 502/503/504 (linkding restarting) never
        // reached the database and SQLite stores long tags: still "server".
        const tag = error?.code === "server" && error.status === 500 ? pbpLinkdingOverlongTag(tags) : "";
        if (tag) throw Object.assign(pbpBookmarkServiceError("tag_too_long", error.status), {tag});
        // Only a create sends the address. A 400 for one the URL column or
        // Django's URLValidator cannot take fails the same way every time.
        if (!existing && error?.code === "remote" && error.status === 400 && pbpLinkdingUrlRejected(fields.url)) {
          throw pbpBookmarkServiceError("url_invalid", error.status);
        }
        throw error;
      }
      const bookmark = pbpBookmarkNormalize(service,data);
      const added = Date.parse(data.date_added), modified = Date.parse(data.date_modified);
      // linkding also returns 201 when POST merges an existing URL. Compare
      // server timestamps only, so that record never receives a deletion undo.
      const merged = Number.isFinite(added) && Number.isFinite(modified) && modified - added > 2000;
      return {status:"saved",bookmark,mutation:existing ? "updated" : merged ? "merged" : "created"};
    }
    let bookmark = existing, step = "bookmark", mutation = existing ? "updated" : "created";
    try {
      if (!bookmark) {
        const created = await request("bookmarks", "POST", {type:"link",url:fields.url,
          ...(fields.title ? {title:fields.title} : {}), ...(fields.notes ? {note:fields.notes} : {}),source:"extension"});
        bookmark = pbpBookmarkNormalize(service,created.data);
        // A concurrent create is already merged by Karakeep 0.34.1: supplied
        // title/note replace the old values, archived is reset, createdAt is
        // refreshed. Preserve its tags and continue the Read Later operation.
        if (created.status === 200) {
          mutation = "merged";
          if (typeof config.alignCreatedTags === "function") tags = config.alignCreatedTags(tags, bookmark);
        }
      }
      if (existing) {
        const id = pbpBookmarkRecordId(bookmark.id);
        const keepCrawledTitle = existing.titleFromContent && fields.title === existing.title;
        const {data} = await request("bookmarks/" + id,"PATCH",{
          ...(!keepCrawledTitle ? {title:fields.title || ""} : {}),note:fields.notes || ""});
        if (!data || data.id !== id) throw pbpBookmarkServiceError("invalid_response");
        bookmark = {...bookmark,title:fields.title || "",notes:fields.notes || ""};
      }
      step = "tags";
      const present = bookmark.nativeTags || [];
      const add = tags.filter(name => !present.some(tag => tag.name === name));
      // Legacy servers can contain blank tag names. Hide them in the form, but
      // a normal metadata edit must not remove those remote associations.
      const remove = mutation === "merged" ? [] : present.filter(tag => tag.name.trim() && !tags.includes(tag.name));
      if (add.length) await request("bookmarks/" + bookmark.id + "/tags", "POST", {tags:add.map(tagName=>({tagName}))});
      if (remove.length) await request("bookmarks/" + bookmark.id + "/tags", "DELETE", {tags:remove.map(tag=>({tagId:tag.id}))});
      bookmark = {...bookmark,tags:mutation === "merged" ? [...new Set([...bookmark.tags,...tags])] : tags};
      step = "read_later";
      if (typeof fields.toread === "boolean" && fields.toread !== bookmark.toread) {
        await setReadLater(bookmark,fields.toread);
        bookmark = {...bookmark,toread:fields.toread};
      }
      return {status:"saved",bookmark,mutation};
    } catch (error) {
      if (["account_changed", "conflict"].includes(error.code) || !bookmark) throw error;
      return {status:"partial",bookmark,mutation,failedStep:step,error:error.code || "remote",httpStatus:error.status};
    }
  };
  // linkding's DRF `next` is built from the request as the server saw it, so
  // behind a TLS-terminating or host-rewriting proxy it carries another scheme
  // or host. Only its path and two integers are trusted; the request is
  // rebuilt under the configured root so nothing is ever sent elsewhere.
  const linkdingNext = (data, dir) => {
    const next = data?.next;
    if (next === null || next === undefined || next === "") return "";
    if (typeof next !== "string") throw pbpBookmarkServiceError("invalid_response");
    let url;
    try { url = new URL(next); } catch { throw pbpBookmarkServiceError("invalid_response"); }
    if (url.pathname !== new URL(dir, root).pathname) throw pbpBookmarkServiceError("invalid_response");
    const readInt = name => {
      const value = url.searchParams.get(name);
      return value !== null && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
    };
    const offset = readInt("offset");
    const pageSize = readInt("limit");
    if (!Number.isInteger(offset) || !Number.isInteger(pageSize) || pageSize < 1) throw pbpBookmarkServiceError("invalid_response");
    return dir + "?limit=" + pageSize + "&offset=" + offset;
  };
  const pages = async (path, readRows, nextPage, limit = 10000, warnOnCap = false) => {
    const rows = [];
    const seen = new Set();
    while (path) {
      if (seen.has(path) || seen.size >= 100) throw pbpBookmarkServiceError("pagination_limit");
      seen.add(path);
      const {data} = await request(path);
      const page = readRows(data);
      if (!Array.isArray(page)) throw pbpBookmarkServiceError("invalid_response");
      rows.push(...page);
      if (rows.length >= limit) {
        // Full already: do not read or validate a next that will not be requested.
        // Count only: never the names.
        if (warnOnCap && (rows.length > limit || data?.next || data?.nextCursor)) console.warn("[bookmark-services] result capped at " + limit + " rows");
        return rows.slice(0,limit);
      }
      const following = nextPage(data);
      if (following && typeof following !== "string") throw pbpBookmarkServiceError("invalid_response");
      path = following;
    }
    return rows;
  };
  const tags = async () => {
    const rows = service === "linkding"
      ? await pages("tags/?limit=1000",data=>data?.results,data=>linkdingNext(data,"tags/"),10000,true)
      : await pages("tags?limit=1000",data=>data?.tags,data=>data.nextCursor ? "tags?limit=1000&cursor=" + encodeURIComponent(data.nextCursor) : "");
    if (!Array.isArray(rows) || rows.some(tag=>typeof tag?.name !== "string")) throw pbpBookmarkServiceError("invalid_response");
    const seen = new Set();
    return rows.filter(tag=>{
      if (!tag.name.trim() || seen.has(tag.name)) return false;
      seen.add(tag.name);
      return true;
    }).map(tag=>({name:tag.name,count:service === "karakeep" ? tag.numBookmarks : 0}));
  };
  const recent = async (limit = 5) => {
    limit = Math.max(1,Math.min(100,Number(limit)||5));
    if (service === "linkding") {
      const rows = await pages("bookmarks/?limit=" + limit,data=>data?.results,data=>linkdingNext(data,"bookmarks/"),limit);
      return rows.map(row=>pbpBookmarkNormalize(service,row));
    }
    // Karakeep filters non-link types after paging, so a page can come back short.
    // Top up from the next pages, at most 3 requests (3 x limit rows fetched).
    // archived=false: archived bookmarks are not "recent", as in linkding and Karakeep's home.
    const links = [];
    let path = "bookmarks?archived=false&limit=" + limit;
    for (let page = 0; path && page < 3 && links.length < limit; page++) {
      const {data} = await request(path);
      if (!Array.isArray(data?.bookmarks)) throw pbpBookmarkServiceError("invalid_response");
      links.push(...data.bookmarks.filter(row=>row.content?.type === "link" && row.archived !== true));
      if (data.nextCursor && typeof data.nextCursor !== "string") throw pbpBookmarkServiceError("invalid_response");
      path = data.nextCursor ? "bookmarks?archived=false&limit=" + limit + "&cursor=" + encodeURIComponent(data.nextCursor) : "";
    }
    return links.slice(0,limit).map(row=>pbpBookmarkNormalize(service,row));
  };
  return {
    lookup, check, save, tags, recent, setReadLater, findReadLaterList,
    async verify() {
      const {data} = await request(service === "linkding" ? "user/profile/" : "users/me");
      if (!data || typeof data !== "object" || Array.isArray(data) ||
          (service === "karakeep" && typeof data.id !== "string") || (service === "linkding" && typeof data.theme !== "string")) throw pbpBookmarkServiceError("invalid_response");
      return {id:service === "karakeep" ? pbpBookmarkRecordId(data.id) : "",label:service === "karakeep" ? String(data.name || "") : "linkding",
        ...(service === "linkding" ? {sharing:data.enable_sharing === true} : {})};
    },
    async remove(bookmark) {
      await request("bookmarks/" + pbpBookmarkRecordId(bookmark.id) + (service === "linkding" ? "/" : ""),"DELETE");
      return true;
    }
  };
}
