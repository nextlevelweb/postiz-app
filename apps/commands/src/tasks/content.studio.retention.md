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

## Where the commands run

Every command below is typed on the Docker host and runs in the backend
container:

```sh
BE=<backend container name>       # from docker ps
PG=<PostgreSQL container name>    # from docker ps
docker exec -i -w /app/apps/commands "$BE" \
  node dist/apps/commands/src/main.js <command> ...
```

- `-w /app/apps/commands`: `dist/apps/commands/src/main.js` is relative to
  that directory. From `/app` the command fails with "Cannot find module".
- `-i`, never `-t`. A TTY merges the command's stderr into its stdout and ends
  every line with a carriage return. The saved output is then no longer the
  plan, and prepare refuses it (`RETENTION_EXECUTION_PLAN_INVALID`).
- With `--json`, stdout is one line of JSON and nothing else. Startup logs and
  refusals (`Retention <step> refused: <code>`) go to stderr.
- Run prepare and execute in the same backend container, so that both use the
  same clock.
- The application image has no `psql` or `pg_dump`. The read-only database
  checks ("Read-only database checks") run in the PostgreSQL container, with
  its own user. Nothing in this runbook prints a password or `DATABASE_URL`.

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

## The first run

- **Size**: 20 to 500 candidates, ideally 50 to 200, of one organization. Take
  an internal organization first.
- **Age**: `--older-than-days 90`. Only if that plan has 0 candidates, make a
  dry run with 60, and only if that one has 0 too, with 30. Never fewer than 30
  days for the first run: never 7. More than 500 candidates at 90 days: use
  more days, or another organization. There is no other way to make a plan
  smaller.
- **Window**: a staffed, low-traffic window, with time for the whole procedure
  and the checks after it. From prepare to the end of execute, at most about
  an hour, a draft, revision or AI operation that names a held version is
  refused (409 `CS_SOURCE_VERSION_RETENTION_PENDING`). No maintenance mode is
  needed.

### Go / no-go

Go only if all of these hold. Otherwise, stop: a plan that was not prepared
leaves nothing behind.

- The running deployment contains the reviewed release with the retention
  execution (step 0).
- The schema has the four retention tables (step 0).
- The backup of step 1 completed and can be restored.
- `blockedSources` is `[]`.
- The plan has 20 to 500 candidates.
- `logicalContentBytes` is acceptable, and the disk and WAL headroom of step 1
  covers it.
- `validUntil` leaves enough time for steps 5 to 9: at least 30 minutes at
  prepare.
- No execution is active and no version is held for the organization (checks
  3 and 4 return nothing).
- The window is staffed and has low traffic.
- The operator knows "Cancel" and "Recovery".

## Procedure

### 0. Before you start

Confirm that the running image includes the reviewed retention execution:

```sh
docker exec -i "$BE" grep -rl content-studio:retention-prepare \
  /app/apps/commands/dist/apps/commands/src/tasks/
```

Confirm that the database has the retention tables: check 0 of "Read-only
database checks" lists four tables.

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

### 2. Private operations directory

On the Docker host, never in the container, a repository or a web root:

```sh
ORG=<organization id>
umask 077
DIR=/root/content-studio-retention/$(date -u +%Y%m%dT%H%MZ)-$ORG
mkdir -p "$DIR" && chmod 700 /root/content-studio-retention "$DIR"
```

Keep every file of the run here: `dry-run.stderr`, `plan.json`,
`prepare.json`, `prepare.stderr`, `execute.json`, `execute.stderr`, and
`cancel.json` and `cancel.stderr` if cancel runs. The directory is `700` and
its files are `600`. These files hold ids, hashes, counts, times and codes
only. Never write a password, `DATABASE_URL` or token here.

This directory is the record of the run. The container is not: its filesystem
is lost when the backend is redeployed.

### 3. Dry run

```sh
docker exec -i -w /app/apps/commands "$BE" \
  node dist/apps/commands/src/main.js content-studio:retention-dry-run \
  --organization "$ORG" --older-than-days 90 --json \
  > "$DIR/plan.json" 2> "$DIR/dry-run.stderr"
echo "exit $?"; chmod 600 "$DIR"/*
```

- Exit code 0: `plan.json` is the plan, one line of JSON.
- Exit code 1: refused. The reason is the last line of `dry-run.stderr`.
  `RETENTION_DRY_RUN_QUARANTINE_ACTIVE` means that versions of the
  organization are still held: see "Recovery".

