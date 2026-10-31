import type { ServerPluginContext } from '../server/plugin.js';
import { registerHosts } from './hosts/server.js';
import { registerNewApi } from './newapi/server.js';

// Explicit composition: adding a trusted data provider does not change auth, SSE, or storage lifecycle.
export function registerServerPlugins(context: ServerPluginContext) {
  const hosts = registerHosts(context);
  const newapi = registerNewApi(context);
  return {
    hosts, newapi,
    snapshot: () => ({ nodes: hosts.nodes(), connections: newapi.connections() }),
    close: async () => { hosts.close(); await newapi.close(); },
  };
}
