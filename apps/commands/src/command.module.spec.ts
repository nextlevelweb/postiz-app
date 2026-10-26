import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { Connection, WorkflowClient } from '@temporalio/client';
import { TEMPORAL_CONNECTION, TemporalService } from 'nestjs-temporal-core';
import { CommandExplorerService } from 'nestjs-command/dist/command-explorer.service';

// Loading the Prisma client copies the repository's .env into process.env
// for every variable not set yet, and the Redis service connects to REDIS_URL
// as it loads. Set before anything loads them: no Redis, no database, no
// Temporal server is reached from here
process.env.REDIS_URL = '';
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.TEMPORAL_ADDRESS = '127.0.0.1:1';
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  NotificationService,
}: typeof import('@gitroom/nestjs-libraries/database/prisma/notifications/notification.service') = require('@gitroom/nestjs-libraries/database/prisma/notifications/notification.service');
const {
  ioRedis,
}: typeof import('@gitroom/nestjs-libraries/redis/redis.service') = require('@gitroom/nestjs-libraries/redis/redis.service');
const {
  CommandModule,
}: typeof import('./command.module') = require('./command.module');
/* eslint-enable @typescript-eslint/no-var-requires */

// Three packages on the graph are published as ES modules only, which Node
// loads and Jest does not. Their code runs when a file is uploaded, a post is
// sanitized or Nostr is used, never while Nest resolves providers
jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn(),
  fileTypeStream: jest.fn(),
}));
jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: { sanitize: jest.fn() },
}));
jest.mock('nostr-tools', () => ({
  getPublicKey: jest.fn(),
  finalizeEvent: jest.fn(),
  Relay: { connect: jest.fn() },
  SimplePool: class {},
}));

// The operator commands start the way `node dist/apps/commands/src/main.js`
// does: Nest resolves CommandModule's whole provider graph. Every provider is
// the real one except TEMPORAL_CONNECTION, the Temporal module's eager worker
// connection, given the null the module itself falls back to when Temporal
// cannot be reached, so nothing leaves the process. The Temporal client is
// lazy and stays real
const compile = () =>
  Test.createTestingModule({ imports: [CommandModule] })
    .overrideProvider(TEMPORAL_CONNECTION)
    .useValue(null)
    .compile();

describe('the commands application', () => {
  it('CB1/TD1 CommandModule resolves its whole provider graph', async () => {
    const moduleRef = await compile();
    expect(moduleRef.get(CommandModule)).toBeInstanceOf(CommandModule);
    await moduleRef.close();
    // and nothing in it reached a Redis server
    expect(ioRedis).not.toBeInstanceOf(Redis);
  });

  it("TD2 NotificationService gets the Temporal module's TemporalService", async () => {
    const moduleRef = await compile();
    const temporal = moduleRef.get(TemporalService, { strict: false });
    expect(temporal).toBeInstanceOf(TemporalService);
    expect(
      (
        moduleRef.get(NotificationService, { strict: false }) as unknown as {
          _temporalService: unknown;
        }
      )._temporalService
    ).toBe(temporal);
    await moduleRef.close();
  });

  it('CB2 offers refresh, config:check, the page-change backfill and the read-only retention dry run (P8-R1B), and nothing else', async () => {
    const moduleRef = await compile();
    expect(
      moduleRef
        .get(CommandExplorerService, { strict: false })
        .explore()
        .map((command) => command.command)
    ).toEqual([
      'refresh',
      'config:check',
      'content-studio:backfill-page-changes',
      'content-studio:retention-dry-run',
    ]);
    await moduleRef.close();
  });

  it('TD4 starting the commands connects to Temporal lazily and starts no workflow', async () => {
    const connect = jest.spyOn(Connection, 'connect');
    const lazy = jest.spyOn(Connection, 'lazy');
    const started = [
      jest.spyOn(WorkflowClient.prototype, 'start'),
      jest.spyOn(WorkflowClient.prototype, 'signalWithStart'),
      jest.spyOn(WorkflowClient.prototype, 'execute'),
    ];
    const moduleRef = await compile();
    await moduleRef.close();
    expect(lazy).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    for (const start of started) {
      expect(start).not.toHaveBeenCalled();
    }
  });
});
