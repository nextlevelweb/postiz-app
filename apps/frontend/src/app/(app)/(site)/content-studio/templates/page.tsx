import { ContentStudioDesignTemplates } from '@gitroom/frontend/components/content-studio/content-studio.design-templates';
export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import {
  getGeneralBrandName,
  getBrandAppTitle,
} from '@gitroom/frontend/config/branding';
export const metadata: Metadata = {
  title: getBrandAppTitle(
    `${getGeneralBrandName(isGeneralServerSide())} Creative Studio Templates`
  ),
  description: '',
};
export default async function Index() {
  return <ContentStudioDesignTemplates />;
}
