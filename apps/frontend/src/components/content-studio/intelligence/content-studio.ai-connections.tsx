'use client';

import { FC, FormEvent, ReactNode, useEffect, useId, useState } from 'react';
import clsx from 'clsx';
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
  aiConnectionHealth,
  aiTestResultMessage,
  aiValidationCodeMessage,
  ContentStudioAIConnection,
  ContentStudioAIProviderInfo,
  isRetiredAIModel,
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

// Only for a provider that asks for it (Anthropic): the workspace an
// unscoped key works in. Not secret, but it travels with the key
const WorkspaceIdInput: FC<{
  value: string;
  onChange: (next: string) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  return (
    <div className="flex flex-col gap-[6px]">
      <Input
        label="Workspace ID (optional)"
        translationKey="content_studio_ai_workspace_id"
        name="workspaceId"
        aria-label={t(
          'content_studio_ai_workspace_id',
          'Workspace ID (optional)'
        )}
        autoComplete="off"
        spellCheck={false}
        disableForm={true}
        removeError={true}
        placeholder="wrkspc_…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="text-[12px] text-textItemBlur">
        {t(
          'content_studio_ai_workspace_id_hint',
          'Only for an Anthropic key that is not tied to one workspace. You find the ID in the Claude Console under Settings, Workspaces.'
        )}
      </div>
    </div>
  );
};

const asksWorkspace = (provider: ContentStudioAIProviderInfo | undefined) =>
  !!provider?.credentialFields.some((field) => field.name === 'workspaceId');

// The state of a connection as a short label: Ready only after a test of the
// key and its model succeeded; Testing… while one runs
export const AIConnectionHealthBadge: FC<{
  connection: ContentStudioAIConnection;
  testing?: boolean;
}> = ({ connection, testing }) => {
  const t = useT();
  const health = aiConnectionHealth(connection);
  const [label, tone] = testing
    ? [t('content_studio_ai_health_testing', 'Testing…'), 'muted']
    : connection.disabled
    ? [t('content_studio_ai_status_disabled', 'Disabled'), 'muted']
    : health === 'ready'
    ? [t('content_studio_ai_health_ready', 'Ready'), 'ok']
    : health === 'attention'
    ? [t('content_studio_ai_health_attention', 'Needs attention'), 'warn']
    : [
        t('content_studio_ai_health_connected', 'Connected, not tested yet'),
        'muted',
      ];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-[6px] px-[8px] py-[1px] rounded-full border text-[12px] font-[600]',
        tone === 'ok' && 'border-green-600/50 text-green-600',
        tone === 'warn' && 'border-red-500/60 text-red-400',
        tone === 'muted' && 'border-newTableBorder text-textItemBlur'
      )}
    >
      <span aria-hidden="true">
        {testing ? '…' : tone === 'ok' ? '✓' : tone === 'warn' ? '!' : '•'}
      </span>
      {label}
    </span>
  );
};

