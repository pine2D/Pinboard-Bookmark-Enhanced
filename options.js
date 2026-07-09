document.addEventListener("DOMContentLoaded", async () => {
  initI18n();
  applyI18n();

  function pbpBindLooseLabels(root) {
    (root || document).querySelectorAll("label.bl:not([for])").forEach((label) => {
      const box = label.parentElement;
      const control = box && box.querySelector("input[id], select[id], textarea[id]");
      if (control) label.htmlFor = control.id;
    });
  }
  pbpBindLooseLabels(document);

  // W3: Lazy-init scaffolding for the appearance panel.
  // Hoisted to the top of DOMContentLoaded so the tab-switch handler and the
  // saved-tab restore (both below) can safely reference _initAppearancePanel.
  // The actual render depends on currentPresetKey + PINBOARD_THEMES, which
  // aren't initialized until the settings load completes much further down.
  // Until that bootstrap finishes, we record a pending request and flush it
  // when _appearancePanelBootReady flips to true.
  let _appearanceInited = false;
  let _appearancePanelBootReady = false;
  let _appearancePendingInit = false;
  let _pinboardThemesPromise = null;
  function _loadPinboardThemes() {
    if (_pinboardThemesPromise) return _pinboardThemesPromise;
    _pinboardThemesPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "pinboard-themes.js";
      s.onload = () => resolve();
      s.onerror = () => {
        _pinboardThemesPromise = null; // allow retry on transient failure
        reject(new Error("Failed to load pinboard-themes.js"));
      };
      document.head.appendChild(s);
    });
    return _pinboardThemesPromise;
  }
  async function _initAppearancePanel() {
    if (_appearanceInited) return;
    if (!_appearancePanelBootReady) { _appearancePendingInit = true; return; }
    _appearanceInited = true;
    try {
      await _loadPinboardThemes();
    } catch (e) {
      console.warn("[options] pinboard-themes lazy load failed:", e.message);
      _appearanceInited = false; // allow retry on next switch
      return;
    }
    renderPresetPreview();
  }

  // ---- Tags panel lazy-init ----
  let _tagGovInited = false;
  async function _initTagGovPanel() {
    if (_tagGovInited) return;
    _tagGovInited = true;
    const overview = $id("tag-gov-overview");
    // Bind Refresh UNCONDITIONALLY before the first load: when the initial
    // loadTagCounts failed (no token yet, offline), the gated binding left a dead
    // Refresh button and no recovery short of a full page reload (_tagGovInited
    // never resets). Static #tag-gov-refresh from options.html (data-i18n
    // localized); updateTagGovOverview preserves it across re-renders.
    const refreshBtn = overview ? overview.querySelector("#tag-gov-refresh") : null;
    if (refreshBtn) refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      await chrome.storage.local.remove("_tagGovAiGroups");
      const fresh = await loadTagCounts(true);
      if (fresh) updateTagGovOverview(fresh);
      else _tagGovShowLoadFailed();
      await renderTagGov();
      await renderLowCountTags();
      refreshBtn.disabled = false;
    });
    const counts = await loadTagCounts();
    if (counts && overview) {
      updateTagGovOverview(counts);
    } else if (overview) {
      _tagGovShowLoadFailed();
    }
    // Restore the last run's outcome if it left anything needing attention —
    // all-ok runs are not resurrected (no nagging).
    if (_tagGovUnfinishedBatches === 0) {
      const lr = (await chrome.storage.local.get({ _tagGovLastRun: null }))._tagGovLastRun;
      if (lr && (lr.fail > 0 || lr.skipped > 0 || (lr.problems && lr.problems.length))) {
        await getTagGovToken(); // seed _tagGovUser so restored delete rows render t:-page links
        _tagGovProblems.length = 0;
        _tagGovProblems.push(...(lr.problems || []));
        const card = $id("tag-gov-progress");
        const fillEl = $id("tag-gov-progress-fill");
        const pt = $id("tag-gov-progress-text");
        if (card) card.classList.remove("hidden");
        if (fillEl) fillEl.style.width = "100%";
        if (pt) {
          pt.textContent = t("tagGovLastRun", new Date(lr.ts).toLocaleString()) + " "
            + t("tagGovDoneSummary", String(lr.ok), String(lr.fail))
            + (lr.skipped > 0 ? " · " + t("tagGovSkippedSummary", String(lr.skipped)) : "");
        }
        _tagGovSetProgressBtn("dismiss");
        renderTagGovProblems();
      }
    }

    // Link the bundles note to the user's bundles page on pinboard.in
    // (username = the part of the API token before the colon).
    const bundlesWarn = $id("tag-gov-bundles-warn");
    if (bundlesWarn && !bundlesWarn.querySelector("a")) {
      const user = (await getTagGovToken()).split(":")[0];
      if (user) {
        const a = document.createElement("a");
        a.href = "https://pinboard.in/u:" + encodeURIComponent(user) + "/bundles/";
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "pinboard.in/u:" + user + "/bundles/";
        bundlesWarn.appendChild(document.createTextNode(" "));
        bundlesWarn.appendChild(a);
      }
    }
    await renderTagGov();
    await renderLowCountTags();
  }

  // ---- Tab switching ----
  const _tabBtns = [...document.querySelectorAll(".tab-btn")];
  function activateTab(btn) {
    _tabBtns.forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); b.tabIndex = -1; });
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    btn.tabIndex = 0;
    $id(`panel-${btn.dataset.panel}`).classList.add("active");
    // W3: lazy-init expensive per-panel rendering on first view.
    if (btn.dataset.panel === "appearance") _initAppearancePanel();
    if (btn.dataset.panel === "tags") _initTagGovPanel();
    if (btn.dataset.panel === "storage") renderStoragePanel();
    if (btn.dataset.panel === "notes") renderNotesPanel();
    history.replaceState(null, "", "#" + btn.dataset.panel);
  }
  _tabBtns.forEach((btn, i) => {
    btn.tabIndex = btn.classList.contains("active") ? 0 : -1;
    btn.addEventListener("click", () => activateTab(btn));
    btn.addEventListener("keydown", (e) => {
      let n = -1;
      if (e.key === "ArrowDown") n = (i + 1) % _tabBtns.length;
      else if (e.key === "ArrowUp") n = (i - 1 + _tabBtns.length) % _tabBtns.length;
      else return;
      e.preventDefault();
      activateTab(_tabBtns[n]);
      _tabBtns[n].focus();
    });
  });

  // Restore active tab after language switch
  const savedTab = sessionStorage.getItem("activeTab");
  if (savedTab) {
    sessionStorage.removeItem("activeTab");
    const btn = document.querySelector(`.tab-btn[data-panel="${savedTab}"]`);
    if (btn) btn.click();
  }

  // Deep-link: options.html#<panel> activates that tab on load and when a
  // reused options tab is retargeted to a different hash.
  function _activateHashPanel() {
    const _hashPanel = (location.hash || "").replace(/^#/, "");
    if (!_hashPanel) return;
    const _dlBtn = document.querySelector(`.tab-btn[data-panel="${_hashPanel}"]`);
    if (_dlBtn) _dlBtn.click();
  }
  _activateHashPanel();
  window.addEventListener("hashchange", _activateHashPanel);

  // ---- Storage management (C2-6) ----
  // Category checkboxes over the reclaimable-cache allowlist in shared.js.
  // Defaults: large+cheap-to-rebuild caches checked; tag cache off (clearing it
  // briefly slows tag autocomplete).
  const STORAGE_CATS = [
    { id: "jina", labelKey: "storageCatJina", defaultOn: true },
    { id: "urls", labelKey: "storageCatUrls", defaultOn: true },
    { id: "tags", labelKey: "storageCatTags", defaultOn: false },
    { id: "misc", labelKey: "storageCatMisc", defaultOn: true },
  ];
  function showStorageStatus(msg, kind) {
    const el = $id("storage-status");
    if (!el) return;
    el.textContent = msg;
    // Reuse the AA-tuned .et-test-status colors (.ok/.err/.warn) already themed
    // across all presets, rather than the popup-only status-msg classes.
    el.className = "et-test-status " + (kind || "");
    el.classList.remove("hidden");
  }
  async function renderStoragePanel() {
    const host = $id("storage-cats");
    if (!host) return;
    let measured = null;
    try { measured = await pbpMeasureLocalStorage(); } catch (_) { measured = null; }
    host.textContent = "";
    if (!measured) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = t("storageMeasureFailed");
      host.appendChild(p);
      return;
    }
    let total = 0;
    STORAGE_CATS.forEach((c) => {
      const m = measured[c.id] || { keys: [], bytes: 0 };
      total += m.bytes;
      const row = document.createElement("div");
      row.className = "fg";
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "storage-cat-cb";
      cb.dataset.cat = c.id;
      cb.checked = c.defaultOn;
      cb.disabled = m.keys.length === 0;
      const span = document.createElement("span");
      span.textContent = `${t(c.labelKey)} — ${pbpFormatBytes(m.bytes)} (${m.keys.length})`;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" "));
      label.appendChild(span);
      row.appendChild(label);
      host.appendChild(row);
    });
    const totalP = document.createElement("p");
    totalP.className = "hint";
    totalP.textContent = t("storageReclaimable", pbpFormatBytes(total));
    host.appendChild(totalP);
  }
  const _storageClearBtn = $id("storage-clear-btn");
  if (_storageClearBtn) {
    _storageClearBtn.addEventListener("click", async () => {
      const cats = [...document.querySelectorAll(".storage-cat-cb:checked")].map((cb) => cb.dataset.cat);
      if (!cats.length) { showStorageStatus(t("storageNoneSelected"), "warn"); return; }
      _storageClearBtn.disabled = true;
      let freed = 0;
      try {
        freed = await pbpReclaimLocalStorage(cats);
      } catch (_) {
        showStorageStatus(t("storageClearFailed"), "err");
        _storageClearBtn.disabled = false;
        return;
      }
      await renderStoragePanel();
      _storageClearBtn.disabled = false;
      showStorageStatus(t("storageCleared", pbpFormatBytes(freed)), "ok");
    });
  }

  // ---- Reset current tab to defaults ----
  const PANEL_DEFAULTS = {
    general: {
      fields: {
        "opt-lang": "auto",
        "opt-backup-include-highlights": true,
        "notify-quick-save": true, "notify-read-later": true, "notify-tab-set": true,
        "notify-batch-save": true, "notify-errors": true
      },
      skip: ["opt-pinboard-token", "opt-sync-enabled"] // never reset token or sync toggle
    },
    popup: {
      fields: {
        "opt-check-bookmark-status": true, "opt-auto-close": true, "offline-queue-enabled": true,
        "opt-show-search": false, "opt-show-recent": false, "opt-show-badge": false,
        "opt-show-suggest-tags": true,
        "opt-show-ai-summary": true, "opt-show-ai-tags": true,
        "opt-show-quick-links": true, "opt-show-quick-row": true,
        "opt-popup-width-custom": "550"
      },
      radios: { "popup-width-preset": "550" },
      nested: {
        urlClean: {
          "opt-urlclean-enabled": true, "opt-urlclean-on-open": true, "opt-urlclean-on-paste": true,
          "opt-urlclean-aggressive": false, "opt-urlclean-custom": [], "opt-urlclean-exclude": []
        }
      }
    },
    bookmarks: {
      fields: {
        "opt-private-default": false, "opt-private-incognito": true, "opt-readlater-default": false,
        "opt-auto-description": true, "opt-blockquote": true, "opt-include-referrer": false,
        "opt-respect-tag-case": true, "opt-tag-presets": "",
        "opt-bgsave-merge": true, "opt-bgsave-skip": false, "opt-bgsave-overwrite": false
      },
      radios: { "tag-sync-mode": "cached" }
    },
    ai: {
      fields: {
        "opt-ai-provider": "gemini",
        "opt-gemini-model": "gemini-2.5-flash-lite", "opt-openai-model": "gpt-5.4-nano",
        "opt-openai-baseurl": "https://api.openai.com/v1", "opt-claude-model": "claude-haiku-4-5",
        "opt-deepseek-model": "deepseek-v4-flash", "opt-qwen-model": "qwen-flash",
        "opt-minimax-model": "MiniMax-M2", "opt-openrouter-model": "meta-llama/llama-4-scout:free",
        "opt-groq-model": "llama-3.1-8b-instant", "opt-mistral-model": "mistral-small-latest",
        "opt-cohere-model": "command-r7b-12-2024", "opt-siliconflow-model": "Qwen/Qwen3-8B",
        "opt-zhipu-model": "glm-4.7-flash", "opt-kimi-model": "kimi-k2.6",
        "opt-ollama-baseurl": "http://localhost:11434", "opt-ollama-model": "llama3.2",
        "opt-custom-name": "Custom", "opt-custom-baseurl": "", "opt-custom-model": ""
      },
      skip: ["opt-gemini-key","opt-openai-key","opt-claude-key","opt-deepseek-key","opt-qwen-key","opt-minimax-key","opt-openrouter-key","opt-groq-key","opt-mistral-key","opt-cohere-key","opt-siliconflow-key","opt-zhipu-key","opt-kimi-key","opt-custom-key"]
    },
    "ai-behavior": {
      fields: {
        "opt-ai-tag-lang": "en", "opt-ai-summary-lang": "auto", "opt-ai-cache-duration": "60",
        "opt-ai-auto-tags": false, "opt-ai-tag-separator": "-",
        "opt-custom-tag-prompt": "", "opt-custom-summary-prompt": ""
      },
      radios: { "ai-content-source": "local" }
    },
    reader: {
      fields: {
        "opt-preview-ai-enabled": true, "opt-preview-skim": false, "opt-preview-ai-model": "",
        "translate-target-lang": "auto", "translate-target-lang-custom": "",
        "opt-translate-glossary": "", "opt-selection-trigger": "icon"
      }
    },
    quick: {
      fields: {
        "qs-auto-notes": true, "qs-blockquote": true, "qs-default-tags": "", "qs-ai-tags": false, "qs-ai-summary": false,
        "rl-auto-notes": true, "rl-blockquote": true, "rl-default-tags": "", "rl-ai-tags": false, "rl-ai-summary": false,
        "opt-batch-tag-enabled": true, "opt-batch-tag": "batch_saved",
        "batch-ai-tags": false, "batch-ai-summary": false, "batch-skip-existing": false
      }
    },
    markdown: {
      fields: {
        "opt-md-frontmatter": true, "opt-md-extended-meta": true,
        "opt-md-image-policy": "keep", "opt-md-include-toc": false,
        "opt-md-include-hl": true
      }
    },
    archive: {
      fields: {
        "opt-wayback-enabled": false, "opt-wayback-batch": false,
        "opt-wayback-s3key": "", "opt-wayback-s3secret": ""
      },
      skip: ["opt-wayback-s3key", "opt-wayback-s3secret"]
    },
    appearance: {
      fields: {
        "opt-theme": "auto", "opt-popup-follow-theme": true, "opt-custom-font": "",
        "opt-custom-css": ""
      }
    },
    tags: {
      fields: { "opt-tag-sort-by-pop": true },
      skip: []
    },
    notes: {
      fields: {},
      skip: []
    }
  };
  if (typeof window !== "undefined") window.__PBP_PANEL_DEFAULTS = PANEL_DEFAULTS;

  // Gray out the Obsidian vault/folder inputs when the master toggle is off.
  // Safe to call on any page/panel (guards on element existence); programmatic
  // .checked changes (load, reset) don't fire 'change', so call it explicitly.
  // Render one settings card per export target from the registry. Inputs use
  // data-et="<id>.<key>" so saveSettings can collect them generically.
  function renderExportTargets(exportTargets) {
    const host = $id("export-targets");
    if (!host || typeof PBP_EXPORT_TARGETS === "undefined") return;
    host.innerHTML = "";
    exportTargets = exportTargets || {};
    pbpExportTargetIds().forEach((id) => {
      const row = PBP_EXPORT_TARGETS[id];
      const cfg = exportTargets[id] || {};

      const sec = document.createElement("div");
      sec.className = "accordion-section";
      const head = document.createElement("button");
      head.type = "button";
      head.className = "accordion-header";
      head.dataset.target = "et-" + id;
      head.setAttribute("aria-controls", head.dataset.target);
      const arrow = document.createElement("span");
      arrow.className = "accordion-arrow";
      const titleEl = document.createElement("span");
      titleEl.textContent = row.label;
      head.appendChild(arrow); head.appendChild(document.createTextNode(" ")); head.appendChild(titleEl);

      const card = document.createElement("div");
      card.className = "accordion-body export-target-card";
      card.id = "et-" + id;

      const enableLabel = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.et = id + ".enabled";
      cb.checked = !!cfg.enabled;
      const sp = document.createElement("span");
      sp.textContent = t("mdSendEnableTo").replace("{name}", row.label);
      enableLabel.appendChild(cb); enableLabel.appendChild(document.createTextNode(" ")); enableLabel.appendChild(sp);
      card.appendChild(enableLabel);

      (row.settings || []).forEach((s) => {
        if (s.type !== "text" && s.type !== "secret" && s.type !== "select") return;
        const wrap = document.createElement("div");
        wrap.className = "et-field";
        const lab = document.createElement("label");
        lab.className = "bl";
        lab.textContent = t(s.label);
        const inp = document.createElement(s.type === "select" ? "select" : "input");
        if (s.type !== "select") {
          inp.type = s.type === "secret" ? "password" : "text";
          inp.autocomplete = "off";
        }
        inp.id = id + "-" + s.key;
        lab.htmlFor = inp.id;
        inp.dataset.et = id + "." + s.key;
        if (s.type === "secret") {
          inp.dataset.secret = "1";
          inp.value = (typeof deobfuscateKey === "function") ? deobfuscateKey(cfg[s.key] || "") : (cfg[s.key] || "");
        } else if (s.type === "select") {
          (s.options || []).forEach((opt) => {
            const o = document.createElement("option");
            o.value = opt.value;
            o.textContent = t(opt.label);
            inp.appendChild(o);
          });
          inp.value = cfg[s.key] || s.default || ((s.options && s.options[0] && s.options[0].value) || "");
        } else {
          inp.value = cfg[s.key] || "";
        }
        if (s.placeholder) inp.placeholder = s.placeholder;
        wrap.appendChild(lab); wrap.appendChild(inp);
        card.appendChild(wrap);
        // Webhook URL: warn (never block — self-hosted/LAN http is a
        // legitimate opt-in target) when the Authorization header would ride
        // in plaintext (audit #31).
        if (id === "webhook" && s.key === "url") {
          const warn = document.createElement("p");
          warn.className = "hint hint-warn";
          warn.hidden = true;
          warn.textContent = t("mdTargetWebhookHttpWarn");
          const syncWarn = () => {
            warn.hidden = !(typeof pbpWebhookHttpWarn === "function" && pbpWebhookHttpWarn(inp.value.trim()));
          };
          inp.addEventListener("input", syncWarn);
          syncWarn();
          card.appendChild(warn);
        }
      });

      if (row.onboarding) {
        const det = document.createElement("details");
        det.className = "et-onboarding";
        const sum = document.createElement("summary");
        sum.textContent = t("mdSendHowToSetUp");
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = t(row.onboarding);
        det.appendChild(sum); det.appendChild(p);
        card.appendChild(det);
      }
      if (row.precheckRequest) {
        const testWrap = document.createElement("div");
        testWrap.className = "et-field et-test";
        const testBtn = document.createElement("button");
        testBtn.type = "button";
        testBtn.className = "btn btn-sm";
        testBtn.textContent = t("mdSendTest");
        const testStatus = document.createElement("span");
        testStatus.className = "et-test-status";
        testBtn.addEventListener("click", async () => {
          const tokenInp = card.querySelector('[data-et="' + id + '.token"]');
          const portInp = card.querySelector('[data-et="' + id + '.port"]');
          const token = (tokenInp && tokenInp.value.trim()) || "";
          const port = (portInp && portInp.value.trim()) || "";
          testStatus.className = "et-test-status";
          if (!token) { testStatus.classList.add("warn"); testStatus.textContent = t("mdSendTestNoToken"); return; }
          testStatus.textContent = t("mdSending");
          try {
            const granted = await chrome.permissions.request({ origins: [row.origin] });
            if (!granted) { testStatus.classList.add("err"); testStatus.textContent = t("mdSendTestPerm"); return; }
          } catch (_) {}
          try {
            const pr = row.precheckRequest({ port }, token);
            const resp = await fetch(pr.url, { method: pr.method, headers: pr.headers, body: pr.body });
            if (resp.status === 401) { testStatus.classList.add("err"); testStatus.textContent = t("mdSendTestBadToken"); }
            else if (!resp.ok) { testStatus.classList.add("err"); testStatus.textContent = t("mdSendTestDown"); }
            else { testStatus.classList.add("ok"); testStatus.textContent = t("mdSendTestOk"); }
          } catch (_) { testStatus.classList.add("err"); testStatus.textContent = t("mdSendTestDown"); }
        });
        testWrap.appendChild(testBtn); testWrap.appendChild(testStatus);
        card.appendChild(testWrap);
      }
      sec.appendChild(head); sec.appendChild(card);
      host.appendChild(sec);
    });
    pbpAccRestore(host);
  }

  // Collect the rendered target cards back into an exportTargets object.
  function collectExportTargets() {
    const out = {};
    pbpExportTargetIds().forEach((id) => { out[id] = {}; });
    document.querySelectorAll("#export-targets [data-et]").forEach((el) => {
      const [id, key] = el.dataset.et.split(".", 2);
      if (!out[id]) out[id] = {};
      if (el.dataset.secret) out[id][key] = (typeof obfuscateKey === "function") ? obfuscateKey(el.value.trim()) : el.value.trim();
      else out[id][key] = el.type === "checkbox" ? el.checked : el.value.trim();
    });
    return out;
  }

  // Show the free-text language input only while the select sits on "custom".
  // Safe to call on any page/panel (guards on element existence); programmatic
  // .value changes (load, reset) don't fire 'change', so call it explicitly.
  function syncTranslateLangCustomState() {
    const sel = $id("translate-target-lang");
    const customEl = $id("translate-target-lang-custom");
    if (!sel || !customEl) return;
    customEl.classList.toggle("hidden", sel.value !== "custom");
  }

  // Resolution contract for the persisted translateTargetLang (read by
  // md-translate.js as a plain string -- it never sees this select):
  //   select on a non-custom option -> that option's code ("auto", "ja", ...)
  //   select on "custom"            -> trimmed free text from the custom input
  //   custom input empty            -> "auto"
  // The literal sentinel "custom" is therefore never persisted.
  function resolveTranslateTargetLang() {
    const sel = $id("translate-target-lang");
    if (!sel) return "auto";
    if (sel.value !== "custom") return sel.value;
    const customEl = $id("translate-target-lang-custom");
    return (customEl && customEl.value.trim()) || "auto";
  }

  // Reset a panel's controls to defaults. Handles three address modes that the
  // old id-only loop missed: (a) radio GROUPS addressed by name (popup-width,
  // tag-sync-mode, ai-content-source), (b) the nested urlClean object, (c)
  // array-valued textareas (custom/exclude params join with newline → "").
  // Custom-overlay CSS clears via its normal opt-custom-css field reset above;
  // it then persists because the reset handler runs saveAll() right after this
  // (saveAll unconditionally calls saveOverlayWithFallback with the cleared value).
  function applyPanelReset(def, root) {
    for (const [id, val] of Object.entries(def.fields || {})) {
      const el = $id(id);
      if (!el) continue;
      // Radios reset via .checked like checkboxes (boolean = whether selected).
      // The old else-branch overwrote a radio's VALUE attribute with "true"/
      // "false" -- saveAll() then persisted bgSaveMode as "true", which the
      // background treats as overwrite (merge protection silently lost).
      if (el.type === "checkbox" || el.type === "radio") el.checked = val;
      else el.value = val;
    }
    // Radio groups by name → check the input whose value === the default.
    for (const [name, val] of Object.entries(def.radios || {})) {
      const r = root.querySelector(`input[name="${name}"][value="${val}"]`);
      if (r) r.checked = true;
    }
    // Nested objects (urlClean): map each member id → its default. Array
    // defaults (customParams/excludeParams) reduce to an empty textarea.
    for (const group of Object.values(def.nested || {})) {
      for (const [id, dflt] of Object.entries(group)) {
        const el = $id(id);
        if (!el) continue;
        if (el.type === "checkbox") el.checked = !!dflt;
        else el.value = Array.isArray(dflt) ? dflt.join("\n") : dflt;
      }
    }
  }
  // Test hook (browser test harness; no-op in normal page).
  if (typeof window !== "undefined") window.__PBP_applyPanelReset = applyPanelReset;

  $id("reset-panel-btn").addEventListener("click", function () {
    const resetBtn = this;
    const activeBtn = document.querySelector(".tab-btn.active");
    if (!activeBtn) return;
    const panel = activeBtn.dataset.panel;
    const def = PANEL_DEFAULTS[panel];
    if (!def) return;
    showConfirmPopover(resetBtn, {
      msg: t("resetConfirm", activeBtn.textContent) + (def.skip ? t("resetKeysKept") : ""),
      yesText: t("reset"),
      noText: t("cancel"),
      onConfirm: () => {
        applyPanelReset(def, document);
        // export-targets has no static fields; reset = re-render with defaults (all disabled).
        // Must run BEFORE saveAll() so collectExportTargets() sees cleared cards, not stale ones.
        if (panel === "markdown") renderExportTargets({});
        saveAll();
        if (typeof def.after === "function") def.after();
        syncTranslateLangCustomState();
      },
    });
  });

  // ---- Accordion sections ----
  // Accordion expand/collapse state, persisted device-locally (localStorage = synchronous
  // read at render = no open->collapse flash; same class as pp-i18n-* / pp-options-fields).
  const PP_ACC_KEY = "pp-acc";
  function pbpAccState() { try { return JSON.parse(localStorage.getItem(PP_ACC_KEY)) || {}; } catch (_) { return {}; } }
  function pbpAccSet(key, open) { const m = pbpAccState(); m[key] = open; try { localStorage.setItem(PP_ACC_KEY, JSON.stringify(m)); } catch (_) {} }
  // Apply persisted open/closed to every accordion-section that has a header data-target.
  function pbpAccRestore(root) {
    (root || document).querySelectorAll(".accordion-section").forEach((sec) => {
      const head = sec.querySelector(".accordion-header[data-target]");
      if (!head) return;
      const st = pbpAccState()[head.dataset.target];
      if (st === true) sec.classList.add("open");
      else if (st === false) sec.classList.remove("open");
      head.setAttribute("aria-expanded", String(sec.classList.contains("open")));
      // st === undefined -> leave the HTML default (.open or not)
    });
  }
  // Event delegation handles both static and dynamically-created accordion headers.
  document.addEventListener("click", (e) => {
    const header = e.target.closest(".accordion-header");
    if (!header) return;
    const sec = header.closest(".accordion-section");
    if (!sec) return;
    const isOpen = sec.classList.toggle("open");
    header.setAttribute("aria-expanded", String(isOpen));
    const key = header.dataset.target;
    if (key) pbpAccSet(key, isOpen);
  });

  // ---- API key show/hide toggle ----
  // SVG (not emoji) — emoji here triggered a 1-3s Segoe UI Emoji font-load stall
  // when the AI panel first rendered on Windows high-DPI. Set initial icon from JS
  // so the static HTML eye glyph never reaches layout.
  document.querySelectorAll(".key-toggle").forEach(btn => {
    btn.innerHTML = PBP_ICONS.eye;
    btn.addEventListener("click", () => {
      const input = $id(btn.dataset.target);
      if (input) {
        const isPassword = input.type === "password";
        input.type = isPassword ? "text" : "password";
        btn.innerHTML = isPassword ? PBP_ICONS.eyeOff : PBP_ICONS.eye;
      }
    });
  });

  // ---- All settings with defaults (from shared.js) ----
  await pbpMigrateSecretsToLocal();
  let s = await (await getSettingsStorage()).get(SETTINGS_DEFAULTS);
  s = await pbpApplySecretOverlay(s); // MUST run before deobfuscateSettings (see shared.js note)
  deobfuscateSettings(s);

  // ---- Schema v2 migration: split customCSS into themePresetKey + customOverlayCSS ----
  // Runs once per profile (guarded by _migrationV2), then stays dormant. Silently converts
  // un-migrated profiles so their old custom CSS keeps rendering; the one-time "upgraded"
  // banner + 7-day undo it used to show were removed once all undo windows had expired.
  const OVERLAY_BYTE_LIMIT = 50 * 1024;

  // The v2 theme-storage migration's one-time "upgraded" banner + 7-day undo were
  // removed (every undo window had long expired). Reclaim their now-dead local keys.
  chrome.storage.local.remove(["_migrationBackup", "_migrationBannerDismissed"]).catch(() => {});

  migrationV2: {
    const flags = await chrome.storage.sync.get({ _migrationV2: false });
    const oldCSSFromSync = await syncGetLarge("customCSS", "");
    let oldCSS = oldCSSFromSync;
    if (!oldCSS) {
      const localOldCSS = await chrome.storage.local.get({ customCSS: "" });
      if (localOldCSS.customCSS) oldCSS = localOldCSS.customCSS;
    }
    const oldKeyForMigration = s.themePresetKey || "";
    const hasOldData = !!oldCSS || !!oldKeyForMigration;
    if (!flags._migrationV2 && hasOldData) {
      try {
        // A2 Phase 3: migration uses PINBOARD_THEMES so we must load it now.
        // This is a one-time cost for un-migrated users; future opens skip this entire block.
        await _loadPinboardThemes();
      } catch (e) {
        console.error("[migrationV2] failed to load pinboard-themes.js", e);
        // Don't set _migrationV2 flag — will retry on next load
        break migrationV2;
      }
      // Resolve preset key: trust stored key, fall back to CSS-text reverse lookup
      let resolvedKey = oldKeyForMigration;
      if (!resolvedKey && oldCSS) {
        for (const [key, theme] of Object.entries(PINBOARD_THEMES)) {
          if (theme.css.trim() === oldCSS.trim()) { resolvedKey = key; break; }
        }
        // Adaptive parent fallback: catppuccin-latte → catppuccin
        if (resolvedKey) {
          for (const [parent, [light, dark]] of Object.entries(ADAPTIVE_THEME_MAP)) {
            if (resolvedKey === light || resolvedKey === dark) { resolvedKey = parent; break; }
          }
        }
      }
      // Decide overlay value (X1: equal to preset → empty; X2/X3: keep full)
      let newOverlay = "";
      if (oldCSS) {
        const preset = resolvedKey ? PINBOARD_THEMES[resolvedKey] : null;
        const presetCSS = preset ? preset.css : "";
        // Adaptive: also compare against light/dark variants
        const adaptiveVariants = ADAPTIVE_THEME_MAP[resolvedKey] || [];
        const allowed = [presetCSS, ...adaptiveVariants.map(k => PINBOARD_THEMES[k]?.css || "")];
        const matchesPreset = allowed.some(css => css && css.trim() === oldCSS.trim());
        newOverlay = matchesPreset ? "" : oldCSS;
      }
      try {
        // Cap overlay at 50KB; oversize → throw to skip migration (rare)
        if (newOverlay.length > OVERLAY_BYTE_LIMIT) {
          await chrome.storage.local.set({ customOverlayCSS_localFallback: newOverlay });
          await chrome.storage.sync.set({ optOverlayInLocal: true });
        } else {
          await syncSetLarge("customOverlayCSS", newOverlay);
          await chrome.storage.sync.set({ optOverlayInLocal: false });
        }
        // Persist resolved preset key in sync
        await chrome.storage.sync.set({ themePresetKey: resolvedKey || "" });
        // Cleanup old customCSS (sync chunks + local backup)
        const meta = await chrome.storage.sync.get("customCSS");
        if (meta.customCSS && meta.customCSS._chunks) {
          const oldChunks = Array.from({ length: meta.customCSS._chunks }, (_, i) => `customCSS_${i}`);
          await chrome.storage.sync.remove(["customCSS", ...oldChunks]);
        }
        await chrome.storage.local.remove("customCSS");
        await chrome.storage.sync.set({ _migrationV2: true });
        // Update s.* with new schema for the rest of the page init
        s.themePresetKey = resolvedKey || "";
        s.customOverlayCSS = newOverlay;
      } catch (e) {
        console.error("[migrationV2] failed", e);
        // Don't set _migrationV2 flag — will retry on next load
      }
    }
    // Always read overlay (post-migration or fresh install)
    if (s.customOverlayCSS === undefined) {
      const overlayFlags = await chrome.storage.sync.get({ optOverlayInLocal: false });
      if (overlayFlags.optOverlayInLocal) {
        const local = await chrome.storage.local.get({ customOverlayCSS_localFallback: "" });
        s.customOverlayCSS = local.customOverlayCSS_localFallback;
      } else {
        s.customOverlayCSS = await syncGetLarge("customOverlayCSS", "");
      }
    }
  }

  // ---- Fill text/password/select fields ----
  const fieldMap = {
    "opt-pinboard-token": s.pinboardToken,
    "opt-ai-provider": s.aiProvider,
    "opt-gemini-key": s.geminiApiKey, "opt-gemini-model": s.geminiModel,
    "opt-openai-key": s.openaiApiKey, "opt-openai-model": s.openaiModel, "opt-openai-baseurl": s.openaiBaseUrl,
    "opt-claude-key": s.claudeApiKey, "opt-claude-model": s.claudeModel,
    "opt-deepseek-key": s.deepseekApiKey, "opt-deepseek-model": s.deepseekModel,
    "opt-qwen-key": s.qwenApiKey, "opt-qwen-model": s.qwenModel,
    "opt-minimax-key": s.minimaxApiKey, "opt-minimax-model": s.minimaxModel,
    "opt-openrouter-key": s.openrouterApiKey, "opt-openrouter-model": s.openrouterModel,
    "opt-groq-key": s.groqApiKey, "opt-groq-model": s.groqModel,
    "opt-mistral-key": s.mistralApiKey, "opt-mistral-model": s.mistralModel,
    "opt-cohere-key": s.cohereApiKey, "opt-cohere-model": s.cohereModel,
    "opt-siliconflow-key": s.siliconflowApiKey, "opt-siliconflow-model": s.siliconflowModel,
    "opt-zhipu-key": s.zhipuApiKey, "opt-zhipu-model": s.zhipuModel,
    "opt-kimi-key": s.kimiApiKey, "opt-kimi-model": s.kimiModel,
    "opt-ollama-baseurl": s.ollamaBaseUrl, "opt-ollama-model": s.ollamaModel,
    "opt-custom-name": s.customName, "opt-custom-baseurl": s.customBaseUrl,
    "opt-custom-key": s.customApiKey, "opt-custom-model": s.customModel,
    "opt-ai-tag-lang": s.aiTagLang, "opt-ai-summary-lang": s.aiSummaryLang, "opt-ai-cache-duration": s.aiCacheDuration,
    "opt-custom-tag-prompt": s.customTagPrompt, "opt-custom-summary-prompt": s.customSummaryPrompt,
    "opt-batch-tag": s.optBatchTag, "opt-lang": s.optLang, "opt-theme": s.optTheme,
    "qs-default-tags": s.qsDefaultTags, "rl-default-tags": s.rlDefaultTags,
    "opt-custom-font": s.customFont, "opt-custom-css": s.customOverlayCSS,
    "opt-ai-tag-separator": s.aiTagSeparator,
    "opt-jina-key": s.jinaApiKey,
    "opt-tag-presets": s.tagPresets,
    "opt-wayback-s3key": s.waybackS3Key,
    "opt-wayback-s3secret": s.waybackS3Secret,
    "opt-preview-ai-model": s.previewAiModel,
    "opt-translate-glossary": s.translateGlossary,
    "opt-selection-trigger": s.selectionTrigger,
    "opt-webdav-url": s.webdavUrl,
    "opt-webdav-user": s.webdavUser,
    "opt-webdav-pass": s.webdavPass,
    "opt-webdav-autopush": s.webdavAutoPush || "off"
  };
  for (const [id, val] of Object.entries(fieldMap)) {
    const el = $id(id);
    if (el) el.value = val;
  }

  // Show default prompts as placeholder so users see them when field is empty
  $id("opt-custom-tag-prompt").placeholder = DEFAULT_TAG_PROMPT;
  $id("opt-custom-summary-prompt").placeholder = DEFAULT_SUMMARY_PROMPT;

  // AI Content Source radio
  const srcRadio = document.querySelector(`input[name="ai-content-source"][value="${s.aiContentSource || 'local'}"]`);
  if (srcRadio) srcRadio.checked = true;

  // Tag Sync Mode radio
  const tsRadio = document.querySelector(`input[name="tag-sync-mode"][value="${s.tagSyncMode || 'cached'}"]`);
  if (tsRadio) tsRadio.checked = true;

  // Background Save Mode radio
  const bsRadio = document.querySelector(`input[name="bgsave-mode"][value="${s.bgSaveMode || 'merge'}"]`);
  if (bsRadio) bsRadio.checked = true;

  // Markdown export image policy select
  const mdImgSel = $id("opt-md-image-policy");
  if (mdImgSel) mdImgSel.value = s.mdExportImagePolicy || "keep";
  // Migrate the legacy obsidian* keys into exportTargets.obsidian (one-time,
  // non-destructive — old keys stay readable as a fallback).
  const _et = s.exportTargets || {};
  if (!_et.obsidian && (s.obsidianEnabled || s.obsidianVault || s.obsidianFolder)) {
    _et.obsidian = { enabled: !!s.obsidianEnabled, vault: s.obsidianVault || "", folder: s.obsidianFolder || "" };
  }
  renderExportTargets(_et);
  pbpAccRestore(document); // restore all accordion states (static quick-actions + export targets)

  // ---- Fill checkbox fields ----
  const checkMap = {
    "opt-private-default": s.optPrivateDefault, "opt-private-incognito": s.optPrivateIncognito,
    "opt-readlater-default": s.optReadlaterDefault, "opt-auto-description": s.optAutoDescription,
    "opt-blockquote": s.optBlockquote, "opt-include-referrer": s.optIncludeReferrer,
    "opt-ai-auto-tags": s.optAiAutoTags,
    "qs-auto-notes": s.qsAutoNotes, "qs-blockquote": s.qsBlockquote,
    "qs-ai-tags": s.qsAiTags, "qs-ai-summary": s.qsAiSummary,
    "rl-auto-notes": s.rlAutoNotes, "rl-blockquote": s.rlBlockquote,
    "rl-ai-tags": s.rlAiTags, "rl-ai-summary": s.rlAiSummary,
    "opt-batch-tag-enabled": s.optBatchTagEnabled,
    "opt-backup-include-highlights": s.backupIncludeHighlights !== false,
    "batch-ai-tags": s.batchAiTags, "batch-ai-summary": s.batchAiSummary,
    "batch-skip-existing": s.batchSkipExisting,
    "opt-show-recent": s.optShowRecent, "opt-show-search": s.optShowSearch,
    "notify-quick-save": s.notifyQuickSave,
    "notify-read-later": s.notifyReadLater,
    "notify-tab-set": s.notifyTabSet, "notify-batch-save": s.notifyBatchSave,
    "notify-errors": s.notifyErrors,
    "opt-respect-tag-case": s.optRespectTagCase,
    "offline-queue-enabled": s.offlineQueueEnabled,
    "opt-show-badge": s.optShowBadge,
    "opt-check-bookmark-status": s.optCheckBookmarkStatus,
    "opt-show-suggest-tags": s.optShowSuggestTags,
    "opt-show-ai-summary": s.optShowAiSummary,
    "opt-show-ai-tags": s.optShowAiTags,
    "opt-show-quick-links": s.optShowQuickLinks,
    "opt-show-quick-row": s.optShowQuickRow,
    "opt-auto-close": s.optAutoCloseAfterSave,
    "opt-popup-follow-theme": s.optPopupFollowTheme,
    "opt-md-frontmatter": s.mdExportFrontmatter,
    "opt-md-extended-meta": s.mdExportExtendedMeta,
    "opt-md-include-toc": s.mdExportIncludeToc,
    "opt-md-include-hl": s.mdExportIncludeHighlights,
    "opt-tag-sort-by-pop": s.tagSortByPopEnabled,
    "opt-wayback-enabled": s.waybackArchiveEnabled === true,
    "opt-wayback-batch": s.waybackArchiveBatch === true,
    "opt-wayback-skip-private": s.waybackSkipPrivate !== false,
    "opt-preview-ai-enabled": s.previewAiEnabled !== false,
    "opt-preview-skim": s.previewSkimEnabled === true
  };
  for (const [id, val] of Object.entries(checkMap)) {
    const el = $id(id);
    if (el) el.checked = val;
  }
  // ---- Preview AI: translation target language (select + custom free-text) ----
  // Stored value is either an option code or a free-text language name; map it
  // back onto the two controls. Guard against a hand-edited backup that smuggled
  // in the "custom" sentinel (resolveTranslateTargetLang never persists it).
  {
    const sel = $id("translate-target-lang");
    const customEl = $id("translate-target-lang-custom");
    if (sel && customEl) {
      const stored = s.translateTargetLang || "auto";
      const codes = Array.from(sel.options).map(o => o.value);
      if (stored !== "custom" && codes.includes(stored)) {
        sel.value = stored;
      } else if (stored === "custom") {
        sel.value = "auto";
      } else {
        sel.value = "custom";
        customEl.value = stored;
      }
      syncTranslateLangCustomState();
      sel.addEventListener("change", syncTranslateLangCustomState);
    }
  }

  // ---- Popup width (B9) ----
  const popupWidth = Number(s.popupWidth) || 550;
  const presetValues = [450, 550, 650];
  if (presetValues.includes(popupWidth)) {
    const radio = document.querySelector(`input[name="popup-width-preset"][value="${popupWidth}"]`);
    if (radio) radio.checked = true;
  } else {
    const radio = document.querySelector(`input[name="popup-width-preset"][value="custom"]`);
    if (radio) radio.checked = true;
  }
  const customInput = $id("opt-popup-width-custom");
  if (customInput) {
    customInput.value = popupWidth;
    const selectCustomRadio = () => {
      const customRadio = document.querySelector('input[name="popup-width-preset"][value="custom"]');
      if (customRadio && !customRadio.checked) customRadio.checked = true;
    };
    customInput.addEventListener("focus", selectCustomRadio);
    customInput.addEventListener("input", selectCustomRadio);
    // Clamp + writeback only on blur/Enter — never during input,
    // because auto-save would re-clamp partial values (e.g. "6" → 420).
    const clampAndCommit = () => {
      const raw = parseInt(customInput.value, 10);
      if (isNaN(raw)) return;
      customInput.value = Math.max(420, Math.min(720, raw));
    };
    customInput.addEventListener("blur", clampAndCommit);
    customInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); clampAndCommit(); customInput.blur(); }
    });
  }

  // ---- URL Clean settings (B4) ----
  const urlClean = s.urlClean || { enabled: true, onPopupOpen: true, onPaste: true, aggressiveMode: false, customParams: [], excludeParams: [] };
  $id("opt-urlclean-enabled").checked = !!urlClean.enabled;
  $id("opt-urlclean-on-open").checked = !!urlClean.onPopupOpen;
  $id("opt-urlclean-on-paste").checked = !!urlClean.onPaste;
  $id("opt-urlclean-aggressive").checked = !!urlClean.aggressiveMode;
  $id("opt-urlclean-custom").value = (urlClean.customParams || []).join("\n");
  $id("opt-urlclean-exclude").value = (urlClean.excludeParams || []).join("\n");

  // ---- Load sync toggle (stored in local, not in settings storage) ----
  const { optSyncEnabled } = await chrome.storage.local.get({ optSyncEnabled: false });
  const syncToggle = $id("opt-sync-enabled");
  if (syncToggle) syncToggle.checked = optSyncEnabled;

  // ---- syncApiKeys (batch (4)): local-only meta-setting, same precedent as
  // optSyncEnabled -- NOT in SETTINGS_DEFAULTS, NOT in backup export, disabled
  // (grayed) whenever sync itself is off. Default unchecked (keys stay local).
  const { syncApiKeys } = await chrome.storage.local.get({ syncApiKeys: false });
  const syncKeysToggle = $id("opt-sync-api-keys");
  if (syncKeysToggle) {
    syncKeysToggle.checked = syncApiKeys;
    syncKeysToggle.disabled = !optSyncEnabled;
  }

  // Sync toggle change: migrate settings then reload
  syncToggle?.addEventListener("change", async () => {
    const enabling = syncToggle.checked;
    if (syncKeysToggle) syncKeysToggle.disabled = !enabling;
    const oldStorage = enabling ? chrome.storage.local : chrome.storage.sync;
    const newStorage = enabling ? chrome.storage.sync : chrome.storage.local;
    try {
      // 1. Migrate regular settings
      const data = await oldStorage.get(Object.keys(SETTINGS_DEFAULTS));
      // syncApiKeys secret routing (batch (4)): when ENABLING sync (local -> sync)
      // and the user has NOT opted API keys into sync, strip the 18
      // API_KEY_FIELDS + exportTargets tokens out of what's headed to sync and
      // keep the full copy local. Disabling (sync -> local): `data` is read from
      // SYNC via an array-form get, so when routing was already active the
      // API_KEY_FIELDS were never in sync -- simply absent from `data`.
      // `newStorage.set(data)` into local is safe only because
      // chrome.storage.set() MERGES rather than replaces: pre-existing local
      // secrets survive by omission, not by an explicit copy.
      if (enabling) {
        const { syncApiKeys } = await chrome.storage.local.get({ syncApiKeys: false });
        if (!syncApiKeys) {
          const { main, secrets } = pbpSplitSecretBatch(data);
          if (Object.keys(secrets).length) await chrome.storage.local.set(secrets);
          await newStorage.set(main);
        } else {
          await newStorage.set(data);
        }
      } else {
        await newStorage.set(data);
      }
      // 2. Migrate customOverlayCSS (large value) — read from old, then switch pref, then write to new
      const customOverlayCSS = await syncGetLarge("customOverlayCSS", "");
      const savedThemes = await syncGetLarge("savedThemes", []);
      await chrome.storage.local.set({ optSyncEnabled: enabling });
      await syncSetLarge("customOverlayCSS", customOverlayCSS);
      await syncSetLarge("savedThemes", savedThemes);
    } catch (e) {
      // Migration failed — revert toggle and abort
      console.error("sync migration failed:", e);
      syncToggle.checked = !enabling;
      await chrome.storage.local.set({ optSyncEnabled: !enabling });
      const errEl = $id("opt-sync-error");
      if (errEl) {
        errEl.textContent = t("syncMigrationFailed") || "Sync migration failed. Please try again or reduce custom CSS size.";
        errEl.classList.remove("hidden");
        setTimeout(() => errEl.classList.add("hidden"), 8000);
      }
      return;
    }
    // Fade out and reload
    const activePanel = document.querySelector(".tab-btn.active")?.dataset.panel || "general";
    sessionStorage.setItem("activeTab", activePanel);
    document.body.style.transition = "opacity 0.18s";
    document.body.style.opacity = "0";
    setTimeout(() => location.reload(), 180);
  });

  // syncApiKeys toggle: on = copy local secrets up to sync (opt back into cloud
  // keys, full exportTargets incl. token -- this IS opting in); off = scrub sync
  // back down, reusing the exact same idempotent routine SW boot runs.
  syncKeysToggle?.addEventListener("change", async () => {
    const enabling = syncKeysToggle.checked;
    try {
      if (enabling) {
        await pbpEnableSyncApiKeys();
      } else {
        await chrome.storage.local.set({ syncApiKeys: false });
        await pbpMigrateSecretsToLocal();
      }
    } catch (e) {
      console.error("syncApiKeys toggle failed:", e);
      syncKeysToggle.checked = !enabling;
      await chrome.storage.local.set({ syncApiKeys: !enabling }).catch(() => {});
    }
  });

  // ---- Apply options page theme based on Pinboard theme preset ----
  function applyOptionsPageTheme(presetKey, themeMode) {
    const prefersDark = themeMode === "dark" ||
      (themeMode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (ADAPTIVE_THEME_MAP[presetKey]) {
      const [light, dark] = ADAPTIVE_THEME_MAP[presetKey];
      document.documentElement.dataset.theme = prefersDark ? dark : light;
    } else if (presetKey) {
      document.documentElement.dataset.theme = presetKey;
    } else if (prefersDark) {
      document.documentElement.dataset.theme = "flexoki-dark";
    } else {
      delete document.documentElement.dataset.theme;
    }
  }
  // Track active preset key — schema v2: themePresetKey is authoritative
  let currentPresetKey = s.themePresetKey || "";
  applyOptionsPageTheme(currentPresetKey, s.optTheme);

  // Language change: save immediately and reload to apply
  $id("opt-lang").addEventListener("change", async () => {
    const lang = $id("opt-lang").value;
    const activePanel = document.querySelector(".tab-btn.active")?.dataset.panel || "general";
    await (await getSettingsStorage()).set({ optLang: lang });
    sessionStorage.setItem("activeTab", activePanel);
    document.body.style.transition = "opacity 0.18s";
    document.body.style.opacity = "0";
    // Prime the i18n mirror BEFORE reload so the reload's SYNC read is fresh —
    // otherwise renderExportTargets() and other t()-at-build-time labels paint the
    // PREVIOUS language (the mirror is normally written only after the async fetch).
    try {
      if (lang === "auto") {
        localStorage.setItem("pp-i18n-lang", "auto");
        localStorage.removeItem("pp-i18n-msgs");
      } else {
        const _r = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
        if (_r.ok) {
          localStorage.setItem("pp-i18n-lang", lang);
          localStorage.setItem("pp-i18n-msgs", JSON.stringify(await _r.json()));
        }
      }
    } catch (_) {}
    setTimeout(() => location.reload(), 180);
  });
  // Real-time switch when theme dropdown changes (affects options-page theme + preset preview)
  // Adaptive presets resolve to light/dark variant in pinboard-style.js content script;
  // options page only re-renders its own dataset.theme here.
  $id("opt-theme").addEventListener("change", () => {
    const mode = $id("opt-theme").value;
    applyOptionsPageTheme(currentPresetKey, mode);
    renderPresetPreview();
  });

  // ---- Provider field toggle ----
  const providers = ["gemini","openai","claude","deepseek","qwen","minimax","openrouter","groq","mistral","cohere","siliconflow","zhipu","kimi","ollama","custom"];
  function updateProviderFields() {
    const selected = $id("opt-ai-provider").value;
    providers.forEach(p => {
      const el = $id("fields-" + p);
      if (el) el.classList.toggle("hidden", p !== selected);
    });
  }
  updateProviderFields();
  $id("opt-ai-provider").addEventListener("change", updateProviderFields);

  // ---- Reset prompt buttons ----
  $id("reset-tag-prompt").addEventListener("click", () => {
    $id("opt-custom-tag-prompt").value = DEFAULT_TAG_PROMPT;
    saveAll();
  });
  $id("reset-summary-prompt").addEventListener("click", () => {
    $id("opt-custom-summary-prompt").value = DEFAULT_SUMMARY_PROMPT;
    saveAll();
  });

  // ---- Batch: revoke all-sites permission ----
  // Reflect current grant state on load
  (async () => {
    try {
      const has = await chrome.permissions.contains({ origins: ["*://*/*"] });
      const statusEl = $id("batch-perm-status");
      const btn = $id("batch-revoke-perm");
      if (!has) {
        if (statusEl) statusEl.textContent = t("batchPermNone");
        if (btn) btn.disabled = true;
      }
    } catch (_) {}
  })();

  $id("batch-revoke-perm")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    const orig = btn.textContent;
    try {
      const revoked = await chrome.permissions.remove({ origins: ["*://*/*"] });
      if (revoked) {
        btn.textContent = t("batchRevokeSuccess");
        if ($id("batch-perm-status")) $id("batch-perm-status").textContent = t("batchPermRevoked");
        btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; }, 2000);
      } else {
        if ($id("batch-perm-status")) $id("batch-perm-status").textContent = t("batchPermNone");
        btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    } catch (err) {
      console.error("revoke permission failed:", err);
      btn.textContent = t("batchRevokeFailed");
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }
  });

  // ---- Wayback: check permission on load ----
  (async () => {
    try {
      const has = await chrome.permissions.contains({ origins: ["https://web.archive.org/*"] });
      const statusEl = $id("wayback-perm-status");
      if (!has && s.waybackArchiveEnabled) {
        const toggle = $id("opt-wayback-enabled");
        if (toggle) toggle.checked = false;
        s.waybackArchiveEnabled = false;
        try { await (await getSettingsStorage()).set({ waybackArchiveEnabled: false }); } catch (_) {}
        if (statusEl) statusEl.textContent = t("waybackPermDenied");
      }
    } catch (_) {}
  })();

  // ---- Wayback: toggle permission on opt-wayback-enabled change ----
  $id("opt-wayback-enabled")?.addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    const statusEl = $id("wayback-perm-status");
    if (enabled) {
      try {
        const granted = await chrome.permissions.request({ origins: ["https://web.archive.org/*"] });
        if (!granted) {
          e.target.checked = false;
          // Programmatic .checked changes fire no 'change' event; re-dispatch so the
          // global auto-save persists the reverted (false) state via the normal path
          // (which picks the correct storage area). Re-entering this listener is safe:
          // it only acts when checked === true. Any transient true the debounced save
          // may have written mid-dialog is overwritten by this final false save.
          e.target.dispatchEvent(new Event("change", { bubbles: true }));
          if (statusEl) statusEl.textContent = t("waybackPermDenied");
          return;
        }
        if (statusEl) statusEl.textContent = "";
      } catch (err) {
        console.error("wayback permission request failed:", err);
        e.target.checked = false;
        // Same re-dispatch as the deny branch — ensures storage reflects false.
        e.target.dispatchEvent(new Event("change", { bubbles: true }));
        if (statusEl) statusEl.textContent = t("waybackPermDenied");
      }
    }
  });

  // ---- Wayback: clear the archive log (display only; keeps the _waybackAttempts
  // dedup map so just-saved URLs are not immediately re-archivable) ----
  $id("wayback-log-clear")?.addEventListener("click", async () => {
    try { await chrome.storage.local.remove("_waybackLog"); } catch (_) {}
    await renderWaybackLog();
  });

  // ---- WebDAV: http:// advisory warning ----
  // Reuses pbpWebhookHttpWarn (export-targets.js, already loaded by options.html):
  // Basic auth also rides the Authorization header, so the same plaintext-
  // credentials risk applies to a WebDAV URL as to a webhook URL.
  (() => {
    const inp = $id("opt-webdav-url");
    const warn = $id("webdav-http-warn");
    if (!inp || !warn) return;
    const syncWarn = () => {
      warn.hidden = !(typeof pbpWebhookHttpWarn === "function" && pbpWebhookHttpWarn(inp.value.trim()));
    };
    inp.addEventListener("input", syncWarn);
    syncWarn();
  })();

  // ---- WebDAV: config straight from the live form (never storage) ----
  // Avoids racing the 500ms debounced auto-save -- a click right after typing
  // a URL must not test/push/pull against a stale stored value.
  function _pbpWebdavCfgFromForm() {
    return {
      baseUrl: $id("opt-webdav-url").value.trim(),
      user: $id("opt-webdav-user").value.trim(),
      pass: $id("opt-webdav-pass").value.trim(),
      includeHighlights: $id("opt-backup-include-highlights").checked,
    };
  }

  // Same-gesture permission request (options-connectivity.js precedent):
  // request() resolves true with no prompt when already granted, so it is
  // safe to call on every click.
  async function _pbpWebdavRequestPermission(baseUrl) {
    const origin = (typeof pbpWebdavOrigin === "function") ? pbpWebdavOrigin(baseUrl) : null;
    if (!origin) return false;
    try { return await chrome.permissions.request({ origins: [origin] }); } catch (_) { return false; }
  }

  $id("opt-webdav-autopush")?.addEventListener("change", async (e) => {
    if (e.target.value === "off") return;
    const statusEl = $id("webdav-status");
    const cfg = _pbpWebdavCfgFromForm();
    const fail = (msgKey) => {
      e.target.value = "off";
      e.target.dispatchEvent(new Event("change", { bubbles: true }));
      if (statusEl) {
        setStatusIcon(statusEl, false, t(msgKey));
        statusEl.style.color = "#c00";
      }
    };
    if (!cfg.baseUrl || !(typeof pbpWebdavOrigin === "function" && pbpWebdavOrigin(cfg.baseUrl))) {
      fail("webdavTestUnreachable");
      return;
    }
    const granted = await _pbpWebdavRequestPermission(cfg.baseUrl);
    if (!granted) fail("webdavPermDenied");
    else if (statusEl) { statusEl.textContent = ""; statusEl.style.color = ""; }
  });

  // ---- WebDAV: render the persisted last-push status on page load ----
  (async () => {
    try {
      const { webdavLastPush } = await chrome.storage.local.get({ webdavLastPush: null });
      const statusEl = $id("webdav-status");
      if (!statusEl || !webdavLastPush) return;
      const when = new Date(webdavLastPush.ts).toLocaleString();
      if (webdavLastPush.ok) {
        setStatusIcon(statusEl, true, t("webdavPushOk", when));
      } else if (webdavLastPush.error === "perm") {
        setStatusIcon(statusEl, false, t("webdavPermDenied"));
      } else if (webdavLastPush.error === "not-writable") {
        setStatusIcon(statusEl, false, webdavLastPush.status ? t("webdavPushFail", "http-" + webdavLastPush.status) : t("webdavPushNotWritable"));
      } else if (webdavLastPush.error === "not-found") {
        setStatusIcon(statusEl, false, t("webdavTargetUnavailable"));
      } else {
        setStatusIcon(statusEl, false, t("webdavPushFail", webdavLastPush.error || ""));
      }
    } catch (_) {}
  })();

  // ---- WebDAV: Test ----
  $id("webdav-test-btn")?.addEventListener("click", async () => {
    const statusEl = $id("webdav-status");
    const cfg = _pbpWebdavCfgFromForm();
    if (!cfg.baseUrl || !statusEl) return;
    statusEl.textContent = t("testTesting");
    statusEl.style.color = "#888";
    const granted = await _pbpWebdavRequestPermission(cfg.baseUrl);
    if (!granted) {
      setStatusIcon(statusEl, false, t("webdavPermDenied"));
      statusEl.style.color = "#c00";
      setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
      return;
    }
    const res = await pbpWebdavTest(cfg);
    if (res.kind === "found") { setStatusIcon(statusEl, true, t("webdavTestOkFound")); statusEl.style.color = "#080"; }
    else if (res.kind === "empty") { setStatusIcon(statusEl, true, t("webdavTestOkEmpty")); statusEl.style.color = "#080"; }
    else if (res.kind === "auth") { setStatusIcon(statusEl, false, t("webdavTestAuthFail")); statusEl.style.color = "#c00"; }
    else if (res.kind === "not-writable") { setStatusIcon(statusEl, false, res.status ? t("webdavPushFail", "http-" + res.status) : t("webdavPushNotWritable")); statusEl.style.color = "#c00"; }
    else if (res.kind === "not-found") { setStatusIcon(statusEl, false, t("webdavTargetUnavailable")); statusEl.style.color = "#c00"; }
    else { setStatusIcon(statusEl, false, t("webdavTestUnreachable")); statusEl.style.color = "#c00"; }
    setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
  });

  // ---- WebDAV: Push now ----
  $id("webdav-push-btn")?.addEventListener("click", async () => {
    const statusEl = $id("webdav-status");
    const cfg = _pbpWebdavCfgFromForm();
    if (!cfg.baseUrl || !statusEl) return;
    statusEl.textContent = t("testTesting");
    statusEl.style.color = "#888";
    const granted = await _pbpWebdavRequestPermission(cfg.baseUrl);
    if (!granted) {
      setStatusIcon(statusEl, false, t("webdavPermDenied"));
      statusEl.style.color = "#c00";
      setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
      return;
    }
    const res = await pbpWebdavPush(cfg);
    if (res.ok) {
      setStatusIcon(statusEl, true, t("webdavPushOk", new Date(res.ts).toLocaleString()));
      statusEl.style.color = "#080";
    } else {
      const msg = res.error === "not-writable" ? (res.status ? t("webdavPushFail", "http-" + res.status) : t("webdavPushNotWritable"))
        : res.error === "not-found" ? t("webdavTargetUnavailable")
        : t("webdavPushFail", res.error || "");
      setStatusIcon(statusEl, false, msg);
      statusEl.style.color = "#c00";
    }
    setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
  });

  // ---- WebDAV: Pull now ----
  $id("webdav-pull-btn")?.addEventListener("click", async () => {
    const statusEl = $id("webdav-status");
    const cfg = _pbpWebdavCfgFromForm();
    if (!cfg.baseUrl || !statusEl) return;
    statusEl.textContent = t("testTesting");
    statusEl.style.color = "#888";
    const granted = await _pbpWebdavRequestPermission(cfg.baseUrl);
    if (!granted) {
      setStatusIcon(statusEl, false, t("webdavPermDenied"));
      statusEl.style.color = "#c00";
      setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
      return;
    }
    const res = await pbpWebdavPull(cfg);
    if (!res.ok) {
      const key = res.error === "auth" ? "webdavTestAuthFail"
        : res.error === "not-found" ? "webdavTestOkEmpty"
        : res.error === "invalid" ? "webdavPullInvalid"
        : "webdavTestUnreachable";
      setStatusIcon(statusEl, false, t(key));
      statusEl.style.color = "#c00";
      setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
      return;
    }
    const pushedAt = (res.data._webdav && res.data._webdav.pushedAt) || "";
    const when = pushedAt ? new Date(pushedAt).toLocaleString() : "?";
    // Spec invariant #2: pull only ever applies after this confirm(); Cancel
    // returns here with zero writes made so far (Test/permission-request
    // above make no storage changes either).
    if (!confirm(t("webdavPullConfirm", when))) {
      statusEl.textContent = "";
      return;
    }
    try {
      await pbpApplyBackupPayload(res.data, { exportableKeys: EXPORTABLE_KEYS, saveOverlayWithFallback });
    } catch (err) {
      console.error("[webdav-pull] apply failed", err);
      setStatusIcon(statusEl, false, t("webdavPullInvalid"));
      statusEl.style.color = "#c00";
      setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
      return;
    }
    // Same fade+reload precedent as the sync-toggle and language-change
    // handlers below (options.js:952 / options.js:1016) -- NOT the silent
    // "reload manually" text the plain file-import flow uses, because
    // overwriting every local setting warrants the same automatic reload
    // those two other big-state-change flows already use. Also copies their
    // sessionStorage.activeTab step (read back at options.js:144) so the
    // reload lands back on the WebDAV sub-section instead of the default tab.
    const activePanel = document.querySelector(".tab-btn.active")?.dataset.panel || "general";
    sessionStorage.setItem("activeTab", activePanel);
    document.body.style.transition = "opacity 0.18s";
    document.body.style.opacity = "0";
    setTimeout(() => location.reload(), 180);
  });

  // ===================== Auto-save =====================
  // Collect all settings from the form and save to chrome.storage.sync
  async function saveAll() {
    const _ets = collectExportTargets();
    const data = {
      // Bookmarks
      pinboardToken: obfuscateKey($id("opt-pinboard-token").value.trim()),
      optPrivateDefault: $id("opt-private-default").checked,
      optPrivateIncognito: $id("opt-private-incognito").checked,
      optReadlaterDefault: $id("opt-readlater-default").checked,
      optAutoDescription: $id("opt-auto-description").checked,
      optBlockquote: $id("opt-blockquote").checked,
      optIncludeReferrer: $id("opt-include-referrer").checked,
      optRespectTagCase: $id("opt-respect-tag-case").checked,
      bgSaveMode: document.querySelector('input[name="bgsave-mode"]:checked')?.value || "merge",
      offlineQueueEnabled: $id("offline-queue-enabled").checked,
      // Quick Actions
      qsAutoNotes: $id("qs-auto-notes").checked,
      qsBlockquote: $id("qs-blockquote").checked,
      qsDefaultTags: $id("qs-default-tags").value.trim(),
      qsAiTags: $id("qs-ai-tags").checked,
      qsAiSummary: $id("qs-ai-summary").checked,
      // Read Later
      rlAutoNotes: $id("rl-auto-notes").checked,
      rlBlockquote: $id("rl-blockquote").checked,
      rlDefaultTags: $id("rl-default-tags").value.trim(),
      rlAiTags: $id("rl-ai-tags").checked,
      rlAiSummary: $id("rl-ai-summary").checked,
      optBatchTagEnabled: $id("opt-batch-tag-enabled").checked,
      optBatchTag: $id("opt-batch-tag").value.trim() || "batch_saved",
      batchAiTags: $id("batch-ai-tags").checked,
      batchAiSummary: $id("batch-ai-summary").checked,
      batchSkipExisting: $id("batch-skip-existing").checked,
      // AI Provider & Keys
      aiProvider: $id("opt-ai-provider").value,
      geminiApiKey: obfuscateKey($id("opt-gemini-key").value.trim()),
      geminiModel: $id("opt-gemini-model").value.trim() || "gemini-2.5-flash-lite",
      openaiApiKey: obfuscateKey($id("opt-openai-key").value.trim()),
      openaiModel: $id("opt-openai-model").value.trim() || "gpt-5.4-nano",
      openaiBaseUrl: $id("opt-openai-baseurl").value.trim() || "https://api.openai.com/v1",
      claudeApiKey: obfuscateKey($id("opt-claude-key").value.trim()),
      claudeModel: $id("opt-claude-model").value.trim() || "claude-haiku-4-5",
      deepseekApiKey: obfuscateKey($id("opt-deepseek-key").value.trim()),
      deepseekModel: $id("opt-deepseek-model").value.trim() || "deepseek-v4-flash",
      qwenApiKey: obfuscateKey($id("opt-qwen-key").value.trim()),
      qwenModel: $id("opt-qwen-model").value.trim() || "qwen-flash",
      minimaxApiKey: obfuscateKey($id("opt-minimax-key").value.trim()),
      minimaxModel: $id("opt-minimax-model").value.trim() || "MiniMax-M2",
      openrouterApiKey: obfuscateKey($id("opt-openrouter-key").value.trim()),
      openrouterModel: $id("opt-openrouter-model").value.trim() || "meta-llama/llama-4-scout:free",
      groqApiKey: obfuscateKey($id("opt-groq-key").value.trim()),
      groqModel: $id("opt-groq-model").value.trim() || "llama-3.1-8b-instant",
      mistralApiKey: obfuscateKey($id("opt-mistral-key").value.trim()),
      mistralModel: $id("opt-mistral-model").value.trim() || "mistral-small-latest",
      cohereApiKey: obfuscateKey($id("opt-cohere-key").value.trim()),
      cohereModel: $id("opt-cohere-model").value.trim() || "command-r7b-12-2024",
      siliconflowApiKey: obfuscateKey($id("opt-siliconflow-key").value.trim()),
      siliconflowModel: $id("opt-siliconflow-model").value.trim() || "Qwen/Qwen3-8B",
      zhipuApiKey: obfuscateKey($id("opt-zhipu-key").value.trim()),
      zhipuModel: $id("opt-zhipu-model").value.trim() || "glm-4.7-flash",
      kimiApiKey: obfuscateKey($id("opt-kimi-key").value.trim()),
      kimiModel: $id("opt-kimi-model").value.trim() || "kimi-k2.6",
      ollamaBaseUrl: $id("opt-ollama-baseurl").value.trim() || "http://localhost:11434",
      ollamaModel: $id("opt-ollama-model").value.trim() || "llama3.2",
      customName: $id("opt-custom-name").value.trim() || "Custom",
      customBaseUrl: $id("opt-custom-baseurl").value.trim(),
      customApiKey: obfuscateKey($id("opt-custom-key").value.trim()),
      customModel: $id("opt-custom-model").value.trim(),
      // AI Behavior & Prompts
      optAiAutoTags: $id("opt-ai-auto-tags").checked,
      aiTagLang: $id("opt-ai-tag-lang").value,
      aiSummaryLang: $id("opt-ai-summary-lang").value,
      aiCacheDuration: (() => {
        const raw = $id("opt-ai-cache-duration").value;
        const n = (raw === "" || raw == null) ? 60 : parseInt(raw, 10);
        return Math.min(10080, Math.max(0, Number.isNaN(n) ? 60 : n));
      })(),
      aiTagSeparator: $id("opt-ai-tag-separator").value,
      aiContentSource: document.querySelector('input[name="ai-content-source"]:checked')?.value || "local",
      tagSyncMode: document.querySelector('input[name="tag-sync-mode"]:checked')?.value || "cached",
      jinaApiKey: obfuscateKey($id("opt-jina-key").value.trim()),
      customTagPrompt: $id("opt-custom-tag-prompt").value,
      customSummaryPrompt: $id("opt-custom-summary-prompt").value,
      mdExportFrontmatter: $id("opt-md-frontmatter").checked,
      mdExportExtendedMeta: $id("opt-md-extended-meta").checked,
      mdExportImagePolicy: $id("opt-md-image-policy").value,
      mdExportIncludeToc: $id("opt-md-include-toc").checked,
      mdExportIncludeHighlights: $id("opt-md-include-hl").checked,
      exportTargets: _ets,
      // Mirror obsidian into legacy keys so popup.js "Send to Obsidian" strip (which still
      // reads obsidianEnabled/Vault/Folder) stays in sync. P2 migrates popup to read exportTargets.
      obsidianEnabled: !!(_ets.obsidian && _ets.obsidian.enabled),
      obsidianVault: (_ets.obsidian && _ets.obsidian.vault) || "",
      obsidianFolder: (_ets.obsidian && _ets.obsidian.folder) || "",
      // Preview-page AI (md-preview explain / ask / translate)
      previewAiEnabled: $id("opt-preview-ai-enabled").checked,
      previewSkimEnabled: $id("opt-preview-skim").checked,
      previewAiModel: $id("opt-preview-ai-model").value.trim(),
      translateTargetLang: resolveTranslateTargetLang(),
      translateGlossary: $id("opt-translate-glossary").value,
      selectionTrigger: $id("opt-selection-trigger").value,
      // Appearance
      optLang: $id("opt-lang").value,
      optTheme: $id("opt-theme").value,
      optShowSearch: $id("opt-show-search").checked,
      optShowRecent: $id("opt-show-recent").checked,
      optShowBadge: $id("opt-show-badge").checked,
      // Notifications
      notifyQuickSave: $id("notify-quick-save").checked,
      notifyReadLater: $id("notify-read-later").checked,
      notifyTabSet: $id("notify-tab-set").checked,
      notifyBatchSave: $id("notify-batch-save").checked,
      notifyErrors: $id("notify-errors").checked,
      // Custom Style (font here; overlay CSS saved separately via syncSetLarge below)
      customFont: $id("opt-custom-font").value.trim(),
      // New toggles
      optCheckBookmarkStatus: $id("opt-check-bookmark-status").checked,
      optShowSuggestTags: $id("opt-show-suggest-tags").checked,
      optShowAiSummary: $id("opt-show-ai-summary").checked,
      optShowAiTags: $id("opt-show-ai-tags").checked,
      optShowQuickLinks: $id("opt-show-quick-links").checked,
      optShowQuickRow: $id("opt-show-quick-row").checked,
      optAutoCloseAfterSave: $id("opt-auto-close").checked,
      optPopupFollowTheme: $id("opt-popup-follow-theme").checked,
      tagSortByPopEnabled: $id("opt-tag-sort-by-pop").checked,
      tagPresets: $id("opt-tag-presets").value,
      waybackArchiveEnabled: $id("opt-wayback-enabled").checked,
      waybackArchiveBatch: $id("opt-wayback-batch").checked,
      waybackSkipPrivate: $id("opt-wayback-skip-private").checked,
      waybackS3Key: obfuscateKey($id("opt-wayback-s3key").value.trim()),
      waybackS3Secret: obfuscateKey($id("opt-wayback-s3secret").value.trim()),
      webdavUrl: $id("opt-webdav-url").value.trim(),
      webdavUser: $id("opt-webdav-user").value.trim(),
      webdavPass: obfuscateKey($id("opt-webdav-pass").value.trim()),
      webdavAutoPush: $id("opt-webdav-autopush").value,
      backupIncludeHighlights: $id("opt-backup-include-highlights").checked,
      themePresetKey: currentPresetKey,
      urlClean: {
        enabled: $id("opt-urlclean-enabled").checked,
        onPopupOpen: $id("opt-urlclean-on-open").checked,
        onPaste: $id("opt-urlclean-on-paste").checked,
        aggressiveMode: $id("opt-urlclean-aggressive").checked,
        customParams: $id("opt-urlclean-custom").value.split("\n").map(s => s.trim()).filter(Boolean),
        excludeParams: $id("opt-urlclean-exclude").value.split("\n").map(s => s.trim()).filter(Boolean),
      },
      // ---- Popup width (B9) ----
      ...(() => {
        const selectedPreset = document.querySelector('input[name="popup-width-preset"]:checked')?.value;
        let popupWidthToSave = 550;
        if (selectedPreset === "custom") {
          const raw = parseInt($id("opt-popup-width-custom").value, 10);
          // Clamp the stored value but do NOT write back to the input — that
          // would clobber partial keystrokes during auto-save (e.g. typing "6"
          // for an eventual "600" would snap to 420). The blur/Enter handler
          // is responsible for cleaning up the displayed value.
          popupWidthToSave = Math.max(420, Math.min(720, isNaN(raw) ? 550 : raw));
        } else if (selectedPreset) {
          popupWidthToSave = parseInt(selectedPreset, 10);
        }
        return { popupWidth: popupWidthToSave };
      })()
    };
    const res = await persistSettings(data);
    // Save customOverlayCSS with quota-aware fallback (sync → local on QUOTA_BYTES)
    await saveOverlayWithFallback($id("opt-custom-css").value);
    if (res.ok && res.fellBackToLocal) {
      // A large prompt key (>8KB) exceeded the sync quota and fell back to local
      // storage — it won't sync to other devices. Surface it the same way
      // saveOverlayWithFallback does for the overlay, instead of a silent "saved"
      // flash that hides the degraded sync (F4).
      const status = $id("auto-save-status");
      if (status) {
        status.textContent = t("optSavedLocally") || "Saved locally (sync quota full)";
        status.classList.add("saved");
        clearTimeout(status._timer);
        status._timer = setTimeout(() => {
          status.textContent = t("optAutoSave"); status.classList.remove("saved");
        }, 4000);
      }
    } else if (res.ok) {
      flashAutoSave();
    } else {
      const status = $id("auto-save-status");
      if (status) {
        setStatusIcon(status, false, t("optSaveFailed") || "Save failed — settings too large to sync");
        status.classList.remove("saved");
        clearTimeout(status._timer);
        status._timer = setTimeout(() => {
          status.textContent = t("optAutoSave"); status.classList.remove("saved");
        }, 4000);
      }
    }
  }

  // Quota-aware overlay save. On sync QUOTA_BYTES, write to local + flag,
  // so the content script and other devices know overlay isn't synced.
  async function saveOverlayWithFallback(value) {
    if (value.length > OVERLAY_BYTE_LIMIT) {
      // UI-side counter blocks before this; final guard
      console.warn("[overlay] exceeds 50KB cap, refusing save");
      return;
    }
    try {
      await syncSetLarge("customOverlayCSS", value);
      await chrome.storage.sync.set({ optOverlayInLocal: false });
      await chrome.storage.local.remove("customOverlayCSS_localFallback");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (/QUOTA|quota/i.test(msg)) {
        await chrome.storage.local.set({ customOverlayCSS_localFallback: value });
        await chrome.storage.sync.set({ optOverlayInLocal: true });
        const status = $id("auto-save-status");
        if (status) {
          status.textContent = t("overlayQuotaFallback") || "CSS saved locally (sync quota full)";
          status.classList.add("saved");
          setTimeout(() => { status.textContent = t("optAutoSave"); status.classList.remove("saved"); }, 4000);
        }
      } else {
        throw e;
      }
    }
  }

  // Debounced auto-save: triggers 500ms after last change
  let saveTimer = null;
  function scheduleAutoSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveAll, 500);
  }

  // Listen on all form inputs for auto-save
  document.querySelectorAll('.panel input[type="checkbox"]').forEach(el => {
    el.addEventListener("change", scheduleAutoSave);
  });
  document.querySelectorAll('.panel input[type="text"], .panel input[type="password"], .panel input[type="number"], .panel textarea').forEach(el => {
    el.addEventListener("input", scheduleAutoSave);
  });
  document.querySelectorAll('.panel select').forEach(el => {
    el.addEventListener("change", scheduleAutoSave);
  });
  document.querySelectorAll('.panel input[type="radio"]').forEach(el => {
    el.addEventListener("change", scheduleAutoSave);
  });
  function flashAutoSave() {
    const el = $id("auto-save-status");
    setStatusIcon(el, true, t("optAutoSaved"));
    el.classList.add("saved");
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.textContent = t("optAutoSave");
      el.classList.remove("saved");
    }, 1500);
  }

  // ---- Export/Import: see options-backup.js ----
  // EXPORTABLE_KEYS whitelist excludes API keys + cache entries from backup.
  const EXPORTABLE_KEYS = Object.keys(SETTINGS_DEFAULTS).filter(k => !API_KEY_FIELDS.includes(k));
  setupBackup({ exportableKeys: EXPORTABLE_KEYS, saveOverlayWithFallback });
  setupApiTests();


  // ---- Theme preset buttons ----
  // Schema v2: preset selection only updates currentPresetKey;
  // textarea (overlay) is never touched. Active state mirrors the key.
  function updateThemePresetButtons() {
    document.querySelectorAll(".theme-preset-btn").forEach(btn => {
      const key = btn.dataset.theme || "";
      const isActive = key === currentPresetKey;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }
  updateThemePresetButtons();

  // Render a read-only preview of the selected preset's CSS (collapsible panel).
  function renderPresetPreview() {
    const previewEl = $id("preset-preview-content");
    const previewSection = $id("preset-preview-section");
    if (!previewEl || !previewSection) return;
    if (!currentPresetKey) {
      previewSection.style.display = "none";
      previewEl.textContent = "";
      return;
    }
    let themeKey = currentPresetKey;
    if (ADAPTIVE_THEME_MAP[themeKey]) {
      const mode = $id("opt-theme").value;
      const prefersDark = mode === "dark" || (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const variantKey = ADAPTIVE_THEME_MAP[themeKey][prefersDark ? 1 : 0];
      if (PINBOARD_THEMES[variantKey]) themeKey = variantKey;
      // Fall back to parent (e.g., flexoki ships one CSS that toggles via .pbp-dark)
    }
    const theme = PINBOARD_THEMES[themeKey];
    previewSection.style.display = "";
    previewEl.textContent = theme ? theme.css : "";
  }

  // W3: appearance panel's render deps (currentPresetKey, PINBOARD_THEMES,
  // ADAPTIVE_THEME_MAP, $id targets) are now initialized — flip the boot-ready
  // flag, flush any queued init from earlier saved-tab clicks, then handle the
  // boot-active case. Dumping a full PINBOARD_THEMES entry (~50KB CSS) into the
  // preview textarea costs noticeable boot time, so we only render when the
  // appearance panel is actually viewed. Settings VALUE population for
  // appearance fields still happens unconditionally above, so saveAll() sees
  // correct values regardless of which panel was viewed.
  _appearancePanelBootReady = true;
  if (_appearancePendingInit) _initAppearancePanel();
  const _activePanelAtBoot = document.querySelector(".tab-btn.active")?.dataset?.panel;
  if (_activePanelAtBoot === "appearance") _initAppearancePanel();

  function applyPreset(key) {
    currentPresetKey = key || "";
    updateThemePresetButtons();
    updateSavedThemeButtons();
    updateSaveThemeBtnState();
    applyOptionsPageTheme(currentPresetKey, $id("opt-theme").value);
    renderPresetPreview();
    scheduleAutoSave();
  }

  document.querySelectorAll(".theme-preset-btn").forEach(btn => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.theme));
  });

  // Toggle "Save as theme" button disabled state based on whether there's
  // any non-whitespace CSS to save. Called from input handler, preset apply,
  // and on initial load.
  function updateSaveThemeBtnState() {
    const saveBtn = $id("save-custom-theme");
    if (!saveBtn) return;
    const css = $id("opt-custom-css").value;
    saveBtn.disabled = !css.trim();
  }

  // Update saved-theme/save-button state and byte counter when user edits overlay CSS.
  // Schema v2: textarea is the overlay; it does NOT determine the preset.
  $id("opt-custom-css").addEventListener("input", () => {
    updateSavedThemeButtons();
    updateSaveThemeBtnState();
    updateOverlayByteCounter();
  });

  // Byte counter: shows N B / 50 KB; warns at 80%, blocks save at 100%.
  function updateOverlayByteCounter() {
    const ta = $id("opt-custom-css");
    const counter = $id("overlay-byte-counter");
    if (!ta || !counter) return;
    const bytes = new Blob([ta.value]).size;
    const pct = bytes / OVERLAY_BYTE_LIMIT;
    counter.textContent = `${formatBytes(bytes)} / 50 KB`;
    counter.classList.toggle("warn", pct >= 0.8 && pct < 1);
    counter.classList.toggle("over", pct >= 1);
    ta.classList.toggle("over-limit", pct >= 1);
  }
  function formatBytes(b) {
    if (b < 1024) return `${b} B`;
    return `${(b / 1024).toFixed(1)} KB`;
  }
  updateOverlayByteCounter();

  // ---- Saved custom themes ----
  let savedThemes = []; // [{ name: "My Theme", css: "..." }, ...]

  async function loadSavedThemes() {
    savedThemes = await syncGetLarge("savedThemes", []);
    if (!Array.isArray(savedThemes)) savedThemes = [];
    // One-time migration from local
    if (!savedThemes.length) {
      const local = await chrome.storage.local.get({ savedThemes: [] });
      if (Array.isArray(local.savedThemes) && local.savedThemes.length) {
        savedThemes = local.savedThemes;
        await syncSetLarge("savedThemes", savedThemes);
        await chrome.storage.local.remove("savedThemes");
      }
    }
    renderSavedThemes();
  }

  async function persistSavedThemes() {
    await syncSetLarge("savedThemes", savedThemes);
  }

  function renderSavedThemes() {
    const container = $id("saved-themes-list");
    const section = $id("saved-themes-section");
    while (container.firstChild) container.removeChild(container.firstChild);
    section.style.display = savedThemes.length ? "" : "none";
    const currentCSS = $id("opt-custom-css").value;
    savedThemes.forEach((theme) => {
      const wrap = document.createElement("span");
      wrap.className = "saved-theme-wrap";
      const btn = document.createElement("button");
      btn.className = "btn btn-sm saved-theme-btn";
      btn.textContent = theme.name;
      btn.title = theme.name; // Full-name tooltip in case label gets truncated
      btn.setAttribute("aria-label", t("loadTheme", theme.name));
      const isActive = currentCSS.trim() === theme.css.trim();
      if (isActive) btn.classList.add("active");
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.addEventListener("click", () => {
        $id("opt-custom-css").value = theme.css;
        updateThemePresetButtons();
        updateSavedThemeButtons();
        updateSaveThemeBtnState();
        // Custom saved themes do NOT affect options page styling — clear preset key
        currentPresetKey = "";
        applyOptionsPageTheme("", $id("opt-theme").value);
        scheduleAutoSave();
      });
      const del = document.createElement("button");
      del.className = "saved-theme-del";
      del.textContent = "\u00d7";
      del.title = t("deleteTheme");
      del.setAttribute("aria-label", t("deleteThemeNamed", theme.name));
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        showConfirmPopover(wrap, {
          msg: t("deleteThemeConfirm", theme.name),
          yesText: t("delete"),
          noText: t("cancel"),
          onConfirm: async () => {
            // Re-find by name in case the array mutated while popover was open.
            const current = savedThemes.findIndex(th => th.name === theme.name);
            if (current >= 0) {
              savedThemes.splice(current, 1);
              await persistSavedThemes();
              renderSavedThemes();
            }
          },
        });
      });
      wrap.append(btn, del);
      container.appendChild(wrap);
    });
  }

  function updateSavedThemeButtons() {
    const currentCSS = $id("opt-custom-css").value;
    document.querySelectorAll(".saved-theme-btn").forEach(btn => {
      const theme = savedThemes.find(t => t.name === btn.textContent);
      const isActive = !!(theme && currentCSS.trim() === theme.css.trim());
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  $id("save-custom-theme").addEventListener("click", () => {
    const css = $id("opt-custom-css").value.trim();
    if (!css) return;

    const wrap = document.querySelector(".save-theme-wrap");
    if (wrap.querySelector(".theme-name-popover")) return; // already open

    const pop = document.createElement("div");
    pop.className = "theme-name-popover";

    const lbl = document.createElement("label");
    lbl.textContent = t("themeName");

    const inp = document.createElement("input");
    inp.type = "text";
    inp.maxLength = 40;

    const overwriteMsg = document.createElement("p");
    overwriteMsg.className = "tnp-overwrite";
    overwriteMsg.style.display = "none";

    const actions = document.createElement("div");
    actions.className = "tnp-actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "tnp-save";
    saveBtn.textContent = t("themeNameSave");

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "tnp-cancel";
    cancelBtn.textContent = t("cancel");

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    pop.appendChild(lbl);
    pop.appendChild(inp);
    pop.appendChild(overwriteMsg);
    pop.appendChild(actions);
    wrap.appendChild(pop);

    inp.focus();

    function dismiss() {
      pop.remove();
      document.removeEventListener("keydown", onEscGlobal);
    }
    // Document-level ESC so focus doesn't have to be inside the input.
    function onEscGlobal(ev) { if (ev.key === "Escape") dismiss(); }
    document.addEventListener("keydown", onEscGlobal);

    pop.addEventListener("click", (e) => e.stopPropagation());
    cancelBtn.addEventListener("click", dismiss);

    saveBtn.addEventListener("click", async () => {
      const trimmedName = inp.value.trim();
      if (!trimmedName) { inp.focus(); return; }
      const existing = savedThemes.findIndex(th => th.name === trimmedName);
      if (existing >= 0 && overwriteMsg.style.display === "none") {
        overwriteMsg.textContent = t("themeOverwrite", trimmedName);
        overwriteMsg.style.display = "";
        saveBtn.textContent = t("themeNameOverwriteBtn");
        return;
      }
      if (existing >= 0) {
        savedThemes[existing].css = css;
      } else {
        savedThemes.push({ name: trimmedName, css });
      }
      await persistSavedThemes();
      renderSavedThemes();
      dismiss();
    });

    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveBtn.click();
    });

    // close on outside click
    function outsideClick() { dismiss(); document.removeEventListener("click", outsideClick); }
    setTimeout(() => document.addEventListener("click", outsideClick), 0);
  });

  await loadSavedThemes();
  updateSaveThemeBtnState();

  // ---- Chrome shortcuts: open chrome://extensions/shortcuts ----
  // A plain <a href="chrome://..."> can't navigate from an extension page, so
  // intercept every shortcut link (any tab) and open it via the tabs API.
  document.querySelectorAll('a[href="chrome://extensions/shortcuts"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    });
  });
  // Show the ACTUAL bound key for every command that has a display slot in the
  // page ([data-command="<command name>"]) — not a hardcoded guess. Unbound
  // commands show the "unset" hint. One loop covers all current + future slots.
  try {
    const cmds = await chrome.commands.getAll();
    const byName = new Map(cmds.map((c) => [c.name, c.shortcut]));
    document.querySelectorAll("[data-command]").forEach((slot) => {
      const sc = byName.get(slot.dataset.command);
      slot.textContent = "";
      if (sc) {
        const kbd = document.createElement("kbd");
        kbd.textContent = sc;
        slot.appendChild(kbd);
      } else {
        slot.textContent = t("mdShortcutUnset");
      }
    });
  } catch (_) { /* commands API unavailable — leave fields blank */ }


  // B5: Write high-frequency UI fields mirror for next options open.
  // Never stores API keys or tokens — only boolean "loggedIn" and visible UI state.
  try {
    const mirror = {
      ts: Date.now(),
      loggedIn: !!(s.pinboardToken),
      aiProvider: s.aiProvider || "gemini",
      notify: {
        "notify-quick-save": s.notifyQuickSave !== false,
        "notify-read-later": s.notifyReadLater !== false,
        "notify-tab-set": s.notifyTabSet !== false,
        "notify-batch-save": s.notifyBatchSave !== false,
        "notify-errors": s.notifyErrors !== false,
      }
    };
    localStorage.setItem("pp-options-fields", JSON.stringify(mirror));
  } catch (_) {}

  // ---- Tag governance event listeners ----
  $id("tag-gov-reset-ignored")?.addEventListener("click", async (e) => {
    e.preventDefault();
    // Anchor to the positioned <small> wrapper, NOT inside the <a href="#"> itself:
    // a popover nested in the anchor makes its buttons activate the link (the
    // popover only stopPropagation()s, it can't cancel the anchor's default), so
    // confirming OR cancelling navigated to "#" and scroll-jumped the page to top.
    showConfirmPopover($id("tag-gov-reset-ignored")?.closest(".tag-gov-reset-link"), {
      msg: t("tagGovResetIgnoredConfirm"),
      yesText: t("reset"),
      noText: t("cancel"),
      onConfirm: async () => {
        await chrome.storage.local.remove("_tagGovIgnored");
        await renderTagGov();
      }
    });
  });

  $id("tag-gov-delete-selected")?.addEventListener("click", async () => {
    const selected = Array.from(
      document.querySelectorAll(".tag-gov-lowcount-checkbox:checked")
    ).map(el => el.value);
    if (!selected.length) return;
    const btn = $id("tag-gov-delete-selected");
    const shown = selected.slice(0, 10).join(", ") + (selected.length > 10 ? ", +" + (selected.length - 10) + " more" : "");
    const msg = t("tagGovConfirmDelete", String(selected.length))
      + "\n" + shown;
    showConfirmPopover(btn, {
      msg,
      yesText: t("tagGovDeleteSelected"),
      noText: t("cancel"),
      onConfirm: async () => {
        const delTags = selected.map(tg => tg.toLowerCase());
        if (delTags.some(tg => _tagGovActiveTags.has(tg))) return;
        delTags.forEach(tg => _tagGovActiveTags.add(tg)); // reserve BEFORE await (atomic check+reserve)
        if (btn) btn.disabled = true;
        if (!(await ensureTagSnapshot())) {
          delTags.forEach(tg => _tagGovActiveTags.delete(tg)); // roll back reservation on snapshot failure
          if (btn) btn.disabled = false;
          return;
        }
        try {
          await runTagGovOps(selected.map(tag => ({ op: "delete", tag })));
        } finally {
          delTags.forEach(tg => _tagGovActiveTags.delete(tg));
          if (btn) btn.disabled = false;
        }
      }
    });
  });

  $id("tag-gov-ai-btn")?.addEventListener("click", async () => {
    const btn = $id("tag-gov-ai-btn");
    const statusEl = $id("tag-gov-ai-status");

    // Re-read settings fresh (like getTagGovToken does): the page-load snapshot `s`
    // is never written back by saveAll(), so a key/provider configured THIS session
    // (paste key on the AI tab, come back here) was invisible until a full reload —
    // and a provider switch would fire the request at the OLD provider/key/model.
    let sNow = await (await getSettingsStorage()).get(SETTINGS_DEFAULTS);
    sNow = await pbpApplySecretOverlay(sNow);
    deobfuscateSettings(sNow);

    if (!hasAIKey(sNow)) {
      if (statusEl) {
        setStatusIcon(statusEl, false, t("tagGovAiNoKey"));
        statusEl.style.color = "#c00";
        setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
      }
      return;
    }

    const origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = t("tagGovAiRunning");
    if (statusEl) { statusEl.textContent = ""; statusEl.style.color = ""; }

    try {
      const counts = await loadTagCounts(false);
      if (!counts) throw new Error("Failed to load tag counts");

      const prompt = pbpTagGovBuildAiPrompt(counts, 1500);
      // Clustering output is a large JSON array, and thinking models (Gemini 2.5,
      // DeepSeek reasoner) burn output budget on reasoning first — the default
      // 1024-token cap came back as an empty response from both. 4096 is accepted
      // by every supported provider.
      const raw = await getOrCreateInflight("taggov|" + sNow.aiProvider, () => callAI(sNow, prompt, { maxTokens: 4096 }));

      const aiGroups = pbpTagGovParseAiResponse(raw, counts);

      await chrome.storage.local.set({ _tagGovAiGroups: { groups: aiGroups, ts: Date.now() } });
      await renderTagGov();

      if (statusEl && aiGroups.length === 0) {
        statusEl.textContent = t("tagGovAiNone");
      }
    } catch (err) {
      let msg = err.name === "AbortError" ? t("testTimeout") : err.message;
      if (err?.code === "model_not_found") {
        msg = t("aiErrorModelNotFound", sNow.aiProvider) + " " + t("aiErrorModelNotFoundHint");
      }
      if (statusEl) {
        setStatusIcon(statusEl, false, msg);
        statusEl.style.color = "#c00";
        setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 5000);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  });

  await renderWaybackLog();
});

