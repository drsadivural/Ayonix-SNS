// Website authentication via Better Auth (maintained library): email +
// password with mandatory email verification, password reset, sessions in
// D1, optional Google OIDC. MCP OAuth is a separate flow (auth/mcp-oauth.ts).
import { betterAuth } from 'better-auth';
import type { Env } from '../lib/env.js';
import { isLocal } from '../lib/env.js';
import { nowIso } from '../lib/ids.js';
import { run } from '../lib/db.js';
import { sendEmail } from '../services/email.js';

export function createAuth(env: Env) {
  const google =
    env.AUTH_GOOGLE_CLIENT_ID && env.AUTH_GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.AUTH_GOOGLE_CLIENT_ID, clientSecret: env.AUTH_GOOGLE_CLIENT_SECRET, prompt: 'select_account' as const } }
      : {};
  return betterAuth({
    appName: 'Ayonix-SNS',
    baseURL: env.APP_ORIGIN,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [env.APP_ORIGIN],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(env, {
          to: user.email,
          template: 'password_reset',
          subject: 'Reset your Ayonix-SNS password',
          text: `Someone asked to reset the password for ${user.email}.\n\nReset it here (valid for one hour): ${url}\n\nIf this was not you, ignore this email.`,
          identityId: user.id,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(env, {
          to: user.email,
          template: 'verify_email',
          subject: 'Verify your Ayonix-SNS email',
          text: `Welcome to Ayonix-SNS.\n\nVerify your email address to continue: ${url}`,
          identityId: user.id,
        });
      },
    },
    socialProviders: google,
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, freshAge: 60 * 15 },
    rateLimit: { enabled: !isLocal(env), window: 60, max: 30 },
    advanced: {
      useSecureCookies: !isLocal(env),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: !isLocal(env) },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await run(env, 'INSERT OR IGNORE INTO identities(id, email, display_name, created_at) VALUES (?,?,?,?)', user.id, user.email, user.name ?? '', nowIso());
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
