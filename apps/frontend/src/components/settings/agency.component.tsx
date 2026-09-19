'use client';

import React, { useCallback, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import copy from 'copy-to-clipboard';

import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';

type OrganizationListItem = {
  id: string;
  name: string;
  users?: Array<{
    role: 'USER' | 'ADMIN' | 'SUPERADMIN';
    disabled?: boolean;
  }>;
};

type ProvisionResult = {
  organizationId: string;
  ownerUserId: string;
  ownerRole: 'SUPERADMIN';
  customer:
    | null
    | {
        email: string;
        userId?: string;
        role: 'ADMIN';
        status: 'added' | 'invite_required';
        inviteUrl?: string;
      };
};

type ConnectLinkResult = {
  token: string;
  url: string;
  expiresAt: string;
};

const readError = async (response: Response) => {
  try {
    const body = await response.json();

    if (typeof body?.message === 'string') {
      return body.message;
    }

    if (typeof body?.msg === 'string') {
      return body.msg;
    }

    if (typeof body?.error === 'string') {
      return body.error;
    }
  } catch {}

  return 'Something went wrong';
};

export const ProvisionOrganizationForm = ({
  onCreated,
}: {
  onCreated?: (result: ProvisionResult) => void | Promise<void>;
}) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const modals = useModals();
  const { mutate: globalMutate } = useSWRConfig();

  const [name, setName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  const create = useCallback(async () => {
    if (!name.trim()) {
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/user/organizations/provision', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          ...(customerEmail.trim()
            ? { customerEmail: customerEmail.trim() }
            : {}),
        }),
      });

      if (!response.ok) {
        toaster.show(await readError(response), 'warning');
        return;
      }

      const created = (await response.json()) as ProvisionResult;

      setResult(created);
      await globalMutate('organizations');

      if (created.customer?.status === 'added') {
        toaster.show(
          t(
            'agency_customer_added',
            'Organization created and customer added as Admin'
          ),
          'success'
        );
      } else if (created.customer?.status === 'invite_required') {
        toaster.show(
          t(
            'agency_customer_invite_required',
            'Organization created. The customer still needs to accept an invitation.'
          ),
          'success'
        );
      } else {
        toaster.show(
          t('agency_organization_created', 'Organization created'),
          'success'
        );
      }

      await onCreated?.(created);
    } finally {
      setLoading(false);
    }
  }, [
    name,
    customerEmail,
    fetch,
    toaster,
    t,
    globalMutate,
    onCreated,
  ]);

  const copyInvite = useCallback(() => {
    if (!result?.customer?.inviteUrl) {
      return;
    }

    copy(result.customer.inviteUrl);
    toaster.show(
      t('link_copied_to_clipboard', 'Link copied to clipboard'),
      'success'
    );
  }, [result, toaster, t]);

  const close = useCallback(() => {
    modals.closeAll();
  }, [modals]);

  if (result) {
    return (
      <div className="relative flex gap-[16px] flex-col flex-1 p-[16px] pt-0">
        <div className="rounded-[8px] border border-newTableBorder bg-newBgColorInner p-[16px]">
          <div className="font-semibold">
            {t('agency_organization_created', 'Organization created')}
          </div>

          <div className="text-[12px] text-customColor18 mt-[6px] break-all">
            {result.organizationId}
          </div>
        </div>

        {result.customer?.status === 'added' && (
          <div className="rounded-[8px] border border-newTableBorder bg-newBgColorInner p-[16px]">
            <div className="font-semibold">
              {t('agency_customer_added_title', 'Customer added')}
            </div>
            <div className="text-[13px] text-customColor18 mt-[4px]">
              {result.customer.email} is toegevoegd als Admin.
            </div>
          </div>
        )}

        {result.customer?.status === 'invite_required' &&
          result.customer.inviteUrl && (
            <div className="rounded-[8px] border border-newTableBorder bg-newBgColorInner p-[16px] flex flex-col gap-[12px]">
              <div>
                <div className="font-semibold">
                  {t('agency_invitation_required', 'Invitation required')}
                </div>
                <div className="text-[13px] text-customColor18 mt-[4px]">
                  Er bestaat nog geen Postiz-account voor{' '}
                  {result.customer.email}. Deel deze uitnodigingslink met de
                  klant.
                </div>
              </div>

              <div className="text-[12px] break-all bg-sixth border border-fifth rounded-[6px] p-[12px]">
                {result.customer.inviteUrl}
              </div>

              <Button onClick={copyInvite}>
                {t('copy_invitation_link', 'Copy invitation link')}
              </Button>
            </div>
          )}

        <Button secondary={true} onClick={close}>
          {t('close', 'Close')}
        </Button>
      </div>
    );
  }

  return (
    <div className="relative flex gap-[14px] flex-col flex-1 p-[16px] pt-0">
      <div className="text-[13px] text-customColor18">
        Maak een beheerde klantorganisatie aan. Het klant-e-mailadres is
        optioneel. Als het account al bestaat wordt de klant direct als Admin
        toegevoegd; anders krijg je een uitnodigingslink terug.
      </div>

      <Input
        value={name}
        disableForm={true}
        removeError={true}
        onChange={(e) => setName(e.target.value)}
        name="agency-organization-name"
        label={t('organization_name', 'Organization name')}
        placeholder={t('organization_name', 'Organization name')}
      />

      <Input
        value={customerEmail}
        disableForm={true}
        removeError={true}
        onChange={(e) => setCustomerEmail(e.target.value)}
        name="agency-customer-email"
        type="email"
        label={t('customer_email_optional', 'Customer email (optional)')}
        placeholder="customer@example.com"
      />

      <Button
        type="button"
        className="mt-[4px]"
        onClick={create}
        disabled={!name.trim()}
        loading={loading}
      >
        {t('create_customer_organization', 'Create customer organization')}
      </Button>
    </div>
  );
};

