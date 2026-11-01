import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Contract/integration tests run inside workerd with real local D1, R2, KV,
// Queues and the Durable Object coordinator. Provider HTTP is never live here.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, '../../migrations'));
      return {
        main: './src/index.ts',
        wrangler: { configPath: '../../wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: 'test',
            APP_ORIGIN: 'http://localhost:8787',
            BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
            TOKEN_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
            SIGNING_KEY: 'signing-key-signing-key-signing-key-0123',
            STRIPE_SECRET_KEY: 'sk_test_contract_double',
            STRIPE_WEBHOOK_SECRET: 'whsec_contract_test_secret',
            STRIPE_BASIC_PRICE_ID: 'price_basic_test',
            STRIPE_STANDARD_PRICE_ID: 'price_standard_test',
            STRIPE_PREMIUM_PRICE_ID: 'price_premium_test',
            STRIPE_PRODUCT_ID: 'prod_test',
          },
        },
      };
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
