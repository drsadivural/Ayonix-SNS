# Provider adapter sources

Retrieved on **2026-11-01** with a web fetch of each official page. The fetch tool returns a summary of each page, so
details below are what that summary showed. **Nothing here is live-verified.** No provider credentials were available,
so no real API call was made. The tests in `tests/unit/providers/` are contract tests against fetch doubles.
They are not provider evidence (see docs/10-ACCEPTANCE.md).

Legend: **Verified** = read on the official page on the date above. **Not verified** = from prior knowledge, or the page did not cover it.

## LinkedIn (`linkedin.ts`)

| Source | Version / date shown | What was verified |
|---|---|---|
| https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api | monikers li-lms-2025-11 … **li-lms-2026-10** (default); ms.date 2026-05-07 | `POST https://api.linkedin.com/rest/posts`; headers `Linkedin-Version: YYYYMM` + `X-Restli-Protocol-Version: 2.0.0`; body (author, commentary, visibility, distribution, lifecycleState, isReshareDisabledByAuthor); `content.media.id` for image/video; `content.article` (source/title/description/thumbnail, no URL scraping); MultiImage organic-only; **organic carousel not supported**; post id in the `x-restli-id` header; permissions w_member_social / w_organization_social; 202511 sunsets 2026-11-16 |
| https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api | li-lms-2026-10; ms.date 2026-06-19 | `POST /rest/images?action=initializeUpload` with `initializeUploadRequest.owner`, response `value.uploadUrl` / `value.image`; JPG/GIF/PNG, < 36,152,320 px; **w_member_social tokens cannot GET /rest/images** |
| https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api | li-lms-2026-10; ms.date 2026-02-12 | initializeUpload (owner, fileSizeBytes, uploadCaptions, uploadThumbnail), `uploadInstructions[]` (uploadUrl, firstByte, lastByte), part PUT returns `etag`, `finalizeUpload` (video, uploadToken, uploadedPartIds), status values (PROCESSING, PROCESSING_FAILED, AVAILABLE, WAITING_UPLOAD), MP4, 3 s–30 min, 75 KB–500 MB |
| https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role | li-lms-2026-10; ms.date 2026-04-29 | `GET /rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`; permissions rw_organization_admin / r_organization_admin; elements carry `organization` (or `organizationTarget`) |
| https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics | li-lms-2026-10; ms.date 2026-04-28 | `organizationalEntityShareStatistics` with `shares=List(...)` / `ugcPosts`; needs rw_organization_admin; fields impressionCount, uniqueImpressionsCount, clickCount, likeCount, commentCount, shareCount, engagement |
| https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow | ms.date 2025-11-10 | authorize `https://www.linkedin.com/oauth/v2/authorization` (response_type, client_id, redirect_uri, state, space-delimited scope); token `POST /oauth/v2/accessToken`; response expires_in (60 days), refresh_token only for approved partners, scope |

Not verified (from prior knowledge): OpenID `GET https://api.linkedin.com/v2/userinfo` (`sub`, `name`), the organization lookup `GET /rest/organizations/{id}` (`localizedName`), the reserved characters of the "little" text format, and the programmatic refresh-token request shape.

Decisions:
- PKCE is not sent. The LinkedIn web authorization-code flow does not use it; the docs use state plus client secret.
- Organization scopes (`w_organization_social`, `rw_organization_admin`) are requested only when `env.LINKEDIN_ENABLE_ORGANIZATIONS === 'true'`. LinkedIn rejects the whole authorization when a scope is not assigned to the app. **This optional field still needs adding to `Env` in lib/env.ts.** The adapter reads it through a local type extension.
- Video post polling uses `GET /rest/videos/{urn}`. Member tokens with only w_member_social are write-only for that endpoint, and the doc states this for images. When it returns 403, the post URN LinkedIn returned (201) is recorded as published with `state.video_status = 'unverifiable_with_granted_scopes'`.
- Member post analytics are a restricted permission, so `fetchMetrics` raises `capability` for member connections.
- Disconnect returns `revoked: false`. No general revoke endpoint is used.

## Meta: Facebook Pages (`facebook.ts`) and Instagram via Facebook Login (`instagram.ts`, shared `meta.ts`)

