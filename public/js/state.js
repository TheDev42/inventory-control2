import { api } from './util.js';

export const app = { meta: null };

export async function loadMeta() {
  app.meta = await api.get('/api/meta');
  return app.meta;
}

// Connector suggestions can grow as new values are entered
export async function refreshConnectors() {
  try { app.meta = await api.get('/api/meta'); } catch { /* keep old */ }
}
