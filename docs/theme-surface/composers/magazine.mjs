// Composer: magazine
// Editorial-style layout — first bookmark acts as a hero, the rest flow in a
// two-column reading grid with serif typography. This composer exists to PROVE
// the scaffold can host fundamentally different designs, not just recolor the
// canonical Pinboard shape.
//
// Non-trivial transformations vs classic-list:
//   - #main_column becomes a CSS Grid with a spanning hero row
//   - .bookmark:first-of-type spans both columns, oversized title
//   - Serif typography option via typo.family-heading
//   - Numbered gutter via ::before on each bookmark
//   - #right_bar reframed as a "masthead" strip above main
//
// tokens.layout.mode must equal "magazine".
// tokens.typo.family-heading (serif) is recommended but not required.

import { baseLayer } from "./_base.mjs";
import { v } from "./_util.mjs";

export function compose(tokens) {
  return baseLayer(tokens) + emit(tokens);
}

function emit(tokens) {
  const heading = (tokens.typo && tokens.typo["family-heading"]) || (tokens.typo && tokens.typo.family) || "serif";
  const dur = (tokens.motion && tokens.motion["duration-med"]) || "220ms";
  const ease = (tokens.motion && tokens.motion.easing) || "cubic-bezier(0.2, 0.8, 0.2, 1)";
  const rightBar = tokens.layout && tokens.layout["right-bar"];

  return `
/* === composer: magazine === */

html, body {
  background: ${v("bg")};
  color: ${v("fg")};
  font-family: ${v("font-family")};
  font-size: ${v("font-size-base")};
  line-height: ${v("line-height")};
}

a, a:link { color: ${v("accent")}; text-decoration: none; border-bottom: 1px solid transparent; transition: border-color ${dur} ${ease}; }
a:hover { color: ${v("link-hover")}; border-bottom-color: ${v("link-hover")}; }
a:visited { color: ${v("link-visited")}; }
a:focus-visible { outline: 2px solid ${v("focus-ring")}; outline-offset: 3px; }

/* banner — thin masthead */
#banner {
  background: ${v("bg")};
  color: ${v("fg")};
  border-bottom: 3px ${v("border-style")} ${v("fg")};
  padding: calc(${v("space-unit")} * 2) calc(${v("space-unit")} * 6);
  font-family: ${heading};
  letter-spacing: 0.02em;
}
#banner a, #top_menu a {
  color: ${v("fg")};
  font-family: ${heading};
  font-variant: small-caps;
  text-transform: lowercase;
  font-size: ${v("font-size-base")};
}
#top_menu a:hover { color: ${v("accent")}; }

#banner_searchbox input,
#tweet_searchbox input[type="text"] {
  background: transparent;
  color: ${v("fg")};
  border: none;
  border-bottom: ${v("border-width")} ${v("border-style")} ${v("border")};
  border-radius: 0;
  padding: calc(${v("space-unit")} * 1) 0;
  font-family: ${heading};
  font-style: italic;
}
#banner_searchbox input:focus-visible,
#tweet_searchbox input[type="text"]:focus-visible {
  outline: none;
  border-bottom-color: ${v("accent")};
  border-bottom-width: 2px;
}

/* sub_banner — treated as an editor's note */
#sub_banner {
  padding: ${v("space-sub-banner-y")} calc(${v("space-unit")} * 6);
  color: ${v("muted")};
  font-style: italic;
  font-family: ${heading};
  border-bottom: 1px ${v("border-style")} ${v("border")};
}

/* right_bar as a masthead strip above main */
#right_bar {
  ${rightBar === "hidden" ? "display: none !important;" : ""}
  background: ${v("bg")};
  color: ${v("fg")};
  border-top: 1px ${v("border-style")} ${v("border")};
  border-bottom: 1px ${v("border-style")} ${v("border")};
  padding: calc(${v("space-unit")} * 2) calc(${v("space-unit")} * 6);
  display: flex;
  flex-wrap: wrap;
  gap: calc(${v("space-unit")} * 3);
  align-items: baseline;
}
#right_bar h1, #right_bar h2, #right_bar h3, #right_bar h4 {
  color: ${v("fg")};
  font-family: ${heading};
  font-weight: ${v("weight-heading")};
  font-variant: small-caps;
  text-transform: lowercase;
  margin: 0;
  letter-spacing: 0.04em;
}
#right_bar a { color: ${v("accent")}; }
#right_bar table { width: auto; }

/* main column: two-column reading grid with hero */
#main_column {
  background: ${v("bg")};
  color: ${v("fg")};
  padding: calc(${v("space-unit")} * 4) calc(${v("space-unit")} * 6);
  max-width: 1180px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: calc(${v("space-unit")} * 6);
  row-gap: ${v("space-bookmark-gap")};
  counter-reset: mag-bookmark;
}

/* forms span both columns */
#main_column form,
#main_column > table,
#main_column > h1, #main_column > h2, #main_column > p {
  grid-column: 1 / -1;
}

/* bookmark entry — article-style */
#main_column .bookmark {
  counter-increment: mag-bookmark;
  background: transparent;
  color: ${v("fg")};
  border-top: ${v("border-width")} ${v("border-style")} ${v("border")} !important;
  padding: calc(${v("space-unit")} * 2) 0;
  position: relative;
  min-width: 0;
}

/* numbered drop cap in the gutter */
#main_column .bookmark::before {
  content: counter(mag-bookmark, decimal-leading-zero);
  display: block;
  font-family: ${heading};
  font-size: ${v("font-size-xs")};
  color: ${v("muted")};
  letter-spacing: 0.12em;
  margin-bottom: calc(${v("space-unit")} * 0.5);
}

/* hero: the first bookmark spans both columns with oversized title */
#main_column .bookmark:first-of-type {
  grid-column: 1 / -1;
  padding: calc(${v("space-unit")} * 4) 0 calc(${v("space-unit")} * 6);
  border-top: 0 !important;
  border-bottom: 3px ${v("border-style")} ${v("fg")};
}
#main_column .bookmark:first-of-type::before { display: none; }
#main_column .bookmark:first-of-type a.bookmark_title {
  font-size: calc(${v("font-size-lg")} * 1.8);
  line-height: 1.1;
  font-family: ${heading};
  font-weight: ${v("weight-heading")};
}

#main_column .bookmark a.bookmark_title {
  color: ${v("fg")};
  font-family: ${heading};
  font-weight: ${v("weight-heading")};
  font-size: calc(${v("font-size-lg")} * 1.1);
  line-height: 1.25;
  letter-spacing: -0.01em;
  display: inline-block;
  border-bottom: none;
}
#main_column .bookmark a.bookmark_title:hover { color: ${v("accent")}; border-bottom: 1px solid ${v("accent")}; }

#main_column .bookmark .description,
#main_column .bookmark .bookmark_description {
  color: ${v("fg")};
  font-size: ${v("font-size-base")};
  line-height: 1.6;
  margin-top: calc(${v("space-unit")} * 1.5);
  /* first-letter flourish on hero */
}
#main_column .bookmark:first-of-type .description::first-letter,
#main_column .bookmark:first-of-type .bookmark_description::first-letter {
  font-family: ${heading};
  font-size: 3em;
  float: left;
  line-height: 0.9;
  padding-right: 0.08em;
  color: ${v("accent")};
}

#main_column .bookmark .tags {
  margin-top: calc(${v("space-unit")} * 1.5);
  font-style: italic;
  font-family: ${heading};
}
#main_column .bookmark .tags a {
  color: ${v("muted")};
  background: transparent;
  padding: 0;
  margin-right: calc(${v("space-unit")} * 1.5);
  border-bottom: 1px dotted ${v("muted")};
  font-size: ${v("font-size-sm")};
}
#main_column .bookmark .tags a:hover { color: ${v("accent")}; border-bottom-color: ${v("accent")}; }

#main_column .bookmark .when,
#main_column .bookmark .display {
  color: ${v("muted")};
  font-size: ${v("font-size-xs")};
  font-family: ${heading};
  font-style: italic;
  letter-spacing: 0.04em;
}

/* private entries: masthead stripe instead of bg flood */
.bookmark.private {
  position: relative;
}
.bookmark.private::after {
  content: "private";
  position: absolute;
  top: calc(${v("space-unit")} * 2);
  right: 0;
  font-family: ${heading};
  font-size: ${v("font-size-xs")};
  font-variant: small-caps;
  color: ${v("destroy")};
  letter-spacing: 0.08em;
}

/* forms — editorial inputs */
#main_column form input[type="text"],
#main_column form input[type="url"],
#main_column form input[type="email"],
#main_column form input[type="password"],
#main_column form input[type="search"],
#main_column form textarea,
#main_column form select {
  background: transparent;
  color: ${v("fg")};
  border: none;
  border-bottom: ${v("border-width")} ${v("border-style")} ${v("border")};
  border-radius: 0;
  padding: calc(${v("space-unit")} * 1) 0;
  font-family: ${heading};
  font-size: ${v("font-size-base")};
  width: 100%;
}
#main_column form textarea { font-family: ${v("font-family")}; }
#main_column form input:focus-visible,
#main_column form textarea:focus-visible,
#main_column form select:focus-visible {
  outline: none;
  border-bottom-color: ${v("accent")};
  border-bottom-width: 2px;
  background: ${v("accent-alpha")};
}
#main_column form ::placeholder { color: ${v("muted")}; font-style: italic; opacity: 1; }

#main_column form input[type="submit"],
#main_column form button {
  background: ${v("fg")};
  color: ${v("bg")};
  border: none;
  border-radius: 0;
  padding: calc(${v("space-unit")} * 1.5) calc(${v("space-unit")} * 4);
  font-family: ${heading};
  font-variant: small-caps;
  text-transform: lowercase;
  letter-spacing: 0.08em;
  cursor: pointer;
  transition: background ${dur} ${ease}, color ${dur} ${ease};
}
#main_column form input[type="submit"]:hover,
#main_column form button:hover { background: ${v("accent")}; color: ${v("bg")}; }

/* tables in editorial voice */
#main_column table { border-collapse: collapse; grid-column: 1 / -1; }
#main_column table th {
  color: ${v("fg")};
  font-family: ${heading};
  font-variant: small-caps;
  text-transform: lowercase;
  letter-spacing: 0.06em;
  text-align: left;
  border-bottom: 2px ${v("border-style")} ${v("fg")};
  padding: calc(${v("space-unit")} * 1) calc(${v("space-unit")} * 2);
}
#main_column table td {
  color: ${v("fg")};
  padding: calc(${v("space-unit")} * 1) calc(${v("space-unit")} * 2);
  border-bottom: 1px ${v("border-style")} ${v("border")};
}

/* footer — colophon */
#footer, .footer {
  color: ${v("muted")};
  border-top: 1px ${v("border-style")} ${v("border")};
  padding: calc(${v("space-unit")} * 4) calc(${v("space-unit")} * 6);
  font-family: ${heading};
  font-style: italic;
  text-align: center;
}

/* respond: single column on narrow */
@media (max-width: 720px) {
  #main_column { grid-template-columns: 1fr; }
  #main_column .bookmark:first-of-type a.bookmark_title { font-size: calc(${v("font-size-lg")} * 1.4); }
}
`;
}
