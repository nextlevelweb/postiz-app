import { Metadata } from 'next';
import { Agent } from '@gitroom/frontend/components/agents/agent';
import { getGeneralBrandName, getBrandAppTitle } from '@gitroom/frontend/config/branding';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
export const metadata: Metadata = {
  title: getBrandAppTitle(`${getGeneralBrandName(isGeneralServerSide())} - Agent`),
  description: 'agents',
};
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Agent>{children}</Agent>;
}
