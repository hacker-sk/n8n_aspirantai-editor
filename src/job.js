import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DATA_DIR = process.env.DATA_DIR || './state';
const MUSIC_DIR = process.env.MUSIC_DIR || './music';
const POSTED_FILE = path.join(DATA_DIR, 'posted-jobs.json');
const JOB_LINK_SELECTOR = process.env.JOB_LINK_SELECTOR || 'a[href*="/jobs/"]';
const FONT_FILE = process.env.FONT_FILE || '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf';
const BRAND_TEXT = process.env.BRAND_TEXT || 'AspirantAI';
const FPS = Number(process.env.FPS || 15);
const MAX_SECONDS = Number(process.env.MAX_SECONDS || 30);
const MIN_SECONDS = Number(process.env.MIN_SECONDS || 12);
const W = 540; // CSS pixels; deviceScaleFactor 2 gives a 1080x1920 video
const H = 960;

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.slice(-800)}`))));
  });
}

async function readPosted() {
  try {
    return JSON.parse(await fs.readFile(POSTED_FILE, 'utf8'));
  } catch {
    return [];
  }
}

export async function markJobPosted(url) {
  const posted = await readPosted();
  posted.push(url);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(POSTED_FILE, JSON.stringify(posted.slice(-2000)));
}

async function pickMusic() {
  const files = (await fs.readdir(MUSIC_DIR).catch(() => [])).filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f));
  if (!files.length) return null;
  return path.resolve(MUSIC_DIR, files[Math.floor(Math.random() * files.length)]);
}

function wrapTitle(title, maxChars = 26, maxLines = 3) {
  const words = title.replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,2}$/, '') + '...';
  }
  return lines.join('\n');
}

async function findJobUrl(browser, listUrl, forced) {
  if (forced) return forced;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(listUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(1500);
    const links = await page.$$eval(JOB_LINK_SELECTOR, (els) => els.map((a) => a.href));
    const unique = [...new Set(links)];
    const posted = await readPosted();
    const fresh = unique.filter((u) => !posted.includes(u));
    if (!fresh.length) throw new Error(`No unposted job links found with selector "${JOB_LINK_SELECTOR}" on ${listUrl}`);
    return fresh[0];
  } finally {
    await ctx.close();
  }
}

async function recordJob(browser, jobUrl, workDir) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  try {
    await page.goto(jobUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await page.addStyleTag({ content: 'html{scroll-behavior:auto !important}' });
    await page.waitForTimeout(1500);

    const info = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const title = (document.querySelector('h1')?.innerText || document.title || '').trim();
      const vac = text.match(/(?:vacanc(?:y|ies)|posts?)\D{0,15}(\d[\d,]*)/i) || text.match(/(\d[\d,]*)\s*(?:posts?|vacanc)/i);
      const last = text.match(/last\s*date[^\d]{0,20}(\d{1,2}[\s\/.-]\w+[\s\/.-]\d{2,4})/i);
      return { title, vacancies: vac ? vac[1] : '', lastDate: last ? last[1] : '', height: document.documentElement.scrollHeight };
    });

    const maxScroll = Math.max(0, info.height - H);
    const duration = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, maxScroll / 110));
    const frames = Math.round(duration * FPS);
    const hold = FPS;

    for (let i = 0; i < frames; i++) {
      const t = Math.min(1, Math.max(0, (i - hold) / Math.max(1, frames - 2 * hold)));
      const eased = t * t * (3 - 2 * t);
      await page.evaluate((y) => window.scrollTo(0, y), Math.round(eased * maxScroll));
      await page.screenshot({ path: path.join(workDir, `f_${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 85 });
    }
    return { ...info, duration: frames / FPS };
  } finally {
    await ctx.close();
  }
}

async function encode(workDir, outFile, title, duration) {
  await fs.writeFile(path.join(workDir, 'title.txt'), wrapTitle(title));
  await fs.writeFile(path.join(workDir, 'brand.txt'), BRAND_TEXT);
  const music = await pickMusic();

  const vf = [
    'fps=30',
    'format=yuv420p',
    "drawbox=x=0:y=0:w=iw:h=420:color=black@0.7:t=fill:enable='between(t,0,3.5)'",
    `drawtext=fontfile=${FONT_FILE}:textfile=title.txt:fontcolor=white:fontsize=62:line_spacing=14:x=(w-text_w)/2:y=150:enable='between(t,0,3.5)'`,
    `drawtext=fontfile=${FONT_FILE}:textfile=brand.txt:fontcolor=white@0.85:fontsize=40:x=(w-text_w)/2:y=h-120`
  ].join(',');

  const args = ['-y', '-framerate', String(FPS), '-i', 'f_%04d.jpg'];
  if (music) args.push('-stream_loop', '-1', '-i', music);
  args.push('-vf', vf);
  if (music) {
    args.push('-af', `afade=t=in:d=1,afade=t=out:st=${Math.max(0, duration - 1.5).toFixed(2)}:d=1.5,volume=0.6`, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '128k');
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-t', duration.toFixed(2), '-movflags', '+faststart', path.resolve(outFile));
  await run('ffmpeg', args, workDir);
}

export async function makeJobVideo(browser, { listUrl, jobUrl: forcedUrl, workDir, outFile }) {
  const jobUrl = await findJobUrl(browser, listUrl, forcedUrl);
  const info = await recordJob(browser, jobUrl, workDir);
  await encode(workDir, outFile, info.title || 'Government Job Update', info.duration);
  return { jobUrl, title: info.title, vacancies: info.vacancies, lastDate: info.lastDate };
}