// A new connection: the provider, its key, a model from the provider's
// catalog and an optional name (the provider's name when left blank). The
// key is sent once and then cleared; leaving the form drops it. Used in the
// Add AI connection dialog and inline in the setup assistant
export const AIConnectionCreateForm: FC<{
  providers: ContentStudioAIProviderInfo[];
  onCancel: () => void;
  // after the connection is saved, tested and the list reloaded
  onCreated: (created: ContentStudioAIConnection) => void;
  // where the fields and the buttons go; the dialog keeps the buttons in
  // view while the fields scroll
  layout?: (form: ReactNode, buttons: ReactNode) => ReactNode;
  onDirtyChange?: (dirty: boolean) => void;
  // false where the page tests the new connection itself (setup assistant)
  testAfterCreate?: boolean;
}> = ({
  providers,
  onCancel,
  onCreated,
  layout,
  onDirtyChange,
  testAfterCreate = true,
}) => {
  const formId = useId();
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioAIConnectionActions();
  const [name, setName] = useState('');
  const [provider, setProvider] = useState(providers[0]?.provider ?? '');
  const [model, setModel] = useState(providers[0]?.defaultModel ?? '');
  const [apiKey, setApiKey] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const { busy, run } = useSingleFlight();
  const info = providers.find((entry) => entry.provider === provider);
  const workspace = asksWorkspace(info);
  const dirty = !!apiKey || !!name.trim() || !!workspaceId.trim();
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty]);

  // the key lives in this form's state only and goes with it
  const cancel = () => onCancel();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run('create', async () => {
      let created: ContentStudioAIConnection;
      try {
        created = await actions.createConnection(
          {
            name: name.trim() || info?.displayName || provider,
            provider,
            defaultModel: model,
          },
          apiKey,
          workspace ? workspaceId : undefined
        );
        setApiKey('');
      } catch (err) {
        // the key stays in this open form only, to correct and send again
        toaster.show(aiConnectionErrorMessage(t, err), 'warning');
        return;
      }
      // a saved key is not yet a working one: it is tested right away, so
      // the list shows Ready or Needs attention
      const result = testAfterCreate
        ? await actions.testConnection(created.id).catch(() => null)
        : null;
      toaster.show(
        result && !result.ok
          ? `${t(
              'content_studio_ai_created_attention',
              'AI connection saved, but it does not work yet.'
            )} ${aiTestResultMessage(t, result)}`
          : t('content_studio_ai_created', 'AI connection created.'),
        result && !result.ok ? 'warning' : 'success'
      );
      onCreated(created);
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
      {workspace && (
        <WorkspaceIdInput value={workspaceId} onChange={setWorkspaceId} />
      )}
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
  // a model the catalog no longer offers cannot be kept: the recommended one
  // is proposed instead, and saving it is a change
  const retired = isRetiredAIModel(connection, provider);
  const initialModel = retired
    ? ''
    : connection.defaultModel ?? provider?.defaultModel ?? '';
  const [model, setModel] = useState(
    retired ? provider?.defaultModel ?? '' : initialModel
  );
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
      {retired && (
        <div role="status" className="text-[13px] text-red-400">
          {t(
            'content_studio_ai_model_retired_choose',
            'The previously selected model is no longer available. Choose another.'
          )}
        </div>
      )}
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
  provider: ContentStudioAIProviderInfo | undefined;
  close: () => void;
}> = ({ connection, provider, close }) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioAIConnectionActions();
  const [apiKey, setApiKey] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const workspace = asksWorkspace(provider);
  const { busy, run } = useSingleFlight();
  const release = useContentStudioDialogGuard(!!apiKey || !!workspaceId);

  const cancel = () => close();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run('replace', async () => {
      try {
        await actions.replaceCredential(
          connection.id,
          apiKey,
          workspace ? workspaceId : undefined
        );
        setApiKey('');
      } catch (err) {
        toaster.show(aiConnectionErrorMessage(t, err), 'warning');
        return;
      }
      // tested right away, as a new connection is
      const result = await actions
        .testConnection(connection.id)
        .catch(() => null);
      toaster.show(
        result && !result.ok
          ? `${t(
              'content_studio_ai_key_replaced_attention',
              'API key replaced, but the connection does not work yet.'
            )} ${aiTestResultMessage(t, result)}`
          : t('content_studio_ai_key_replaced', 'API key replaced.'),
        result && !result.ok ? 'warning' : 'success'
      );
      release();
      close();
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
      {workspace && (
        <WorkspaceIdInput value={workspaceId} onChange={setWorkspaceId} />
      )}
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

// a secondary action of a connection: text, not a large button
const QUIET_ACTION =
  'h-[32px] underline-offset-2 hover:underline disabled:opacity-50 disabled:pointer-events-none';

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
        <ReplaceKey
          connection={connection}
          provider={providerOf(connection.provider)}
          close={close}
        />
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
                      {connection.credentialPresent
                        ? t('content_studio_ai_key_stored', 'API key stored')
                        : t('content_studio_ai_key_missing', 'No API key')}
                    </span>
                    {!!connection.lastValidatedAt && (
                      <span>
                        {t('content_studio_ai_tested_at', 'Tested')}{' '}
                        {formatDate(connection.lastValidatedAt)}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-[8px] pt-[4px]">
                    <AIConnectionHealthBadge
                      connection={connection}
                      testing={busy === connection.id}
                    />
                    {aiConnectionHealth(connection) === 'attention' && (
                      <span className="text-[13px] text-red-400">
                        {aiValidationCodeMessage(
                          t,
                          connection.lastValidationCode
                        )}
                      </span>
                    )}
                  </div>
                  {isRetiredAIModel(connection, provider) && (
                    <div role="status" className="text-[13px] text-red-400">
                      {t(
                        'content_studio_ai_model_retired',
                        'The previously selected model is no longer available. Choose another with Edit; until then the recommended model is used.'
                      )}
                    </div>
                  )}
                </div>
                {canManage && (
                  // Test and Edit are the everyday actions; the key, turning
                  // the connection off and removing it are quieter text
                  // buttons, each with its own name, never behind a menu
                  <div className="flex flex-col gap-[8px] w-full sm:w-auto">
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
                    </div>
                    <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] text-[13px]">
                      <button
                        type="button"
                        className={QUIET_ACTION}
                        disabled={!!busy}
                        aria-label={`${t(
                          'content_studio_ai_replace_key',
                          'Replace key'
                        )} ${connection.name}`}
                        onClick={() => openReplaceKey(connection)}
                      >
                        {t('content_studio_ai_replace_key', 'Replace key')}
                      </button>
                      {connection.disabled ? (
                        <button
                          type="button"
                          className={QUIET_ACTION}
                          disabled={!!busy}
                          aria-label={`${t(
                            'content_studio_ai_enable',
                            'Enable'
                          )} ${connection.name}`}
                          onClick={() => enable(connection)}
                        >
                          {t('content_studio_ai_enable', 'Enable')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={QUIET_ACTION}
                          disabled={!!busy}
                          aria-label={`${t(
                            'content_studio_ai_disable',
                            'Disable'
                          )} ${connection.name}`}
                          onClick={() => disable(connection)}
                        >
                          {t('content_studio_ai_disable', 'Disable')}
                        </button>
                      )}
                      <button
                        type="button"
                        className={clsx(QUIET_ACTION, 'text-red-400')}
                        disabled={!!busy}
                        aria-label={`${t(
                          'content_studio_ai_remove',
                          'Remove'
                        )} ${connection.name}`}
                        onClick={() => remove(connection)}
                      >
                        {t('content_studio_ai_remove', 'Remove')}
                      </button>
                    </div>
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
