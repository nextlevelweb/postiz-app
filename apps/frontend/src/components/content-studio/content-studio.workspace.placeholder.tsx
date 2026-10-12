'use client';

import { FC } from 'react';
import Link from 'next/link';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

// Stands in for the package workspace until it is built, so opening a package
// never lands on a 404. Nothing is loaded here
export const ContentStudioWorkspacePlaceholder: FC = () => {
  const t = useT();
  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[16px]">
      <Link href="/content-studio" className="hover:underline w-fit">
        {t('content_studio_back', 'Back to Content Studio')}
      </Link>
      <div className="text-textItemBlur">
        {t(
          'content_studio_workspace_coming',
          'The package workspace will be added in the next step.'
        )}
      </div>
    </div>
  );
};
