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
import type { ContentStudioDesignDocumentV1 } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignPageSetContentV1,
  DESIGN_PAGE_SET_DESCRIPTION_MAX,
  DESIGN_PAGE_SET_NAME_MAX,
  extractContentStudioDesignPageSet,
  parseContentStudioDesignPageSetContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';
import { addContentStudioDesignPageSet } from '@gitroom/frontend/components/content-studio/content-studio.design.editor';
import { ContentStudioDesignEditor } from '@gitroom/frontend/components/content-studio/content-studio.design.editing';
import {
  ContentStudioDesignPageSet,
  ContentStudioOrganizationDesignPageSet,
  designPageSetErrorMessage,
  useContentStudioDesignPageSetActions,
  useContentStudioDesignPageSets,
} from '@gitroom/frontend/components/content-studio/content-studio.design-page-sets.api';

// Page sets (P4-17): reusable page structures, the names and sizes of some
// pages in order (and a literal background where a page has one), never
// their content. A new design can start from one (the server makes its
// pages from the id), the editor adds one to a draft as blank pages after
// the last page (one undo step), and the page structure of a draft can be
// saved as a new page set. Each page set shows its pages as small DOM boxes
// of their proportions and as text; nothing is rendered or fetched

type Translate = (key: string, fallback: string) => string;

// The content, or null when it does not parse as Page Set v1
const parsePageSet = (content: unknown) => {
  try {
    return parseContentStudioDesignPageSetContent(content);
  } catch {
    return null;
  }
};

const pageCountText = (t: Translate, count: number) =>
  count === 1
    ? t('content_studio_page_set_one_page', '1 page')
    : `${count} ${t('content_studio_page_set_pages', 'pages')}`;

// The pages of a page set: a box of each page's proportions (decorative)
// and a line of text per page with its name and size
export const DesignPageSetPages: FC<{
  content: ContentStudioDesignPageSetContentV1;
}> = ({ content }) => {
  const t = useT();
  return (
    <div className="flex flex-col gap-[6px] min-w-0">
      <div aria-hidden="true" className="flex items-end gap-[4px]">
        {content.pages.map((page, index) => {
          const scale = 36 / Math.max(page.width, page.height);
          return (
            <span
              key={index}
              data-page-set-page=""
              className="block border border-newTableBorder rounded-[2px]"
              style={{
                width: Math.max(4, page.width * scale),
                height: Math.max(4, page.height * scale),
                backgroundColor: page.background?.color.value ?? '#ffffff',
              }}
            />
          );
        })}
      </div>
      <ul className="text-[12px] text-textItemBlur">
        {content.pages.map((page, index) => (
          <li key={index}>
            {`${
              page.name ||
              `${t('content_studio_design_page', 'Page')} ${index + 1}`
            } ${page.width} × ${page.height}`}
          </li>
        ))}
      </ul>
    </div>
  );
};

const sourceText = (t: Translate, pageSet: ContentStudioDesignPageSet) =>
  pageSet.source === 'organization'
    ? t('content_studio_page_set_organization', 'Organization')
    : t('content_studio_page_set_built_in', 'Built-in');

