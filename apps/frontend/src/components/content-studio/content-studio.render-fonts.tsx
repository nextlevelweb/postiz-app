'use client';

import { FC, FormEvent, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import {
  ContentStudioRenderFont,
  DEFAULT_RENDER_FONT_FAMILY,
  RENDER_FONT_ACCEPT,
  RENDER_FONT_FILE_MAX_BYTES,
  RENDER_FONT_STYLES,
  RENDER_FONT_WEIGHTS,
  renderFontErrorMessage,
  useContentStudioRenderFontActions,
  useContentStudioRenderFonts,
} from '@gitroom/frontend/components/content-studio/content-studio.render-fonts.api';

// Render fonts: the built-in font every design renders with, and the
// organization's own font files for exact design fonts. Every member sees the
// list; only ADMIN and SUPERADMIN see upload, disable and enable (the server
// checks the same roles). Nothing here is needed for a first render

const MANAGER_ROLES = ['ADMIN', 'SUPERADMIN'];
const useCanManageRenderFonts = () =>
  MANAGER_ROLES.includes(useUser()?.role as string);

const fontLabel = (
  t: (key: string, fallback: string) => string,
  font: { family: string; weight: number; style: string }
) =>
  `${font.family} · ${font.weight} · ${
    font.style === 'italic'
      ? t('content_studio_render_font_italic', 'Italic')
      : t('content_studio_render_font_normal', 'Normal')
  }`;

const UploadRenderFontForm: FC = () => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioRenderFontActions();
  const [family, setFamily] = useState('');
  const [weight, setWeight] = useState(400);
  const [style, setStyle] = useState<string>('normal');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const { busy, run } = useSingleFlight();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!family.trim() || !file) {
      setError(
        t(
          'content_studio_render_font_required',
          'Enter the font family and choose a font file.'
        )
      );
      return;
    }
    if (file.size > RENDER_FONT_FILE_MAX_BYTES) {
      setError(
        t(
          'content_studio_render_font_too_large',
          'The font file is larger than 32 MB.'
        )
      );
      return;
    }
    run('upload', async () => {
      try {
        await actions.upload({ family: family.trim(), weight, style, file });
        toaster.show(
          t('content_studio_render_font_uploaded', 'Render font saved.'),
          'success'
        );
        setFamily('');
        setFile(null);
      } catch (err) {
        setError(renderFontErrorMessage(t, err));
      }
    });
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-[12px]"
      aria-label={t('content_studio_render_font_upload', 'Upload a font')}
    >
      <div className="text-[14px] font-[600]">
        {t('content_studio_render_font_upload', 'Upload a font')}
      </div>
      <div className="text-[12px] text-textItemBlur">
        {t(
          'content_studio_render_font_upload_hint',
          'Use the family name exactly as your designs and Brand Kit name it. Uploading again for the same family, weight and style replaces the file for new renders.'
        )}
      </div>
      <Input
        label="Family"
        translationKey="content_studio_render_font_family"
        name="family"
        aria-label={t('content_studio_render_font_family', 'Family')}
        disableForm={true}
        removeError={true}
        maxLength={200}
        value={family}
        onChange={(e) => setFamily(e.target.value)}
      />
      <div className="flex flex-wrap gap-[12px]">
        <div className="flex-1 min-w-[140px]">
          <Select
            label="Weight"
            translationKey="content_studio_render_font_weight"
            name="weight"
            aria-label={t('content_studio_render_font_weight', 'Weight')}
            disableForm={true}
            hideErrors={true}
            value={String(weight)}
            onChange={(e) => setWeight(Number(e.target.value))}
          >
            {RENDER_FONT_WEIGHTS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex-1 min-w-[140px]">
          <Select
            label="Style"
            translationKey="content_studio_render_font_style"
            name="style"
            aria-label={t('content_studio_render_font_style', 'Style')}
            disableForm={true}
            hideErrors={true}
            value={style}
            onChange={(e) => setStyle(e.target.value)}
          >
            {RENDER_FONT_STYLES.map((value) => (
              <option key={value} value={value}>
                {value === 'italic'
                  ? t('content_studio_render_font_italic', 'Italic')
                  : t('content_studio_render_font_normal', 'Normal')}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <label className="flex flex-col gap-[6px] text-[14px]">
        {t('content_studio_render_font_file', 'Font file (.ttf or .otf)')}
        <input
          type="file"
          name="file"
          accept={RENDER_FONT_ACCEPT}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      {!!error && (
        <div role="status" className="text-[13px] text-red-400">
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <Button type="submit" loading={!!busy} disabled={!!busy}>
          {t('content_studio_render_font_save', 'Save font')}
        </Button>
      </div>
    </form>
  );
};

const RenderFontRow: FC<{
  font: ContentStudioRenderFont;
  canManage: boolean;
}> = ({ font, canManage }) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioRenderFontActions();
  const { busy, run } = useSingleFlight();
  const enabled = !font.disabledAt;
  return (
    <li className="flex flex-wrap items-center gap-[12px] p-[12px] border border-newTableBorder rounded-[8px]">
      <div className="flex flex-col gap-[2px] flex-1 min-w-[160px]">
        <span className="text-[14px] font-[600] break-words">
          {fontLabel(t, font)}
        </span>
        <span className="text-[12px] text-textItemBlur">
          {enabled
            ? t('content_studio_render_font_active', 'Used for new renders')
            : t(
                'content_studio_render_font_disabled',
                'Disabled: new renders use the built-in font'
              )}
        </span>
      </div>
      {canManage && (
        <Button
          secondary
          loading={!!busy}
          disabled={!!busy}
          onClick={() =>
            run(font.id, async () => {
              try {
                await actions.setEnabled(font.id, !enabled);
              } catch (err) {
                toaster.show(renderFontErrorMessage(t, err), 'warning');
              }
            })
          }
        >
          {enabled
            ? t('content_studio_render_font_disable', 'Disable')
            : t('content_studio_render_font_enable', 'Enable')}
        </Button>
      )}
    </li>
  );
};

export const ContentStudioRenderFonts: FC = () => {
  const t = useT();
  const canManage = useCanManageRenderFonts();
  const fonts = useContentStudioRenderFonts(true);

  return (
    <div className="flex flex-col gap-[16px] min-w-0">
      <section
        aria-label={t('content_studio_render_font_default', 'Built-in font')}
        className="flex flex-col gap-[4px] p-[12px] rounded-[8px] border border-newTableBorder"
      >
        <span className="text-[14px] font-[600]">
          {`${DEFAULT_RENDER_FONT_FAMILY} · ${t(
            'content_studio_render_font_default',
            'Built-in font'
          )}`}
        </span>
        <span className="text-[12px] text-textItemBlur">
          {t(
            'content_studio_render_font_default_hint',
            'Every design renders without setup: text in a font you have not uploaded is drawn with Noto Sans (Regular up to weight 500, Bold from 600; italic is drawn upright). Noto Sans is licensed under the SIL Open Font License 1.1.'
          )}
        </span>
      </section>

      <div className="flex flex-col gap-[8px]">
        <div className="text-[14px] font-[600]">
          {t('content_studio_render_font_list', 'Your fonts')}
        </div>
        {fonts.error ? (
          <div className="flex items-center gap-[12px]">
            <span>
              {t(
                'content_studio_render_font_load_error',
                'Render fonts could not be loaded.'
              )}
            </span>
            <Button secondary onClick={() => fonts.mutate()}>
              {t('content_studio_retry', 'Try again')}
            </Button>
          </div>
        ) : !fonts.data ? (
          <LoadingComponent />
        ) : !fonts.data.length ? (
          <div className="text-[13px] text-textItemBlur">
            {t(
              'content_studio_render_font_none',
              'No fonts uploaded. Designs use the built-in font.'
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-[8px]">
            {fonts.data.map((font) => (
              <RenderFontRow key={font.id} font={font} canManage={canManage} />
            ))}
          </ul>
        )}
      </div>

      {canManage ? (
        <UploadRenderFontForm />
      ) : (
        <div className="text-[12px] text-textItemBlur">
          {t(
            'content_studio_render_font_admin_hint',
            'An organization administrator can upload your brand fonts.'
          )}
        </div>
      )}
    </div>
  );
};
