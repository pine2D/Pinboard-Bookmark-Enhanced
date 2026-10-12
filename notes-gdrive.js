// SW-only notes codec. OAuth, HTTP, bootstrap, retries and the shared
// connection record come from the vocabulary transport; the notes store owns
// its independent journal and cursors.
const PBP_NOTES_DRIVE_PROTOCOL = Object.freeze({
  kind: "notes-batch", schema: 1, filePrefix: "pbp-notes",
  validateEvent: (event) => pbpNotesValidateEvent(event),
  validBatchBody: (body, ownerHash) => pbpNotesValidBatchBody(body, ownerHash)
});

function pbpCreateNotesDriveSyncRunner(options = {}) {
  return pbpCreateVocabDriveSyncRunner({
    ...options,
    client: options.client || pbpCreateVocabDriveClient({ protocol: PBP_NOTES_DRIVE_PROTOCOL }),
    store: options.store || pbpCreateNotesSyncStore(),
    protocol: PBP_NOTES_DRIVE_PROTOCOL
  });
}
