// ============================================================
// Pinboard Bookmark Enhanced - Listbox primitive (options + library)
// ============================================================
// The one drawn <select> the extension allows (COMPONENTS.md §6.4
// exception 2, spec stage2 §3; library: spec 2026-10-03 library redesign
// §8). It enhances only `select[data-listbox]`:
//
//   select#<id>[hidden]          <- still the value carrier: the page reads
//                                   and writes .value and listens for change
//   div.listbox
//     button.listbox-btn#<id>-btn[role=combobox]          <- value box (default)
//       span.listbox-value + span.btn-ic (PBP_ICONS.chevronDown)
//       span.listbox-sizer[aria-hidden]  <- longest option text, zero height:
//                                           max-content = widest option, as a
//                                           native select sizes itself
//     button.listbox-trigger.btn.ghost#<id>-btn[role=combobox]
//                                    <- data-listbox-face="ghost" instead: a
//                                       menu trigger, not a value box (never
//                                       .listbox-btn, never a FIELD_TARGETS
//                                       entry). Its content is setBtnIcon() of
//                                       the selected option's data-face-icon
//                                       (a PBP_ICONS key) and data-face-label
//                                       (default: the option text) -- just the
//                                       label span when there is no icon to
//                                       draw; no sizer.
//                                       The consumer owns its title.
//     div.listbox-pop[hidden]        <- popover shell: border, radius, shadow,
//                                       overflow hidden (clips the scrollbar
//                                       into the rounded corners)
//       ul.listbox-list#<id>-list[role=listbox]   <- the scroll layer
//         li.listbox-opt#<id>-opt-<i>[role=option][aria-selected]
//
// Placement has two modes:
//   data-listbox (no value)  absolute: the shell sits inside .listbox and the
//                            surface CSS owns its geometry; open() measures
//                            once and sets data-flip="up" when the list would
//                            overrun the viewport bottom (options).
//   data-listbox="float"     the shell is a popover="manual" in the top layer,
//                            placed with position: fixed by pbpListboxPlace(),
//                            so no scroll container can clip it (library). A
//                            window resize closes it; an outer scroll closes
//                            it only when it moved the button (> 1px from
//                            where open() placed the panel), so a scroll that
//                            was still queued or coasting (touchpad inertia)
//                            when the list opened cannot snap it shut, and a
//                            pane scrolling beside the button leaves it be.
//                            Scrolling the list itself never closes it.
//
// Behaviour is the WAI-ARIA APG "select-only combobox": focus never leaves the
// button, aria-activedescendant names the active option, and moving it only
// scrolls the list. A pick writes select.value and dispatches bubbling input +
// change events, so every existing listener (autosave, provider fields,
// translate custom input) runs unchanged. The native select is never removed;
// it only gets `hidden` here, so a page where this script does not run -- or
// where one select fails to enhance -- keeps a usable native control.
//
// Programmatic .value writes fire no change event: call
// window.pbpListboxSync(select) after them. applyI18n() rewrites option text
// and then dispatches pbp:i18n-applied, which re-syncs every enhanced select.
// window.pbpListboxPlace(pop, anchor) is exported for other floating panels
// (the library's narrow-index Filter popover). <html data-listbox-ready> marks
// the end of the DOMContentLoaded enhancement pass -- set even when a select
// failed -- so a surface may hide select[data-listbox] until then.
(() => {
  "use strict";

  const TYPEAHEAD_MS = 500;
  const PAGE_STEP = 10;
  const PLACE_EDGE = 8;     // clearance kept from every viewport edge
  const PLACE_OFFSET = 4;   // anchor-to-panel gap (the options shell's sp-1)
  const states = new WeakMap();   // select -> state
  const enhanced = new Set();     // for the i18n re-sync; pruned of detached states on enhance and re-sync

  function chevron() {
    return typeof PBP_ICONS !== "undefined" && PBP_ICONS.chevronDown ? PBP_ICONS.chevronDown : "";
  }

  function isEnabled(state, i) {
    const opt = state.select.options[i];
    return !!opt && !opt.disabled;
  }

  // Nearest enabled index from `from` walking in `dir` (±1); stays on `from`
  // when nothing enabled lies that way (clamp, no wrap).
  function step(state, from, dir) {
    for (let i = from + dir; i >= 0 && i < state.select.options.length; i += dir) {
      if (isEnabled(state, i)) return i;
    }
    return from;
  }

  // Clamp an absolute target into range, then settle on an enabled option,
  // preferring the direction of travel.
  function settle(state, target, dir) {
    const last = state.select.options.length - 1;
    let i = Math.max(0, Math.min(last, target));
    if (isEnabled(state, i)) return i;
    const ahead = step(state, i, dir);
    if (ahead !== i) return ahead;
    const back = step(state, i, -dir);
    return back !== i ? back : state.active;
  }

  function firstEnabled(state) { return settle(state, 0, 1); }
  function lastEnabled(state) { return settle(state, state.select.options.length - 1, -1); }

  function optionText(opt) { return (opt?.textContent || "").trim(); }

  // Fixed-position placement for a shown panel, after showConfirmPopover's
  // position() (shared.js): min width = the anchor, max width = the viewport
  // minus 8px a side; below the anchor unless the room there is short and the
  // room above is larger (then data-flip="up"); clamped horizontally into the
  // viewport. --listbox-room is the px the panel's border box may take on the
  // chosen side (viewport room minus the 4px anchor gap and the 8px edge); the
  // surface CSS turns it into the scroll layer's max-height. The viewport is
  // documentElement.client* (a classic scrollbar is not room). Returns the
  // side, "down" or "up".
  function place(pop, anchor) {
    const root = document.documentElement;
    const vw = root.clientWidth || window.innerWidth;
    const vh = root.clientHeight || window.innerHeight;
    const a = anchor.getBoundingClientRect();
    const s = pop.style;
    s.position = "fixed";
    s.right = "auto";
    s.bottom = "auto";
    // Measure at a neutral spot: a stale left near the right edge would
    // shrink-to-fit the width being measured.
    s.left = "0px";
    s.top = "0px";
    s.minWidth = `${Math.round(a.width)}px`;
    s.maxWidth = `${Math.max(0, vw - 2 * PLACE_EDGE)}px`;
    s.removeProperty("--listbox-room");
    const natural = pop.getBoundingClientRect().height;
    const below = Math.max(0, vh - a.bottom - PLACE_OFFSET - PLACE_EDGE);
    const above = Math.max(0, a.top - PLACE_OFFSET - PLACE_EDGE);
    const up = natural > below && above > below;
    s.setProperty("--listbox-room", `${Math.floor(up ? above : below)}px`);
    const r = pop.getBoundingClientRect();
    let left = a.left;
    if (left + r.width > vw - PLACE_EDGE) left = a.right - r.width;
    left = Math.max(PLACE_EDGE, Math.min(left, vw - PLACE_EDGE - r.width));
    const top = up ? a.top - PLACE_OFFSET - r.height : a.bottom + PLACE_OFFSET;
    s.left = `${Math.round(left)}px`;
    s.top = `${Math.round(Math.max(PLACE_EDGE, top))}px`;
    if (up) pop.setAttribute("data-flip", "up");
    else pop.removeAttribute("data-flip");
    return up ? "up" : "down";
  }

  // Keep the active option in view by moving the scroll layer's own
  // scrollTop, with scrollIntoView's "nearest" rule (only when it is outside,
  // by the least amount). Never li.scrollIntoView(): that also scrolls every
  // scrollable ancestor -- the options document, or in the library the list
  // and detail columns, which jumped (spec 2026-10-03 library redesign §8.1).
  function reveal(list, li) {
    const box = list.getBoundingClientRect();
    const top = box.top + list.clientTop;
    const bottom = top + list.clientHeight;
    const r = li.getBoundingClientRect();
    if (r.top < top) list.scrollTop -= top - r.top;
    else if (r.bottom > bottom) list.scrollTop += r.bottom - bottom;
  }

  function setActive(state, i) {
    const items = state.list.children;
    if (items[state.active]) items[state.active].removeAttribute("data-active");
    state.active = i;
    const li = items[i];
    if (!li) { state.btn.removeAttribute("aria-activedescendant"); return; }
    li.setAttribute("data-active", "");
    state.btn.setAttribute("aria-activedescendant", li.id);
    if (!state.pop.hidden) reveal(state.list, li);
  }

  // Ghost face: icon + short label of the selected option. Rebuilt only when
  // either changes; the button's title belongs to the consumer. An option
  // with no drawable icon (no data-face-icon, or a key PBP_ICONS lacks) gets
  // its label span alone: setBtnIcon would still write an empty .btn-ic, and
  // the .btn family's gap would open a blank slot beside the label.
  function syncFace(state) {
    const opt = state.select.selectedOptions[0] || null;
    const label = opt?.dataset.faceLabel || optionText(opt);
    const key = opt?.dataset.faceIcon || "";
    const icon = key && typeof PBP_ICONS === "object" && PBP_ICONS && PBP_ICONS[key] ? key : "";
    const face = `${icon}\n${label}`;
    if (state.face === face) return;
    state.face = face;
    if (icon && typeof setBtnIcon === "function") {
      setBtnIcon(state.btn, icon, label);
    } else {
      const text = document.createElement("span");
      text.textContent = label;
      state.btn.replaceChildren(text);
    }
  }

  function sync(state) {
    const { select, list } = state;
    const opts = select.options;
    // Reuse the <li> nodes: ids stay stable, no listener lives on them (the
    // list owns one delegated handler), so repeated syncs leak nothing.
    while (list.children.length > opts.length) list.lastElementChild.remove();
    for (let i = 0; i < opts.length; i++) {
      let li = list.children[i];
      if (!li) {
        li = document.createElement("li");
        li.className = "listbox-opt";
        li.setAttribute("role", "option");
        list.appendChild(li);
      }
      li.id = `${select.id}-opt-${i}`;
      li.dataset.value = opts[i].value;
      const text = optionText(opts[i]);
      if (li.textContent !== text) li.textContent = text;
      li.setAttribute("aria-selected", i === select.selectedIndex ? "true" : "false");
      if (opts[i].disabled) li.setAttribute("aria-disabled", "true");
      else li.removeAttribute("aria-disabled");
    }
    if (state.ghost) {
      syncFace(state);
    } else {
      state.value.textContent = optionText(select.selectedOptions[0]);
      let longest = "";
      for (const opt of opts) { const text = optionText(opt); if (text.length > longest.length) longest = text; }
      if (state.sizer.textContent !== longest) state.sizer.textContent = longest;
    }
    state.btn.disabled = select.disabled;
    if (!state.pop.hidden) setActive(state, Math.min(state.active, opts.length - 1));
  }

  function onOutside(state, ev) {
    if (!state.root.contains(ev.target)) close(state);
  }

  function open(state, activeIndex) {
    if (!state.pop.hidden) return;
    const { pop, btn } = state;
    pop.removeAttribute("data-flip");
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    if (state.float) {
      // Top layer first: a popover that is not showing has no box to measure.
      try { pop.showPopover(); }
      catch (err) { console.warn("[listbox] showPopover failed:", err?.name, err?.message); }
      place(pop, btn);
      // The anchor's box the panel was placed against: onScroll compares.
      state.anchorRect = btn.getBoundingClientRect();
      window.addEventListener("resize", state.onResize);
      document.addEventListener("scroll", state.onScroll, true);
    } else {
      // Flip above when the list would overrun the viewport bottom and the
      // room above is larger. Measured once per open; the side is an
      // attribute the CSS positions by. --listbox-room is the border-box
      // height the chosen side has inside the viewport (the anchor gap and an
      // 8px edge off), same contract as place(): the surface CSS clamps the
      // scroll layer with it. Without that clamp a list opened from mid-page
      // in a short window ran past the viewport bottom, and since moving the
      // active option scrolls only the list (reveal), End / PageDown put the
      // active option out of sight.
      pop.style.removeProperty("--listbox-room");
      const listRect = pop.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      const viewH = window.innerHeight || document.documentElement.clientHeight;
      const gap = Math.max(0, listRect.top - btnRect.bottom);
      const below = Math.max(0, viewH - btnRect.bottom - gap - PLACE_EDGE);
      const above = Math.max(0, btnRect.top - gap - PLACE_EDGE);
      const up = listRect.bottom > viewH && btnRect.top > viewH - btnRect.bottom;
      if (up) pop.setAttribute("data-flip", "up");
      pop.style.setProperty("--listbox-room", `${Math.floor(up ? above : below)}px`);
    }
    const current = state.select.selectedIndex;
    const start = Number.isInteger(activeIndex) ? activeIndex
      : (isEnabled(state, current) ? current : firstEnabled(state));
    state.active = -1;
    setActive(state, start);
    document.addEventListener("pointerdown", state.outside, true);
  }

  function close(state) {
    if (state.pop.hidden) return;
    document.removeEventListener("pointerdown", state.outside, true);
    if (state.float) {
      window.removeEventListener("resize", state.onResize);
      document.removeEventListener("scroll", state.onScroll, true);
      try { if (state.pop.matches(":popover-open")) state.pop.hidePopover(); }
      catch (err) { console.warn("[listbox] hidePopover failed:", err?.name, err?.message); }
    }
    const items = state.list.children;
    if (items[state.active]) items[state.active].removeAttribute("data-active");
    state.pop.hidden = true;
    state.pop.removeAttribute("data-flip");
    state.btn.setAttribute("aria-expanded", "false");
    state.btn.removeAttribute("aria-activedescendant");
    clearTimeout(state.typedTimer);
    state.typedTimer = 0;
    state.typed = "";
  }

  function commit(state, i) {
    const { select } = state;
    if (!isEnabled(state, i)) return false;
    if (select.selectedIndex !== i) {
      select.selectedIndex = i;
      // Native order: input, then change. Both bubble so delegated listeners
      // (the autosave table in options.js) see them. The select's own change
      // listener below re-syncs the button.
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    sync(state);
    return true;
  }

  function typeahead(state, ch) {
    clearTimeout(state.typedTimer);
    state.typed += ch.toLowerCase();
    state.typedTimer = setTimeout(() => { state.typed = ""; }, TYPEAHEAD_MS);
    const opts = state.select.options;
    const n = opts.length;
    // A fresh single letter searches from the option after the active one (so
    // repeating it cycles); a longer buffer re-tests the active one first.
    const offset = state.typed.length === 1 ? 1 : 0;
    const from = state.active < 0 ? 0 : state.active;
    for (let k = 0; k < n; k++) {
      const i = (from + offset + k) % n;
      if (isEnabled(state, i) && optionText(opts[i]).toLowerCase().startsWith(state.typed)) {
        setActive(state, i);
        return;
      }
    }
  }

  function onKeydown(state, ev) {
    const { key, altKey, ctrlKey, metaKey } = ev;
    const isOpen = !state.pop.hidden;
    const printable = key.length === 1 && !ctrlKey && !metaKey && !altKey;
    if (!isOpen) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        ev.preventDefault();
        open(state);
      } else if (key === "Home" || key === "End") {
        ev.preventDefault();
        open(state, key === "Home" ? firstEnabled(state) : lastEnabled(state));
      } else if (printable) {
        ev.preventDefault();
        open(state);
        typeahead(state, key);
      }
      return;
    }
    switch (key) {
      case "ArrowDown":
        ev.preventDefault();
        setActive(state, step(state, state.active, 1));
        return;
      case "ArrowUp":
        ev.preventDefault();
        if (altKey) { commit(state, state.active); close(state); return; }
        setActive(state, step(state, state.active, -1));
        return;
      case "Home":
        ev.preventDefault(); setActive(state, firstEnabled(state)); return;
      case "End":
        ev.preventDefault(); setActive(state, lastEnabled(state)); return;
      case "PageDown":
        ev.preventDefault(); setActive(state, settle(state, state.active + PAGE_STEP, 1)); return;
      case "PageUp":
        ev.preventDefault(); setActive(state, settle(state, state.active - PAGE_STEP, -1)); return;
      case "Enter":
        ev.preventDefault(); commit(state, state.active); close(state); return;
      case " ":
        ev.preventDefault();
        if (state.typed) { typeahead(state, key); return; }
        commit(state, state.active); close(state); return;
      case "Escape":
        ev.preventDefault(); close(state); return;
      case "Tab":
        // Commit and close, but leave the default alone: focus moves on
        // normally (no trap).
        commit(state, state.active); close(state); return;
      default:
        if (printable) { ev.preventDefault(); typeahead(state, key); }
    }
  }

  function enhance(select) {
    if (!select || select.tagName !== "SELECT" || !select.id) return null;
    const existing = states.get(select);
    if (existing) return existing;
    const id = select.id;
    const float = select.getAttribute("data-listbox") === "float";
    const ghost = select.getAttribute("data-listbox-face") === "ghost";

    const root = document.createElement("div");
    root.className = "listbox";
    const btn = document.createElement("button");
    btn.type = "button";
    // The ghost face is a menu trigger, not a value box: it never carries
    // .listbox-btn, which ui-contract and FIELD_TARGETS treat as one.
    if (ghost) btn.className = "listbox-trigger btn ghost";
    else btn.className = "listbox-btn";
    btn.id = `${id}-btn`;
    btn.setAttribute("role", "combobox");
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", `${id}-list`);
    let value = null;
    let sizer = null;
    if (!ghost) {
      value = document.createElement("span");
      value.className = "listbox-value";
      const ic = document.createElement("span");
      ic.className = "btn-ic";
      ic.setAttribute("aria-hidden", "true");
      ic.innerHTML = chevron();   // static PBP_ICONS constant, never page content
      sizer = document.createElement("span");
      sizer.className = "listbox-sizer";
      sizer.setAttribute("aria-hidden", "true");
      btn.append(value, ic, sizer);
    }
    const pop = document.createElement("div");
    pop.className = "listbox-pop";
    pop.hidden = true;
    if (float) pop.setAttribute("popover", "manual");
    const list = document.createElement("ul");
    list.className = "listbox-list";
    list.id = `${id}-list`;
    list.setAttribute("role", "listbox");
    list.setAttribute("tabindex", "-1");
    pop.appendChild(list);

    // Name: the select's own aria-labelledby wins; otherwise the label[for]
    // that pointed at the select (re-pointed at the button below).
    const label = [...document.querySelectorAll("label[for]")].find((el) => el.htmlFor === id) || null;
    let labelledBy = select.getAttribute("aria-labelledby");
    if (!labelledBy && label) {
      if (!label.id) label.id = `${id}-label`;
      labelledBy = label.id;
    }
    if (labelledBy) {
      btn.setAttribute("aria-labelledby", labelledBy);
      list.setAttribute("aria-labelledby", labelledBy);
    }

    root.append(btn, pop);
    select.after(root);
    select.hidden = true;
    // Re-point the label only once the button is in the page: if anything
    // above threw, the native select keeps both its label and its visibility.
    if (label) label.htmlFor = btn.id;

    const state = {
      select, root, btn, pop, list, value, sizer, float, ghost, face: "",
      active: -1, typed: "", typedTimer: 0, outside: null, onResize: null, onScroll: null, anchorRect: null,
    };
    state.outside = (ev) => onOutside(state, ev);
    state.onResize = () => close(state);
    // An outer scroll closes the panel only when it carried the button away
    // from where the panel was placed (> 1px either axis): a scroll event
    // still queued from before the open, or touchpad inertia in another pane,
    // moves nothing here and must not close a list the user just opened.
    state.onScroll = (ev) => {
      if (ev.target === state.list) return;
      const was = state.anchorRect;
      const now = state.btn.getBoundingClientRect();
      if (!was || Math.abs(now.left - was.left) > 1 || Math.abs(now.top - was.top) > 1) close(state);
    };

    btn.addEventListener("click", () => {
      if (state.pop.hidden) open(state); else close(state);
    });
    // A label click only focuses, as it does for a native select; without
    // this the label's activation behaviour clicks the button and opens the
    // list. (An open list is closed first by the outside pointerdown.)
    if (label) label.addEventListener("click", (ev) => { ev.preventDefault(); btn.focus(); });
    btn.addEventListener("keydown", (ev) => onKeydown(state, ev));
    btn.addEventListener("blur", () => close(state));
    // Keep focus on the button while the pointer works the list.
    pop.addEventListener("mousedown", (ev) => ev.preventDefault());
    list.addEventListener("click", (ev) => {
      const li = ev.target.closest?.(".listbox-opt");
      if (!li || !list.contains(li)) return;
      const i = [...list.children].indexOf(li);
      if (!commit(state, i)) return;   // disabled: stays open, value unchanged
      close(state);
      btn.focus();
    });
    list.addEventListener("pointermove", (ev) => {
      const li = ev.target.closest?.(".listbox-opt");
      if (!li || !list.contains(li)) return;
      const i = [...list.children].indexOf(li);
      if (i !== state.active && isEnabled(state, i)) setActive(state, i);
    });
    select.addEventListener("change", () => sync(state));

    states.set(select, state);
    enhanced.add(state);
    sync(state);
    return state;
  }

  window.pbpEnhanceListbox = (select) => {
    // Builders re-enhance after rebuilding their markup; drop the previous
    // run's detached states here too, not only on the next language switch.
    enhanced.forEach((state) => { if (!state.select.isConnected) enhanced.delete(state); });
    return enhance(select) ? true : false;
  };
  window.pbpListboxSync = (select) => {
    const state = select && states.get(select);
    if (state) sync(state);
  };
  window.pbpListboxPlace = (pop, anchor) => place(pop, anchor);

  // Builders that rebuild their markup (options.js renderExportTargets on a
  // panel reset) leave the previous run's state -- and its detached DOM --
  // in the Set; drop those here instead of re-syncing them forever.
  document.addEventListener("pbp:i18n-applied", () => {
    enhanced.forEach((state) => { if (state.select.isConnected) sync(state); else enhanced.delete(state); });
  });
  document.addEventListener("DOMContentLoaded", () => {
    const targets = [...document.querySelectorAll("select[data-listbox]")];
    try {
      for (const select of targets) {
        try { enhance(select); }
        catch (err) { console.warn("[listbox] enhance failed:", select.id, err?.name, err?.message); }
      }
    } finally {
      // First-frame gate: a surface may hide select[data-listbox] until this
      // attribute exists. Set even when a select failed -- its native control
      // then shows as the fallback.
      document.documentElement.setAttribute("data-listbox-ready", "");
    }
    // The page's own DOMContentLoaded work (applyI18n, settings loads) runs
    // after this handler; absorb its writes once more.
    requestAnimationFrame(() => targets.forEach((select) => window.pbpListboxSync(select)));
  }, { once: true });
})();