// ---- Tag Governance helpers (top-level so they survive the DOMContentLoaded closure) ----

const TAG_GOV_RETRY_WAIT_MS = 10000; // single backoff before retrying a 429 once (Pinboard rate limit)
const TAG_GOV_LIST_RETRY_WAIT_MS = 60000; // posts/all has its own documented once-per-5-min budget — back off much longer

// Rebuild the tag-overview line (tag count + total uses). Top level, NOT inside the
// DOMContentLoaded closure: runTagGovOps calls it after every batch (a closure-scoped
// version threw "updateTagGovOverview is not defined" there, killing the post-batch
// re-render). Preserves the #tag-gov-refresh button across replaceChildren — query it
// live from the container instead of $id, whose memoized cache could hold a stale node.
function updateTagGovOverview(counts) {
  const overview = $id("tag-gov-overview");
  if (!counts || !overview) return;
  const tagCount = Object.keys(counts).length;
  const totalUses = Object.values(counts).reduce((a, b) => a + b, 0);
  const refreshBtn = overview.querySelector("#tag-gov-refresh");
  overview.replaceChildren();
  const span = document.createElement("span");
  span.textContent = t("tagGovOverview", String(tagCount), String(totalUses));
  overview.appendChild(span);
  if (refreshBtn) overview.appendChild(refreshBtn);
}

