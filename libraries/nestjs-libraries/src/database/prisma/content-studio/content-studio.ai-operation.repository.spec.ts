import fs from 'fs';
import path from 'path';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  ContentStudioAIOperationRepository,
  ContentStudioAIUsageCreate,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioSourceVersionRetentionPendingError } from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

// No database: the Prisma delegates are mocked. The transaction mock keeps a
// tiny in-memory copy of the rows and puts it back when the callback throws,
// like a rollback, so the completion order can be checked without
// PostgreSQL (the real constraints are covered by the integration suite)

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const OPERATION = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-13T10:00:00.000Z');
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const read = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

const usage = (
  overrides: Partial<ContentStudioAIUsageCreate> = {}
): ContentStudioAIUsageCreate => ({
  attempt: 1,
  provider: 'openai',
  model: 'gpt-6.1-sol',
  outcome: 'succeeded',
  usageSource: 'provider',
  inputTokens: 12,
  outputTokens: 30,
  cachedInputTokens: 4,
  reasoningTokens: null,
  totalTokens: 42,
  providerCostMicros: null,
  costCurrency: null,
  providerRequestId: 'req_1',
  ...overrides,
});

interface Row {
  id: string;
  organizationId: string;
  status: string;
  [key: string]: unknown;
}

const setup = () => {
  const state = {
    operations: [
      { id: OPERATION, organizationId: ORG, status: 'running' },
    ] as Row[],
    usages: [] as Array<Record<string, unknown>>,
    outsideUsages: [] as Array<Record<string, unknown>>,
  };
  // like Prisma, a where field that is undefined is no condition
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([key, value]) => value === undefined || row[key] === value
    );
  const tx = {
    // P8-R1Q/P8-R1C: how many source versions the context names are still
    // there and held for nothing (both, by default)
    contentStudioSourceVersion: {
      count: jest.fn().mockResolvedValue(2),
    },
    contentStudioAIOperation: {
      create: jest.fn().mockResolvedValue({ id: OPERATION }),
      updateMany: jest.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const rows = state.operations.filter((row) =>
            matches(row, args.where)
          );
          rows.forEach((row) => Object.assign(row, args.data));
          return { count: rows.length };
        }
      ),
    },
    contentStudioAIUsage: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        if (
          state.usages.some(
            (row) =>
              row.operationId === args.data.operationId &&
              row.attempt === args.data.attempt
          )
        ) {
          throw new Error('Unique constraint failed (operationId, attempt)');
        }
        state.usages.push({ ...args.data });
        return { id: `usage-${state.usages.length}` };
      }),
    },
  };
  const transaction = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => {
      const snapshot = JSON.parse(JSON.stringify(state));
      try {
        return await fn(tx);
      } catch (err) {
        state.operations = snapshot.operations;
        state.usages = snapshot.usages;
        throw err;
      }
    }),
  };
  // the client outside any transaction: a usage row written with it would
  // survive a rollback, so the repository must never use it
  const outside = {
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      state.outsideUsages.push({ ...args.data });
      return { id: 'outside' };
    }),
  };
  const operation = {
    create: jest.fn().mockResolvedValue({ id: OPERATION }),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const repository = new ContentStudioAIOperationRepository(
    {
      model: {
        contentStudioAIOperation: operation,
        contentStudioAIUsage: outside,
      },
    } as unknown as PrismaRepository<'contentStudioAIOperation'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  return { repository, operation, transaction, tx, state, outside };
};

const createInput = {
  id: OPERATION,
  organizationId: ORG,
  userId: '44444444-4444-4444-8444-444444444444',
  connectionId: '55555555-5555-4555-8555-555555555555',
  packageId: '66666666-6666-4666-8666-666666666666',
  kind: 'generate_item',
  provider: 'openai',
  model: 'gpt-6.1-sol',
  promptVersion: 'cs-item-v1',
  baseDraftVersion: 3,
  context: { v: 1 as const, itemId: 'item-1' },
  requestHash: 'a'.repeat(64),
  startedAt: NOW,
};

const TEXT_FIELDS =
  /prompt"|system|instruction|requestBody|responseBody|generatedText|"text"|"output"|"content"|apiKey|sealedCredential/i;

describe('ContentStudioAIOperationRepository: operations', () => {
  it('OR1-OR3 creates a running operation with exactly the checked fields', async () => {
    const { repository, operation } = setup();
    await expect(
      repository.createRunningOperation(createInput)
    ).resolves.toEqual({ id: OPERATION });
    const [[args]] = operation.create.mock.calls;
    expect(args).toEqual({
      // a package operation names no design revision (P6-02)
      data: { ...createInput, designRevisionId: null, status: 'running' },
      select: { id: true },
    });
    expect(JSON.stringify(args)).not.toMatch(TEXT_FIELDS);
  });

  it('P602 OR13 creates a design operation on its revision, without a package or draft version', async () => {
    const { repository, operation } = setup();
    const design = {
      ...createInput,
      packageId: null,
      baseDraftVersion: null,
      designRevisionId: '55555555-5555-4555-8555-555555555555',
      kind: 'design_restyle',
    };
    await repository.createRunningOperation(design);
    const [[args]] = operation.create.mock.calls;
    expect(args.data).toEqual({ ...design, status: 'running' });
    expect(args.data.packageId).toBeNull();
    expect(args.data.baseDraftVersion).toBeNull();
  });

  const sourced = {
    ...createInput,
    context: {
      v: 1 as const,
      itemId: 'item-1',
      sources: [
        '77777777-7777-4777-8777-777777777771',
        '77777777-7777-4777-8777-777777777772',
      ].map((versionId, i) => ({
        sourceId: `88888888-8888-4888-8888-88888888888${i}`,
        versionId,
        versionNumber: 3,
        contentHash: 'b'.repeat(64),
      })),
    },
  };

  it('Q27 P8-R1Q/P8-R1C an operation naming source versions: the check (still there, held for nothing) and the create in one transaction, the check first, of the organization', async () => {
    const { repository, operation, transaction, tx } = setup();
    await expect(repository.createRunningOperation(sourced)).resolves.toEqual({
      id: OPERATION,
    });
    expect(transaction.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.contentStudioSourceVersion.count).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        id: {
          in: sourced.context.sources.map((source) => source.versionId),
        },
        retentionPending: { is: null },
      },
    });
    expect(
      tx.contentStudioSourceVersion.count.mock.invocationCallOrder[0]
    ).toBeLessThan(
      tx.contentStudioAIOperation.create.mock.invocationCallOrder[0]
    );
    expect(tx.contentStudioAIOperation.create.mock.calls[0][0]).toEqual({
      data: { ...sourced, designRevisionId: null, status: 'running' },
      select: { id: true },
    });
    expect(operation.create).not.toHaveBeenCalled();
  });

  it('Q28/Q29 P8-R1Q/P8-R1C a source version held or gone, any one of them: no operation is created', async () => {
    for (const available of [0, 1]) {
      const { repository, operation, tx } = setup();
      tx.contentStudioSourceVersion.count.mockResolvedValue(available);
      await expect(
        repository.createRunningOperation(sourced)
      ).rejects.toBeInstanceOf(ContentStudioSourceVersionRetentionPendingError);
      expect(tx.contentStudioAIOperation.create).not.toHaveBeenCalled();
      expect(operation.create).not.toHaveBeenCalled();
    }
  });

  it('Q6 P8-R1Q an operation naming no source version is created as before: no transaction, no held check', async () => {
    const { repository, transaction, tx } = setup();
    await repository.createRunningOperation(createInput);
    expect(transaction.$transaction).not.toHaveBeenCalled();
    expect(tx.contentStudioSourceVersion.count).not.toHaveBeenCalled();
  });

  it('OR4/OR5 reads an operation of the organization only', async () => {
    const { repository, operation } = setup();
    expect(
      await repository.getOperationForOrganization(OTHER_ORG, OPERATION)
    ).toBeNull();
    const [[args]] = operation.findFirst.mock.calls;
    expect(args.where).toEqual({ id: OPERATION, organizationId: OTHER_ORG });
    expect(Object.keys(args.select)).not.toEqual(
      expect.arrayContaining(['organizationId'])
    );
    expect(JSON.stringify(args.select)).not.toMatch(TEXT_FIELDS);
  });
});

