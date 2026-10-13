import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { inspect } from 'util';
import fs from 'fs';
import path from 'path';
import {
  createSecretBox,
  SecretBox,
} from '@gitroom/nestjs-libraries/services/secret.box';
import {
  aiConnectionSecretContext,
  openContentStudioAICredential,
  sealContentStudioAICredential,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.credential';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import {
  ContentStudioAIConnectionActor,
  ContentStudioAIConnectionService,
  toPublicAIConnection,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.service';

// No database and no provider: the repository is mocked, while the credential
// wrapper and SecretBox run for real on a test keyring (null: not configured).
// Spies wrap them so the tests can see which id was sealed for and that
// nothing ever opens a stored credential
const mockKeyring: { box: SecretBox | null } = { box: null };
jest.mock('@gitroom/nestjs-libraries/services/secret.box', () => {
  const actual = jest.requireActual(
    '@gitroom/nestjs-libraries/services/secret.box'
  );
  const current = (): SecretBox => {
    if (!mockKeyring.box) {
      throw new actual.SecretBoxError('NOT_CONFIGURED');
    }
    return mockKeyring.box;
  };
  return {
    ...actual,
    secretBox: {
      seal: (plaintext: string, context: string) =>
        current().seal(plaintext, context),
      open: (envelope: string, context: string) =>
        current().open(envelope, context),
      needsRotation: (envelope: string) => current().needsRotation(envelope),
    },
  };
});
jest.mock('@gitroom/nestjs-libraries/content-studio/ai/ai.credential', () => {
  const actual = jest.requireActual(
    '@gitroom/nestjs-libraries/content-studio/ai/ai.credential'
  );
  return {
    ...actual,
    sealContentStudioAICredential: jest.fn(),
    openContentStudioAICredential: jest.fn(),
  };
});
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, randomUUID: jest.fn() };
});

const actualCredential = jest.requireActual(
  '@gitroom/nestjs-libraries/content-studio/ai/ai.credential'
);
const actualCrypto = jest.requireActual('crypto');
const seal = jest.mocked(sealContentStudioAICredential);
const open = jest.mocked(openContentStudioAICredential);
const uuid = jest.mocked(randomUUID);

const MARKER = 'sk-content-studio-test-secret-123';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const NEW_ID = '44444444-4444-4444-8444-444444444444';
const USER = 'user-1';
const T0 = new Date('2026-10-01T00:00:00.000Z');

// The organization exactly as the auth middleware sets it: getOrgsByUserId
// keeps only the requesting user's membership ({disabled, role}); the
// impersonation path keeps {id, disabled, role, userId} of that user
const actor = (
  role: string,
  extra: Partial<{ disabled: boolean; userId: string }> = {}
): ContentStudioAIConnectionActor => ({
  organization: {
    id: ORG,
    name: 'Client A',
    apiKey: 'org-api-key',
    users: [{ disabled: false, role, ...extra }],
    subscription: null,
  } as ContentStudioAIConnectionActor['organization'],
  user: { id: USER },
});
const ADMIN = actor('ADMIN');
const SUPERADMIN = actor('SUPERADMIN');
const MEMBER = actor('USER');

// A summary as the repository selects it (it has createdById, never the
// envelope or the organization)
const row = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  name: 'Main OpenAI',
  provider: 'openai',
  defaultModel: null,
  disabledAt: null,
  credentialUpdatedAt: T0,
  lastValidatedAt: T0,
  lastValidationStatus: 'valid',
  lastValidationCode: null,
  createdById: USER,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const PUBLIC_FIELDS = [
  'createdAt',
  'credentialPresent',
  'credentialUpdatedAt',
  'defaultModel',
  'disabled',
  'id',
  'lastValidatedAt',
  'lastValidationCode',
  'lastValidationStatus',
  'name',
  'provider',
  'updatedAt',
];

