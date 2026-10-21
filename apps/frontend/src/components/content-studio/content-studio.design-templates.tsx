'use client';

import {
  FC,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import {
  ContentStudioDesignDocumentV1,
  DESIGN_TEXT_MAX,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignTemplateSlot,
  ContentStudioDesignTemplateValue,
} from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance';
import {
  ContentStudioDesignMediaRef,
  DESIGN_CANVAS_PRESETS,
  DESIGN_NAME_MAX,
  designErrorCode,
  designFromPackageErrorMessage,
  newContentStudioDesignDocument,
  useContentStudioBrandKitRevisions,
  useContentStudioDesignActions,
} from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import {
  ContentStudioDesignTemplateBrand,
  ContentStudioDesignTemplateCard,
  ContentStudioDesignTemplateChoice,
  ContentStudioOrganizationDesignTemplate,
  DESIGN_TEMPLATE_DESCRIPTION_MAX,
  designTemplateErrorMessage,
  designTemplateGuidance,
  useContentStudioDesignTemplateActions,
  useContentStudioDesignTemplateBrands,
  useContentStudioDesignTemplates,
} from '@gitroom/frontend/components/content-studio/content-studio.design-templates.api';
import { DesignMediaPicker } from '@gitroom/frontend/components/content-studio/content-studio.design.editing';
import {
  DESIGN_LIBRARY_PATH,
  designPagePath,
} from '@gitroom/frontend/components/content-studio/content-studio.designs';
import { ContentStudioDesignPageThumbnail } from '@gitroom/frontend/components/content-studio/content-studio.design.preview';

export const TEMPLATE_LIBRARY_PATH = '/content-studio/templates';
export const templatePagePath = (id: string) =>
  `${TEMPLATE_LIBRARY_PATH}/${encodeURIComponent(id)}`;

// The checks the API makes too: trimmed, within the length, no NUL
const validText = (value: string, max: number, required: boolean) => {
  const trimmed = value.trim();
  return (
    (!required || !!trimmed) && trimmed.length <= max && !trimmed.includes('\0')
  );
};

const FIELD =
  'bg-newBgColorInner min-h-[80px] p-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0';

// The name of a template, or of a design, and an optional description
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
    maxLength={DESIGN_NAME_MAX}
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
      {t('content_studio_template_description', 'Description')}
      <textarea
        className={FIELD}
        value={value}
        maxLength={DESIGN_TEMPLATE_DESCRIPTION_MAX}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
};

// The document of a template revision, or null when it does not parse
const parseTemplateDocument = (content: unknown) => {
  try {
    return parseContentStudioDesignDocument(content);
  } catch {
    return null;
  }
};

// The text of a field's layer in the template document: where its field
// starts
const slotLayerText = (
  document: ContentStudioDesignDocumentV1,
  slot: ContentStudioDesignTemplateSlot
) => {
  const layer = document.pages
    .find((page) => page.id === slot.pageId)
    ?.layers.find((entry) => entry.id === slot.layerId);
  return layer?.type === 'text' ? layer.text : '';
};

// One field of a guided use: its label, its description and, while it is
// missing a required value, why; all tied to the control
const GuidedField: FC<{
  slot: ContentStudioDesignTemplateSlot;
  missing: boolean;
  children: (describedBy: string | undefined) => ReactNode;
}> = ({ slot, missing, children }) => {
  const t = useT();
  const id = `template-field-${slot.id}`;
  const describedBy =
    [
      slot.description ? `${id}-description` : null,
      missing ? `${id}-error` : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div
      className="flex flex-col gap-[6px] min-w-0"
      data-template-field={slot.type}
    >
      {children(describedBy)}
      {!!slot.description && (
        <div id={`${id}-description`} className="text-[12px] text-textItemBlur">
          {slot.description}
        </div>
      )}
      {missing && (
        <div id={`${id}-error`} className="text-[12px] text-red-400">
          {slot.type === 'image'
            ? t(
                'content_studio_template_field_image_required',
                'Choose an image for this required field.'
              )
            : t(
                'content_studio_template_field_text_required',
                'This field is required.'
              )}
        </div>
      )}
    </div>
  );
};