describe('ContentStudioAIOperationRepository: completion', () => {
  it('OR6/OR7/OR12 completes a running operation as succeeded with its usage row, in one transaction', async () => {
    const { repository, transaction, tx, state } = setup();
    const done = await repository.completeSucceededWithUsage({
      organizationId: ORG,
      operationId: OPERATION,
      completedAt: NOW,
      resultHash: 'b'.repeat(64),
      usage: usage(),
    });

    expect(done).toEqual({ completed: true });
    expect(transaction.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.contentStudioAIOperation.updateMany).toHaveBeenCalledWith({
      where: { id: OPERATION, organizationId: ORG, status: 'running' },
      data: {
        status: 'succeeded',
        resultHash: 'b'.repeat(64),
        errorCode: null,
        completedAt: NOW,
      },
    });
    // UR1-UR4: the usage row of the same operation and organization
    expect(tx.contentStudioAIUsage.create).toHaveBeenCalledWith({
      data: { organizationId: ORG, operationId: OPERATION, ...usage() },
      select: { id: true },
    });
    expect(
      tx.contentStudioAIOperation.updateMany.mock.invocationCallOrder[0]
    ).toBeLessThan(tx.contentStudioAIUsage.create.mock.invocationCallOrder[0]);
    expect(state.operations[0].status).toBe('succeeded');
    expect(state.usages).toHaveLength(1);
    expect(state.outsideUsages).toEqual([]);
  });

  it('OR8/OR9 completes a running operation as failed with its usage row', async () => {
    const { repository, tx, state } = setup();
    const failed = usage({
      outcome: 'failed',
      usageSource: 'none',
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      totalTokens: null,
    });
    await repository.completeFailedWithUsage({
      organizationId: ORG,
      operationId: OPERATION,
      completedAt: NOW,
      errorCode: 'AUTH_FAILED',
      usage: failed,
    });
    expect(tx.contentStudioAIOperation.updateMany).toHaveBeenCalledWith({
      where: { id: OPERATION, organizationId: ORG, status: 'running' },
      data: {
        status: 'failed',
        resultHash: null,
        errorCode: 'AUTH_FAILED',
        completedAt: NOW,
      },
    });
    expect(state.operations[0]).toMatchObject({
      status: 'failed',
      errorCode: 'AUTH_FAILED',
    });
    expect(state.usages).toEqual([
      { organizationId: ORG, operationId: OPERATION, ...failed },
    ]);
    expect(state.outsideUsages).toEqual([]);
  });

  it('OR10 never completes an operation twice nor adds a second usage row', async () => {
    const { repository, tx, state } = setup();
    const input = {
      organizationId: ORG,
      operationId: OPERATION,
      completedAt: NOW,
      usage: usage(),
    };
    await repository.completeSucceededWithUsage({
      ...input,
      resultHash: 'b'.repeat(64),
    });
    expect(
      await repository.completeFailedWithUsage({
        ...input,
        errorCode: 'TIMEOUT',
      })
    ).toEqual({ completed: false });
    expect(
      await repository.completeSucceededWithUsage({
        ...input,
        resultHash: 'c'.repeat(64),
      })
    ).toEqual({ completed: false });
    expect(tx.contentStudioAIUsage.create).toHaveBeenCalledTimes(1);
    expect(state.operations[0]).toMatchObject({
      status: 'succeeded',
      resultHash: 'b'.repeat(64),
    });
  });

  it('OR13 rolls the status back when the usage row cannot be written', async () => {
    const { repository, tx, state } = setup();
    tx.contentStudioAIUsage.create.mockRejectedValueOnce(
      new Error('database down')
    );
    await expect(
      repository.completeSucceededWithUsage({
        organizationId: ORG,
        operationId: OPERATION,
        completedAt: NOW,
        resultHash: 'b'.repeat(64),
        usage: usage(),
      })
    ).rejects.toThrow('database down');
    expect(state.operations[0].status).toBe('running');
    expect(state.usages).toEqual([]);
  });

  it('OR14 cannot complete an operation of another organization', async () => {
    const { repository, tx, state } = setup();
    expect(
      await repository.completeSucceededWithUsage({
        organizationId: OTHER_ORG,
        operationId: OPERATION,
        completedAt: NOW,
        resultHash: 'b'.repeat(64),
        usage: usage(),
      })
    ).toEqual({ completed: false });
    expect(tx.contentStudioAIUsage.create).not.toHaveBeenCalled();
    expect(state.operations[0].status).toBe('running');
  });

  it('OR11/UR5-UR7 has no generic update, delete or upsert and no usage write outside a completion', async () => {
    const { repository, operation } = setup();
    await repository.createRunningOperation(createInput);
    await repository.getOperationForOrganization(ORG, OPERATION);
    for (const method of [
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
    ] as const) {
      expect(operation[method]).not.toHaveBeenCalled();
    }
    const methods = Object.getOwnPropertyNames(
      ContentStudioAIOperationRepository.prototype
    );
    expect(methods.sort()).toEqual([
      'complete',
      'completeFailedWithUsage',
      'completeSucceededWithUsage',
      'constructor',
      'createRunningOperation',
      'getOperationForOrganization',
      'getOperationStateForOrganization',
    ]);
  });
});

