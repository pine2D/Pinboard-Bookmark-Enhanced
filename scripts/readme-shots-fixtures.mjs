// Presentation fixtures for scripts/readme-shots.mjs (README screenshots).
// All content is original text written for these shots (no third-party
// articles, no real bookmarks). Video fixtures hand-written in the shapes of
// YouTube's own responses (watch page ytInitialPlayerResponse, timedtext).

export const USER = "reader";
export const TOKEN = `${USER}:0000000000000000000000000000000000000000`;
export const OWNER = `acct_${USER}`;
export const ARTICLE_URL = "https://example.com/essays/the-case-for-slow-reading";
export const ARTICLE_TITLE = "The Case for Slow Reading";

// [source, zh-CN translation]
export const BLOCKS = [
  ["h1", ARTICLE_TITLE, "慢读的理由"],
  ["p", "We save more than we read. A bookmark is a promise to our future selves, and most of those promises are quietly broken. The problem is rarely a lack of time; saving simply feels like reading, so the reading never happens.",
    "我们收藏的远比读过的多。书签是对未来自己的承诺，而大多数承诺都悄悄落空了。问题很少出在没时间，而是收藏本身就让人觉得读过了，于是真正的阅读迟迟没有发生。"],
  ["h2", "Saving is not reading", "收藏不等于阅读"],
  ["p", "Every bookmarking tool eventually faces the same question: what happens after the click? A link that only sits in a list is a receipt, not knowledge. The value appears when you come back, read with attention, and leave a trace of what mattered.",
    "每一款书签工具最终都要面对同一个问题：点下收藏之后呢？一条只躺在列表里的链接只是一张收据，算不上知识。价值出现在你回来专心读完、并留下重点痕迹的那一刻。"],
  ["p", "That trace can be small. A highlighted sentence, a two-line note, or a single word you looked up is often enough to bring the whole argument back months later.",
    "这道痕迹可以很小。一句高亮、两行笔记，或者查过的一个单词，往往就足以在几个月后把整篇论证重新唤回。"],
  ["h2", "Attention is the scarce resource", "注意力才是稀缺资源"],
  ["p", "Pages compete for attention with banners, sidebars, and autoplaying video. Stripping a page down to its text is not an aesthetic preference; it is a way of deciding, in advance, what deserves your focus.",
    "网页用横幅、侧栏和自动播放的视频争夺你的注意力。把页面剥到只剩正文并不是审美偏好，而是提前决定什么值得你专注。"],
  ["blockquote", "A clean page is a quiet room: the argument can finally be heard.",
    "干净的页面就像一间安静的屋子：论证终于能被听见。"],
  ["p", "Reading in a second language makes this even clearer. A side-by-side translation lets you stay with the original voice without ever losing the thread, and the words you stop to look up become a vocabulary built from things you actually read.",
    "用第二语言阅读时，这一点更加明显。双语对照让你既能贴着原文的语气读下去，又不会跟丢思路；而那些停下来查过的词，会变成一份从真实阅读中积累起来的词汇表。"],
  ["h2", "Make it a habit", "让它成为习惯"],
  ["p", "Slow reading does not mean reading less. It means choosing a few pieces each week, reading them to the end, and keeping what you learn somewhere you will actually look again.",
    "慢读并不意味着少读。它意味着每周挑几篇文章，读到最后，并把学到的东西放在你真的会再看的地方。"],
  ["p", "Over time, those small traces add up to something a list of links never could: a personal library of ideas, in your own words.",
    "日积月累，这些细小的痕迹会汇成一串链接永远给不了的东西：一座用你自己的话写成的个人思想书库。"],
];

export const ARTICLE_MARKDOWN = BLOCKS.map(([kind, src]) =>
  kind === "h1" ? `# ${src}` : kind === "h2" ? `## ${src}` : kind === "blockquote" ? `> ${src}` : src,
).join("\n\n");

