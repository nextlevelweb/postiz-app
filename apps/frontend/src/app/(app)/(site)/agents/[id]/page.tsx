import { Metadata } from 'next';
import { Agent } from '@gitroom/frontend/components/agents/agent';
import { AgentChat } from '@gitroom/frontend/components/agents/agent.chat';
import { getGeneralBrandName, getBrandAppTitle } from '@gitroom/frontend/config/branding';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
export const metadata: Metadata = {
  title: getBrandAppTitle(`${getGeneralBrandName(isGeneralServerSide())} - Agent`),
  description: '',
};
export default async function Page() {
  return (
    <AgentChat />
  );
}