const setup = () => {
  const repository = {
    createConnection: jest.fn(async (input: { id: string }) => ({
      ...row(),
      id: input.id,
    })),
    listConnectionsForOrganization: jest.fn(async () => [
      row(),
      row({ id: NEW_ID, provider: 'openrouter', disabledAt: T0 }),
    ]),
    getConnectionForOrganization: jest.fn(
      async (organizationId: string, id: string) =>
        organizationId === ORG && id === ID ? row() : null
    ),
    updateConnectionMetadata: jest.fn(async () => ({ count: 1 })),
    replaceCredential: jest.fn(async () => ({ count: 1 })),
    disableConnection: jest.fn(async () => ({ count: 1 })),
    enableConnection: jest.fn(async () => ({ count: 1 })),
    archiveConnection: jest.fn(async () => ({ count: 1 })),
    getSealedCredentialForResolver: jest.fn(),
  };
  const service = new ContentStudioAIConnectionService(
    repository as unknown as ContentStudioAIConnectionRepository
  );
  return { repository, service };
};
type Repository = ReturnType<typeof setup>['repository'];

const writes = (repository: Repository) =>
  [
    repository.createConnection,
    repository.updateConnectionMetadata,
    repository.replaceCredential,
    repository.disableConnection,
    repository.enableConnection,
    repository.archiveConnection,
  ].flatMap((fn) => (fn as jest.Mock).mock.calls);

const httpError = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  return {
    status: (err as HttpException).getStatus(),
    body: (err as HttpException).getResponse(),
    text: [
      String(err),
      JSON.stringify((err as HttpException).getResponse()),
      inspect(err),
    ].join('\n'),
  };
};

const ADMIN_REQUIRED = {
  msg: 'You do not have permission to manage AI connections.',
  code: 'CS_AI_ADMIN_REQUIRED',
};
const NOT_FOUND = { msg: 'AI connection not found.', code: 'CS_NOT_FOUND' };

beforeEach(() => {
  mockKeyring.box = createSecretBox({
    keys: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
    activeKey: 'k1',
  });
  seal.mockImplementation(actualCredential.sealContentStudioAICredential);
  open.mockImplementation(actualCredential.openContentStudioAICredential);
  uuid.mockImplementation(() => NEW_ID);
});

describe('ContentStudioAIConnectionService: managers', () => {
  const mutations = (service: ContentStudioAIConnectionService) => ({
    create: (a: ContentStudioAIConnectionActor) =>
      service.createConnection(a, {
        name: 'Main',
        provider: 'openai',
        credential: { apiKey: MARKER },
      }),
    rename: (a: ContentStudioAIConnectionActor) =>
      service.renameConnection(a, ID, 'Renamed'),
    replace: (a: ContentStudioAIConnectionActor) =>
      service.replaceCredential(a, ID, { apiKey: MARKER }),
    disable: (a: ContentStudioAIConnectionActor) =>
      service.disableConnection(a, ID),
    enable: (a: ContentStudioAIConnectionActor) =>
      service.enableConnection(a, ID),
    archive: (a: ContentStudioAIConnectionActor) =>
      service.archiveConnection(a, ID),
  });

  it.each([
    ['create'],
    ['rename'],
    ['replace'],
    ['disable'],
    ['enable'],
    ['archive'],
  ])('allows ADMIN and SUPERADMIN to %s', async (name) => {
    for (const manager of [ADMIN, SUPERADMIN]) {
      const { service } = setup();
      await expect(
        mutations(service)[name as 'create'](manager)
      ).resolves.toBeDefined();
    }
  });

  it.each([
    ['create'],
    ['rename'],
    ['replace'],
    ['disable'],
    ['enable'],
    ['archive'],
  ])(
    'refuses a USER member to %s with a 403 before any lookup or write',
    async (name) => {
      const { repository, service } = setup();
      const err = await httpError(mutations(service)[name as 'create'](MEMBER));
      expect(err.status).toBe(403);
      expect(err.body).toEqual(ADMIN_REQUIRED);
      expect(repository.getConnectionForOrganization).not.toHaveBeenCalled();
      expect(writes(repository)).toEqual([]);
      expect(seal).not.toHaveBeenCalled();
    }
  );

  // every value the Role enum does not list as a manager, and broken shapes
  it.each([
    ['role USER', actor('USER')],
    ['an unknown role', actor('OWNER')],
    ['a lower case role', actor('admin')],
    ['a disabled ADMIN membership', actor('ADMIN', { disabled: true })],
    ["another user's ADMIN membership", actor('ADMIN', { userId: 'user-2' })],
    [
      'no membership',
      { organization: { id: ORG, users: [] }, user: { id: USER } },
    ],
    ['no users relation', { organization: { id: ORG }, user: { id: USER } }],
    [
      'two memberships',
      {
        organization: {
          id: ORG,
          users: [
            { role: 'USER', disabled: false },
            { role: 'ADMIN', disabled: false },
          ],
        },
        user: { id: USER },
      },
    ],
  ])('refuses %s', async (_name, who) => {
    const { repository, service } = setup();
    const err = await httpError(mutations(service).create(who));
    expect(err.status).toBe(403);
    expect(writes(repository)).toEqual([]);
  });

  it("accepts the impersonation shape for the user's own ADMIN membership", async () => {
    const { service } = setup();
    await expect(
      mutations(service).create(
        actor('ADMIN', { userId: USER, ...({ id: 'membership-1' } as object) })
      )
    ).resolves.toBeDefined();
  });

  it('never answers 401, 402 or 406', async () => {
    const { service } = setup();
    for (const run of Object.values(mutations(service))) {
      const err = await httpError(run(MEMBER));
      expect([401, 402, 406]).not.toContain(err.status);
    }
  });
});