All pages were reachable on 2026-11-01 (no 429). Examples on these pages use **Graph API v26.0**. The adapters use `META_GRAPH_VERSION`.

| Source | What was verified |
|---|---|
| https://developers.facebook.com/docs/pages-api/posts/ | `POST /{page-id}/feed` (message, link, published, scheduled_publish_time), Page access token, photo posts via `/{page-id}/photos` with `url`, feed returns `id`, photos return `id` + `post_id` |
| https://developers.facebook.com/docs/graph-api/reference/page/photos/ | `url`, `caption`, `published=false` for unpublished photos; multi-photo = unpublished photos + `attached_media[n]={"media_fbid":...}` on `/feed`; permissions pages_manage_posts, pages_read_engagement, pages_show_list + CREATE_CONTENT task |
| https://developers.facebook.com/docs/graph-api/reference/page/videos/ | `POST /{page-id}/videos` accepts `file_url`, description, title, published; returns `id`; pages_manage_posts + pages_read_engagement + pages_show_list |
| https://developers.facebook.com/docs/video-api/guides/publishing | `graph-video.facebook.com` host in the examples (this guide shows resumable-upload handles, not file_url) |
| https://developers.facebook.com/docs/video-api/guides/reels-publishing | `/{page-id}/video_reels` upload_phase start → `video_id`; `POST rupload.facebook.com/video-upload/{version}/{video-id}` with `Authorization: OAuth` + `file_url` header → `{success:true}`; finish with `video_state=PUBLISHED`, description; status via `GET /{video-id}?fields=status` (video_status, uploading/processing/publishing phases); 9:16, 3–90 s, ≥540x960 |
| https://developers.facebook.com/docs/graph-api/securing-requests/ | `appsecret_proof` = HMAC-SHA256(access token, app secret). Hex encoding is inferred from the PHP `hash_hmac` example. |
| https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/ | `oauth/access_token` with `grant_type=fb_exchange_token`; about 60 days; Page tokens from `/accounts` with a long-lived user token; no server refresh grant |
| https://developers.facebook.com/docs/graph-api/reference/user/permissions/ | `GET /me/permissions` (permission, status granted/declined/expired). The page documents DELETE of a **single** permission; its return shape is inconsistent (`true` vs `{success}`). |
| https://developers.facebook.com/docs/graph-api/reference/insights/ | Post metrics: `post_impressions`/`_unique` **deprecated from v25**; current: post_media_view, post_total_media_view_unique, post_clicks, post_reactions_like_total, …; read_insights + pages_read_engagement |
| https://developers.facebook.com/docs/instagram-platform/content-publishing/ | `POST /{ig-user-id}/media` (image_url, video_url, media_type REELS/CAROUSEL/VIDEO, is_carousel_item, children, caption); `status_code` IN_PROGRESS/FINISHED/PUBLISHED/ERROR/EXPIRED; `POST /{ig-user-id}/media_publish` creation_id; Facebook-Login path permissions instagram_basic, instagram_content_publish, pages_read_engagement; JPEG only; the publishing limit is stated inconsistently on the page (100 vs 50 per 24 h) |
| https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | Images JPEG ≤ 8 MB, aspect ratio **4:5–1.91:1**, width 320–1440; Reels MOV/MP4, 3 s–15 min, ≤ 300 MB, width ≤ 1920; caption 2200 chars / 30 hashtags / 20 mentions; carousel up to **20** items |
| https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights | Metrics reach, views, likes, comments, shares, saved, total_interactions…; `impressions` deprecated for media after 2024-07-02; instagram_manage_insights |

Not verified: the Facebook Login dialog URL `https://www.facebook.com/{version}/dialog/oauth` and the use of POST rather than GET for `oauth/access_token`; Graph error codes 4/17/32/613/80001–80014 (rate limit), 190 (token), 10/200–299 (permission) and 368 (blocked), which come from prior knowledge; `DELETE /me/permissions` without a permission name revoking the whole grant (the current page documents only per-permission DELETE); the `permalink_url` field on video nodes; `share_to_feed` for Reels.

