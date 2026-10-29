import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DATA_DIR = process.env.DATA_DIR || './state';
const MUSIC_DIR = process.env.MUSIC_DIR || './music';
const NEWS_FILE = path.join(DATA_DIR, 'news-posted.json');
const BRAND_TEXT = process.env.BRAND_TEXT || 'AspirantAI';
const LOGO_URL = process.env.LOGO_URL || 'https://www.aspirantai.co.in/aspirant-owl.png';
const REPEAT_DAYS = Number(process.env.REPEAT_DAYS || 0);

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
      if (REPEAT_DAYS > 0 && recentKeys.has(parseContent(p.text, p.tags).key)) continue;
      return p;
    }
    throw new Error(`No suitable unposted news post found on ${homeUrl} (found ${posts.length} posts)`);
  } finally {
    await ctx.close();
  }
}

function classicCardHtml(c, scene) {
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

async function renderClassicCards(browser, content, workDir) {
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  try {
    for (const scene of ['A', 'B']) {
      await page.setContent(classicCardHtml(content, scene), { waitUntil: 'networkidle' });
      await page.screenshot({ path: path.join(workDir, `scene_${scene}.png`), type: 'png' });
    }
  } finally {
    await ctx.close();
  }
}

async function encodeClassic(workDir, outFile) {
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

const TEMPLATES = ['classic', 'student'];

function pickTemplate() {
  const forced = (process.env.NEWS_TEMPLATE || '').toLowerCase();
  if (TEMPLATES.includes(forced)) return forced;
  return TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
}

function studentCardHtml(c, scene) {
  const tags = c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const hasNum = /\d/.test(c.key) && !/^20\d\d$/.test(c.key);
  let top;
  let body;
  if (scene === 1) {
    top = '<div class="alert"><span class="dot"></span>EXAM ALERT</div>';
    body = `<div class="kicker">Aspirants, read this</div><div class="hl">${esc(c.headline)}</div><div class="tags">${tags}</div>`;
  } else if (scene === 2) {
    top = '<div class="alert alt">WHAT YOU NEED TO KNOW</div>';
    const pts = c.points.length ? c.points : [c.headline];
    body = `<div class="cards">${pts.map((p, i) => `<div class="pt"><div class="num">${i + 1}</div><div class="txt">${esc(p)}</div></div>`).join('')}</div>`;
  } else {
    top = '<div class="alert alt">DO NOT MISS OUT</div>';
    const lead = hasNum
      ? `<div class="kicker">Key number</div><div class="bignum">${esc(c.key)}</div>`
      : '<div class="kicker">Stay ahead of the exam</div>';
    body = `${lead}<div class="cta">Save this and share it with your study group</div><div class="cta2">Follow ${esc(BRAND_TEXT)} for daily exam updates</div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1080px;height:1920px;font-family:'Noto Sans','Noto Sans Devanagari',Arial,sans-serif;color:#1f2937;background:#fff7ed;display:flex;flex-direction:column;padding:110px 70px 250px 96px;position:relative}
body::before{content:'';position:absolute;left:0;top:0;bottom:0;width:26px;background:#dc2626}
.brand{display:flex;align-items:center;gap:22px;font-size:44px;font-weight:700;color:#111827}
.brand img{width:84px;height:84px;border-radius:22px}
.alert{margin-top:60px;align-self:flex-start;background:#dc2626;color:#fff;font-size:42px;font-weight:800;letter-spacing:4px;padding:18px 36px;border-radius:14px;display:flex;align-items:center;gap:18px}
.alert.alt{background:#111827}
.dot{width:20px;height:20px;border-radius:50%;background:#fff}
.main{flex:1;display:flex;flex-direction:column;justify-content:center}
.kicker{font-size:44px;font-weight:700;color:#dc2626;margin-bottom:36px;text-transform:uppercase;letter-spacing:2px}
.hl{font-size:80px;font-weight:800;line-height:1.25;color:#111827}
.tags{margin-top:50px;display:flex;flex-wrap:wrap;gap:16px}
.tag{background:#fee2e2;color:#b91c1c;padding:12px 24px;border-radius:12px;font-size:32px;font-weight:700}
.cards{display:flex;flex-direction:column;gap:36px}
.pt{display:flex;gap:32px;align-items:flex-start;background:#fff;border-radius:28px;padding:40px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
.num{flex:none;width:90px;height:90px;border-radius:24px;background:#dc2626;color:#fff;font-size:56px;font-weight:800;display:flex;align-items:center;justify-content:center}
.txt{font-size:44px;line-height:1.4;font-weight:600}
.bignum{font-size:170px;font-weight:900;color:#dc2626;line-height:1.1;word-break:break-all;margin-bottom:60px}
.cta{font-size:56px;font-weight:800;line-height:1.3;color:#111827}
.cta2{margin-top:30px;font-size:38px;color:#6b7280}
.foot{font-size:34px;color:#6b7280;text-align:center}
</style></head><body>
<div class="brand"><img src="${esc(LOGO_URL)}"><span>${esc(BRAND_TEXT)}</span></div>
${top}
<div class="main">${body}</div>
<div class="foot">Link in bio for full details</div>
</body></html>`;
}

async function renderStudentCards(browser, content, workDir) {
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  try {
    for (const scene of [1, 2, 3]) {
      await page.setContent(studentCardHtml(content, scene), { waitUntil: 'networkidle' });
      await page.screenshot({ path: path.join(workDir, `student_${scene}.png`), type: 'png' });
    }
  } finally {
    await ctx.close();
  }
}

async function encodeStudent(workDir, outFile) {
  const music = await pickMusic();
  const z = (d, rate) => `zoompan=z='min(zoom+${rate},1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${d}:s=1080x1920:fps=30,format=yuv420p`;
  let graph =
    `[0:v]${z(108, 0.0007)}[v0];[1:v]${z(120, 0.0006)}[v1];[2:v]${z(102, 0.0007)}[v2];` +
    '[v0][v1]xfade=transition=slideleft:duration=0.4:offset=3.2[x1];' +
    '[x1][v2]xfade=transition=slideleft:duration=0.4:offset=6.8[v]';
  const args = ['-y', '-i', 'student_1.png', '-i', 'student_2.png', '-i', 'student_3.png'];
  if (music) {
    args.push('-stream_loop', '-1', '-i', music);
    graph += ';[3:a]afade=t=in:d=0.8,afade=t=out:st=8.8:d=1.2,volume=0.6[a]';
  }
  args.push('-filter_complex', graph, '-map', '[v]');
  if (music) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '128k');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-t', '10', '-movflags', '+faststart', outFile);
  await run('ffmpeg', args, workDir);
}

export async function makeNewsVideo(browser, { homeUrl, postUrl, dryRun, workDir, outFile }) {
  const post = await choosePost(browser, homeUrl, postUrl);
  const content = parseContent(post.text, post.tags);
  const template = pickTemplate();
  console.log('Template:', template);
  if (template === 'student') {
    await renderStudentCards(browser, content, workDir);
    await encodeStudent(workDir, outFile);
  } else {
    await renderClassicCards(browser, content, workDir);
    await encodeClassic(workDir, outFile);
  }
  return {
    postUrl: post.url,
    key: content.key,
    headline: content.headline,
    summary: content.points.join(' '),
    hashtags: content.tags.join(' '),
    template
  };
}
