# Content Studio roadmap

Status: 2026-11-06, Review 20 (H8.5 release hardening, before RC2).
Branch: `nlw/content-studio-security-sync`. Production runs `nlw-v1.0.2`
(no Content Studio tables); `nlw-v1.1.0-rc.1` is the parked release
candidate.

Every statement here carries one of three labels:

- **SOURCE_CONFIRMED**: written in the original architecture or proven in code.
- **RECONSTRUCTED_FROM_IMPLEMENTATION**: read back from what the code does;
  no planning document says it.
- **NEW_RECOMMENDATION**: a proposal from the Review 18-20 audits, not a
  decision yet.

"H1-H10" is **not** an original roadmap. The name first appears in the Review
18 prompt (2026-11-06). Where this document uses H-numbers it maps them to the
original phases.

## 1. Original plan: Phase 0-10 (SOURCE_CONFIRMED)

Defined in the "Phase 4: Content Studio master architecture (design only)"
answer of 2026-10-11. Until this file existed, the plan lived only in that
working session; no repository file held it.

| Phase | Name | Delivers (summary of the original) |
|---|---|---|
| P0 | Platform prerequisites | SafeFetch (SSRF-safe dispatcher), organization-scoped Media getter, SecretBox, composer preview XSS fix, guard against env AI keys in Content Studio |
| P1 | Studio core, packages and handoff (no AI) | projects, packages (global, thread, variant copy), Media attachments, revisions, "Use in post" handoff |
| P2 | AI connections, text generation, editorial intelligence v1 | per-organization AI connections (create, test, rotate, revoke), resolver with no fallback, text generation, metering, writing profiles, editorial policy, audiences |
| P3 | Sources and grounding | URL, RSS and text sources with versions, article to social, verified quotes and claims, drift notices |
| P4 | Brand, design documents, templates and rendering | brand profiles, built-in templates, slot editing, shared layout engine, server render to Media (fontkit, Sharp) |
| P5 | Review and approvals | submit, approve, reject, approval-gated handoff per organization policy, review queue, role checks |
| P6 | Visual editor and creative tools | editor bridge, freeform layers, locks, AI design patches, organization templates, `image.generate`, more adapters |
| P7 | Library and reuse | library items and collections, snippets, approved-asset reuse, global packs |
| P8 | Research, News Radar and expertise knowledge | topics, watches and runs, multi-source packages, expertise sources, search through an organization connection |
| P9 | Interview / transcript and video studio | transcription to transcript sources with time ranges, timestamped quotes, video jobs reusing clipping patterns |
| P10 | Productization | managed AI mode (entitlement, ledger, reserve/capture/release), outbound MCP tool sources, Content Studio tools on the inbound Postiz MCP, public API ("if wanted") |

Dutch (NL) interface translation was never one of these phases. Review 13
planned it as a separate `nlw/dutch-translation` branch (SOURCE_CONFIRMED).

## 2. Current status (RECONSTRUCTED_FROM_IMPLEMENTATION, verified in Reviews 18-20)

| Phase | Status | Notes |
|---|---|---|
| P0 | done | SafeFetch, scoped Media, SecretBox, XSS fix, architecture guard (`content-studio.architecture.spec.ts`) |
| P1 | done | packages, revisions, handoff to the composer |
| P2 | done | OpenAI, OpenRouter, Anthropic and Codex connections; Codex is off by default since Review 20 (`CONTENT_STUDIO_ENABLE_CODEX`) |
| P3 | done | sources, versions, grounding, page changes, retention (P8-R1C) |
| P4 | done | Brand Kit, Design Document v1, templates, page sets, layout patterns, style presets, server renderer; bundled Noto Sans default font since Review 20 |
| P5 | done | reviews, claims, approval, approval-gated handoff; administrators decide since Review 20, never on their own request |
| P6 | mostly absorbed by P4 | editor and AI design proposals exist; no `image.generate` |
| P7 | mostly absorbed by P4 | blocks and templates; no separate library |
| P8 | done, expanded | research, News Radar, discoveries, source changes, retention |
| P9 | not started | no audio, transcript or video in Content Studio (upstream Postiz has building blocks) |
| P10 | not started | no Content Studio public API, no Content Studio MCP tools, no managed AI ledger |

## 3. H8.5: release hardening for v1.1.0 (Review 20, SOURCE_CONFIRMED in code)

In scope, done in Review 20:

- M1 bundled default render font (Noto Sans 2.015, OFL) and a Render fonts panel
- M2 Codex provider behind `CONTENT_STUDIO_ENABLE_CODEX` (default off)
- M3 no AI prompts or outputs recorded by Sentry; raw prompt logging removed
- M4 interface language no longer sets the content language
- M5 post updates and group sweeps scoped to the organization
- M6 public API post type explicit; a missing type is a draft
- S1 JWT purposes; reset, invite and activation links no longer work as sessions
- S2 approval decided by administrators only, never self-approval
- S3 per-user rate limits on expensive Content Studio routes
- S4 the only active profile of a kind is preselected in AI dialogs
- S5 Content Studio PostgreSQL and Temporal suites in CI

Deferred out of v1.1.0 (NEW_RECOMMENDATION): render to post, approval
enforced on every publish surface, quotas or credits, token expiry for
sessions, session revocation.

## 4. Rebaseline after v1.1.0 (NEW_RECOMMENDATION)

Order of work once v1.1.0 is stable:

1. **Foundation contracts** (no new product surface): a request context
   (organization, actor, role, origin), capability checks shared by the
   dashboard, public API and MCP, an append-only audit event, idempotency
   keys for writes, a Post link from a handoff to the posts it created, a job
   view for long-running work, a usage event outbox.
2. **H10A: Content Studio public API v1** (original P10 "public API"), built
   on those contracts, with an explicit publish confirmation.
3. **H9A: audio and transcript sources** (original P9, first half).
4. **H10B: Content Studio MCP tools** (original P10), through the gateway.
5. **H9B: video studio** (original P9, second half).
6. **Control Plane adapters** (section 5).

Approval enforcement on every publish surface needs items 1 (capabilities and
the Post link) and belongs there, not in a release-hardening RC.

## 5. Control Plane compatibility (NEW_RECOMMENDATION)

The intended Control Plane:

- **ContextForge**: MCP and API gateway
- **authentik**: identity provider
- **OpenBao**: secrets vault
- **OpenMeter**: usage, limits and credits

Applications behind it: CompanyOS, Content Studio, Hermes, Make / n8n and
future NLW apps.

Rules for Content Studio until the adapters exist:

- no hard dependency on any of the four; each arrives as an adapter behind an
  existing seam (the AI provider gate and resolver, SecretBox, the throttler,
  the auth middleware);
- gateway policy is an **additional** defense, never the only one: Content
  Studio keeps its own organization scoping, role checks, rate limits and
  validation;
- metering moves from the in-process rate limit to OpenMeter usage events
  through the outbox, without changing the routes.

## 6. Dutch translation (NEW_RECOMMENDATION)

A separate branch from the stable v1.1.0 commit (`nlw/dutch-translation`),
independent of the phases above. Content Studio strings are already keyed
(`content_studio_*` in `libraries/react-shared-libraries/src/translation`).
Since Review 20 the interface language no longer sets the content language,
so a Dutch interface can write English posts and the other way round.