Decisions:
- Instagram uses only the Facebook Login for Business path, with no `instagram_business_*` scopes. Discovery finds no consumer accounts, because the API returns only Page-linked Business/Creator accounts. When none exist, discovery raises `capability/no_instagram_professional_account` with instructions.
- Carousel validation is capped at 10 items to match `packages/domain` MEDIA_RULES, although Meta now documents up to 20.
- `post_media_view` and `total_interactions` keep `metric: null`. Their definitions do not exactly match views/engagements. `post_impressions` is requested only when the Graph major version is below 25.
- `refreshOrReconnect`: within 7 days of user-token expiry it returns reconnect_required. Otherwise it validates the token with `/me` and returns the **unchanged** token. No refresh happens.
- Instagram `media_publish` is guarded. `pollStatus` sets `receipt.state.publish_requested = true` on the passed receipt **before** the publish call. A later poll that sees the flag without a media id raises `ambiguous` and never publishes again. Callers must persist the receipt even when `pollStatus` throws.

## TikTok (`tiktok.ts`)

| Source | What was verified |
|---|---|
| https://developers.tiktok.com/doc/content-posting-api-reference-direct-post | `POST /v2/post/publish/video/init/`; post_info (privacy_level required and must match creator_info, title ≤2200, disable_duet/comment/stitch, video_cover_timestamp_ms, brand_content_toggle, brand_organic_toggle, is_aigc); source_info FILE_UPLOAD (video_size, chunk_size, total_chunk_count) or PULL_FROM_URL; response publish_id + upload_url; error codes (access_token_invalid, scope_not_authorized, spam_risk_*, reached_active_user_cap, unaudited_client_can_only_post_to_private_accounts, url_ownership_unverified, privacy_level_option_mismatch, rate_limit_exceeded); unaudited clients are private-only; 6 req/min |
| https://developers.tiktok.com/doc/content-posting-api-reference-photo-post | `POST /v2/post/publish/content/init/`; media_type PHOTO, post_mode DIRECT_POST; title ≤90, description ≤4000; PULL_FROM_URL only; photo_images ≤35; photo_cover_index; **URLs must be on a verified domain/prefix** |
| https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status | `POST /v2/post/publish/status/fetch/`; statuses PROCESSING_UPLOAD/PROCESSING_DOWNLOAD/SEND_TO_USER_INBOX/PUBLISH_COMPLETE/FAILED; fail_reason; `publicaly_available_post_id` (list<int64>) empty for private posts and during moderation |
| https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info | `POST /v2/post/publish/creator_info/query/`; fields incl. privacy_level_options, comment/duet/stitch_disabled, max_video_post_duration_sec; some errors arrive with **HTTP 200** |
| https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide | Chunks 5–64 MB (final ≤128 MB), < 5 MB in one chunk, 1–1000 chunks, `Content-Range: bytes first-last/total`; 206 partial / 201 complete; video MP4/WebM/MOV ≤4 GB, 360–4096 px; photos JPEG/WebP ≤20 MB |
| https://developers.tiktok.com/doc/oauth-user-access-token-management | Token `POST https://open.tiktokapis.com/v2/oauth/token/` (client_key, client_secret, code, grant_type, redirect_uri, code_verifier for mobile/desktop only); comma-separated scope; refresh_token grant; revoke `POST /v2/oauth/revoke/` |
| https://developers.tiktok.com/doc/login-kit-web | Authorize `https://www.tiktok.com/v2/auth/authorize/` (client_key, comma scope, response_type, redirect_uri, state). **PKCE is not mentioned for web.** |
| https://developers.tiktok.com/doc/login-kit-desktop | PKCE is required for desktop and uses a **hex** SHA-256 code_challenge, not base64url |

Not verified: `GET /v2/user/info/?fields=open_id,avatar_url,display_name`; `POST /v2/video/query/` metrics fields (view_count, like_count, comment_count, share_count) and its 20-id batch; `is_aigc` placement for photo posts (put in post_info); `auto_add_music`.

