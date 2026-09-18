import { Controller, Get, HttpException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import dayjs from 'dayjs';

import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

type ConnectLinkPayload = {
  purpose: 'connect-link';
  orgId: string;
  linkId: string;
  expiresAt: string;
};

/**
 * Public customer-facing connection endpoints.
 *
 * Authentication is performed by the signed, expiring connect-link token.
 * These routes deliberately do not use AuthMiddleware: the customer does not
 * need a Postiz user account or Postiz session to authorize an integration.
 *
 * The actual provider callback remains Postiz' existing integration callback.
 * We only bind the provider OAuth state to the intended organization in Redis.
 */
@ApiTags('Connect Links')
@Controller('/connect')
export class ConnectLinkController {
  constructor(
    private _integrationManager: IntegrationManager,
    private _organizationService: OrganizationService
  ) {}

  private validateToken(token: string): ConnectLinkPayload {
    try {
      const payload = AuthService.verifyJWT(token) as ConnectLinkPayload;

      if (
        payload?.purpose !== 'connect-link' ||
        !payload.orgId ||
        !payload.linkId ||
        !payload.expiresAt
      ) {
        throw new HttpException({ msg: 'Invalid connect link' }, 400);
      }

      const expiresAt = dayjs(payload.expiresAt);

      if (!expiresAt.isValid()) {
        throw new HttpException({ msg: 'Invalid connect link' }, 400);
      }

      if (dayjs().isAfter(expiresAt)) {
        throw new HttpException({ msg: 'Connect link has expired' }, 410);
      }

      return payload;
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }

      throw new HttpException({ msg: 'Invalid connect link' }, 400);
    }
  }

  private assertConnectableProvider(integration: string) {
    if (
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(integration)
    ) {
      throw new HttpException({ msg: 'Integration not allowed' }, 400);
    }

    const provider =
      this._integrationManager.getSocialIntegration(integration);

    /*
     * Connect links currently support browser-based OAuth integrations only.
     *
     * Web3, browser-extension, custom-field and external-instance providers
     * have a different authorization UX and should not silently be forced
     * through this flow.
     */
    if (
      provider.isWeb3 ||
      provider.isChromeExtension ||
      provider.externalUrl ||
      provider.customFields
    ) {
      throw new HttpException(
        { msg: 'This integration is not supported by connect links' },
        400
      );
    }

    return provider;
  }

  @Get('/:token/integrations')
  async getAvailableIntegrations(@Param('token') token: string) {
    const { orgId } = this.validateToken(token);

    const org = await this._organizationService.getOrgById(orgId);

    if (!org || org.deletedAt) {
      throw new HttpException({ msg: 'Organization not found' }, 404);
    }

    const integrations = await this._integrationManager.getAllIntegrations();

    return {
      organization: {
        name: org.name,
      },
      integrations: integrations.social
        .filter(
          (integration) =>
            !integration.isWeb3 &&
            !integration.isChromeExtension &&
            !integration.isExternal &&
            !integration.customFields
        )
        .map((integration) => ({
          name: integration.name,
          identifier: integration.identifier,
        })),
    };
  }

  @Get('/:token/social/:integration')
  async getOAuthUrl(
    @Param('token') token: string,
    @Param('integration') integration: string
  ) {
    const { orgId } = this.validateToken(token);

    const org = await this._organizationService.getOrgById(orgId);

    if (!org || org.deletedAt) {
      throw new HttpException({ msg: 'Organization not found' }, 404);
    }

    const integrationProvider =
      this.assertConnectableProvider(integration);

    const { codeVerifier, state, url } =
      await integrationProvider.generateAuthUrl(undefined);

    /*
     * This is the bridge into Postiz' existing OAuth callback machinery.
     *
     * The callback resolves the organization from organization:<state> and
     * therefore stores the resulting integration directly in this customer's
     * organization without requiring a Postiz login.
     */
    await ioRedis.set(`organization:${state}`, orgId, 'EX', 3600);
    await ioRedis.set(`login:${state}`, codeVerifier, 'EX', 3600);
    await ioRedis.set(
      `redirect:${state}`,
      `${process.env.FRONTEND_URL}/connect/${token}?success=${encodeURIComponent(
        integration
      )}`,
      'EX',
      3600
    );

    return { url };
  }
}
