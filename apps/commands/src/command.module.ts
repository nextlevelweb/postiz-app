import { Module } from '@nestjs/common';
import { CommandModule as ExternalCommandModule } from 'nestjs-command';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import { RefreshTokens } from './tasks/refresh.tokens';
import { ConfigurationTask } from './tasks/configuration';
import { ContentStudioPageChangesBackfill } from './tasks/content.studio.page.changes';
import { ContentStudioRetentionDryRun } from './tasks/content.studio.retention';
import { ContentStudioRetentionExecution } from './tasks/content.studio.retention.execution';

@Module({
  imports: [ExternalCommandModule, DatabaseModule, getTemporalModule(false)],
  controllers: [],
  providers: [
    RefreshTokens,
    ConfigurationTask,
    ContentStudioPageChangesBackfill,
    ContentStudioRetentionDryRun,
    ContentStudioRetentionExecution,
  ],
  get exports() {
    return [...this.imports, ...this.providers];
  },
})
export class CommandModule {}
