const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? JSON_HEADERS : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

async function jsonError(res) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  throw new Error(data?.error || `Request failed (${res.status})`);
}

export const api = {
  state: () => request('GET', '/api/state'),
  // The profile route reads fields off the top level of the body, so this must
  // not be wrapped in a "profile" key - wrapping it made saves a silent no-op.
  saveProfile: (profile) => request('PUT', '/api/profile', profile),
  saveAssumptions: (assumptions) => request('PUT', '/api/settings', { assumptions }),
  saveTax: (tax) => request('PUT', '/api/settings', { tax }),
  saveTargetAllocation: (targetAllocation) => request('PUT', '/api/settings', { targetAllocation }),
  createHolding: (holding) => request('POST', '/api/holdings', holding),
  updateHolding: (id, holding) => request('PUT', `/api/holdings/${id}`, holding),
  deleteHolding: (id) => request('DELETE', `/api/holdings/${id}`),
  bulkDeleteHoldings: (ids) => request('POST', '/api/holdings/bulk-delete', { ids }),
  createGoal: (goal) => request('POST', '/api/goals', goal),
  updateGoal: (id, goal) => request('PUT', `/api/goals/${id}`, goal),
  deleteGoal: (id) => request('DELETE', `/api/goals/${id}`),
  refreshFx: () => request('POST', '/api/fx/refresh'),
  refreshPrices: (ids) => request('POST', '/api/prices/refresh', ids && ids.length ? { ids } : {}),
  pinRate: (code, manualRate) => request('PUT', `/api/fx/${code}`, { manualRate }),
  snapshot: () => request('POST', '/api/snapshot'),
  seed: () => request('POST', '/api/seed'),
  reset: () => request('POST', '/api/reset'),
  import: (doc) => request('PUT', '/api/import', doc),

  // Dated backup copies. Downloading one needs no method: the route is a GET that
  // answers with an attachment header, so a plain <a download> link hands over the
  // exact bytes a restore would put back.
  listBackups: () => request('GET', '/api/backups'),
  createBackup: () => request('POST', '/api/backups'),
  restoreBackup: (name) => request('PUT', `/api/backups/${encodeURIComponent(name)}/restore`),
  deleteBackup: (name) => request('DELETE', `/api/backups/${encodeURIComponent(name)}`),
  saveEmail: (email) => request('PUT', '/api/settings', { email }),
  savePhoneAccess: (phoneAccess) => request('PUT', '/api/settings', { phoneAccess }),
  revokePhones: () => request('POST', '/api/access/revoke'),

  // A PDF arrives as bytes, not JSON, so it cannot go through request(). The blob
  // URL is revoked by the caller once the browser has taken the file.
  reportDownload: async (payload) => {
    const res = await fetch('/api/report/pdf', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) await jsonError(res);
    const name = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') || '');
    const blob = await res.blob();
    return {
      url: URL.createObjectURL(blob),
      fileName: name ? name[1] : 'wealth-report.pdf',
      bytes: blob.size,
      pages: Number(res.headers.get('X-Report-Pages')) || null,
      sections: Number(res.headers.get('X-Report-Sections')) || null,
    };
  },
  reportEmail: (payload) => request('POST', '/api/report/email', payload || {}),
};
