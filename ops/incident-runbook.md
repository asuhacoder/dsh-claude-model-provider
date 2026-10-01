# Incident and rollback

Stop promotion on install failures, new privacy/authentication issues, or severe usage regression. Keep previous tarballs and state backup; uninstall the provider through DSH's plugin manager to restore composition. Do not delete official authentication profiles or user histories. A crashed local writer leaves writer.lock: inspect its PID and stop/confirm the process is gone before removing only that lock; never remove the database. Unknown tool effects require a DSH receipt or human reconciliation before continuation. npm tag rollback requires maintainer publisher authority; never overwrite a published version.

## Local state during an active provider

`accounts list`, `explain-route`, and redacted diagnostics use a read-only SQLite connection, so they can inspect a running provider without taking its writer lock or clearing reservations. To recover a crashed writer, run `doctor --recover`; it refuses a live/inaccessible PID and removes only a lock whose recorded process no longer exists. Bindings, usage and tool receipts remain intact. Restart releases stale local reservations but does not treat consumed usage as refunded. A persisted provider circuit retains its backoff and releases an abandoned half-open probe.