export const AgencyComponent = () => {
  const t = useT();
  const fetch = useFetch();
  const user = useUser();
  const toaster = useToaster();
  const modals = useModals();

  const [creatingLinkFor, setCreatingLinkFor] = useState<string | null>(null);
  const [connectLinks, setConnectLinks] = useState<
    Record<string, ConnectLinkResult>
  >({});

  const loadOrganizations = useCallback(async () => {
    const response = await fetch('/user/organizations');

    if (!response.ok) {
      throw new Error('Could not load organizations');
    }

    return (await response.json()) as OrganizationListItem[];
  }, [fetch]);

  const {
    data: organizations,
    isLoading,
    mutate,
  } = useSWR('agency-organizations', loadOrganizations, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
  });

  const managedOrganizations = useMemo(
    () =>
      (organizations || []).filter(
        (organization) =>
          organization.users?.[0]?.role === 'SUPERADMIN' &&
          !organization.users?.[0]?.disabled
      ),
    [organizations]
  );

  const openCreate = useCallback(() => {
    modals.openModal({
      classNames: {
        modal: 'bg-transparent text-textColor',
      },
      title: t(
        'create_customer_organization',
        'Create customer organization'
      ),
      withCloseButton: true,
      children: (
        <ProvisionOrganizationForm
          onCreated={async () => {
            await mutate();
          }}
        />
      ),
    });
  }, [modals, mutate, t]);

  const createConnectLink = useCallback(
    async (organization: OrganizationListItem) => {
      setCreatingLinkFor(organization.id);

      try {
        const response = await fetch(
          `/user/organizations/${organization.id}/connect-link`,
          {
            method: 'POST',
            body: JSON.stringify({
              expiresInHours: 24,
            }),
          }
        );

        if (!response.ok) {
          toaster.show(await readError(response), 'warning');
          return;
        }

        const result = (await response.json()) as ConnectLinkResult;

        setConnectLinks((current) => ({
          ...current,
          [organization.id]: result,
        }));

        copy(result.url);

        toaster.show(
          t(
            'connect_link_copied',
            '24-hour connection link copied to clipboard'
          ),
          'success'
        );
      } finally {
        setCreatingLinkFor(null);
      }
    },
    [fetch, toaster, t]
  );

  const copyConnectLink = useCallback(
    (organizationId: string) => {
      const link = connectLinks[organizationId];

      if (!link) {
        return;
      }

      copy(link.url);

      toaster.show(
        t('link_copied_to_clipboard', 'Link copied to clipboard'),
        'success'
      );
    },
    [connectLinks, toaster, t]
  );

  if (user?.role !== 'SUPERADMIN') {
    return null;
  }

  return (
    <div className="flex flex-col">
      <div
        className="rounded-[10px] p-[20px] mb-[20px] text-white relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, #1B355F 0%, #09578B 58%, #039E94 100%)',
        }}
      >
        <div
          className="absolute top-0 right-0 w-[110px] h-[5px]"
          style={{ background: '#FF6600' }}
        />

        <div
          className="text-[12px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: '#0BDEAB' }}
        >
          Next Level Web
        </div>

        <h3 className="text-[22px] font-semibold mt-[3px]">
          {t('agency_management', 'Agency Management')}
        </h3>

        <div className="text-[13px] opacity-80 mt-[5px] max-w-[720px]">
          Beheer klantorganisaties en genereer veilige tijdelijke links waarmee
          klanten zelf hun social-media-accounts kunnen autoriseren zonder
          toegang tot het Postiz-dashboard.
        </div>
      </div>

      <div className="flex items-center justify-between gap-[20px] mb-[16px]">
        <div>
          <div className="text-[17px] font-semibold">
            {t('managed_organizations', 'Managed organizations')}
          </div>
          <div className="text-[12px] text-customColor18 mt-[3px]">
            Alleen organisaties waarin jij Super Admin bent worden hier
            weergegeven.
          </div>
        </div>

        <Button onClick={openCreate}>
          {t('create_customer_organization', 'Create customer organization')}
        </Button>
      </div>

      <div className="bg-sixth border-fifth border rounded-[8px] overflow-hidden">
        {isLoading && (
          <div className="p-[24px] text-customColor18">
            {t('loading', 'Loading...')}
          </div>
        )}

        {!isLoading && managedOrganizations.length === 0 && (
          <div className="p-[24px]">
            <div className="font-semibold">
              {t('no_managed_organizations', 'No managed organizations yet')}
            </div>
            <div className="text-[13px] text-customColor18 mt-[4px]">
              Maak je eerste klantorganisatie aan om te beginnen.
            </div>
          </div>
        )}

        {!isLoading &&
          managedOrganizations.map((organization, index) => {
            const link = connectLinks[organization.id];

            return (
              <div
                key={organization.id}
                className={`p-[20px] flex flex-col gap-[14px] ${
                  index > 0 ? 'border-t border-fifth' : ''
                }`}
              >
                <div className="flex items-center gap-[16px]">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">
                      {organization.name}
                    </div>
                    <div className="text-[11px] text-customColor18 break-all mt-[2px]">
                      {organization.id}
                    </div>
                  </div>

                  <div className="text-[11px] px-[9px] py-[4px] rounded-full border border-newTableBorder">
                    Super Admin
                  </div>

                  <Button
                    onClick={() => createConnectLink(organization)}
                    loading={creatingLinkFor === organization.id}
                  >
                    {t('create_connect_link', 'Create 24-hour connect link')}
                  </Button>
                </div>

                {link && (
                  <div className="rounded-[7px] border border-newTableBorder bg-newBgColorInner p-[14px] flex flex-col gap-[10px]">
                    <div className="flex items-center gap-[12px]">
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-semibold">
                          {t('active_connect_link', 'Generated connect link')}
                        </div>
                        <div className="text-[11px] text-customColor18 mt-[2px]">
                          Geldig tot{' '}
                          {new Date(link.expiresAt).toLocaleString()}
                        </div>
                      </div>

                      <Button
                        secondary={true}
                        onClick={() => copyConnectLink(organization.id)}
                      >
                        {t('copy_link', 'Copy link')}
                      </Button>
                    </div>

                    <div className="text-[11px] break-all text-customColor18">
                      {link.url}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
};

export default AgencyComponent;
