export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { PlatformAnalytics } from '@gitroom/frontend/components/platform-analytics/platform.analytics';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { getGeneralBrandName, getBrandAppTitle } from '@gitroom/frontend/config/branding';
export const metadata: Metadata = {
  title: getBrandAppTitle(`${getGeneralBrandName(isGeneralServerSide())} Analytics`),
  description: '',
};
export default async function Index() {
  return <PlatformAnalytics />;
}
