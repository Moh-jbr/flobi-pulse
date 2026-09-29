// Cloud Run (read-only): status of services like flobi-artwork-render.
import { json } from '../net/http.mjs';

/** Pages of services read at most (Google pages long lists with nextPageToken). */
const MAX_PAGES = 10;

/** `request` is only replaced by tests. */
export async function listCloudRunServices({ projectId, location, getToken, request = json }) {
  const url = `https://run.googleapis.com/v2/projects/${projectId}/locations/${location}/services`;
  const services = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await request({
      url: pageToken ? `${url}?${new URLSearchParams({ pageToken })}` : url,
      headers: { authorization: `Bearer ${await getToken()}` },
      timeoutMs: 30_000,
    });
    services.push(...(res?.services || []));
    pageToken = res?.nextPageToken || null;
    if (!pageToken) break;
  }
  return services.map((s) => {
    const name = s.name.split('/').pop();
    const ready = s.terminalCondition || (s.conditions || []).find((c) => c.type === 'Ready') || {};
    return {
      name,
      url: s.uri,
      ready: ready.state === 'CONDITION_SUCCEEDED',
      reason: ready.reason || ready.message || null,
      revision: (s.latestReadyRevision || '').split('/').pop(),
      updatedAt: Date.parse(s.updateTime),
    };
  });
}
