import dayjs from 'dayjs';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { AuthService } from '@gitroom/backend/services/auth/auth.service';
import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';
import { NoAuthIntegrationsController } from '@gitroom/backend/api/routes/no.auth.integrations.controller';
import { PublicController } from '@gitroom/backend/api/routes/public.controller';
import { EnterpriseController } from '@gitroom/backend/api/routes/enterprise.controller';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';

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

// Session, invite, password reset, enterprise and extension tokens share one
// signing secret and no purpose marker (CVE-2026-115933). Nothing may sign
// request data any more, and every verify site refuses the other kinds
const JWT_SECRET = process.env.JWT_SECRET;
beforeAll(() => {
  process.env.JWT_SECRET = 'test-only-signing-secret';
});
afterAll(() => {
  if (JWT_SECRET === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = JWT_SECRET;
  }
});

const sign = (value: object) => AuthChecker.signJWT(value);
const future = () => dayjs().add(1, 'day').format('YYYY-MM-DD HH:mm:ss');

// The genuine shapes each flow signs
const loginToken = () =>
  sign({
    id: 'user-1',
    email: 'user@example.com',
    providerName: 'LOCAL',
    activated: true,
  });
const inviteToken = (extra: object = {}) =>
  sign({
    email: 'new@example.com',
    role: 'ADMIN',
    orgId: 'org-1',
    timeLimit: future(),
    id: 'abcde',
    ...extra,
  });
const resetToken = () =>
  sign({ id: 'user-1', expires: dayjs().add(20, 'minutes').format() });
const connectLinkToken = () =>
  sign({
    purpose: 'connect-link',
    orgId: 'org-1',
    linkId: 'link-1',
    expiresAt: dayjs().add(1, 'day').toISOString(),
  });

const authService = (overrides: Record<string, any> = {}) =>
  new AuthService(
    overrides.users || ({} as any),
    overrides.organizations || ({} as any),
    {} as any,
    {} as any,
    {} as any
  );

describe('team invite cookie', () => {
  it('accepts a genuine invite', () => {
    expect(authService().getOrgFromCookie(inviteToken())).toEqual(
      expect.objectContaining({ orgId: 'org-1', role: 'ADMIN', id: 'abcde' })
    );
  });

  it('refuses every other kind of token and forged claims', () => {
    const service = authService();
    for (const token of [
      loginToken(),
      resetToken(),
      connectLinkToken(),
      inviteToken({ role: 'SUPERADMIN' }),
      inviteToken({ orgId: { not: '' } }),
      inviteToken({ id: { not: '' } }),
      inviteToken({ timeLimit: undefined }),
      inviteToken({ timeLimit: dayjs().subtract(1, 'day').format() }),
    ]) {
      expect(service.getOrgFromCookie(token)).toBe(false);
    }
  });

  it('signs only the invite fields, never the rest of the body', async () => {
    const service = new OrganizationService(
      {} as any,
      { sendEmail: jest.fn() } as any,
      {} as any
    );
    const { url } = await service.inviteTeamMember(
      { id: 'org-1', name: 'Org' } as any,
      { email: 'admin@example.com' } as any,
      {
        email: 'new@example.com',
        role: 'USER',
        sendEmail: false,
        orgId: 'other-org',
        purpose: 'connect-link',
        integrationId: 'int-1',
        timeLimit: '2999-01-01 00:00:00',
      } as any
    );
    const payload = AuthChecker.verifyJWT(
      new URL(url, 'https://app.example.com').searchParams.get('org')!
    ) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(
      ['email', 'iat', 'id', 'orgId', 'role', 'timeLimit'].sort()
    );
    expect(payload).toEqual(
      expect.objectContaining({ orgId: 'org-1', role: 'USER' })
    );
    expect(payload.timeLimit).not.toBe('2999-01-01 00:00:00');
  });
});

