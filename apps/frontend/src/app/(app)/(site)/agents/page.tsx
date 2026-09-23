import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getGeneralBrandName, getBrandAppTitle } from '@gitroom/frontend/config/branding';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: getBrandAppTitle(`${getGeneralBrandName(isGeneralServerSide())} - Agent`),
  description: '',
};

export default async function Page() {
  return redirect('/agents/new');
}
