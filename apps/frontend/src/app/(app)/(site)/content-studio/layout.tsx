import { ContentStudioCloseModalsOnNavigate } from '@gitroom/frontend/components/content-studio/content-studio.dialog';

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ContentStudioCloseModalsOnNavigate />
      {children}
    </>
  );
}