describe('ContentStudioAIConnectionService: create', () => {
  const create = (
    service: ContentStudioAIConnectionService,
    input: Partial<{
      name: string;
      provider: string;
      credential: unknown;
    }> = {},
    who = ADMIN
  ) =>
    service.createConnection(who, {
      name: 'Main OpenAI',
      provider: 'openai',
      credential: { apiKey: MARKER },
      ...input,
    });

  it('S1/S2/S7-S10/S13/S14 seals for a server id before the insert', async () => {
    for (const who of [ADMIN, SUPERADMIN]) {
      const { repository, service } = setup();
      seal.mockClear();
      const result = await create(service, { provider: 'openrouter' }, who);

      expect(uuid).toHaveBeenCalled();
      expect(seal).toHaveBeenCalledWith({
        organizationId: ORG,
        connectionId: NEW_ID,
        provider: 'openrouter',
        credential: { apiKey: MARKER },
      });
      expect(seal.mock.invocationCallOrder[0]).toBeLessThan(
        repository.createConnection.mock.invocationCallOrder[0]
      );
      const [input] = repository.createConnection.mock.calls[0] as unknown as [
        Record<string, unknown>
      ];
      expect(input).toEqual({
        id: NEW_ID,
        organizationId: ORG,
        name: 'Main OpenAI',
        provider: 'openrouter',
        sealedCredential: expect.stringMatching(/^sb1\.k1\./),
        defaultModel: null,
        credentialUpdatedAt: expect.any(Date),
        createdById: USER,
      });
      // the stored envelope opens for exactly this organization and id
      expect(
        mockKeyring.box?.open(
          input.sealedCredential as string,
          aiConnectionSecretContext(ORG, NEW_ID)
        )
      ).toBe(`{"apiKey":"${MARKER}","v":1}`);
      expect(result.id).toBe(NEW_ID);
    }
  });

  it('S11 trims the name and keeps inner spaces', async () => {
    const { repository, service } = setup();
    await create(service, { name: '  Main   OpenAI \t' });
    expect(repository.createConnection.mock.calls[0][0]).toMatchObject({
      name: 'Main   OpenAI',
    });
  });

  it.each([
    ['blank', '   '],
    ['empty', ''],
    ['over 100 characters after trimming', 'x'.repeat(101)],
    ['NUL', 'Main\u0000AI'],
    ['an unpaired surrogate', 'Main \ud800 AI'],
  ])('S12 rejects a %s name with a fixed 400', async (_name, name) => {
    const { repository, service } = setup();
    const err = await httpError(create(service, { name }));
    expect(err.status).toBe(400);
    expect(err.body).toEqual({
      msg: 'The AI connection name is invalid.',
      code: 'CS_INVALID_REQUEST',
    });
    expect(repository.createConnection).not.toHaveBeenCalled();
  });

  it('accepts exactly 100 characters and a paired surrogate', async () => {
    const { repository, service } = setup();
    await create(service, { name: `  ${'x'.repeat(100)}  ` });
    await create(service, { name: 'Main \ud83d\ude80 AI' });
    expect(repository.createConnection).toHaveBeenCalledTimes(2);
  });

  it.each([['anthropic'], ['google'], ['OpenAI'], ['']])(
    'S4 rejects provider %p with a fixed 400 and seals nothing',
    async (provider) => {
      const { repository, service } = setup();
      const err = await httpError(create(service, { provider }));
      expect(err.status).toBe(400);
      expect(err.body).toEqual({
        msg: 'This AI provider is not supported.',
        code: 'CS_AI_PROVIDER_UNSUPPORTED',
      });
      expect(seal).not.toHaveBeenCalled();
      expect(repository.createConnection).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['a key with a space', { apiKey: `${MARKER} x` }],
    ['an extra field', { apiKey: MARKER, baseURL: 'https://x.test' }],
    ['a sealed value', { sealedCredential: `sb1.k1.${MARKER}` }],
    ['no key', {}],
    ['a string', MARKER],
  ])(
    'S5 rejects %s with a fixed 400 that never repeats it',
    async (_n, credential) => {
      const { repository, service } = setup();
      const err = await httpError(create(service, { credential }));
      expect(err.status).toBe(400);
      expect(err.body).toEqual({
        msg: 'The AI credential is invalid.',
        code: 'CS_AI_CREDENTIAL_INVALID',
      });
      expect(err.text).not.toContain(MARKER);
      expect(repository.createConnection).not.toHaveBeenCalled();
    }
  );

  it('S6 maps a SecretBox without keyring to a fixed 503', async () => {
    const { repository, service } = setup();
    mockKeyring.box = null;
    const err = await httpError(create(service));
    expect(err.status).toBe(503);
    expect(err.body).toEqual({
      msg: 'AI credential storage is not available.',
      code: 'CS_AI_SECRET_STORE_UNAVAILABLE',
    });
    expect(err.text).not.toMatch(/SecretBox|NOT_CONFIGURED|SECRET_BOX/);
    expect(repository.createConnection).not.toHaveBeenCalled();
  });

  it('maps an impossible context to a fixed 500', async () => {
    const { service } = setup();
    uuid.mockImplementation(
      () => 'not-a-uuid' as ReturnType<typeof actualCrypto.randomUUID>
    );
    const err = await httpError(create(service));
    expect(err.status).toBe(500);
    expect(err.body).toEqual({
      msg: 'Could not update this AI connection.',
      code: 'CS_AI_OPERATION_FAILED',
    });
  });

  it('S9 takes the organization and creator from the request context only', async () => {
    const { repository, service } = setup();
    await service.createConnection(ADMIN, {
      name: 'Main',
      provider: 'openai',
      credential: { apiKey: MARKER },
      ...({ organizationId: OTHER_ORG, createdById: 'user-b' } as object),
    });
    expect(repository.createConnection.mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      createdById: USER,
    });
  });

  it('S15 answers the public summary only', async () => {
    const { service } = setup();
    const result = await create(service);
    expect(Object.keys(result).sort()).toEqual(PUBLIC_FIELDS);
    expect(JSON.stringify(result)).not.toMatch(
      /sk-content-studio|sb1\.|organizationId|createdById|sealedCredential/
    );
  });
});

