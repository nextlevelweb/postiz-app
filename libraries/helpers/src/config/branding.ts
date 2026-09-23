export const branding = {
  name: process.env.NEXT_PUBLIC_BRAND_NAME?.trim() || '',
  shortName: process.env.NEXT_PUBLIC_BRAND_SHORT_NAME?.trim() || '',
  logoUrl: process.env.NEXT_PUBLIC_BRAND_LOGO_URL?.trim() || '',
  logoTextUrl: process.env.NEXT_PUBLIC_BRAND_LOGO_TEXT_URL?.trim() || '',
  faviconUrl: process.env.NEXT_PUBLIC_BRAND_FAVICON_URL?.trim() || '',
  primaryColor: process.env.NEXT_PUBLIC_BRAND_PRIMARY_COLOR?.trim() || '',
  secondaryColor: process.env.NEXT_PUBLIC_BRAND_SECONDARY_COLOR?.trim() || '',
  accentColor: process.env.NEXT_PUBLIC_BRAND_ACCENT_COLOR?.trim() || '',
  textDark: process.env.NEXT_PUBLIC_BRAND_TEXT_DARK?.trim() || '',
  textLight: process.env.NEXT_PUBLIC_BRAND_TEXT_LIGHT?.trim() || '',
  gradientStart: process.env.NEXT_PUBLIC_BRAND_GRADIENT_START?.trim() || '',
  gradientEnd: process.env.NEXT_PUBLIC_BRAND_GRADIENT_END?.trim() || '',
  websiteUrl: process.env.NEXT_PUBLIC_BRAND_WEBSITE_URL?.trim() || '',
  supportUrl: process.env.NEXT_PUBLIC_BRAND_SUPPORT_URL?.trim() || '',
  termsUrl:
    process.env.NEXT_PUBLIC_BRAND_TERMS_URL?.trim() ||
    'https://postiz.com/terms',
  privacyUrl:
    process.env.NEXT_PUBLIC_BRAND_PRIVACY_URL?.trim() ||
    'https://postiz.com/privacy',
  authHeadline: process.env.NEXT_PUBLIC_BRAND_AUTH_HEADLINE?.trim() || '',
  authStat: process.env.NEXT_PUBLIC_BRAND_AUTH_STAT?.trim() || '',
  appTitle: process.env.NEXT_PUBLIC_BRAND_APP_TITLE?.trim() || '',
  agencyReviewEmail: process.env.BRAND_AGENCY_REVIEW_EMAIL?.trim() || '',
} as const;

export const getBrandName = (fallback: string = 'Postiz') =>
  branding.name || fallback;

export const getBrandShortName = (fallback: string = 'Postiz') =>
  branding.shortName || branding.name || fallback;

export const getGeneralBrandName = (isGeneral: boolean) =>
  getBrandName(isGeneral ? 'Postiz' : 'Gitroom');

export const getBrandWebsiteUrl = () =>
  branding.websiteUrl || 'https://postiz.com';

export const getBrandSupportUrl = () =>
  branding.supportUrl || getBrandWebsiteUrl();

export const isWhiteLabelBranding = () => Boolean(branding.name);

export const getBrandPrimaryColor = () =>
  branding.primaryColor || '#612ad5';

export const getBrandSecondaryColor = () =>
  branding.secondaryColor || '#612ad5';

export const getBrandAccentColor = () =>
  branding.accentColor || '#FC69FF';

export const getBrandGradientStart = () =>
  branding.gradientStart || '#662FDA';

export const getBrandGradientEnd = () =>
  branding.gradientEnd || '#5720CB';

export const getBrandAppTitle = (fallback: string) =>
  branding.appTitle || fallback;
