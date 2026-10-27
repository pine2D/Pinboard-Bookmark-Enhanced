// The archive owns immutable generation records and independent cursors. OAuth,
// account validation, retries and the transport remain the shared Drive runner.
const PBP_DICT_ARCHIVE_DRIVE_PROTOCOL = Object.freeze({
  kind: "dict-entry-batch", schema: 4, readSchemas: [1, 2, 3, 4], filePrefix: "pbp-dict-entry",
  validateEvent: event => pbpDictArchiveValidateEvent(event),
  validBatchBody: (body, ownerHash) => pbpDictArchiveValidBatchBody(body, ownerHash)
});
function pbpCreateDictArchiveDriveSyncRunner(options = {}) {
  return pbpCreateVocabDriveSyncRunner({ ...options,
    client: options.client || pbpCreateVocabDriveClient({ protocol: PBP_DICT_ARCHIVE_DRIVE_PROTOCOL }),
    store: options.store || pbpCreateDictArchiveStore(), protocol: PBP_DICT_ARCHIVE_DRIVE_PROTOCOL });
}
