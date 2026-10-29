'use client';

import { useMemo } from 'react';
import { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { request } from '@gitroom/frontend/components/content-studio/content-studio.api';
import {
  aiConnectionHealth,
  AUDIENCE_PROFILES_PATH,
  ContentStudioAIConnection,
  ContentStudioAIProviderInfo,
  ContentStudioEditorialPolicyState,
  ContentStudioProfileDetail,
  ContentStudioProfileList,
  ContentStudioProfilesPath,
  EDITORIAL_POLICY_PATH,
  EXPERTISE_PROFILES_PATH,
  profilePath,
  profilesListPath,
  useContentStudioAIConnections,
  useContentStudioAIProviders,
  useContentStudioEditorialPolicy,
  useContentStudioProfiles,
  WRITING_PROFILES_PATH,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';
import {
  BRAND_KIT_PATH,
  ContentStudioBrandKitSummary,
  useContentStudioBrandKit,
} from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import { useContentStudioSources } from '@gitroom/frontend/components/content-studio/content-studio.sources.api';
import type { WritingProfileContent } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.writing-profiles';
import type { AudienceProfileContent } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.audience-profiles';
import type { ExpertiseProfileContent } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.expertise-profiles';
import type { EditorialPolicyContent } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.editorial-policy';

// The guided setup. What is set up is read from the organization's own
// Content Studio data every time, never from a flag: a usable AI connection,
// the Brand Kit's description, and at least one writing, audience and
// expertise profile and the editorial policy. Only the unfinished wizard and
// "hide the setup card" are kept, in this browser and per organization

export const AI_SETUP_PROPOSAL_PATH = '/content-studio/ai/setup/proposal';

export type ContentStudioSetupItem =
  | 'ai'
  | 'brand'
  | 'voice'
  | 'audience'
  | 'expertise'
  | 'editorial';

export const CONTENT_STUDIO_SETUP_ITEMS: ContentStudioSetupItem[] = [
  'ai',
  'brand',
  'voice',
  'audience',
  'expertise',
  'editorial',
];

// A connection Content Studio can use now: enabled, with a stored key, of a
// provider the server offers
export const isUsableAIConnection = (
  connection: ContentStudioAIConnection,
  providers: ContentStudioAIProviderInfo[]
) =>
  !connection.disabled &&
  connection.credentialPresent &&
  providers.some((provider) => provider.provider === connection.provider);

// Whether opening Content Studio should open the setup assistant instead of
// the home page: as long as the organization's setup is not complete, on
// every device, until "Finish later" or "Skip for now" was chosen there.
// What is set up is the organization's own data, so a phone decides the same
// as the computer the setup was started on (UX review 03: a rule that also
// looked at existing content and at an unfinished assistant kept in this
// browser opened it on the computer but not on the phone). A filtered or
// paged home page was asked for on purpose and is never redirected
export const shouldOpenContentStudioSetup = (input: {
  complete: boolean;
  hidden: boolean;
  filtered: boolean;
}) => !input.complete && !input.hidden && !input.filtered;

export interface ContentStudioSetupStatus {
  loaded: boolean;
  done: Record<ContentStudioSetupItem, boolean>;
  doneCount: number;
  total: number;
  complete: boolean;
  // not part of setup, but the next thing worth doing
  hasSources: boolean;
}

export const useContentStudioSetupStatus = (): ContentStudioSetupStatus => {
  const providers = useContentStudioAIProviders();
  const connections = useContentStudioAIConnections();
  const brandKit = useContentStudioBrandKit(true);
  const writing = useContentStudioProfiles(WRITING_PROFILES_PATH, false, 1);
  const audiences = useContentStudioProfiles(AUDIENCE_PROFILES_PATH, false, 1);
  const expertise = useContentStudioProfiles(EXPERTISE_PROFILES_PATH, false, 1);
  const policy = useContentStudioEditorialPolicy<EditorialPolicyContent>();
  const sources = useContentStudioSources(false, 1);

  return useMemo(() => {
    const done: Record<ContentStudioSetupItem, boolean> = {
      // a connection whose last test failed is not set up yet
      ai: !!connections.data?.some(
        (connection) =>
          isUsableAIConnection(connection, providers.data || []) &&
          aiConnectionHealth(connection) !== 'attention'
      ),
      brand: !!brandKitIdentity(
        brandKit.data?.currentRevision?.content
      ).description.trim(),
      voice: !!writing.data?.results.length,
      audience: !!audiences.data?.results.length,
      expertise: !!expertise.data?.results.length,
      editorial: !!policy.data?.currentRevision,
    };
    const doneCount = CONTENT_STUDIO_SETUP_ITEMS.filter(
      (item) => done[item]
    ).length;
    return {
      // an item that failed to load counts as not done, never as loading
      loaded: [
        providers,
        connections,
        brandKit,
        writing,
        audiences,
        expertise,
        policy,
      ].every((entry) => entry.data !== undefined || !!entry.error),
      done,
      doneCount,
      total: CONTENT_STUDIO_SETUP_ITEMS.length,
      complete: doneCount === CONTENT_STUDIO_SETUP_ITEMS.length,
      hasSources: !!sources.data?.results.length,
    };
  }, [
    providers.data,
    providers.error,
    connections.data,
    connections.error,
    brandKit.data,
    brandKit.error,
    writing.data,
    writing.error,
    audiences.data,
    audiences.error,
    expertise.data,
    expertise.error,
    policy.data,
    policy.error,
    sources.data,
  ]);
};

export interface BrandIdentity {
  brandName: string;
  tagline: string;
  description: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The identity of a verified Brand Kit revision; empty texts when there is
// none
export const brandKitIdentity = (content: unknown): BrandIdentity => {
  const identity = isRecord(content) ? content.identity : undefined;
  const text = (key: keyof BrandIdentity) =>
    isRecord(identity) && typeof identity[key] === 'string'
      ? (identity[key] as string)
      : '';
  return {
    brandName: text('brandName'),
    tagline: text('tagline'),
    description: text('description'),
  };
};

// The Brand Kit with a new identity: colors, typography and visual direction
// stay exactly as they are, and a first kit starts with them empty
export const brandKitWithIdentity = (
  content: unknown,
  identity: BrandIdentity
) => ({
  ...(isRecord(content)
    ? content
    : {
        schemaVersion: 1,
        colors: [],
        typography: [],
        visualDirection: { keywords: [], dos: [], donts: [] },
      }),
  identity: {
    brandName: identity.brandName.trim(),
    tagline: identity.tagline.trim(),
    description: identity.description.trim(),
  },
});

// The AI draft of the setup, exactly as the server validated it
export interface ContentStudioSetupProposal {
  brand: { tagline: string; description: string };
  writing: { name: string; content: WritingProfileContent };
  audiences: Array<{ name: string; content: AudienceProfileContent }>;
  expertise: { name: string; content: ExpertiseProfileContent };
  editorialPolicy: { content: EditorialPolicyContent };
}

export interface ContentStudioSetupCompany {
  companyName: string;
  tagline: string;
  website: string;
  description: string;
  goal: string;
  audience: string;
  language: string;
}

export const useContentStudioSetupActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  // the first page of active profiles of one kind
  const activeProfiles = (base: ContentStudioProfilesPath) =>
    request<ContentStudioProfileList>(fetch, profilesListPath(base, false, 1));
  return useMemo(
    () => ({
      getBrandKit: () =>
        request<ContentStudioBrandKitSummary>(fetch, BRAND_KIT_PATH),
      getEditorialPolicy: () =>
        request<ContentStudioEditorialPolicyState<EditorialPolicyContent>>(
          fetch,
          EDITORIAL_POLICY_PATH
        ),
      getProfile: <T>(base: ContentStudioProfilesPath, id: string) =>
        request<ContentStudioProfileDetail<T>>(fetch, profilePath(base, id)),
      // the active profile with exactly this name, on the first page
      findActiveProfile: async (
        base: ContentStudioProfilesPath,
        name: string
      ) =>
        (await activeProfiles(base)).results.find(
          (profile) => profile.name === name
        ) ?? null,
      // the most recently changed active profile of a kind, with its content
      latestActiveProfile: async <T>(base: ContentStudioProfilesPath) => {
        const first = (await activeProfiles(base)).results[0];
        return first
          ? request<ContentStudioProfileDetail<T>>(
              fetch,
              profilePath(base, first.id)
            )
          : null;
      },
      // one AI request: never retried here, the user decides to try again
      proposeSetup: (
        connectionId: string,
        company: ContentStudioSetupCompany
      ) =>
        request<{
          operationId: string;
          proposal: ContentStudioSetupProposal;
          ai: { provider: string; model: string; promptVersion: string };
        }>(fetch, AI_SETUP_PROPOSAL_PATH, {
          method: 'POST',
          body: JSON.stringify({
            connectionId,
            companyName: company.companyName,
            tagline: company.tagline?.trim() || null,
            website: company.website.trim() || null,
            description: company.description,
            goal: company.goal.trim() || null,
            audience: company.audience.trim() || null,
            language: company.language.trim() || null,
          }),
        }),
      // the Brand Kit identity over the revision it was read at; colors,
      // typography and visual direction are kept as they are
      saveBrandKit: async <T>(baseRevisionNumber: number, content: T) => {
        const result = await request<{ latestRevisionNumber: number }>(
          fetch,
          `${BRAND_KIT_PATH}/revisions`,
          {
            method: 'POST',
            body: JSON.stringify({ baseRevisionNumber, content }),
          }
        );
        await mutate(
          (key) =>
            typeof key === 'string' &&
            (key === BRAND_KIT_PATH ||
              key.startsWith(`${BRAND_KIT_PATH}/revisions?`))
        );
        return result;
      },
    }),
    [fetch, mutate]
  );
};

// --- this browser only: the unfinished wizard and the hidden setup card ---

const draftKey = (organizationId: string) =>
  `content-studio-setup-draft:${organizationId}`;
const hiddenKey = (organizationId: string) =>
  `content-studio-setup-hidden:${organizationId}`;

// Storage can be unavailable (private windows, blocked site data): then
// nothing is kept and nothing fails
const storage = () => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const loadContentStudioSetupDraft = <T>(
  organizationId: string
): T | null => {
  try {
    const value = storage()?.getItem(draftKey(organizationId));
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
};

export const saveContentStudioSetupDraft = <T>(
  organizationId: string,
  draft: T
) => {
  try {
    storage()?.setItem(draftKey(organizationId), JSON.stringify(draft));
  } catch {
    // full or blocked: the wizard keeps working without resume
  }
};

export const clearContentStudioSetupDraft = (organizationId: string) => {
  try {
    storage()?.removeItem(draftKey(organizationId));
  } catch {
    // nothing to clear
  }
};

export const isContentStudioSetupHidden = (organizationId: string) => {
  try {
    return storage()?.getItem(hiddenKey(organizationId)) === '1';
  } catch {
    return false;
  }
};

export const setContentStudioSetupHidden = (
  organizationId: string,
  hidden: boolean
) => {
  try {
    if (hidden) {
      storage()?.setItem(hiddenKey(organizationId), '1');
    } else {
      storage()?.removeItem(hiddenKey(organizationId));
    }
  } catch {
    // the card simply shows again
  }
};
