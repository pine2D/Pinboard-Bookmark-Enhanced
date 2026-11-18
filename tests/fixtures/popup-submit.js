// Test-only access to the live popup's lexical form state. No production source
// is parsed or re-executed. Every case gets a separate fixture document.
window.popupSubmitFixture = {
  setupSubmit,
  account: () => pbpBookmarkConnection(settings).account,
  replaceTags: tags => { currentTags = tags.slice(); },
  configure({ url, title, notes, tags, private: isPrivate = false, toread = false, loaded = null, service = "pinboard", archiveTouched = false, archive = false }) {
    settings = { pinboardToken: "alice:fixture-token", bookmarkService: service, optAutoCloseAfterSave: false, waybackArchiveEnabled: false };
    if (service !== "pinboard") {
      settings[service + "Url"] = "https://bookmarks.example/";
      settings[service + "Token"] = pbpBookmarkCredentialSeal({
        baseUrl: settings[service + "Url"], token: "fixture-token",
        connectionId: "fixture-connection", userId: "fixture-user", sharing: true,
      });
    }
    currentTags = tags.slice();
    existingBookmark = loaded;
    bookmarkLookup = { status: loaded ? "found" : "missing", url, generation: 1, promise: null, formLoaded: !!loaded };
    _pageInfoReady = true;
    _archiveUserTouched = archiveTouched;
    _waybackHostGranted = false;
    _popupDraftContext = null;
    const values = { "url-input": url, "title-input": title, "description-input": notes, "linkding-description-input": "", "tags-input": "" };
    for (const [id, value] of Object.entries(values)) document.getElementById(id).value = value;
    document.getElementById("private-check").checked = isPrivate;
    document.getElementById("readlater-check").checked = toread;
    document.getElementById("archive-check").checked = archive;
    setupSubmit(settings.pinboardToken);
  },
};
