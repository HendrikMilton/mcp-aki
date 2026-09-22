/**
 * Third corpus: aki.ee itself — the regulator's guidance material, FAQs and news.
 *
 * The two existing corpora are adjudicative: they answer "how was this decided". Guidance is
 * normative — "what does the regulator say you should do" — which is why it gets its own index and
 * its own tools rather than being merged into search_decisions. Merged, a paragraph of the
 * üldjuhend would come back looking like a binding decision, which is the same failure class as the
 * invented KrMS § 64 citation that motivated get_statute.
 *
 * Discovery is the sitemap, not a link crawl: aki.ee publishes all 576 pages at /sitemap.xml, so
 * there is no navigation problem to solve and no reason to drive a browser. The PDFs are a second
 * pass — they are NOT in the sitemap and are linked from the individual guidance pages (the index
 * pages show only two "recent" highlights, which is misleading if you sample those alone).
 */
import {execFile} from 'child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {createHash} from 'crypto';
import {join} from 'path';
import {promisify} from 'util';
import type {GuidanceDoc, GuidanceType} from '../types';

const execFileAsync = promisify(execFile);

const BASE = 'https://www.aki.ee';
const SITEMAP = `${BASE}/sitemap.xml`;

/**
 * aki.ee returns 429 under concurrent fetches — the decisions crawler lost 98 of 657 files to an
 * 8-way pull. Serial with a pause gets everything, and 576 pages at this rate is ~12 minutes.
 */
const FETCH_DELAY_MS = 1200;
const MAX_ATTEMPTS = 5;

const DATA = process.env.GUIDANCE_DATA ?? join(__dirname, '../../data/guidance');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stable short id from the URL, matching the convention the AKI decision corpus already uses. */
export const idOf = (url: string): string => createHash('sha1').update(url).digest('hex').slice(0, 10);

/**
 * Pages that are in the sitemap but must not reach the index.
 *
 * The /en/ mirrors matter most: they are translations of the same Estonian pages, so leaving them
 * in fills a rerank pool of 80 with duplicate pairs and pushes out genuinely different results.
 * That is a recall loss, not merely wasted bytes.
 */
const EXCLUDE = [
	/^\/en(\/|$)/,
	/^\/lehte-ei-leitud$/,
	/^\/ligipaas-keelatud$/,
	/^\/$/, // the front page is a link farm with no content of its own
];

/**
 * Type comes from the URL path, which on a Drupal site is reliable and free. News is indexed but
 * kept out of search_guidance by default — a 2019 announcement reads as current obligation
 * otherwise — and stays reachable through list_guidance.
 */
export const typeOf = (path: string): GuidanceType => {
	if (/(^|\/)(uudised|news)(\/|$)/.test(path)) return 'news';
	if (/(^|\/)kkk(\/|$)/.test(path)) return 'kkk';
	if (/juhend/.test(path)) return 'juhend';
	return 'muu';
};

export const sitemapUrls = async (): Promise<string[]> => {
	const res = await fetch(SITEMAP);
	if (!res.ok) throw new Error(`sitemap returned ${res.status}`);
	const xml = await res.text();
	const locs = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => m[1].trim());

	// The sitemap is generated with a misconfigured base and emits http://default/… for every
	// entry. Rewriting the host is not optional; nothing resolves without it.
	const urls = locs.map((l) => l.replace(/^https?:\/\/default/, BASE));

	const kept = urls.filter((u) => {
		if (!u.startsWith(BASE)) return false;
		const path = u.slice(BASE.length) || '/';
		return !EXCLUDE.some((re) => re.test(path));
	});
	return [...new Set(kept)];
};

/**
 * Without a timeout a single hung connection stalls the whole serial crawl — there is no
 * concurrency to carry on around it, so the run simply stops making progress and looks like a slow
 * page rather than a wedged one. Seen on the first pass: it parked at 500/552 for hours.
 */
const FETCH_TIMEOUT_MS = 30_000;

const fetchWithRetry = async (url: string, binary: boolean): Promise<Buffer | string | null> => {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const res = await fetch(url, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)}).catch(() => null);
		if (res?.ok) {
			if (!binary) return await res.text();
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length > 1000) return buf;
		}
		// 429 is the expected failure here, so back off further each time rather than hammer.
		await sleep(FETCH_DELAY_MS * (attempt + 1) * 2);
	}
	return null;
};

