import { ReactNode } from 'react';

/**
 * Public authorization surface.
 *
 * This intentionally lives outside `(site)`, so a customer does not need an
 * authenticated Postiz session or access to the Postiz dashboard.
 *
 * Product/agency-specific branding should be layered on separately.
 */
export default function ConnectLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen w-full flex-1 bg-newBgColor">
      {children}
    </div>
  );
}
