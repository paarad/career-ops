import { decodeEntities } from './_html-entities.mjs';
import { DEFAULT_USER_AGENT } from '../user-agent.mjs';
// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Net-Empregos provider — the board-wide public RSS feed at
// https://www.net-empregos.com/rss.asp: the ~1000 newest offers in Portugal
// (ttl 5), each item carrying its company, category, zone and date. The site's
// robots.txt allows `/` and lists this feed itself; its terms allow use for an
// active job search and forbid commercial use. So the provider reads that one
// feed and nothing else: no login, no saved search, no offer page, no apply.
//
// The board is nationwide and mostly not tech, so the entry filters it before
// the scanner sees it. An item is kept when its zone is one of `zones` AND
// (its category matches one of `categories` OR its title matches one of
// `keywords`). Matching ignores case and accents and drops the "(a)" / "/a"
// gender suffixes, so "Empregado/a de Balcão" matches "empregado de balcao".
// The defaults are the Lisbon day job lane of
// templates/portals.dayjob.example.yml; an empty `zones` list keeps every zone.
//
// The feed is ISO-8859-1, and ctx.fetchText decodes UTF-8 (Response.text()),
// which turns every accented letter into U+FFFD. So the bytes are fetched here,
// pinned to the board host with redirect:'error', and decoded by the charset
// the XML prolog declares. A ctx that offers fetchBytes (the tests) is used
// instead of the built-in fetch.
//
// Wire in via a `job_boards:` entry with `provider: net-empregos`.

const FEED_URL = 'https://www.net-empregos.com/rss.asp';
const TRUSTED_HOST = 'www.net-empregos.com';
const FEED_TIMEOUT_MS = 30_000;

const DEFAULT_ZONES = ['Lisboa'];
const DEFAULT_CATEGORIES = ['Restauração', 'Hotelaria / Turismo', 'Construção Civil', 'Limpezas'];
const DEFAULT_KEYWORDS = [
  'copeiro', 'copeira', 'cozinha', 'ajudante de cozinha', 'servente',
  'empregado de mesa', 'empregada de mesa', 'empregado de balcão', 'empregada de balcão',
  'rececionista', 'recepcionista', 'limpeza',
];

/** @param {string} url */
function assertNetEmpregosUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`net-empregos: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`net-empregos: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`net-empregos: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

// The body's bytes, read inside the timeout window so a stalled body cannot
// hang the scan. Errors carry .status and .retryAfter like _http.mjs's.
async function fetchBytes(url, { redirect = 'error', timeoutMs = FEED_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': DEFAULT_USER_AGENT },
      redirect,
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
      err.status = res.status;
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decode the feed's bytes by the charset its XML prolog declares: ISO-8859-1
 * (read as its superset windows-1252, as browsers do) or else UTF-8.
 * Exported for unit tests.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeFeed(bytes) {
  const prolog = new TextDecoder('windows-1252').decode(bytes.subarray(0, 200));
  const declared = (/encoding\s*=\s*["']([\w.-]+)["']/i.exec(prolog)?.[1] || '').toLowerCase();
  const label = ['iso-8859-1', 'latin1', 'windows-1252'].includes(declared) ? 'windows-1252' : 'utf-8';
  return new TextDecoder(label).decode(bytes);
}

// NaN-safe Date.parse - `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// The feed entity-encodes text INSIDE its CDATA sections (`Moon &amp; Sun`,
// `Hidr&amp;#225;ulica`), so a tag's text is decoded twice.
function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return decodeEntities(cdata ? cdata[1] : m[1]);
}