const decode = (s: string): string =>
	s
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

/**
 * aki.ee serves missing pages with HTTP 200 and a "Lehte ei leitud" body, so the status code cannot
 * be trusted. The sitemap does list URLs that soft-404, and without this check they enter the index
 * as identical near-empty documents.
 */
export const isSoftNotFound = (html: string): boolean =>
	/<title[^>]*>\s*Lehte ei leitud/i.test(html) || /<title[^>]*>\s*Ligipääs keelatud/i.test(html);

const stripTags = (fragment: string): string =>
	fragment
		.replace(/<(script|style|noscript|svg)\b[^>]*>.*?<\/\1>/gis, ' ')
		.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
		.replace(/<li\b[^>]*>/gi, '\n- ')
		.replace(/<h([1-6])\b[^>]*>/gi, '\n\n')
		.replace(/<[^>]+>/g, ' ');

/**
 * Take the content blocks by name rather than taking <main> and subtracting the chrome.
 *
 * Subtracting does not work: the chrome blocks are nested <div>s, so a non-greedy match to the
 * first </div> removes almost nothing and the footer's address and newsletter pitch survive onto
 * all 576 pages — which is exactly the repeated boilerplate that would dominate BM25.
 *
 * #block-leadtext is the standfirst and sits outside <article>, so both are needed.
 */
