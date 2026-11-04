'use client';

import { createContext, FC, ReactNode, useContext, useEffect } from 'react';
interface VariableContextInterface {
  stripeClient: string;
  billingEnabled: boolean;
  isChatBase: boolean;
  isGeneral: boolean;
  genericOauth: boolean;
  oauthLogoUrl: string;
  oauthDisplayName: string;
  mcpUrl?: string;
  cloudflareUrl: string;
  mainUrl: string;
  frontEndUrl: string;
  plontoKey: string;
  storageProvider: 'local' | 'cloudflare';
  backendUrl: string;
  environment: string;
  discordUrl: string;
  uploadDirectory: string;
  facebookPixel: string;
  telegramBotName: string;
  neynarClientId: string;
  appleClientId: string;
  isSecured: boolean;
  disableImageCompression: boolean;
  disableXAnalytics: boolean;
  language: string;
  dub: boolean;
  transloadit: string[];
  mediaProcessing: boolean;
  sentryDsn: string;
  extensionId: string;
  googleAdsId?: string;
  googleAdsTrialTracking?: string;
  recaptchaSiteKey?: string;
}
const VariableContext = createContext({
  stripeClient: '',
  billingEnabled: false,
  isGeneral: true,
  genericOauth: false,
  isChatBase: false,
  oauthLogoUrl: '',
  googleAdsId: '',
  googleAdsTrialTracking: '',
  oauthDisplayName: '',
  mcpUrl: '',
  cloudflareUrl: '',
  mainUrl: '',
  frontEndUrl: '',
  storageProvider: 'local',
  plontoKey: '',
  backendUrl: '',
  discordUrl: '',
  uploadDirectory: '',
  isSecured: false,
  telegramBotName: '',
  facebookPixel: '',
  neynarClientId: '',
  appleClientId: '',
  disableImageCompression: false,
  disableXAnalytics: false,
  language: '',
  dub: false,
  transloadit: [],
  mediaProcessing: false,
  sentryDsn: '',
  extensionId: '',
  recaptchaSiteKey: '',
} as VariableContextInterface);
// Development only: a backend on the frontend's own host (FRONTEND_URL) is
// reached on the host the browser opened the frontend on, so localhost,
// 127.0.0.1 and a LAN address each call their own backend (with NOT_SECURED;
// secure cookies stay bound to FRONTEND_URL). Production, the server and a
// backend on another host keep the configured URL.
export const developmentBackendUrl = (
  backendUrl: string,
  frontEndUrl: string,
  environment: string,
  hostname?: string
) => {
  if (environment !== 'development' || !hostname) {
    return backendUrl;
  }
  try {
    const backend = new URL(backendUrl);
    if (
      backend.hostname !== new URL(frontEndUrl).hostname ||
      backend.hostname === hostname
    ) {
      return backendUrl;
    }
    backend.hostname = hostname;
    return backendUrl.endsWith('/')
      ? backend.href
      : backend.href.replace(/\/$/, '');
  } catch {
    return backendUrl;
  }
};

export const VariableContextComponent: FC<
  VariableContextInterface & {
    children: ReactNode;
  }
> = (props) => {
  const { children, ...configured } = props;
  const otherProps = {
    ...configured,
    backendUrl: developmentBackendUrl(
      configured.backendUrl,
      configured.frontEndUrl,
      configured.environment,
      typeof window === 'undefined' ? undefined : window.location.hostname
    ),
  };
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // @ts-ignore
      window.vars = otherProps;
    }
  }, []);
  return (
    <VariableContext.Provider value={otherProps}>
      {children}
    </VariableContext.Provider>
  );
};
export const useVariables = () => {
  return useContext(VariableContext);
};
export const loadVars = () => {
  // @ts-ignore
  return window.vars as VariableContextInterface;
};
