'use client';

import { FC, FormEvent, useCallback, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import type { ContentStudioBrandKitContentV1 } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import type {
  ContentStudioDesignShapeLayer,
  ContentStudioDesignTextLayer,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignStylePresetContentV1,
  ContentStudioDesignStylePresetKind,
  extractContentStudioDesignStylePreset,
  parseContentStudioDesignStylePresetContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset';
import { applyContentStudioDesignStyle } from '@gitroom/frontend/components/content-studio/content-studio.design.editor';
import { ContentStudioDesignEditor } from '@gitroom/frontend/components/content-studio/content-studio.design.editing';
import {
  resolveDesignPreviewColor,
  resolveDesignPreviewFont,
} from '@gitroom/frontend/components/content-studio/content-studio.design.preview';
import {
  ContentStudioDesignStylePreset,
  ContentStudioOrganizationDesignStylePreset,
  DESIGN_STYLE_PRESET_DESCRIPTION_MAX,
  DESIGN_STYLE_PRESET_NAME_MAX,
  designStylePresetErrorMessage,
  useContentStudioDesignStylePresetActions,
  useContentStudioDesignStylePresets,
} from '@gitroom/frontend/components/content-studio/content-studio.design-style-presets.api';

// Style presets in the editor: for the one selected text or shape layer,
// the built-in and the organization's presets of its kind. Apply copies a
// preset's style into the draft as one undo step (nothing is sent, nothing
// links the layer to the preset); Save style as preset sends the selected
// layer's style fields only. Each preset shows a small DOM sample drawn from
// its own values (no render, Media, font download or canvas), with Brand Kit
// tokens resolved only from the design's own exact revision

type Translate = (key: string, fallback: string) => string;

// The content, or null when it does not parse as Style Preset v1
const parsePreset = (content: unknown) => {
  try {
    return parseContentStudioDesignStylePresetContent(content);
  } catch {
    return null;
  }
};

const kindLabel = (t: Translate, kind: ContentStudioDesignStylePresetKind) =>
  kind === 'text'
    ? t('content_studio_style_presets_text', 'Text styles')
    : t('content_studio_style_presets_shape', 'Shape styles');

// A sample of the style: plain DOM boxes, aria-hidden (the name says it)
const PresetSample: FC<{
  content: ContentStudioDesignStylePresetContentV1;
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ content, brand }) => {
  if (content.kind === 'text') {
    const font = resolveDesignPreviewFont(content.style.font, brand);
    const color = resolveDesignPreviewColor(content.style.color, brand);
    return (
      <span
        aria-hidden="true"
        data-style-sample="text"
        data-unresolved={font && color ? undefined : 'token'}
        className="block truncate text-[18px] leading-[1.2] min-w-0"
        style={{
          ...(font
            ? {
                fontFamily: font.family,
                fontWeight: font.weight,
                fontStyle: font.style,
              }
            : {}),
          ...(color ? { color } : {}),
          opacity: content.style.opacity,
          textAlign: content.style.align,
        }}
      >
        Aa
      </span>
    );
  }
  const fill = resolveDesignPreviewColor(content.style.fill, brand);
  return (
    <span
      aria-hidden="true"
      data-style-sample="shape"
      data-unresolved={fill ? undefined : 'token'}
      className="block w-[40px] h-[24px] border border-newTableBorder"
      style={{
        ...(fill ? { backgroundColor: fill } : {}),
        borderRadius: Math.min(content.style.cornerRadius / 4, 12),
        opacity: content.style.opacity,
      }}
    />
  );
};

const NameField: FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
}> = ({ label, value, onChange }) => (
  <Input
    label={label}
    name="name"
    aria-label={label}
    disableForm={true}
    removeError={true}
    value={value}
    maxLength={DESIGN_STYLE_PRESET_NAME_MAX}
    onChange={(e) => onChange(e.target.value)}
    autoFocus
  />
);

