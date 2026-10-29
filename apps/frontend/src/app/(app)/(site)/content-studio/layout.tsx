import { ContentStudioCloseModalsOnNavigate } from '@gitroom/frontend/components/content-studio/content-studio.dialog';
import { ContentStudioDocumentClass } from '@gitroom/frontend/components/content-studio/content-studio.shell';

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ContentStudioCloseModalsOnNavigate />
      <ContentStudioDocumentClass />
      {children}
    </>
  );
}
