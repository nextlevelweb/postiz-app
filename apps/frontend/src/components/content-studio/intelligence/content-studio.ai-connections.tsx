'use client';

import { FC, FormEvent, ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import {
  ContentStudioDialogLayout,
  useContentStudioDialogGuard,
} from '@gitroom/frontend/components/content-studio/content-studio.dialog';
import {
  AI_CONNECTION_NAME_MAX,
  aiConnectionErrorMessage,
  aiTestResultMessage,
  aiValidationCodeMessage,
  ContentStudioAIConnection,
  ContentStudioAIProviderInfo,
  useContentStudioAIConnectionActions,
  useContentStudioAIConnections,
  useContentStudioAIProviders,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';
import {
  ChoiceField,
  formatDate,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';

// Only these membership roles manage connections, as on the server; anything
// else, unknown or missing included, only sees them. The server decides: this
// only hides what it would refuse
const MANAGER_ROLES = ['ADMIN', 'SUPERADMIN'];
export const useCanManageAIConnections = () => {
  const user = useUser();
  return MANAGER_ROLES.includes(user?.role as string);
};

const modelOptions = (provider: ContentStudioAIProviderInfo | undefined) =>
  (provider?.models || []).map((model) => ({
    value: model.id,
    label: model.label,
  }));

// The key field. Its value lives only in the state of the open dialog
const ApiKeyInput: FC<{
  value: string;
  onChange: (next: string) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  return (
    <Input
      label="API key"
      translationKey="content_studio_ai_api_key"
      name="apiKey"
      aria-label={t('content_studio_ai_api_key', 'API key')}
      type="password"
      autoComplete="new-password"
      spellCheck={false}
      disableForm={true}
      removeError={true}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};

// A new connection: the provider, its key, a model from the provider's
// catalog and an optional name (the provider's name when left blank). The
// key is sent once and then cleared; leaving the form drops it. Used in the
// Add AI connection dialog and inline in the setup assistant
export const AIConnectionCreateForm: FC<{
  providers: ContentStudioAIProviderInfo[];
  onCancel: () => void;
  // after the connection is saved and the list reloaded
  onCreated: () => void;
  // where the fields and the buttons go; the dialog keeps the buttons in
  // view while the fields scroll
  layout?: (form: ReactNode, buttons: ReactNode) => ReactNode;
  onDirtyChange?: (dirty: boolean) => void;
}> = ({ providers, onCancel, onCreated, layout, onDirtyChange }) => {
  const formId = useId();
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioAIConnectionActions();
  const [name, setName] = useState('');
  const [provider, setProvider] = useState(providers[0]?.provider ?? '');
  const [model, setModel] = useState(providers[0]?.defaultModel ?? '');
  const [apiKey, setApiKey] = useState('');
  const { busy, run } = useSingleFlight();
  const info = providers.find((entry) => entry.provider === provider);
  const dirty = !!apiKey || !!name.trim();
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty]);

  // the key lives in this form's state only and goes with it
  const cancel = () => onCancel();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run('create', async () => {
      try {
        await actions.createConnection(
          {
            name: name.trim() || info?.displayName || provider,
            provider,
            defaultModel: model,
          },
          apiKey
        );
        setApiKey('');
        toaster.show(
          t('content_studio_ai_created', 'AI connection created.'),
          'success'
        );
        onCreated();
      } catch (err) {
        // the key stays in this open form only, to correct and send again
        toaster.show(aiConnectionErrorMessage(t, err), 'warning');
      }
    });
  };

  const buttons = (
    <>
      <Button type="button" secondary onClick={cancel}>
        {t('cancel', 'Cancel')}
      </Button>
      <Button
        type="submit"
        form={formId}
        loading={busy === 'create'}
        disabled={!!busy || !provider || !model || !apiKey}
      >
        {t('content_studio_ai_connect', 'Connect')}
      </Button>
    </>
  );

  const fields = (
    <>
      <ChoiceField
        label={t('content_studio_ai_provider', 'Provider')}
        value={provider}
        options={providers.map((entry) => ({
          value: entry.provider,
          label: entry.displayName,
        }))}
        onChange={(next) => {
          setProvider(next);
          setModel(
            providers.find((entry) => entry.provider === next)?.defaultModel ??
              ''
          );
        }}
      />
      <div className="flex flex-col gap-[6px]">
        <ApiKeyInput value={apiKey} onChange={setApiKey} />
        <div className="text-[12px] text-textItemBlur">
          {t(
            'content_studio_ai_key_hint',
            'Create an API key in your provider account and paste it here. It is stored encrypted and is never shown again.'
          )}
        </div>
      </div>
      <ChoiceField
        label={t('content_studio_ai_model', 'Model')}
        hint={t(
          'content_studio_ai_model_hint',
          'The recommended model is selected. You can change it later.'
        )}
        value={model}
        options={modelOptions(info)}
        onChange={setModel}
      />
      <div className="flex flex-col gap-[6px]">
        <Input
          label="Connection name (optional)"
          translationKey="content_studio_ai_name_optional"
          name="name"
          aria-label={t(
            'content_studio_ai_name_optional',
            'Connection name (optional)'
          )}
          disableForm={true}
          removeError={true}
          value={name}
          placeholder={info?.displayName}
          maxLength={AI_CONNECTION_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="text-[12px] text-textItemBlur">
          {t(
            'content_studio_ai_name_hint',
            'Only needed to tell several connections apart, e.g. "OpenAI marketing".'
          )}
        </div>
      </div>
    </>
  );

  const form = (
    <form
      id={formId}
      onSubmit={submit}
      className="flex flex-col gap-[16px] min-w-0"
    >
      {fields}
    </form>
  );
  return layout ? (
    <>{layout(form, buttons)}</>
  ) : (
    <div className="flex flex-col gap-[16px] min-w-0">
      {form}
      <div className="flex flex-wrap gap-[8px] justify-end">{buttons}</div>
    </div>
  );
};

// The Add AI connection dialog: the form, kept in view at any window height,
// and asking before a typed key or name is dropped
const CreateConnection: FC<{
  providers: ContentStudioAIProviderInfo[];
  close: () => void;
}> = ({ providers, close }) => {
  const [dirty, setDirty] = useState(false);
  const release = useContentStudioDialogGuard(dirty);
  return (
    <AIConnectionCreateForm
      providers={providers}
      onCancel={close}
      onCreated={() => {
        release();
        close();
      }}
      onDirtyChange={setDirty}
      layout={(form, buttons) => (
        <ContentStudioDialogLayout footer={buttons}>
          {form}
        </ContentStudioDialogLayout>
      )}
    />
  );
};

// The name and default model; the provider never changes and the key has its
// own dialog
const EditConnection: FC<{
  connection: ContentStudioAIConnection;
  provider: ContentStudioAIProviderInfo | undefined;
  close: () => void;
}> = ({ connection, provider, close }) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioAIConnectionActions();
  const [name, setName] = useState(connection.name);
  const initialModel = connection.defaultModel ?? provider?.defaultModel ?? '';
  const [model, setModel] = useState(initialModel);
  const { busy, run } = useSingleFlight();
  const release = useContentStudioDialogGuard(
    name !== connection.name || model !== initialModel
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run('edit', async () => {
      try {
        await actions.updateConnection(connection.id, {
          name: name.trim(),
          defaultModel: model,
        });
        toaster.show(
          t('content_studio_ai_updated', 'AI connection updated.'),
          'success'
        );
        release();
        close();
      } catch (err) {
        toaster.show(aiConnectionErrorMessage(t, err), 'warning');
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <Input
        label="Name"
        translationKey="content_studio_ai_name"
        name="name"
        aria-label={t('content_studio_ai_name', 'Name')}
        disableForm={true}
        removeError={true}
        value={name}
        maxLength={AI_CONNECTION_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="flex flex-col gap-[4px]">
        <div className="text-[14px] font-[600]">
          {t('content_studio_ai_provider', 'Provider')}
        </div>
        <div>{provider?.displayName ?? connection.provider}</div>
      </div>
      <ChoiceField
        label={t('content_studio_ai_default_model', 'Default model')}
        value={model}
        options={modelOptions(provider)}
        onChange={setModel}
      />
      <div className="flex flex-wrap gap-[8px] justify-end">
        <Button secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          loading={busy === 'edit'}
          disabled={!!busy || !name.trim() || !model}
        >
          {t('save', 'Save')}
        </Button>
      </div>
    </form>
  );
};

// A new key for an existing connection. The current key cannot be shown:
// the server never sends it, and nothing here asks for it
const ReplaceKey: FC<{
  connection: ContentStudioAIConnection;
  close: () => void;
}> = ({ connection, close }) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioAIConnectionActions();
  const [apiKey, setApiKey] = useState('');
  const { busy, run } = useSingleFlight();
  const release = useContentStudioDialogGuard(!!apiKey);

  const cancel = () => close();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run('replace', async () => {
      try {
        await actions.replaceCredential(connection.id, apiKey);
        setApiKey('');
        toaster.show(
          t('content_studio_ai_key_replaced', 'API key replaced.'),
          'success'
        );
        release();
        close();
      } catch (err) {
        toaster.show(aiConnectionErrorMessage(t, err), 'warning');
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <div className="text-textItemBlur">
        {t(
          'content_studio_ai_replace_hint',
          'The current API key cannot be viewed. Enter a new key to replace it.'
        )}
      </div>
      <ApiKeyInput value={apiKey} onChange={setApiKey} />
      <div className="flex flex-wrap gap-[8px] justify-end">
        <Button secondary onClick={cancel}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          loading={busy === 'replace'}
          disabled={!!busy || !apiKey}
        >
          {t('content_studio_ai_replace_key', 'Replace key')}
        </Button>
      </div>
    </form>
  );
};

const ValidationStatus: FC<{ connection: ContentStudioAIConnection }> = ({
  connection,
}) => {
  const t = useT();
  if (!connection.lastValidationStatus) {
    return <span>{t('content_studio_ai_not_tested', 'Not tested')}</span>;
  }
  if (connection.lastValidationStatus === 'valid') {
    return <span>{t('content_studio_ai_working', 'Working')}</span>;
  }
  return (
    <span>
      {t('content_studio_ai_failed', 'Failed')}:{' '}
      {aiValidationCodeMessage(t, connection.lastValidationCode)}
    </span>
  );
};

// The AI connections of the organization. Every member sees them; only
// ADMIN and SUPERADMIN members get the controls that change them
export const AIConnectionsSection: FC = () => {
  const t = useT();
  const toaster = useToaster();
  const modals = useModals();
  const canManage = useCanManageAIConnections();
  const providers = useContentStudioAIProviders();
  const connections = useContentStudioAIConnections();
  const actions = useContentStudioAIConnectionActions();
  const { busy, run } = useSingleFlight();
  const providerOf = (id: string) =>
    providers.data?.find((entry) => entry.provider === id);

  const openCreate = () =>
    modals.openModal({
      title: t('content_studio_ai_add', 'Add AI connection'),
      children: (close: () => void) => (
        <CreateConnection providers={providers.data || []} close={close} />
      ),
    });
  const openEdit = (connection: ContentStudioAIConnection) =>
    modals.openModal({
      title: `${t('content_studio_ai_edit', 'Edit')}: ${connection.name}`,
      children: (close: () => void) => (
        <EditConnection
          connection={connection}
          provider={providerOf(connection.provider)}
          close={close}
        />
      ),
    });
  const openReplaceKey = (connection: ContentStudioAIConnection) =>
    modals.openModal({
      title: `${t('content_studio_ai_replace_key', 'Replace key')}: ${
        connection.name
      }`,
      children: (close: () => void) => (
        <ReplaceKey connection={connection} close={close} />
      ),
    });

  const failed = (err: unknown) =>
    toaster.show(aiConnectionErrorMessage(t, err), 'warning');

  const test = (connection: ContentStudioAIConnection) =>
    run(connection.id, async () => {
      try {
        const result = await actions.testConnection(connection.id);
        toaster.show(
          aiTestResultMessage(t, result),
          result.ok ? 'success' : 'warning'
        );
      } catch (err) {
        failed(err);
      }
    });

  const disable = async (connection: ContentStudioAIConnection) => {
    if (
      !(await deleteDialog(
        t(
          'content_studio_ai_disable_hint',
          'This prevents Content Studio from using this connection until it is enabled again.'
        ),
        t('content_studio_ai_disable', 'Disable'),
        t('content_studio_ai_disable_title', 'Disable AI connection'),
        t('cancel', 'Cancel')
      ))
    ) {
      return;
    }
    await run(connection.id, async () => {
      try {
        await actions.disableConnection(connection.id);
        toaster.show(
          t('content_studio_ai_disabled', 'AI connection disabled.'),
          'success'
        );
      } catch (err) {
        failed(err);
      }
    });
  };

  const enable = (connection: ContentStudioAIConnection) =>
    run(connection.id, async () => {
      try {
        await actions.enableConnection(connection.id);
        toaster.show(
          t('content_studio_ai_enabled', 'AI connection enabled.'),
          'success'
        );
      } catch (err) {
        failed(err);
      }
    });

  const remove = async (connection: ContentStudioAIConnection) => {
    if (
      !(await deleteDialog(
        t(
          'content_studio_ai_remove_hint',
          'Removing this AI connection permanently removes its stored API key. This connection cannot be restored.'
        ),
        t('content_studio_ai_remove', 'Remove'),
        t('content_studio_ai_remove_title', 'Remove AI connection'),
        t('cancel', 'Cancel')
      ))
    ) {
      return;
    }
    await run(connection.id, async () => {
      try {
        await actions.removeConnection(connection.id);
        toaster.show(
          t('content_studio_ai_removed', 'AI connection removed.'),
          'success'
        );
      } catch (err) {
        failed(err);
      }
    });
  };

  return (
    <div className="flex flex-col gap-[16px] min-w-0">
      <div className="flex flex-wrap items-center gap-[8px]">
        <div className="flex-1 min-w-[200px] text-textItemBlur">
          {canManage
            ? t(
                'content_studio_ai_intro_admin',
                'Connect your own AI provider accounts. API keys are stored encrypted and are never shown again.'
              )
            : t(
                'content_studio_ai_intro_member',
                'Only admins can add or change AI connections.'
              )}
        </div>
        {canManage && (
          <Button disabled={!providers.data?.length} onClick={openCreate}>
            {t('content_studio_ai_add', 'Add AI connection')}
          </Button>
        )}
      </div>
      {connections.error ? (
        <div className="flex flex-col items-center gap-[12px] py-[24px]">
          <div>
            {t('content_studio_load_error', 'Could not load Content Studio.')}
          </div>
          <Button secondary onClick={() => connections.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        </div>
      ) : !connections.data ? (
        <LoadingComponent />
      ) : !connections.data.length ? (
        <div className="flex flex-col items-center gap-[12px] py-[32px] text-center">
          <div className="font-[600]">
            {t('content_studio_ai_none', 'No AI connections yet.')}
          </div>
          <div className="max-w-[520px] text-[14px] text-textItemBlur">
            {t(
              'content_studio_ai_none_hint',
              'Connect OpenAI, Anthropic or OpenRouter with your own API key. Content Studio then drafts your brand profile, posts and design copy for you to review.'
            )}
          </div>
          {canManage && (
            <Button disabled={!providers.data?.length} onClick={openCreate}>
              {t('content_studio_ai_add', 'Add AI connection')}
            </Button>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-[8px]">
          {connections.data.map((connection) => {
            const provider = providerOf(connection.provider);
            const model = provider?.models.find(
              (entry) => entry.id === connection.defaultModel
            );
            return (
              <li
                key={connection.id}
                className="flex flex-wrap items-center gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
              >
                <div className="flex flex-col gap-[2px] flex-1 min-w-[220px]">
                  <div className="font-[600] break-words">
                    {connection.name}
                  </div>
                  <div className="text-[12px] text-textItemBlur flex flex-wrap gap-x-[12px]">
                    <span>{provider?.displayName ?? connection.provider}</span>
                    <span>
                      {model?.label ??
                        connection.defaultModel ??
                        t('content_studio_ai_no_model', 'No default model')}
                    </span>
                    <span>
                      {connection.disabled
                        ? t('content_studio_ai_status_disabled', 'Disabled')
                        : t('content_studio_ai_status_enabled', 'Enabled')}
                    </span>
                    <span>
                      {connection.credentialPresent
                        ? t('content_studio_ai_key_stored', 'API key stored')
                        : t('content_studio_ai_key_missing', 'No API key')}
                    </span>
                    <ValidationStatus connection={connection} />
                    {!!connection.lastValidatedAt && (
                      <span>
                        {t('content_studio_ai_tested_at', 'Tested')}{' '}
                        {formatDate(connection.lastValidatedAt)}
                      </span>
                    )}
                  </div>
                </div>
                {canManage && (
                  <div className="flex flex-wrap gap-[8px]">
                    <Button
                      secondary
                      loading={busy === connection.id}
                      disabled={!!busy || connection.disabled}
                      aria-label={`${t('content_studio_ai_test', 'Test')} ${
                        connection.name
                      }`}
                      onClick={() => test(connection)}
                    >
                      {t('content_studio_ai_test', 'Test')}
                    </Button>
                    <Button
                      secondary
                      disabled={!!busy}
                      aria-label={`${t('content_studio_ai_edit', 'Edit')} ${
                        connection.name
                      }`}
                      onClick={() => openEdit(connection)}
                    >
                      {t('content_studio_ai_edit', 'Edit')}
                    </Button>
                    <Button
                      secondary
                      disabled={!!busy}
                      aria-label={`${t(
                        'content_studio_ai_replace_key',
                        'Replace key'
                      )} ${connection.name}`}
                      onClick={() => openReplaceKey(connection)}
                    >
                      {t('content_studio_ai_replace_key', 'Replace key')}
                    </Button>
                    {connection.disabled ? (
                      <Button
                        secondary
                        disabled={!!busy}
                        aria-label={`${t(
                          'content_studio_ai_enable',
                          'Enable'
                        )} ${connection.name}`}
                        onClick={() => enable(connection)}
                      >
                        {t('content_studio_ai_enable', 'Enable')}
                      </Button>
                    ) : (
                      <Button
                        secondary
                        disabled={!!busy}
                        aria-label={`${t(
                          'content_studio_ai_disable',
                          'Disable'
                        )} ${connection.name}`}
                        onClick={() => disable(connection)}
                      >
                        {t('content_studio_ai_disable', 'Disable')}
                      </Button>
                    )}
                    <Button
                      secondary
                      disabled={!!busy}
                      aria-label={`${t('content_studio_ai_remove', 'Remove')} ${
                        connection.name
                      }`}
                      onClick={() => remove(connection)}
                    >
                      {t('content_studio_ai_remove', 'Remove')}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
