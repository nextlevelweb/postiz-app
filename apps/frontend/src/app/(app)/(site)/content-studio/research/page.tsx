import { ContentStudioResearchTabs } from '@gitroom/frontend/components/content-studio/content-studio.research.tabs';
export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import {
  getGeneralBrandName,
  getBrandAppTitle,
} from '@gitroom/frontend/config/branding';
export const metadata: Metadata = {
  title: getBrandAppTitle(
    `${getGeneralBrandName(isGeneralServerSide())} News Radar`
  ),
  description: '',
};
export default async function Index() {
  return <ContentStudioResearchTabs />;
}
