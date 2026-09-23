'use client';

import { useCallback, useEffect, useState } from 'react';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { branding } from '@gitroom/frontend/config/branding';

type PlatformInfo = {
  name: string;
  identifier: string;
};

type ConnectLinkInfo = {
  organization: {
    name: string;
  };
  integrations: PlatformInfo[];
};

export const ConnectPlatforms = ({
  token,
  successProvider,
}: {
  token: string;
  successProvider?: string;
}) => {
  const { backendUrl } = useVariables();

  const [data, setData] = useState<ConnectLinkInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const response = await fetch(
          `${backendUrl}/connect/${encodeURIComponent(token)}/integrations`
        );

        const body = await response.json().catch(() => ({}));

        if (!active) {
          return;
        }

        if (!response.ok) {
          setError(
            body?.msg ||
              'This authorization link is invalid or has expired.'
          );
          return;
        }

        setData(body);
      } catch {
        if (active) {
          setError('Could not load this authorization link.');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      active = false;
    };
  }, [backendUrl, token]);

  const connect = useCallback(
    async (identifier: string) => {
      setConnecting(identifier);
      setError(null);

      try {
        const response = await fetch(
          `${backendUrl}/connect/${encodeURIComponent(
            token
          )}/social/${encodeURIComponent(identifier)}`
        );

        const body = await response.json().catch(() => ({}));

        if (!response.ok || !body?.url) {
          setError(body?.msg || 'Could not start authorization.');
          setConnecting(null);
          return;
        }

        window.location.assign(body.url);
      } catch {
        setError('Could not start authorization.');
        setConnecting(null);
      }
    },
    [backendUrl, token]
  );

  if (loading) {
    return (
      <main className="flex min-h-screen w-full items-center justify-center p-[24px] text-newTextColor">
        <div className="rounded-[12px] border border-newBorder bg-newBgColorInner p-[32px]">
          Loading authorization options…
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="flex min-h-screen w-full items-center justify-center p-[24px] text-newTextColor">
        <div className="w-full max-w-[520px] rounded-[12px] border border-newBorder bg-newBgColorInner p-[32px] text-center">
          <h1 className="text-[22px] font-semibold">
            Authorization link unavailable
          </h1>
          <p className="mt-[12px] text-[14px] text-newTextItemBlur">
            {error || 'This authorization link cannot be used.'}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center p-[24px] text-newTextColor">
      <div className="w-full max-w-[620px] rounded-[12px] border border-newBorder bg-newBgColorInner p-[28px]">
        <div className="text-center">
          <h1 className="text-[24px] font-semibold">
            Connect an account
          </h1>

          <p className="mt-[8px] text-[14px] text-newTextItemBlur">
            Authorize an account for {data.organization.name}.
            You do not need a {branding.name || 'Postiz'} account to continue.
          </p>
        </div>

        {successProvider && (
          <div className="mt-[20px] rounded-[8px] border border-newBorder bg-newBoxFocused p-[12px] text-center text-[14px]">
            Account connected successfully.
          </div>
        )}

        {error && (
          <div className="mt-[20px] rounded-[8px] border border-newBorder p-[12px] text-center text-[14px]">
            {error}
          </div>
        )}

        <div className="mt-[24px] grid grid-cols-1 gap-[10px] sm:grid-cols-2">
          {data.integrations.map((platform) => {
            const isConnecting = connecting === platform.identifier;

            return (
              <button
                type="button"
                key={platform.identifier}
                disabled={!!connecting}
                onClick={() => connect(platform.identifier)}
                className="flex min-h-[58px] items-center justify-between rounded-[8px] border border-newBorder bg-newBgColor px-[16px] py-[12px] text-left transition hover:bg-newBoxHover disabled:cursor-wait disabled:opacity-60"
              >
                <span className="text-[14px] font-medium">
                  {platform.name}
                </span>

                <span className="text-[12px] text-newTextItemBlur">
                  {isConnecting ? 'Opening…' : 'Connect'}
                </span>
              </button>
            );
          })}
        </div>

        {!data.integrations.length && (
          <div className="mt-[24px] text-center text-[14px] text-newTextItemBlur">
            No browser-based integrations are currently available.
          </div>
        )}

        <p className="mt-[24px] text-center text-[12px] text-newTextItemBlur">
          Authorization takes place directly with the selected provider.
        </p>
      </div>
    </main>
  );
};