export const pageText = (html: string): {title: string; text: string} => {
	const title = decode(
		(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
			.replace(/\s*\|\s*Andmekaitse Inspektsioon\s*$/i, '')
			.trim(),
	);

	const lead = /<div[^>]+id="block-leadtext"[\s\S]*?<\/div>/i.exec(html)?.[0] ?? '';
	const article = /<article\b[^>]*class="[^"]*\bnode\b[^"]*"[\s\S]*?<\/article>/i.exec(html)?.[0];

	// No <article> means a listing or landing page; those carry only navigation, and the caller
	// drops them on the length threshold rather than indexing a menu.
	const body = stripTags(lead) + '\n\n' + stripTags(article ?? '');

	const text = decode(body)
		.replace(/[ \t]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return {title, text};
};

/** Absolute .pdf (and office-document) links on a page, deduped. */
export const fileLinks = (html: string, pageUrl: string): string[] => {
	const out = new Set<string>();
	for (const m of html.matchAll(/href="([^"]+\.(?:pdf|docx?|xlsx?|odt))"/gi)) {
		try {
			out.add(new URL(decode(m[1]), pageUrl).toString());
		} catch {
			/* a malformed href is not worth failing the page over */
		}
	}
	return [...out];
};

const cachePath = (kind: 'html' | 'file' | 'text', id: string, ext: string): string =>
	join(DATA, kind, `${id}.${ext}`);

/** The parent page's cached HTML, for dating an attachment that carries no date itself. */
const parentHtml = (url: string): string => {
	const path = cachePath('html', idOf(url), 'html');
	return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

const ensureDirs = (): void => {
	for (const kind of ['html', 'file', 'text']) mkdirSync(join(DATA, kind), {recursive: true});
};

/** pdftotext is already a dependency of the research pipeline and handles Estonian diacritics. */
const pdfToText = async (path: string): Promise<string> => {
	const {stdout} = await execFileAsync('pdftotext', ['-q', '-nopgbrk', path, '-'], {
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout.trim();
};

export interface CrawlStats {
	pages: number;
	files: number;
	skipped: number;
	offSite: number;
	duplicate: number;
	failed: string[];
}

/**
 * Publication date from the page itself.
 *
 * News pages carry no JSON-LD, no <time> and no OpenGraph date — the only signal is the byline
 * Drupal renders under the title as <p class="card-text vp-date">29.11.2023 | 00:00</p>. Without it
 * every one of the 317 news items indexed with year 0, which is exactly the gap that stops the
 * corpus ordering a guidance release against the ruling that followed it.
 */
export const dateOf = (html: string): string | undefined => {
	const m = /class="[^"]*\bvp-date\b[^"]*"[^>]*>\s*(\d{2})\.(\d{2})\.(\d{4})/i.exec(html);
	return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
};

/**
 * Year, best effort, in falling order of reliability: the page's own byline, the /YYYY-MM/ upload
 * path an attachment lives under, then the "Last updated" line. 0 means unknown rather than old — a
 * yearFrom filter must not silently hide a document whose date the site never published.
 */
export const yearOf = (url: string, text = '', html = ''): number => {
	const fromByline = dateOf(html);
	if (fromByline) return Number(fromByline.slice(0, 4));
	const fromPath = /\/(\d{4})-\d{2}\//.exec(url)?.[1];
	if (fromPath) return Number(fromPath);
	const fromText = /Last updated:\s*\d{2}\.\d{2}\.(\d{4})/i.exec(text)?.[1];
	return fromText ? Number(fromText) : 0;
};

export const isOnSite = (url: string): boolean => {
	try {
		return /(^|\.)aki\.ee$/.test(new URL(url).hostname);
	} catch {
		return false;
	}
};

/**
 * A file linked from many pages is site chrome, not a document belonging to any one page, so its
 * parents say nothing about what it is. Below that, prefer a parent that types to something more
 * specific than 'muu'.
 */
const SIDEBAR_PARENT_THRESHOLD = 20;

export const typeOfFile = (parents: string[]): GuidanceType => {
	if (parents.length >= SIDEBAR_PARENT_THRESHOLD) return 'muu';
	const types = parents.map((p) => typeOf(new URL(p).pathname));
	return types.find((t) => t !== 'muu') ?? 'muu';
};

/** The deepest path wins: a document page is more specific than the listing that also links it. */
export const mostSpecificParent = (parents: string[]): string =>
	[...parents].sort(
		(a, b) => new URL(b).pathname.split('/').length - new URL(a).pathname.split('/').length,
	)[0];

/**
 * Drop documents whose extracted text is byte-identical to one already kept.
 *
 * AKI publishes the same guidance at two paths — an old /dokumendid/isikuandmete_tootleja_uldjuhend
 * slug and a current /documents/YYYY-MM/ upload — so URL dedupe alone leaves both in. Two copies of
 * the üldjuhend would pair up through the whole rerank pool and halve the distinct results a query
 * can return.
 *
 * The survivor is the one with the more human title: the current uploads carry real titles, the
 * legacy slugs are underscored filenames.
 */
export const dedupeByContent = (docs: GuidanceDoc[]): GuidanceDoc[] => {
	const best = new Map<string, GuidanceDoc>();
	const score = (d: GuidanceDoc) => (d.title.includes(' ') ? 2 : 0) + (d.type !== 'muu' ? 1 : 0);
	for (const doc of docs) {
		const path = cachePath('text', doc.id, 'txt');
		if (!existsSync(path)) continue;
		const key = createHash('sha1').update(readFileSync(path)).digest('hex');
		const prior = best.get(key);
		if (!prior || score(doc) > score(prior)) best.set(key, doc);
	}
	return [...best.values()];
};

/**
 * Two passes, both resumable: anything already cached on disk is neither refetched nor re-paused,
 * so an interrupted run costs only what it had not yet reached.
 */
export const crawlGuidance = async (): Promise<{docs: GuidanceDoc[]; stats: CrawlStats}> => {
	ensureDirs();
	const urls = await sitemapUrls();
	console.log(`sitemap: ${urls.length} pages after exclusions`);

	const docs: GuidanceDoc[] = [];
	const failed: string[] = [];
	let skipped = 0;
	let offSite = 0;
	let duplicate = 0;
	const fileLinksByPage = new Map<string, string[]>();

	// Pass 1 — the HTML pages.
	for (const [i, url] of urls.entries()) {
		const id = idOf(url);
		const htmlPath = cachePath('html', id, 'html');
		let html: string;

		if (existsSync(htmlPath)) {
			html = readFileSync(htmlPath, 'utf8');
			skipped++;
		} else {
			const got = (await fetchWithRetry(url, false)) as string | null;
			await sleep(FETCH_DELAY_MS);
			if (got === null) {
				failed.push(url);
				continue;
			}
			html = got;
			writeFileSync(htmlPath, html, 'utf8');
		}

		if (isSoftNotFound(html)) {
			failed.push(`${url} (soft 404)`);
			continue;
		}

		const {title, text} = pageText(html);
		fileLinksByPage.set(url, fileLinks(html, url));
		if (text.length < 200) continue; // a stub or a pure listing page carries nothing to retrieve

		writeFileSync(cachePath('text', id, 'txt'), text, 'utf8');
		docs.push({
			id,
			url,
			type: typeOf(url.slice(BASE.length)),
			format: 'html',
			title: title || url,
			chars: text.length,
			year: yearOf(url, text, html),
			date: dateOf(html),
		});

		if ((i + 1) % 50 === 0) console.log(`  pages ${i + 1}/${urls.length} (${skipped} cached)`);
	}

	// Pass 2 — the attached documents, deduped across pages.
	//
	// Every parent is kept, not just the first. The site puts a "recent documents" widget in the
	// sidebar of every page, so first-parent-wins attributes those PDFs to an arbitrary page and
	// types the whole attachment set from it. Keeping the full parent list lets typeOfFile tell a
	// sidebar link (hundreds of parents) from a real one (one or two).
	const byFile = new Map<string, string[]>();
	for (const [page, links] of fileLinksByPage) {
		for (const link of links) byFile.set(link, [...(byFile.get(link) ?? []), page]);
	}
	console.log(`files: ${byFile.size} unique attachments`);

	for (const [url, parents] of byFile) {
		// The regulator links third-party documents (EDPB, EMTA, curia, ETSI). They are not aki.ee
		// content and one of them is a 484k-char English accessibility standard, so they stay out.
		if (!isOnSite(url)) {
			offSite++;
			continue;
		}
		const parentUrl = mostSpecificParent(parents);
		const id = idOf(url);
		const ext = url.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '');
		const filePath = cachePath('file', id, ext);
		const textPath = cachePath('text', id, 'txt');

		if (!existsSync(filePath)) {
			const buf = (await fetchWithRetry(url, true)) as Buffer | null;
			await sleep(FETCH_DELAY_MS);
			if (!buf) {
				failed.push(url);
				continue;
			}
			writeFileSync(filePath, buf);
		} else {
			skipped++;
		}

		// Only PDFs get text here; office formats are kept on disk and left for a later pass rather
		// than silently indexed as empty.
		if (ext !== 'pdf') continue;
		let text = existsSync(textPath) ? readFileSync(textPath, 'utf8') : '';
		if (!text) {
			text = await pdfToText(filePath).catch(() => '');
			if (text) writeFileSync(textPath, text, 'utf8');
		}
		if (text.length < 200) continue;

		docs.push({
			id,
			url,
			parentUrl,
			type: typeOfFile(parents),
			format: 'pdf',
			// An attachment has no byline of its own; the page that publishes it does.
			year: yearOf(url, text, parentHtml(parentUrl)),
			date: dateOf(parentHtml(parentUrl)),
			title: decodeURIComponent(url.split('/').pop()!).replace(/\.pdf$/i, '').replace(/_\d+$/, ''),
			chars: text.length,
		});
	}

		const deduped = dedupeByContent(docs);
	duplicate = docs.length - deduped.length;
	return {
		docs: deduped,
		stats: {pages: urls.length, files: byFile.size, skipped, offSite, duplicate, failed},
	};
};

if (require.main === module) {
	crawlGuidance().then(({docs, stats}) => {
		mkdirSync(DATA, {recursive: true});
		writeFileSync(join(DATA, 'docs.json'), JSON.stringify(docs, null, 1), 'utf8');
		const byType = docs.reduce<Record<string, number>>((a, d) => {
			a[`${d.type}/${d.format}`] = (a[`${d.type}/${d.format}`] ?? 0) + 1;
			return a;
		}, {});
		console.log(`\n${docs.length} guidance docs`, byType);
		console.log(`total chars: ${docs.reduce((n, d) => n + d.chars, 0).toLocaleString()}`);
		if (stats.failed.length) console.log(`failed (${stats.failed.length}):`, stats.failed.slice(0, 10));
	});
}