// The page sets a new design can start from: the built-in ones and the
// organization's active ones, one to choose. Only the id is passed on
export const DesignPageSetPicker: FC<{
  value: string | null;
  onChange: (id: string) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  const [page, setPage] = useState(1);
  const list = useContentStudioDesignPageSets(true, false, page);
  if (list.error) {
    return (
      <div role="status">
        {t(
          'content_studio_page_sets_load_error',
          'Page sets could not be loaded.'
        )}
      </div>
    );
  }
  if (!list.data) {
    return <LoadingComponent width={40} height={40} />;
  }
  const choices: ContentStudioDesignPageSet[] = [
    ...list.data.system,
    ...list.data.results.filter((pageSet) => !pageSet.archivedAt),
  ];
  return (
    <fieldset className="flex flex-col gap-[8px] min-w-0">
      <legend className="text-[14px] mb-[6px]">
        {t('content_studio_page_set', 'Page set')}
      </legend>
      {choices.map((pageSet) => {
        const content = parsePageSet(pageSet.content);
        return (
          <label
            key={`${pageSet.source}:${pageSet.id}`}
            data-page-set-choice={pageSet.source}
            className="flex items-start gap-[8px] cursor-pointer border border-newTableBorder rounded-[8px] px-[10px] py-[8px]"
          >
            <input
              type="radio"
              name="page-set"
              value={pageSet.id}
              disabled={!content}
              checked={value === pageSet.id}
              onChange={() => onChange(pageSet.id)}
            />
            <span className="flex flex-col gap-[4px] min-w-0">
              <span className="font-[600] break-words">{pageSet.name}</span>
              <span className="text-[12px] text-textItemBlur">
                {`${sourceText(t, pageSet)} · ${pageCountText(
                  t,
                  pageSet.pageCount
                )}`}
              </span>
              {content ? (
                <DesignPageSetPages content={content} />
              ) : (
                <span role="alert" className="text-[12px]">
                  {t(
                    'content_studio_page_set_error_integrity',
                    'Stored page set data could not be read safely.'
                  )}
                </span>
              )}
            </span>
          </label>
        );
      })}
      {list.data.pages > 1 && (
        <ContentStudioPager
          page={page}
          pages={list.data.pages}
          setPage={setPage}
        />
      )}
    </fieldset>
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
    maxLength={DESIGN_PAGE_SET_NAME_MAX}
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
      {t('content_studio_page_set_description', 'Description')}
      <textarea
        className="bg-newBgColorInner min-h-[64px] p-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0"
        value={value}
        maxLength={DESIGN_PAGE_SET_DESCRIPTION_MAX}
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

// A new page set from the page structure of the draft as it is now: names,
// sizes and literal backgrounds only, listed for a last look
const SavePageSetForm: FC<{
  content: ContentStudioDesignPageSetContentV1;
  close: () => void;
}> = ({ content, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { createPageSet } = useContentStudioDesignPageSetActions();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { busy, run } = useSingleFlight();
  const valid =
    validText(name, DESIGN_PAGE_SET_NAME_MAX, true) &&
    validText(description, DESIGN_PAGE_SET_DESCRIPTION_MAX, false);
  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!valid) {
        return;
      }
      await run('save', async () => {
        try {
          await createPageSet({
            name: name.trim(),
            description: description.trim(),
            content,
          });
          toaster.show(
            t('content_studio_page_set_saved', 'Page set saved.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(designPageSetErrorMessage(t, err), 'warning');
        }
      });
    },
    [valid, run, createPageSet, name, description, content, toaster, close, t]
  );
  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <div className="text-[13px] text-textItemBlur">
        {t(
          'content_studio_page_set_save_hint',
          'Only the page names, sizes and plain background colors are saved: no layers, images or Brand Kit. A design started from it gets blank pages.'
        )}
      </div>
      <DesignPageSetPages content={content} />
      <NameField
        label={t('content_studio_page_set_name', 'Page set name')}
        value={name}
        onChange={setName}
      />
      <DescriptionField value={description} onChange={setDescription} />
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !valid}>
          {t('content_studio_page_set_save', 'Save page set')}
        </Button>
      </div>
    </form>
  );
};

