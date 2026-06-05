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

  // Zhihu lazy-loads images: real URL in data-original / data-actualsrc. Promote
  // to src so markdown keeps them. Operates on a DETACHED node (never the live DOM).
  function fixLazyImages(root) {
    if (!root || !root.querySelectorAll) return root;
    root.querySelectorAll("img").forEach(function (img) {
      var real = img.getAttribute("data-original") || img.getAttribute("data-actualsrc");
      var cur = img.getAttribute("src") || "";
      if (real && (!cur || cur.indexOf("data:") === 0)) img.setAttribute("src", real);
      img.removeAttribute("data-original");
      img.removeAttribute("data-actualsrc");
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

  function answerSection(author, voteup, permalink, bodyHtml) {
    var head = "<h2>" + escapeHtml(author || "匿名用户") + "</h2>";
    var meta = "<p>" + escapeHtml(String(voteup || 0) + " 赞同") +
      (permalink ? ' · <a href="' + escapeHtml(permalink) + '">链接</a>' : "") + "</p>";
    return head + meta + (bodyHtml || "");
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
    if (ans) { bodyHtml = ans.content || ""; author = (ans.author && ans.author.name) || ""; voteup = ans.voteup_count || 0; }
    if (!bodyHtml) {
      var node = doc.querySelector(".RichText.ztext");
      if (node) bodyHtml = node.innerHTML;
    }
    if (!author) {
      var aEl = doc.querySelector(".AuthorInfo-name") || doc.querySelector(".AuthorInfo .UserLink-link");
      if (aEl) author = aEl.textContent.trim();
    }
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
      if (ans) { bodyHtml = ans.content || ""; author = (ans.author && ans.author.name) || ""; voteup = ans.voteup_count || 0; }
      if (!bodyHtml) { var node = card.querySelector(".RichText.ztext"); if (node) bodyHtml = node.innerHTML; }
      if (!author) { var aEl = card.querySelector(".AuthorInfo-name") || card.querySelector(".AuthorInfo .UserLink-link"); if (aEl) author = aEl.textContent.trim(); }
      pushAnswer(aid, author, voteup, bodyHtml);
    });

    // Source 2: initialData answers with no matching DOM card (keeps the full batch).
    if (ent.answers) {
      Object.keys(ent.answers).forEach(function (aid) {
        if (seen[aid]) return;
        var ans = ent.answers[aid];
        if (!ans || !ans.content) return;
        pushAnswer(aid, (ans.author && ans.author.name) || "", ans.voteup_count || 0, ans.content);
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
  var SITE_RULES = [
    { id: "zhihu-answer",   match: { host: "zhihu.com",          url: /\/question\/\d+\/answer\/\d+/ },   extract: extractZhihuAnswer },
    { id: "zhihu-question", match: { host: "zhihu.com",          url: /\/question\/\d+\/?(?:[?#].*)?$/ }, extract: extractZhihuQuestion },
    { id: "zhihu-zhuanlan", match: { host: "zhuanlan.zhihu.com", url: /\/p\/\d+/ },                       extract: extractZhihuArticle }
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