describe('ContentStudioAIConnectionService: read', () => {
  it('S16-S18 lists for any member, mapped', async () => {
    for (const _who of [MEMBER, ADMIN]) {
      const { repository, service } = setup();
      const list = await service.listConnections(ORG);
      expect(repository.listConnectionsForOrganization).toHaveBeenCalledWith(
        ORG
      );
      expect(list.map((c) => [c.id, c.provider, c.disabled])).toEqual([
        [ID, 'openai', false],
        [NEW_ID, 'openrouter', true],
      ]);
      for (const item of list) {
        expect(Object.keys(item).sort()).toEqual(PUBLIC_FIELDS);
      }
    }
  });

  it('S19 reads a connection of the organization', async () => {
    const { service } = setup();
    expect(await service.getConnection(ORG, ID)).toEqual({
      id: ID,
      name: 'Main OpenAI',
      provider: 'openai',
      defaultModel: null,
      disabled: false,
      credentialPresent: true,
      credentialUpdatedAt: T0,
      lastValidatedAt: T0,
      lastValidationStatus: 'valid',
      lastValidationCode: null,
      createdAt: T0,
      updatedAt: T0,
    });
  });

  it('S20 answers 404 for a foreign, missing or malformed id', async () => {
    const { repository, service } = setup();
    for (const [organizationId, id] of [
      [OTHER_ORG, ID],
      [ORG, NEW_ID],
      [ORG, 'not-a-uuid'],
      [ORG, 'AAAAAAAA-3333-4333-8333-333333333333'],
    ]) {
      const err = await httpError(service.getConnection(organizationId, id));
      expect(err.status).toBe(404);
      expect(err.body).toEqual(NOT_FOUND);
    }
    // malformed ids never reach the database
    expect(repository.getConnectionForOrganization).toHaveBeenCalledTimes(2);
  });

  it('S21/S22 reads need no manager role and never show internals', async () => {
    const mapped = toPublicAIConnection({
      ...row(),
      ...({
        organizationId: ORG,
        sealedCredential: `sb1.k1.${MARKER}`,
        archivedAt: T0,
        apiKey: MARKER,
      } as object),
    });
    expect(Object.keys(mapped).sort()).toEqual(PUBLIC_FIELDS);
    expect(JSON.stringify(mapped)).not.toMatch(
      /organizationId|sealedCredential|createdById|archivedAt|apiKey|sk-content-studio/
    );
  });

  it('lists the providers without a database or a secret', () => {
    const { repository, service } = setup();
    expect(service.listProviders().map((p) => p.provider)).toEqual([
      'openai',
      'openrouter',
    ]);
    expect(
      Object.values(repository).every((fn) => fn.mock.calls.length === 0)
    ).toBe(true);
  });
});

