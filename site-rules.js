// ============================================================
// Pinboard Bookmark Enhanced — Site-specific extraction rules
// ============================================================
// Injected (with vendor/defuddle.js) into the active tab's ISOLATED world by
// popup.js extractLocalMarkdown(). Runs BEFORE Defuddle: a matching rule returns
// clean { contentHtml, title } that reuses the existing Turndown path; no match
// (or empty content) → caller falls back to Defuddle.
//
// Self-contained: no imports, DOM-only. Exposes globals SITE_RULES / matchRule /
// applySiteRule so the injected inline func (page context) can call them.
// Adding a site = push one { id, match, extract }. Keep selectors here so markup
// drift is localized; per-rule smoke tests live in md-convert-tests.html.

(function () {
  "use strict";

  // ---- shared helpers ----------------------------------------------------

  function readEntities(doc) {
    try {
      var el = doc.getElementById("js-initialData");
      if (!el) return {};
      var data = JSON.parse(el.textContent || "{}");
      return (data.initialState && data.initialState.entities) || {};
    } catch (_) { return {}; }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Zhihu lazy-loads images: real URL in data-original / data-actualsrc / data-src. Promote
  // to src so markdown keeps them. Operates on a DETACHED node (never the live DOM).
  function fixLazyImages(root) {
    if (!root || !root.querySelectorAll) return root;
    root.querySelectorAll("img").forEach(function (img) {
      var real = img.getAttribute("data-original") || img.getAttribute("data-actualsrc") || img.getAttribute("data-src");
      var cur = img.getAttribute("src") || "";
      if (real && (!cur || cur.indexOf("data:") === 0)) img.setAttribute("src", real);
      img.removeAttribute("data-original");
      img.removeAttribute("data-actualsrc");
      img.removeAttribute("data-src");
    });
    return root;
  }

  // Parse an HTML string into a detached div, fix lazy images, return innerHTML.
  function cleanBodyHtml(doc, html) {
    if (!html) return "";
    var tmp = doc.createElement("div");
    tmp.innerHTML = html;
    fixLazyImages(tmp);
    return tmp.innerHTML;
  }

  // Return the first JSON-LD graph node whose @type matches (string or in an array of @type).
  function readJsonLd(doc, type) {
    var nodes = doc.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < nodes.length; i++) {
      var data;
      try { data = JSON.parse(nodes[i].textContent || "null"); } catch (_) { continue; }
      var arr = Array.isArray(data) ? data : (data && Array.isArray(data["@graph"]) ? data["@graph"] : [data]);
      for (var j = 0; j < arr.length; j++) {
        var t = arr[j] && arr[j]["@type"];
        if (t === type || (Array.isArray(t) && t.indexOf(type) !== -1)) return arr[j];
      }
    }
    return null;
  }

  function pickText(doc, picks) {
    for (var i = 0; i < (picks || []).length; i++) {
      var p = picks[i];
      if (Array.isArray(p)) { var el = doc.querySelector(p[0]); if (el) { var v = el.getAttribute(p[1]); if (v) return v.trim(); } }
      else { var e2 = doc.querySelector(p); if (e2 && e2.textContent.trim()) return e2.textContent.trim(); }
    }
    return "";
  }

  function answerSection(author, voteup, permalink, bodyHtml) {
    var head = "<h2>" + escapeHtml(author || "匿名用户") + "</h2>";
    var meta = "<p>" + escapeHtml(String(voteup || 0) + " 赞同") +
      (permalink ? ' · <a href="' + escapeHtml(permalink) + '">链接</a>' : "") + "</p>";
    return head + meta + (bodyHtml || "");
  }

  // Parse a Zhihu vote count from text / aria-label: "赞同 430" -> 430, "1.2万" -> 12000.
  function parseCount(s) {
    s = String(s == null ? "" : s);
    var m = s.match(/([\d.]+)\s*万/);
    if (m) return Math.round(parseFloat(m[1]) * 10000);
    m = s.match(/([\d.]+)\s*[kK]/);
    if (m) return Math.round(parseFloat(m[1]) * 1000);
    m = s.match(/(\d[\d,]*)/);
    return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
  }

  // Vote count from a js-initialData answer entity. Zhihu normalizes API fields to
  // camelCase (voteupCount); tolerate api/v4 snake_case (voteup_count) too.
  function entVoteup(ans) {
    if (!ans) return 0;
    var v = (ans.voteupCount != null) ? ans.voteupCount : ans.voteup_count;
    return Number(v) || 0;
  }

  // Vote count from a rendered card/doc — the up-vote button (down = VoteButton--down).
  // DOM fallback for lazy-loaded answers that aren't in js-initialData.
  function domVoteup(root) {
    if (!root || !root.querySelector) return 0;
    var btn = root.querySelector(".VoteButton:not(.VoteButton--down)");
    if (!btn) return 0;
    return parseCount(btn.getAttribute("aria-label") || btn.textContent);
  }

  // ---- Zhihu: zhuanlan article (zhuanlan.zhihu.com/p/{id}) ---------------

  function extractZhihuArticle(doc, url) {
    var id = (url.match(/\/p\/(\d+)/) || [])[1];
    var ent = readEntities(doc);
    var title = "", html = "";
    var art = id && ent.articles && ent.articles[id];
    if (art) { title = art.title || ""; html = art.content || ""; }
    if (!html) {
      var node = doc.querySelector(".Post-RichText") || doc.querySelector(".RichText.ztext");
      if (node) html = node.innerHTML;
    }
    if (!title) {
      var tEl = doc.querySelector(".Post-Title") || doc.querySelector("h1");
      if (tEl) title = tEl.textContent.trim();
    }
    var contentHtml = cleanBodyHtml(doc, html);
    if (!contentHtml) return null;
    return { contentHtml: contentHtml, title: title || doc.title };
  }

  // ---- Zhihu: question title / detail helpers ---------------------------

  function questionTitle(doc, qid, ent) {
    var q = qid && ent.questions && ent.questions[qid];
    if (q && q.title) return q.title;
    var el = doc.querySelector(".QuestionHeader-title");
    return el ? el.textContent.trim() : doc.title;
  }

  function questionDetailHtml(doc, qid, ent) {
    var q = qid && ent.questions && ent.questions[qid];
    var html = (q && q.detail) || "";
    if (!html) {
      var el = doc.querySelector(".QuestionRichText .RichText.ztext") ||
               doc.querySelector(".QuestionHeader-detail");
      if (el) html = el.innerHTML;
    }
    return cleanBodyHtml(doc, html);
  }

  // ---- Zhihu: single answer permalink (/question/{q}/answer/{a}) ---------

  function extractZhihuAnswer(doc, url) {
    var m = url.match(/\/question\/(\d+)\/answer\/(\d+)/) || [];
    var qid = m[1], aid = m[2];
    var ent = readEntities(doc);
    var ans = aid && ent.answers && ent.answers[aid];
    var bodyHtml = "", author = "", voteup = 0;
    if (ans) { bodyHtml = ans.content || ""; author = (ans.author && ans.author.name) || ""; voteup = entVoteup(ans); }
    if (!bodyHtml) {
      var node = doc.querySelector(".RichText.ztext");
      if (node) bodyHtml = node.innerHTML;
    }
    if (!author) {
      var aEl = doc.querySelector(".AuthorInfo-name") || doc.querySelector(".AuthorInfo .UserLink-link");
      if (aEl) author = aEl.textContent.trim();
    }
    if (!voteup) voteup = domVoteup(doc);
    var body = cleanBodyHtml(doc, bodyHtml);
    if (!body) return null;
    var permalink = (qid && aid) ? "https://www.zhihu.com/question/" + qid + "/answer/" + aid : url;
    return { contentHtml: answerSection(author, voteup, permalink, body), title: questionTitle(doc, qid, ent) };
  }

  // ---- Zhihu: question page, all currently-loaded answers ----------------

  function extractZhihuQuestion(doc, url) {
    var qid = (url.match(/\/question\/(\d+)/) || [])[1];
    var ent = readEntities(doc);
    var sections = [];
    var seen = {};

    function pushAnswer(aid, author, voteup, bodyHtml) {
      bodyHtml = (typeof bodyHtml === "string") ? bodyHtml : "";
      if (!bodyHtml) return;
      // No-aid fallback key includes length to avoid collisions between two
      // same-author answers that share their first 40 chars.
      var key = aid || (author + ":" + bodyHtml.length + ":" + bodyHtml.slice(0, 40));
      if (seen[key]) return;
      seen[key] = 1;
      var permalink = (qid && aid) ? "https://www.zhihu.com/question/" + qid + "/answer/" + aid : "";
      sections.push(answerSection(author, voteup, permalink, cleanBodyHtml(doc, bodyHtml)));
    }

    // Source 1: rendered DOM cards in display (sort) order, enriched by initialData.
    var cards = doc.querySelectorAll(".List-item .ContentItem.AnswerItem, .ContentItem.AnswerItem");
    cards.forEach(function (card) {
      var aid = card.getAttribute("name") || "";
      var ans = aid && ent.answers && ent.answers[aid];
      var bodyHtml = "", author = "", voteup = 0;
      if (ans) { bodyHtml = ans.content || ""; author = (ans.author && ans.author.name) || ""; voteup = entVoteup(ans); }
      if (!bodyHtml) { var node = card.querySelector(".RichText.ztext"); if (node) bodyHtml = node.innerHTML; }
      if (!author) { var aEl = card.querySelector(".AuthorInfo-name") || card.querySelector(".AuthorInfo .UserLink-link"); if (aEl) author = aEl.textContent.trim(); }
      if (!voteup) voteup = domVoteup(card);
      pushAnswer(aid, author, voteup, bodyHtml);
    });

    // Source 2: initialData answers with no matching DOM card (keeps the full batch).
    if (ent.answers) {
      Object.keys(ent.answers).forEach(function (aid) {
        if (seen[aid]) return;
        var ans = ent.answers[aid];
        if (!ans || !ans.content) return;
        pushAnswer(aid, (ans.author && ans.author.name) || "", entVoteup(ans), ans.content);
      });
    }

    if (!sections.length) return null;

    var note = "";
    if (!ent.answers || !Object.keys(ent.answers).length) {
      note = "<blockquote><p>" +
        escapeHtml("注：仅提取到当前页面已加载/可见的回答；登录并向下滚动加载更多回答后再导出可获取更多。") +
        "</p></blockquote>";
    }
    var detail = questionDetailHtml(doc, qid, ent);
    return { contentHtml: note + (detail || "") + sections.join("\n"), title: questionTitle(doc, qid, ent) };
  }

  // ---- StackOverflow / StackExchange (JSON-LD QAPage; DOM fallback) ------
  function extractStackOverflow(doc) {
    var qa = readJsonLd(doc, "QAPage");
    var main = qa && qa.mainEntity;
    var title = (main && (main.name || qa.name)) || pickText(doc, ["h1[itemprop=name]", "h1 .question-hyperlink", "h1"]);
    var parts = [];
    if (main && main.text) parts.push(cleanBodyHtml(doc, main.text));
    var answers = [];
    if (main) {
      if (main.acceptedAnswer) [].push.apply(answers, [].concat(main.acceptedAnswer).map(function (a) { return { a: a, accepted: true }; }));
      if (main.suggestedAnswer) [].push.apply(answers, [].concat(main.suggestedAnswer).map(function (a) { return { a: a, accepted: false }; }));
    }
    if (answers.length) {
      parts.push("<h2>" + escapeHtml(answers.length + " Answers") + "</h2>");
      answers.forEach(function (x) {
        var votes = x.a.upvoteCount != null ? x.a.upvoteCount + " votes" : "answer";
        parts.push("<h3>" + escapeHtml((x.accepted ? "[accepted] " : "") + votes) + "</h3>" + cleanBodyHtml(doc, x.a.text || ""));
      });
    }
    // DOM fallback per-section: question if JSON-LD lacked its body, answers if
    // JSON-LD carried none (a sparse QAPage can have the question but no answers).
    if (!main || !main.text) {
      var q = doc.querySelector("#question .s-prose.js-post-body");
      if (q) parts.unshift(cleanBodyHtml(doc, q.innerHTML));
    }
    if (!answers.length) {
      doc.querySelectorAll("#answers .answer").forEach(function (ans) {
        var body = ans.querySelector(".s-prose.js-post-body");
        var vc = ans.querySelector(".js-vote-count");
        var acc = ans.classList.contains("accepted-answer") || ans.querySelector(".js-accepted-answer-indicator");
        if (body) parts.push("<h3>" + escapeHtml((acc ? "[accepted] " : "") + (vc ? vc.textContent.trim() + " votes" : "")) + "</h3>" + cleanBodyHtml(doc, body.innerHTML));
      });
    }
    if (!parts.join("")) return null;
    return { contentHtml: parts.join("\n"), title: title };
  }

  // ---- V2EX (topic + threaded replies) ----------------------------------
  function extractV2ex(doc) {
    var title = pickText(doc, ["h1"]);
    var parts = [];
    var topic = doc.querySelector(".topic_content");
    if (topic) parts.push(cleanBodyHtml(doc, topic.innerHTML));
    doc.querySelectorAll(".subtle .topic_content").forEach(function (ap) { parts.push(cleanBodyHtml(doc, ap.innerHTML)); });
    var replies = doc.querySelectorAll('.cell[id^="r_"]');
    if (replies.length) {
      parts.push("<h2>" + escapeHtml("回复 (" + replies.length + ")") + "</h2>");
      replies.forEach(function (cell) {
        var author = pickText({ querySelector: function (s) { return cell.querySelector(s); } }, ["a[href^='/member/']", "strong a", "a.dark"]);
        var floor = (cell.querySelector(".no") || {}).textContent || "";
        var thanks = (cell.querySelector(".small.fade") || {}).textContent || "";
        var body = cell.querySelector(".reply_content");
        var head = "<p><strong>" + escapeHtml("#" + floor.trim() + " · " + (author || "匿名")) +
          (thanks.trim() ? escapeHtml(" · 感谢 " + thanks.trim()) : "") + "</strong></p>";
        if (body) parts.push(head + cleanBodyHtml(doc, body.innerHTML));
      });
    }
    if (!parts.join("")) return null;
    var pages = doc.querySelectorAll("#Main .box .inner .page_normal, #Main .box .inner .page_current");
    var note = "";
    if (pages.length > 1) note = "<blockquote><p>" + escapeHtml("注：仅提取当前页回复（共 " + pages.length + " 页）。") + "</p></blockquote>";
    return { contentHtml: note + parts.join("\n"), title: title };
  }

  // ---- arXiv (/abs/ citation_* meta card) -------------------------------
  function extractArxiv(doc) {
    function metas(name) { return Array.prototype.map.call(doc.querySelectorAll('meta[name="' + name + '"]'), function (m) { return m.getAttribute("content") || ""; }).filter(Boolean); }
    var title = (metas("citation_title")[0]) || pickText(doc, ["h1.title", "h1"]);
    var authors = metas("citation_author");
    var abs = metas("citation_abstract")[0] || pickText(doc, ["blockquote.abstract"]);
    var pdf = metas("citation_pdf_url")[0] || "";
    if (!abs && !authors.length) return null;
    var html = "";
    if (authors.length) html += "<p><strong>" + escapeHtml(authors.join(", ")) + "</strong></p>";
    if (abs) html += "<p>" + escapeHtml(abs) + "</p>";
    if (pdf) html += '<p><a href="' + escapeHtml(pdf) + '">PDF</a></p>';
    return { contentHtml: html, title: title };
  }

  // ---- framework ---------------------------------------------------------

  function hostMatches(pattern, hostname) {
    return hostname === pattern || hostname.endsWith("." + pattern);
  }

  function matchRule(m, doc, url) {
    if (!m) return false;
    var hostname;
    try { hostname = new URL(url).hostname; } catch (_) { return false; }
    if (m.host && !hostMatches(m.host, hostname)) return false;       // cheap first
    if (m.url && !m.url.test(url)) return false;                       // then regex
    if (typeof m.test === "function") { try { if (!m.test(doc, url)) return false; } catch (_) { return false; } }
    return true;
  }

  // Ordered: answer-permalink before question (a permalink URL contains /question/).
  // NOTE: zhuanlan.zhihu.com suffix-matches the "zhihu.com" host gate; only the Zhihu
  // URL regexes keep /p/<id> falling through to zhihu-zhuanlan — don't broaden them.
  var SITE_RULES = [
    { id: "zhihu-answer",   source: "self", lastVerified: "2026-06-05", driftCheck: "manual",
      match: { host: "zhihu.com", url: /\/question\/\d+\/answer\/\d+/ }, extract: extractZhihuAnswer },
    { id: "zhihu-question", source: "self", lastVerified: "2026-06-05", driftCheck: "manual",
      match: { host: "zhihu.com", url: /\/question\/\d+\/?(?:[?#].*)?$/ }, extract: extractZhihuQuestion },
    { id: "zhihu-zhuanlan", source: "self", lastVerified: "2026-06-05", driftCheck: "manual",
      match: { host: "zhuanlan.zhihu.com", url: /\/p\/\d+/ }, extract: extractZhihuArticle }
    ,{ id: "stackoverflow", source: "json-ld+self", lastVerified: "2026-06-06", driftCheck: "auto",
       sampleUrl: "", match: { host: "stackoverflow.com", url: /\/questions\/\d+/ }, extract: function (d) { return extractStackOverflow(d); } }
    ,{ id: "stackexchange", source: "json-ld+self", lastVerified: "2026-06-06", driftCheck: "auto",
       sampleUrl: "", match: { host: "stackexchange.com", url: /\/questions\/\d+/ }, extract: function (d) { return extractStackOverflow(d); } }
    ,{ id: "v2ex",  source: "self", lastVerified: "2026-06-06", driftCheck: "auto",
       sampleUrl: "", match: { host: "v2ex.com", url: /\/t\/\d+/ }, extract: function (d) { return extractV2ex(d); } }
    ,{ id: "arxiv", source: "self", lastVerified: "2026-06-06", driftCheck: "auto",
       sampleUrl: "", match: { host: "arxiv.org", url: /\/abs\// }, extract: function (d) { return extractArxiv(d); } }
  ];

  function applySiteRule(doc, url) {
    for (var i = 0; i < SITE_RULES.length; i++) {
      var rule = SITE_RULES[i];
      if (!matchRule(rule.match, doc, url)) continue;
      var out = null;
      try { out = rule.extract(doc, url); } catch (_) { out = null; }
      if (out && out.contentHtml) {
        return { id: rule.id, contentHtml: out.contentHtml, title: out.title || doc.title || "", url: url };
      }
      break; // matched site but produced nothing → fall back to Defuddle
    }
    return null;
  }

  // Expose for the injected inline func (page isolated world) + test harness.
  var g = (typeof window !== "undefined") ? window : (typeof self !== "undefined" ? self : this);
  g.SITE_RULES = SITE_RULES;
  g.matchRule = matchRule;
  g.applySiteRule = applySiteRule;
})();
