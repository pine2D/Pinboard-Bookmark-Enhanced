// The archive owns immutable generation records and independent cursors. OAuth,
// account validation, retries and the transport remain the shared Drive runner.
const PBP_ASK_ARCHIVE_DRIVE_PROTOCOL = Object.freeze({
  kind: "ask-history-batch", schema: 1, filePrefix: "pbp-ask-history",
  validateEvent: event => pbpAskArchiveValidateEvent(event),
  validBatchBody: (body, ownerHash) => pbpAskArchiveValidBatchBody(body, ownerHash)
});
function pbpCreateAskArchiveDriveSyncRunner(options = {}) {
  return pbpCreateVocabDriveSyncRunner({ ...options,
    client: options.client || pbpCreateVocabDriveClient({ protocol: PBP_ASK_ARCHIVE_DRIVE_PROTOCOL }),
    store: options.store || pbpCreateAskArchiveStore(), protocol: PBP_ASK_ARCHIVE_DRIVE_PROTOCOL });
}
