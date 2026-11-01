# 4. Real provider integrations

Before coding each adapter, re-fetch official current docs, select a supported API version, record granted scopes and run a capability probe. Endpoint paths here are integration guidance, not permission to assume access. Meta docs returned 429 in this research environment; exact scopes/version and account eligibility remain a mandatory implementation-time verification gate.

## Common adapter contract

Each adapter implements authorizeUrl, exchangeCode, discoverAccounts, probeCapabilities, refreshOrReconnect, validatePost, uploadMedia, submitPost, pollStatus, fetchMetrics and disconnect. If a provider has no refresh mechanism, refreshOrReconnect must return an explicit reconnect requirement. Unsupported formats/metrics return structured capability errors, never fabricated data. Disconnect revokes when supported, destroys local tokens and pauses pending targets; it does not delete already-public posts without a distinct user request.

Persist account ID/name/type, granted scopes, expiry, last verification, API version and capability flags separately from encrypted token blobs. UI connection states: disconnected, authorizing, pending_review, connected, expiring, reconnect_required, restricted, error. “Connected” means account discovery succeeded, not that every publishing or insight capability is granted.

## LinkedIn

Use official OAuth and the Posts API, with supported Linkedin-Version and X-Restli-Protocol-Version headers. Request member publishing access for personal profiles and organization publishing access for Pages; verify the signed-in member has the required Page role. Broader community-management/read/analytics access may need approval. Request minimal scopes and record the actual approved set.

Support text, single/multiple images, link posts and video where approved. Implement the real image/video upload initialization and transfer, then create the post using its returned asset URN. Persist the post URN returned by the provider and obtain the canonical URL when available. Validate allowed organic formats: do not label an unsupported organic carousel API as working. Do not copy LinkupAPI's outreach/DM behavior into this product.

Read authorized organization/member metrics only when the granted product permits them. Display unavailable values clearly. Never request LinkedIn passwords, cookies or browser extensions as an API substitute.

## Facebook

Implement Pages publishing using a verified Meta developer app, Facebook Login, Page selection and the approved permissions for Page discovery, reading engagement and managing posts. Personal-profile automated publishing is outside this product. Verify the current permission set in Meta docs and app review rather than assuming this document grants it.

Use Page feed/photo/video or the current Reels publishing flow appropriate to the media. Photo/video upload can be asynchronous. Inspect final provider errors and processing state before marking published. Prove Page identity and role, token lifecycle, app-secret protections, callback signature validation, deauthorization and deletion callbacks. Prove link, image, video and supported Reels separately. No browser posting fallback.

## Instagram

Support Professional accounts using a single documented Meta login path. Prefer Instagram Login if it supplies the required capabilities; if using Facebook Login, implement its required Page association. Do not mix scope names/token types between the two paths. Discover eligibility and reject unsupported consumer accounts with a useful explanation.

Create an owned-media container, poll readiness and invoke media publishing; persist container and final media ID separately. Implement single images, carousel and Reels with current supported media constraints; Stories only if the account/API path permits. No plain text publishing. Publicly retrievable media must be on controlled URLs with a valid fetch window and verified ownership; never expose R2 credentials. Validate dimensions, aspect ratio, codec, size/duration and current provider rate limits on the server.

## TikTok

Implement Login Kit and Content Posting API with approved publishing scope. Direct Post needs audit for public distribution; unreviewed operation is limited. The app is intended as a multi-customer SaaS, not an internal uploader. Recheck audit eligibility.

At approval, fetch creator info, show account identity, supported privacy options without a preselected value, permitted interactions, editable title, preview, commercial-content disclosures and required consent. Bind approval to the exact asset/caption/settings. Revalidate creator constraints at dispatch; pause if they change. Record approved consent. A blanket ChatGPT instruction alone cannot satisfy this flow.

Use init/upload or verified-domain URL pull as documented, persist publish_id, then poll status or verify signed callbacks. Do not mark accepted uploads as published. Photos/videos require distinct validation. Respect creator and app caps; no blind retries after an ambiguous result. No added Ayonix watermark.

## YouTube

Use Google OAuth and YouTube Data API with minimal upload permission, channel selection and the Analytics read scope only when needed. Implement resumable uploads, status polling and final video ID/URL. Shorts are a format of video, not a separate text-post endpoint. Plain text/community-post publishing is not promised.

Explicitly capture title, description, audience/made-for-kids, visibility and synthetic-media disclosure when required. For native future publication, use the documented private/upload + publishAt requirements; do not also schedule a second upload. Choose exactly one scheduling owner per target. Cancellation/changes must reconcile the native schedule.

Important freshness finding: the live videos.insert reference retrieved on 30 October 2026 states unverified projects are NOT restricted to private viewing, conflicting with older audit guidance and search snippets. Do not hardcode the old restriction. Recheck current official behavior, OAuth verification and quota/audit requirements for the actual project, and prove requested visibility on a real authorized upload. Record discrepancies; capability probes and real results decide availability.

## Metrics

Collect available authorized metrics daily and after publication using per-provider jobs and backoff. Normalize impressions, reach, views, likes, comments, shares, saves, clicks, followers and engagement only where defined/available. Store raw metric names, provider, account/post, period, aggregation, retrieved_at and schema version. Missing ≠ zero. No combined unique reach across providers. A total engagement rate is a weighted calculation with a stated denominator, not an average of percentages. Preserve estimated/provider-delayed labels. Do not claim sales or ROI without real conversion data.

## Mandatory provider evidence

For every supported format capture redacted request correlation, actual response ID, receipt/status, correct destination and live URL/visibility observed in the platform. Also test denied scope, revoked/expired token, invalid media, rate limiting and partial campaign failure. Keep unit fault injection separate from live evidence. Disabled/unapproved adapters are BLOCKED; they cannot be sold as enabled.