// Tags dropped in one pass over the characters (a <br> becomes a line break),
// then entities decoded and any angle bracket they produce dropped too, so no
// markup survives into the description, however the tags nest.
function plainText(html) {
  let text = '';
  let tag = null;
  for (const char of html) {
    if (tag !== null) {
      if (char !== '>') tag += char;
      else {
        text += /^br\b/i.test(tag) ? '\n' : '';
        tag = null;
      }
    } else if (char === '<') tag = '';
    else text += char;
  }
  return decodeEntities(text)
    .replace(/[<>]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// One labelled field of the description block: `<b>Zona: </b> Lisboa<br>`.
function descriptionField(html, label) {
  const m = html.match(new RegExp(`<b>\\s*${label}:\\s*</b>([^<]*)`, 'i'));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

// Keep only absolute HTTPS links on the board host.
function cleanUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * Parse Net-Empregos' public RSS feed into offers, first occurrence of a link
 * winning. Exported for unit tests.
 *
 * Each `<item>` has `<title>`, `<dc:creator>` (the company), `<link>`,
 * `<pubDate>` and a `<description>` whose HTML starts with labelled fields:
 * Empresa, Categoria, Zona, Data, then a truncated Descrição.
 *
 * @param {string} xml - decoded feed text
 * @returns {Array<{title: string, url: string, company: string, location: string, category: string, description: string, postedAt?: number}>}
 */
export function parseNetEmpregosFeed(xml) {
  if (typeof xml !== 'string') return [];
  const offers = [];
  const seen = new Set();
  for (const item of xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || []) {
    const url = cleanUrl(tagText(item, 'link'));
    if (!url || seen.has(url)) continue;
    const title = decodeEntities(tagText(item, 'title')).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    seen.add(url);
    const html = tagText(item, 'description');
    const company = decodeEntities(tagText(item, 'dc:creator')).trim() || descriptionField(html, 'Empresa');
    const offer = {
      title,
      url,
      company,
      location: descriptionField(html, 'Zona'),
      category: descriptionField(html, 'Categoria'),
      description: plainText(html),
    };
    const postedAt = toEpochMs(tagText(item, 'pubDate'));
    if (postedAt !== undefined) offer.postedAt = postedAt;
    offers.push(offer);
  }
  return offers;
}

/**
 * Fold a label for matching: lowercase, no accents, no "(a)" / "/a" gender
 * suffix, single spaces. Exported for unit tests.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function foldLabel(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\(\s*[ao]s?\s*\)|\/\s*[ao]s?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// An entry list, or the default when the entry leaves it out. A bare string is
// one item; non-strings and blanks are dropped.
function listOf(value, fallback) {
  if (value === undefined || value === null) return fallback.map(foldLabel);
  return (Array.isArray(value) ? value : [value])
    .filter((v) => typeof v === 'string')
    .map(foldLabel)
    .filter(Boolean);
}

/**
 * The entry's filter: zone AND (category OR title keyword). Exported for unit
 * tests.
 *
 * @param {{zones?: unknown, categories?: unknown, keywords?: unknown}} [entry]
 * @returns {(offer: {title: string, location: string, category: string}) => boolean}
 */
export function buildDayJobFilter(entry = {}) {
  const zones = listOf(entry.zones, DEFAULT_ZONES);
  const categories = listOf(entry.categories, DEFAULT_CATEGORIES);
  const keywords = listOf(entry.keywords, DEFAULT_KEYWORDS);
  return (offer) => {
    const zone = foldLabel(offer.location);
    if (zones.length > 0 && !zones.includes(zone)) return false;
    const category = foldLabel(offer.category);
    const title = foldLabel(offer.title);
    return categories.some((c) => category.includes(c)) || keywords.some((k) => title.includes(k));
  };
}

/** @type {Provider} */
export default {
  id: 'net-empregos',

  detect(entry) {
    return entry?.provider === 'net-empregos' ? { url: FEED_URL } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = assertNetEmpregosUrl(FEED_URL);
    const read = typeof ctx?.fetchBytes === 'function' ? ctx.fetchBytes : fetchBytes;
    const xml = decodeFeed(await read(feedUrl, { redirect: 'error' }));
    const keep = buildDayJobFilter(entry);
    return parseNetEmpregosFeed(xml)
      .filter(keep)
      .map(({ category: _category, ...job }) => job);
  },
};
