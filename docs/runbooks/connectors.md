# Connector setup (production: https://sns.ayonix.com)

The five connectors are implemented in `apps/worker/src/providers/` and covered by contract tests
with fetch doubles. None has been exercised against a real provider yet. A connector shows as
**unavailable** on the Connectors page until its keys are set. Then each network's own review decides
what it can do (see "Before review" in each section).

Run every `secret put` command from `/home/azureuser/projects/Ayonix-SNS`. Wrangler prompts for the
value and does not echo it. Never paste keys into chat, tickets or commits. New secrets take effect
immediately; no redeploy is needed.

## Shared requirements

All four developer portals ask for these. Have them ready first:

| Item | Value |
|---|---|
| App / website URL | `https://sns.ayonix.com` |
| Privacy policy URL | `https://sns.ayonix.com/privacy` |
| Terms of service URL | `https://sns.ayonix.com/terms` |
| App icon | 1024×1024 PNG of the Ayonix-SNS mark |
| Contact email | an inbox you monitor |

**Blocker:** `/privacy` and `/terms` currently show "Legal text pending approval". Meta, TikTok and
Google reviewers reject apps whose policy pages are placeholders. Publish approved legal text before
submitting any review.

Redirect (callback) URLs, one per connector, must match exactly:

| Connector | Redirect URL |
|---|---|
| LinkedIn | `https://sns.ayonix.com/oauth/linkedin/callback` |
| Facebook Pages | `https://sns.ayonix.com/oauth/facebook/callback` |
| Instagram | `https://sns.ayonix.com/oauth/instagram/callback` |
| TikTok | `https://sns.ayonix.com/oauth/tiktok/callback` |
| YouTube | `https://sns.ayonix.com/oauth/youtube/callback` |

## LinkedIn

Portal: https://www.linkedin.com/developers/apps

1. Create an app. Associate it with the Ayonix company page (a page admin must approve the association).
2. Under **Products**, add **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**.
   Both are self-serve and grant `openid`, `profile` and `w_member_social`.
3. Under **Auth**, add the LinkedIn redirect URL above.
4. Set the keys:
   ```bash
   npx wrangler secret put LINKEDIN_CLIENT_ID --env production
   npx wrangler secret put LINKEDIN_CLIENT_SECRET --env production
   ```

Result: members can connect their personal profile and publish text, link, image and video posts.

**Company pages** need the **Community Management API**, a vetted product. LinkedIn accepts the
Development-tier request only on a *new* app with no other products, and Standard tier requires a
screencast of each use case. Once approved:

- Set `"LINKEDIN_ENABLE_ORGANIZATIONS": "true"` in the production `vars` in `wrangler.jsonc` and deploy.
  The connector then also requests `w_organization_social` and `rw_organization_admin`.
- If the approved app cannot also carry the OpenID Connect product, the member profile lookup
  (`/v2/userinfo`) needs a code change before switching credentials to that app.

Not available on any tier: analytics for personal posts (`r_member_social` is closed). Personal posts
therefore show metrics as "Not available".

API version: `LINKEDIN_API_VERSION` is `202610` in `wrangler.jsonc`. LinkedIn sunsets each version
about a year after release, so bump it periodically.

## Meta: Facebook Pages and Instagram

Portal: https://developers.facebook.com/apps. One Meta app serves both connectors.

1. Create a **Business** app, owned by the Ayonix business portfolio. Complete **Business
   verification** in Meta Business Settings; advanced access requires it.
2. Add **Facebook Login for Business**. Under its settings:
   - Valid OAuth Redirect URIs: both the Facebook and Instagram redirect URLs above.
   - Deauthorize callback URL: `https://sns.ayonix.com/webhooks/meta/deauthorize`
   - Data deletion request URL: `https://sns.ayonix.com/webhooks/meta/data-deletion`
3. Create two Login **configurations** (user access token):
   - Facebook: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`
   - Instagram: `instagram_basic`, `instagram_content_publish`, `pages_show_list`,
     `pages_read_engagement`, `instagram_manage_insights`
4. Set the keys:
   ```bash
   npx wrangler secret put META_APP_ID --env production
   npx wrangler secret put META_APP_SECRET --env production
   npx wrangler secret put META_FACEBOOK_CONFIG_ID --env production
   npx wrangler secret put META_INSTAGRAM_CONFIG_ID --env production
   ```
   With the configuration IDs set, the login dialog sends `config_id` instead of a scope list, as Meta
   recommends for business apps. Without them it falls back to the scope list.

Before review: only people with a role on the app (admin, developer, tester) can connect. To open it
to customers, submit **App Review** for advanced access to every permission above, with a screencast
of connecting a Page, scheduling a post and viewing its metrics.

Instagram requirements: the account must be an Instagram **Business or Creator** account linked to a
Facebook Page the user manages. Personal accounts cannot be connected; the app explains this when
none is found. Instagram images must be JPEG.

API version: `META_GRAPH_VERSION` is `v26.0` in `wrangler.jsonc`.

## TikTok

Portal: https://developers.tiktok.com/apps

1. Create an app (organization: Ayonix). Fill in the shared details above.
2. Add products **Login Kit** (platform: Web, redirect URL above) and **Content Posting API**, with
   **Direct Post** enabled.
3. Scopes: `user.info.basic`, `video.publish`, `video.list`.
4. Under **URL properties**, verify the URL prefix `https://sns.ayonix.com/u/media/` (or the domain
   `sns.ayonix.com`) by adding TikTok's DNS TXT record in Cloudflare. Photo posts pull media from
   that address and fail with `url_ownership_unverified` without it.
5. Set the keys:
   ```bash
   npx wrangler secret put TIKTOK_CLIENT_KEY --env production
   npx wrangler secret put TIKTOK_CLIENT_SECRET --env production
   ```

Before review: an unaudited app can post only to **private** (`SELF_ONLY`) accounts, for a small
number of users. Submit the app for review and the Content Posting API **audit** to post publicly.
Every TikTok post still waits for the creator's approval on Ayonix's TikTok approval page; that is a
TikTok requirement and stays after the audit.

## YouTube (Google)

Portal: https://console.cloud.google.com

1. Create a project, for example "Ayonix-SNS".
2. **APIs & Services → Library**: enable **YouTube Data API v3** and **YouTube Analytics API**.
3. **Google Auth Platform**:
   - Branding: app name, support email, home page `https://sns.ayonix.com`, the privacy and terms URLs,
     authorized domain `ayonix.com` (verify it in Google Search Console if asked).
   - Audience: External. While in *Testing*, add the Google accounts that may connect.
   - Data access: add `youtube.upload`, `youtube.readonly` and `yt-analytics.readonly`.
   - Clients: create a **Web application** client with the YouTube redirect URL above.
4. Set the keys:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID --env production
   npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
   ```

Before verification: only listed test users can connect, and Google expires their refresh tokens
after 7 days, so connections need reconnecting weekly. Submit the app for **verification**; these
scopes are sensitive and need a demo video. The default API quota is 10,000 units a day, and an upload
costs about 100 units. Request more quota in the console when needed.

Native YouTube scheduling (`publishAt`) stays off because it needs the broader `youtube.force-ssl`
scope to stay cancellable. Ayonix's own scheduler publishes at the scheduled time instead.

## Checking a connector after setup

1. Sign in at https://sns.ayonix.com, open **Connectors** and connect the account.
2. Schedule a post a few minutes ahead (use a private or test account where the network allows).
3. Confirm it publishes, opens at the link Ayonix shows, and that metrics appear on the next daily run.
4. Record the result against the matching check in `evidence/` (LI-01, FB-01, IG-01, TT-01, YT-01).