const norm = (s) => String(s).replace(/[#>*_`\s]+/g, " ").trim().toLowerCase();
export function translate(text) {
  const n = norm(text);
  for (const [, src, zh] of BLOCKS) if (n.includes(norm(src).slice(0, 48))) return String(text).replace(/^([#>\s]*).*$/s, `$1${zh}`);
  return text;
}

export const ARTICLE_HTML = (scheme) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${ARTICLE_TITLE} — Field Notes</title>
<meta name="description" content="Saving feels like reading, so the reading never happens. A short essay on attention, highlights, and keeping what you learn.">
<style>
:root{color-scheme:${scheme};--bg:${scheme === "dark" ? "#16181d" : "#fbfaf7"};--fg:${scheme === "dark" ? "#e6e3dc" : "#22201c"};--mute:${scheme === "dark" ? "#8d8a83" : "#77736b"};--rule:${scheme === "dark" ? "#2a2d34" : "#e7e3da"};--ad:${scheme === "dark" ? "#22252c" : "#efece4"}}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.7 Georgia,"Times New Roman",serif}
header{display:flex;justify-content:space-between;align-items:center;padding:18px 48px;border-bottom:1px solid var(--rule);font:600 15px/1 -apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.02em}
header nav{display:flex;gap:28px;font-weight:400;color:var(--mute)}
.wrap{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:56px;max-width:1120px;margin:0 auto;padding:48px}
.kicker{font:600 12px/1 -apple-system,"Segoe UI",sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#b4532a}
h1{font-size:46px;line-height:1.12;margin:14px 0 12px;letter-spacing:-.01em}
.by{font:14px/1.4 -apple-system,"Segoe UI",sans-serif;color:var(--mute);margin-bottom:28px}
h2{font-size:24px;margin:34px 0 8px}
blockquote{margin:24px 0;padding-left:20px;border-left:3px solid #b4532a;font-style:italic}
aside .ad{background:var(--ad);border-radius:8px;height:250px;display:grid;place-items:center;color:var(--mute);font:13px sans-serif;margin-bottom:20px}
aside h4{font:600 12px/1 sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--mute)}
aside li{font:15px/1.5 -apple-system,"Segoe UI",sans-serif;margin:10px 0;color:var(--fg)}
aside ul{padding-left:18px}
</style></head><body>
<header><span>FIELD NOTES</span><nav><span>Essays</span><span>Reviews</span><span>Archive</span><span>Subscribe</span></nav></header>
<div class="wrap"><main><article>
<div class="kicker">Essay · Reading</div>
${BLOCKS.map(([k, s]) => k === "h1" ? `<h1>${s}</h1><div class="by">By the Field Notes desk · 7 min read</div>` : k === "h2" ? `<h2>${s}</h2>` : k === "blockquote" ? `<blockquote>${s}</blockquote>` : `<p>${s}</p>`).join("\n")}
</article></main>
<aside><div class="ad">Advertisement</div><h4>Most read</h4><ul><li>Notes on typography for small screens</li><li>Why plain text endures</li><li>The long tail of link rot</li></ul></aside></div>
</body></html>`;

// ---- Pinboard API ----
export const PINBOARD_API = new Map([
  ["/v1/posts/get", JSON.stringify({ date: "2026-10-09T00:00:00Z", user: USER, posts: [] })],
  ["/v1/posts/recent", JSON.stringify({ date: "2026-10-09T00:00:00Z", user: USER, posts: [
    { href: "https://example.com/a", description: "Notes on typography for small screens", tags: "design typography", time: "2026-10-08T10:00:00Z", shared: "yes", toread: "no", extended: "" },
    { href: "https://example.com/b", description: "Why plain text endures", tags: "writing tools", time: "2026-10-07T10:00:00Z", shared: "yes", toread: "yes", extended: "" },
    { href: "https://example.com/c", description: "The long tail of link rot", tags: "web archive", time: "2026-10-06T10:00:00Z", shared: "no", toread: "no", extended: "" },
  ] })],
  ["/v1/posts/suggest", '[{"popular":["reading","essay"]},{"recommended":["attention","longform","productivity"]}]'],
  ["/v1/tags/get", JSON.stringify({ reading: 214, essay: 96, attention: 31, longform: 58, productivity: 77, design: 145, typography: 40, writing: 88, tools: 120, web: 66, archive: 19, habits: 24, learning: 52, language: 37, notes: 45, "to-read": 12 })],
  ["/v1/posts/add", '{"result_code":"done"}'],
  ["/v1/posts/update", '{"update_time":"2026-10-09T00:00:00Z"}'],
  ["/v1/user/api_token", '{"result":"0000000000000000000000000000000000000000"}'],
]);

// ---- AI answers ----
export const AI_TAGS_SUMMARY = JSON.stringify({
  tags: ["reading", "attention", "habits", "note-taking"],
  summary: "Saving a link feels like reading it, so the reading rarely happens. The essay argues for choosing fewer pieces, reading them on a clean page, and leaving small traces (highlights, short notes, looked-up words) that turn bookmarks into a personal library of ideas.",
});

export function askAnswer(userPrompt) {
  const lines = String(userPrompt).split("\n");
  const find = (needle) => {
    for (const l of lines) { const m = l.match(/^\[P(\d+)\]/); if (m && l.includes(needle)) return Number(m[1]); }
    return 1;
  };
  const a = find("receipt, not knowledge"), b = find("That trace can be small"), c = find("Slow reading does not mean");
  return [
    `Because saving gives the feeling of progress without the reading itself. A link that only sits in a list is "a receipt, not knowledge" [P${a}]; its value appears only when you come back, read with attention, and leave a trace of what mattered [P${a}].`,
    "",
    `That trace can be tiny: one highlighted sentence, a two-line note, or a word you looked up is enough to bring the argument back later [P${b}]. So the author suggests reading fewer pieces, all the way to the end [P${c}].`,
    "",
    "CITES:",
    `P${a}: "A link that only sits in a list is a receipt, not knowledge."`,
    `P${b}: "A highlighted sentence, a two-line note, or a single word you looked up"`,
    `P${c}: "choosing a few pieces each week, reading them to the end"`,
  ].join("\n");
}

// ---- Library: highlights + vocabulary ----
const day = 86_400_000;
export const HIGHLIGHTS = (now) => [
  {
    key: "pbp_hl_readme-slow-reading", url: ARTICLE_URL, title: ARTICLE_TITLE,
    items: [
      { id: "s1", owner: OWNER, ts: now - 2 * 3600_000, color: 1, quote: "A link that only sits in a list is a receipt, not knowledge.", note: "This is why my reading list never shrinks. Saving is not the finish line." },
      { id: "s2", owner: OWNER, ts: now - 2 * 3600_000 + 60_000, color: 2, quote: "A highlighted sentence, a two-line note, or a single word you looked up is often enough to bring the whole argument back months later.", note: "" },
      { id: "s3", owner: OWNER, ts: now - 2 * 3600_000 + 120_000, color: 3, quote: "Stripping a page down to its text is not an aesthetic preference; it is a way of deciding, in advance, what deserves your focus.", note: "Good line for the reading-workflow post." },
      { id: "s4", owner: OWNER, ts: now - 2 * 3600_000 + 180_000, color: 4, quote: "the words you stop to look up become a vocabulary built from things you actually read", note: "" },
      { id: "s5", owner: OWNER, ts: now - 2 * 3600_000 + 240_000, color: 1, quote: "a personal library of ideas, in your own words.", note: "" },
    ],
  },
  { key: "pbp_hl_readme-plain-text", url: "https://example.com/essays/why-plain-text-endures", title: "Why Plain Text Endures",
    items: [
      { id: "p1", owner: OWNER, ts: now - 1 * day, color: 2, quote: "Formats come and go; a text file opened in 1995 still opens today.", note: "Argument for keeping notes in Markdown." },
      { id: "p2", owner: OWNER, ts: now - 1 * day + 60_000, color: 5, quote: "The best archive is the one you can read without the software that wrote it.", note: "" },
    ] },
  { key: "pbp_hl_readme-typography", url: "https://example.com/design/typography-small-screens", title: "Notes on Typography for Small Screens",
    items: [
      { id: "t1", owner: OWNER, ts: now - 3 * day, color: 3, quote: "Line length matters more than font choice once the screen gets narrow.", note: "" },
    ] },
  { key: "pbp_hl_readme-link-rot", url: "https://example.com/web/link-rot", title: "The Long Tail of Link Rot",
    items: [
      { id: "l1", owner: OWNER, ts: now - 6 * day, color: 4, quote: "Half of the links cited in a decade-old paper no longer resolve.", note: "Archive everything worth citing." },
    ] },
];

export const VOCAB = [
  { term: "serendipity", gloss: "意外发现珍宝的运气", status: "new", group: "Essays",
    note: "Often paired with \"pure\" or \"happy\". Not just luck: the gift of noticing what you were not looking for.",
    contexts: [
      { url: "https://example.com/essays/why-plain-text-endures", title: "Why Plain Text Endures", quote: "Half the joy of an old notebook is the serendipity of what you find in it." },
      { url: ARTICLE_URL, title: ARTICLE_TITLE, quote: "Rereading your highlights invites a kind of serendipity a feed never offers." },
    ] },
  { term: "ephemeral", gloss: "短暂的", status: "known", group: "Essays", contexts: [{ url: ARTICLE_URL, title: ARTICLE_TITLE, quote: "Most of what we save is ephemeral." }] },
  { term: "scarce", gloss: "稀缺的", status: "new", group: "Essays", contexts: [{ url: ARTICLE_URL, title: ARTICLE_TITLE, quote: "Attention is the scarce resource." }] },
  { term: "endure", gloss: "持久；经受住", status: "new", group: "Tech", contexts: [{ url: "https://example.com/essays/why-plain-text-endures", title: "Why Plain Text Endures", quote: "Why plain text endures." }] },
  { term: "resolve", gloss: "（链接）解析；解决", status: "known", group: "Tech", contexts: [{ url: "https://example.com/web/link-rot", title: "The Long Tail of Link Rot", quote: "links that no longer resolve" }] },
  { term: "trace", gloss: "痕迹；踪迹", status: "new", group: "Essays", contexts: [{ url: ARTICLE_URL, title: ARTICLE_TITLE, quote: "leave a trace of what mattered" }] },
  { term: "argument", gloss: "论证；论点", status: "known", contexts: [{ url: ARTICLE_URL, title: ARTICLE_TITLE, quote: "bring the whole argument back months later" }] },
  { term: "deliberate", gloss: "刻意的；深思熟虑的", status: "new", group: "Essays", contexts: [{ url: ARTICLE_URL, title: ARTICLE_TITLE, quote: "a deliberate habit" }] },
  { term: "legible", gloss: "清晰可读的", status: "new", group: "Design", contexts: [{ url: "https://example.com/design/typography-small-screens", title: "Notes on Typography for Small Screens", quote: "keep body text legible at any width" }] },
  { term: "kerning", gloss: "字距调整", status: "known", group: "Design", contexts: [{ url: "https://example.com/design/typography-small-screens", title: "Notes on Typography for Small Screens", quote: "kerning matters less than line length" }] },
  { term: "provenance", gloss: "出处；来源", status: "new", group: "Tech", contexts: [{ url: "https://example.com/web/link-rot", title: "The Long Tail of Link Rot", quote: "the provenance of a quotation" }] },
  { term: "wistful", gloss: "惆怅的；渴望的", status: "new", contexts: [{ url: ARTICLE_URL, title: ARTICLE_TITLE, quote: "a wistful look at the unread pile" }] },
];

export const DICT = {
  serendipity: {
    word: "serendipity",
    entries: [{
      language: { code: "en", name: "English" }, partOfSpeech: "noun",
      pronunciations: [{ type: "ipa", text: "/ˌsɛɹ.ənˈdɪp.ɪ.ti/", tags: ["UK"] }, { type: "ipa", text: "/ˌsɛɹ.ənˈdɪp.ə.ti/", tags: ["US"] }],
      forms: [{ word: "serendipities", tags: ["plural"] }],
      senses: [
        { definition: "An unsought, unintended, and/or unexpected, but fortunate, discovery and/or learning experience that happens by accident.", examples: ["The discovery was pure serendipity."], tags: [], synonyms: ["fluke", "happenstance", "chance"], antonyms: [], subsenses: [] },
        { definition: "The faculty of making such fortunate discoveries; a natural gift for finding valuable things not sought for.", examples: [], tags: ["uncountable"], synonyms: [], antonyms: [], subsenses: [] },
      ],
    }],
    source: { url: "https://en.wiktionary.org/wiki/serendipity", license: { name: "CC BY-SA", url: "https://creativecommons.org/licenses/by-sa/4.0" } },
  },
};

// ---- pinboard.in page (structure mirrors the live site; content is fake) ----
const BOOKMARKS = [
  ["The Case for Slow Reading", ARTICLE_URL, "Saving feels like reading, so the reading never happens. An essay on attention, highlights, and keeping what you learn.", ["reading", "attention", "habits"], "", true],
  ["Why Plain Text Endures", "https://example.com/essays/why-plain-text-endures", "Formats come and go; a text file opened in 1995 still opens today.", ["writing", "tools", "archive"], "", false],
  ["Notes on Typography for Small Screens", "https://example.com/design/typography-small-screens", "Line length matters more than font choice once the screen gets narrow.", ["design", "typography"], "private", false],
  ["The Long Tail of Link Rot", "https://example.com/web/link-rot", "Half of the links cited in a decade-old paper no longer resolve. What that means for anyone who keeps a library of links.", ["web", "archive"], "", false],
  ["A Field Guide to Personal Knowledge Management", "https://example.org/guides/pkm-field-guide", "Capture less, connect more: a practical walkthrough of notes, links, and review habits.", ["notes", "learning", "productivity"], "", false],
  ["Designing Calm Interfaces", "https://example.net/design/calm-interfaces", "", ["design", "ux"], "", false],
  ["Learning a Language from What You Already Read", "https://example.org/language/read-to-learn", "Turn the articles you already read into vocabulary practice.", ["language", "learning"], "", false],
];

export function pinboardHtml() {
  const bm = BOOKMARKS.map(([title, href, desc, tags, cls, unread], i) => `
       <div>
    <div name="edit_checkbox" class="edit_checkbox"><input autocomplete="off" type="checkbox"></div><div id="${1000 + i}" class="bookmark ${cls} ">
	<div class="star"><span>&#x272D;</span></div>
	<div class="display">
    <a class="bookmark_title ${unread ? "unread" : ""}" href="${href}">${title}</a>  &nbsp;<a class="cached" href="#">&#x2611;</a>
		<br>
		<a class="url_display" href="${href}">${href}</a><br>
		${desc ? `<div class="description">${desc}</div>` : ""}
${tags.map((t) => `<a class="tag" href="/u:${USER}/t:${t}/">${t}</a>&nbsp; `).join("\n")}
		<br>
		<a class="when" href="#" title="">${["2 hours ago", "yesterday", "3 days ago", "6 days ago", "1 week ago", "2 weeks ago", "3 weeks ago"][i]}</a>
        <div class="edit_links" style="display:inline">&nbsp;&nbsp;<a href="#" class="edit">edit</a>&nbsp;&nbsp;<div class="delete_link"><a class="delete" href="#">delete</a></div></div>    </div>
    <div style="clear:both"></div>
</div>
       <div style="clear:both"></div></div>`).join("");
  const cloud = Object.entries({ reading: 214, design: 145, tools: 120, essay: 96, writing: 88, productivity: 77, web: 66, longform: 58, learning: 52, notes: 45, typography: 40, language: 37, attention: 31, habits: 24, archive: 19, ux: 17 })
    .map(([t, n]) => `<a href="/u:${USER}/t:${t}/" style="font-size:${Math.round(12 + Math.log2(n) * 1.4)}px;" class="tag">${t}</a> `).join(" ");
  return `<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8">
<title>Pinboard: bookmarks for ${USER}</title>
<link rel="stylesheet" media="(min-width:640px)" href="/stylesheets/skeleton.css">
<link rel="stylesheet" href="/stylesheets/autocomplete.css">
<link rel="stylesheet" media="(min-width:640px)" href="/stylesheets/bookmarks.css">
<link rel="stylesheet" href="/stylesheets/basic.css"><link rel="stylesheet" href="/stylesheets/new_main.css">
</head><body id="pinboard">
<div id="content">
    <div id="banner">
        <div id="logo"><a href="/recent"><img src="/blue-pin.png" class="pin_logo"></a>
          <a id="pinboard_name" href="/">Pinboard</a>
          <span id="banner_user">(<a class="banner_username " href="/u:${USER}">${USER}</a>)</span>
        </div>
        <div id="top_menu"><span class="hideable">
     <a href="/network/">network</a> &#x2027; <a href="/notes/">notes</a> &#x2027; <a href="/popular/">popular</a> &#x2027;
     <a href="/add/">add url</a> &#x2027; <a href="/note/add/">add note</a> &#x2027; <a href="/settings/">settings</a> &#x2027; <a href="/u:${USER}/profile/">account</a>
       &nbsp;&nbsp;&nbsp;&nbsp; <a href="/logout/"> log out </a></span></div>
	<div style="clear:both"></div>
</div>
 <div id="main_column">
  <div class="user_navbar">
    <div class="small_username"><b><a href="/u:${USER}">${USER}</a></b></div>
    <div class="bookmark_count_box"> <span class="bookmark_count">2,418</span></div><div id="bmarks_page_nav"><a href="/u:${USER}/" class="filter selected">all</a>   &#x2027;  <a href="#" class="filter ">private</a>
  &#x2027;  <a href="#" class="filter ">public</a> &#x2027;  <a href="#" class="filter ">unread</a> &#x2027;  <a href="#" class="filter ">untagged</a> &#x2027;  <a href="#" class="filter ">starred</a>
  <div class="rss_linkbox"><a class="rss_link" href="#">RSS</a></div></div><div style="clear:both"></div></div>
<div id="bookmarks">${bm}
</div>
</div>
<div id="right_bar">
    <div id="searchbox"><form><input type="text" size="30" value="" name="query"><br>
        <div class="search_button"><input type="submit" name="mine" value="Search Mine"> <input name="all" type="submit" value="Search All"></div></form></div>
<div id="tag_cloud"><div><p><a class="tag_heading_selected" href="?mode=cloud">top tags</a> &nbsp; <a href="?mode=list">all tags</a> &#x2027; <a href="/tags/">manage</a></p></div>
${cloud}
</div>
</div>
</div>
</body></html>`;
}

// ---- YouTube video workspace ----
export const VID = "sL0wR3ad1ng";
export const WATCH_URL = `https://www.youtube.com/watch?v=${VID}`;
export const TITLE = "The Case for Slow Reading";
export const CHANNEL = "Field Notes Talks";

// ---------- captions (original text) ----------
export const LINES = [
  "Hi, everyone. Thanks for coming.",
  "I want to start with a confession.",
  "Last year I saved more than two thousand articles.",
  "I read maybe forty of them.",
  "Saving a link feels like reading it.",
  "It gives you the same small sense of progress.",
  "But the reading itself never quite happens.",
  "So tonight I want to make the case for slow reading.",
  "Not reading less, but reading differently.",
  "Let's start with what a bookmark really is.",
  "A bookmark is a promise to your future self.",
  "It says, I'll come back to this when I have time.",
  "Most of those promises are quietly broken.",
  "Not because we're lazy, but because the list grows faster than we read.",
  "A link that only sits in a list is a receipt.",
  "It proves you were there. It isn't knowledge.",
  "The value shows up when you come back",
  "and actually read the thing to the end.",
  "Which brings me to attention.",
  "Every page you open is competing for it.",
  "Banners, sidebars, videos that start on their own.",
  "Stripping a page down to its text",
  "isn't an aesthetic choice.",
  "It's a decision about what deserves your focus.",
  "A clean page is like a quiet room.",
  "The argument can finally be heard.",
  "The second idea is to leave a trace.",
  "It can be tiny: one highlighted sentence,",
  "a two-line note, a single word you looked up.",
  "Months later, that trace brings the whole argument back.",
  "Reading in a second language makes this obvious.",
  "The words you stop to look up become your vocabulary,",
  "a vocabulary built from things you actually read.",
  "So here's my suggestion for this week.",
  "Pick three pieces. Read them to the end.",
  "Keep what you learn somewhere you'll look again.",
  "Over time, those small traces add up",
  "to a library of ideas in your own words.",
  "Thank you.",
];
// Contiguous timing: ~0.075s per character + a floor, rounded like YouTube's
// own timedtext (2-decimal seconds).
export const CUES = (() => {
  let t = 0.04; const out = [];
  for (const text of LINES) {
    const len = Math.max(2.2, Math.min(6.2, 0.9 + text.length * 0.072));
    out.push({ start: +t.toFixed(2), dur: +(len - 0.08).toFixed(2), text });
    t += len;
  }
  return out;
})();
export const DURATION = Math.ceil(CUES.at(-1).start + CUES.at(-1).dur + 2.5);

// timedtext default format (no fmt): <transcript><text start dur>, entities
// double-encoded as YouTube serves them (&amp;#39; for an apostrophe).
const enc2 = (s) => s.replace(/&/g, "&amp;amp;").replace(/</g, "&amp;lt;").replace(/>/g, "&amp;gt;").replace(/'/g, "&amp;#39;").replace(/"/g, "&amp;quot;");
export const TIMEDTEXT_XML = `<?xml version="1.0" encoding="utf-8" ?><transcript>${CUES.map((c) => `<text start="${c.start}" dur="${c.dur}">${enc2(c.text)}</text>`).join("")}</transcript>`;
// json3 shape (fmt=json3), served if the extension ever asks for it.
export const TIMEDTEXT_JSON3 = JSON.stringify({ wireMagic: "pb3", pens: [{}], wsWinStyles: [{}], wpWinPositions: [{}],
  events: CUES.map((c) => ({ tStartMs: Math.round(c.start * 1000), dDurationMs: Math.round(c.dur * 1000), segs: [{ utf8: c.text }] })) });

const ttBase = (extra) => `https://www.youtube.com/api/timedtext?v=${VID}&ei=Zx8kZ7yQBNnCq9EP1YzXwQ4&caps=asr&opi=112496729&xoaf=5&hl=en&ip=0.0.0.0&ipbits=0&expire=1791676800&sparams=ip,ipbits,expire,v,ei,caps,opi,xoaf&signature=8A1C6F0E5B2D4F3A9C7E1B0D2F4A6C8E0B1D3F5A.2E4C6A8B0D1F3E5A7C9B1D3F5E7A9C0B2D4E6F8A&key=yt8${extra}`;
export const PLAYER_RESPONSE = {
  responseContext: { serviceTrackingParams: [], mainAppWebResponseContext: { loggedOut: true } },
  playabilityStatus: { status: "OK", playableInEmbed: true, contextParams: "Q0FFU0FnZ0I=" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: ttBase("&lang=en"), name: { simpleText: "English" }, vssId: ".en", languageCode: "en", isTranslatable: true, trackName: "" },
        { baseUrl: ttBase("&kind=asr&lang=en"), name: { simpleText: "English (auto-generated)" }, vssId: "a.en", languageCode: "en", kind: "asr", isTranslatable: true, trackName: "" },
      ],
      audioTracks: [{ captionTrackIndices: [0, 1], defaultCaptionTrackIndex: 0, visibility: "UNKNOWN", hasDefaultTrack: true, captionsInitialState: "CAPTIONS_INITIAL_STATE_OFF_RECOMMENDED" }],
      translationLanguages: [{ languageCode: "zh-Hans", languageName: { simpleText: "Chinese (Simplified)" } }],
      defaultAudioTrackIndex: 0,
    },
  },
  videoDetails: { videoId: VID, title: TITLE, lengthSeconds: String(DURATION), keywords: ["reading", "attention"], channelId: "UCfieldnotes0000000000000", isOwnerViewing: false,
    shortDescription: "Why saving a link is not the same as reading it, and how small traces turn reading into knowledge.",
    isCrawlable: true, thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${VID}/hqdefault.jpg`, width: 480, height: 360 }] },
    allowRatings: true, viewCount: "4182", author: CHANNEL, isPrivate: false, isUnpluggedCorpus: false, isLiveContent: false },
  microformat: { playerMicroformatRenderer: { title: { simpleText: TITLE }, lengthSeconds: String(DURATION), ownerChannelName: CHANNEL, category: "Education", publishDate: "2026-09-14T09:00:00-07:00" } },
};
export const WATCH_HTML = `<!DOCTYPE html><html style="font-size: 10px;font-family: Roboto, Arial, sans-serif;" lang="en" system-icons typography><head><meta http-equiv="origin-trial" content=""><title>${TITLE} - YouTube</title><meta name="title" content="${TITLE}"><meta property="og:title" content="${TITLE}"><link rel="canonical" href="${WATCH_URL}"></head><body dir="ltr"><script nonce="n0nce">var ytInitialPlayerResponse = ${JSON.stringify(PLAYER_RESPONSE)};var meta = document.createElement('meta'); meta.name = 'referrer'; meta.content = 'origin-when-cross-origin'; document.getElementsByTagName('head')[0].appendChild(meta);</script><ytd-app></ytd-app></body></html>`;


// Slide still shown as the player picture (rendered to PNG by the driver).
export const SLIDE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:1280px;height:720px;overflow:hidden}
body{background:radial-gradient(120% 90% at 18% 0%,#2a2f3a 0%,#171a21 55%,#111318 100%);color:#f3efe6;font-family:"Segoe UI",Calibri,Arial,sans-serif;position:relative}
.frame{position:absolute;inset:72px 96px;display:flex;flex-direction:column}
.eyebrow{font-size:20px;letter-spacing:.22em;text-transform:uppercase;color:#d9a25f;font-weight:600}
.rule{width:64px;height:3px;background:#d9a25f;margin:28px 0 36px;border-radius:2px}
h1{font-family:Georgia,Constantia,"Book Antiqua",serif;font-weight:400;font-size:92px;line-height:1.04;margin:0;letter-spacing:-.01em;max-width:900px}
.sub{font-size:32px;color:#b9b3a7;margin-top:30px;font-weight:300}
.foot{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;font-size:20px;color:#8d887e}
.foot b{color:#d8d2c6;font-weight:600}
.books{position:absolute;right:110px;top:150px;display:flex;align-items:flex-end;gap:10px;opacity:.9}
.books i{display:block;width:26px;border-radius:3px 3px 1px 1px}
</style></head><body>
<div class="books"><i style="height:210px;background:#d9a25f"></i><i style="height:250px;background:#5d7a8c"></i><i style="height:186px;background:#a2533f"></i><i style="height:232px;background:#e7dfcf"></i><i style="height:200px;background:#43566a;transform:rotate(9deg);transform-origin:bottom left;margin-left:8px"></i></div>
<div class="frame">
  <div class="eyebrow">Field Notes &middot; Evening Talks</div>
  <div class="rule"></div>
  <h1>The Case for<br>Slow Reading</h1>
  <div class="sub">A three-minute talk on attention and keeping what you read</div>
  <div class="foot"><span><b>Mara Ellison</b> &nbsp;&middot;&nbsp; Field Notes</span><span>02 / 06</span></div>
</div></body></html>`;


// Relay stub on the real relay URL: same inbound gate as docs/yt-embed.html
// (parent + pbpVideo:1 + allowlist, arm on first chrome-extension:// message),
// replies "ready" then time reports {t,state:1,d,r} every 250ms from START_T.
export const relayHtml = (START_T) => `<!doctype html>
<meta charset="utf-8"><title>Video embed</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}img{width:100%;height:100%;object-fit:cover;display:block}</style>
<body><img src="slide.png" alt="">
<script>
(function () {
  var parentOrigin = "", t = ${START_T}, state = 1, rate = 1, last = 0, timer = 0;
  function post(m) { if (parentOrigin) try { window.parent.postMessage(m, parentOrigin); } catch (_) {} }
  function tick() { var now = performance.now(); if (state === 1 && last) t += (now - last) / 1000 * rate; last = now;
    post({ pbpVideo: 1, event: "time", t: t, state: state, d: ${DURATION}, r: rate }); }
  window.__setT = function (v) { t = v; last = 0; tick(); };
  window.addEventListener("message", function (e) {
    if (window.parent === window || e.source !== window.parent) return;
    var d = e.data; if (!d || typeof d !== "object" || d.pbpVideo !== 1) return;
    if (["hello", "seekTo", "playVideo", "pauseVideo", "setPlaybackRate"].indexOf(d.func) < 0) return;
    if (!parentOrigin && e.origin && e.origin.indexOf("chrome-extension://") === 0) {
      parentOrigin = e.origin; post({ pbpVideo: 1, event: "ready" });
      if (!timer) { tick(); timer = setInterval(tick, 250); }
    }
    if (e.origin !== parentOrigin) return;
    var a = Array.isArray(d.args) ? d.args : [];
    if (d.func === "seekTo" && isFinite(+a[0])) { t = +a[0]; tick(); }
    else if (d.func === "pauseVideo") { state = 2; tick(); }
    else if (d.func === "playVideo") { state = 1; last = 0; tick(); }
    else if (d.func === "setPlaybackRate" && isFinite(+a[0])) { rate = +a[0]; tick(); }
  });
})();
</script></body>`;
