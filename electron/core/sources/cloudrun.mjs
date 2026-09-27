// Cloud Run (read-only): status of services like flobi-artwork-render.
import { json } from '../net/http.mjs';

export async function listCloudRunServices({ projectId, location, getToken }) {
  const res = await json({
    url: `https://run.googleapis.com/v2/projects/${projectId}/locations/${location}/services`,
    headers: { authorization: `Bearer ${await getToken()}` },
    timeoutMs: 30_000,
  });
  return (res?.services || []).map((s) => {
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