describe('ContentStudioAIConnectionService: rename', () => {
  it('S23/S24/S26/S31 renames, trimmed, and answers the re-read summary', async () => {
    for (const who of [ADMIN, SUPERADMIN]) {
      const { repository, service } = setup();
      repository.getConnectionForOrganization
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row({ name: 'Renamed' }));
      const result = await service.renameConnection(who, ID, '  Renamed ');
      expect(repository.updateConnectionMetadata).toHaveBeenCalledWith({
        organizationId: ORG,
        connectionId: ID,
        name: 'Renamed',
      });
      expect(result.name).toBe('Renamed');
      expect(Object.keys(result).sort()).toEqual(PUBLIC_FIELDS);
    }
  });

  it('S27 rejects a blank name before any write', async () => {
    const { repository, service } = setup();
    expect(
      (await httpError(service.renameConnection(ADMIN, ID, '  '))).status
    ).toBe(400);
    expect(repository.updateConnectionMetadata).not.toHaveBeenCalled();
  });

  it('S28/S29 answers 404 for a missing connection or a lost race', async () => {
    const { repository, service } = setup();
    expect(
      (await httpError(service.renameConnection(ADMIN, NEW_ID, 'X'))).body
    ).toEqual(NOT_FOUND);
    repository.updateConnectionMetadata.mockResolvedValueOnce({ count: 0 });
    expect(
      (await httpError(service.renameConnection(ADMIN, ID, 'X'))).body
    ).toEqual(NOT_FOUND);
  });

  it('S30 sends the name only, never a provider or model', async () => {
    const { repository, service } = setup();
    await service.renameConnection(ADMIN, ID, 'Renamed');
    const [[input]] = repository.updateConnectionMetadata.mock
      .calls as unknown as [[Record<string, unknown>]];
    expect(Object.keys(input).sort()).toEqual([
      'connectionId',
      'name',
      'organizationId',
    ]);
  });
});

