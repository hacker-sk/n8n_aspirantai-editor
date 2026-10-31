import fs from 'node:fs/promises';
import path from 'node:path';

// News reel -> Buffer (via n8n). Uploads the video to a temporary GitHub release
// (public repo = public URL), then tells the n8n webhook to schedule it in Buffer.
const REPO = process.env.GITHUB_REPOSITORY;
const GH = process.env.GITHUB_TOKEN;
const HOOK = process.env.N8N_BUFFER_WEBHOOK_URL;
const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // Buffer fetches the file when the post goes out, so keep it a few days
const head = { Authorization: 'Bearer ' + GH, Accept: 'application/vnd.github+json' };

async function cleanupOldMedia() {
  try {
    const res = await fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=100', { headers: head });
    if (!res.ok) return;
    const releases = await res.json();
    for (const rel of releases) {
      if (!String(rel.tag_name).startsWith('media-')) continue;
      if (Date.now() - new Date(rel.created_at).getTime() < KEEP_MS) continue;
      await fetch('https://api.github.com/repos/' + REPO + '/releases/' + rel.id, { method: 'DELETE', headers: head }).catch(() => {});
      await fetch('https://api.github.com/repos/' + REPO + '/git/refs/tags/' + rel.tag_name, { method: 'DELETE', headers: head }).catch(() => {});
    }
  } catch (e) {
    console.error('Old media cleanup skipped:', e.message);
  }
}

async function uploadToRelease(file) {
  const tag = 'media-' + Date.now();
  const relRes = await fetch('https://api.github.com/repos/' + REPO + '/releases', {
    method: 'POST',
    headers: head,
    body: JSON.stringify({ tag_name: tag, name: tag, prerelease: true })
  });
  const rel = await relRes.json();
  if (!relRes.ok) throw new Error('GitHub release failed: ' + JSON.stringify(rel).slice(0, 300));
  const assetRes = await fetch('https://uploads.github.com/repos/' + REPO + '/releases/' + rel.id + '/assets?name=' + path.basename(file), {
    method: 'POST',
    headers: { ...head, 'Content-Type': 'video/mp4' },
    body: await fs.readFile(file)
  });
  const asset = await assetRes.json();
  if (!assetRes.ok) throw new Error('GitHub asset upload failed: ' + JSON.stringify(asset).slice(0, 300));
  return asset.browser_download_url;
}

export async function sendToBuffer(file, caption) {
  if (!HOOK) throw new Error('N8N_BUFFER_WEBHOOK_URL secret is missing');
  if (!REPO || !GH) throw new Error('GITHUB_REPOSITORY / GITHUB_TOKEN missing');
  await cleanupOldMedia();
  const videoUrl = await uploadToRelease(file);
  console.log('Video hosted at:', videoUrl);
  const res = await fetch(HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoUrl, caption })
  });
  const text = await res.text();
  if (!res.ok) throw new Error('n8n webhook ' + res.status + ': ' + text.slice(0, 300));
  return videoUrl;
}
