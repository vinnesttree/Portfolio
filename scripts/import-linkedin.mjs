#!/usr/bin/env node
/**
 * Import a LinkedIn data export into site/content/linkedin.json.
 *
 *   node scripts/import-linkedin.mjs <unzipped-export-folder> [options]
 *
 * Get the export from LinkedIn: Settings & Privacy → Data privacy →
 * "Get a copy of your data". Posts (Shares.csv) and articles are only in the
 * larger archive, so pick that option rather than the quick one.
 *
 * Options:
 *   --out <file>          Where to write (default: site/content/linkedin.json)
 *   --handle <name>       LinkedIn handle, e.g. aroeser2 (default: keep existing)
 *   --visibility <list>   Comma-separated Visibility values to publish
 *                         (default: PUBLIC,ANYONE)
 *   --all-posts           Publish every post regardless of visibility
 *   --include-drafts      Include articles that look unpublished
 *   --dry-run             Print the summary without writing anything
 *
 * Only the profile sections shown on the site are read. Messages, connections,
 * contact details and other private data in the export are never touched.
 * No dependencies; needs Node 18+.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'site', 'content', 'linkedin.json');
const DEFAULT_VISIBILITY = ['PUBLIC', 'ANYONE'];
const EXCERPT_LENGTH = 320;

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// ── CSV ──────────────────────────────────────────────────────────────────────

/** RFC 4180 parser: quoted fields, escaped quotes ("") and newlines inside quotes. */
export function parseCSV(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Turn CSV rows into objects keyed by normalised header. Some LinkedIn files
 * start with a "Notes:" preamble, so the header is the first row that
 * contains one of the expected column names.
 */
export function toRecords(rows, expectedColumns) {
  const expected = new Set(expectedColumns.map(normalizeKey));
  const headerIndex = rows.findIndex((r) => r.some((cell) => expected.has(normalizeKey(cell))));
  if (headerIndex === -1) return [];
  const header = rows[headerIndex].map(normalizeKey);
  return rows.slice(headerIndex + 1).map((r) => {
    const record = {};
    header.forEach((key, i) => { record[key] = (r[i] ?? '').trim(); });
    return record;
  });
}

/** First non-empty value among the column name aliases. */
function pick(record, ...aliases) {
  for (const alias of aliases) {
    const value = record[normalizeKey(alias)];
    if (value) return value;
  }
  return '';
}

// ── Values ───────────────────────────────────────────────────────────────────

/**
 * Normalise LinkedIn's assorted date formats to "YYYY", "YYYY-MM" or
 * "YYYY-MM-DD". Unrecognised values are returned unchanged so nothing is lost.
 */
export function normalizeDate(value) {
  const v = String(value || '').trim();
  if (!v || /^(present|current|now)$/i.test(v)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const month = (name) => MONTHS[name.slice(0, 4).toLowerCase()] || MONTHS[name.slice(0, 3).toLowerCase()];
  let m;

  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(v))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{4})-(\d{2})$/.exec(v))) return `${m[1]}-${m[2]}`;
  if ((m = /^(\d{4})$/.exec(v))) return m[1];
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(v)) && month(m[1])) return `${m[2]}-${pad(month(m[1]))}`;
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(v)) && month(m[1])) {
    return `${m[3]}-${pad(month(m[1]))}-${pad(m[2])}`;
  }
  if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(v)) && month(m[2])) {
    return `${m[3]}-${pad(month(m[2]))}-${pad(m[1])}`;
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/.exec(v))) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  if ((m = /^(\d{1,2})\/(\d{4})$/.exec(v))) return `${m[2]}-${pad(m[1])}`;
  return v;
}