The plan names versions by id, with their hashes and counts only. It holds no
content, title or URL, but keep it private all the same.

### 4. Review (a human, before the hour ends)

```sh
P="$DIR/plan.json"
jq '.organizationId, .candidateSummary, .blockedSources, .dryRunHash' "$P"
jq '{evaluationNow, validUntil, policy}' "$P"
jq '.candidates | length' "$P"
jq '[.candidates[].candidateReason] | unique' "$P"
# the sources with the most candidates
jq -r '.candidates | group_by(.sourceId) | map([length, .[0].sourceId])
  | sort_by(-.[0]) | .[:20][] | @tsv' "$P"
jq -r '.sources[] | select(.candidateVersions > 0)
  | [.sourceId, .totalVersions, .protectedVersions, .policyRetainedVersions,
     .candidateVersions] | @tsv' "$P"
jq '.candidates[:20]' "$P"
jq -r '(.validUntil | sub("\\.[0-9]+Z$"; "Z") | fromdate) - now
  | "\(floor) seconds left"' "$P"
```

Check that:

- the organization is the one you mean
- `blockedSources` is `[]`
- the number of candidates is in the first-run range (20 to 500)
- every `candidateReason` is `REPEAT_RUN_INTERIOR`
- no source has unexpectedly many candidates, and every source keeps versions
- `logicalContentBytes` fits the disk headroom from step 1
- `validUntil` leaves enough time for steps 5 to 9

If anything is off, stop here. Nothing is held yet.

### 5. Copy the plan into the container

Prepare reads `--plan` inside the backend container, where a file on the host
does not exist. Copy it in through stdin:

```sh
docker exec -i "$BE" sh -c '
  umask 077
  mkdir -p /root/content-studio-retention
  cat > /root/content-studio-retention/plan.json
' < "$DIR/plan.json"
```

The copy in the container is only the input of prepare. The plan in `$DIR` is
the record.

### 6. Prepare

```sh
docker exec -i -w /app/apps/commands "$BE" \
  node dist/apps/commands/src/main.js content-studio:retention-prepare \
  --plan /root/content-studio-retention/plan.json \
  --organization "$ORG" --confirm --json \
  > "$DIR/prepare.json" 2> "$DIR/prepare.stderr"
echo "exit $?"; chmod 600 "$DIR"/*
EXEC=$(jq -r '.executionId // empty' "$DIR/prepare.json"); echo "$EXEC"
```

Prepare checks the plan file (format, versions, organization, times, policy,
candidates and its own hash). It then makes the dry run again at the plan's
time, and goes on only if the hash is the same. It records the execution, its
items and the organization's lock, and holds every candidate: from then on, no
draft, revision or AI operation can name them. A plan file larger than 64 MiB
is refused before it is read.

### 7. Inspect the prepare result

```sh
jq . "$DIR/prepare.json"; tail -n 3 "$DIR/prepare.stderr"
```

| Exit code | Outcome                             | What to do                                                                                         |
| --------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| 0         | `prepared`                          | Check below, then go to step 8.                                                                    |
| 0         | `nothing_to_delete`                 | The plan had no candidates. Nothing was recorded. Stop.                                            |
| 1         | refused, or `aborted`               | Nothing is held. Find the reason, then plan again from step 1.                                     |
| 2         | `cleanup_required` or `interrupted` | Go to "Recovery".                                                                                  |
| 2         | refused, `CLEANUP_REQUIRED`         | The database failed. `prepare.json` is empty. Go to "Recovery" and look the execution id up there. |

For `prepared`, check that:

- `executionId` is saved (`$EXEC`)
- `plannedCount` equals the number of candidates in the plan
- `errorCode` is `null`
- `readyAt` is before `validUntil`
- optional: check 3 counts `plannedCount` held versions, and check 4 names
  `$EXEC`

If anything is off, do not execute: cancel (see "Cancel").

### 8. Wait

Wait until `readyAt`, which is 60 seconds after the last candidate was held.
Nothing needs to keep running in the meantime: the state is in the database,
and the terminal may be closed. Executing earlier answers `not_ready`
(`RETENTION_EXECUTION_NOT_READY`, exit code 1) and changes nothing.

### 9. Execute (at or after readyAt, before validUntil)

Run it from a session that survives a lost connection, such as `tmux` on the
host:

