// tests/providers/net-empregos.test.mjs — provider-contract tests for the
// Net-Empregos board-wide RSS provider (providers/net-empregos.mjs) and the
// day job lane template that wires it (templates/portals.dayjob.example.yml).
// The fixture is a trimmed copy of the real feed, kept in its own ISO-8859-1
// bytes: 14 items, one of them a repeated link.
import { pass, fail, ROOT } from '../helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import * as yaml from 'js-yaml';

console.log('\nProvider — net-empregos');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/net-empregos.mjs')).href);
  const provider = mod.default;
  const { decodeFeed, parseNetEmpregosFeed, buildDayJobFilter, foldLabel } = mod;
  const bytes = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/net-empregos/rss-trimmed.xml')));

  if (provider.id === 'net-empregos') pass('net-empregos.id is "net-empregos"');
  else fail(`net-empregos.id is ${JSON.stringify(provider.id)}`);

  // detect() — explicit provider selection only (board-wide feed)
  const hit = provider.detect({ name: 'Net-Empregos', provider: 'net-empregos' });
  if (hit && hit.url === 'https://www.net-empregos.com/rss.asp') pass('detect() resolves provider:net-empregos → feed URL');
  else fail(`detect() returned ${JSON.stringify(hit)}`);
  if (provider.detect({ name: 'X', careers_url: 'https://www.net-empregos.com/' }) === null) pass('detect() requires provider:net-empregos');
  else fail('detect() should not claim an entry without provider:net-empregos');

  // decodeFeed — the prolog's ISO-8859-1 wins over UTF-8
  const xml = decodeFeed(bytes);
  if (xml.includes('Restauração / Bares / Pastelarias') && !xml.includes('�')) pass('decodeFeed reads the ISO-8859-1 bytes without replacement characters');
  else fail('decodeFeed mangled the accented letters');
  const utf8 = decodeFeed(new TextEncoder().encode('<?xml version="1.0" encoding="utf-8"?><x>Construção</x>'));
  if (utf8.includes('Construção')) pass('decodeFeed keeps a UTF-8 feed as UTF-8');
  else fail(`decodeFeed on UTF-8 gave ${JSON.stringify(utf8)}`);

  // parseNetEmpregosFeed — every field, entities decoded twice, links deduped
  const offers = parseNetEmpregosFeed(xml);
  if (offers.length === 13) pass('parse keeps 13 offers (the repeated link once)');
  else fail(`parse returned ${offers.length} offers, expected 13`);
  const nata = offers.find((o) => o.url === 'https://www.net-empregos.com/16165766/estamos-a-recrutar-m-f-empregado-a-de-limpeza-copa/');
  if (nata && nata.company === 'GALERIA DE NATA LDA' && nata.location === 'Lisboa'
    && nata.category === 'Restauração / Bares / Pastelarias' && nata.postedAt === Date.parse('Fri, 23 Oct 2026 18:48:15 GMT')) {
    pass('parse reads title, link, company, zone, category and pubDate');
  } else {
    fail(`Galeria de Nata offer = ${JSON.stringify(nata)}`);
  }
  if (nata?.description.startsWith('Empresa: GALERIA DE NATA LDA\nCategoria:') && !/[<>]/.test(nata.description)) pass('parse turns the description HTML into plain text');
  else fail(`description = ${JSON.stringify(nata?.description?.slice(0, 80))}`);
  const titles = offers.map((o) => o.title);
  if (titles.includes('Moon & Sun Lisboa - Rececionista (M/F)') && offers.some((o) => o.company === 'Ms Hotels & Resorts, Lda')) pass('parse decodes &amp; inside CDATA');
  else fail('parse left &amp; in a title or company');
  if (titles.includes('Chefe de Equipa de Hidráulica (M/F) - Lisboa')) pass('parse decodes the double-encoded &amp;#225;');
  else fail('parse left a double-encoded entity in a title');
  if (parseNetEmpregosFeed('').length === 0 && parseNetEmpregosFeed(null).length === 0) pass('empty or null input → no offers');
  else fail('empty or null input should give no offers');
  const offHost = parseNetEmpregosFeed('<item><title>X</title><link>https://evil.example/1/x/</link></item>');
  if (offHost.length === 0) pass('parse drops a link off the board host');
  else fail('parse kept an off-host link');

  // foldLabel — case, accents and gender endings
  if (foldLabel('Empregado/a de Balcão') === 'empregado de balcao' && foldLabel('Empregado(a) de  Mesa') === 'empregado de mesa'
    && foldLabel('Recepcionista/ Administrativo/a') === 'recepcionista/ administrativo') {
    pass('foldLabel drops accents, case and (a) or /a endings only');
  } else {
    fail(`foldLabel gave ${JSON.stringify([foldLabel('Empregado/a de Balcão'), foldLabel('Empregado(a) de  Mesa'), foldLabel('Recepcionista/ Administrativo/a')])}`);
  }

  // buildDayJobFilter — defaults: Lisboa AND (category OR title keyword)
  const kept = offers.filter(buildDayJobFilter({})).map((o) => o.title);
  const expected = [
    'Estamos a recrutar(M/F) - Empregado(a) de Limpeza/Copa',
    'Cozinheiro/a de 3. (M/F) - Chiado, Lisboa - Full-Time',
    'Moon & Sun Lisboa - Rececionista (M/F)',
    'Empregado/a de Balcão e Mesa (M/F) - Lisboa - Part-Time 30h',
    'Auxiliar de Limpeza em Zona Industrial (m/f) - Lisboa',
    'Rececionista Ramo Automóvel - Lisboa',
    'Engenheiro Civil | Alenquer [258-000336-1]',
    'Servente (M/F/D) Lisboa',
    'Chefe de Equipa de Hidráulica (M/F) - Lisboa',
  ];
  if (JSON.stringify(kept) === JSON.stringify(expected)) pass('default filter keeps the 9 Lisbon restaurant, hotel, building and cleaning offers');
  else fail(`default filter kept ${JSON.stringify(kept)}`);
  if (kept.includes('Rececionista Ramo Automóvel - Lisboa')) pass('a title keyword keeps an offer outside the categories');
  else fail('keyword-only match was dropped');
  const dropped = titles.filter((t) => !kept.includes(t));
  if (dropped.length === 4 && dropped.every((t) => /Gaia|Picheleiro|React|Field Support/.test(t))) pass('default filter drops the Porto, all-zones and Lisbon IT offers');
  else fail(`default filter dropped ${JSON.stringify(dropped)}`);
  const porto = offers.filter(buildDayJobFilter({ zones: ['Porto'], categories: [], keywords: 'ajudante de cozinha' })).map((o) => o.title);
  if (JSON.stringify(porto) === JSON.stringify(['Ajudante de cozinha (M/F) - Aguda, Vila Nova de Gaia'])) pass('entry zones, categories and a bare keyword string override the defaults');
  else fail(`custom filter kept ${JSON.stringify(porto)}`);
  const anyZone = offers.filter(buildDayJobFilter({ zones: [], categories: ['Construção Civil'], keywords: [] }));
  if (anyZone.some((o) => o.location === '( Todas as Zonas )')) pass('zones: [] keeps every zone');
  else fail('zones: [] should keep every zone');

  // fetch() — pinned host, redirect:'error', filtered jobs in the scanner's shape
  let calledWith = null;
  const jobs = await provider.fetch(
    { name: 'Net-Empregos Lisboa', provider: 'net-empregos' },
    {
      transport: 'http',
      fetchBytes: async (url, options) => { calledWith = { url, options }; return bytes; },
      fetchText: async () => { throw new Error('fetchText should not be called'); },
      fetchJson: async () => { throw new Error('fetchJson should not be called'); },
    },
  );
  if (calledWith?.url === 'https://www.net-empregos.com/rss.asp' && calledWith.options?.redirect === 'error') pass('fetch() reads the feed bytes with redirect:error');
  else fail(`fetch() called ${JSON.stringify(calledWith)}`);
  if (jobs.length === 9 && jobs.every((j) => j.title && j.url && j.location === 'Lisboa' && !('category' in j))) pass('fetch() returns the 9 kept offers as Job objects');
  else fail(`fetch() returned ${jobs.length} jobs: ${JSON.stringify(jobs[0])}`);

  // The lane template: one enabled net-empregos board, no companies, and a
  // negative title filter that drops trade and degree roles.
  const template = yaml.load(readFileSync(join(ROOT, 'templates/portals.dayjob.example.yml'), 'utf-8'));
  const boards = template?.job_boards ?? [];
  if (boards.length === 1 && boards[0].provider === 'net-empregos' && boards[0].enabled === true && !template.tracked_companies) {
    pass('the day job template wires one enabled net-empregos board and no companies');
  } else {
    fail(`template boards = ${JSON.stringify(boards)}`);
  }
  const fromTemplate = offers.filter(buildDayJobFilter(boards[0] ?? {})).map((o) => o.title);
  if (JSON.stringify(fromTemplate) === JSON.stringify(expected)) pass('the template lists equal the provider defaults');
  else fail(`template filter kept ${JSON.stringify(fromTemplate)}`);
  const { buildTitleFilter } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const titleOk = buildTitleFilter(template.title_filter);
  const afterTitle = fromTemplate.filter(titleOk);
  if (!afterTitle.includes('Engenheiro Civil | Alenquer [258-000336-1]') && !afterTitle.includes('Chefe de Equipa de Hidráulica (M/F) - Lisboa')
    && afterTitle.length === 7) {
    pass('the template title filter drops the engineer and team lead, keeps 7');
  } else {
    fail(`after the template title filter: ${JSON.stringify(afterTitle)}`);
  }
} catch (e) {
  fail(`net-empregos provider tests crashed: ${e.message}`);
}