/** Tidy free text: normalise newlines, drop LinkedIn mention/hashtag markup. */
export function cleanText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/@\[([^\]]+)\]\(urn:li:[^)]+\)/g, '$1')
    .replace(/\{hashtag\|\\?#\|([^}]+)\}/g, '#$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "NATIVE_OR_BILINGUAL" → "Native or bilingual". */
function humanize(value) {
  const v = String(value || '').trim();
  if (!/^[A-Z0-9_]+$/.test(v)) return v;
  const words = v.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null));

// ── HTML (articles) ──────────────────────────────────────────────────────────

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

export function parseArticle(html) {
  const tagText = (re) => {
    const m = re.exec(html);
    return m ? htmlToText(m[1]) : '';
  };
  const title = tagText(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || tagText(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = htmlToText(html
    .replace(/<head[\s\S]*?<\/head>/i, '')
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, ''));
  // Only lines that are nothing but "Published on <date>" count, so a body
  // sentence like "I published a paper..." is never mistaken for metadata.
  const dateLine = (word) => {
    const m = new RegExp(`^\\s*${word}(?:\\s+on)?[:\\s]+(.{4,40}?)\\s*$`, 'im').exec(text);
    const date = m ? normalizeDate(m[1]) : '';
    return /^\d{4}/.test(date) ? date : '';
  };
  const published = dateLine('published');
  const created = dateLine('created');
  const url = /https:\/\/www\.linkedin\.com\/pulse\/[^\s"'<>]+/i.exec(html);

  const body = text
    .split('\n')
    .filter((line) => !/^(created|published)(\s+on)?[:\s]/i.test(line.trim()))
    .join('\n')
    .trim();
  const excerpt = body.length > EXCERPT_LENGTH
    ? `${body.slice(0, EXCERPT_LENGTH).replace(/\s+\S*$/, '')}…`
    : body;

  return {
    title,
    date: published || created,
    status: published ? 'published' : created ? 'draft' : 'unknown',
    excerpt: cleanText(excerpt),
    url: url ? url[0] : '',
  };
}

// ── Export folder ────────────────────────────────────────────────────────────

/** Recursively list files (a few levels deep: exports unzip into a subfolder). */
async function listFiles(dir, depth = 4) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) out.push(...await listFiles(full, depth - 1));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Find "<Name>.csv" under any of the given names. Complete archives may
 * suffix a member id ("Shares_12345.csv"), so that form matches too.
 */
function findCsv(files, names) {
  for (const name of names) {
    const re = new RegExp(`^${name.replace(/[^a-z0-9]/gi, '[ _]?')}(?:_[^/\\\\]*)?\\.csv$`, 'i');
    const match = files.filter((f) => re.test(path.basename(f))).sort((a, b) => a.length - b.length)[0];
    if (match) return match;
  }
  return null;
}

async function readCsv(files, names, columns) {
  const file = findCsv(files, names);
  if (!file) return null;
  return toRecords(parseCSV(await readFile(file, 'utf8')), columns);
}

// ── Mapping ──────────────────────────────────────────────────────────────────

export async function importExport(dir, options = {}) {
  const files = await listFiles(dir);
  const report = { found: [], missing: [], notes: [] };
  const allowed = new Set((options.visibility || DEFAULT_VISIBILITY).map((v) => v.trim().toUpperCase()));

  const load = async (names, columns) => {
    const list = [].concat(names);
    const records = await readCsv(files, list, columns);
    (records ? report.found : report.missing).push(`${list[0]}.csv`);
    return records || [];
  };

  const data = {
    handle: options.handle || '',
    importedAt: new Date().toISOString().slice(0, 10),
    profile: { headline: '', summary: '', location: '' },
    experience: [],
    education: [],
    projects: [],
    publications: [],
    posts: [],
    articles: [],
    certifications: [],
    honors: [],
    volunteering: [],
    skills: [],
    languages: [],
  };

  const [profile] = await load('Profile', ['First Name', 'Headline', 'Summary']);
  if (profile) {
    data.profile = {
      headline: cleanText(pick(profile, 'Headline')),
      summary: cleanText(pick(profile, 'Summary')),
      location: pick(profile, 'Geo Location', 'Location'),
    };
  }

  data.experience = (await load('Positions', ['Company Name', 'Title', 'Started On']))
    .map((r) => compact({
      title: pick(r, 'Title'),
      company: pick(r, 'Company Name', 'Company'),
      location: pick(r, 'Location'),
      start: normalizeDate(pick(r, 'Started On', 'Start Date')),
      end: normalizeDate(pick(r, 'Finished On', 'End Date')),
      description: cleanText(pick(r, 'Description')),
    }))
    .filter((e) => e.title || e.company);

  data.education = (await load('Education', ['School Name', 'Degree Name', 'Start Date']))
    .map((r) => compact({
      school: pick(r, 'School Name', 'School'),
      degree: [pick(r, 'Degree Name', 'Degree'), pick(r, 'Field Of Study', 'Field of Study')].filter(Boolean).join(', '),
      start: normalizeDate(pick(r, 'Start Date', 'Started On')),
      end: normalizeDate(pick(r, 'End Date', 'Finished On')),
      activities: cleanText(pick(r, 'Activities')),
      notes: cleanText(pick(r, 'Notes', 'Description')),
    }))
    .filter((e) => e.school);

  data.projects = (await load('Projects', ['Title', 'Description', 'Started On']))
    .map((r) => compact({
      title: pick(r, 'Title', 'Name'),
      description: cleanText(pick(r, 'Description')),
      url: safeHttpUrl(pick(r, 'Url', 'URL')),
      start: normalizeDate(pick(r, 'Started On', 'Start Date')),
      end: normalizeDate(pick(r, 'Finished On', 'End Date')),
    }))
    .filter((p) => p.title);

  data.publications = (await load('Publications', ['Name', 'Published On', 'Publisher']))
    .map((r) => compact({
      title: pick(r, 'Name', 'Title'),
      publisher: pick(r, 'Publisher'),
      date: normalizeDate(pick(r, 'Published On', 'Date')),
      description: cleanText(pick(r, 'Description')),
      url: safeHttpUrl(pick(r, 'Url', 'URL')),
    }))
    .filter((p) => p.title);

  data.certifications = (await load('Certifications', ['Name', 'Authority', 'Url']))
    .map((r) => compact({
      name: pick(r, 'Name'),
      authority: pick(r, 'Authority', 'Issuing Organization'),
      date: normalizeDate(pick(r, 'Started On', 'Issued On', 'Issue Date')),
      url: safeHttpUrl(pick(r, 'Url', 'URL')),
    }))
    .filter((c) => c.name);

  data.honors = (await load('Honors', ['Title', 'Issued On', 'Description']))
    .map((r) => compact({
      title: pick(r, 'Title'),
      issuer: pick(r, 'Issuer'),
      date: normalizeDate(pick(r, 'Issued On', 'Date')),
      description: cleanText(pick(r, 'Description')),
    }))
    .filter((a) => a.title);

  data.volunteering = (await load(['Volunteering', 'Volunteer Experiences'], ['Company Name', 'Role', 'Cause']))
    .map((r) => compact({
      role: pick(r, 'Role'),
      organization: pick(r, 'Company Name', 'Organization'),
      cause: humanize(pick(r, 'Cause')),
      start: normalizeDate(pick(r, 'Started On', 'Start Date')),
      end: normalizeDate(pick(r, 'Finished On', 'End Date')),
      description: cleanText(pick(r, 'Description')),
    }))
    .filter((v) => v.role || v.organization);

  data.skills = [...new Set((await load('Skills', ['Name', 'Skill']))
    .map((r) => pick(r, 'Name', 'Skill'))
    .filter(Boolean))];

  data.languages = (await load('Languages', ['Name', 'Proficiency']))
    .map((r) => compact({ name: pick(r, 'Name'), proficiency: humanize(pick(r, 'Proficiency')) }))
    .filter((l) => l.name);

  // Posts: publish only what was shared publicly unless told otherwise.
  const shares = await load('Shares', ['Date', 'ShareLink', 'ShareCommentary']);
  const visibilityCounts = {};
  let skippedEmpty = 0;
  let hasVisibilityColumn = false;
  for (const r of shares) {
    const text = cleanText(pick(r, 'ShareCommentary', 'Share Commentary', 'Commentary'));
    const visibility = pick(r, 'Visibility').toUpperCase();
    if (visibility) hasVisibilityColumn = true;
    const label = visibility || '(blank)';
    if (!text) {
      skippedEmpty++;
      continue;
    }
    const include = options.allPosts || (visibility && allowed.has(visibility));
    visibilityCounts[label] = visibilityCounts[label] || { included: 0, skipped: 0 };
    visibilityCounts[label][include ? 'included' : 'skipped']++;
    if (!include) continue;
    data.posts.push(compact({
      date: normalizeDate(pick(r, 'Date')),
      text,
      url: safeHttpUrl(pick(r, 'ShareLink', 'Share Link')),
      sharedUrl: safeHttpUrl(pick(r, 'SharedUrl', 'Shared Url', 'SharedURL')),
    }));
  }
  report.posts = { visibilityCounts, skippedEmpty, hasVisibilityColumn, total: shares.length };

  // Articles: HTML files inside an "Articles" folder.
  const articleFiles = files.filter((f) => /\.html?$/i.test(f)
    && path.relative(dir, f).split(path.sep).some((part) => /^articles$/i.test(part)));
  const articleStatus = { published: 0, draft: 0, unknown: 0 };
  for (const file of articleFiles) {
    const article = parseArticle(await readFile(file, 'utf8'));
    if (!article.title) continue;
    articleStatus[article.status]++;
    if (article.status === 'draft' && !options.includeDrafts) continue;
    const { status, ...rest } = article;
    data.articles.push(compact(rest));
  }
  report.articles = { files: articleFiles.length, ...articleStatus };

  return { data, report };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--out') options.out = value();
    else if (arg === '--handle') options.handle = value();
    else if (arg === '--visibility') options.visibility = value().split(',').filter(Boolean);
    else if (arg === '--all-posts') options.allPosts = true;
    else if (arg === '--include-drafts') options.includeDrafts = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  return { options, dir: positional[0] };
}

async function existingHandle(outFile) {
  try {
    return JSON.parse(await readFile(outFile, 'utf8')).handle || '';
  } catch {
    return '';
  }
}

function printSummary(data, report, options) {
  const line = (label, n) => console.log(`  ${label.padEnd(16)} ${n}`);
  console.log('\nImported from LinkedIn:');
  line('Headline/about', data.profile.headline || data.profile.summary ? 'yes' : 'no');
  for (const key of ['experience', 'education', 'projects', 'publications', 'posts', 'articles',
    'certifications', 'honors', 'volunteering', 'skills', 'languages']) {
    line(key, data[key].length);
  }

  if (report.missing.length) {
    console.log(`\nNot in this export (skipped): ${report.missing.join(', ')}`);
    if (report.missing.includes('Shares.csv')) {
      console.log('  Posts are only in the larger "complete" archive. Request that one to import posts.');
    }
  }

  const { visibilityCounts, skippedEmpty, hasVisibilityColumn, total } = report.posts;
  if (total) {
    console.log('\nPosts by visibility:');
    for (const [value, counts] of Object.entries(visibilityCounts)) {
      console.log(`  ${value.padEnd(20)} ${counts.included} published, ${counts.skipped} skipped`);
    }
    if (skippedEmpty) console.log(`  ${skippedEmpty} reposts without your own text were skipped.`);
    const skipped = Object.values(visibilityCounts).reduce((n, c) => n + c.skipped, 0);
    if (skipped && !options.allPosts) {
      console.log(hasVisibilityColumn
        ? `  Only posts marked ${[...(options.visibility || DEFAULT_VISIBILITY)].join('/')} are published.\n`
          + '  If the skipped values above are public posts, re-run with --visibility <values> or --all-posts.'
        : '  This export has no Visibility column, so no post could be confirmed as public.\n'
          + '  Re-run with --all-posts to publish them anyway.');
    }
  }

  if (report.articles.files) {
    const { draft, unknown } = report.articles;
    if (draft && !options.includeDrafts) console.log(`\n${draft} article(s) look like drafts and were skipped (--include-drafts to keep).`);
    if (unknown) console.log(`\n${unknown} article(s) had no publish date; included anyway.`);
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const { options, dir } = parsed;
  if (options.help || !dir) {
    const doc = (await readFile(fileURLToPath(import.meta.url), 'utf8')).split('*/')[0];
    console.log(doc.replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, '').trimEnd());
    process.exit(options.help ? 0 : 2);
  }
  if (/\.zip$/i.test(dir)) {
    console.error('Unzip the LinkedIn export first, then pass the folder it extracts to.');
    process.exit(2);
  }

  const out = path.resolve(options.out || DEFAULT_OUT);
  options.handle = options.handle || await existingHandle(out);

  let result;
  try {
    result = await importExport(path.resolve(dir), options);
  } catch (err) {
    console.error(`Could not read ${dir}: ${err.message}`);
    process.exit(1);
  }
  const { data, report } = result;
  if (!report.found.length) {
    console.error(`No LinkedIn CSV files found in ${dir}. Is this the unzipped export folder?`);
    process.exit(1);
  }

  printSummary(data, report, options);
  if (options.dryRun) {
    console.log('\nDry run: nothing written.');
    return;
  }
  await writeFile(out, `${JSON.stringify(data, null, 2)}\n`);
  const shown = path.relative(process.cwd(), out);
  console.log(`\nWrote ${shown && !shown.startsWith('..') ? shown : out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
