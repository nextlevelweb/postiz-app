import fs from 'fs';
import os from 'os';
import { Command, Option } from 'nestjs-command';
import { Injectable } from '@nestjs/common';
import {
  ContentStudioSourceRetentionExecutionService,
  contentStudioSourceVersionRetentionExecutionExitCode,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention-execution.service';
import {
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PLAN_MAX_BYTES,
  ContentStudioSourceVersionRetentionExecutionError,
  parseContentStudioSourceVersionRetentionPlan,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';
import { canonicalJson } from '@gitroom/nestjs-libraries/content-studio/canonical.json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NO_BACKUP =
  'This command does not create or verify your database backup.';

type Report = Awaited<
  ReturnType<ContentStudioSourceRetentionExecutionService['cancel']>
>;

// The retention execution of one organization (P8-R1C), for an operator
// only, in three commands: prepare a reviewed dry-run plan (the exact
// output of content-studio:retention-dry-run --json), execute it once it is
// ready, or cancel it. Each needs --confirm; execute needs --backup-confirmed
// too, the operator's word that a full database backup was made before the
// dry run (nothing here makes or checks one). There is nothing to skip the
// wait or the checks, to size batches, to force or resume anything: an
// interrupted execution is cancelled and planned again. --json prints the
// report as canonical JSON and nothing else on stdout; refusals go to
// stderr. Exit code 0: done; 1: nothing removed and nothing left held; 2: an
// operator must look (partial, integrity failed, cleanup required)
@Injectable()
export class ContentStudioRetentionExecution {
  constructor(
    private _contentStudioSourceRetentionExecutionService: ContentStudioSourceRetentionExecutionService
  ) {}

  @Command({
    command: 'content-studio:retention-prepare',
    describe:
      'Prepare a reviewed Content Studio retention dry-run plan: check it, record it and hold its candidates. Removes nothing.',
  })
  async prepare(
    @Option({
      name: 'plan',
      describe:
        'The plan: a file with the JSON of content-studio:retention-dry-run --json',
      type: 'string',
      required: false,
    })
    plan?: string,
    @Option({
      name: 'organization',
      describe: 'The organization id the plan is of',
      type: 'string',
      required: false,
    })
    organization?: string,
    @Option({
      name: 'confirm',
      describe: 'Prepare the plan',
      type: 'boolean',
      default: false,
      required: false,
    })
    confirm?: boolean,
    @Option({
      name: 'json',
      describe: 'Print the report as JSON, and nothing else',
      type: 'boolean',
      default: false,
      required: false,
    })
    json?: boolean
  ) {
    if (confirm !== true) {
      return refuse(
        'prepare',
        'RETENTION_EXECUTION_PLAN_INVALID (--confirm is required)'
      );
    }
    if (typeof organization !== 'string' || !UUID.test(organization)) {
      return refuse('prepare', '--organization must be an organization id');
    }
    if (typeof plan !== 'string' || !plan) {
      return refuse(
        'prepare',
        'RETENTION_EXECUTION_PLAN_INVALID (--plan is required)'
      );
    }
    let text: string;
    try {
      const file = fs.statSync(plan);
      if (
        !file.isFile() ||
        file.size > CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PLAN_MAX_BYTES
      ) {
        return refuse(
          'prepare',
          'RETENTION_EXECUTION_PLAN_INVALID (not a plan file, or too large)'
        );
      }
      text = fs.readFileSync(plan, 'utf8');
    } catch {
      return refuse(
        'prepare',
        'RETENTION_EXECUTION_PLAN_INVALID (the plan file cannot be read)'
      );
    }

    return run('prepare', json, async () => {
      if (!json) {
        // what is about to be prepared; the service checks it all again
        const preflight = parseContentStudioSourceVersionRetentionPlan(
          text,
          organization
        );
        console.log(
          'Content Studio retention prepare: prepare does not delete SourceVersions.'
        );
        console.log(`Organization: ${preflight.organizationId}`);
        console.log(`Plan hash: ${preflight.planHash}`);
        console.log(
          `Policy: ${
            preflight.policy.mode
          }, versions made before ${preflight.policy.olderThan.toISOString()}`
        );
        console.log(
          `Evaluated at ${preflight.evaluationNow.toISOString()}, valid until ${preflight.validUntil.toISOString()}`
        );
        console.log(
          `Candidates: ${preflight.candidates.length} of ${preflight.sourceCount} sources`
        );
        console.log(
          `Logical content bytes of the candidates: ${
            preflight.logicalContentBytes ?? 'unknown'
          } (not disk space PostgreSQL would free)`
        );
      }
      return this._contentStudioSourceRetentionExecutionService.prepare({
        organizationId: organization,
        plan: text,
        clock: () => new Date(),
      });
    });
  }

  @Command({
    command: 'content-studio:retention-execute',
    describe:
      'Execute a prepared Content Studio retention plan once it is ready: check every candidate again and remove them.',
  })
  async execute(
    @Option({
      name: 'execution',
      describe: 'The execution id prepare printed',
      type: 'string',
      required: false,
    })
    execution?: string,
    @Option({
      name: 'backup-confirmed',
      describe:
        'A full database backup was made before the dry run, and can be restored',
      type: 'boolean',
      default: false,
      required: false,
    })
    backupConfirmed?: boolean,
    @Option({
      name: 'confirm',
      describe: 'Remove the candidates of the plan',
      type: 'boolean',
      default: false,
      required: false,
    })
    confirm?: boolean,
    @Option({
      name: 'json',
      describe: 'Print the report as JSON, and nothing else',
      type: 'boolean',
      default: false,
      required: false,
    })
    json?: boolean
  ) {
    if (confirm !== true) {
      return refuse(
        'execute',
        'RETENTION_EXECUTION_STATE_INVALID (--confirm is required)'
      );
    }
    if (backupConfirmed !== true) {
      return refuse(
        'execute',
        `RETENTION_EXECUTION_STATE_INVALID (--backup-confirmed is required). ${NO_BACKUP}`
      );
    }
    if (typeof execution !== 'string' || !UUID.test(execution)) {
      return refuse('execute', '--execution must be an execution id');
    }
    if (!json) {
      console.log(
        `Content Studio retention execute. ${NO_BACKUP} --backup-confirmed is your word that one was made.`
      );
    }
    return run('execute', json, () =>
      this._contentStudioSourceRetentionExecutionService.execute({
        executionId: execution,
        clock: () => new Date(),
        hostname: os.hostname() || null,
      })
    );
  }

  @Command({
    command: 'content-studio:retention-cancel',
    describe:
      'Cancel a Content Studio retention execution that has not ended: release what it holds. Removes nothing.',
  })
  async cancel(
    @Option({
      name: 'execution',
      describe: 'The execution id',
      type: 'string',
      required: false,
    })
    execution?: string,
    @Option({
      name: 'confirm',
      describe: 'Cancel the execution',
      type: 'boolean',
      default: false,
      required: false,
    })
    confirm?: boolean,
    @Option({
      name: 'json',
      describe: 'Print the report as JSON, and nothing else',
      type: 'boolean',
      default: false,
      required: false,
    })
    json?: boolean
  ) {
    if (confirm !== true) {
      return refuse(
        'cancel',
        'RETENTION_EXECUTION_STATE_INVALID (--confirm is required)'
      );
    }
    if (typeof execution !== 'string' || !UUID.test(execution)) {
      return refuse('cancel', '--execution must be an execution id');
    }
    if (!json) {
      console.log(
        'Content Studio retention cancel: cancel does not delete SourceVersions.'
      );
    }
    return run('cancel', json, () =>
      this._contentStudioSourceRetentionExecutionService.cancel({
        executionId: execution,
        clock: () => new Date(),
      })
    );
  }
}

const refuse = (step: string, message: string, exitCode = 1) => {
  console.error(`Retention ${step} refused: ${message}`);
  process.exitCode = exitCode;
  return true;
};

// The report on stdout, with the exit code of its outcome. A refusal is
// its code on stderr; any other failure may have left an execution behind
async function run(
  step: string,
  json: boolean | undefined,
  work: () => Promise<
    | Report
    | { outcome: 'nothing_to_delete'; organizationId: string; planHash: string }
  >
) {
  let report;
  try {
    report = await work();
  } catch (err) {
    if (err instanceof ContentStudioSourceVersionRetentionExecutionError) {
      return refuse(
        step,
        err.detail ? `${err.code} (${err.detail})` : err.code
      );
    }
    return refuse(
      step,
      'RETENTION_EXECUTION_CLEANUP_REQUIRED (the database failed: inspect the execution and run content-studio:retention-cancel if one is active)',
      2
    );
  }
  process.exitCode = contentStudioSourceVersionRetentionExecutionExitCode(
    report.outcome
  );
  if (json) {
    console.log(canonicalJson(report));
    return true;
  }
  console.log(`Outcome: ${report.outcome}`);
  for (const [key, value] of Object.entries(report)) {
    if (key !== 'outcome' && value !== null && value !== undefined) {
      console.log(`  ${key}: ${value}`);
    }
  }
  if (report.outcome === 'prepared' && 'readyAt' in report) {
    console.log(
      `Execute with content-studio:retention-execute --execution ${report.executionId} --backup-confirmed --confirm, at or after ${report.readyAt} and before ${report.validUntil}.`
    );
  }
  if (report.outcome === 'partial' || report.outcome === 'aborted') {
    console.log('A new dry run is needed before any further retention.');
  }
  if (
    report.outcome === 'cleanup_required' ||
    report.outcome === 'interrupted'
  ) {
    console.log(
      'Operator action required: run content-studio:retention-cancel for this execution.'
    );
  }
  return true;
}
