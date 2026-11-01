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
  return type === "application/json" || type.endsWith("+json") ? "json" : "other";
}

function pbpBookmarkResponseFailure(response, phase) {
  const status = response.status;
  const challenged = String(response.headers?.get?.("cf-mitigated") || "").trim().toLowerCase() === "challenge";
  const kind = pbpBookmarkContentKind(response.headers);
  if (challenged) return "gateway_challenge";
  if (phase === "body") return kind === "other" ? "not_api" : "invalid_response";
  if (status === 401 && /^basic(?:\s|$)/i.test(String(response.headers?.get?.("WWW-Authenticate") || "").trim())) return "gateway_basic";
  if ((status === 401 || status === 403) && kind === "other") return "gateway_denied";
  if (status === 401 || status === 403) return "auth";
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
    nativeTags: service === "karakeep" ? value.tags.map(tag => ({id:pbpBookmarkRecordId(tag.id),name:tag.name})) : []
  };
}

// The current save planner/UI consumes this projection. Provider-specific IDs
// stay in bookmark; no provider credential is ever shaped like a Pinboard key.
function pbpBookmarkAsPost(bookmark) {
  return {
    href: bookmark.url, description: bookmark.title, extended: bookmark.notes, summary: bookmark.summary,
    tags: pbpBookmarkFormatTags(bookmark.tags), tagNames:bookmark.tags.slice(), shared: bookmark.private ? "no" : "yes",
    toread: bookmark.toread ? "yes" : "no", time: bookmark.time,
    bookmarkId: bookmark.id
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
    if (!response.ok) throw pbpBookmarkServiceError(pbpBookmarkResponseFailure(response, "status"), response.status);
    if (response.status === 204) { responseOk(); return {status:204, data:null}; }
    let data;
    let text;
    try { text = await response.text(); }
    catch (error) {
      // Name and message only: never the body, token or header values.
      console.warn("[bookmark-services] body read failed:", error?.name, error?.message);
      throw pbpBookmarkServiceError(error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "timeout" : pbpBookmarkResponseFailure(response, "body"));
    }
    if (text.length > 4 * 1024 * 1024) throw pbpBookmarkServiceError("invalid_response");
    try { data = JSON.parse(text); }
    catch (error) {
      // V8's SyntaxError message quotes the start of the body, so log the name only.
      console.warn("[bookmark-services] body parse failed:", error?.name);
      throw pbpBookmarkServiceError(pbpBookmarkResponseFailure(response, "body"));
    }
    await guard();
    responseOk();
    return {status:response.status, data};
  };
  const validList = list => list && list.type === "manual" && list.public === false &&
    list.hasCollaborators === false && list.userRole === "owner";
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
    const {data} = await request("lists");
    if (!Array.isArray(data?.lists)) throw pbpBookmarkServiceError("invalid_response");
    const candidates = data.lists.filter(list => validList(list) && list.description === listMarker);
    if (candidates.length > 1) throw pbpBookmarkServiceError("read_later_list");
    let list = candidates[0];
    if (!list) list = (await request("lists", "POST", {name:config.readLaterListName || "Read later",icon:"bookmark",description:listMarker,type:"manual"})).data;
    if (!validList(list)) throw pbpBookmarkServiceError("read_later_list");
    readLaterListId = pbpBookmarkRecordId(list.id);
    if (typeof config.saveReadLaterList !== "function") throw pbpBookmarkServiceError("local_store");
    await config.saveReadLaterList(readLaterListId);
    await guard();
    return readLaterListId;
  };
  const lookup = async url => {
    if (!pbpBookmarkWebUrl(url)) throw pbpBookmarkServiceError("invalid_request");
    if (service === "linkding") {
      const {data} = await request("bookmarks/check/?url=" + encodeURIComponent(url));
      if (!data || !Object.hasOwn(data,"bookmark")) throw pbpBookmarkServiceError("invalid_response");
      return data.bookmark === null ? null : pbpBookmarkNormalize(service,data.bookmark);
    }
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
  const save = async (fields, existing) => {
    if (!fields || !pbpBookmarkWebUrl(fields.url) || !Array.isArray(fields.tags) ||
        fields.tags.some(tag => typeof tag !== "string" || !tag.trim())) throw pbpBookmarkServiceError("invalid_request");
    let tags = [...new Set(fields.tags)];
    if (service === "linkding") {
      const body = {...(existing ? {} : {url:fields.url}), title:fields.title || "", notes:fields.notes || "",tag_names:tags,
        ...(!existing ? {description:fields.summary ?? ""}
          // The popup and reader show a stored Description as one line. Compare
          // that line, so a multi-line value the user left alone is never
          // flattened, and write only the line the user saw.
          : typeof fields.summary === "string"
            && pbpBookmarkDescriptionLine(fields.summary) !== pbpBookmarkDescriptionLine(existing.summary)
            ? {description:pbpBookmarkDescriptionLine(fields.summary)} : {}),
        ...(typeof fields.toread === "boolean" ? {unread:fields.toread} : {}),
        ...(!existing ? {shared:config.sharingEnabled === true && fields.sharedExplicit === true && fields.private === false}
          : config.sharingEnabled === true && fields.sharedExplicit === true && typeof fields.private === "boolean" && fields.private !== existing.private ? {shared:!fields.private} : {})};
      const {data} = await request(existing ? "bookmarks/" + pbpBookmarkRecordId(existing.id) + "/" : "bookmarks/?disable_scraping", existing ? "PATCH" : "POST", body);
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
  const pages = async (path, readRows, nextPage, limit = 10000) => {
    const rows = [];
    const seen = new Set();
    while (path) {
      if (seen.has(path) || seen.size >= 100) throw pbpBookmarkServiceError("pagination_limit");
      seen.add(path);
      const {data} = await request(path);
      const page = readRows(data);
      if (!Array.isArray(page)) throw pbpBookmarkServiceError("invalid_response");
      rows.push(...page);
      if (rows.length >= limit) return rows.slice(0,limit);
      path = nextPage(data);
      if (path && typeof path !== "string") throw pbpBookmarkServiceError("invalid_response");
    }
    return rows;
  };
  const tags = async () => {
    const rows = service === "linkding"
      ? await pages("tags/?limit=100",data=>data?.results,data=>data.next)
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
    const rows = service === "linkding"
      ? await pages("bookmarks/?limit=" + limit,data=>data?.results,data=>data.next,limit)
      : await pages("bookmarks?limit=" + limit,data=>data?.bookmarks,data=>data.nextCursor ? "bookmarks?limit=" + limit + "&cursor=" + encodeURIComponent(data.nextCursor) : "",limit);
    return rows.filter(row=>service === "linkding" || row.content?.type === "link").map(row=>pbpBookmarkNormalize(service,row));
  };
  return {
    lookup, save, tags, recent, setReadLater,
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
