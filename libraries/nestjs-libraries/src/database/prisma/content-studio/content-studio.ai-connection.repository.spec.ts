import fs from 'fs';
import path from 'path';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';

// No database: the Prisma delegate is mocked, so these tests pin the queries
// the repository sends (where the organization boundary and the secret
// boundary live) rather than what a mock happens to return

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const ID = 'connection-1';
const NOW = new Date('2026-10-13T10:00:00.000Z');
// stands in for a sealed envelope; it must never come back from a summary
const ENVELOPE = 'sb1.k1.iv.sk-content-studio-test-secret-123.tag';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const read = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

const delegate = () => ({
  findMany: jest.fn().mockResolvedValue([]),
  findFirst: jest.fn().mockResolvedValue(null),
  findUnique: jest.fn().mockResolvedValue(null),
  count: jest.fn().mockResolvedValue(0),
  create: jest.fn().mockResolvedValue({}),
  update: jest.fn().mockResolvedValue({}),
  updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  upsert: jest.fn().mockResolvedValue({}),
  delete: jest.fn().mockResolvedValue({}),
  deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
});

const setup = () => {
  const connection = delegate();
  const repository = new ContentStudioAIConnectionRepository({
    model: { contentStudioAIConnection: connection },
  } as unknown as PrismaRepository<'contentStudioAIConnection'>);
  return { connection, repository };
};

const SUMMARY_FIELDS = [
  'createdAt',
  'createdById',
  'credentialUpdatedAt',
  'defaultModel',
  'disabledAt',
  'id',
  'lastValidatedAt',
  'lastValidationCode',
  'lastValidationStatus',
  'name',
  'provider',
  'updatedAt',
];

const createInput = {
  id: ID,
  organizationId: ORG,
  name: 'Main OpenAI',
  provider: 'openai',
  sealedCredential: ENVELOPE,
  defaultModel: null,
  credentialUpdatedAt: NOW,
  createdById: 'user-1',
};

// Every repository method once, with the arguments a caller would pass
const callEveryMethod = async (
  repository: ContentStudioAIConnectionRepository
) => {
  await repository.createConnection(createInput);
  await repository.listConnectionsForOrganization(ORG);
  await repository.getConnectionForOrganization(ORG, ID);
  await repository.updateConnectionMetadata({
    organizationId: ORG,
    connectionId: ID,
    name: 'Renamed',
  });
  await repository.replaceCredential({
    organizationId: ORG,
    connectionId: ID,
    sealedCredential: ENVELOPE,
    credentialUpdatedAt: NOW,
  });
  await repository.setValidationResult({
    organizationId: ORG,
    connectionId: ID,
    validatedAt: NOW,
    status: 'invalid',
    code: 'AUTH_FAILED',
  });
  await repository.disableConnection(ORG, ID, NOW);
  await repository.enableConnection(ORG, ID);
  await repository.archiveConnection(ORG, ID, NOW);
  await repository.getSealedCredentialForResolver(ORG, ID);
};

