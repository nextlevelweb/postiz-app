import { Plugs } from '@gitroom/frontend/components/plugs/plugs';
export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { getGeneralBrandName, getBrandAppTitle } from '@gitroom/frontend/config/branding';
export const metadata: Metadata = {
  title: getBrandAppTitle(`${getGeneralBrandName(isGeneralServerSide())} Plugs`),
  description: '',
};
export default async function Index() {
  return <Plugs />;
}
