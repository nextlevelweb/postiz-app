import { ContentStudioIntelligence } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence';
export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import {
  getGeneralBrandName,
  getBrandAppTitle,
} from '@gitroom/frontend/config/branding';
export const metadata: Metadata = {
  title: getBrandAppTitle(
    `${getGeneralBrandName(isGeneralServerSide())} Brand & AI`
  ),
  description: '',
};
export default async function Index() {
  return <ContentStudioIntelligence />;
}