describe('ContentStudioAIConnectionRepository', () => {
  it('R1/R2 creates with the caller id and returns the summary only', async () => {
    const { connection, repository } = setup();
    await repository.createConnection(createInput);

    const [{ data, select }] = connection.create.mock.calls[0];
    expect(data).toEqual(createInput);
    expect(data.id).toBe(ID);
    expect(Object.keys(select).sort()).toEqual(SUMMARY_FIELDS);
    expect(select).not.toHaveProperty('sealedCredential');
    expect(select).not.toHaveProperty('organizationId');
  });

  it('R3/R4 lists active connections of the organization, without the credential', async () => {
    const { connection, repository } = setup();
    await repository.listConnectionsForOrganization(ORG);

    const [args] = connection.findMany.mock.calls[0];
    expect(args.where).toEqual({ organizationId: ORG, archivedAt: null });
    expect(args.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
    expect(Object.keys(args.select).sort()).toEqual(SUMMARY_FIELDS);
    expect(args.select).not.toHaveProperty('sealedCredential');
  });

  it('R5/R6 gets one active connection of the organization, without the credential', async () => {
    const { connection, repository } = setup();
    await repository.getConnectionForOrganization(ORG, ID);

    const [args] = connection.findFirst.mock.calls[0];
    expect(args.where).toEqual({
      id: ID,
      organizationId: ORG,
      archivedAt: null,
    });
    expect(Object.keys(args.select).sort()).toEqual(SUMMARY_FIELDS);
    expect(args.select).not.toHaveProperty('sealedCredential');
  });

  it('R7 reads a connection of another organization as missing', async () => {
    const { connection, repository } = setup();
    connection.findFirst.mockImplementation(async ({ where }) =>
      where.organizationId === ORG ? { id: ID } : null
    );
    expect(await repository.getConnectionForOrganization(OTHER_ORG, ID)).toBe(
      null
    );
    expect(await repository.getSealedCredentialForResolver(OTHER_ORG, ID)).toBe(
      null
    );
    expect(await repository.getConnectionForOrganization(ORG, ID)).toEqual({
      id: ID,
    });
  });

  it('R8/R9 updates name and default model only, scoped to the organization', async () => {
    const { connection, repository } = setup();
    await repository.updateConnectionMetadata({
      organizationId: ORG,
      connectionId: ID,
      name: 'Renamed',
      defaultModel: null,
    });
    await repository.updateConnectionMetadata({
      organizationId: ORG,
      connectionId: ID,
      // a provider sneaked in by a caller is not written
      ...({ provider: 'openrouter' } as object),
    });

    const [[first], [second]] = connection.updateMany.mock.calls;
    expect(first).toEqual({
      where: { id: ID, organizationId: ORG, archivedAt: null },
      data: { name: 'Renamed', defaultModel: null },
    });
    // undefined fields are left unchanged by Prisma
    expect(second.data).toEqual({ name: undefined, defaultModel: undefined });
    expect(second.data).not.toHaveProperty('provider', 'openrouter');
    expect(
      Object.getOwnPropertyNames(ContentStudioAIConnectionRepository.prototype)
    ).not.toEqual(expect.arrayContaining([expect.stringMatching(/provider/i)]));
  });

  it('R10-R14 replaces the envelope, resets validation and returns a count', async () => {
    const { connection, repository } = setup();
    const result = await repository.replaceCredential({
      organizationId: ORG,
      connectionId: ID,
      sealedCredential: ENVELOPE,
      credentialUpdatedAt: NOW,
    });

    expect(connection.updateMany).toHaveBeenCalledWith({
      where: { id: ID, organizationId: ORG, archivedAt: null },
      data: {
        sealedCredential: ENVELOPE,
        credentialUpdatedAt: NOW,
        lastValidatedAt: null,
        lastValidationStatus: null,
        lastValidationCode: null,
      },
    });
    // nothing reads the old envelope first
    expect(connection.findFirst).not.toHaveBeenCalled();
    expect(connection.findMany).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 1 });
    expect(JSON.stringify(result)).not.toContain('sk-content-studio');
  });

  it('R25/R26 records a test result on an active, enabled connection of the organization only', async () => {
    const { connection, repository } = setup();
    const valid = await repository.setValidationResult({
      organizationId: ORG,
      connectionId: ID,
      validatedAt: NOW,
      status: 'valid',
      code: null,
    });
    await repository.setValidationResult({
      organizationId: ORG,
      connectionId: ID,
      validatedAt: NOW,
      status: 'invalid',
      code: 'RATE_LIMITED',
    });

    expect(connection.updateMany.mock.calls).toEqual([
      [
        {
          where: {
            id: ID,
            organizationId: ORG,
            archivedAt: null,
            disabledAt: null,
          },
          data: {
            lastValidatedAt: NOW,
            lastValidationStatus: 'valid',
            lastValidationCode: null,
          },
        },
      ],
      [
        {
          where: {
            id: ID,
            organizationId: ORG,
            archivedAt: null,
            disabledAt: null,
          },
          data: {
            lastValidatedAt: NOW,
            lastValidationStatus: 'invalid',
            lastValidationCode: 'RATE_LIMITED',
          },
        },
      ],
    ]);
    expect(valid).toEqual({ count: 1 });
  });

  it('R15 disables an active, enabled connection of the organization', async () => {
    const { connection, repository } = setup();
    await repository.disableConnection(ORG, ID, NOW);
    expect(connection.updateMany).toHaveBeenCalledWith({
      where: {
        id: ID,
        organizationId: ORG,
        archivedAt: null,
        disabledAt: null,
      },
      data: { disabledAt: NOW },
    });
  });

  it('R16 enables a disabled, active connection of the organization', async () => {
    const { connection, repository } = setup();
    await repository.enableConnection(ORG, ID);
    expect(connection.updateMany).toHaveBeenCalledWith({
      where: {
        id: ID,
        organizationId: ORG,
        archivedAt: null,
        disabledAt: { not: null },
      },
      data: { disabledAt: null },
    });
  });

  it('R17/R18 archives and wipes the credential in one write', async () => {
    const { connection, repository } = setup();
    await repository.archiveConnection(ORG, ID, NOW);

    expect(connection.updateMany).toHaveBeenCalledTimes(1);
    expect(connection.updateMany).toHaveBeenCalledWith({
      where: { id: ID, organizationId: ORG, archivedAt: null },
      data: { archivedAt: NOW, sealedCredential: null },
    });
  });

  it('R20/R21 reads the envelope for the resolver, scoped and minimal', async () => {
    const { connection, repository } = setup();
    await repository.getSealedCredentialForResolver(ORG, ID);
    expect(connection.findFirst).toHaveBeenCalledWith({
      where: { id: ID, organizationId: ORG, archivedAt: null },
      select: {
        id: true,
        provider: true,
        sealedCredential: true,
        disabledAt: true,
      },
    });
  });

  it('R22 selects the envelope in the resolver read only', async () => {
    const { connection, repository } = setup();
    await callEveryMethod(repository);

    const reads = [
      ...connection.create.mock.calls,
      ...connection.findMany.mock.calls,
      ...connection.findFirst.mock.calls,
    ].map(([args]) => args.select);
    const exposing = reads.filter((select) => select?.sealedCredential);
    expect(reads).toHaveLength(4);
    expect(exposing).toEqual([
      { id: true, provider: true, sealedCredential: true, disabledAt: true },
    ]);
    // writes return counts, never rows
    for (const [args] of connection.updateMany.mock.calls) {
      expect(args).not.toHaveProperty('select');
    }
  });

  it('R17 every query is scoped to the organization', async () => {
    const { connection, repository } = setup();
    await callEveryMethod(repository);

    const calls = Object.values(connection).flatMap((fn) => fn.mock.calls);
    expect(calls.length).toBe(10);
    for (const [args] of calls) {
      const scope = args.where || args.data;
      expect(scope.organizationId).toBe(ORG);
    }
  });

  it('R19 never deletes or uses unscoped single-row writes', async () => {
    const { connection, repository } = setup();
    await callEveryMethod(repository);
    for (const method of [
      'delete',
      'deleteMany',
      'update',
      'upsert',
      'findUnique',
    ] as const) {
      expect(connection[method]).not.toHaveBeenCalled();
    }
  });

  it('R23/R24 source: no environment, provider SDK, network or SecretBox use', () => {
    const text = read(
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.ai-connection.repository.ts'
    );
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/from 'openai'|@anthropic-ai|@ai-sdk|from 'ai'/);
    expect(text).not.toMatch(/\bfetch\(|secret\.box|ai\.credential/);
    expect(text).not.toMatch(/\.delete(Many)?\(|\.update\(|\.upsert\(/);
    expect(text).not.toMatch(/getSecret|getCredential\b|changeProvider/);
  });

  it('is registered once in the database module', () => {
    const text = read(
      'libraries/nestjs-libraries/src/database/prisma/database.module.ts'
    );
    expect(text.match(/ContentStudioAIConnectionRepository\b/g)).toHaveLength(
      2
    );
    expect(text).toContain(
      "import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';"
    );
    expect(text).toMatch(/\n {4}ContentStudioAIConnectionRepository,\n/);
  });
});

describe('ContentStudioAIConnection schema', () => {
  const schema = read(
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const block = (name: string) => {
    const match = schema.match(
      new RegExp(`\\nmodel ${name} \\{\\n([\\s\\S]*?)\\n\\}`)
    );
    if (!match) {
      throw new Error(`model ${name} not found`);
    }
    return match[1];
  };
  const model = block('ContentStudioAIConnection');
  const field = (name: string) =>
    model.match(new RegExp(`^\\s+${name}\\s+(\\S+)`, 'm'))?.[1];

  it('has the planned fields and types, provider as a plain string', () => {
    expect(field('id')).toBe('String');
    expect(field('organizationId')).toBe('String');
    expect(field('provider')).toBe('String');
    expect(field('sealedCredential')).toBe('String?');
    expect(field('defaultModel')).toBe('String?');
    expect(field('disabledAt')).toBe('DateTime?');
    expect(field('archivedAt')).toBe('DateTime?');
    expect(field('credentialUpdatedAt')).toBe('DateTime');
    expect(field('createdById')).toBe('String');
    expect(schema).not.toMatch(/\nenum (AIProvider|ContentStudioAIProvider)\b/);
  });

  it('has the tenant key, indexes and creator relation', () => {
    expect(model).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(model).toMatch(/@@index\(\[organizationId, archivedAt\]\)/);
    expect(model).toMatch(/@@index\(\[createdById\]\)/);
    expect(model).toMatch(
      /createdBy\s+User\s+@relation\("ContentStudioAIConnectionCreatedBy", fields: \[createdById\], references: \[id\]\)/
    );
    expect(block('Organization')).toMatch(
      /contentStudioAIConnections\s+ContentStudioAIConnection\[\]/
    );
    expect(block('User')).toMatch(
      /contentStudioAIConnections\s+ContentStudioAIConnection\[\]\s+@relation\("ContentStudioAIConnectionCreatedBy"\)/
    );
  });

  it('has no endpoint, config, mode, pricing or unique name/provider fields', () => {
    expect(model).not.toMatch(
      /baseUrl|baseURL|publicConfig|credentialMode|price|cost|credit|apiKey/i
    );
    expect(model).not.toMatch(/@@unique\(\[(organizationId, )?(provider|name)/);
    // only the composite tenant key is unique
    expect(model).not.toMatch(/[^@]@unique/);
  });
});

// The API arrived with P2-02 (its routes are pinned by the controller specs),
// its settings screen with P2-09 in the Brand & AI folder, and with P2-10 the
// workspace's AI writing dialog, which only reads the connection list
describe('AI connection surface so far', () => {
  it('keeps AI connection frontend code in the Brand & AI screen and the AI writing dialog only', () => {
    const frontend = path.join(
      REPO_ROOT,
      'apps/frontend/src/components/content-studio'
    );
    expect(
      fs
        .readdirSync(frontend, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            /ai\/connections|AIConnection/.test(
              fs.readFileSync(path.join(frontend, entry.name), 'utf8')
            )
        )
        .map((entry) => entry.name)
        .sort()
    ).toEqual([
      'content-studio.ai-writing.spec.ts',
      'content-studio.ai-writing.tsx',
    ]);
    const intelligence = path.join(frontend, 'intelligence');
    expect(
      fs
        .readdirSync(intelligence)
        .filter((file) =>
          /ai\/connections|AIConnection/.test(
            fs.readFileSync(path.join(intelligence, file), 'utf8')
          )
        )
        .sort()
    ).toEqual([
      'content-studio.ai-connections.spec.ts',
      'content-studio.ai-connections.tsx',
      'content-studio.intelligence.api.ts',
      'content-studio.intelligence.spec.ts',
      'content-studio.intelligence.tsx',
    ]);
  });

  it('has the OpenAI, OpenRouter and Anthropic adapters only', () => {
    const providers = fs
      .readdirSync(
        path.join(
          REPO_ROOT,
          'libraries/nestjs-libraries/src/content-studio/ai/providers'
        )
      )
      .filter((file) => !/\.spec\.ts$/.test(file));
    expect(providers.sort()).toEqual([
      'anthropic.provider.ts',
      'openai.provider.ts',
      'openrouter.provider.ts',
    ]);
  });
});