```sh
docker exec -i -w /app/apps/commands "$BE" \
  node dist/apps/commands/src/main.js content-studio:retention-execute \
  --execution "$EXEC" --backup-confirmed --confirm --json \
  > "$DIR/execute.json" 2> "$DIR/execute.stderr"
echo "exit $?"; chmod 600 "$DIR"/*
jq . "$DIR/execute.json"; tail -n 3 "$DIR/execute.stderr"
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

Started at or after `validUntil`, execute releases what is held and ends
`aborted` (`RETENTION_EXECUTION_PLAN_EXPIRED`). Nothing is removed.

| Exit code | Outcome                               | What to do                                                                                               |
| --------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 0         | `completed`, `integrityCheck: passed` | Done. Go to step 11.                                                                                     |
| 1         | `not_ready`                           | Wait until `readyAt`, then run execute again.                                                            |
| 1         | `aborted`                             | Nothing was removed and nothing is held. A fresh dry run is needed.                                      |
| 1         | refused                               | Nothing changed. Read the code on stderr. `RETENTION_EXECUTION_ALREADY_RUN` means this plan already ran. |
| 2         | `partial`                             | Some batches were removed, then it stopped. What was left is released. See "Outcomes".                   |
| 2         | `cleanup_required` or `interrupted`   | See "Outcomes".                                                                                          |
| 2         | refused, `CLEANUP_REQUIRED`           | The database failed. `execute.json` is empty. Go to "Recovery".                                          |

The report and the execution row hold ids, hashes, counts, times and codes only.

### 10. Monitor

From a second terminal, without touching the execution:

```sh
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E "$BE|$PG"
docker stats --no-stream "$BE" "$PG"
docker exec "$PG" pg_isready
df -h <database volume>
```

Execute of a few hundred candidates takes seconds. Do not start a second
command for the organization while it runs.

### 11. After a successful execution

Check that:

- `execute.json` has `outcome` `completed`, `deletedCount` equal to
  `plannedCount`, `integrityCheck` `passed` and `errorCode` `null`
- the read-only checks agree: check 1 shows the execution `completed`, check 2
  only `deleted` items, check 3 no held version, check 4 no lock, and check 5
  `0`
- the backend is healthy and Content Studio opens. A source with removed
  versions shows its history (gaps in the version numbers are expected) and
  its latest version. An existing draft opens and saves. The next capture of
  that source succeeds.

Watch WAL, autovacuum and the database disk. Removed rows are reclaimed by
ordinary autovacuum: rely on it. Never run `VACUUM FULL`: it rewrites the table
and locks it. A manual `VACUUM` is not part of this procedure. The disk does not
shrink at once: the space is reused.

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
  FROM pg_stat_user_tables WHERE relname = 'ContentStudioSourceVersion';
```

### 12. Keep the records

Keep `$DIR` (the plan, every output and the execution id) with the operations
records for as long as the backup: at least 30 days. The execution and its
items stay in the database: they list exactly which versions were removed, in
which batch, and when.

## Cancel

```sh
docker exec -i -w /app/apps/commands "$BE" \
  node dist/apps/commands/src/main.js content-studio:retention-cancel \
  --execution "$EXEC" --confirm --json \
  > "$DIR/cancel.json" 2> "$DIR/cancel.stderr"
echo "exit $?"; chmod 600 "$DIR"/*
jq . "$DIR/cancel.json"; tail -n 3 "$DIR/cancel.stderr"
```

Cancel ends an execution that has not ended (preparing, prepared or
executing): it releases every version still held for its plan, removes no
version, and ends the execution.

- An execution with no version removed ends as `cancelled` (exit code 0).
- An execution that removed versions ends as `partial`, after the organization
  is checked (exit code 2).
- If the release cannot be proven, it answers `cleanup_required` (exit code 2).
  The execution keeps its lock. Run cancel again once the database is
  reachable.

Cancel can be run again until it succeeds. On an execution that already ended,
it answers `RETENTION_EXECUTION_STATE_INVALID` (exit code 1).

## Outcomes

- **Success**: `completed`, `integrityCheck` `passed`. Do the checks of step
  11, and keep the backup.
- **Safe abort**: `aborted`, or a refusal with exit code 1. Nothing was removed
  (`deletedCount` 0) and nothing is held. Find the reason in `errorCode` or on
  stderr. Plan again from step 1 only once it is understood.
- **Partial**: `partial`. Some batches were removed and the rest was released.
  Read `errorCode` and `integrityCheck`. Stop: no further retention until it is
  understood. A later dry run lists the remaining candidates again.
