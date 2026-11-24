// SW-only tag governance: the list response supplies URLs, never write payloads.
// Pinboard has no conditional update API; the shared save transaction prevents
// this extension's saves from entering the lookup-to-write window. Other clients
// can still change a bookmark between these two server requests.
/**
 * @param {{ account?: string, url?: string, oldTag?: string, newTag?: string }} [opts]
 */
function pbpRetagPinboardPost({ account, url, oldTag, newTag } = {}) {
  return runSaveDeliveryTransaction(async () => {
    const failed = (error, httpStatus) => ({ status: httpStatus === 429 ? "rate_limited" : "failed", error, httpStatus });
    if (typeof account !== "string" || !account || typeof url !== "string" || !url
        || typeof oldTag !== "string" || !oldTag || typeof newTag !== "string" || !newTag) {
      return failed("invalid_retag_request");
    }
    const currentAuth = async () => {
      const auth = await getCurrentBookmarkAuth();
      if (auth.service !== "pinboard" || !auth.token || auth.account !== account) {
        throw Object.assign(new Error("account_changed"), { code: "account_changed" });
      }
      return auth;
    };
    let auth = await currentAuth();
    const response = await pinboardFetch(`https://api.pinboard.in/v1/posts/get?auth_token=${encodeURIComponent(auth.token)}&format=json&url=${encodeURIComponent(url)}`);
    if (!response.ok) return failed("lookup_http", response.status);
    const data = await response.json();
    await currentAuth();
    if (!data || typeof data !== "object" || !Array.isArray(data.posts)) return failed("invalid_lookup");
    if (data.posts.length === 0) return { status: "unchanged" };
    const post = data.posts[0];
    // Never infer defaults from a partial/error response: doing so would replace
    // private/unread flags or erase notes. Exact href prevents URL alias writes.
    if (data.posts.length !== 1 || !post || post.href !== url
        || !["description", "extended", "tags", "time"].every(key => typeof post[key] === "string")
        || !post.time || !Number.isFinite(Date.parse(post.time))
        || !["yes", "no"].includes(post.shared) || !["yes", "no"].includes(post.toread)) return failed("invalid_lookup");
    const tags = post.tags.split(/\s+/).filter(Boolean);
    const oldLower = oldTag.toLowerCase();
    if (!tags.some(tag => tag.toLowerCase() === oldLower)) return { status: "unchanged" };
    const seen = new Set(), next = [];
    for (const tag of tags) {
      const replacement = tag.toLowerCase() === oldLower ? newTag : tag;
      const key = replacement.toLowerCase();
      if (!seen.has(key)) { seen.add(key); next.push(replacement); }
    }
    auth = await currentAuth();
    const uri = buildPostsAddUri({ token: auth.token, url, title: post.description,
      extended: post.extended, tags: next.join(" "), shared: post.shared,
      toread: post.toread, dt: post.time });
    if (uri.length > POSTS_ADD_URI_BUDGET) return { status: "too_large" };
    const saved = await pinboardFetch(uri);
    await currentAuth();
    if (!saved.ok) return failed("write_http", saved.status);
    const result = await saved.json();
    if (result?.result_code !== "done") return failed(String(result?.result_code || "invalid_write_response"));
    // A tag edit invalidates the cached full row before the next lookup.
    statusCache.delete(url);
    return { status: "saved" };
  });
}
