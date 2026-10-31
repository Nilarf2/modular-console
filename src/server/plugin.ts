import type { FastifyInstance } from 'fastify';
import type { Settings } from '../shared/types.js';
import type { Store } from './store.js';

/** Trusted build-time server plugin API, version 1. Authentication wraps /api routes. */
export interface ServerPluginContext {
  app: FastifyInstance;
  store: Store;
  now: () => number;
  origin?: string;
  demo: boolean;
  getSettings: () => Settings;
  saveSettings: (settings: Settings) => void;
}
