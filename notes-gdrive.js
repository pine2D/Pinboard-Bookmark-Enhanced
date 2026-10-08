// SW-only notes codec. OAuth, HTTP, bootstrap and retries share the vocabulary
// transport while the notes store owns its independent journal and cursors.
const PBP_NOTES_DRIVE_PROTOCOL = Object.freeze({
  kind: "notes-batch", schema: 1, filePrefix: "pbp-notes",
  validateEvent: (event) => pbpNotesValidateEvent(event),
  validBatchBody: (body, ownerHash) => pbpNotesValidBatchBody(body, ownerHash)
});
const PBP_NOTES_DRIVE_ALARMS = Object.freeze({
  dirty: "notes-sync-dirty", periodic: "notes-sync-periodic", retry: "notes-sync-retry"
});

function pbpCreateNotesDriveSyncRunner(options = {}) {
  return pbpCreateVocabDriveSyncRunner({
    ...options,
    client: options.client || pbpCreateVocabDriveClient({ protocol: PBP_NOTES_DRIVE_PROTOCOL }),
    store: options.store || pbpCreateNotesSyncStore(),
    protocol: PBP_NOTES_DRIVE_PROTOCOL,
    alarmNames: PBP_NOTES_DRIVE_ALARMS
  });
}

async function pbpNotesScheduleDirty(alarms = chrome.alarms, now = Date.now) {
  const when = now() + 30000;
  const existing = await alarms.get(PBP_NOTES_DRIVE_ALARMS.dirty);
  if (existing && Number.isFinite(existing.scheduledTime) && existing.scheduledTime <= when) return false;
  alarms.create(PBP_NOTES_DRIVE_ALARMS.dirty, { when });
  return true;
}
