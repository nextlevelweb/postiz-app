export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AfterActivate } from '@gitroom/frontend/components/auth/after.activate';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { getGeneralBrandName, getBrandAppTitle } from '@gitroom/frontend/config/branding';
export const metadata: Metadata = {
  title: `${
    getGeneralBrandName(isGeneralServerSide())
  } - Activate your account`,
  description: '',
};
export default async function Auth() {
  return <AfterActivate />;
}