// Pinboard username (token prefix), stashed by getTagGovToken for building
// pinboard.in/u:<user>/... links without an extra async hop at render time.
let _tagGovUser = "";

// Loading tag counts failed (no token / offline / API error): say so in the
// overview line instead of leaving the unfilled "$TAGS$ tags" template visible.
// Preserves the Refresh button the same way updateTagGovOverview does.
function _tagGovShowLoadFailed() {
  const overview = $id("tag-gov-overview");
  if (!overview) return;
  const refreshBtn = overview.querySelector("#tag-gov-refresh");
  overview.replaceChildren();
  const span = document.createElement("span");
  span.textContent = t("tagGovLoadFailed");
  overview.appendChild(span);
  if (refreshBtn) overview.appendChild(refreshBtn);
}

// Shared token reader for tag-governance operations.
// Returns the deobfuscated Pinboard token, or "" if not set / on error.
async function getTagGovToken() {
  try {
    let s = await (await getSettingsStorage()).get(SETTINGS_DEFAULTS);
    s = await pbpApplySecretOverlay(s);
    const token = deobfuscateKey(s.pinboardToken) || "";
    if (token) _tagGovUser = token.split(":")[0] || _tagGovUser;
    return token;
  } catch (e) {
    console.error("[tag-gov] getTagGovToken failed:", e);
    return "";
  }
}