// The organization's Brand Kit revisions, to use one exact revision instead
// of the template's: nothing follows the latest revision
const TemplateBrandChoice: FC<{
  pinnedRevisionId: string;
  value: string | null;
  onChange: (revisionId: string) => void;
}> = ({ pinnedRevisionId, value, onChange }) => {
  const t = useT();
  const [page, setPage] = useState(1);
  const revisions = useContentStudioBrandKitRevisions(true, page);
  return (
    <fieldset className="flex flex-col gap-[6px]">
      <legend className="text-[13px] mb-[4px]">
        {t(
          'content_studio_template_brand_revision',
          'Brand Kit revision for the new design'
        )}
      </legend>
      {revisions.error ? (
        <div role="alert">
          {t(
            'content_studio_design_brand_list_error',
            'Brand Kit revisions could not be loaded.'
          )}
        </div>
      ) : !revisions.data ? (
        <LoadingComponent width={40} height={40} />
      ) : (
        revisions.data.results.map((revision) => (
          <label
            key={revision.id}
            className="flex items-center gap-[8px] border border-newTableBorder rounded-[8px] px-[12px] py-[8px] cursor-pointer"
          >
            <input
              type="radio"
              name="template-brand-revision"
              value={revision.id}
              checked={value === revision.id}
              onChange={() => onChange(revision.id)}
            />
            <span className="flex-1">
              {`${t('content_studio_design_revision', 'Revision')} ${
                revision.revisionNumber
              }`}
            </span>
            {revision.id === pinnedRevisionId && (
              <span className="text-[11px] px-[8px] rounded-full border border-newTableBorder">
                {t('content_studio_template_brand_current', 'Template')}
              </span>
            )}
          </label>
        ))
      )}
      {!!revisions.data && revisions.data.pages > 1 && (
        <ContentStudioPager
          page={page}
          pages={revisions.data.pages}
          setPage={setPage}
        />
      )}
    </fieldset>
  );
};

// A design from a saved package revision (P6-01): the version, the thread
// item as the server returned it with that version, and how the caller
// shows one of its Media (this library shows none itself). Shown only: the
// server reads the text and the Media again
export interface ContentStudioTemplatePackageSource {
  packageId: string;
  revisionId: string;
  revisionNumber: number;
  item: { id: string; text: string; mediaIds: string[] };
  mediaTile: (mediaId: string) => ReactNode;
}

// The field a package's text goes into unless the person picks another:
// the first text field of several lines, else the first text field
export const defaultPackageTextSlotId = (
  slots: ContentStudioDesignTemplateSlot[]
) => {
  const texts = slots.filter((slot) => slot.type === 'text');
  return (
    texts.find((slot) => slot.type === 'text' && slot.multiline)?.id ??
    texts[0]?.id ??
    null
  );
};

const PACKAGE_SOURCE_ERRORS = [
  'CS_STORED_REVISION_INVALID',
  'CS_DESIGN_SOURCE_ITEM_NOT_FOUND',
  'CS_DESIGN_SOURCE_SLOT_INVALID',
  'CS_DESIGN_SOURCE_MEDIA_INVALID',
  'CS_DESIGN_MEDIA_UNAVAILABLE',
];