describe('ContentStudioAIConnectionService: replace credential', () => {
  it('S33-S36/S39/S42 checks and seals the new key for the stored provider and id', async () => {
    const { repository, service } = setup();
    repository.getConnectionForOrganization.mockResolvedValue(
      row({ provider: 'openrouter' })
    );
    const result = await service.replaceCredential(ADMIN, ID, {
      apiKey: MARKER,
    });

    expect(seal).toHaveBeenCalledWith({
      organizationId: ORG,
      connectionId: ID,
      provider: 'openrouter',
      credential: { apiKey: MARKER },
    });
    expect(repository.replaceCredential).toHaveBeenCalledWith({
      organizationId: ORG,
      connectionId: ID,
      sealedCredential: expect.stringMatching(/^sb1\.k1\./),
      credentialUpdatedAt: expect.any(Date),
    });
    // the repository contract resets the validation fields itself
    const [[input]] = repository.replaceCredential.mock.calls as unknown as [
      [Record<string, unknown>]
    ];
    expect(Object.keys(input).sort()).toEqual([
      'connectionId',
      'credentialUpdatedAt',
      'organizationId',
      'sealedCredential',
    ]);
    expect(Object.keys(result).sort()).toEqual(PUBLIC_FIELDS);
    expect(JSON.stringify(result)).not.toMatch(/sk-content-studio|sb1\./);
  });

  it('S37 never reads or opens the old credential', async () => {
    const { repository, service } = setup();
    await service.replaceCredential(ADMIN, ID, { apiKey: MARKER });
    expect(repository.getSealedCredentialForResolver).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('S32 refuses a USER member', async () => {
    const { repository, service } = setup();
    expect(
      (
        await httpError(
          service.replaceCredential(MEMBER, ID, { apiKey: MARKER })
        )
      ).status
    ).toBe(403);
    expect(repository.replaceCredential).not.toHaveBeenCalled();
  });

  it('S38 answers 404 for a missing connection or a lost race', async () => {
    const { repository, service } = setup();
    expect(
      (
        await httpError(
          service.replaceCredential(ADMIN, NEW_ID, { apiKey: MARKER })
        )
      ).body
    ).toEqual(NOT_FOUND);
    repository.replaceCredential.mockResolvedValueOnce({ count: 0 });
    expect(
      (
        await httpError(
          service.replaceCredential(ADMIN, ID, { apiKey: MARKER })
        )
      ).body
    ).toEqual(NOT_FOUND);
  });

  it('S40 rejects an invalid key with a fixed 400 that never repeats it', async () => {
    const { repository, service } = setup();
    const err = await httpError(
      service.replaceCredential(ADMIN, ID, { apiKey: `${MARKER}\n` })
    );
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'CS_AI_CREDENTIAL_INVALID' });
    expect(err.text).not.toContain(MARKER);
    expect(repository.replaceCredential).not.toHaveBeenCalled();
  });

  it('S41 maps a SecretBox without keyring to a fixed 503', async () => {
    const { repository, service } = setup();
    mockKeyring.box = null;
    const err = await httpError(
      service.replaceCredential(ADMIN, ID, { apiKey: MARKER })
    );
    expect(err.status).toBe(503);
    expect(repository.replaceCredential).not.toHaveBeenCalled();
  });
});

