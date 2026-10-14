'use client';

import { FC, FormEvent, useState } from 'react';
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

// A new connection: name, provider, model from the provider's catalog, and a
// key. The key is sent once and then cleared; closing the dialog drops it
const CreateConnection: FC<{
  providers: ContentStudioAIProviderInfo[];
  close: () => void;
}> = ({ providers, close }) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioAIConnectionActions();
  const [name, setName] = useState('');
  const [provider, setProvider] = useState(providers[0]?.provider ?? '');
  const [model, setModel] = useState(providers[0]?.defaultModel ?? '');
  const [apiKey, setApiKey] = useState('');
  const { busy, run } = useSingleFlight();
  const info = providers.find((entry) => entry.provider === provider);

  const cancel = () => {
    setApiKey('');
    close();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run('create', async () => {
      try {
        await actions.createConnection(
          { name: name.trim(), provider, defaultModel: model },
          apiKey
        );
        setApiKey('');
        toaster.show(
          t('content_studio_ai_created', 'AI connection created.'),
          'success'
        );
        close();
      } catch (err) {
        // the key stays in this open form only, to correct and send again
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
      <ApiKeyInput value={apiKey} onChange={setApiKey} />
      <ChoiceField
        label={t('content_studio_ai_default_model', 'Default model')}
        value={model}
        options={modelOptions(info)}
        onChange={setModel}
      />
      <div className="flex flex-wrap gap-[8px] justify-end">
        <Button secondary onClick={cancel}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          loading={busy === 'create'}
          disabled={!!busy || !name.trim() || !provider || !model || !apiKey}
        >
          {t('content_studio_ai_add', 'Add AI connection')}
        </Button>
      </div>
    </form>
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
  const [model, setModel] = useState(
    connection.defaultModel ?? provider?.defaultModel ?? ''
  );
  const { busy, run } = useSingleFlight();

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

  const cancel = () => {
    setApiKey('');
    close();
  };

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
        <div className="py-[24px] text-center">
          {t('content_studio_ai_none', 'No AI connections yet.')}
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