// A new design from exactly the chosen template revision: its name and,
// when the revision has guidance, its fields in their order. A text field
// starts with the template's own text; an image field keeps the template's
// image until another is chosen from Media (referenced by the server); and
// where the template allows it, another exact Brand Kit revision may be
// chosen. Only the identities, the name, the values of the revision's own
// fields and the chosen Brand Kit revision id are sent; the server copies
// and fills the template's document. It opens once it exists.
// With a package source (P6-01) the item's text goes into the text field
// chosen for it, exactly as saved and not editable here, and one Media of
// the item may go into an image field; the other fields are filled as
// above. Only ids are sent for both; another Brand Kit revision is not
// offered
export const UseTemplateForm: FC<{
  choice: ContentStudioDesignTemplateChoice;
  defaultName: string;
  close: () => void;
  content?: unknown;
  guidance?: unknown;
  packageSource?: ContentStudioTemplatePackageSource;
}> = ({
  choice,
  defaultName,
  close,
  content,
  guidance: rawGuidance,
  packageSource,
}) => {
  const t = useT();
  const toaster = useToaster();
  const router = useRouter();
  const modals = useModals();
  const { instantiateTemplate } = useContentStudioDesignTemplateActions();
  const { createDesignFromPackageRevision } = useContentStudioDesignActions();
  const [name, setName] = useState(defaultName);
  const { busy, run } = useSingleFlight();
  const document = useMemo(() => parseTemplateDocument(content), [content]);
  const guidance = useMemo(
    () =>
      document
        ? designTemplateGuidance(document, rawGuidance ?? null)
        : rawGuidance === null || rawGuidance === undefined
        ? null
        : 'invalid',
    [document, rawGuidance]
  );
  const slots = guidance && guidance !== 'invalid' ? guidance.slots : [];
  const rebinding =
    !packageSource &&
    !!guidance &&
    guidance !== 'invalid' &&
    guidance.brandRebinding &&
    !!document?.brandKit;
  // the field the package text goes into, and the package image chosen for
  // an image field
  const [packageSlotId, setPackageSlotId] = useState<string | null>(() =>
    packageSource ? defaultPackageTextSlotId(slots) : null
  );
  const [packageImage, setPackageImage] = useState<{
    slotId: string;
    mediaId: string;
  } | null>(null);
  const guided = !!slots.length || rebinding;
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    document
      ? Object.fromEntries(
          slots
            .filter((slot) => slot.type === 'text')
            .map((slot) => [slot.id, slotLayerText(document, slot)])
        )
      : {}
  );
  const [images, setImages] = useState<
    Record<string, ContentStudioDesignMediaRef>
  >({});
  const [rebind, setRebind] = useState(false);
  const [brandRevisionId, setBrandRevisionId] = useState<string | null>(null);
  const missing = (slot: ContentStudioDesignTemplateSlot) =>
    slot.required &&
    (slot.type === 'text'
      ? !(
          (packageSource && slot.id === packageSlotId
            ? packageSource.item.text
            : texts[slot.id]) ?? ''
        ).trim()
      : !images[slot.id] && packageImage?.slotId !== slot.id);
  const valid =
    validText(name, DESIGN_NAME_MAX, true) &&
    guidance !== 'invalid' &&
    !slots.some(missing) &&
    (!rebind || !!brandRevisionId);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!valid) {
        return;
      }
      // the revision's own fields only, in its order: every text field and
      // each chosen image (never the ones the package fills)
      const values: Record<string, ContentStudioDesignTemplateValue> = {};
      for (const slot of slots) {
        if (
          packageSource &&
          (slot.id === packageSlotId || slot.id === packageImage?.slotId)
        ) {
          continue;
        }
        if (slot.type === 'text') {
          values[slot.id] = texts[slot.id] ?? '';
        } else if (images[slot.id]) {
          values[slot.id] = {
            mediaId: images[slot.id].mediaId,
            sha256: images[slot.id].sha256,
          };
        }
      }
      if (packageSource) {
        await run('use', async () => {
          try {
            const created = await createDesignFromPackageRevision(
              packageSource.packageId,
              packageSource.revisionId,
              {
                name: name.trim(),
                itemId: packageSource.item.id,
                start: {
                  templateSource: choice.source,
                  templateId: choice.templateId,
                  ...(choice.source === 'system'
                    ? { templateRevisionNumber: choice.revisionNumber }
                    : { templateRevisionId: choice.revisionId }),
                  ...(packageSlotId ? { textSlotId: packageSlotId } : {}),
                  values,
                  ...(packageImage
                    ? {
                        mediaId: packageImage.mediaId,
                        imageSlotId: packageImage.slotId,
                      }
                    : {}),
                },
              }
            );
            toaster.show(
              t('content_studio_design_created', 'Design created.'),
              'success'
            );
            // the history and this form: the new design opens instead
            modals.closeAll();
            router.push(designPagePath(created.id));
          } catch (err) {
            const code = designErrorCode(err);
            toaster.show(
              PACKAGE_SOURCE_ERRORS.includes(String(code))
                ? designFromPackageErrorMessage(t, err)
                : designTemplateErrorMessage(t, err),
              'warning'
            );
          }
        });
        return;
      }
      await run('use', async () => {
        try {
          const created = await instantiateTemplate(
            choice,
            name.trim(),
            guided
              ? {
                  values,
                  ...(rebind && brandRevisionId
                    ? { brandKitRevisionId: brandRevisionId }
                    : {}),
                }
              : undefined
          );
          toaster.show(
            t('content_studio_design_created', 'Design created.'),
            'success'
          );
          close();
          router.push(designPagePath(created.id));
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      });
    },
    [
      valid,
      slots,
      texts,
      images,
      run,
      instantiateTemplate,
      createDesignFromPackageRevision,
      packageSource,
      packageSlotId,
      packageImage,
      modals,
      choice,
      name,
      guided,
      rebind,
      brandRevisionId,
      toaster,
      close,
      router,
      t,
    ]
  );

  const chooseImage = (slot: ContentStudioDesignTemplateSlot) =>
    modals.openModal({
      title: t('content_studio_design_choose_image', 'Choose image'),
      children: (closePicker: () => void) => (
        <DesignMediaPicker
          close={closePicker}
          onPicked={(ref) => {
            setImages((current) => ({ ...current, [slot.id]: ref }));
            setPackageImage((current) =>
              current?.slotId === slot.id ? null : current
            );
          }}
        />
      ),
    });

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <NameField
        label={t('content_studio_template_design_name', 'Design name')}
        value={name}
        onChange={setName}
      />
      {guidance === 'invalid' && (
        <div role="alert">
          {t(
            'content_studio_template_error_integrity',
            'Stored template data could not be read safely.'
          )}
        </div>
      )}
      {!!packageSource &&
        guidance !== 'invalid' &&
        (packageSlotId ? (
          slots.filter((slot) => slot.type === 'text').length > 1 && (
            <fieldset className="flex flex-col gap-[6px] min-w-0">
              <legend className="text-[14px] mb-[6px]">
                {`${t(
                  'content_studio_template_package_text_field',
                  'Field for the text of version'
                )} ${packageSource.revisionNumber}`}
              </legend>
              {slots
                .filter((slot) => slot.type === 'text')
                .map((slot) => (
                  <label
                    key={slot.id}
                    className="flex items-center gap-[8px] cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="package-text-field"
                      value={slot.id}
                      checked={packageSlotId === slot.id}
                      onChange={() => setPackageSlotId(slot.id)}
                    />
                    {slot.label}
                  </label>
                ))}
            </fieldset>
          )
        ) : (
          <div className="text-[13px] text-textItemBlur">
            {t(
              'content_studio_template_package_text_layer',
              'This template has no text field: the text is added as a text layer on the first page, exactly as saved.'
            )}
          </div>
        ))}
      {!!slots.length && (
        <fieldset className="flex flex-col gap-[12px] min-w-0">
          <legend className="text-[14px] font-[600] mb-[6px]">
            {t('content_studio_template_fields', 'Template fields')}
          </legend>
          {slots.map((slot) => (
            <GuidedField key={slot.id} slot={slot} missing={missing(slot)}>
              {(describedBy) =>
                packageSource && slot.id === packageSlotId ? (
                  <div
                    role="group"
                    aria-label={slot.label}
                    aria-describedby={describedBy}
                    className="flex flex-col gap-[6px] text-[14px] min-w-0"
                  >
                    <span>
                      {slot.label}
                      {` · ${t(
                        'content_studio_template_package_text_from',
                        'From version'
                      )} ${packageSource.revisionNumber}`}
                    </span>
                    <div
                      data-package-text
                      className="whitespace-pre-wrap break-words max-h-[160px] overflow-y-auto border border-newTableBorder rounded-[8px] p-[10px] text-[13px]"
                    >
                      {packageSource.item.text}
                    </div>
                  </div>
                ) : slot.type === 'text' ? (
                  <label className="flex flex-col gap-[6px] text-[14px]">
                    <span>
                      {slot.label}
                      {slot.required &&
                        ` (${t(
                          'content_studio_template_required',
                          'required'
                        )})`}
                    </span>
                    {slot.multiline ? (
                      <textarea
                        className={FIELD}
                        value={texts[slot.id] ?? ''}
                        maxLength={DESIGN_TEXT_MAX}
                        required={slot.required}
                        aria-required={slot.required}
                        aria-invalid={missing(slot)}
                        aria-describedby={describedBy}
                        onChange={(e) =>
                          setTexts((current) => ({
                            ...current,
                            [slot.id]: e.target.value,
                          }))
                        }
                      />
                    ) : (
                      <input
                        type="text"
                        className="bg-newBgColorInner h-[42px] px-[12px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0"
                        value={texts[slot.id] ?? ''}
                        maxLength={DESIGN_TEXT_MAX}
                        required={slot.required}
                        aria-required={slot.required}
                        aria-invalid={missing(slot)}
                        aria-describedby={describedBy}
                        onChange={(e) =>
                          setTexts((current) => ({
                            ...current,
                            [slot.id]: e.target.value,
                          }))
                        }
                      />
                    )}
                  </label>
                ) : (
                  <div
                    role="group"
                    aria-label={slot.label}
                    aria-describedby={describedBy}
                    className="flex flex-col gap-[6px] text-[14px]"
                  >
                    <span>
                      {slot.label}
                      {slot.required &&
                        ` (${t(
                          'content_studio_template_required',
                          'required'
                        )})`}
                    </span>
                    <span className="text-[13px] text-textItemBlur">
                      {packageImage?.slotId === slot.id
                        ? t(
                            'content_studio_template_package_image_chosen',
                            'An image of the package is chosen.'
                          )
                        : images[slot.id]
                        ? t(
                            'content_studio_template_image_chosen',
                            'A new image is chosen.'
                          )
                        : t(
                            'content_studio_template_image_kept',
                            'The template image is used.'
                          )}
                    </span>
                    {!!packageSource?.item.mediaIds.length && (
                      <div className="flex flex-wrap gap-[8px]">
                        {packageSource.item.mediaIds.map((mediaId, index) => (
                          <button
                            key={mediaId}
                            type="button"
                            aria-pressed={
                              packageImage?.slotId === slot.id &&
                              packageImage.mediaId === mediaId
                            }
                            aria-label={`${t(
                              'content_studio_template_package_image',
                              'Use package image'
                            )} ${index + 1}: ${slot.label}`}
                            className={clsx(
                              'rounded-[8px] border-[2px]',
                              packageImage?.slotId === slot.id &&
                                packageImage.mediaId === mediaId
                                ? 'border-[var(--brand-primary,#612ad5)]'
                                : 'border-transparent'
                            )}
                            onClick={() => {
                              setPackageImage({ slotId: slot.id, mediaId });
                              setImages((current) => {
                                const next = { ...current };
                                delete next[slot.id];
                                return next;
                              });
                            }}
                          >
                            {packageSource.mediaTile(mediaId)}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-[8px]">
                      <Button
                        type="button"
                        secondary
                        aria-label={`${t(
                          'content_studio_design_choose_image',
                          'Choose image'
                        )}: ${slot.label}`}
                        onClick={() => chooseImage(slot)}
                      >
                        {t(
                          'content_studio_design_choose_image',
                          'Choose image'
                        )}
                      </Button>
                      {(!!images[slot.id] ||
                        packageImage?.slotId === slot.id) && (
                        <Button
                          type="button"
                          secondary
                          aria-label={`${t(
                            'content_studio_template_image_reset',
                            'Use the template image'
                          )}: ${slot.label}`}
                          onClick={() => {
                            setImages((current) => {
                              const next = { ...current };
                              delete next[slot.id];
                              return next;
                            });
                            setPackageImage((current) =>
                              current?.slotId === slot.id ? null : current
                            );
                          }}
                        >
                          {t(
                            'content_studio_template_image_reset',
                            'Use the template image'
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                )
              }
            </GuidedField>
          ))}
        </fieldset>
      )}
      {rebinding && !!document?.brandKit && (
        <div className="flex flex-col gap-[8px]">
          <label className="flex items-center gap-[8px] text-[14px] cursor-pointer">
            <input
              type="checkbox"
              checked={rebind}
              onChange={(e) => {
                setRebind(e.target.checked);
                setBrandRevisionId(null);
              }}
            />
            {t(
              'content_studio_template_brand_rebind',
              'Use another Brand Kit revision'
            )}
          </label>
          <div className="text-[12px] text-textItemBlur">
            {rebind
              ? t(
                  'content_studio_template_brand_rebind_hint',
                  'The new design is pinned to the revision you choose. It must have every color and type style this template uses, or nothing is created.'
                )
              : `${t(
                  'content_studio_template_brand_kept',
                  'The new design keeps the template’s Brand Kit revision'
                )} ${document.brandKit.revisionNumber}.`}
          </div>
          {rebind && (
            <TemplateBrandChoice
              pinnedRevisionId={document.brandKit.revisionId}
              value={brandRevisionId}
              onChange={setBrandRevisionId}
            />
          )}
        </div>
      )}
      <div className="text-[13px] text-textItemBlur">
        {packageSource
          ? `${t(
              'content_studio_template_package_hint',
              'The new design starts as a copy of this template revision with the text of package version'
            )} ${packageSource.revisionNumber}. ${t(
              'content_studio_design_package_independent',
              'Later changes to the package or the design do not affect the other.'
            )}`
          : t(
              'content_studio_template_use_hint',
              'The new design starts as a copy of this template revision. Later changes to either one do not affect the other.'
            )}
      </div>
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !valid}>
          {t('content_studio_create_design', 'Create design')}
        </Button>
      </div>
    </form>
  );
};

// A new template from exactly one saved revision of a design: the server
// reads that revision, nothing unsaved goes with it. It opens once it exists
export const SaveAsTemplateForm: FC<{
  designId: string;
  revisionId: string;
  revisionNumber: number;
  defaultName: string;
  close: () => void;
}> = ({ designId, revisionId, revisionNumber, defaultName, close }) => {
  const t = useT();
  const toaster = useToaster();
  const router = useRouter();
  const { saveDesignAsTemplate } = useContentStudioDesignTemplateActions();
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const { busy, run } = useSingleFlight();
  const valid =
    validText(name, DESIGN_NAME_MAX, true) &&
    validText(description, DESIGN_TEMPLATE_DESCRIPTION_MAX, false);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!valid) {
        return;
      }
      await run('save', async () => {
        try {
          const created = await saveDesignAsTemplate(designId, revisionId, {
            name: name.trim(),
            description: description.trim(),
          });
          toaster.show(
            t('content_studio_template_created', 'Template created.'),
            'success'
          );
          close();
          router.push(templatePagePath(created.id));
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      });
    },
    [
      valid,
      run,
      saveDesignAsTemplate,
      designId,
      revisionId,
      name,
      description,
      toaster,
      close,
      router,
      t,
    ]
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <div className="text-[13px] text-textItemBlur">
        {`${t(
          'content_studio_template_from_revision',
          'The template is made from saved revision'
        )} ${revisionNumber}.`}
      </div>
      <NameField
        label={t('content_studio_template_name', 'Template name')}
        value={name}
        onChange={setName}
      />
      <DescriptionField value={description} onChange={setDescription} />
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !valid}>
          {t('content_studio_save_as_template', 'Save as template')}
        </Button>
      </div>
    </form>
  );
};

// A new organization template: one empty white page of a fixed size, like a
// new design. It opens once it exists
const NewTemplateForm: FC<{ close: () => void }> = ({ close }) => {
  const t = useT();
  const toaster = useToaster();
  const router = useRouter();
  const { createTemplate } = useContentStudioDesignTemplateActions();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [presetId, setPresetId] = useState<string>(DESIGN_CANVAS_PRESETS[0].id);
  const { busy, run } = useSingleFlight();
  const valid =
    validText(name, DESIGN_NAME_MAX, true) &&
    validText(description, DESIGN_TEMPLATE_DESCRIPTION_MAX, false);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const preset = DESIGN_CANVAS_PRESETS.find((p) => p.id === presetId);
      if (!valid || !preset) {
        return;
      }
      await run('create', async () => {
        try {
          const created = await createTemplate({
            name: name.trim(),
            description: description.trim(),
            content: newContentStudioDesignDocument(preset),
          });
          toaster.show(
            t('content_studio_template_created', 'Template created.'),
            'success'
          );
          close();
          router.push(templatePagePath(created.id));
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      });
    },
    [
      valid,
      presetId,
      run,
      createTemplate,
      name,
      description,
      toaster,
      close,
      router,
      t,
    ]
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <NameField
        label={t('content_studio_template_name', 'Template name')}
        value={name}
        onChange={setName}
      />
      <DescriptionField value={description} onChange={setDescription} />
      <fieldset className="flex flex-col gap-[8px]">
        <legend className="text-[14px] mb-[6px]">
          {t('content_studio_design_canvas', 'Canvas size')}
        </legend>
        {DESIGN_CANVAS_PRESETS.map((preset) => (
          <label
            key={preset.id}
            className="flex items-center gap-[8px] cursor-pointer"
          >
            <input
              type="radio"
              name="preset"
              value={preset.id}
              checked={presetId === preset.id}
              onChange={() => setPresetId(preset.id)}
            />
            <span>
              {t(`content_studio_design_preset_${preset.id}`, preset.label)}{' '}
              <span className="text-textItemBlur">
                {preset.width} × {preset.height}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !valid}>
          {t('content_studio_create_template', 'Create template')}
        </Button>
      </div>
    </form>
  );
};

// The name and the description: no revision is made
export const TemplateDetailsForm: FC<{
  template: ContentStudioOrganizationDesignTemplate;
  close: () => void;
}> = ({ template, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { updateTemplate } = useContentStudioDesignTemplateActions();
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? '');
  const { busy, run } = useSingleFlight();
  const changed =
    validText(name, DESIGN_NAME_MAX, true) &&
    validText(description, DESIGN_TEMPLATE_DESCRIPTION_MAX, false) &&
    (name.trim() !== template.name ||
      description.trim() !== (template.description ?? ''));

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!changed) {
        return;
      }
      await run('details', async () => {
        try {
          await updateTemplate(template.id, {
            name: name.trim(),
            description: description.trim(),
          });
          toaster.show(
            t('content_studio_template_updated', 'Template updated.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      });
    },
    [
      changed,
      run,
      updateTemplate,
      template,
      name,
      description,
      toaster,
      close,
      t,
    ]
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <NameField
        label={t('content_studio_template_name', 'Template name')}
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

export type TemplateTask = 'archive' | 'restore';

// Archive and Restore of the organization's templates, one at a time per
// template; built-in templates have neither. Nothing is ever deleted
export const useTemplateCommands = () => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioDesignTemplateActions();
  const running = useRef(new Set<string>());
  const [busy, setBusy] = useState<Record<string, TemplateTask>>({});

  const run = useCallback(
    async (id: string, task: TemplateTask, work: () => Promise<void>) => {
      if (running.current.has(id)) {
        return;
      }
      running.current.add(id);
      setBusy((current) => ({ ...current, [id]: task }));
      try {
        await work();
      } finally {
        running.current.delete(id);
        setBusy((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    },
    []
  );

  const archive = useCallback(
    async (template: ContentStudioOrganizationDesignTemplate) => {
      if (
        !(await deleteDialog(
          t(
            'content_studio_template_archive_hint',
            'It will no longer be offered for new designs. Its revisions and the designs made from it stay as they are.'
          ),
          t('content_studio_archive', 'Archive'),
          t('content_studio_template_archive_title', 'Archive this template?'),
          t('cancel', 'Cancel')
        ))
      ) {
        return;
      }
      await run(template.id, 'archive', async () => {
        try {
          await actions.archiveTemplate(template.id);
          toaster.show(
            t('content_studio_template_archived', 'Template archived.'),
            'success'
          );
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      });
    },
    [run, actions, toaster, t]
  );

  const restore = useCallback(
    (template: ContentStudioOrganizationDesignTemplate) =>
      run(template.id, 'restore', async () => {
        try {
          await actions.restoreTemplate(template.id);
          toaster.show(
            t('content_studio_template_restored', 'Template restored.'),
            'success'
          );
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      }),
    [run, actions, toaster, t]
  );

  return { busy, archive, restore };
};

// The first page of a template's current document, drawn by the structural
// preview: shapes, text and image placeholders only. Brand Kit tokens are
// resolved from the exact revision the document names, loaded once for all
// the cards that name it (P4-12); until it is loaded, or when it cannot be,
// they show as unresolved, like any token the preview cannot resolve
const TemplateThumbnail: FC<{
  document: ContentStudioDesignDocumentV1 | null;
  brand: ContentStudioDesignTemplateBrand | null;
}> = ({ document, brand }) =>
  document ? (
    <ContentStudioDesignPageThumbnail
      page={document.pages[0]}
      brand={brand?.content ?? null}
    />
  ) : null;

// One template card: a heading and plain actions side by side (never a
// control inside another)
const TemplateCard: FC<{
  template: ContentStudioDesignTemplateCard;
  document: ContentStudioDesignDocumentV1 | null;
  brand: ContentStudioDesignTemplateBrand | null;
  busy?: TemplateTask;
  commands: ReturnType<typeof useTemplateCommands>;
}> = ({ template, document, brand, busy, commands }) => {
  const t = useT();
  const modals = useModals();
  const system = template.source === 'system';
  const archived = !system && !!template.archivedAt;
  const guidance = document
    ? designTemplateGuidance(document, template.currentRevision.guidance)
    : null;
  const fields = guidance && guidance !== 'invalid' ? guidance.slots.length : 0;
  const use = () =>
    modals.openModal({
      title: t('content_studio_use_template', 'Use template'),
      children: (close: () => void) => (
        <UseTemplateForm
          choice={
            template.source === 'system'
              ? {
                  source: 'system',
                  templateId: template.id,
                  revisionNumber: template.currentRevision.revisionNumber,
                }
              : {
                  source: 'organization',
                  templateId: template.id,
                  revisionId: template.currentRevision.id,
                }
          }
          defaultName={template.name}
          close={close}
          content={template.currentRevision.content}
          guidance={template.currentRevision.guidance}
        />
      ),
    });
  return (
    <li
      data-template={template.source}
      className="flex flex-col gap-[10px] p-[16px] border border-newTableBorder rounded-[8px] min-w-0"
    >
      <TemplateThumbnail document={document} brand={brand} />
      <div className="flex flex-col gap-[4px] min-w-0">
        <h3 className="text-[16px] font-[600] break-words">{template.name}</h3>
        <div className="flex flex-wrap gap-x-[12px] gap-y-[4px] text-[12px] text-textItemBlur">
          <span className="px-[8px] rounded-full border border-newTableBorder">
            {system
              ? t('content_studio_template_built_in', 'Built-in')
              : t('content_studio_template_organization', 'Organization')}
          </span>
          {archived && (
            <span className="px-[8px] rounded-full border border-newTableBorder">
              {t('content_studio_archived', 'Archived')}
            </span>
          )}
          <span>
            {t('content_studio_design_revision', 'Revision')}{' '}
            {template.latestRevisionNumber}
          </span>
          {!!fields && (
            <span>
              {fields}{' '}
              {fields === 1
                ? t('content_studio_template_field_count_one', 'field')
                : t('content_studio_template_field_count', 'fields')}
            </span>
          )}
          {brand?.status === 'error' && (
            <span>
              {t(
                'content_studio_template_brand_unavailable',
                'Brand Kit revision unavailable'
              )}
            </span>
          )}
        </div>
        {!!template.description && (
          <div className="text-[13px] break-words">{template.description}</div>
        )}
      </div>
      <div className="flex flex-wrap gap-[8px]">
        {!archived && (
          <Button
            aria-label={`${t('content_studio_use_template', 'Use template')} ${
              template.name
            }`}
            onClick={use}
          >
            {t('content_studio_use_template', 'Use template')}
          </Button>
        )}
        {template.source === 'organization' && (
          <>
            <Link
              href={templatePagePath(template.id)}
              aria-label={`${t('content_studio_open', 'Open')} ${
                template.name
              }`}
              className="h-[40px] px-[24px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
            >
              {t('content_studio_open', 'Open')}
            </Link>
            {archived ? (
              <Button
                secondary
                loading={busy === 'restore'}
                disabled={!!busy}
                aria-label={`${t('content_studio_restore', 'Restore')} ${
                  template.name
                }`}
                onClick={() => commands.restore(template)}
              >
                {t('content_studio_restore', 'Restore')}
              </Button>
            ) : (
              <>
                <Button
                  secondary
                  disabled={!!busy}
                  aria-label={`${t(
                    'content_studio_template_edit_details',
                    'Edit details'
                  )} ${template.name}`}
                  onClick={() =>
                    modals.openModal({
                      title: t(
                        'content_studio_template_edit_details',
                        'Edit details'
                      ),
                      children: (close: () => void) => (
                        <TemplateDetailsForm
                          template={template}
                          close={close}
                        />
                      ),
                    })
                  }
                >
                  {t('content_studio_template_edit_details', 'Edit details')}
                </Button>
                <Button
                  secondary
                  loading={busy === 'archive'}
                  disabled={!!busy}
                  aria-label={`${t('content_studio_archive', 'Archive')} ${
                    template.name
                  }`}
                  onClick={() => commands.archive(template)}
                >
                  {t('content_studio_archive', 'Archive')}
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </li>
  );
};

const GRID =
  'grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-[12px] min-w-0';

// Templates: the built-in ones and the organization's, active or archived.
// Each card shows the first page of the current document, drawn by the
// structural preview; nothing is rendered or fetched per card (the exact
// Brand Kit revisions the documents name are loaded once per revision)
export const ContentStudioDesignTemplates: FC = () => {
  const t = useT();
  const modals = useModals();
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const list = useContentStudioDesignTemplates(archived, page);
  const commands = useTemplateCommands();
  // every card's document parsed once; its Brand Kit revisions loaded once
  // each, for all the cards that name them
  const documents = useMemo(
    () =>
      new Map(
        [...(list.data?.system ?? []), ...(list.data?.results ?? [])].map(
          (template) => [
            `${template.source}:${template.id}`,
            parseTemplateDocument(template.currentRevision.content),
          ]
        )
      ),
    [list.data]
  );
  const refs = useMemo(
    () =>
      Array.from(documents.values()).map((entry) => entry?.brandKit ?? null),
    [documents]
  );
  const brandOf = useContentStudioDesignTemplateBrands(refs);
  const cardOf = (template: ContentStudioDesignTemplateCard) => {
    const document = documents.get(`${template.source}:${template.id}`) ?? null;
    return { document, brand: brandOf(document?.brandKit ?? null) };
  };

  const pages = list.data?.pages;
  // a page that no longer exists (after archiving, say) moves to the last one
  useEffect(() => {
    if (pages !== undefined && page > Math.max(pages, 1)) {
      setPage(Math.max(pages, 1));
    }
  }, [pages, page]);

  const newTemplate = useCallback(
    () =>
      modals.openModal({
        title: t('content_studio_create_template', 'Create template'),
        children: (close: () => void) => <NewTemplateForm close={close} />,
      }),
    [modals, t]
  );

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[16px] min-w-0">
      <div className="flex flex-wrap items-center gap-[12px]">
        <div className="flex flex-col gap-[4px] flex-1 min-w-[200px]">
          <h1 className="text-[20px] font-[600]">
            {t('content_studio_templates', 'Templates')}
          </h1>
          <div className="text-textItemBlur">
            {t(
              'content_studio_templates_subtitle',
              'Start new designs from built-in or saved templates.'
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-[8px]">
          <Link
            href={DESIGN_LIBRARY_PATH}
            className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
          >
            {t('content_studio_creative_studio', 'Creative Studio')}
          </Link>
          <Button onClick={newTemplate}>
            {t('content_studio_create_template', 'Create template')}
          </Button>
        </div>
      </div>

      <div
        role="group"
        aria-label={t('content_studio_status', 'Status')}
        className="flex gap-[8px]"
      >
        {[false, true].map((value) => (
          <Button
            key={String(value)}
            secondary={archived !== value}
            aria-pressed={archived === value}
            className={clsx(archived === value && 'font-[600]')}
            onClick={() => {
              if (archived !== value) {
                setArchived(value);
                setPage(1);
              }
            }}
          >
            {value
              ? t('content_studio_archived', 'Archived')
              : t('content_studio_active', 'Active')}
          </Button>
        ))}
      </div>

      {list.error ? (
        <div className="flex flex-col items-center gap-[12px] py-[40px]">
          <div>
            {t(
              'content_studio_templates_load_error',
              'Templates could not be loaded.'
            )}
          </div>
          <Button secondary onClick={() => list.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        </div>
      ) : !list.data ? (
        <LoadingComponent />
      ) : (
        <>
          {!archived && (
            <section className="flex flex-col gap-[8px]">
              <h2 className="font-[600]">
                {t('content_studio_templates_built_in', 'Built-in templates')}
              </h2>
              <ul
                aria-label={t(
                  'content_studio_templates_built_in',
                  'Built-in templates'
                )}
                className={GRID}
              >
                {list.data.system.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    {...cardOf(template)}
                    commands={commands}
                  />
                ))}
              </ul>
            </section>
          )}
          <section className="flex flex-col gap-[8px]">
            <h2 className="font-[600]">
              {archived
                ? t(
                    'content_studio_templates_archived',
                    'Archived organization templates'
                  )
                : t(
                    'content_studio_templates_organization',
                    'Organization templates'
                  )}
            </h2>
            {!list.data.results.length ? (
              <div className="text-textItemBlur">
                {archived
                  ? t(
                      'content_studio_no_archived_templates',
                      'No archived templates.'
                    )
                  : t(
                      'content_studio_no_templates',
                      'No organization templates yet. Create one, or save a design as a template.'
                    )}
              </div>
            ) : (
              <ul
                aria-label={
                  archived
                    ? t(
                        'content_studio_templates_archived',
                        'Archived organization templates'
                      )
                    : t(
                        'content_studio_templates_organization',
                        'Organization templates'
                      )
                }
                className={GRID}
              >
                {list.data.results.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    {...cardOf(template)}
                    busy={commands.busy[template.id]}
                    commands={commands}
                  />
                ))}
              </ul>
            )}
            {list.data.pages > 1 && (
              <ContentStudioPager
                page={page}
                pages={list.data.pages}
                setPage={setPage}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
};