describe('password reset', () => {
  it('refuses a token whose id is not a string', async () => {
    const updatePassword = jest.fn();
    const service = authService({ users: { updatePassword } });
    const forged = sign({
      id: { not: '' },
      expires: dayjs().add(20, 'minutes').format(),
    });
    expect(
      service.forgotReturn({ token: forged, password: 'new-password' } as any)
    ).toBe(false);
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('accepts a genuine reset token', () => {
    const updatePassword = jest.fn().mockReturnValue('updated');
    const service = authService({ users: { updatePassword } });
    expect(
      service.forgotReturn({
        token: resetToken(),
        password: 'new-password',
      } as any)
    ).toBe('updated');
    expect(updatePassword).toHaveBeenCalledWith('user-1', 'new-password');
  });
});

describe('auth middleware', () => {
  it('refuses a session whose id is not a string before any lookup', async () => {
    const getUserById = jest.fn();
    const middleware = new AuthMiddleware({} as any, { getUserById } as any);
    const forged = sign({ id: { not: '' } });
    await expect(
      middleware.use(
        { headers: { auth: forged }, cookies: {} } as any,
        { cookie: jest.fn(), header: jest.fn() } as any,
        jest.fn()
      )
    ).rejects.toThrow();
    expect(getUserById).not.toHaveBeenCalled();
  });
});

describe('POST /integrations/extension-refresh', () => {
  const setup = () => {
    const integration = {
      id: 'int-1',
      internalId: 'skool-user-1',
      providerIdentifier: 'skool',
      name: 'Skool',
      picture: '',
    };
    const integrationService = {
      getIntegrationById: jest.fn().mockResolvedValue(integration),
      createOrUpdateIntegration: jest.fn().mockResolvedValue({}),
      refreshNeeded: jest.fn(),
    };
    const provider = {
      isChromeExtension: true,
      authenticate: jest.fn().mockResolvedValue({
        id: 'skool-user-1',
        accessToken: 'stored-access',
        expiresIn: 3600,
      }),
    };
    const manager = {
      getSocialIntegration: jest.fn().mockReturnValue(provider),
    };
    const controller = new NoAuthIntegrationsController(
      manager as any,
      integrationService as any,
      {} as any,
      {} as any
    );
    const extensionToken = sign({
      integrationId: 'int-1',
      organizationId: 'org-1',
      internalId: 'skool-user-1',
      provider: 'skool',
    });
    return { controller, integrationService, extensionToken };
  };
  const cookies = Buffer.from(
    JSON.stringify({ id: 'victim', providerName: 'LOCAL' })
  ).toString('base64');

  it('stores the cookies encrypted, never as a signed token', async () => {
    const { controller, integrationService, extensionToken } = setup();
    await expect(
      controller.extensionRefreshCookies({ jwt: extensionToken, cookies })
    ).resolves.toEqual({ success: true });

    const stored =
      integrationService.createOrUpdateIntegration.mock.calls[0].slice(-1)[0];
    expect(() => AuthChecker.verifyJWT(stored)).toThrow();
    expect(JSON.parse(AuthChecker.fixedDecryption(stored))).toEqual({
      id: 'victim',
      providerName: 'LOCAL',
    });
  });

  it('refuses invite, reset and login tokens', async () => {
    const { controller, integrationService } = setup();
    const confused = [
      sign({
        integrationId: 'int-1',
        organizationId: 'org-1',
        internalId: 'skool-user-1',
        provider: 'skool',
        timeLimit: future(),
      }),
      sign({
        integrationId: 'int-1',
        organizationId: 'org-1',
        internalId: 'skool-user-1',
        provider: 'skool',
        expires: future(),
      }),
      loginToken(),
      inviteToken(),
    ];
    for (const jwt of confused) {
      await expect(
        controller.extensionRefreshCookies({ jwt, cookies })
      ).rejects.toThrow();
    }
    expect(integrationService.createOrUpdateIntegration).not.toHaveBeenCalled();
  });

  it('refuses a token for another provider than the stored channel', async () => {
    const { controller, integrationService } = setup();
    const jwt = sign({
      integrationId: 'int-1',
      organizationId: 'org-1',
      internalId: 'skool-user-1',
      provider: 'linkedin',
    });
    await expect(
      controller.extensionRefreshCookies({ jwt, cookies })
    ).rejects.toThrow('Integration not found');
    expect(integrationService.createOrUpdateIntegration).not.toHaveBeenCalled();
  });
});

describe('POST /public/modify-subscription', () => {
  const setup = () => {
    const subscriptionService = { modifySubscriptionByOrg: jest.fn() };
    const controller = new PublicController(
      {} as any,
      {} as any,
      {} as any,
      subscriptionService as any
    );
    return { controller, subscriptionService };
  };

  it('refuses invite, login and reset tokens that carry orgId and billing', async () => {
    const { controller, subscriptionService } = setup();
    for (const params of [
      inviteToken({ billing: 'ULTIMATE' }),
      sign({
        id: 'user-1',
        providerName: 'LOCAL',
        orgId: 'org-1',
        billing: 'ULTIMATE',
      }),
      sign({
        id: 'user-1',
        expires: future(),
        orgId: 'org-1',
        billing: 'ULTIMATE',
      }),
      sign({ orgId: { not: '' }, billing: 'ULTIMATE' }),
    ]) {
      await expect(controller.modifySubscription(params)).resolves.toEqual({
        success: false,
      });
    }
    expect(subscriptionService.modifySubscriptionByOrg).not.toHaveBeenCalled();
  });

  it('accepts the billing token it is meant for', async () => {
    const { controller, subscriptionService } = setup();
    await expect(
      controller.modifySubscription(sign({ orgId: 'org-1', billing: 'PRO' }))
    ).resolves.toEqual({ success: true });
    expect(subscriptionService.modifySubscriptionByOrg).toHaveBeenCalledWith(
      'org-1',
      expect.any(Number),
      'PRO'
    );
  });
});

describe('POST /enterprise/delete-channel', () => {
  it('refuses a database filter object as the API key', async () => {
    const getOrgByApiKey = jest.fn().mockResolvedValue({ id: 'org-1' });
    const controller = new EnterpriseController(
      {} as any,
      { getOrgByApiKey } as any,
      {} as any,
      {} as any
    );
    await expect(
      controller.deleteChannel(sign({ apiKey: { not: '' }, id: 'int-1' }))
    ).resolves.toEqual({ success: false });
    await expect(
      controller.deleteChannel(sign({ apiKey: 'key', id: { not: '' } }))
    ).resolves.toEqual({ success: false });
    expect(getOrgByApiKey).not.toHaveBeenCalled();
  });
});
