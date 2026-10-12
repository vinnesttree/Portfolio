import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { cleanText, importExport, normalizeDate, parseArticle, parseCSV, toRecords } from '../import-linkedin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'linkedin-export');
const script = path.join(here, '..', 'import-linkedin.mjs');
const run = promisify(execFile);

test('parseCSV handles quotes, escaped quotes, embedded newlines, CRLF and BOM', () => {
  const rows = parseCSV('﻿a,b,c\r\n1,"x, y","say ""hi""\nthere"\r\n\r\n2,,last\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', 'x, y', 'say "hi"\nthere'],
    ['2', '', 'last'],
  ]);
});

test('toRecords skips a preamble and finds the header row', () => {
  const rows = parseCSV('Notes:\n"something"\n\nFirst Name,Company Name\nJo,Acme\n');
  assert.deepEqual(toRecords(rows, ['Company Name']), [{ firstname: 'Jo', companyname: 'Acme' }]);
});

test('normalizeDate understands the formats LinkedIn uses', () => {
  assert.equal(normalizeDate('2024-05-02 14:03:11'), '2024-05-02');
  assert.equal(normalizeDate('Mar 2024'), '2024-03');
  assert.equal(normalizeDate('September 2021'), '2021-09');
  assert.equal(normalizeDate('Sept 2021'), '2021-09');
  assert.equal(normalizeDate('Mar 15, 2023'), '2023-03-15');
  assert.equal(normalizeDate('15 Mar 2023'), '2023-03-15');
  assert.equal(normalizeDate('3/15/2023'), '2023-03-15');
  assert.equal(normalizeDate('2020'), '2020');
  assert.equal(normalizeDate('Present'), '');
  assert.equal(normalizeDate(''), '');
  assert.equal(normalizeDate('sometime'), 'sometime');
});

test('cleanText strips LinkedIn mention and hashtag markup', () => {
  assert.equal(cleanText('Hi @[Ada Lovelace](urn:li:person:abc) {hashtag|\\#|pcb}\r\n\n\n\nbye'), 'Hi Ada Lovelace #pcb\n\nbye');
});

test('parseArticle ignores "published" inside body text', () => {
  const article = parseArticle('<h1>T</h1><p>I published a paper in 2020.</p><p>Created on 2024-02-01</p>');
  assert.equal(article.status, 'draft');
  assert.equal(article.date, '2024-02-01');
});

test('importExport maps the fixture export', async () => {
  const { data, report } = await importExport(fixture, { handle: 'example' });

  assert.equal(data.handle, 'example');
  assert.equal(data.profile.headline, 'Hardware engineer, test fixture');
  assert.equal(data.profile.summary, 'I design boards.\n\nI also write firmware, "carefully".');
  assert.equal(data.profile.location, 'Springfield, Example State');

  assert.deepEqual(data.experience[0], {
    title: 'Embedded Engineer',
    company: 'Example Robotics Co.',
    location: 'Springfield',
    start: '2024-03',
    description: '• Brought up a new motor controller\n• Wrote the bootloader',
  });
  assert.equal(data.experience[1].end, '2022-08');

  assert.deepEqual(data.education, [{
    school: 'Example State University',
    degree: 'Bachelor of Science - BS',
    start: '2020',
    end: '2024',
    activities: 'Robotics club',
  }]);

  assert.equal(data.publications[0].date, '2023-03-15');
  assert.equal(data.publications[0].url, 'https://example.com/paper');
  assert.equal(data.publications[1].url, undefined, 'non-http URLs are dropped');

  // Only the public post with text is published; the member-id file suffix is found.
  assert.equal(data.posts.length, 1);
  assert.equal(data.posts[0].date, '2024-05-02');
  assert.match(data.posts[0].text, /"quotes"\nand a second line\. #pcb$/);
  assert.equal(data.posts[0].sharedUrl, 'https://example.com/board');
  assert.deepEqual(report.posts.visibilityCounts, {
    PUBLIC: { included: 1, skipped: 0 },
    CONNECTIONS: { included: 0, skipped: 1 },
  });
  assert.equal(report.posts.skippedEmpty, 1);

  assert.deepEqual(data.skills, ['KiCad', 'Firmware']);
  assert.deepEqual(data.languages, [{ name: 'English', proficiency: 'Native or bilingual' }]);
  assert.equal(data.certifications[0].date, '2023-06');

  // The published article is kept with its publish date; the draft is not.
  assert.equal(data.articles.length, 1);
  assert.equal(data.articles[0].title, 'Lessons from a Fixture Board');
  assert.equal(data.articles[0].date, '2024-01-12');
  assert.match(data.articles[0].excerpt, /^I published a paper once, but this article is about boards & bring-up\./);

  // Private files in the export are never read into the output.
  assert.doesNotMatch(JSON.stringify(data), /private@example\.com|123 Private St|Secret Co/);
});

test('--all-posts and --include-drafts widen the import', async () => {
  const { data } = await importExport(fixture, { allPosts: true, includeDrafts: true });
  assert.equal(data.posts.length, 2);
  assert.equal(data.articles.length, 2);
});

test('CLI writes the JSON file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'li-import-'));
  try {
    const out = path.join(dir, 'linkedin.json');
    const { stdout } = await run(process.execPath, [script, fixture, '--out', out, '--handle', 'example']);
    assert.match(stdout, /Wrote /);
    assert.match(stdout, /CONNECTIONS\s+0 published, 1 skipped/);
    const written = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(written.handle, 'example');
    assert.equal(written.experience.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the committed linkedin.json matches the shape the site expects', async () => {
  const content = JSON.parse(await readFile(path.join(here, '..', '..', 'site', 'content', 'linkedin.json'), 'utf8'));
  for (const key of ['experience', 'education', 'projects', 'publications', 'posts', 'articles',
    'certifications', 'honors', 'volunteering', 'skills', 'languages']) {
    assert.ok(Array.isArray(content[key]), `${key} should be an array`);
  }
});
