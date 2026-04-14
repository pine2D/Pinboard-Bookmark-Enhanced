// Composer: card-grid
// Bookmarks render as discrete cards in a responsive grid. Requires:
//   - CSS Grid on #main_column
//   - Each .bookmark becomes a self-contained card with shadow + radius
//   - Defeats Pinboard's inline `border-top` (we already neutralized it in _base,
//     but card-grid adds explicit `border-top: 0 !important` via layout-scope)
//   - Right_bar collapses below main on narrow viewports.
// tokens.layout.mode must equal "card-grid".

import { baseLayer } from "./_base.mjs";
import { v } from "./_util.mjs";

export function compose(tokens) {
  return baseLayer(tokens) + emit(tokens);
}

function emit(tokens) {
  const shadow = (tokens.fx && tokens.fx["shadow-md"]) || `0 1px 3px ${v("border")}`;
  const hoverLift = (tokens.motion && tokens.motion["hover-lift"]) || "translateY(-2px)";
  const dur = (tokens.motion && tokens.motion["duration-fast"]) || "140ms";
  const ease = (tokens.motion && tokens.motion.easing) || "ease-out";
  const minCard = (tokens.layout && tokens.layout["card-min"]) || "280px";

  return `
/* === composer: card-grid === */

html, body {
  background: ${v("bg")};
  color: ${v("fg")};
  font-family: ${v("font-family")};
  font-size: ${v("font-size-base")};
  line-height: ${v("line-height")};
}

a, a:link { color: ${v("accent")}; text-decoration: none; }
a:hover { color: ${v("link-hover")}; }
a:visited { color: ${v("link-visited")}; }
a:focus-visible { outline: 2px solid ${v("focus-ring")}; outline-offset: 2px; border-radius: ${v("radius-sm")}; }

#banner {
  background: ${v("bg")};
  color: ${v("fg")};
  border-bottom: ${v("border-width")} ${v("border-style")} ${v("border")};
  padding: calc(${v("space-unit")} * 2) calc(${v("space-unit")} * 4);
}
#banner a { color: ${v("accent")}; }
#top_menu a { color: ${v("fg")}; }
#top_menu a:hover { color: ${v("accent")}; }

#banner_searchbox input,
#tweet_searchbox input[type="text"] {
  background: ${v("input-bg")};
  color: ${v("fg")};
  border: ${v("border-width")} ${v("border-style")} ${v("border")};
  border-radius: ${v("radius-md")};
  padding: calc(${v("space-unit")} * 1.5) calc(${v("space-unit")} * 2);
}
#banner_searchbox input:focus-visible,
#tweet_searchbox input[type="text"]:focus-visible {
  outline: none;
  border-color: ${v("accent")};
  box-shadow: 0 0 0 3px ${v("accent-alpha")};
}

#sub_banner {
  padding: ${v("space-sub-banner-y")} calc(${v("space-unit")} * 4);
  color: ${v("muted")};
  border-bottom: ${v("border-width")} ${v("border-style")} ${v("border")};
}

#main_column {
  background: ${v("bg")};
  color: ${v("fg")};
  padding: ${v("space-main-padding")};
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(${minCard}, 1fr));
  gap: ${v("space-bookmark-gap")};
}

/* bookmark card */
#main_column .bookmark {
  background: ${v("bg")};
  color: ${v("fg")};
  border: ${v("border-width")} ${v("border-style")} ${v("border")} !important;
  border-top: ${v("border-width")} ${v("border-style")} ${v("border")} !important;
  border-radius: ${v("radius-md")};
  padding: calc(${v("space-unit")} * 3);
  box-shadow: ${shadow};
  transition: transform ${dur} ${ease}, box-shadow ${dur} ${ease};
  display: flex;
  flex-direction: column;
  gap: calc(${v("space-unit")} * 1.5);
  min-width: 0;
}
#main_column .bookmark:hover {
  transform: ${hoverLift};
  box-shadow: 0 4px 12px ${v("accent-alpha")};
  background: ${v("bg")};
}

#main_column .bookmark a.bookmark_title {
  color: ${v("accent")};
  font-weight: ${v("weight-heading")};
  font-size: ${v("font-size-lg")};
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

#main_column .bookmark .description,
#main_column .bookmark .bookmark_description {
  color: ${v("fg")};
  font-size: ${v("font-size-sm")};
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

#main_column .bookmark .tags { display: flex; flex-wrap: wrap; gap: 4px; }
#main_column .bookmark .tags a {
  color: ${v("accent")};
  background: ${v("tag-bg")};
  padding: 2px 8px;
  border-radius: ${v("radius-sm")};
  font-size: ${v("font-size-xs")};
}

#main_column .bookmark .when,
#main_column .bookmark .display {
  color: ${v("muted")};
  font-size: ${v("font-size-xs")};
  margin-top: auto;
}

/* right_bar: in card-grid, dock below main on narrow */
#right_bar {
  background: ${v("bg")};
  color: ${v("fg")};
  border: ${v("border-width")} ${v("border-style")} ${v("border")};
  border-radius: ${v("radius-md")};
  padding: ${v("space-right-bar-gap")};
  grid-column: 1 / -1;
}
#right_bar h1, #right_bar h2, #right_bar h3, #right_bar h4 {
  color: ${v("fg")};
  font-weight: ${v("weight-heading")};
}
#right_bar a { color: ${v("accent")}; }
#right_bar table { width: 100%; border-collapse: collapse; }

/* forms: break out of grid */
#main_column form,
#main_column > table,
#main_column > h1, #main_column > h2, #main_column > p {
  grid-column: 1 / -1;
}
#main_column form input[type="text"],
#main_column form input[type="url"],
#main_column form input[type="email"],
#main_column form input[type="password"],
#main_column form input[type="search"],
#main_column form textarea,
#main_column form select {
  background: ${v("input-bg")};
  color: ${v("fg")};
  border: ${v("border-width")} ${v("border-style")} ${v("border")};
  border-radius: ${v("radius-md")};
  padding: calc(${v("space-unit")} * 1.5);
  font-family: inherit;
  font-size: ${v("font-size-base")};
}
#main_column form input:focus-visible,
#main_column form textarea:focus-visible,
#main_column form select:focus-visible {
  outline: none;
  border-color: ${v("accent")};
  box-shadow: 0 0 0 3px ${v("accent-alpha")};
}
#main_column form input[type="submit"],
#main_column form button {
  background: ${v("btn-bg")};
  color: ${v("btn-fg")};
  border: none;
  border-radius: ${v("radius-md")};
  padding: calc(${v("space-unit")} * 1.5) calc(${v("space-unit")} * 4);
  font-weight: ${v("weight-heading")};
  cursor: pointer;
  transition: background ${dur} ${ease};
}
#main_column form input[type="submit"]:hover,
#main_column form button:hover { background: ${v("accent")}; }

#footer, .footer { color: ${v("muted")}; border-top: ${v("border-width")} ${v("border-style")} ${v("border")}; grid-column: 1 / -1; padding-top: calc(${v("space-unit")} * 2); }
`;
}
