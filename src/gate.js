import fs from 'node:fs';

const DIR = process.env.DATA_DIR || './state';
const FILE = path.join(DIR, 'schedule.json');
const MIN = Number(process.env.MIN_GAP_MINUTES || 120);
const MAX = Number(process.env.MAX_GAP_MINUTES || 240);
const TICK = Number(process.env.SCHEDULE_TICK_MINUTES || 60);
const mode = process.argv[2];

// Random gap between MIN and (MAX - TICK) minutes. The hourly check adds up to TICK more, so real gaps stay between 2 and 4 hours.
function nextTime() {
  const hi = Math.max(MIN, MAX - TICK);
  const mins = MIN + Math.random() * (hi - MIN);
  return new Date(Date.now() + mins * 60000).toISOString();
}

function out(k, v) {
  console.log(k + '=' + v);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, k + '=' + v + '\n');
}

function save(iso) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ nextPostAt: iso }));
}

if (mode === 'schedule') {
  const t = nextTime();
  save(t);
  console.log('Next post not before ' + t);
} else if (process.env.GITHUB_EVENT_NAME !== 'schedule') {
  out('due', 'true');
} else {
  let next = null;
  try {
    next = JSON.parse(fs.readFileSync(FILE, 'utf8')).nextPostAt;
  } catch (e) {}
  if (!next) {
    const t = nextTime();
    save(t);
    console.log('First scheduled run: next post not before ' + t);
    out('due', 'false');
  } else if (Date.now() >= new Date(next).getTime()) {
    out('due', 'true');
  } else {
    console.log('Not due yet, next post not before ' + next);
    out('due', 'false');
  }
}
