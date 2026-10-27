import fs from 'node:fs/promises';
import path from 'node:path';

const V = process.env.IG_API_VERSION || 'v26.0';
const TOKEN = process.env.IG_ACCESS_TOKEN;
const UID = process.env.IG_USER_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(url, { method, headers: { Authorization: `OAuth ${TOKEN}`, ...headers }, body });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json.error || json.success === false) throw new Error(`Instagram API ${res.status}: ${text.slice(0, 600)}`);
  return json;
}

async function waitUntilReady(containerId) {
  for (let i = 0; i < 40; i++) {
    const s = await api(`https://graph.facebook.com/${V}/${containerId}?fields=status_code,status`, { method: 'GET' });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram processing failed: ${JSON.stringify(s)}`);
    await sleep(10000);
  }
  throw new Error('Timed out waiting for Instagram to process the video');
}

async function publish(containerId) {
  const r = await api(`https://graph.facebook.com/${V}/${UID}/media_publish`, {
    body: new URLSearchParams({ creation_id: containerId })
  });
  return r.id;
}

// Method 1 (default): upload the file straight to Meta, no public hosting needed.
async function viaResumable(file, caption) {
  const size = (await fs.stat(file)).size;
  const c = await api(`https://graph.facebook.com/${V}/${UID}/media`, {
    body: new URLSearchParams({ media_type: 'REELS', upload_type: 'resumable', caption })
  });
  await api(c.uri || `https://rupload.facebook.com/ig-api-upload/${V}/${c.id}`, {
    headers: { offset: '0', file_size: String(size) },
    body: await fs.readFile(file)
  });
  await waitUntilReady(c.id);
  return publish(c.id);
}

// Method 2 (fallback, needs a PUBLIC repo): host the video as a temporary GitHub release asset.
async function uploadToRelease(file) {
  const repo = process.env.GITHUB_REPOSITORY;
  const gh = process.env.GITHUB_TOKEN;
  if (!repo || !gh) throw new Error('GITHUB_REPOSITORY / GITHUB_TOKEN missing for URL fallback');
  const head = { Authorization: `Bearer ${gh}`, Accept: 'application/vnd.github+json' };
  const tag = `media-${Date.now()}`;
  const relRes = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: head,
    body: JSON.stringify({ tag_name: tag, name: tag, prerelease: true })
  });
  const rel = await relRes.json();
  if (!relRes.ok) throw new Error('GitHub release failed: ' + JSON.stringify(rel).slice(0, 300));
  const assetRes = await fetch(`https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${path.basename(file)}`, {
    method: 'POST',
    headers: { ...head, 'Content-Type': 'video/mp4' },
    body: await fs.readFile(file)
  });
  const asset = await assetRes.json();
  if (!assetRes.ok) throw new Error('GitHub asset upload failed: ' + JSON.stringify(asset).slice(0, 300));
  return {
    url: asset.browser_download_url,
    cleanup: async () => {
      await fetch(`https://api.github.com/repos/${repo}/releases/${rel.id}`, { method: 'DELETE', headers: head }).catch(() => {});
      await fetch(`https://api.github.com/repos/${repo}/git/refs/tags/${tag}`, { method: 'DELETE', headers: head }).catch(() => {});
    }
  };
}

async function viaUrl(file, caption) {
  const { url, cleanup } = await uploadToRelease(file);
  try {
    const c = await api(`https://graph.facebook.com/${V}/${UID}/media`, {
      body: new URLSearchParams({ media_type: 'REELS', video_url: url, caption })
    });
    await waitUntilReady(c.id);
    return await publish(c.id);
  } finally {
    await cleanup();
  }
}

export async function publishReel(file, caption) {
  if (!TOKEN || !UID) throw new Error('IG_ACCESS_TOKEN and IG_USER_ID secrets are missing');
  try {
    return await viaResumable(file, caption);
  } catch (e) {
    console.error('Direct upload failed:', e.message);
    if (process.env.IG_FALLBACK_URL !== 'true') throw e;
    console.log('Trying public URL fallback...');
    return viaUrl(file, caption);
  }
}
