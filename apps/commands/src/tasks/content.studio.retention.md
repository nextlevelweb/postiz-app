# Content Studio source version retention: operator runbook

Retention removes captured source versions that repeat the same page capture
(`compact_repeats`): within each run of identical captures it keeps the first
and the last version, and removes the versions in between that nothing
protects and that are old enough. It never removes a version that a draft, a
revision, a review or an AI operation names, the latest version of a source,
the versions its last page change is shown against, or anything made in the
last week. A removed version is gone from the database: only a backup brings it
back.

It runs only from these operator commands, one organization at a time, in the
backend container. There is no route, schedule, workflow or agent for it.

| Command                            | What it does                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `content-studio:retention-dry-run` | Reads only. Reports what the policy would remove, as a plan with a hash.          |
| `content-studio:retention-prepare` | Checks a reviewed plan, records it, and holds its candidates. Removes nothing.    |
| `content-studio:retention-execute` | Once the plan is ready: checks every candidate again and removes them.            |
| `content-studio:retention-cancel`  | Ends an execution that has not ended and releases what it holds. Removes nothing. |

Run the commands with `node dist/apps/commands/src/main.js <command> ...` in the
backend container. Run `prepare` and `execute` on the same host, so that both
use the same clock.

## Limits

- At most 10,000 candidates per execution. A larger plan is refused
  (`RETENTION_EXECUTION_TOO_LARGE`). Plan a smaller organization, or wait for
  scoped plans.
- A plan that holds any source back (`blockedSources` not empty) is refused
  (`RETENTION_EXECUTION_BLOCKED_SOURCES`).
- One active execution per organization. A plan is executed at most once,
  whatever happened to it. Every new attempt needs a fresh dry run.
- A plan is valid for one hour after its dry run (`validUntil`). The prepare,
  the wait of 60 seconds after the last hold, and the **start** of execute must
  all happen before `validUntil`.
- Versions are removed in batches of 100. Nothing sets another size.

## Procedure

### 0. Before you start

Confirm that the deployed image includes the retention execution: the
`content-studio:retention-prepare` command exists.

### 1. Backup (an operational prerequisite, not checked by the commands)

Immediately before the dry run:

1. Take a full PostgreSQL backup of the production database.
2. Confirm that it completed.
3. Confirm that it can be restored, for example from its size and table
   listing, or by restoring it into a scratch database.
4. Keep it for at least 30 days after the execution.

The commands never create, check or read a backup, and never call Coolify or
`pg_dump`. `--backup-confirmed` on execute records your word that this backup
exists. The command prints: "This command does not create or verify your
database backup."

Also confirm the free disk space of the database volume. Removing rows writes
WAL roughly the size of the removed content, and the disk does not shrink at
once. Free space should comfortably exceed about twice the plan's
`candidateSummary.logicalContentBytes`, plus your normal WAL margin.
`logicalContentBytes` is the logical size of the candidates' content, only an
estimate. It is never the disk space that is freed.

### 2. Dry run

```sh
node dist/apps/commands/src/main.js content-studio:retention-dry-run \
  --organization <organization id> --older-than-days <days, 7 or more> --json \
  > /secure/plan-<organization id>-<time>.json
chmod 600 /secure/plan-<organization id>-<time>.json
```

The plan names versions by id, with their hashes and counts only. It holds no
content, title or URL, but keep it private all the same.

### 3. Review (a human, before the hour ends)

```sh
jq '.organizationId, .candidateSummary, .blockedSources, .dryRunHash' plan.json
jq '.candidates[:20]' plan.json
```

Check that:

- the organization is the one you mean
- `blockedSources` is `[]`
- the number of candidates is between 1 and 10,000
- `logicalContentBytes` fits the disk headroom from step 1
- `evaluationNow` and `validUntil` leave enough time for steps 4 to 6

### 4. Prepare

```sh
node dist/apps/commands/src/main.js content-studio:retention-prepare \
  --plan plan.json --organization <organization id> --confirm
```

Prepare checks the plan file (format, versions, organization, times, policy,
candidates and its own hash). It then makes the dry run again at the plan's
time, and goes on only if the hash is the same. It records the execution, its
items and the organization's lock, and holds every candidate: from then on, no
draft, revision or AI operation can name them. Note the execution id and
`readyAt`. A plan file larger than 64 MiB is refused before it is read.

