import { ContentStudioWorkspace } from '@gitroom/frontend/components/content-studio/content-studio.workspace';
export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import {
  getGeneralBrandName,
  getBrandAppTitle,
} from '@gitroom/frontend/config/branding';
export const metadata: Metadata = {
  title: getBrandAppTitle(
    `${getGeneralBrandName(isGeneralServerSide())} Content Studio`
  ),
  description: '',
};
export default async function Index(params: {
  params: Promise<{
    id: string;
  }>;
  searchParams: Promise<{
    revision?: string | string[];
    sources?: string | string[];
  }>;
}) {
  const { id } = await params.params;
  // the exact revision a review links to (P5-06), checked by the workspace
  const { revision } = await params.searchParams;
  const linked = typeof revision === 'string' ? revision : undefined;
  // the research sources a research link names (P8-03), as the link's text:
  // the workspace keeps only ids and the server decides what each one is
  const { sources } = await params.searchParams;
  const research = typeof sources === 'string' ? sources : undefined;
  // a new package is a new editor, never the previous one's state
  return (
    <ContentStudioWorkspace
      key={id}
      packageId={id}
      linkedRevisionId={linked}
      researchSources={research}
    />
  );
}
