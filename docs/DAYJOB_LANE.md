# Day job lane

A second scan profile for a bridge job (restaurant, kitchen, hotel, building site, cleaning) that runs beside the main search without touching it. It reuses the scanner's lane switch (`CAREER_OPS_PORTALS`, `CAREER_OPS_PIPELINE`, `CAREER_OPS_SCAN_HISTORY`, see [SCRIPTS.md](SCRIPTS.md)) and one zero token provider, `net-empregos`. No model, no login, no apply: it lists offers, you apply by hand or walk in.

## Set up

```bash
cp templates/portals.dayjob.example.yml portals.dayjob.yml
```

`portals.dayjob.yml` is yours (gitignored, never auto updated). Your main `portals.yml` and its `title_filter` stay exactly as they are.

## Run

```bash
CAREER_OPS_PORTALS=portals.dayjob.yml \
CAREER_OPS_PIPELINE=data/dayjob-offers.md \
CAREER_OPS_SCAN_HISTORY=data/dayjob-scan-history.tsv \
  node scan.mjs --quiet
```

Add `--dry-run` to preview without writing. In Docker, the same through the container:

```bash
docker compose exec -T \
  -e CAREER_OPS_PORTALS=portals.dayjob.yml \
  -e CAREER_OPS_PIPELINE=data/dayjob-offers.md \
  -e CAREER_OPS_SCAN_HISTORY=data/dayjob-scan-history.tsv \
  career-ops node scan.mjs --quiet
```

The lane keeps its own dedup history, so an offer is written once, and neither lane hides the other's offers. `data/scan-runs.tsv` and `data/portal-health.tsv` stay shared with the main lane.

## What it writes

`data/dayjob-offers.md`, the scanner's own pipeline format, one line per fitting offer under `## Pending`:

```
- [ ] https://www.net-empregos.com/<id>/<slug>/ | <company> | <title> | Lisboa | posted: 2026-10-23
```

A `|` inside a field is written `/`, so the cells split cleanly. The number in the link is Net-Empregos' offer id, which grows with every new offer, so the highest ids are the newest offers. A reader such as a daily brief can show the few newest and drop the rest.

## What it keeps

From the feed's ~1000 newest offers in Portugal, an offer is kept when its zone is one of `zones` and either its category contains one of `categories` or its title contains one of `keywords` (case, accents and `(a)` or `/a` endings ignored). Then `title_filter.negative` drops roles that need a trade or a degree (engineers, managers, supervisors). On 25 October 2026 that gave 28 Lisbon offers out of 1000.

Edit the lists in `portals.dayjob.yml` to widen or narrow it: add `Setubal` to `zones` for the south bank, or remove a category.

## Schedule

The feed holds about one to three days of offers and refreshes every 5 minutes, so one read every 6 hours misses nothing. With cron (Linux, macOS):

```cron
0 */6 * * * cd /path/to/career-ops && CAREER_OPS_PORTALS=portals.dayjob.yml CAREER_OPS_PIPELINE=data/dayjob-offers.md CAREER_OPS_SCAN_HISTORY=data/dayjob-scan-history.tsv /usr/local/bin/node scan.mjs --quiet >> data/dayjob-scan.log 2>&1
```

On Windows with Docker, a Task Scheduler task every 6 hours running the `docker compose exec -T` command above from the project folder does the same.

## Off switch

The day you sign a contract, set `enabled: false` on the Net-Empregos entry in `portals.dayjob.yml`. The scan then reads nothing and writes nothing, so a scheduled run stays harmless until you remove it.

## The source and its terms

- Net-Empregos publishes `https://www.net-empregos.com/rss.asp` itself and lists it in its robots.txt, which allows `/`.
- Its terms allow access for an active job search and forbid commercial use. This lane is one person's own search, reads that one feed every few hours with career-ops' own user agent, and opens no offer page.
- The site may stop or change the feed at any time.

## Fallbacks (not built)

If Net-Empregos drops the feed or gives too few offers, these are the next sources checked, in order. Neither is built.

1. **SAPO Emprego**: no RSS, but `https://emprego.sapo.pt/offers.xml` is a sitemap of about 1000 live offer URLs that its robots.txt allows (it disallows `/offers/search` and `/apply-job`). A provider would read the sitemap once a day and fetch only new offer pages to learn their location.
2. **Turijobs** (hospitality): no RSS, but `https://www.turijobs.com/pt-pt/sitemap/active-offers.xml` lists active offers with the city in the URL; filter `lisboa` there. robots.txt disallows its filtered searches and its own terms pages, so read the terms by hand once before building it.

Indeed, OLX, Alerta Emprego and the boat crew boards forbid bots or block plain requests: they stay manual.

## Limits

- The title filter matches substrings without folding accents: list both spellings when they differ (`responsável`, `responsavel`).
- A broad category still lets a few trade roles through (an electrician in Construção Civil). Add a word to `title_filter.negative` when one keeps coming back.
- Fork note: the updater prunes tracked files under `tests/` that upstream does not ship, so `tests/providers/net-empregos.test.mjs` and its fixture disappear on the next `update-system.mjs apply` unless upstream adopts the provider. The provider and this guide are not pruned.