const DescriptionField: FC<{
  value: string;
  onChange: (value: string) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  return (
    <label className="flex flex-col gap-[6px] text-[14px]">
      {t('content_studio_style_preset_description', 'Description')}
      <textarea
        className="bg-newBgColorInner min-h-[64px] p-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0"
        value={value}
        maxLength={DESIGN_STYLE_PRESET_DESCRIPTION_MAX}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
};

const validText = (value: string, max: number, required: boolean) => {
  const trimmed = value.trim();
  return (
    (!required || !!trimmed) && trimmed.length <= max && !trimmed.includes('\0')
  );
};

// A new preset from the style of exactly the selected layer, as it is in
// the draft now: its style fields only
const SaveStylePresetForm: FC<{
  content: ContentStudioDesignStylePresetContentV1;
  close: () => void;
}> = ({ content, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { createPreset } = useContentStudioDesignStylePresetActions();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { busy, run } = useSingleFlight();
  const valid =
    validText(name, DESIGN_STYLE_PRESET_NAME_MAX, true) &&
    validText(description, DESIGN_STYLE_PRESET_DESCRIPTION_MAX, false);
  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!valid) {
        return;
      }
      await run('save', async () => {
        try {
          await createPreset({
            name: name.trim(),
            description: description.trim(),
            content,
          });
          toaster.show(
            t('content_studio_style_preset_saved', 'Style preset saved.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(designStylePresetErrorMessage(t, err), 'warning');
        }
      });
    },
    [valid, run, createPreset, name, description, content, toaster, close, t]
  );
  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <div className="text-[13px] text-textItemBlur">
        {t(
          'content_studio_style_preset_save_hint',
          'Only the style is saved: not the text, position, size or image. Designs that use it later get a copy.'
        )}
      </div>
      <NameField
        label={t('content_studio_style_preset_name', 'Preset name')}
        value={name}
        onChange={setName}
      />
      <DescriptionField value={description} onChange={setDescription} />
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !valid}>
          {t('content_studio_style_preset_save', 'Save preset')}
        </Button>
      </div>
    </form>
  );
};

// The name and the description of an organization preset
const StylePresetDetailsForm: FC<{
  preset: ContentStudioOrganizationDesignStylePreset;
  close: () => void;
}> = ({ preset, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { updatePreset } = useContentStudioDesignStylePresetActions();
  const [name, setName] = useState(preset.name);
  const [description, setDescription] = useState(preset.description ?? '');
  const { busy, run } = useSingleFlight();
  const changed =
    validText(name, DESIGN_STYLE_PRESET_NAME_MAX, true) &&
    validText(description, DESIGN_STYLE_PRESET_DESCRIPTION_MAX, false) &&
    (name.trim() !== preset.name ||
      description.trim() !== (preset.description ?? ''));
  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!changed) {
        return;
      }
      await run('details', async () => {
        try {
          await updatePreset(preset.id, {
            name: name.trim(),
            description: description.trim(),
          });
          toaster.show(
            t('content_studio_style_preset_updated', 'Style preset updated.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(designStylePresetErrorMessage(t, err), 'warning');
        }
      });
    },
    [changed, run, updatePreset, preset, name, description, toaster, close, t]
  );
  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <NameField
        label={t('content_studio_style_preset_name', 'Preset name')}
        value={name}
        onChange={setName}
      />
      <DescriptionField value={description} onChange={setDescription} />
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !changed}>
          {t('save', 'Save')}
        </Button>
      </div>
    </form>
  );
};

