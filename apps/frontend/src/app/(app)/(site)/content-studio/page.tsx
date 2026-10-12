import { ContentStudioHome } from '@gitroom/frontend/components/content-studio/content-studio.home';
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
export default async function Index() {
  return <ContentStudioHome />;
}
