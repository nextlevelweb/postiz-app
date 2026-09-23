export const dynamic = 'force-dynamic';
import { AdminStatsComponent } from '@gitroom/frontend/components/admin/admin-stats.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { getGeneralBrandName, getBrandAppTitle } from '@gitroom/frontend/config/branding';

export const metadata: Metadata = {
  title: getBrandAppTitle(`${getGeneralBrandName(isGeneralServerSide())} Admin Stats`),
  description: '',
};

export default async function Page() {
  return (
    <div className="bg-newBgColorInner flex-1 min-w-0 flex-col flex p-[20px] gap-[12px]">
      <AdminStatsComponent />
    </div>
  );
}
