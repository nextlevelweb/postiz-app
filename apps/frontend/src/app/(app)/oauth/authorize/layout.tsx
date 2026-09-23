import { Metadata } from 'next';
import { getBrandAppTitle } from '@gitroom/frontend/config/branding';
import { ReactNode } from 'react';

export const metadata: Metadata = {
  title: getBrandAppTitle('Authorize Application'),
};

export default async function OAuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="bg-[#0B0A0A] flex flex-1 min-h-screen w-screen">
      {children}
    </div>
  );
}
