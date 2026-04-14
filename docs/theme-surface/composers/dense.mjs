// Composer: dense
// High-density variant of classic-list. Collapses bookmark-gap, shrinks typography,
// drops tag chip padding, and moves meta inline with the title. Ideal for power
// users with many bookmarks per page.
// tokens.layout.mode must equal "dense".

import { v } from "./_util.mjs";
import { compose as composeClassic } from "./classic-list.mjs";

export function compose(tokens) {
  // Dense inherits classic-list and overrides.
  return composeClassic({
    ...tokens,
    layout: { ...tokens.layout, mode: "classic-list" }
  }) + denseOverrides(tokens);
}

function denseOverrides(tokens) {
  const tight = tokens.space["gap-1"] || "2px";
  return `
/* === composer: dense (overrides classic-list) === */

#main_column .bookmark {
  padding: ${tight} 0;
  border-radius: 0;
}

#main_column .bookmark a.bookmark_title {
  font-size: ${v("font-size-sm")};
  font-weight: ${v("weight-body")};
}

#main_column .bookmark .description,
#main_column .bookmark .bookmark_description {
  font-size: ${v("font-size-xs")};
  /* clamp multiline descriptions to 2 lines */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

#main_column .bookmark .tags a {
  padding: 0 4px;
  font-size: ${v("font-size-xs")};
}

#main_column .bookmark .when,
#main_column .bookmark .display {
  font-size: ${v("font-size-xs")};
}

/* tighter form spacing */
#main_column form input,
#main_column form textarea,
#main_column form select {
  padding: calc(${v("space-unit")} * 0.75);
  font-size: ${v("font-size-sm")};
}

#sub_banner { padding: calc(${v("space-sub-banner-y")} / 2) 0; }
`;
}
