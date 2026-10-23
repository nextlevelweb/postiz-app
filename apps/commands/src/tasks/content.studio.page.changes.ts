import { Command, Option } from 'nestjs-command';
import { Injectable } from '@nestjs/common';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';

// Rebuilds every page source's last page change (P8-04B1) from its versions,
// once after the fields are added, or to repair them. Run by an operator
// only, never on start or deploy. Safe to run again and while captures run:
// a source already right is not written, and a capture that goes first wins.
// --after continues after the last source id a run printed
@Injectable()
export class ContentStudioPageChangesBackfill {
  constructor(
    private _contentStudioSourceService: ContentStudioSourceService
  ) {}

  @Command({
    command: 'content-studio:backfill-page-changes',
    describe:
      'Rebuild the last page change of every Content Studio page source from its versions.',
  })
  async backfill(
    @Option({
      name: 'after',
      describe: 'Start after this source id (continues a previous run)',
      type: 'string',
      required: false,
    })
    after?: string
  ) {
    let afterId: string | null = after || null;
    let updated = 0;
    let unchanged = 0;
    const failed: string[] = [];
    do {
      const page = await this._contentStudioSourceService.backfillPageChanges({
        afterId,
      });
      updated += page.updated;
      unchanged += page.unchanged;
      failed.push(...page.failed);
      for (const id of page.failed) {
        console.error('Source could not be backfilled:', id);
      }
      afterId = page.next;
      if (afterId) {
        console.log(
          `Page changes: ${updated} updated, ${unchanged} unchanged, ${failed.length} failed, up to ${afterId}`
        );
      }
    } while (afterId);

    console.log(
      `Page changes backfill complete: ${updated} updated, ${unchanged} unchanged, ${failed.length} failed.`
    );
    if (failed.length) {
      process.exitCode = 1;
    }
    return true;
  }
}
