import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DATA_DIR = process.env.DATA_DIR || './state';
const MUSIC_DIR = process.env.MUSIC_DIR || './music';
const NEWS_FILE = path.join(DATA_DIR, 'news-posted.json');
const BRAND_TEXT = process.env.BRAND_TEXT || 'AspirantAI';
const LOGO_URL = process.env.LOGO_URL || 'https://www.aspirantai.co.in/aspirant-owl.png';
const REPEAT_DAYS = 3;

// Only exam/job related posts are used; political posts are skipped on purpose.
const INCLUDE = new RegExp(
  process.env.NEWS_INCLUDE ||
    'recruit|vacanc|exam|job|result|admit card|syllabus|notification|government|police|railway|ssc|upsc|bank|rbi|agniveer|constable|cutoff|scholarship',
  'i'
);
const EXCLUDE = new RegExp(process.env.NEWS_EXCLUDE || 'politic|congress|bjp|\\bnda\\b|tmc|election', 'i');

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.slice(-800)}`))));
  });
}

async function pickMusic() {
  const files = (await fs.readdir(MUSIC_DIR).catch(() => [])).filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f));
  if (!files.length) return null;
  return path.resolve(MUSIC_DIR, files[Math.floor(Math.random() * files.length)]);
}

async function readNewsPosted() {
  try {
    return JSON.parse(await fs.readFile(NEWS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

export async function markNewsPosted(url, key) {
  const list = await readNewsPosted();
  list.push({ url, key, ts: Date.now() });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(NEWS_FILE, JSON.stringify(list.slice(-500)));
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function clip(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n).replace(/\s+\S*$/, '') + '...';
}

export function parseContent(text, tags = []) {
  const clean = text.replace(/#[A-Za-z0-9_]+/g, '').replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).filter((s) => s.length > 3);
  const headline = clip(sentences[0] || clean, 120);

  const months = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i;
  const scored = sentences.slice(1).map((s, i) => ({
    s,
    i,
    score: (/\d/.test(s) ? 2 : 0) + (months.test(s) ? 1 : 0) + (s.length >= 40 && s.length <= 140 ? 1 : 0)
  }));
  const points = scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 3)
    .sort((a, b) => a.i - b.i)
    .map((x) => clip(x.s, 110));

  const numbers = (clean.match(/\d[\d,]{2,}/g) || []).sort((a, b) => b.length - a.length);
  const key = numbers[0] || headline.toLowerCase().split(' ').slice(0, 5).join(' ');
  return { clean, headline, points, tags: tags.slice(0, 3), key };
}

async function extractPosts(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/posts/"]')) {
      const href = a.href;
      if (href.includes('/posts/quiz_') || seen.has(href)) continue;
      const text = (a.textContent || '').trim();
      if (text.length < 120) continue;
      seen.add(href);
      let tags = [];
      let el = a;
      for (let i = 0; i < 6 && el.parentElement; i++) {
        el = el.parentElement;
        const links = new Set(
          [...el.querySelectorAll('a[href*="/posts/"]')].map((x) => x.href).filter((h) => !h.includes('/posts/quiz_'))
        );
        if (links.size > 1) break;
        const found = (el.textContent || '').match(/#[A-Za-z0-9_]+/g);
        if (found) {
          tags = [...new Set(found)];
          break;
        }
      }
      out.push({ url: href, text, tags });
    }
    return out;
  });
}

async function choosePost(browser, homeUrl, forcedPostUrl) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(forcedPostUrl || homeUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(1500);
    const posts = await extractPosts(page);
    if (forcedPostUrl) {
      if (!posts.length) throw new Error('Could not read the post text from ' + forcedPostUrl);
      return posts.find((p) => p.url === forcedPostUrl) || posts[0];
    }
    const posted = await readNewsPosted();
    const cutoff = Date.now() - REPEAT_DAYS * 24 * 3600 * 1000;
    const recentKeys = new Set(posted.filter((p) => p.ts > cutoff).map((p) => p.key));
    const postedUrls = new Set(posted.map((p) => p.url));

    for (const p of posts) {
      const hay = p.text + ' ' + p.tags.join(' ');
      if (!INCLUDE.test(hay) || EXCLUDE.test(hay)) continue;
      if (postedUrls.has(p.url)) continue;
      if (recentKeys.has(parseContent(p.text, p.tags).key)) continue;
      return p;
    }
    throw new Error(`No suitable unposted news post found on ${homeUrl} (found ${posts.length} posts)`);
  } finally {
    await ctx.close();
  }
}

function cardHtml(c, scene) {
  const tags = c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const body =
    scene === 'A'
      ? `<div class="hl big">${esc(c.headline)}</div>`
      : `<div class="hl small">${esc(c.headline)}</div><ul>${c.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1080px;height:1920px;font-family:'Noto Sans','Noto Sans Devanagari',Arial,sans-serif;color:#fff;background:linear-gradient(160deg,#0b1220 0%,#1e3a8a 100%);display:flex;flex-direction:column;padding:120px 80px 260px}
.brand{display:flex;align-items:center;gap:24px;font-size:48px;font-weight:700}
.brand img{width:96px;height:96px;border-radius:24px}
.tags{margin-top:40px;display:flex;flex-wrap:wrap;gap:16px}
.tag{background:rgba(251,191,36,.18);color:#fbbf24;padding:12px 24px;border-radius:999px;font-size:34px;font-weight:600}
.main{flex:1;display:flex;flex-direction:column;justify-content:center}
.hl{font-weight:800;line-height:1.25}
.hl.big{font-size:84px}
.hl.small{font-size:56px;color:#fbbf24;margin-bottom:60px}
ul{list-style:none;padding:0;display:flex;flex-direction:column;gap:44px}
li{font-size:46px;line-height:1.4;padding-left:56px;position:relative}
li::before{content:'';position:absolute;left:0;top:20px;width:20px;height:20px;border-radius:50%;background:#fbbf24}
.foot{font-size:38px;opacity:.85;text-align:center}
</style></head><body>
<div class="brand"><img src="${esc(LOGO_URL)}"><span>${esc(BRAND_TEXT)}</span></div>
<div class="tags">${tags}</div>
<div class="main">${body}</div>
<div class="foot">Follow for daily exam and job updates</div>
</body></html>`;
}

async function renderCards(browser, content, workDir) {
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  try {
    for (const scene of ['A', 'B']) {
      await page.setContent(cardHtml(content, scene), { waitUntil: 'networkidle' });
      await page.screenshot({ path: path.join(workDir, `scene_${scene}.png`), type: 'png' });
    }
  } finally {
    await ctx.close();
  }
}

async function encode(workDir, outFile) {
  const music = await pickMusic();
  const zoomA = "zoompan=z='min(zoom+0.0006,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=120:s=1080x1920:fps=30,format=yuv420p";
  const zoomB = "zoompan=z='min(zoom+0.0005,1.1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=198:s=1080x1920:fps=30,format=yuv420p";
  let graph = `[0:v]${zoomA}[v0];[1:v]${zoomB}[v1];[v0][v1]xfade=transition=fade:duration=0.6:offset=3.4[v]`;

  const args = ['-y', '-i', 'scene_A.png', '-i', 'scene_B.png'];
  if (music) {
    args.push('-stream_loop', '-1', '-i', music);
    graph += ';[2:a]afade=t=in:d=0.8,afade=t=out:st=8.8:d=1.2,volume=0.6[a]';
  }
  args.push('-filter_complex', graph, '-map', '[v]');
  if (music) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '128k');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-t', '10', '-movflags', '+faststart', outFile);
  await run('ffmpeg', args, workDir);
}

export async function makeNewsVideo(browser, { homeUrl, postUrl, dryRun, workDir, outFile }) {
  const post = await choosePost(browser, homeUrl, postUrl);
  const content = parseContent(post.text, post.tags);
  await renderCards(browser, content, workDir);
  await encode(workDir, outFile);
  return {
    postUrl: post.url,
    key: content.key,
    headline: content.headline,
    summary: content.points.join(' '),
    hashtags: content.tags.join(' ')
  };
}
