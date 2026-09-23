export const dynamic = 'force-dynamic';
import { LaunchesComponent } from '@gitroom/frontend/components/launches/launches.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { getGeneralBrandName, getBrandAppTitle } from '@gitroom/frontend/config/branding';
export const metadata: Metadata = {
  title: getBrandAppTitle(`${`${getGeneralBrandName(isGeneralServerSide())} ${isGeneralServerSide() ? 'Calendar' : 'Launches'}`}`),
  description: '',
};
export default async function Index() {
  return <LaunchesComponent />;
}