describe('ContentStudioAIOperationRepository source', () => {
  const text = read(
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.ai-operation.repository.ts'
  ).replace(/^\s*\/\/.*$/gm, '');

  it('OR15/UR10 reads no environment, provider SDK or logger', () => {
    expect(text).not.toMatch(
      /process\.env|from 'openai'|@anthropic-ai|@ai-sdk|console\.|Logger|\bfetch\(/
    );
  });

  it('UR5-UR9 only ever creates usage rows, with no text or credential field', () => {
    expect(text).not.toMatch(
      /contentStudioAIUsage\.(update|updateMany|upsert|delete|deleteMany)\(/
    );
    expect(text.match(/contentStudioAIUsage\.create\(/g)).toHaveLength(1);
    expect(text).not.toMatch(
      /\b(prompt|system|instruction|generatedText|requestBody|responseBody|apiKey|sealedCredential)\b/
    );
  });

  it('is registered once in the database module', () => {
    const module = read(
      'libraries/nestjs-libraries/src/database/prisma/database.module.ts'
    );
    expect(module.match(/ContentStudioAIOperationRepository\b/g)).toHaveLength(
      2
    );
    expect(module.match(/ContentStudioAIExecutionService\b/g)).toHaveLength(2);
  });
});

describe('ContentStudioAIOperation and ContentStudioAIUsage schema', () => {
  const schema = read(
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const block = (name: string) => {
    const match = schema.match(
      new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`)
    );
    if (!match) {
      throw new Error(`model ${name} not found`);
    }
    return match[1];
  };
  const fields = (name: string) =>
    Object.fromEntries(
      block(name)
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([field]) => field && !field.startsWith('@@'))
        .map(([field, type]) => [field, type])
    );
  const operation = block('ContentStudioAIOperation');
  const usageModel = block('ContentStudioAIUsage');

  it('S10/S11 has the planned fields, every enumeration as a string', () => {
    expect(fields('ContentStudioAIOperation')).toEqual({
      id: 'String',
      organizationId: 'String',
      userId: 'String',
      connectionId: 'String',
      // P6-02: a package operation or a design operation, never both
      packageId: 'String?',
      designRevisionId: 'String?',
      kind: 'String',
      status: 'String',
      provider: 'String',
      model: 'String',
      promptVersion: 'String',
      baseDraftVersion: 'Int?',
      context: 'Json',
      requestHash: 'String',
      resultHash: 'String?',
      // the checked answer of a draft that runs on after its request
      // (activation flow 01): read back by the client that started it
      result: 'Json?',
      errorCode: 'String?',
      startedAt: 'DateTime',
      completedAt: 'DateTime?',
      organization: 'Organization',
      user: 'User',
      connection: 'ContentStudioAIConnection',
      package: 'ContentPackage?',
      designRevision: 'ContentStudioDesignRevision?',
      usages: 'ContentStudioAIUsage[]',
    });
    expect(fields('ContentStudioAIUsage')).toEqual({
      id: 'String',
      organizationId: 'String',
      operationId: 'String',
      attempt: 'Int',
      provider: 'String',
      model: 'String',
      outcome: 'String',
      usageSource: 'String',
      inputTokens: 'Int?',
      outputTokens: 'Int?',
      cachedInputTokens: 'Int?',
      reasoningTokens: 'Int?',
      totalTokens: 'Int?',
      providerCostMicros: 'BigInt?',
      costCurrency: 'String?',
      providerRequestId: 'String?',
      createdAt: 'DateTime',
      organization: 'Organization',
      operation: 'ContentStudioAIOperation',
    });
  });

  it('S1-S7 binds every reference to the same organization', () => {
    expect(operation).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(operation).toMatch(
      /connection\s+ContentStudioAIConnection\s+@relation\(fields: \[connectionId, organizationId\], references: \[id, organizationId\]\)/
    );
    // optional since P6-02, with the foreign key actions of the required
    // relation it was (Restrict, Cascade)
    expect(operation).toMatch(
      /package\s+ContentPackage\?\s+@relation\(fields: \[packageId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Cascade\)/
    );
    // P6-02: a design operation's exact revision, of the same organization
    expect(operation).toMatch(
      /designRevision\s+ContentStudioDesignRevision\?\s+@relation\(fields: \[designRevisionId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
    expect(operation).toMatch(/@@index\(\[designRevisionId\]\)/);
    expect(operation).toMatch(
      /organization\s+Organization\s+@relation\(fields: \[organizationId\], references: \[id\]\)/
    );
    expect(operation).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\]\)/
    );
    expect(usageModel).toMatch(
      /operation\s+ContentStudioAIOperation\s+@relation\(fields: \[operationId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(usageModel).toMatch(/@@unique\(\[operationId, attempt\]\)/);
    // the referenced keys exist
    expect(block('ContentStudioAIConnection')).toMatch(
      /@@unique\(\[id, organizationId\]\)/
    );
    expect(block('ContentPackage')).toMatch(
      /@@unique\(\[id, organizationId\]\)/
    );
    expect(block('ContentStudioDesignRevision')).toMatch(
      /@@unique\(\[id, organizationId\]\)/
    );
  });

  it('S8/S9 has no column for text, credentials or commercial credit', () => {
    for (const model of [operation, usageModel]) {
      const names = model
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean);
      for (const forbidden of [
        'prompt',
        'systemPrompt',
        'system',
        'instruction',
        'requestBody',
        'responseBody',
        'output',
        'generatedText',
        'content',
        'text',
        'apiKey',
        'sealedCredential',
        'credit',
        'credits',
        'wallet',
        'balance',
        'price',
      ]) {
        expect(names).not.toContain(forbidden);
      }
      expect(model).not.toMatch(/credit|wallet|billing|reserve|capture/i);
    }
  });

  it('adds the back-relations only, with no enum', () => {
    expect(block('Organization')).toMatch(
      /contentStudioAIOperations\s+ContentStudioAIOperation\[\]/
    );
    expect(block('Organization')).toMatch(
      /contentStudioAIUsages\s+ContentStudioAIUsage\[\]/
    );
    expect(block('User')).toMatch(
      /contentStudioAIOperations\s+ContentStudioAIOperation\[\]/
    );
    expect(block('ContentStudioAIConnection')).toMatch(
      /operations\s+ContentStudioAIOperation\[\]/
    );
    expect(block('ContentPackage')).toMatch(
      /aiOperations\s+ContentStudioAIOperation\[\]/
    );
    expect(block('ContentStudioDesignRevision')).toMatch(
      /aiOperations\s+ContentStudioAIOperation\[\]/
    );
    expect(schema).not.toMatch(/enum ContentStudioAI/);
  });
});