// The name and the description of an organization page set; its pages stay
// as they were saved (a new structure is a new page set)
const PageSetDetailsForm: FC<{
  pageSet: ContentStudioOrganizationDesignPageSet;
  close: () => void;
}> = ({ pageSet, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { updatePageSet } = useContentStudioDesignPageSetActions();
  const [name, setName] = useState(pageSet.name);
  const [description, setDescription] = useState(pageSet.description ?? '');
  const { busy, run } = useSingleFlight();
  const changed =
    validText(name, DESIGN_PAGE_SET_NAME_MAX, true) &&
    validText(description, DESIGN_PAGE_SET_DESCRIPTION_MAX, false) &&
    (name.trim() !== pageSet.name ||
      description.trim() !== (pageSet.description ?? ''));
  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!changed) {
        return;
      }
      await run('details', async () => {
        try {
          await updatePageSet(pageSet.id, {
            name: name.trim(),
            description: description.trim(),
          });
          toaster.show(
            t('content_studio_page_set_updated', 'Page set updated.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(designPageSetErrorMessage(t, err), 'warning');
        }
      });
    },
    [changed, run, updatePageSet, pageSet, name, description, toaster, close, t]
  );
  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <NameField
        label={t('content_studio_page_set_name', 'Page set name')}
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

// The organization's archived page sets, each restorable
const ArchivedPageSets: FC = () => {
  const t = useT();
  const toaster = useToaster();
  const { restorePageSet } = useContentStudioDesignPageSetActions();
  const [page, setPage] = useState(1);
  const list = useContentStudioDesignPageSets(true, true, page);
  const { busy, run } = useSingleFlight();
  if (list.error) {
    return (
      <div role="alert">
        {t(
          'content_studio_page_sets_load_error',
          'Page sets could not be loaded.'
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
            'content_studio_page_sets_none_archived',
            'No archived page sets.'
          )}
        </div>
      ) : (
        <ul
          aria-label={t(
            'content_studio_page_sets_archived',
            'Archived page sets'
          )}
          className="flex flex-col gap-[6px]"
        >
          {list.data.results.map((pageSet) => (
            <li
              key={pageSet.id}
              className="flex items-center gap-[8px] border border-newTableBorder rounded-[8px] px-[10px] py-[6px]"
            >
              <span className="flex-1 min-w-0 break-words">
                {`${pageSet.name} · ${pageCountText(t, pageSet.pageCount)}`}
              </span>
              <Button
                secondary
                loading={busy === pageSet.id}
                disabled={!!busy}
                aria-label={`${t('content_studio_restore', 'Restore')} ${
                  pageSet.name
                }`}
                onClick={() =>
                  run(pageSet.id, async () => {
                    try {
                      await restorePageSet(pageSet.id);
                      toaster.show(
                        t(
                          'content_studio_page_set_restored',
                          'Page set restored.'
                        ),
                        'success'
                      );
                    } catch (err) {
                      toaster.show(
                        designPageSetErrorMessage(t, err),
                        'warning'
                      );
                    }
                  })
                }
              >
                {t('content_studio_restore', 'Restore')}
              </Button>
            </li>
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
    </div>
  );
};

// One page set: its name, source and page count as text, its pages, and
// its actions
const PageSetRow: FC<{
  pageSet: ContentStudioDesignPageSet;
  disabled: boolean;
  onAdd: (content: ContentStudioDesignPageSetContentV1) => void;
}> = ({ pageSet, disabled, onAdd }) => {
  const t = useT();
  const toaster = useToaster();
  const modals = useModals();
  const { archivePageSet } = useContentStudioDesignPageSetActions();
  const { busy, run } = useSingleFlight();
  const content = parsePageSet(pageSet.content);
  const organization = pageSet.source === 'organization' ? pageSet : null;
  return (
    <li
      data-page-set={pageSet.source}
      className="flex flex-col gap-[6px] border border-newTableBorder rounded-[8px] px-[10px] py-[8px] min-w-0"
    >
      <div className="flex flex-col min-w-0">
        <span className="text-[13px] font-[600] break-words">
          {pageSet.name}
        </span>
        <span className="text-[11px] text-textItemBlur">
          {`${sourceText(t, pageSet)} · ${pageCountText(t, pageSet.pageCount)}`}
        </span>
      </div>
      {content ? (
        <DesignPageSetPages content={content} />
      ) : (
        <div role="alert" className="text-[12px]">
          {t(
            'content_studio_page_set_error_integrity',
            'Stored page set data could not be read safely.'
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-[4px]">
        <Button
          secondary
          className="h-[28px] px-[10px] text-[12px]"
          disabled={disabled || !content}
          aria-label={`${t('content_studio_page_set_add', 'Add pages')} ${
            pageSet.name
          }`}
          onClick={() => content && onAdd(content)}
        >
          {t('content_studio_page_set_add', 'Add pages')}
        </Button>
        {organization && (
          <>
            <Button
              secondary
              className="h-[28px] px-[10px] text-[12px]"
              disabled={!!busy}
              aria-label={`${t(
                'content_studio_page_set_edit',
                'Edit details'
              )} ${pageSet.name}`}
              onClick={() =>
                modals.openModal({
                  title: t('content_studio_page_set_edit', 'Edit details'),
                  children: (close: () => void) => (
                    <PageSetDetailsForm pageSet={organization} close={close} />
                  ),
                })
              }
            >
              {t('content_studio_page_set_edit', 'Edit details')}
            </Button>
            <Button
              secondary
              className="h-[28px] px-[10px] text-[12px]"
              loading={busy === 'archive'}
              disabled={!!busy}
              aria-label={`${t('content_studio_archive', 'Archive')} ${
                pageSet.name
              }`}
              onClick={() =>
                run('archive', async () => {
                  try {
                    await archivePageSet(organization.id);
                    toaster.show(
                      t(
                        'content_studio_page_set_archived',
                        'Page set archived. Designs made with it keep their pages.'
                      ),
                      'success'
                    );
                  } catch (err) {
                    toaster.show(designPageSetErrorMessage(t, err), 'warning');
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

export const DesignPageSets: FC<{
  editor: ContentStudioDesignEditor;
  document: ContentStudioDesignDocumentV1;
  onAdded: (pageIds: string[]) => void;
}> = ({ editor, document, onAdded }) => {
  const t = useT();
  const modals = useModals();
  // the catalog loads only once it is opened
  const [open, setOpen] = useState(false);
  const [listPage, setListPage] = useState(1);
  const list = useContentStudioDesignPageSets(open, false, listPage);
  const disabled = editor.saving || editor.interacting;

  const add = (content: ContentStudioDesignPageSetContentV1) => {
    const added = editor.apply((latest) => {
      const outcome = addContentStudioDesignPageSet(latest, content);
      return { document: outcome.document, result: outcome.pageIds };
    });
    if (added) {
      onAdded(added);
    }
  };
  const save = () => {
    const content = extractContentStudioDesignPageSet(document);
    modals.openModal({
      title: t('content_studio_page_set_save', 'Save page set'),
      children: (close: () => void) => (
        <SavePageSetForm content={content} close={close} />
      ),
    });
  };
  const rows = (pageSets: ContentStudioDesignPageSet[], label: string) => (
    <ul aria-label={label} className="flex flex-col gap-[6px]">
      {pageSets.map((pageSet) => (
        <PageSetRow
          key={`${pageSet.source}:${pageSet.id}`}
          pageSet={pageSet}
          disabled={disabled}
          onAdd={add}
        />
      ))}
    </ul>
  );

  return (
    <section
      aria-label={t('content_studio_page_sets', 'Page sets')}
      className="flex flex-col gap-[8px] min-w-0"
    >
      <h2 className="font-[600]">
        {t('content_studio_page_sets', 'Page sets')}
      </h2>
      <div className="text-[12px] text-textItemBlur">
        {t(
          'content_studio_page_sets_hint',
          'Adding a page set adds blank pages after the last page; they do not stay linked.'
        )}
      </div>
      <div className="flex flex-wrap gap-[6px]">
        <Button
          secondary
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? t('content_studio_page_sets_hide', 'Hide page sets')
            : t('content_studio_page_sets_show', 'Browse page sets')}
        </Button>
        <Button secondary disabled={disabled} onClick={save}>
          {t('content_studio_page_set_save', 'Save page set')}
        </Button>
        <Button
          secondary
          onClick={() =>
            modals.openModal({
              title: t(
                'content_studio_page_sets_archived',
                'Archived page sets'
              ),
              children: () => <ArchivedPageSets />,
            })
          }
        >
          {t('content_studio_page_sets_archived', 'Archived page sets')}
        </Button>
      </div>
      {open &&
        (list.error ? (
          <div role="status">
            {t(
              'content_studio_page_sets_load_error',
              'Page sets could not be loaded.'
            )}
          </div>
        ) : !list.data ? (
          <LoadingComponent width={40} height={40} />
        ) : (
          <>
            <h3 className="text-[13px] font-[600]">
              {t('content_studio_page_sets_built_in', 'Built-in')}
            </h3>
            {rows(
              list.data.system,
              `${t('content_studio_page_sets_built_in', 'Built-in')} · ${t(
                'content_studio_page_sets',
                'Page sets'
              )}`
            )}
            <h3 className="text-[13px] font-[600]">
              {t('content_studio_page_sets_organization', 'Organization')}
            </h3>
            {list.data.results.length ? (
              rows(
                list.data.results.filter((pageSet) => !pageSet.archivedAt),
                `${t(
                  'content_studio_page_sets_organization',
                  'Organization'
                )} · ${t('content_studio_page_sets', 'Page sets')}`
              )
            ) : (
              <div className="text-[12px] text-textItemBlur">
                {t(
                  'content_studio_page_sets_none',
                  'No organization page sets yet. Save the pages of a design as a page set.'
                )}
              </div>
            )}
            {list.data.pages > 1 && (
              <ContentStudioPager
                page={listPage}
                pages={list.data.pages}
                setPage={setListPage}
              />
            )}
          </>
        ))}
    </section>
  );
};