- **Cleanup required**: `cleanup_required`, or a refusal
  `RETENTION_EXECUTION_CLEANUP_REQUIRED`. The lock and held versions may
  remain. Run cancel (see "Recovery" for a lost id) until it ends the
  execution. Then confirm with checks 3 and 4, and stop.
- **Interrupted**: `interrupted`. Another command ended the execution while
  this one ran. Inspect the execution as it is now (checks 1 and 4). If it
  still has a lock, run cancel. Otherwise read its status and follow it.
- **Integrity failed**: `integrityCheck` `failed` (`partial`,
  `RETENTION_EXECUTION_INTEGRITY_FAILED`). Stop all retention. Preserve the
  backup. Do not repair anything by hand. A read-only dry run of the
  organization names the record that does not verify (model and id). Then
  investigate a selective restore (see "Restore").

## Recovery

An interrupted command (a lost SSH session, a crash, a killed process) leaves
the execution as it was, with the organization's lock. The candidates stay
held, so writers stay safe. Nothing resumes an execution, and nothing releases
held versions on its own.

1. **Find the execution id.** Take it from the saved output first: `executionId`
   in `prepare.json` or `execute.json`. If the output has none, for example
   because prepare was interrupted while it held versions, before it printed
   anything, look it up read-only from the organization's lock (check 4):

   ```sql
   SELECT "executionId", "acquiredAt"
     FROM "ContentStudioSourceVersionRetentionExecutionLock"
    WHERE "organizationId" = '<organization id>';
   ```

   No row means no execution is active for the organization. If versions are
   still held all the same (check 3), stop and escalate.

2. **Cancel it**, with its output saved (see "Cancel"). Repeat until it
   answers `cancelled` or `partial`.
3. **Confirm**: check 3 counts 0 and check 4 returns no row.
4. **Plan again from step 1**, with a new backup, once the cause is understood.

Do not use prepare to find the execution. Prepare names the active execution
(`RETENTION_EXECUTION_ALREADY_ACTIVE`, `execution <id>`) only if it gets that
far, with a new plan while no version is held. While versions are held, a new
dry run is refused (`RETENTION_DRY_RUN_QUARANTINE_ACTIVE`). The old plan
answers `RETENTION_EXECUTION_ALREADY_RUN` or `RETENTION_EXECUTION_PLAN_EXPIRED`,
without an id.

## Read-only database checks

Run them in the PostgreSQL container. `POSTGRES_DB` must be the production
database. If it is not, name that database with `-d` instead:

```sh
docker exec -i "$PG" sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -v org="$1" -v exec="$2"' \
  sh "$ORG" "${EXEC:-00000000-0000-0000-0000-000000000000}" <<'SQL'
BEGIN READ ONLY;
-- 0. the four retention tables exist
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name LIKE 'ContentStudioSourceVersionRetention%' ORDER BY 1;
-- 1. the organization's executions
SELECT id, status, "plannedCount", "deletedCount", "batchCount", "errorCode",
       "integrityCheck", "readyAt", "planValidUntil", "finishedAt"
  FROM "ContentStudioSourceVersionRetentionExecution"
 WHERE "organizationId" = :'org' ORDER BY "createdAt" DESC LIMIT 5;
-- 2. the execution's items by status
SELECT status, count(*) FROM "ContentStudioSourceVersionRetentionExecutionItem"
 WHERE "executionId" = :'exec' GROUP BY status;
-- 3. versions still held for the organization
SELECT count(*) AS held FROM "ContentStudioSourceVersionRetentionPending"
 WHERE "organizationId" = :'org';
-- 4. the active execution of the organization (its lock)
SELECT "executionId", "acquiredAt"
  FROM "ContentStudioSourceVersionRetentionExecutionLock"
 WHERE "organizationId" = :'org';
-- 5. versions recorded as deleted that are still there (expected: 0)
SELECT count(*) AS still_there
  FROM "ContentStudioSourceVersionRetentionExecutionItem" i
  JOIN "ContentStudioSourceVersion" v ON v.id = i."sourceVersionId"
 WHERE i."executionId" = :'exec' AND i.status = 'deleted';
ROLLBACK;
SQL
```

They select ids, counts, statuses, codes and times only, never content, titles
or URLs.

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
the backup, in all of Postiz: drafts, revisions, captures, reviews, AI
operations, posts and integrations.