// Once per options-page session: download a tags/get snapshot before any destructive op.
// Returns true if the snapshot was already downloaded this session or was just successfully
// downloaded. Returns false (and shows an error in #tag-gov-progress-text) on any failure.
let _tagGovSnapshotDownloaded = false;

async function ensureTagSnapshot() {
  if (_tagGovSnapshotDownloaded) return true;
  const progressText = $id("tag-gov-progress-text");
  const progress = $id("tag-gov-progress");
  try {
    const token = await getTagGovToken();
    if (!token) {
      if (progress) progress.classList.remove("hidden");
      if (progressText) progressText.textContent = t("tagGovSnapshotFailed");
      _tagGovSetProgressBtn("dismiss"); // failure card must be closable on a fresh page
      return false;
    }
    const resp = await pinboardFetch(
      `https://api.pinboard.in/v1/tags/get?auth_token=${encodeURIComponent(token)}&format=json`
    );
    if (!resp || !resp.ok) {
      if (progress) progress.classList.remove("hidden");
      if (progressText) progressText.textContent = t("tagGovSnapshotFailed");
      _tagGovSetProgressBtn("dismiss"); // failure card must be closable on a fresh page
      return false;
    }
    const counts = await resp.json();
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const yyyymmdd = pad(now.getFullYear(), 4) + pad(now.getMonth() + 1) + pad(now.getDate());
    const hhmm = pad(now.getHours()) + pad(now.getMinutes());
    const filename = `pinboard-tags-snapshot-${yyyymmdd}-${hhmm}.json`;
    const blob = new Blob(
      [JSON.stringify({ exportedAt: now.toISOString(), counts }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    _tagGovSnapshotDownloaded = true;
    // Don't stomp a running batch's progress line with the snapshot note.
    if (_tagGovUnfinishedBatches === 0) {
      if (progress) progress.classList.remove("hidden");
      if (progressText) progressText.textContent = t("tagGovSnapshotSaved");
    }
    return true;
  } catch (e) {
    console.error("[tag-gov] ensureTagSnapshot failed:", e);
    if (progress) progress.classList.remove("hidden");
    if (progressText) progressText.textContent = t("tagGovSnapshotFailed");
    _tagGovSetProgressBtn("dismiss"); // failure card must be closable on a fresh page
    return false;
  }
}

// Format a seconds estimate: "45s" under 90s, whole minutes above.
function formatTagGovEst(seconds) {
  return seconds < 90 ? Math.ceil(seconds) + "s" : Math.ceil(seconds / 60) + " min";
}

async function confirmMergeGroup(group, canonical, anchorEl) {
  if (!group || !group.members || group.members.length === 0) return;
  const plan = pbpTagGovBuildPlan(group.members, canonical);
  if (plan.length === 0) return;
  const renames = plan.filter(op => op.op === "rename");
  const summary = renames.map(op => op.old + " -> " + canonical).join(" | ");
  // Renames run as per-bookmark re-saves (tags/rename is broken server-side), so the
  // duration scales with bookmark count: one posts/all fetch per rename + one posts/add
  // per bookmark, each spaced 3.1s by the rate-limit queue.
  const canonLower = canonical.toLowerCase();
  const bookmarkCount = group.members.reduce((sum, m) =>
    (m && m.tag && m.tag.toLowerCase() !== canonLower) ? sum + (m.count || 0) : sum, 0);
  const estSec = Math.ceil((renames.length + bookmarkCount) * 3.2);
  const estStr = formatTagGovEst(estSec);
  const msg = t("tagGovConfirmMerge", String(renames.length), canonical)
    + (summary ? ": " + summary : "")
    + "\n" + t("tagGovMergeEstimate", estStr);
  const anchor = anchorEl;
  if (!anchor) return;
  showConfirmPopover(anchor, {
    msg,
    yesText: t("tagGovMerge"),
    noText: t("cancel"),
    onConfirm: async () => {
      // Refuse overlapping plans (same group clicked twice, or a sibling group
      // sharing a tag) instead of burning another rate-limited posts/all slot.
      const planTags = [];
      for (const pop of plan) planTags.push(pop.old.toLowerCase(), pop.new.toLowerCase());
      if (planTags.some(tg => _tagGovActiveTags.has(tg))) return;
      planTags.forEach(tg => _tagGovActiveTags.add(tg)); // reserve BEFORE await (atomic check+reserve)
      if (!(await ensureTagSnapshot())) {
        planTags.forEach(tg => _tagGovActiveTags.delete(tg)); // roll back reservation on snapshot failure
        return;
      }
      _tagGovMarkRowQueued(anchor.closest(".tag-gov-group-row"));
      try {
        await runTagGovOps(plan);
      } finally {
        planTags.forEach(tg => _tagGovActiveTags.delete(tg));
      }
    }
  });
}

// Pinboard's v1 tags/rename endpoint is broken server-side (verified 2026-06-11: HTTP 500
// with empty body for EVERY input, including two nonexistent tag names — it crashes before
// input validation; the documented v2 API is not deployed, all /v2/* paths return an
// Apache-level 403). tags/delete and posts/add still work, so renames are implemented as
// per-bookmark re-tagging: fetch every post carrying the old tag, then re-save each via
// posts/add replace=yes with the old tag substituted. The old tag disappears on its own
// once its use count reaches zero. Deliberately NO tags/delete afterwards: if any re-save
// was skipped or failed, deleting would strip the old tag with no new tag present (data loss).
// Each network call flows through the shared 3.1s pinboardFetch queue.
async function retagBookmarksViaResave(token, oldTag, newTag, onProgress) {
  const enc = encodeURIComponent;
  // The 10s retry sleeps used to be a frozen screen — tell the user what is happening.
  const setWaitNote = () => {
    const pt = $id("tag-gov-progress-text");
    if (pt) pt.textContent = t("tagGovRateLimitWait");
  };
  const listUrl = `https://api.pinboard.in/v1/posts/all?tag=${enc(oldTag)}&meta=no&format=json&auth_token=${enc(token)}`;
  // pinboardFetch REJECTS on network failure or its 30s timeout — without this catch
  // the rejection escaped to the op-level handler as an anonymous fail with no row.
  let resp;
  try {
    resp = await pinboardFetch(listUrl, { timeoutMs: 30000 });
    if (resp.status === 429) {
      setWaitNote();
      await new Promise(r => setTimeout(r, TAG_GOV_LIST_RETRY_WAIT_MS));
      // Stop clicked during the 60s wait: don't burn the budgeted retry on a result
      // that would be discarded anyway.
      if (_tagGovCancelRequested) {
        return { total: 0, saved: 0, failed: 0, skipped: 0, problems: [], cancelled: true };
      }
      resp = await pinboardFetch(listUrl, { timeoutMs: 30000 });
      if (resp.status === 429) return { total: 0, saved: 0, failed: 0, skipped: 0, problems: [], aborted: true };
    }
  } catch (e) {
    return { total: 0, saved: 0, failed: 1, skipped: 0,
      problems: [{ url: "", title: "", kind: "failed", reason: "posts/all: " + (e?.name || "network error") }], aborted: false };
  }
  // A failed list fetch means NO bookmark was touched — say which pair and why, so the
  // summary's "1 failed" is not an anonymous dead end (re-running is fully safe).
  if (!resp.ok) {
    return { total: 0, saved: 0, failed: 1, skipped: 0,
      problems: [{ url: "", title: "", kind: "failed", reason: "posts/all HTTP " + resp.status }], aborted: false };
  }
  const posts = await resp.json();
  if (!Array.isArray(posts)) {
    return { total: 0, saved: 0, failed: 1, skipped: 0,
      problems: [{ url: "", title: "", kind: "failed", reason: "posts/all: unexpected response" }], aborted: false };
  }

  const oldLower = oldTag.toLowerCase();
  let saved = 0, failed = 0, skipped = 0;
  const problems = []; // { url, title, kind: "failed" | "skipped" } per bookmark
  for (let i = 0; i < posts.length; i++) {
    if (_tagGovCancelRequested) {
      return { total: posts.length, saved, failed, skipped, problems, cancelled: true };
    }
    if (onProgress) onProgress(i, posts.length);
    const post = posts[i];
    if (!post || !post.href) {
      failed++;
      problems.push({ url: "", title: (post && post.description) || "", kind: "failed", reason: "missing href" });
      continue;
    }
    const tags = (post.tags || "").split(/\s+/).filter(Boolean);
    // Pinboard tags are case-insensitive: match accordingly. Already clean -> count as done without a write.
    if (!tags.some(tg => tg.toLowerCase() === oldLower)) { saved++; continue; }
    const seen = new Set();
    const next = [];
    for (const tg of tags) {
      const replaced = tg.toLowerCase() === oldLower ? newTag : tg;
      const key = replaced.toLowerCase();
      if (!seen.has(key)) { seen.add(key); next.push(replaced); }
    }
    const uri = buildPostsAddUri({
      token,
      url: post.href,
      title: post.description || post.href,
      extended: post.extended || "",
      tags: next.join(" "),
      shared: post.shared,
      toread: post.toread,
      dt: post.time
    });
    // Never truncate a bookmark to fit the URI cap — skip it and surface the count instead.
    if (uri.length > POSTS_ADD_URI_BUDGET) {
      skipped++;
      problems.push({ url: post.href, title: post.description || post.href, kind: "skipped" });
      continue;
    }
    try {
      let r = await pinboardFetch(uri);
      if (r.status === 429) {
        setWaitNote();
        await new Promise(rs => setTimeout(rs, TAG_GOV_RETRY_WAIT_MS));
        if (_tagGovCancelRequested) {
          return { total: posts.length, saved, failed, skipped, problems, cancelled: true };
        }
        r = await pinboardFetch(uri);
        if (r.status === 429) {
          // A persistent 429 on one bookmark is likely a transient cross-context
          // collision (popup/background share the rate budget) — record it and move
          // on instead of killing the whole run over a single bookmark.
          failed++;
          problems.push({ url: post.href, title: post.description || post.href, kind: "failed", reason: "HTTP 429" });
          continue;
        }
      }
      if (!r.ok) {
        failed++;
        problems.push({ url: post.href, title: post.description || post.href, kind: "failed", reason: "HTTP " + r.status });
        continue;
      }
      const data = await r.json();
      if (data.result_code === "done") {
        saved++;
      } else {
        failed++;
        problems.push({ url: post.href, title: post.description || post.href, kind: "failed", reason: String(data.result_code || "unknown") });
      }
    } catch (e) {
      console.error("[tag-gov] retag re-save failed:", post.href, e);
      failed++;
      problems.push({ url: post.href, title: post.description || post.href, kind: "failed", reason: e?.name || "network error" });
    }
  }
  if (onProgress) onProgress(posts.length, posts.length);
  return { total: posts.length, saved, failed, skipped, problems, aborted: false };
}

// Batches queue up instead of running concurrently: several confirmed merges would
// otherwise interleave their writes into the single shared progress line (observed in
// the field as alternating "1/2 ... 24/92" / "1/2 ... 36/42" from different batches).
// Network calls were already serialized by the pinboardFetch queue; this serializes
// the UI and the ok/fail bookkeeping too.
let _tagGovBatchChain = Promise.resolve();
let _tagGovUnfinishedBatches = 0;
// Number of queued batches to drop after an abort/stop: exactly the batches that
// were waiting at that moment (they would keep hammering an API that just told us
// to stop, and their op lines would overwrite the abort explanation). A NEW batch
// the user confirms during the drain window lands after these and still runs.
let _tagGovDrainCount = 0;
// Set by the Stop button; checked at every per-bookmark/per-op checkpoint. A stopped
// run drains its queue like an aborted one — completed re-saves persist server-side.
let _tagGovCancelRequested = false;

// The single button on the progress card: "Stop" while a run is active, "Dismiss"
// once the queue drains (the sticky card otherwise pins to the viewport forever).
function _tagGovSetProgressBtn(mode) {
  const btn = $id("tag-gov-progress-btn");
  if (!btn) return;
  btn.dataset.mode = mode;
  btn.disabled = false;
  btn.hidden = false;
  btn.textContent = mode === "stop" ? t("tagGovStop") : t("tagGovDismiss");
}

document.addEventListener("click", (ev) => {
  const btn = ev.target instanceof Element && ev.target.closest("#tag-gov-progress-btn");
  if (!btn) return;
  if (btn.dataset.mode === "stop") {
    _tagGovCancelRequested = true;
    btn.disabled = true; // takes effect at the next per-bookmark checkpoint
  } else {
    const card = $id("tag-gov-progress");
    if (card) card.classList.add("hidden");
    // The attention list is a sibling of the card — dismiss both, or it stays
    // orphaned on screen with no way to clear it.
    _tagGovProblems.length = 0;
    renderTagGovProblems();
    // Dismiss = acknowledged: drop the persisted record so it stops reappearing.
    try { chrome.storage.local.remove("_tagGovLastRun"); } catch (_) {}
  }
});
// Bookmarks that need manual attention, accumulated across the queued batches of one
// run and reset when a fresh run starts (counter at zero).
const _tagGovProblems = [];
const TAG_GOV_PROBLEMS_CAP = 20;
// Every tag involved in a queued/running op (lowercased): used to refuse
// double-queueing the same group (or a sibling group sharing a tag) and to keep
// rebuilt rows visually frozen if the user refreshes mid-run.
const _tagGovActiveTags = new Set();

// Visually freeze a group row whose merge is queued/running: disable its controls
// and append a "Queued" note. Rows rebuilt by renderTagGov re-apply this state from
// _tagGovActiveTags; the drain-time re-render naturally clears it.
function _tagGovMarkRowQueued(row) {
  if (!row || row.classList.contains("tag-gov-row-queued")) return;
  row.classList.add("tag-gov-row-queued");
  row.querySelectorAll("button, input").forEach(el => { el.disabled = true; });
  const note = document.createElement("span");
  note.className = "tag-gov-queued-note";
  note.textContent = t("tagGovQueuedBadge");
  row.appendChild(note);
}

// Run-level totals shown in the done summary, accumulated across the queued batches
// of one run: per-batch numbers alone hid earlier batches' failures — only the last
// batch's summary survived on screen while the problems list was cross-batch.
const _tagGovRunTotals = { ok: 0, fail: 0, skipped: 0 };

// Render the manual-attention list under the progress row: failed re-saves and
// skipped over-budget bookmarks, each linking to pinboard's edit form for that URL.
function renderTagGovProblems() {
  const box = $id("tag-gov-problems");
  if (!box) return;
  box.replaceChildren();
  if (_tagGovProblems.length === 0) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const title = document.createElement("div");
  title.className = "tag-gov-problems-title";
  title.textContent = t("tagGovProblemsTitle");
  box.appendChild(title);
  for (const pr of _tagGovProblems.slice(0, TAG_GOV_PROBLEMS_CAP)) {
    const row = document.createElement("div");
    row.className = "tag-gov-problem-row";
    const kind = document.createElement("span");
    kind.className = "tag-gov-problem-kind" + (pr.kind === "failed" ? " bad" : "");
    kind.textContent = t(pr.kind === "failed" ? "tagGovProblemFailed" : "tagGovProblemSkipped");
    row.appendChild(kind);
    if (pr.tag) {
      // delete-path row: the tag name, linked to its page so the user can inspect
      // what still carries it before retrying.
      row.appendChild(document.createTextNode(" "));
      if (_tagGovUser) {
        const a = document.createElement("a");
        a.href = "https://pinboard.in/u:" + encodeURIComponent(_tagGovUser) + "/t:" + encodeURIComponent(pr.tag) + "/";
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = pr.tag;
        row.appendChild(a);
      } else {
        row.appendChild(document.createTextNode(pr.tag));
      }
    } else {
      row.appendChild(document.createTextNode(" " + pr.old + " -> " + pr.new));
      if (pr.url) {
        row.appendChild(document.createTextNode(" · "));
        const a = document.createElement("a");
        a.href = "https://pinboard.in/add?url=" + encodeURIComponent(pr.url);
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = pr.title || pr.url;
        row.appendChild(a);
      }
    }
    if (pr.reason) row.appendChild(document.createTextNode(" · " + pr.reason));
    box.appendChild(row);
  }
  if (_tagGovProblems.length > TAG_GOV_PROBLEMS_CAP) {
    const more = document.createElement("div");
    more.className = "tag-gov-problem-row";
    more.textContent = "+" + (_tagGovProblems.length - TAG_GOV_PROBLEMS_CAP);
    box.appendChild(more);
  }
}

// Busy dot on the Tags tab button: inactive panels are display:none, so a running
// batch is otherwise invisible from every other settings tab.
function _tagGovSetTabBusy(busy) {
  const btn = document.querySelector('.tab-btn[data-panel="tags"]');
  if (btn) btn.classList.toggle("tab-busy", busy);
}

function runTagGovOps(ops) {
  if (_tagGovUnfinishedBatches === 0) {
    _tagGovSetTabBusy(true);
    // fresh run: reset the cross-batch accumulators
    _tagGovProblems.length = 0;
    _tagGovRunTotals.ok = 0;
    _tagGovRunTotals.fail = 0;
    _tagGovRunTotals.skipped = 0;
    _tagGovDrainCount = 0;
    _tagGovCancelRequested = false;
  }
  _tagGovUnfinishedBatches++;
  const run = _tagGovBatchChain.then(() =>
    _runTagGovBatch(ops).finally(() => {
      _tagGovUnfinishedBatches--;
      if (_tagGovUnfinishedBatches === 0) {
        _tagGovSetTabBusy(false);
        // Backstop for a batch that threw before reaching the tail: never leave
        // the card stuck on a dead "Stop" button.
        _tagGovSetProgressBtn("dismiss");
      }
    })
  );
  _tagGovBatchChain = run.catch(() => {});
  return run;
}

// Warn before leaving while batches are running/queued. Completed re-saves persist
// server-side; re-running the same merge after a reload resumes safely (posts/all
// only returns still-untagged bookmarks) — but the rest of the running batch and
// every queued batch would be silently dropped.
window.addEventListener("beforeunload", (e) => {
  if (_tagGovUnfinishedBatches > 0) {
    e.preventDefault();
    e.returnValue = ""; // required by Chrome to show the native confirmation
  }
});

// True only while the drain-time tail re-render runs: renderTagGov must not re-freeze
// rows from _tagGovActiveTags then (the tags are released a few microtasks later), but
// MUST re-freeze them on user-triggered re-renders (ignore/refresh/AI) mid-run.
let _tagGovIsTailRender = false;

async function _tagGovTailRefresh() {
  _tagGovSetProgressBtn("dismiss");
  // Persist the run outcome: the summary and attention list were DOM-only and
  // vanished if the page closed before the user came back to look at them.
  try {
    await chrome.storage.local.set({ _tagGovLastRun: {
      ts: Date.now(),
      ok: _tagGovRunTotals.ok,
      fail: _tagGovRunTotals.fail,
      skipped: _tagGovRunTotals.skipped,
      problems: _tagGovProblems.slice(0, TAG_GOV_PROBLEMS_CAP)
    } });
  } catch (_) {}
  const fresh = await loadTagCounts(true);
  if (fresh) updateTagGovOverview(fresh);
  _tagGovIsTailRender = true;
  try {
    await renderTagGov();
    await renderLowCountTags();
  } finally {
    _tagGovIsTailRender = false;
  }
}

async function _runTagGovBatch(ops) {
  if (_tagGovDrainCount > 0) {
    // Queued behind an aborted/stopped batch: drop without touching the progress
    // line (it shows the abort explanation), but still refresh the panel at drain.
    _tagGovDrainCount--;
    // The stopped run is fully drained — a new batch confirmed during the drain
    // window must NOT inherit the stale cancel flag (it would die at its first
    // checkpoint with zero ops executed, shown as "Stopped" the user never asked for).
    if (_tagGovDrainCount === 0) _tagGovCancelRequested = false;
    if (_tagGovUnfinishedBatches === 1) await _tagGovTailRefresh();
    return { ok: 0, fail: 0, aborted: true };
  }
  if (!ops || ops.length === 0) return { ok: 0, fail: 0, aborted: false };
  const token = await getTagGovToken();
  if (!token) {
    const pt = $id("tag-gov-progress-text");
    const pg = $id("tag-gov-progress");
    if (pg) pg.classList.remove("hidden");
    if (pt) pt.textContent = t("pinboardErrorAuth");
    _tagGovSetProgressBtn("dismiss");
    // Keep the run bookkeeping consistent with the normal path: count the failures
    // and still run the drain-time tail (persist + refresh) when last in the queue.
    _tagGovRunTotals.fail += ops.length;
    if (_tagGovUnfinishedBatches === 1) await _tagGovTailRefresh();
    return { ok: 0, fail: ops.length, aborted: false };
  }

  const progress = $id("tag-gov-progress");
  const fill = $id("tag-gov-progress-fill");
  const ptext = $id("tag-gov-progress-text");
  // Visibility from any scroll position is handled by CSS — #tag-gov-progress is
  // position:sticky at the viewport bottom, so no scroll jump is needed here.
  if (progress) progress.classList.remove("hidden");

  _tagGovSetProgressBtn("stop");

  let ok = 0, fail = 0, aborted = false, cancelled = false, skippedTotal = 0;
  const enc = encodeURIComponent;

  for (let i = 0; i < ops.length; i++) {
    if (_tagGovCancelRequested) {
      cancelled = true;
      break;
    }
    const op = ops[i];
    // Bar = completed ops + fractional progress inside the current op. The old
    // (i + 1) / ops.length formula filled the bar at the START of each op — a
    // single-op batch showed 100% from the first second while 30 bookmarks were
    // still being re-saved.
    if (fill) fill.style.width = Math.round((i / ops.length) * 100) + "%";
    const opLine =
      t("tagGovOpLabel", String(i + 1), String(ops.length)) + " " +
      "<span class=\"status-ic ok\">" + PBP_ICONS.check + "</span>" + ok + " " +
      "<span class=\"status-ic bad\">" + PBP_ICONS.cross + "</span>" + fail;
    const queueSuffix = () => {
      const waiting = _tagGovUnfinishedBatches - 1; // batches queued behind this one
      return waiting > 0 ? " · " + t("tagGovQueuedBatches", String(waiting)) : "";
    };
    if (ptext) ptext.innerHTML = opLine + queueSuffix();

    if (op.op === "rename") {
      // tags/rename is broken server-side -- re-tag each bookmark instead (see helper above).
      try {
        const res = await retagBookmarksViaResave(token, op.old, op.new, (done, total) => {
          if (total <= 0) return;
          if (fill) {
            fill.style.width = Math.round(((i + done / total) / ops.length) * 100) + "%";
          }
          if (ptext) {
            // Live ETA from the REAL bookmark total — the confirm-time estimate came
            // from possibly-stale cached counts. Upcoming ops add one posts/all each.
            const remainSec = (total - done) * 3.2 + (ops.length - i - 1) * 3.2;
            const eta = remainSec >= 3 ? " · " + t("tagGovTimeLeft", formatTagGovEst(remainSec)) : "";
            ptext.innerHTML = opLine + " " + t("tagGovRetagProgress", String(done), String(total)) + eta + queueSuffix();
          }
        });
        // Collect partial results BEFORE the abort check — an aborted op returns the
        // failed/skipped rows it accumulated, exactly what the user needs to see then.
        skippedTotal += res.skipped;
        for (const pr of (res.problems || [])) {
          _tagGovProblems.push({ ...pr, old: op.old, new: op.new });
        }
        if (res.cancelled) {
          cancelled = true;
          break;
        }
        if (res.aborted) {
          aborted = true;
          break;
        }
        // Skipped bookmarks don't fail the task — they are listed for manual editing.
        if (res.failed === 0) {
          ok++;
        } else {
          fail++;
        }
      } catch (e) {
        console.error("[tag-gov] op failed:", op, e);
        fail++;
      }
      continue;
    }

    if (op.op !== "delete") {
      fail++;
      continue;
    }
    const opUrl = `https://api.pinboard.in/v1/tags/delete?tag=${enc(op.tag)}&auth_token=${enc(token)}&format=json`;

    try {
      let resp = await pinboardFetch(opUrl);
      if (resp.status === 429) {
        if (ptext) ptext.textContent = t("tagGovRateLimitWait");
        await new Promise(r => setTimeout(r, TAG_GOV_RETRY_WAIT_MS));
        if (_tagGovCancelRequested) {
          cancelled = true;
          break;
        }
        resp = await pinboardFetch(opUrl);
        if (resp.status === 429) {
          aborted = true;
          break;
        }
      }
      if (!resp.ok) {
        fail++;
        _tagGovProblems.push({ kind: "failed", tag: op.tag, reason: "HTTP " + resp.status });
        continue;
      }
      const data = await resp.json();
      if (data.result === "done") {
        ok++;
      } else {
        fail++;
        _tagGovProblems.push({ kind: "failed", tag: op.tag, reason: String(data.result || "unknown") });
      }
    } catch (e) {
      console.error("[tag-gov] op failed:", op, e);
      fail++;
      _tagGovProblems.push({ kind: "failed", tag: op.tag, reason: e?.name || "network error" });
    }
  }

  if (fill && !aborted && !cancelled) fill.style.width = "100%";
  const cancelledBehind = (aborted || cancelled) ? _tagGovUnfinishedBatches - 1 : 0;
  if (aborted || cancelled) {
    _tagGovDrainCount = cancelledBehind;
    // Solo stop (nothing queued behind): release the cancel flag right away so a
    // batch confirmed during this batch's tail refresh runs normally.
    if (cancelledBehind === 0) _tagGovCancelRequested = false;
  }

  _tagGovRunTotals.ok += ok;
  _tagGovRunTotals.fail += fail;
  _tagGovRunTotals.skipped += skippedTotal;

  if (ptext) {
    const behindNote = cancelledBehind > 0 ? " · " + t("tagGovQueuedCancelled", String(cancelledBehind)) : "";
    ptext.textContent = cancelled
      ? t("tagGovStopped") + behindNote
      : aborted
        ? t("tagGovAborted429") + behindNote
        : t("tagGovDoneSummary", String(_tagGovRunTotals.ok), String(_tagGovRunTotals.fail))
          + (_tagGovRunTotals.skipped > 0 ? " · " + t("tagGovSkippedSummary", String(_tagGovRunTotals.skipped)) : "");
    // The manual-attention list renders below the (viewport-pinned) progress row, at
    // the bottom of the panel — out of sight when scrolled up. Link to it explicitly.
    if (_tagGovProblems.length > 0) {
      ptext.appendChild(document.createTextNode(" · "));
      const seeBelow = document.createElement("a");
      seeBelow.href = "#";
      seeBelow.textContent = t("tagGovProblemsSeeBelow");
      seeBelow.addEventListener("click", (ev) => {
        ev.preventDefault();
        // block:"center" keeps the list clear of the sticky progress card at the bottom
        $id("tag-gov-problems")?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      ptext.appendChild(seeBelow);
    }
  }
  renderTagGovProblems();

  // Refresh detection/UI only when this is the last batch in the queue: a mid-queue
  // renderTagGov() rebuilt the group rows under the user (resetting a canonical radio
  // they had just changed — risking a merge in the wrong direction) and burned one
  // forced tags/get per batch. The old pre-purge of cached_user_tags was redundant —
  // loadTagCounts(true) bypasses and rewrites the cache itself — and cleared popup
  // autocomplete's cache whenever the refetch failed.
  if (_tagGovUnfinishedBatches === 1) await _tagGovTailRefresh();

  return { ok, fail, aborted, cancelled };
}

async function loadTagCounts(forceFresh = false) {
  try {
    if (!forceFresh) {
      const cached = await chrome.storage.local.get({ cached_user_tags: null });
      if (cached.cached_user_tags) {
        const { counts, timestamp } = cached.cached_user_tags;
        if (Date.now() - timestamp < TAG_CACHE_TTL) {
          return counts || null;
        }
      }
    }
    const token = await getTagGovToken();
    if (!token) return null;
    const url = `https://api.pinboard.in/v1/tags/get?auth_token=${encodeURIComponent(token)}&format=json`;
    // tags/get on a slow pinboard day exceeds the default 15s timeout (seen in the
    // field: AbortError and Failed-to-fetch back-to-back) — allow 30s and retry once
    // through the queue before declaring failure to the panel.
    let resp;
    try {
      resp = await pinboardFetch(url, { timeoutMs: 30000 });
    } catch (e) {
      console.warn("[tag-gov] tags/get failed, retrying once:", e?.name || e);
      resp = await pinboardFetch(url, { timeoutMs: 30000 });
    }
    if (!resp || !resp.ok) return null;
    const counts = await resp.json();
    if (!counts || typeof counts !== "object") return null;
    await chrome.storage.local.set({
      cached_user_tags: { counts, timestamp: Date.now() }
    });
    return counts;
  } catch (e) {
    // Expected failure mode (slow/unreachable API) and already surfaced in the UI —
    // warn, not error: unpacked extensions list console.error on chrome://extensions,
    // which should stay reserved for real defects.
    console.warn("[tag-gov] loadTagCounts failed:", e);
    return null;
  }
}

async function renderTagGov() {
  const container = $id("tag-gov-groups");
  if (!container) return;

  // Do NOT empty the container before the awaits below: a paint during the async gap
  // collapses the panel height, Chrome clamps the scroll offset, and the page visibly
  // jumps to the top. Build the new content first, then swap atomically at the end.
  const stored = await chrome.storage.local.get({
    cached_user_tags: null,
    _tagGovIgnored: [],
    _tagGovAiGroups: { groups: [] }
  });
  const tagCounts = stored.cached_user_tags && stored.cached_user_tags.counts;

  if (!tagCounts) {
    const empty = document.createElement("div");
    empty.className = "fg";
    empty.textContent = t("tagGovNoGroups");
    container.replaceChildren(empty);
    return;
  }

  const ignoredList = stored._tagGovIgnored || [];
  // AI groups are a stored snapshot and never expire on their own. After a merge the
  // heuristic groups self-heal (rebuilt from fresh counts) but stale AI groups would
  // keep showing vanished members — worse, an AI group whose canonical was itself
  // just merged away would re-create that tag if merged. Filter members against the
  // live counts, refresh their counts, and drop groups left with fewer than 2 members.
  const aiGroups = ((stored._tagGovAiGroups && stored._tagGovAiGroups.groups) || [])
    .map(g => ({
      ...g,
      members: (g.members || [])
        .filter(m => m && Object.prototype.hasOwnProperty.call(tagCounts, m.tag))
        .map(m => ({ ...m, count: tagCounts[m.tag] }))
    }))
    .filter(g => g.members.length >= 2
      && g.members.some(m => m.tag === g.suggestedCanonical));

  let allGroups = pbpTagGovFindGroups(tagCounts);
  allGroups = allGroups.concat(aiGroups);
  // Heuristic and AI detection share the same id scheme (sorted members joined) and
  // the AI prompt is steered toward the same plural/separator/typo shapes — without
  // dedupe a duplicated group rendered twice with IDENTICAL radio name="group-<id>",
  // so the two rows fought over one radio group and a canonical chosen in one row
  // silently uncheck-ed the other. Keep the first occurrence (heuristic wins).
  const seenGroupIds = new Set();
  allGroups = allGroups.filter(g => !seenGroupIds.has(g.id) && seenGroupIds.add(g.id));
  allGroups = allGroups.filter(g => !ignoredList.includes(g.id));

  if (!allGroups.length) {
    const empty = document.createElement("div");
    empty.className = "fg";
    empty.textContent = t("tagGovNoGroups");
    container.replaceChildren(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const group of allGroups) {
    const row = document.createElement("div");
    row.className = "tag-gov-group-row";

    const badge = document.createElement("span");
    badge.className = "tag-gov-kind-badge";
    const kindKey = group.kind === "plural" ? "tagGovKindPlural"
      : group.kind === "separator" ? "tagGovKindSeparator"
      : group.kind === "typo" ? "tagGovKindTypo"
      : "tagGovKindAi";
    badge.textContent = t(kindKey);
    row.appendChild(badge);

    const membersList = document.createElement("div");
    membersList.className = "tag-gov-members";
    for (const member of group.members) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "group-" + group.id;
      radio.value = member.tag;
      radio.defaultChecked = (member.tag === group.suggestedCanonical);
      label.appendChild(radio);
      const text = document.createElement("span");
      text.textContent = " " + member.tag + " (" + member.count + ")";
      label.appendChild(text);
      membersList.appendChild(label);
    }
    row.appendChild(membersList);

    if (group.kind === "ai" && group.reason) {
      const reason = document.createElement("small");
      reason.className = "tag-gov-reason";
      reason.textContent = group.reason;
      row.appendChild(reason);
    }

    const btnGroup = document.createElement("div");
    btnGroup.className = "tag-gov-actions";

    const mergeBtn = document.createElement("button");
    mergeBtn.className = "btn btn-sm";
    mergeBtn.textContent = t("tagGovMerge");
    mergeBtn.addEventListener("click", () => {
      const selected = row.querySelector("input[type=\"radio\"]:checked");
      const canonical = selected ? selected.value : group.suggestedCanonical;
      if (typeof confirmMergeGroup === "function") confirmMergeGroup(group, canonical, mergeBtn);
    });
    btnGroup.appendChild(mergeBtn);

    const ignoreBtn = document.createElement("button");
    ignoreBtn.className = "btn btn-sm";
    ignoreBtn.textContent = t("tagGovIgnore");
    ignoreBtn.addEventListener("click", async () => {
      const result2 = await chrome.storage.local.get({ _tagGovIgnored: [] });
      const list = result2._tagGovIgnored || [];
      if (!list.includes(group.id)) {
        list.push(group.id);
        await chrome.storage.local.set({ _tagGovIgnored: list });
        await renderTagGov();
      }
    });
    btnGroup.appendChild(ignoreBtn);

    row.appendChild(btnGroup);
    frag.appendChild(row);

    // Re-freeze rows whose tags belong to a queued/RUNNING op — a user-triggered
    // re-render (ignore/refresh/AI) mid-run must restore the frozen state even with
    // a single batch running (the old counter>1 test dropped it, leaving a clickable
    // row whose confirm then no-oped silently on the active-tags guard). The one
    // exception is the drain-time tail render, where the active tags are released a
    // few microtasks later and marking would freeze the just-finished group's row.
    if (!_tagGovIsTailRender
        && _tagGovUnfinishedBatches > 0
        && group.members.some(m => m && m.tag && _tagGovActiveTags.has(m.tag.toLowerCase()))) {
      _tagGovMarkRowQueued(row);
    }
  }
  container.replaceChildren(frag);
}

async function renderLowCountTags() {
  const listContainer = $id("tag-gov-lowcount-list");
  if (!listContainer) return;

  // Same scroll-jump guard as renderTagGov: never leave the container empty across
  // an await — build first, swap atomically.
  const cached = await chrome.storage.local.get({ cached_user_tags: null });
  const counts = cached.cached_user_tags && cached.cached_user_tags.counts;
  if (!counts) {
    listContainer.replaceChildren();
    return;
  }

  const lowCount = pbpTagGovLowCountTags(counts, 1);
  if (!lowCount.length) {
    const empty = document.createElement("div");
    empty.textContent = t("tagGovNoLowCount");
    listContainer.replaceChildren(empty);
    return;
  }

  const table = document.createElement("div");
  table.className = "tag-gov-lowcount-table";
  const boxes = [];
  let lastIdx = null;            // anchor = last individually-clicked box; resets each render
  lowCount.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "tag-gov-lowcount-row";
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "tag-gov-lowcount-checkbox";
    checkbox.value = item.tag;
    checkbox.addEventListener("click", (e) => {
      // The browser already toggled this checkbox before the click handler runs,
      // so checkbox.checked is the new state and the range follows it. The anchor
      // moves only on a plain click; shift-clicks extend from the same anchor
      // (native checkbox-list range semantics).
      if (e.shiftKey && lastIdx !== null) {
        pbpTagGovApplyShiftRange(boxes, lastIdx, i);
      } else {
        lastIdx = i;
      }
    });
    boxes.push(checkbox);
    label.appendChild(checkbox);
    const text = document.createElement("span");
    text.textContent = " " + item.tag + " (" + item.count + ")";
    label.appendChild(text);
    row.appendChild(label);
    table.appendChild(row);
  });
  listContainer.replaceChildren(table);

  const summary = $id("tag-gov-lowcount")?.querySelector("summary");
  if (summary) summary.textContent = t("tagGovLowCountTitle") + " (" + lowCount.length + ")";

  const selectAll = $id("tag-gov-select-all");
  if (selectAll) {
    selectAll.checked = false;
    selectAll.onchange = () => {
      listContainer.querySelectorAll(".tag-gov-lowcount-checkbox")
        .forEach(cb => { cb.checked = selectAll.checked; });
    };
  }
}

// ---- Wayback Log Viewer ----
// Map a raw wayback outcome detail to an i18n explanation key, or null for unknown.
function waybackErrorKey(detail) {
  const d = String(detail || "").toLowerCase();
  if (!d) return null;
  if (d.includes("401") || d.includes("unauthorized")) return "archiveErrAuth";
  if (d.includes("failed to fetch") || d.includes("network")) return "archiveErrNetwork";
  if (d.includes("too-many-daily-captures")) return "archiveErrDailyLimit";
  if (d.includes("blocked")) return "archiveErrBlocked";
  if (d.includes("no-access") || d.includes("403")) return "archiveErrNoAccess";
  if (d.includes("not-found") || d.includes("404")) return "archiveErrNotFound";
  if (/http-5\d\d/.test(d) || d.includes("internal-server-error") || d.includes("service-unavailable") || d.includes("gateway") || d.includes("celery") || d.includes("job-failed") || d.includes("no-browsers")) return "archiveErrServer";
  return null;
}

async function renderWaybackLog() {
  const container = $id("wayback-log");
  if (!container) return;

  container.replaceChildren();

  let log = [];
  try {
    const data = await chrome.storage.local.get({ _waybackLog: [] });
    log = Array.isArray(data._waybackLog) ? data._waybackLog : [];
  } catch (_) {
    log = [];
  }

  // Show the Clear button only when there's something to clear
  const clearBtn = $id("wayback-log-clear");
  if (clearBtn) clearBtn.style.display = log.length ? "" : "none";

  if (!log.length) {
    const empty = document.createElement("div");
    empty.className = "wayback-log-empty";
    empty.textContent = t("archiveLogEmpty");
    container.appendChild(empty);
    return;
  }

  const reversed = [...log].reverse();

  function buildRow(entry) {
    const row = document.createElement("div");
    row.className = "wayback-log-row";

    const urlEl = document.createElement("a");
    urlEl.className = "wayback-log-url";
    let urlText = "";
    try { urlText = entry.url || ""; } catch (_) { urlText = ""; }
    urlEl.title = urlText;
    if (urlText) {
      urlEl.href = "https://web.archive.org/web/*/" + urlText;
      urlEl.target = "_blank";
      urlEl.rel = "noopener";
    }
    const urlTextSpan = document.createElement("span");
    urlTextSpan.className = "wayback-log-url-text";
    urlTextSpan.textContent = urlText;
    urlEl.appendChild(urlTextSpan);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "ext-icon");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M5 1h6v6M11 1L6 6M9 7v3H2V3h3");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.3");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    urlEl.appendChild(svg);

    const timeEl = document.createElement("span");
    timeEl.className = "wayback-log-time";
    timeEl.textContent = _waybackRelTime(entry.ts);

    const outcomeEl = document.createElement("span");
    outcomeEl.className = "wayback-log-outcome";
    const outcome = (typeof entry.outcome === "string") ? entry.outcome : "";
    let outcomeText;
    let showRetry = false;
    if (outcome === "requested") {
      outcomeText = t("archiveOutcomeRequested");
    } else if (outcome.startsWith("job:")) {
      outcomeText = t("archiveOutcomeRequested");
      outcomeEl.title = outcome;
    } else if (outcome === "skipped") {
      outcomeText = t("archiveOutcomeSkipped");
    } else if (outcome === "skippedPrivate") {
      outcomeText = t("archiveOutcomeSkippedPrivate");
    } else if (outcome === "permDenied") {
      outcomeText = t("waybackPermDenied");
    } else if (outcome === "rate-limited") {
      outcomeText = t("archiveOutcomeRateLimited");
      outcomeEl.title = t("archiveErrRateLimited");
      showRetry = true;
    } else if (outcome === "timeout") {
      outcomeText = t("archiveOutcomeTimeout");
      outcomeEl.title = t("archiveErrTimeoutHint");
      showRetry = true;
    } else if (outcome.startsWith("error")) {
      const detail = outcome.startsWith("error:") ? outcome.slice(6) : "";
      const errKey = waybackErrorKey(detail);
      outcomeText = errKey
        ? t("archiveOutcomeError") + " · " + t(errKey)
        : (detail ? t("archiveOutcomeError") + " · " + detail.slice(0, 48) : t("archiveOutcomeError"));
      outcomeEl.title = outcome;
      showRetry = true;
    } else {
      outcomeText = outcome;
    }
    outcomeEl.textContent = outcomeText;

    row.appendChild(urlEl);
    row.appendChild(timeEl);
    row.appendChild(outcomeEl);

    if (showRetry && entry.url) {
      const btn = document.createElement("button");
      btn.className = "wayback-log-retry";
      btn.title = t("archiveRetry");
      btn.setAttribute("aria-label", t("archiveRetry"));
      btn.innerHTML = PBP_ICONS.refresh;
      btn.addEventListener("click", () => {
        btn.disabled = true;
        try { chrome.runtime.sendMessage({ type: "archive_url", url: entry.url, force: true }).catch(() => {}); } catch (_) {}
        setTimeout(() => { renderWaybackLog(); }, 2500);
      });
      row.appendChild(btn);
    }

    return row;
  }

  const visible = reversed.slice(0, 10);
  const rest = reversed.slice(10);

  for (const entry of visible) {
    container.appendChild(buildRow(entry));
  }

  if (rest.length > 0) {
    const details = document.createElement("details");
    details.className = "wayback-log-more";
    const summary = document.createElement("summary");
    summary.textContent = t("archiveLogMore", String(rest.length));
    details.appendChild(summary);
    for (const entry of rest) {
      details.appendChild(buildRow(entry));
    }
    container.appendChild(details);
  }
}

function _waybackRelTime(ts) {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return t("offlineJustNow");
  const m = Math.floor(s / 60);
  if (m < 60) return t("offlineMinAgo", String(m));
  const h = Math.floor(m / 60);
  if (h < 24) return t("offlineHourAgo", String(h));
  const d = Math.floor(h / 24);
  return t("offlineDayAgo", String(d));
}
