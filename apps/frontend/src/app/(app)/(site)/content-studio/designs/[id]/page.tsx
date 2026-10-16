import { ContentStudioDesignWorkspace } from '@gitroom/frontend/components/content-studio/content-studio.design.workspace';
export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import {
  getGeneralBrandName,
  getBrandAppTitle,
} from '@gitroom/frontend/config/branding';
export const metadata: Metadata = {
  title: getBrandAppTitle(
    `${getGeneralBrandName(isGeneralServerSide())} Creative Studio`
  ),
  description: '',
};
export default async function Index(params: {
  params: Promise<{
    id: string;
  }>;
}) {
  const { id } = await params.params;
  // another design is another page, never the previous one's state
  return <ContentStudioDesignWorkspace key={id} designId={id} />;
}