// The organization's archived presets of one kind, each restorable
const ArchivedStylePresets: FC<{
  kind: ContentStudioDesignStylePresetKind;
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ kind, brand }) => {
  const t = useT();
  const toaster = useToaster();
  const { restorePreset } = useContentStudioDesignStylePresetActions();
  const [page, setPage] = useState(1);
  const list = useContentStudioDesignStylePresets(kind, true, page);
  const { busy, run } = useSingleFlight();
  if (list.error) {
    return (
      <div role="alert">
        {t(
          'content_studio_style_presets_load_error',
          'Style presets could not be loaded.'
        )}
      </div>
    );
  }
  if (!list.data) {
    return <LoadingComponent width={40} height={40} />;
  }
  return (
    <div className="flex flex-col gap-[8px] min-w-0">
      {!list.data.results.length ? (
        <div className="text-textItemBlur">
          {t(
            'content_studio_style_presets_none_archived',
            'No archived style presets.'
          )}
        </div>
      ) : (
        <ul
          aria-label={t(
            'content_studio_style_presets_archived',
            'Archived style presets'
          )}
          className="flex flex-col gap-[6px]"
        >
          {list.data.results.map((preset) => {
            const content = parsePreset(preset.content);
            return (
              <li
                key={preset.id}
                className="flex items-center gap-[8px] border border-newTableBorder rounded-[8px] px-[10px] py-[6px]"
              >
                {content && <PresetSample content={content} brand={brand} />}
                <span className="flex-1 min-w-0 break-words">
                  {preset.name}
                </span>
                <Button
                  secondary
                  loading={busy === preset.id}
                  disabled={!!busy}
                  aria-label={`${t('content_studio_restore', 'Restore')} ${
                    preset.name
                  }`}
                  onClick={() =>
                    run(preset.id, async () => {
                      try {
                        await restorePreset(preset.id);
                        toaster.show(
                          t(
                            'content_studio_style_preset_restored',
                            'Style preset restored.'
                          ),
                          'success'
                        );
                      } catch (err) {
                        toaster.show(
                          designStylePresetErrorMessage(t, err),
                          'warning'
                        );
                      }
                    })
                  }
                >
                  {t('content_studio_restore', 'Restore')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {list.data.pages > 1 && (
        <ContentStudioPager
          page={page}
          pages={list.data.pages}
          setPage={setPage}
        />
      )}
    </div>
  );
};

// One preset: its sample, name, source as text and its actions side by side
const StylePresetRow: FC<{
  preset: ContentStudioDesignStylePreset;
  brand: ContentStudioBrandKitContentV1 | null;
  applied: boolean;
  disabled: boolean;
  onApply: (content: ContentStudioDesignStylePresetContentV1) => void;
}> = ({ preset, brand, applied, disabled, onApply }) => {
  const t = useT();
  const toaster = useToaster();
  const modals = useModals();
  const { archivePreset } = useContentStudioDesignStylePresetActions();
  const { busy, run } = useSingleFlight();
  const content = parsePreset(preset.content);
  const organization = preset.source === 'organization' ? preset : null;
  return (
    <li
      data-style-preset={preset.source}
      className="flex flex-col gap-[6px] border border-newTableBorder rounded-[8px] px-[10px] py-[8px] min-w-0"
    >
      <div className="flex items-center gap-[8px] min-w-0">
        {content && <PresetSample content={content} brand={brand} />}
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-[13px] font-[600] break-words">
            {preset.name}
          </span>
          <span className="text-[11px] text-textItemBlur">
            {organization
              ? t('content_studio_style_preset_organization', 'Organization')
              : t('content_studio_style_preset_built_in', 'Built-in')}
            {applied &&
              ` · ${t('content_studio_style_preset_applied', 'Applied')}`}
          </span>
        </div>
      </div>
      {!content && (
        <div role="alert" className="text-[12px]">
          {t(
            'content_studio_style_preset_error_integrity',
            'Stored style preset data could not be read safely.'
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-[4px]">
        <Button
          secondary
          className="h-[28px] px-[10px] text-[12px]"
          disabled={disabled || !content}
          aria-label={`${t('content_studio_style_preset_apply', 'Apply')} ${
            preset.name
          }`}
          onClick={() => content && onApply(content)}
        >
          {t('content_studio_style_preset_apply', 'Apply')}
        </Button>
        {organization && (
          <>
            <Button
              secondary
              className="h-[28px] px-[10px] text-[12px]"
              disabled={!!busy}
              aria-label={`${t(
                'content_studio_style_preset_edit',
                'Edit details'
              )} ${preset.name}`}
              onClick={() =>
                modals.openModal({
                  title: t('content_studio_style_preset_edit', 'Edit details'),
                  children: (close: () => void) => (
                    <StylePresetDetailsForm
                      preset={organization}
                      close={close}
                    />
                  ),
                })
              }
            >
              {t('content_studio_style_preset_edit', 'Edit details')}
            </Button>
            <Button
              secondary
              className="h-[28px] px-[10px] text-[12px]"
              loading={busy === 'archive'}
              disabled={!!busy}
              aria-label={`${t('content_studio_archive', 'Archive')} ${
                preset.name
              }`}
              onClick={() =>
                run('archive', async () => {
                  try {
                    await archivePreset(organization.id);
                    toaster.show(
                      t(
                        'content_studio_style_preset_archived',
                        'Style preset archived. Designs that used it keep their style.'
                      ),
                      'success'
                    );
                  } catch (err) {
                    toaster.show(
                      designStylePresetErrorMessage(t, err),
                      'warning'
                    );
                  }
                })
              }
            >
              {t('content_studio_archive', 'Archive')}
            </Button>
          </>
        )}
      </div>
    </li>
  );
};

export const DesignStylePresets: FC<{
  editor: ContentStudioDesignEditor;
  layer: ContentStudioDesignTextLayer | ContentStudioDesignShapeLayer;
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ editor, layer, brand }) => {
  const t = useT();
  const modals = useModals();
  const kind = layer.type;
  const [page, setPage] = useState(1);
  const list = useContentStudioDesignStylePresets(kind, false, page);
  // which preset was applied to this layer last, while it stays selected
  const [applied, setApplied] = useState<{
    layerId: string;
    presetId: string;
  } | null>(null);
  const disabled = editor.saving || editor.interacting;
  const apply = (
    preset: ContentStudioDesignStylePreset,
    content: ContentStudioDesignStylePresetContentV1
  ) => {
    const done = editor.apply((latest) => ({
      document: applyContentStudioDesignStyle(latest, layer.id, content, brand),
      result: true,
    }));
    if (done) {
      setApplied({ layerId: layer.id, presetId: preset.id });
    }
  };
  const saveStyle = () => {
    const content = extractContentStudioDesignStylePreset(layer);
    if (!content) {
      return;
    }
    modals.openModal({
      title: t(
        'content_studio_style_preset_save_title',
        'Save style as preset'
      ),
      children: (close: () => void) => (
        <SaveStylePresetForm content={content} close={close} />
      ),
    });
  };
  const rows = (presets: ContentStudioDesignStylePreset[], label: string) => (
    <ul aria-label={label} className="flex flex-col gap-[6px]">
      {presets.map((preset) => (
        <StylePresetRow
          key={`${preset.source}:${preset.id}`}
          preset={preset}
          brand={brand}
          disabled={disabled}
          applied={
            applied?.layerId === layer.id && applied.presetId === preset.id
          }
          onApply={(content) => apply(preset, content)}
        />
      ))}
    </ul>
  );

  return (
    <section
      aria-label={t('content_studio_style_presets', 'Style presets')}
      className="flex flex-col gap-[8px] min-w-0"
    >
      <h2 className="font-[600]">
        {t('content_studio_style_presets', 'Style presets')}
      </h2>
      <div className="text-[12px] text-textItemBlur">
        {`${kindLabel(t, kind)} · ${t(
          'content_studio_style_presets_hint',
          'Applying copies the style into this layer; it does not stay linked.'
        )}`}
      </div>
      <div className="flex flex-wrap gap-[6px]">
        <Button secondary disabled={disabled} onClick={saveStyle}>
          {t('content_studio_style_preset_save_title', 'Save style as preset')}
        </Button>
        <Button
          secondary
          onClick={() =>
            modals.openModal({
              title: t(
                'content_studio_style_presets_archived',
                'Archived style presets'
              ),
              children: () => (
                <ArchivedStylePresets kind={kind} brand={brand} />
              ),
            })
          }
        >
          {t('content_studio_style_presets_archived', 'Archived style presets')}
        </Button>
      </div>
      {list.error ? (
        <div role="status">
          {t(
            'content_studio_style_presets_load_error',
            'Style presets could not be loaded.'
          )}
        </div>
      ) : !list.data ? (
        <LoadingComponent width={40} height={40} />
      ) : (
        <>
          <h3 className="text-[13px] font-[600]">
            {t('content_studio_style_presets_built_in', 'Built-in')}
          </h3>
          {rows(
            list.data.system.filter((preset) => preset.kind === kind),
            `${t(
              'content_studio_style_presets_built_in',
              'Built-in'
            )} · ${kindLabel(t, kind)}`
          )}
          <h3 className="text-[13px] font-[600]">
            {t('content_studio_style_presets_organization', 'Organization')}
          </h3>
          {list.data.results.length ? (
            rows(
              list.data.results.filter(
                (preset) => preset.kind === kind && !preset.archivedAt
              ),
              `${t(
                'content_studio_style_presets_organization',
                'Organization'
              )} · ${kindLabel(t, kind)}`
            )
          ) : (
            <div className="text-[12px] text-textItemBlur">
              {t(
                'content_studio_style_presets_none',
                'No organization presets of this kind yet. Save a layer’s style to make one.'
              )}
            </div>
          )}
          {list.data.pages > 1 && (
            <ContentStudioPager
              page={page}
              pages={list.data.pages}
              setPage={setPage}
            />
          )}
        </>
      )}
    </section>
  );
};