Decisions:
- **PKCE is not sent for TikTok.** Login Kit for Web documents no PKCE, and TikTok's desktop PKCE uses a hex challenge that does not match the base64url `AuthorizeInput.codeChallenge`. This deviates from the brief's assumption that TikTok v2 web supports PKCE.
- PUBLISH_COMPLETE with a public id sets remoteId to that id, parsed from the raw JSON to keep int64 precision. PUBLISH_COMPLETE without an id for a non-public privacy level counts as published, with `remoteId = publish_id`, `url = null` and `state.remote_id_is_publish_id = true`. For PUBLIC_TO_EVERYONE posts the adapter keeps polling, because the id may arrive after moderation. After 6 hours it records the post the same way.
- The video init call is not marked `creates`, because nothing posts until the upload completes. The final chunk PUT is marked `creates`. Photo `content/init` is marked `creates`.
- No watermark is added.

## YouTube / Google (`youtube.ts`)

| Source | Page "last updated" | What was verified |
|---|---|---|
| https://developers.google.com/youtube/v3/docs/videos/insert | 2026-10-15 | Upload endpoint; scopes (youtube.upload / youtube / youtubepartner / youtube.force-ssl); 256 GB, video/* or application/octet-stream; **"Videos uploaded from unverified API projects are not restricted to private viewing mode."**; status.publishAt, selfDeclaredMadeForKids, containsSyntheticMedia settable |
| https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol | 2026-10-15 | `uploadType=resumable` + part; X-Upload-Content-Length / X-Upload-Content-Type; Location session URI; chunks in multiples of 256 KB, `308 Resume Incomplete` with Range; 201 with the video resource |
| https://developers.google.com/youtube/v3/docs/videos | 2026-10-15 | uploadStatus deleted/failed/processed/rejected/uploaded; failureReason/rejectionReason values; publishAt only on never-published **private** videos; containsSyntheticMedia; processingDetails.processingStatus; title ≤100 chars, description ≤5000 bytes, no `<` `>`; **no Shorts field** |
| https://developers.google.com/youtube/v3/docs/videos/list | 2026-10-15 | comma-separated `id`; processingDetails is owner-only; 1 unit |
| https://developers.google.com/youtube/v3/docs/videos/delete | 2026-10-15 | scopes youtubepartner / youtube / youtube.force-ssl; 50 units; 204 |
| https://developers.google.com/youtube/v3/docs/channels/list | 2026-10-15 | `mine=true` for the authorized user. The scopes for mine=true were not stated on the page summary. |
| https://developers.google.com/youtube/analytics/reference/reports/query | 2026-10-15 | `GET https://youtubeanalytics.googleapis.com/v2/reports` (ids=channel==MINE, startDate, endDate, metrics, dimensions, filters `video==a,b` up to 500); yt-analytics.readonly, **and the page says requests now also require youtube.readonly** |
| https://developers.google.com/identity/protocols/oauth2/web-server | (truncated) | authorize `https://accounts.google.com/o/oauth2/v2/auth` (space-delimited scope, access_type=offline, state, include_granted_scopes, prompt); token `https://oauth2.googleapis.com/token`; `scope` in the response = granted scopes; refresh_token only with offline; revoke `POST https://oauth2.googleapis.com/revoke`; invalid_grant meaning |
| https://developers.google.com/identity/protocols/oauth2/native-app | 2026-10-30 | PKCE `code_challenge` / `code_challenge_method=S256` (base64url SHA-256) and `code_verifier` |

Not verified: PKCE acceptance on Google's **web-server** client type (the web-server page summary was truncated; PKCE was confirmed on the native-app page); Google error `reason` strings (quotaExceeded, rateLimitExceeded, insufficientPermissions…), which come from prior knowledge.

Decisions:
- Default scopes are youtube.upload, youtube.readonly and yt-analytics.readonly. Deleting videos needs youtube.force-ssl, which is not requested by default. Native scheduling (`publishAt`) is therefore reported `unavailable` and rejected in `validatePost` unless a delete-capable scope was granted. This keeps a native schedule cancellable.
- `cancelNativeSchedule` re-reads the video and deletes only when it is still `private` with a future `publishAt`. Call it only before publishAt.
- The URL is always `https://www.youtube.com/watch?v={id}`, because the API cannot tell whether a video is a Short.
- The resumable session URI is never persisted. Upload and creation both happen in `submitPost`.
