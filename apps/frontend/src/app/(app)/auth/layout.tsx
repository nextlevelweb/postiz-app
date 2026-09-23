import { getT } from '@gitroom/react/translation/get.translation.service.backend';

export const dynamic = 'force-dynamic';
import { ReactNode } from 'react';
import loadDynamic from 'next/dynamic';
import { TestimonialComponent } from '@gitroom/frontend/components/auth/testimonial.component';
import { LogoTextComponent } from '@gitroom/frontend/components/ui/logo-text.component';
import { MantineWrapper } from '@gitroom/react/helpers/mantine.wrapper';
import { Toaster } from '@gitroom/react/toaster/toaster';
import { branding, getGeneralBrandName } from '@gitroom/frontend/config/branding';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
const ReturnUrlComponent = loadDynamic(() => import('./return.url.component'));
export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  const t = await getT();
  const brandName = getGeneralBrandName(isGeneralServerSide());
  const isWhiteLabel = Boolean(branding.name);
  const authHeadline =
    branding.authHeadline ||
    (isWhiteLabel
      ? `Manage your social presence with ${brandName}`
      : `Entrepreneurs use ${brandName} To Grow Their Social Presence`);
  const authStat = branding.authStat || (!isWhiteLabel ? '20,000+' : '');

  return (
    <MantineWrapper>
      <Toaster />
      <div
        className={
          isWhiteLabel
            ? 'bg-[#0E0E0E] flex flex-1 min-h-screen w-screen text-white items-center justify-center p-[16px]'
            : 'bg-[#0E0E0E] flex flex-1 p-[12px] gap-[12px] min-h-screen w-screen text-white'
        }
      >
        {/*<style>{`html, body {overflow-x: hidden;}`}</style>*/}
        <ReturnUrlComponent />

        <div
          className={
            isWhiteLabel
              ? 'flex flex-col py-[40px] px-[24px] w-full max-w-[520px] min-h-[620px] rounded-[12px] text-white bg-[#1A1919]'
              : 'flex flex-col py-[40px] px-[20px] flex-1 lg:w-[600px] lg:flex-none rounded-[12px] text-white p-[12px] bg-[#1A1919]'
          }
        >
          <div className="w-full max-w-[440px] mx-auto justify-center gap-[20px] h-full flex flex-col text-white">
            <LogoTextComponent />
            <div className="flex">{children}</div>
          </div>
        </div>

        {!isWhiteLabel && (
          <div className="text-[36px] flex-1 pt-[88px] hidden lg:flex flex-col items-center">
            <div className="text-center">
              {authStat && (
                <>
                  Over{' '}
                  <span className="text-[42px] text-[var(--brand-primary)]">{authStat}</span>{' '}
                </>
              )}
              <span>{authHeadline}</span>
            </div>
            <TestimonialComponent />
          </div>
        )}
      </div>
    </MantineWrapper>
  );
}
