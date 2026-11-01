import pricing from '../pricing.json' with { type: 'json' };
import mcpTools from '../mcp-tools.json' with { type: 'json' };

export { pricing, mcpTools };
export * from './api.js';

export type PricingCatalog = typeof pricing;
export type McpToolContract = (typeof mcpTools)['tools'][number];
