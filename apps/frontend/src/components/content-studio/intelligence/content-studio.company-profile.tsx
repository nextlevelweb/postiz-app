'use client';

import { FC, useCallback, useEffect, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioRequestError } from '@gitroom/frontend/components/content-studio/content-studio.api';
import {
  ContentStudioBrandKitSummary,
  useContentStudioBrandKit,
} from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import {
  BrandIdentity,
  brandKitIdentity,
  brandKitWithIdentity,
  useContentStudioSetupActions,
} from '@gitroom/frontend/components/content-studio/content-studio.setup.api';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import { useUnsavedChangesWarning } from '@gitroom/frontend/components/content-studio/content-studio.dialog';
import {
  ConflictNotice,
  EditorActions,
  LongTextField,
  ShortTextField,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';

// The limits the API enforces (brand.kit.ts)
const BRAND_NAME_MAX = 200;
const BRAND_TAGLINE_MAX = 300;
const BRAND_DESCRIPTION_MAX = 2000;

const emptyIdentity = (): BrandIdentity => ({
  brandName: '',
  tagline: '',
  description: '',
});

export const isBrandKitConflict = (error: unknown) =>
  error instanceof ContentStudioRequestError &&
  error.code === 'CS_BRAND_KIT_REVISION_CONFLICT';

// What the company is, in its own words: the identity of the organization's
// Brand Kit. Saving keeps the kit's colors, type styles and visual direction
// as they are and stores a new version over the one it was loaded from
export const CompanyProfileSection: FC = () => {
  const t = useT();
  const toaster = useToaster();
  const brandKit = useContentStudioBrandKit(true);
  const { saveBrandKit } = useContentStudioSetupActions();
  const [loaded, setLoaded] = useState(false);
  const [identity, setIdentity] = useState<BrandIdentity>(emptyIdentity);
  const [saved, setSaved] = useState<BrandIdentity>(emptyIdentity);
  const [baseRevision, setBaseRevision] = useState(0);
  const [conflict, setConflict] = useState(false);
  const { busy, run } = useSingleFlight();

  const seed = useCallback((data: ContentStudioBrandKitSummary) => {
    const current = brandKitIdentity(data.currentRevision?.content);
    setIdentity(current);
    setSaved(current);
    setBaseRevision(data.latestRevisionNumber);
    setConflict(false);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (brandKit.data && !loaded) {
      seed(brandKit.data);
    }
  }, [brandKit.data, loaded, seed]);

  const dirty = loaded && JSON.stringify(identity) !== JSON.stringify(saved);
  useUnsavedChangesWarning(dirty);

  const save = () =>
    run('save', async () => {
      try {
        const result = await saveBrandKit(
          baseRevision,
          brandKitWithIdentity(
            brandKit.data?.currentRevision?.content,
            identity
          )
        );
        setBaseRevision(result.latestRevisionNumber);
        setSaved(identity);
        toaster.show(
          t('content_studio_company_saved', 'Company profile saved.'),
          'success'
        );
      } catch (err) {
        if (isBrandKitConflict(err)) {
          setConflict(true);
          return;
        }
        toaster.show(
          t(
            'content_studio_company_save_error',
            'The company profile could not be saved. Check the lengths and try again.'
          ),
          'warning'
        );
      }
    });

  const reload = () =>
    run('reload', async () => {
      const latest = await brandKit.mutate();
      if (latest) {
        seed(latest);
      }
    });

  if (brandKit.error && !loaded) {
    return (
      <div className="flex flex-col items-center gap-[12px] py-[24px]">
        <div>
          {t('content_studio_load_error', 'Could not load Content Studio.')}
        </div>
        <Button secondary onClick={() => brandKit.mutate()}>
          {t('content_studio_retry', 'Try again')}
        </Button>
      </div>
    );
  }
  if (!loaded) {
    return <LoadingComponent />;
  }

  const set = (patch: Partial<BrandIdentity>) =>
    setIdentity({ ...identity, ...patch });
  const tooLong =
    identity.brandName.length > BRAND_NAME_MAX ||
    identity.tagline.length > BRAND_TAGLINE_MAX ||
    identity.description.length > BRAND_DESCRIPTION_MAX;

  return (
    <div className="flex flex-col gap-[16px] min-w-0 max-w-[820px]">
      <div className="text-[13px] text-textItemBlur">
        {t(
          'content_studio_company_note',
          'Who you are and what you do. Every AI suggestion in Content Studio starts from this.'
        )}
      </div>
      {conflict && (
        <ConflictNotice
          message={t(
            'content_studio_company_conflict',
            'The company profile changed elsewhere. Reload the latest version before saving.'
          )}
          busy={busy === 'reload'}
          onReload={reload}
        />
      )}
      <ShortTextField
        label={t('content_studio_company_name', 'Company or brand name')}
        value={identity.brandName}
        onChange={(brandName) => set({ brandName })}
      />
      <ShortTextField
        label={t('content_studio_company_tagline', 'Tagline')}
        hint={t(
          'content_studio_company_tagline_hint',
          'One line that sums up what you offer.'
        )}
        value={identity.tagline}
        onChange={(tagline) => set({ tagline })}
      />
      <LongTextField
        label={t('content_studio_company_description', 'What you do')}
        hint={t(
          'content_studio_company_description_hint',
          'What the company does, for whom, and why it matters. Up to 2000 characters.'
        )}
        rows={6}
        value={identity.description}
        onChange={(description) => set({ description })}
      />
      <EditorActions>
        {tooLong && (
          <span role="alert" className="text-[13px] me-auto">
            {t(
              'content_studio_company_too_long',
              'One of the texts is longer than allowed.'
            )}
          </span>
        )}
        <Button
          loading={busy === 'save'}
          disabled={!!busy || conflict || !dirty || tooLong}
          onClick={save}
        >
          {t('content_studio_save_profile', 'Save')}
        </Button>
      </EditorActions>
    </div>
  );
};