describe('ContentStudioAIConnectionService: disable and enable', () => {
  it('S43 disables an enabled connection and answers the re-read summary', async () => {
    const { repository, service } = setup();
    repository.getConnectionForOrganization
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ disabledAt: T0 }));
    const result = await service.disableConnection(ADMIN, ID);
    expect(repository.disableConnection).toHaveBeenCalledWith(
      ORG,
      ID,
      expect.any(Date)
    );
    expect(result.disabled).toBe(true);
  });

  it('S44 leaves an already disabled connection alone', async () => {
    const { repository, service } = setup();
    repository.getConnectionForOrganization.mockResolvedValue(
      row({ disabledAt: T0 })
    );
    const result = await service.disableConnection(ADMIN, ID);
    expect(repository.disableConnection).not.toHaveBeenCalled();
    expect(result.disabled).toBe(true);
  });

  it('S45 enables a disabled connection and answers the re-read summary', async () => {
    const { repository, service } = setup();
    repository.getConnectionForOrganization
      .mockResolvedValueOnce(row({ disabledAt: T0 }))
      .mockResolvedValueOnce(row());
    const result = await service.enableConnection(SUPERADMIN, ID);
    expect(repository.enableConnection).toHaveBeenCalledWith(ORG, ID);
    expect(result.disabled).toBe(false);
  });

  it('S46 leaves an already enabled connection alone', async () => {
    const { repository, service } = setup();
    const result = await service.enableConnection(ADMIN, ID);
    expect(repository.enableConnection).not.toHaveBeenCalled();
    expect(result.disabled).toBe(false);
  });

  it('S47/S48 refuses members and answers 404 for missing connections', async () => {
    const { repository, service } = setup();
    expect(
      (await httpError(service.disableConnection(MEMBER, ID))).status
    ).toBe(403);
    expect((await httpError(service.enableConnection(MEMBER, ID))).status).toBe(
      403
    );
    expect(
      (await httpError(service.disableConnection(ADMIN, NEW_ID))).body
    ).toEqual(NOT_FOUND);
    expect(
      (await httpError(service.enableConnection(ADMIN, NEW_ID))).body
    ).toEqual(NOT_FOUND);
    expect(repository.disableConnection).not.toHaveBeenCalled();
    expect(repository.enableConnection).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('ContentStudioAIConnectionService: archive', () => {
  it('S49/S52/S55 archives once and answers the id only', async () => {
    const { repository, service } = setup();
    const result = await service.archiveConnection(ADMIN, ID);
    expect(repository.archiveConnection).toHaveBeenCalledTimes(1);
    expect(repository.archiveConnection).toHaveBeenCalledWith(
      ORG,
      ID,
      expect.any(Date)
    );
    expect(result).toEqual({ id: ID });
    // no re-read of the archived row and no look at its credential
    expect(repository.getConnectionForOrganization).toHaveBeenCalledTimes(1);
    expect(repository.getSealedCredentialForResolver).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('S50/S51 refuses members and answers 404 for missing or already archived', async () => {
    const { repository, service } = setup();
    expect(
      (await httpError(service.archiveConnection(MEMBER, ID))).status
    ).toBe(403);
    expect(
      (await httpError(service.archiveConnection(ADMIN, NEW_ID))).body
    ).toEqual(NOT_FOUND);
    repository.archiveConnection.mockResolvedValueOnce({ count: 0 });
    expect(
      (await httpError(service.archiveConnection(ADMIN, ID))).body
    ).toEqual(NOT_FOUND);
  });

  it('S53/S54 has no delete, restore, test or model method', () => {
    const methods = Object.getOwnPropertyNames(
      ContentStudioAIConnectionService.prototype
    );
    expect(methods.filter((m) => /delete|restore|test|model/i.test(m))).toEqual(
      []
    );
  });
});

describe('ContentStudioAIConnectionService source', () => {
  // code only: the comments explain these rules and may name them
  const text = fs
    .readFileSync(
      path.join(__dirname, 'content-studio.ai-connection.service.ts'),
      'utf8'
    )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('checks roles itself: no CheckPolicies, billing, AI section or permissions service', () => {
    expect(text).not.toMatch(
      /CheckPolicies|Sections\.|AuthorizationActions|PermissionsService|subscription|stripe|credit/i
    );
    expect(text).toMatch(/Role\.ADMIN, Role\.SUPERADMIN/);
  });

  it('has no logging, environment, SDK, network or open of a credential', () => {
    expect(text).not.toMatch(
      /console\.|Logger|process\.env|from 'openai'|@anthropic-ai|@ai-sdk|\bfetch\(|openContentStudioAICredential|getSealedCredentialForResolver/
    );
    expect(text).not.toMatch(/JSON\.stringify|\.message\b/);
    expect(text).not.toMatch(/\b40[126]\b/);
  });
});
