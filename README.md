# Next Level Web Postiz Fork

> **This repository is a maintained fork of [Postiz](https://github.com/gitroomhq/postiz-app) for Next Level Web's agency-managed social media infrastructure.**
>
> The upstream Postiz project remains the foundation of this repository. The original Postiz README and documentation are intentionally preserved below.
>
> This fork contains intentional product, authorization, organization-management, and customer-onboarding differences from upstream Postiz. These changes must be reviewed carefully when merging future upstream releases.

## Purpose of this fork

Next Level Web uses Postiz as a multi-customer agency platform.

The core tenancy model is:

- Each customer is represented by a separate Postiz `Organization`.
- The Next Level Web agency account remains `SUPERADMIN` of organizations it manages.
- Customer accounts are added as `ADMIN`.
- Customer `ADMIN` users may manage normal team members and other `ADMIN` users.
- Customer users cannot promote themselves or other users to `SUPERADMIN`.
- Customer `ADMIN` users cannot rename the organization, because organization names are managed by the agency as customer records.
- Organization provisioning is controlled by the agency `SUPERADMIN`.

## Agency organization provisioning

This fork adds an agency provisioning flow for creating customer organizations.

Provisioning supports:

- creating an organization without a customer account;
- attaching an existing Postiz user as `ADMIN`;
- generating a normal Postiz organization invitation when the customer does not yet have an account;
- ensuring the agency user remains `SUPERADMIN`;
- preventing a customer from being provisioned as `SUPERADMIN`;
- rejecting ambiguous email addresses that match multiple Postiz identities/providers;
- transactionally creating the organization and membership when attaching an existing customer, preventing partially provisioned organizations.

Relevant implementation areas include:

- `apps/backend/src/api/routes/users.controller.ts`
- `libraries/nestjs-libraries/src/database/prisma/organizations/organization.service.ts`
- `libraries/nestjs-libraries/src/database/prisma/organizations/organization.repository.ts`
- `libraries/nestjs-libraries/src/dtos/organizations/provision.organization.dto.ts`

## Customer social-account authorization links

This fork adds temporary customer-facing connect links.

An agency `SUPERADMIN` can generate a signed, expiring link for an organization. The customer can use this link to authorize supported social-media accounts without receiving a Postiz login or dashboard session.

Security properties include:

- the target organization must explicitly belong to the requesting user;
- the requesting user must be `SUPERADMIN` of that target organization;
- connect tokens are signed using the existing Postiz JWT infrastructure;
- connect tokens have an explicit `connect-link` purpose;
- links expire;
- OAuth state is bound server-side to the intended organization through Redis;
- supported OAuth connect-link flows use a fresh cryptographically secure state value before redirecting to the provider, independent of the provider's upstream state generator;
- X remains on its OAuth 1.0 provider-issued request token for callback correlation rather than replacing that token with an OAuth2-style state value;
- integrations created through the flow are stored directly in that organization;
- public connect-link users do not receive an authenticated Postiz dashboard session;
- public connect-link entry points and callback endpoints are rate-limited per client IP;
- organization OAuth state is retained only as long as required for multi-step provider selection;
- multi-step OAuth state is additionally bound to the exact temporary integration being configured.

The generic connect-link flow supports browser-based OAuth providers.

Provider types requiring a different authorization UX are intentionally excluded, including:

- Web3 providers;
- Chrome-extension based providers;
- providers using custom credential fields;
- providers requiring an external or instance URL.

Multi-step OAuth providers continue through Postiz's existing page/account selection flow while preserving organization isolation.

Relevant implementation areas include:

- `apps/backend/src/api/routes/connect-link.controller.ts`
- `apps/backend/src/api/routes/no.auth.integrations.controller.ts`
- `apps/frontend/src/app/(app)/connect/`
- `apps/frontend/src/components/connect/`
- `libraries/nestjs-libraries/src/dtos/integrations/create-connect-link.dto.ts`

## Organization ownership restrictions

In this fork, renaming an organization is deliberately restricted to the organization's `SUPERADMIN`.

Customer `ADMIN` users may manage team membership, including adding `ADMIN` and `USER` members, but they cannot rename the agency-managed customer organization.

This restriction is enforced server-side. The corresponding organization-name controls are also hidden in the frontend for non-`SUPERADMIN` users.

The backend authorization check is authoritative; the frontend restriction is only a user-interface restriction.

## Important: merging upstream Postiz

**Do not blindly resolve upstream merge conflicts by accepting the upstream version of agency-related files.**

The agency ownership model, provisioning logic, customer role restrictions, connect-link authorization flow and organization-name restriction are intentional fork behavior.

Extra care is required when upstream changes:

- authentication middleware;
- organization membership and roles;
- organization creation;
- team-member invitations;
- organization settings;
- social integration OAuth;
- OAuth callback state handling;
- Redis OAuth state keys;
- integration creation/update logic;
- public integration routes;
- frontend organization switching;
- frontend integration continuation and page selection.

After merging upstream changes, verify at minimum that:

1. customers cannot obtain `SUPERADMIN` through agency provisioning;
2. customer `ADMIN` users cannot rename agency-managed organizations;
3. connect links cannot target organizations not owned by the requesting agency user;
4. OAuth state remains bound to the intended organization;
5. multi-step provider selection cannot access an integration belonging to another organization;
6. connect-link users do not receive an authenticated Postiz session;
7. organization OAuth state is cleaned up after successful authorization;
8. backend and frontend production builds succeed.

---

# Upstream Postiz documentation

The content below is the original Postiz project documentation and is intentionally retained for reference.

<p align="center">
  <a href="https://postiz.com/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/765e9d72-3ee7-4a56-9d59-a2c9befe2311">
    <img alt="Postiz Logo" src="https://github.com/user-attachments/assets/f0d30d70-dddb-4142-8876-e9aa6ed1cb99" width="280"/>
  </picture>
  </a>
</p>

<p align="center">
<a href="https://opensource.org/license/agpl-v3">
  <img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg" alt="License">
</a>
</p>

<h3 align="center"><strong><a href="https://github.com/gitroomhq/postiz-agent">NEW: check out Postiz agent CLI! perfect for OpenClaw and other agents</a></strong></h3>
<div align="center">
  <strong>
  <h2>Your ultimate AI social media scheduling tool</h2><br />
  <a href="https://postiz.com">Postiz</a>: An alternative to: Buffer.com, Hypefury, Twitter Hunter, etc...<br /><br />
  </strong>
  Postiz offers everything you need to manage your social media posts,<br />build an audience, capture leads, and grow your business.
</div>

<div class="flex" align="center">
  <br />
  <img alt="Instagram" src="https://postiz.com/svgs/socials/Instagram.svg" width="32">
  <img alt="Youtube" src="https://postiz.com/svgs/socials/Youtube.svg" width="32">
  <img alt="Dribbble" src="https://postiz.com/svgs/socials/Dribbble.svg" width="32">
  <img alt="Linkedin" src="https://postiz.com/svgs/socials/Linkedin.svg" width="32">
  <img alt="Reddit" src="https://postiz.com/svgs/socials/Reddit.svg" width="32">
  <img alt="TikTok" src="https://postiz.com/svgs/socials/TikTok.svg" width="32">
  <img alt="Facebook" src="https://postiz.com/svgs/socials/Facebook.svg" width="32">
  <img alt="Pinterest" src="https://postiz.com/svgs/socials/Pinterest.svg" width="32">
  <img alt="Threads" src="https://postiz.com/svgs/socials/Threads.svg" width="32">
  <img alt="X" src="https://postiz.com/svgs/socials/X.svg" width="32">
  <img alt="Slack" src="https://postiz.com/svgs/socials/Slack.svg" width="32">
  <img alt="Discord" src="https://postiz.com/svgs/socials/Discord.svg" width="32">
  <img alt="Mastodon" src="https://postiz.com/svgs/socials/Mastodon.svg" width="32">
  <img alt="Bluesky" src="https://postiz.com/svgs/socials/Bluesky.svg" width="32">
</div>

<p align="center">
  <br />
  <a href="https://docs.postiz.com" rel="dofollow"><strong>Explore the docs »</strong></a>
  <br />

  <br />
  <a href="https://youtube.com/@postizofficial" rel="dofollow"><strong>Watch the YouTube Tutorials»</strong></a>
  <br />
</p>

<p align="center">
  <a href="https://platform.postiz.com">Register</a>
  ·
  <a href="https://discord.postiz.com">Join Our Discord (devs only)</a>
  ·
  <a href="https://docs.postiz.com/public-api">Public API</a><br />
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@postiz/node">NodeJS SDK</a>
  ·
  <a href="https://www.npmjs.com/package/n8n-nodes-postiz">N8N custom node</a>
  ·
  <a href="https://apps.make.com/postiz">Make.com integration</a>
</p>

<br /><br />

## 🔌 See the leading Postiz features

<p align="center">
  <a href="https://www.youtube.com/watch?v=BdsCVvEYgHU" target="_blank">
    <img alt="Postiz" src="https://github.com/user-attachments/assets/8b9b7939-da1a-4be5-95be-42c6fce772de" />
  </a>
</p>

## ✨ Features

| ![Image 1](https://github.com/user-attachments/assets/a27ee220-beb7-4c7e-8c1b-2c44301f82ef) | ![Image 2](https://github.com/user-attachments/assets/eb5f5f15-ed90-47fc-811c-03ccba6fa8a2) |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ![Image 3](https://github.com/user-attachments/assets/d51786ee-ddd8-4ef8-8138-5192e9cfe7c3) | ![Image 4](https://github.com/user-attachments/assets/91f83c89-22f6-43d6-b7aa-d2d3378289fb) |

### Our Sponsors

| Sponsor |                                  Logo                                   | Description     |
|---------|:-----------------------------------------------------------------------:|-----------------|
| [Hostinger](https://www.hostinger.com/vps/docker/postiz?ref=postiz) | <img src=".github/sponsors/hostinger.png" alt="Hostinger" width="500"/> | Hostinger is on a mission to make online success possible for anyone – from developers to aspiring bloggers and business owners |
| [Virlo](https://dev.virlo.ai/?ref=postiz) | <img src="https://github.com/user-attachments/assets/25182598-5344-45fc-b9cd-e4cfa16aabfd" alt="Virlo" width="500"/> | Virlo is the #1 social media trend spotting and all-in-one GTM tool for teams leveraging short-form video |
| [ChatbotX](https://chatbotx.io/?ref=postiz) | <img src="https://github.com/user-attachments/assets/0aa6b058-9a64-46d3-bc26-337abc51737d" alt="ChatbotX" width="500"/> | The ManyChat alternative that you can self-host, white-label, and resell to your clients. Bring your own OpenClaw, Hermes, or Claude agents! |

![Bronze Tier](https://opencollective.com/postiz/tiers/main-repository-bronze-tier.svg?avatarHeight=36&width=600&button=false)

# Intro

- Schedule all your social media posts (many AI features)
- Measure your work with analytics.
- Collaborate with other team members to exchange or buy posts.
- Invite your team members to collaborate, comment, and schedule posts.
- At the moment, there is no difference between the hosted version and the self-hosted version
- Perfect for automation (API) with platforms like N8N, Make.com, Zapier, etc.

## Tech Stack

- Pnpm workspaces (Monorepo)
- NextJS (React)
- NestJS
- Prisma (Default to PostgreSQL)
- Temporal
- Resend (email notifications)

## Quick Start

To have the project up and running, please follow the [Quick Start Guide](https://docs.postiz.com/quickstart)

## Sponsor Postiz

We now give a few options to Sponsor Postiz:
- Just a donation: You like what we are building, and want to buy us some coffee so we can build faster.
- Main repository: Get your logo with a backlink from the main Postiz repository. Postiz has over 7M downloads and 20k views per month.

Link: https://opencollective.com/postiz

## Postiz Compliance

- Postiz is an open-source, self-hosted social media scheduling tool that supports platforms like X (formerly Twitter), Bluesky, Mastodon, Discord, and others.
- Postiz hosted service uses official, platform-approved OAuth flows.
- Postiz does not automate or scrape content from social media platforms.
- Postiz does not collect, store, or proxy API keys or access tokens from users.
- Postiz never asks users to paste API keys into our hosted product.
- Postiz users always authenticate directly with the social platform (e.g., X, Discord, etc.), ensuring platform compliance and data privacy.

## License

This repository's source code is available under the [AGPL-3.0 license](LICENSE).

<br /><br />

<p align="center">
  <img src="https://github.com/snyk-labs/secure-developer-sample-repo/raw/main/badge_full.svg" alt="Secure Developer Badge Full" width="150">
</p>
