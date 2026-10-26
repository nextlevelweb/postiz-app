import { Command, Option } from 'nestjs-command';
import { Injectable } from '@nestjs/common';
import { ContentStudioSourceRetentionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.service';
import {
  ContentStudioSourceRetentionIntegrityError,
  contentStudioSourceVersionRetentionErrorCode,
  CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MIN_AGE_MS,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MODES,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';
import { canonicalJson } from '@gitroom/nestjs-libraries/content-studio/canonical.json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_DAYS = CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MIN_AGE_MS / DAY_MS;
const MAX_DAYS = 3650;

// The retention dry run of one organization (P8-R1B), for an operator to
// review: which captured source versions compact_repeats would select now,
// and the hash of that plan. Run by an operator only. It only reads: it
// writes, removes and schedules nothing, and a candidate is never permission
// to remove anything. --older-than-days is a duration before now (whole
// seconds), never a date in a time zone. --json prints the whole report as
// canonical JSON and nothing else on stdout; errors go to stderr, with the
// exit code 1
@Injectable()
export class ContentStudioRetentionDryRun {
  constructor(
    private _contentStudioSourceRetentionService: ContentStudioSourceRetentionService
  ) {}

  @Command({
    command: 'content-studio:retention-dry-run',
    describe:
      'Show which Content Studio source versions the retention policy would select for one organization. Reads only.',
  })
  async dryRun(
    @Option({
      name: 'organization',
      describe: 'The organization id',
      type: 'string',
      required: false,
    })
    organization?: string,
    @Option({
      name: 'older-than-days',
      describe: `Only versions made at least this many days ago (${MIN_DAYS} or more)`,
      type: 'string',
      required: false,
    })
    olderThanDays?: string,
    @Option({
      name: 'mode',
      describe: 'The retention policy (only compact_repeats)',
      type: 'string',
      default: 'compact_repeats',
      required: false,
    })
    mode?: string,
    @Option({
      name: 'json',
      describe: 'Print the whole report as JSON, and nothing else',
      type: 'boolean',
      default: false,
      required: false,
    })
    json?: boolean
  ) {
    const refuse = (message: string) => {
      console.error(`Retention dry run refused: ${message}`);
      process.exitCode = 1;
      return true;
    };
    if (
      !(
        CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MODES as readonly unknown[]
      ).includes(mode)
    ) {
      return refuse(
        'RETENTION_POLICY_NOT_ENABLED (only compact_repeats is enabled)'
      );
    }
    if (typeof organization !== 'string' || !UUID.test(organization)) {
      return refuse('--organization must be an organization id');
    }
    const days =
      typeof olderThanDays === 'string' && /^\d{1,4}$/.test(olderThanDays)
        ? Number(olderThanDays)
        : NaN;
    if (!(days >= MIN_DAYS && days <= MAX_DAYS)) {
      return refuse(
        `RETENTION_POLICY_INVALID (--older-than-days must be a whole number from ${MIN_DAYS} to ${MAX_DAYS})`
      );
    }

    // one clock for the whole run, in whole seconds
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    let report;
    try {
      report =
        await this._contentStudioSourceRetentionService.computeRetentionDryRun({
          organizationId: organization,
          now,
          policy: {
            mode,
            olderThan: new Date(now.getTime() - days * DAY_MS),
          },
        });
    } catch (err) {
      const code = contentStudioSourceVersionRetentionErrorCode(err);
      if (!code) {
        throw err;
      }
      // the code, and for stored data that could not be verified the
      // record by model and id: never content
      return refuse(
        err instanceof ContentStudioSourceRetentionIntegrityError
          ? `${code} (${err.reference.type} ${err.reference.id})`
          : code
      );
    }

    if (json) {
      console.log(canonicalJson(report));
      return true;
    }
    const summary = report.candidateSummary;
    const protection = report.protectionSummary;
    console.log(
      'Content Studio retention dry run: read only, nothing was changed or removed.'
    );
    console.log(`Organization: ${report.organizationId}`);
    console.log(
      `Policy: ${report.policy.mode}, versions made before ${report.policy.olderThan}`
    );
    console.log(
      `Evaluated at ${report.evaluationNow}, valid until ${report.validUntil}`
    );
    console.log(
      `Versions: ${summary.totalVersions} in total, ${summary.protectedVersions} protected, ${summary.technicallyUnprotectedVersions} technically unprotected`
    );
    console.log(
      `Technically unprotected: ${summary.policyRetainedVersions} kept by the policy (${summary.policyRetainedByRule.RUN_BOUNDARY} first or last of a run, ${summary.policyRetainedByRule.TOO_RECENT} too recent), ${summary.candidateVersions} candidates, ${summary.blockedCandidateVersions} held back`
    );
    console.log(
      `Protections: ${
        protection.protectionEdges
      } in total; ${CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS.map(
        (reason) =>
          `${reason} ${protection.edgesByReason[reason]} (${protection.versionsByReason[reason]} versions)`
      ).join(', ')}`
    );
    console.log(`Blocked sources: ${summary.blockedSources}`);
    for (const blocked of report.blockedSources) {
      console.log(
        `  ${blocked.sourceId} ${blocked.blocker} (${blocked.suppressedCandidates} held back)`
      );
    }
    console.log(
      `Logical content bytes of the candidates: ${summary.logicalContentBytes} (the size of their stored blocks, not disk space PostgreSQL would free: removed rows stay until VACUUM, and TOAST compresses differently)`
    );
    console.log(
      `Oldest candidate: ${
        summary.oldestCandidateCreatedAt ?? 'none'
      }, newest candidate: ${summary.newestCandidateCreatedAt ?? 'none'}`
    );
    console.log(`Dry run hash: ${report.dryRunHash}`);
    console.log(
      'A candidate is not permission to remove anything: nothing is removed without product approval and a fresh check first.'
    );
    return true;
  }
}
