declare namespace Cloudflare {
  interface Env extends Omit<import('../src/lib/env.js').Env, 'OAUTH_PROVIDER'> {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
