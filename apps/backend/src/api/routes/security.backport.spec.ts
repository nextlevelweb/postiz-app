import { BadRequestException } from '@nestjs/common';
import { IntegrationsController } from '@gitroom/backend/api/routes/integrations.controller';
import { MediaController } from '@gitroom/backend/api/routes/media.controller';
import { UsersController } from '@gitroom/backend/api/routes/users.controller';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';

// Published as ES modules only, which Node loads and Jest does not. Their
// code runs when a file is uploaded, a post is sanitized or Nostr is used
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

// The route side of the upstream v2.25.1-v2.25.3 security backport
const ORG = { id: 'org-1' } as any;

describe('POST /integrations/function (CVE-2026-115931)', () => {
  const setup = () => {
    const manager = new IntegrationManager();
    const facebook = manager.getSocialIntegration('facebook') as any;
    const integration = {
      id: 'int-1',
      token: 'channel-token',
      internalId: 'page-1',
      providerIdentifier: 'facebook',
    };
    const integrationService = {
      getIntegrationById: jest.fn().mockResolvedValue(integration),
    };
    const controller = new IntegrationsController(
      manager,
      integrationService as any,
      {} as any,
      {} as any
    );
    return { controller, facebook };
  };

  it('never runs an internal helper of the provider', async () => {
    const { controller, facebook } = setup();
    const readOrFetch = jest
      .spyOn(facebook, 'readOrFetch')
      .mockResolvedValue(Buffer.from('SECRET'));
    const fetch = jest.spyOn(facebook, 'fetch').mockResolvedValue({});

    for (const name of ['readOrFetch', 'fetch', 'constructor']) {
      await expect(
        controller.functionIntegration(ORG, { id: 'int-1', name } as any)
      ).rejects.toThrow('Function not found');
    }
    expect(readOrFetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs a function the dashboard calls with the channel token', async () => {
    const { controller, facebook } = setup();
    const pages = jest
      .spyOn(facebook, 'pages')
      .mockResolvedValue([{ id: 'page-1' }]);

    await expect(
      controller.functionIntegration(ORG, {
        id: 'int-1',
        name: 'pages',
      } as any)
    ).resolves.toEqual([{ id: 'page-1' }]);
    expect(pages).toHaveBeenCalledWith(
      'channel-token',
      undefined,
      'page-1',
      expect.objectContaining({ id: 'int-1' })
    );
  });
});

describe('POST /media/save-media (CVE-2026-115932)', () => {
  const BUCKET = process.env.CLOUDFLARE_BUCKET_URL;
  afterEach(() => {
    if (BUCKET === undefined) {
      delete process.env.CLOUDFLARE_BUCKET_URL;
    } else {
      process.env.CLOUDFLARE_BUCKET_URL = BUCKET;
    }
  });

  const setup = () => {
    const mediaService = { saveFile: jest.fn().mockResolvedValue({}) };
    const controller = new MediaController(mediaService as any, {} as any);
    const save = (name: unknown) =>
      controller.saveMedia(ORG, {} as any, name as any, 'photo.png');
    return { mediaService, save };
  };

  it('refuses a name that would point outside the bucket', async () => {
    process.env.CLOUDFLARE_BUCKET_URL = 'https://bucket.example.com';
    const { mediaService, save } = setup();
    for (const name of [
      '../../etc/passwd',
      '/etc/passwd',
      'a/b.png',
      'a\\b.png',
      '..',
      '.',
      { path: 'x' },
    ]) {
      await expect(save(name)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(mediaService.saveFile).not.toHaveBeenCalled();
  });

  it('refuses every name without a bucket url, as local storage has', async () => {
    delete process.env.CLOUDFLARE_BUCKET_URL;
    const { mediaService, save } = setup();
    await expect(save('photo.png')).rejects.toBeInstanceOf(BadRequestException);
    expect(mediaService.saveFile).not.toHaveBeenCalled();
  });

  it('saves a bare object name under the bucket url', async () => {
    process.env.CLOUDFLARE_BUCKET_URL = 'https://bucket.example.com';
    const { mediaService, save } = setup();
    await save('abc123.png');
    expect(mediaService.saveFile).toHaveBeenCalledWith(
      'org-1',
      'abc123.png',
      'https://bucket.example.com/abc123.png',
      'photo.png'
    );
  });
});

describe('GET /user/organizations (CVE-2026-107761)', () => {
  it('returns no API key or other organization columns', async () => {
    const subscription = { subscriptionTier: 'PRO', totalChannels: 5 };
    const orgService = {
      getOrgsByUserId: jest.fn().mockResolvedValue([
        {
          id: 'org-1',
          name: 'Next Level Web',
          apiKey: 'ORG_API_KEY',
          paymentId: 'cus_1',
          description: 'internal',
          users: [{ role: 'USER', disabled: false }],
          subscription,
        },
        {
          id: 'org-2',
          name: 'Disabled membership',
          apiKey: 'OTHER_KEY',
          users: [{ role: 'ADMIN', disabled: true }],
        },
      ]),
    };
    const controller = new UsersController(
      {} as any,
      {} as any,
      {} as any,
      orgService as any,
      {} as any,
      {} as any
    );

    const result = await controller.getOrgs({ id: 'user-1' } as any);

    expect(result).toEqual([
      {
        id: 'org-1',
        name: 'Next Level Web',
        users: [{ role: 'USER', disabled: false }],
        subscription,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('KEY');
  });
});

describe('IntegrationRepository writes (CVE-2026-107761, CVE-2026-115933)', () => {
  const setup = () => {
    const update = jest.fn().mockResolvedValue({ id: 'int-1' });
    const model = { model: { integration: { update } } };
    const customers = {
      model: {
        customer: { findFirst: jest.fn().mockResolvedValue({ id: 'cus-1' }) },
      },
    };
    const repository = new IntegrationRepository(
      model as any,
      {} as any,
      {} as any,
      {} as any,
      customers as any,
      {} as any
    );
    return { repository, update };
  };

  it.each([
    [
      'deleteChannel',
      (r: IntegrationRepository) => r.deleteChannel('org-1', 'int-1'),
    ],
    [
      'updateNameAndUrl',
      (r: IntegrationRepository) => r.updateNameAndUrl('int-1', 'n', 'u'),
    ],
    [
      'updateIntegrationGroup',
      (r: IntegrationRepository) =>
        r.updateIntegrationGroup('org-1', 'int-1', 'g'),
    ],
    [
      'updateOnCustomerName',
      (r: IntegrationRepository) =>
        r.updateOnCustomerName('org-1', 'int-1', 'Customer'),
    ],
  ])('%s selects only the id', async (_name, call) => {
    const { repository, update } = setup();
    await call(repository);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true } })
    );
  });
});
