import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeNewsVideo, markNewsPosted } from './news.js';
import { makeJobVideo, markJobPosted } from './job.js';
import { publishReel } from './instagram.js';
import { sendToBuffer } from './buffer.js';

const kind = process.argv[2];
const dry = process.argv.includes('--dry');
if (!['news', 'job'].includes(kind)) {
  console.error('Usage: node src/main.js news|job [--dry]');
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);
const outDir = path.resolve('out');
const workDir = path.join(outDir, `tmp-${kind}`);
const outFile = path.join(outDir, `${kind}-${stamp}.mp4`);
await fs.mkdir(workDir, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  let caption;
  let markPosted;

  if (kind === 'news') {
    const meta = await makeNewsVideo(browser, {
      homeUrl: process.env.NEWS_HOME_URL || 'https://www.aspirantai.co.in/',
      postUrl: process.env.POST_URL || undefined,
      dryRun: true,
      workDir,
      outFile
    });
    console.log('News post:', meta.postUrl, '|', meta.headline);
    caption = `${meta.headline}\n\n${meta.summary}\n\nMore updates for exam aspirants: link in bio.\n\n${meta.hashtags} #governmentexams #currentaffairs`;
    markPosted = () => markNewsPosted(meta.postUrl, meta.key);
  } else {
    const meta = await makeJobVideo(browser, {
      listUrl: process.env.JOB_LIST_URL || 'https://www.aspirantai.co.in/discover',
      jobUrl: process.env.JOB_URL || undefined,
      workDir,
      outFile
    });
    console.log('Job:', meta.jobUrl, '|', meta.title);
    const lines = [meta.title];
    if (meta.vacancies) lines.push(`Vacancies: ${meta.vacancies}`);
    if (meta.lastDate) lines.push(`Last date: ${meta.lastDate}`);
    caption = `${lines.join('\n')}\n\nFull details, eligibility and apply link: link in bio.\n\n#governmentjobs #sarkarijobs #exampreparation`;
    markPosted = () => markJobPosted(meta.jobUrl);
  }

  console.log('Video ready:', outFile);
  if (dry) {
    console.log('Dry run: not posting. Caption would be:\n' + caption);
  } else {
    const useBuffer = kind === 'news' && Boolean(process.env.N8N_BUFFER_WEBHOOK_URL);
    const id = await (useBuffer ? sendToBuffer(outFile, caption) : publishReel(outFile, caption));
    console.log(useBuffer ? 'Sent to Buffer via n8n:' : 'Published to Instagram, media id:', id);
    await markPosted();
  }
} finally {
  await browser.close().catch(() => {});
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}
