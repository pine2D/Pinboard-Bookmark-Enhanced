// ============================================================
// Pinboard Bookmark Plus - Custom Style Injector
// Content script for pinboard.in pages
// ============================================================

(async () => {
  try {
    const { customFont, customCSS } = await chrome.storage.sync.get({
      customFont: "",
      customCSS: ""
    });

    if (!customFont && !customCSS) return;

    let css = "";
    if (customFont) {
      css += `body, .bookmark_title, .bookmark_description, .tag { font-family: ${customFont} !important; }\n`;
    }
    if (customCSS) {
      css += customCSS;
    }

    const style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  } catch (_) {}
})();
