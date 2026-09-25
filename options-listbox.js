// ============================================================
// Pinboard Bookmark Enhanced - Options listbox primitive
// ============================================================
// The one drawn <select> the settings page allows (COMPONENTS.md §6.4
// exception 2, spec stage2 §3). It enhances only `select[data-listbox]`:
//
//   select#<id>[hidden]          <- still the value carrier: options.js reads
//                                   and writes .value and listens for change
//   div.listbox
//     button.listbox-btn#<id>-btn[role=combobox]
//       span.listbox-value + span.btn-ic (PBP_ICONS.chevronDown)
//       span.listbox-sizer[aria-hidden]  <- longest option text, zero height:
//                                           max-content = widest option, as a
//                                           native select sizes itself
//     div.listbox-pop[hidden]        <- popover shell: border, radius, shadow,
//                                       overflow hidden (clips the scrollbar
//                                       into the rounded corners)
//       ul.listbox-list#<id>-list[role=listbox]   <- the scroll layer
//         li.listbox-opt#<id>-opt-<i>[role=option][aria-selected]
//
// Behaviour is the WAI-ARIA APG "select-only combobox": focus never leaves the
// button, aria-activedescendant names the active option. A pick writes
// select.value and dispatches bubbling input + change events, so every
// existing listener (autosave, provider fields, translate custom input) runs
// unchanged. The native select is never removed; it only gets `hidden` here,
// so a page where this script does not run keeps a usable native control.
//
// Programmatic .value writes fire no change event: call
// window.pbpListboxSync(select) after them (options.js does, at the two
// documented points). applyI18n() rewrites option text and then dispatches
// pbp:i18n-applied, which re-syncs every enhanced select.
(() => {
  "use strict";

  const TYPEAHEAD_MS = 500;
  const PAGE_STEP = 10;
  const states = new WeakMap();   // select -> state
  const enhanced = new Set();     // for the i18n re-sync; two entries on this page

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

  function setActive(state, i) {
    const items = state.list.children;
    if (items[state.active]) items[state.active].removeAttribute("data-active");
    state.active = i;
    const li = items[i];
    if (!li) { state.btn.removeAttribute("aria-activedescendant"); return; }
    li.setAttribute("data-active", "");
    state.btn.setAttribute("aria-activedescendant", li.id);
    if (!state.pop.hidden && typeof li.scrollIntoView === "function") li.scrollIntoView({ block: "nearest" });
  }

  function sync(state) {
    const { select, list, value } = state;
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
    value.textContent = optionText(select.selectedOptions[0]);
    let longest = "";
    for (const opt of opts) { const text = optionText(opt); if (text.length > longest.length) longest = text; }
    if (state.sizer.textContent !== longest) state.sizer.textContent = longest;
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
    // Flip above when the list would overrun the viewport bottom and the room
    // above is larger. Measured once per open; the attribute, not an inline
    // style, carries the result (the CSS owns the geometry).
    const listRect = pop.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const viewH = window.innerHeight || document.documentElement.clientHeight;
    if (listRect.bottom > viewH && btnRect.top > viewH - btnRect.bottom) pop.setAttribute("data-flip", "up");
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

    const root = document.createElement("div");
    root.className = "listbox";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "listbox-btn";
    btn.id = `${id}-btn`;
    btn.setAttribute("role", "combobox");
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", `${id}-list`);
    const value = document.createElement("span");
    value.className = "listbox-value";
    const ic = document.createElement("span");
    ic.className = "btn-ic";
    ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = chevron();   // static PBP_ICONS constant, never page content
    const sizer = document.createElement("span");
    sizer.className = "listbox-sizer";
    sizer.setAttribute("aria-hidden", "true");
    btn.append(value, ic, sizer);
    const pop = document.createElement("div");
    pop.className = "listbox-pop";
    pop.hidden = true;
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
    if (label) label.htmlFor = btn.id;

    root.append(btn, pop);
    select.after(root);
    select.hidden = true;

    const state = { select, root, btn, pop, list, value, sizer, active: -1, typed: "", typedTimer: 0, outside: null };
    state.outside = (ev) => onOutside(state, ev);

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

  window.pbpEnhanceListbox = (select) => (enhance(select) ? true : false);
  window.pbpListboxSync = (select) => {
    const state = select && states.get(select);
    if (state) sync(state);
  };

  // Builders that rebuild their markup (options.js renderExportTargets on a
  // panel reset) leave the previous run's state -- and its detached DOM --
  // in the Set; drop those here instead of re-syncing them forever.
  document.addEventListener("pbp:i18n-applied", () => {
    enhanced.forEach((state) => { if (state.select.isConnected) sync(state); else enhanced.delete(state); });
  });
  document.addEventListener("DOMContentLoaded", () => {
    const targets = [...document.querySelectorAll("select[data-listbox]")];
    targets.forEach(enhance);
    // options.js's own DOMContentLoaded work (applyI18n, provider fields, the
    // settings load) runs after this handler; absorb its writes once more.
    requestAnimationFrame(() => targets.forEach((select) => window.pbpListboxSync(select)));
  }, { once: true });
})();