- Exit code 0 means prepared, or `nothing_to_delete` (the plan had no
  candidates, and nothing was recorded).
- Exit code 1 means refused. Nothing is held. Plan again from step 1 or 2.
- Exit code 2 means `cleanup_required`. Go to "Recovery".

### 5. Wait

Wait until `readyAt`, which is 60 seconds after the last candidate was held.
Nothing needs to keep running in the meantime: the state is in the database,
and the terminal may be closed. Executing earlier answers
`RETENTION_EXECUTION_NOT_READY` (exit code 1) and changes nothing.

### 6. Execute (at or after readyAt, before validUntil)

```sh
node dist/apps/commands/src/main.js content-studio:retention-execute \
  --execution <execution id> --backup-confirmed --confirm
```

1. Execute checks every candidate again in one snapshot, both at the plan's time
   and now. Each must still be there exactly as planned, still a candidate,
   held for this plan only, and its source must read the same without it.
2. If any candidate is not, the whole plan is aborted and nothing is removed.
3. Otherwise it removes the candidates in batches. Each batch is one
   transaction that removes the candidates' held rows, removes the versions and
   records the items as deleted.
4. Each source is checked once its last batch is done, and the whole
   organization at the end.

### 7. Inspect the outcome

| Exit code | Outcome                               | What to do                                                                                                                                                                                                            |
| --------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | `completed`, `integrityCheck: passed` | Done.                                                                                                                                                                                                                 |
| 1         | `not_ready`                           | Wait until `readyAt`, then run execute again.                                                                                                                                                                         |
| 1         | `aborted`                             | Nothing was removed and nothing is held. A fresh dry run is needed.                                                                                                                                                   |
| 2         | `partial`                             | Some batches were removed, then it stopped. What was left is released. Read `errorCode` and `integrityCheck`. A fresh dry run is needed before any further retention. If `integrityCheck` is `failed`, see "Restore". |
| 2         | `cleanup_required` or `interrupted`   | Run cancel (see "Recovery").                                                                                                                                                                                          |

The report and the execution row hold ids, hashes, counts, times and codes only.

### 8. Cancel, when needed

```sh
node dist/apps/commands/src/main.js content-studio:retention-cancel \
  --execution <execution id> --confirm
```

Cancel ends an execution that has not ended (preparing, prepared or
executing): it releases every version still held for its plan, removes no
version, and ends the execution.

- An execution with no version removed ends as `cancelled` (exit code 0).
- An execution that removed versions ends as `partial`, after the organization
  is checked (exit code 2).

Cancel can be run again until it succeeds. On an execution that already ended,
it answers `RETENTION_EXECUTION_STATE_INVALID`.

### 9. Keep the records

Keep `plan.json` and the execution id with the operations records for as long
as the backup is kept. The execution and its items stay in the database: they
list exactly which versions were removed, in which batch, and when.

### 10. After the execution

Watch WAL, autovacuum and the database disk. Removed rows are reclaimed by
ordinary autovacuum. The disk may not shrink at once. Never run `VACUUM FULL`
or an explicit `VACUUM` for this: it locks tables.

## Recovery

An interrupted command (a lost SSH session, a crash, a killed process) leaves
the execution as it was, with the organization's lock. The candidates stay
held, so writers stay safe.

- The next prepare for that organization answers
  `RETENTION_EXECUTION_ALREADY_ACTIVE` and names the execution.
- Run cancel for that execution, then plan again from step 1.

Nothing resumes an execution, and nothing releases held versions on its own.

If a release fails (`RETENTION_EXECUTION_CLEANUP_REQUIRED`), the execution
keeps its lock, so that nothing else starts. Run cancel again once the
database is reachable.

## Restore

The backup from step 1 is the only copy of the removed versions.

The preferred path is a selective restore:

1. Restore the backup into a scratch PostgreSQL database, never production.
2. Take the removed version ids from the execution's items: the rows of
   `ContentStudioSourceVersionRetentionExecutionItem` with that `executionId`
   and status `deleted`.
3. Extract exactly those `ContentStudioSourceVersion` rows from the scratch
   database, and insert them into production with a reviewed operator
   procedure. Version ids and numbers are never reused, so the rows return to
   their places in history.
4. Afterwards, run a dry run for the organization to confirm that every
   protection resolves again.

No command does this, and nothing restores automatically.

A full database restore is a last resort only. It loses every write made since
the backup: drafts, revisions, captures, reviews and AI operations.
