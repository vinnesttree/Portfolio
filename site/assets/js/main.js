/*
 * Renders the portfolio from the JSON files in /content and enriches the
 * project cards with live data from the public GitHub API.
 *
 * All text is inserted with textContent (never innerHTML), so content pulled
 * from GitHub or a LinkedIn export cannot inject markup.
 */
(() => {
  'use strict';

  const CONTENT = {
    profile: 'content/profile.json',
    projects: 'content/projects.json',
    linkedin: 'content/linkedin.json',
  };
  const GITHUB_CACHE_MS = 60 * 60 * 1000;
  const POSTS_INITIAL = 6;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Colours GitHub uses for each language (github/linguist).
  const LANGUAGE_COLORS = {
    'C': '#555555', 'C++': '#f34b7d', 'C#': '#178600', 'CSS': '#663399', 'Go': '#00add8',
    'HTML': '#e34c26', 'Java': '#b07219', 'JavaScript': '#f1e05a', 'Jupyter Notebook': '#da5b0b',
    'Kotlin': '#a97bff', 'MATLAB': '#e16737', 'Python': '#3572a5', 'Rust': '#dea584',
    'Shell': '#89e051', 'Swift': '#f05138', 'TypeScript': '#3178c6', 'VHDL': '#adb2cb',
    'Verilog': '#b2b7f8', 'SystemVerilog': '#dae1c2', 'Assembly': '#6e4c13', 'OpenSCAD': '#e5cd45',
  };

  // ── Small helpers ────────────────────────────────────────────────────────

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /** Create an element: h('a', { class: 'x', href: url }, 'text', childNode). */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'href') {
        const url = safeUrl(value);
        if (url) el.setAttribute('href', url);
      } else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false || child === '') continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  /** Only allow http(s), mailto and same-site relative links. */
  function safeUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim(), window.location.href);
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function externalLink(props, ...children) {
    const el = h('a', props, ...children);
    const href = el.getAttribute('href');
    if (href && new URL(href).origin !== window.location.origin && !href.startsWith('mailto:')) {
      el.setAttribute('rel', 'noopener');
    }
    return el;
  }

  async function fetchJSON(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  const nonEmpty = (list) => Array.isArray(list) && list.length > 0;

  // ── Dates ────────────────────────────────────────────────────────────────
  // Content files store dates as "YYYY", "YYYY-MM" or "YYYY-MM-DD". Anything
  // else is shown exactly as written.

  function parseDate(value) {
    const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(String(value || ''));
    if (!m) return null;
    return { year: +m[1], month: m[2] ? +m[2] : null, day: m[3] ? +m[3] : null };
  }

  function formatDate(value, { withDay = false } = {}) {
    if (!value) return '';
    const d = parseDate(value);
    if (!d) return String(value);
    if (!d.month) return String(d.year);
    const month = MONTHS[d.month - 1];
    return withDay && d.day ? `${month} ${d.day}, ${d.year}` : `${month} ${d.year}`;
  }

  function formatRange(start, end) {
    const from = formatDate(start);
    const to = end ? formatDate(end) : 'Present';
    if (!from) return end ? to : '';
    return from === to ? from : `${from} – ${to}`;
  }

  /** Newest first; entries without an end date (current roles) first of all. */
  function byRecency(startKey, endKey) {
    return (a, b) => {
      if (endKey) {
        const aCurrent = !a[endKey];
        const bCurrent = !b[endKey];
        if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
      }
      return String(b[startKey] || '').localeCompare(String(a[startKey] || ''));
    };
  }

  // ── Rich text ────────────────────────────────────────────────────────────
  // LinkedIn descriptions are plain text with line breaks and "•" bullets.
  // Turn them into paragraphs and lists without interpreting any markup.

  function richText(text) {
    const fragment = document.createDocumentFragment();
    const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      if (!lines.length) continue;
      let list = null;
      let para = [];
      const flushPara = () => {
        if (para.length) fragment.append(h('p', null, para.join(' ')));
        para = [];
      };
      for (const line of lines) {
        const bullet = /^[•·▪●◦*\-–—]\s*(.+)$/.exec(line);
        if (bullet) {
          flushPara();
          if (!list) {
            list = h('ul');
            fragment.append(list);
          }
          list.append(h('li', null, bullet[1]));
        } else {
          list = null;
          para.push(line);
        }
      }
      flushPara();
    }
    return fragment;
  }

  // ── Profile, links & skills ──────────────────────────────────────────────

  function bindText(key, value) {
    for (const el of $$(`[data-bind="${key}"]`)) {
      el.textContent = value || '';
      if (el.hasAttribute('hidden') && value) el.hidden = false;
    }
  }

  function linkedinHandle(profile, linkedin) {
    if (linkedin && linkedin.handle) return linkedin.handle;
    const m = /linkedin\.com\/in\/([^/?#]+)/i.exec((profile.links || {}).linkedin || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  function renderProfile(profile, linkedin) {
    const li = (linkedin && linkedin.profile) || {};
    const links = profile.links || {};

    const headline = li.headline || profile.headline;
    if (profile.name) {
      bindText('name', profile.name);
      document.title = headline ? `${profile.name} · ${headline}` : profile.name;
    }
    bindText('headline', headline);
    bindText('location', li.location || profile.location);
    bindText('year', String(new Date().getFullYear()));

    const about = $('#about-body');
    const summary = li.summary || (Array.isArray(profile.about) ? profile.about.join('\n\n') : profile.about);
    if (about && summary) about.replaceChildren(richText(summary));

    const handle = linkedinHandle(profile, linkedin);
    const urls = {
      github: links.github,
      linkedin: links.linkedin,
      'linkedin-activity': handle ? `https://www.linkedin.com/in/${encodeURIComponent(handle)}/recent-activity/all/` : links.linkedin,
      resume: profile.resume,
    };
    for (const [key, value] of Object.entries(urls)) {
      for (const el of $$(`[data-link="${key}"]`)) {
        const url = safeUrl(value);
        if (url) {
          el.setAttribute('href', url);
          el.hidden = false;
        } else {
          el.hidden = true;
        }
      }
    }

    renderContact(profile, handle);
  }

  function renderContact(profile, handle) {
    const list = $('#contact-list');
    if (!list) return;
    const links = profile.links || {};
    const items = [];
    if (profile.email) items.push(['Email', `mailto:${profile.email}`, profile.email]);
    if (links.linkedin) items.push(['LinkedIn', links.linkedin, handle ? `in/${handle}` : 'Profile']);
    const gh = /github\.com\/([^/?#]+)/i.exec(links.github || '');
    if (links.github) items.push(['GitHub', links.github, gh ? `@${gh[1]}` : 'Profile']);
    for (const [key, url] of Object.entries(links)) {
      if (key === 'linkedin' || key === 'github' || !url) continue;
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      items.push([label, url, url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')]);
    }
    list.replaceChildren(...items
      .filter(([, url]) => safeUrl(url))
      .map(([label, url, value]) => h('li', null,
        externalLink({ class: 'contact-item', href: url },
          h('span', { class: 'contact-label' }, label),
          h('span', { class: 'contact-value' }, value)))));
  }

  function renderSkills(profile, linkedin) {
    const root = $('#skills');
    if (!root) return;
    const groups = (profile.skills || []).filter((g) => g && nonEmpty(g.items));
    const known = new Set(groups.flatMap((g) => g.items.map((s) => s.toLowerCase())));
    const extra = ((linkedin && linkedin.skills) || []).filter((s) => s && !known.has(s.toLowerCase()));
    if (extra.length) groups.push({ group: groups.length ? 'More skills' : 'Skills', items: extra });

    root.replaceChildren(...groups.map((g) => h('div', { class: 'skill-group' },
      h('h3', { class: 'skill-group-title' }, g.group),
      h('ul', { class: 'chips' }, g.items.map((s) => h('li', { class: 'chip' }, s))))));
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  function languageBadge(language) {
    if (!language) return null;
    const dot = h('span', { class: 'lang-dot', 'aria-hidden': 'true' });
    dot.style.setProperty('--lang-color', LANGUAGE_COLORS[language] || 'var(--muted)');
    return h('span', { class: 'meta-item' }, dot, language);
  }

  function renderProjects(config) {
    const grid = $('#project-grid');
    const user = config.githubUser;
    const cards = new Map();

    const nodes = (config.projects || []).map((p) => {
      const repoUrl = p.repo && user ? `https://github.com/${user}/${p.repo}` : null;
      const meta = h('div', { class: 'project-meta' });
      const linkRow = h('div', { class: 'project-links' },
        repoUrl && externalLink({ class: 'text-link', href: repoUrl }, 'Source on GitHub'),
        (p.links || []).map((l) => externalLink({ class: 'text-link', href: l.url }, l.label)));

      const card = h('article', { class: 'project-card' },
        h('header', { class: 'project-head' },
          h('div', { class: 'project-title-row' },
            h('h3', { class: 'project-title' },
              repoUrl ? externalLink({ href: repoUrl }, p.title || p.repo) : (p.title || p.repo)),
            p.status && h('span', { class: 'badge' }, p.status)),
          p.tagline && h('p', { class: 'project-tagline' }, p.tagline)),
        p.image && h('img', { class: 'project-image', src: p.image, alt: p.imageAlt || '', loading: 'lazy' }),
        p.summary && h('p', { class: 'project-summary' }, p.summary),
        nonEmpty(p.specs) && h('dl', { class: 'spec-list spec-list-compact' },
          p.specs.map((s) => h('div', null, h('dt', null, s.label), h('dd', null, s.value)))),
        nonEmpty(p.highlights) && h('ul', { class: 'project-highlights' },
          p.highlights.map((item) => h('li', null, item))),
        nonEmpty(p.tags) && h('ul', { class: 'chips chips-small', 'aria-label': 'Technologies' },
          p.tags.map((t) => h('li', { class: 'chip' }, t))),
        h('footer', { class: 'project-foot' }, meta, linkRow));

      if (p.repo) cards.set(p.repo.toLowerCase(), { meta });
      return card;
    });

    grid.replaceChildren(...nodes);
    return cards;
  }

  async function loadRepos(user) {
    const key = `gh-repos:${user}`;
    try {
      const cached = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (cached && Date.now() - cached.savedAt < GITHUB_CACHE_MS) return cached.repos;
    } catch {
      // Ignore unreadable cache.
    }

    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/repos?type=owner&sort=pushed&per_page=100`);
    if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
    const repos = (await res.json()).map((r) => ({
      name: r.name,
      description: r.description,
      url: r.html_url,
      homepage: r.homepage,
      language: r.language,
      stars: r.stargazers_count,
      pushedAt: r.pushed_at,
      fork: r.fork,
      archived: r.archived,
    }));

    try {
      sessionStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), repos }));
    } catch {
      // Storage full or blocked: the next visit simply refetches.
    }
    return repos;
  }

  function repoMeta(repo) {
    return [
      languageBadge(repo.language),
      repo.stars > 0 && h('span', { class: 'meta-item', title: 'GitHub stars' }, `★ ${repo.stars}`),
      repo.pushedAt && h('span', { class: 'meta-item' }, `Updated ${formatDate(repo.pushedAt.slice(0, 10))}`),
    ];
  }

  async function enrichFromGitHub(config, cards) {
    const user = config.githubUser;
    if (!user) return;
    let repos;
    try {
      repos = await loadRepos(user);
    } catch (err) {
      console.warn('GitHub data unavailable, showing curated projects only.', err);
      return;
    }

    const own = repos.filter((r) => !r.fork);
    const count = $('[data-bind="repoCount"]');
    if (count) {
      count.replaceChildren(externalLink({ href: `https://github.com/${user}?tab=repositories` },
        `${own.length} on GitHub`));
    }

    for (const repo of repos) {
      const card = cards.get(repo.name.toLowerCase());
      if (card) card.meta.replaceChildren(...repoMeta(repo).filter(Boolean));
    }

    if (config.showOtherRepos === false) return;
    const excluded = new Set((config.exclude || []).map((n) => n.toLowerCase()));
    const others = own.filter((r) => !r.archived
      && !cards.has(r.name.toLowerCase())
      && !excluded.has(r.name.toLowerCase())
      && r.name.toLowerCase() !== `${user}.github.io`.toLowerCase()
      && r.name.toLowerCase() !== user.toLowerCase());
    if (!others.length) return;

    $('#repo-list').replaceChildren(...others.map((r) => h('li', { class: 'repo-row' },
      h('div', { class: 'repo-main' },
        externalLink({ class: 'repo-name', href: r.url }, r.name),
        h('p', { class: 'repo-desc' }, r.description || 'No description yet.')),
      h('div', { class: 'project-meta' }, ...repoMeta(r).filter(Boolean)))));
    $('#more-repos').hidden = false;
  }

  // ── LinkedIn ─────────────────────────────────────────────────────────────

  function showBlock(name, visible) {
    const block = $(`[data-block="${name}"]`);
    if (block) block.hidden = !visible;
    return visible;
  }

  function timelineItem({ title, subtitle, range, body }) {
    return h('li', { class: 'timeline-item' },
      h('div', { class: 'timeline-head' },
        h('h4', { class: 'timeline-title' }, title),
        range && h('span', { class: 'timeline-range' }, range)),
      subtitle && h('p', { class: 'timeline-subtitle' }, subtitle),
      body && h('div', { class: 'timeline-body prose' }, richText(body)));
  }

  function textCard({ title, url, meta, body, clamp }) {
    return h('article', { class: 'text-card' },
      h('h4', { class: 'text-card-title' }, url ? externalLink({ href: url }, title) : title),
      meta && h('p', { class: 'text-card-meta' }, meta),
      body && h('div', { class: `text-card-body prose${clamp ? ' clamp' : ''}` }, richText(body)));
  }

  const joinParts = (...parts) => parts.filter(Boolean).join(' · ');

  function renderLinkedIn(li, handle) {
    const profileUrl = handle ? `https://www.linkedin.com/in/${encodeURIComponent(handle)}/` : null;

    const experience = (li.experience || []).slice().sort(byRecency('start', 'end'));
    if (showBlock('experience', nonEmpty(experience))) {
      $('#experience-list').replaceChildren(...experience.map((e) => timelineItem({
        title: e.title,
        subtitle: joinParts(e.company, e.location),
        range: formatRange(e.start, e.end),
        body: e.description,
      })));
    }

    const education = (li.education || []).slice().sort(byRecency('start', 'end'));
    if (showBlock('education', nonEmpty(education))) {
      $('#education-list').replaceChildren(...education.map((e) => timelineItem({
        title: e.school,
        subtitle: e.degree,
        range: formatRange(e.start, e.end),
        body: [e.activities && `Activities: ${e.activities}`, e.notes].filter(Boolean).join('\n\n'),
      })));
    }

    const certifications = (li.certifications || []).slice().sort(byRecency('date'));
    if (showBlock('certifications', nonEmpty(certifications))) {
      $('#certification-list').replaceChildren(...certifications.map((c) => h('li', null,
        c.url ? externalLink({ class: 'plain-title', href: c.url }, c.name) : h('span', { class: 'plain-title' }, c.name),
        h('span', { class: 'plain-meta' }, joinParts(c.authority, formatDate(c.date))))));
    }

    const honors = (li.honors || []).slice().sort(byRecency('date'));
    if (showBlock('honors', nonEmpty(honors))) {
      $('#honor-list').replaceChildren(...honors.map((a) => h('li', null,
        h('span', { class: 'plain-title' }, a.title),
        h('span', { class: 'plain-meta' }, joinParts(a.issuer, formatDate(a.date))),
        a.description && h('div', { class: 'plain-body prose' }, richText(a.description)))));
    }

    const volunteering = (li.volunteering || []).slice().sort(byRecency('start', 'end'));
    if (showBlock('volunteering', nonEmpty(volunteering))) {
      $('#volunteering-list').replaceChildren(...volunteering.map((v) => timelineItem({
        title: v.role,
        subtitle: joinParts(v.organization, v.cause),
        range: formatRange(v.start, v.end),
        body: v.description,
      })));
    }

    if (showBlock('languages', nonEmpty(li.languages))) {
      $('#language-list').replaceChildren(...li.languages.map((l) => h('li', null,
        h('span', { class: 'plain-title' }, l.name),
        l.proficiency && h('span', { class: 'plain-meta' }, l.proficiency))));
    }

    const hasExperience = ['experience', 'education', 'certifications', 'honors', 'volunteering', 'languages']
      .some((key) => nonEmpty(li[key]));
    $('#experience').hidden = !hasExperience;

    const publications = (li.publications || []).slice().sort(byRecency('date'));
    if (showBlock('publications', nonEmpty(publications))) {
      $('#publication-list').replaceChildren(...publications.map((p) => textCard({
        title: p.title,
        url: p.url,
        meta: joinParts(p.publisher, formatDate(p.date, { withDay: true })),
        body: p.description,
      })));
    }

    const articles = (li.articles || []).slice().sort(byRecency('date'));
    if (showBlock('articles', nonEmpty(articles))) {
      $('#article-list').replaceChildren(...articles.map((a) => textCard({
        title: a.title,
        url: a.url || (handle ? `https://www.linkedin.com/in/${encodeURIComponent(handle)}/recent-activity/articles/` : null),
        meta: formatDate(a.date, { withDay: true }),
        body: a.excerpt,
        clamp: true,
      })));
    }

    const posts = (li.posts || []).slice().sort(byRecency('date'));
    if (showBlock('posts', nonEmpty(posts))) {
      const cards = posts.map((p, i) => {
        const card = h('article', { class: 'post-card' },
          h('p', { class: 'post-date' }, formatDate(p.date, { withDay: true })),
          h('div', { class: 'post-text prose clamp' }, richText(p.text)),
          h('div', { class: 'post-links' },
            p.sharedUrl && externalLink({ class: 'text-link', href: p.sharedUrl }, 'Shared link'),
            externalLink({ class: 'text-link', href: p.url || profileUrl }, 'Read on LinkedIn →')));
        if (i >= POSTS_INITIAL) card.hidden = true;
        return card;
      });
      $('#post-list').replaceChildren(...cards);
      const more = $('#posts-more');
      if (posts.length > POSTS_INITIAL) {
        more.textContent = `Show all ${posts.length} posts`;
        more.hidden = false;
        more.addEventListener('click', () => {
          cards.forEach((c) => { c.hidden = false; });
          more.hidden = true;
        }, { once: true });
      }
    }

    const hasWriting = [publications, articles, posts].some(nonEmpty);
    $('#writing').hidden = !hasWriting;

    const liProjects = (li.projects || []).slice().sort(byRecency('start', 'end'));
    if (nonEmpty(liProjects)) {
      $('#li-project-list').replaceChildren(...liProjects.map((p) => textCard({
        title: p.title,
        url: p.url,
        meta: formatRange(p.start, p.end),
        body: p.description,
      })));
      $('#li-projects').hidden = false;
    }

    for (const link of $$('[data-section-link]')) {
      const section = document.getElementById(link.dataset.sectionLink);
      link.hidden = !section || section.hidden;
    }

    // Once real LinkedIn content is on the page the generic call-out is redundant.
    const callout = $('#linkedin-callout');
    if (callout) callout.hidden = hasExperience || hasWriting;
  }

  // ── Page chrome ──────────────────────────────────────────────────────────

  function renumberSections() {
    $$('main .section:not([hidden]) .section-index').forEach((el, i) => {
      el.textContent = String(i + 1).padStart(2, '0');
    });
  }

  function initThemeToggle() {
    const button = $('.theme-toggle');
    if (!button) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const current = () => document.documentElement.getAttribute('data-theme') || (media.matches ? 'dark' : 'light');
    const sync = () => button.setAttribute('aria-pressed', String(current() === 'dark'));
    sync();
    media.addEventListener('change', sync);
    button.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem('theme', next);
      } catch {
        // Not persisted; the choice still applies for this page view.
      }
      sync();
    });
  }

  function initNav() {
    const toggle = $('.nav-toggle');
    const list = $('#nav-list');
    if (toggle && list) {
      const setOpen = (open) => {
        toggle.setAttribute('aria-expanded', String(open));
        list.classList.toggle('open', open);
      };
      toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
      list.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    }

    if (!('IntersectionObserver' in window)) return;
    const links = new Map($$('.nav-list a').map((a) => [a.getAttribute('href').slice(1), a]));
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const a of links.values()) a.removeAttribute('aria-current');
        const active = links.get(entry.target.id);
        if (active) active.setAttribute('aria-current', 'true');
      }
    }, { rootMargin: '-45% 0px -50% 0px' });
    for (const id of links.keys()) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────

  async function main() {
    initThemeToggle();
    initNav();

    const [profile, projects, linkedin] = await Promise.all(Object.values(CONTENT).map((path) =>
      fetchJSON(path).catch((err) => {
        console.warn(`Could not load ${path}; using the built-in fallback.`, err);
        return null;
      })));

    const li = linkedin || {};
    if (profile) {
      renderProfile(profile, li);
      renderSkills(profile, li);
    }
    renderLinkedIn(li, linkedinHandle(profile || {}, li));
    renumberSections();

    if (projects) {
      const cards = renderProjects(projects);
      await enrichFromGitHub(projects, cards);
    }
  }

  main();
})();
