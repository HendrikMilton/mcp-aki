import {createHash} from 'crypto';
import type {Category, Doc} from '../types';

const BASE = 'https://www.aki.ee';

const LISTINGS: Record<Category, string> = {
	ettekirjutused: '/meist/teadlikkus/ettekirjutused',
	vaideotsused: '/meist/teadlikkus/vaideotsused',
	seisukohad: '/kiirelt-katte/aki-otsused/seisukohad',
};

export const docId = (url: string): string =>
	createHash('sha1').update(url).digest('hex').slice(0, 10);

const decodeEntities = (s: string): string =>
	s
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#039;|&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');

const stripTags = (html: string): string =>
	decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();

const absolute = (href: string): string =>
	decodeEntities(href).startsWith('http') ? decodeEntities(href) : BASE + decodeEntities(href);

/** Drop the "| 195.63 KB | pdf" suffix the CMS appends to every link label. */
const cleanTitle = (label: string): string =>
	stripTags(label)
		.replace(/\|\s*[\d.]+\s*[KMG]B\s*\|\s*pdf\s*$/i, '')
		.trim();

/** Map a table's own heading labels onto our fields; column order differs per category and year. */
const FIELD_BY_HEADING: Record<string, 'date' | 'norms' | 'addressee' | 'topic' | 'title'> = {
	'asja nr': 'title',
	asi: 'title',
	kuupäev: 'date',
	õigusnormid: 'norms',
	adressaat: 'addressee',
	teema: 'topic',
};

const DATE_RE = /^\d{1,2}\.\d{1,2}\.\d{4}$/;
const NORM_RE = /IK[ÜU]M|AvTS|IKS|ESS|§|\bart\b/i;

/** Tables without a <thead> — a handful of older panes — get classified by cell shape instead. */
const metaByShape = (values: string[]): Partial<Doc> => {
	const date = values.find((v) => DATE_RE.test(v));
	const rest = values.filter((v) => v && v !== date);
	const norms = rest.find((v) => NORM_RE.test(v));
	const remaining = rest.filter((v) => v !== norms);
	return {date, norms, addressee: remaining[0], topic: remaining[1]};
	// Deliberately no title here: without headings there is no way to tell an Asja nr cell from
	// an Adressaat cell, so the link label stays authoritative.
};

const cellTexts = (row: string): string[] =>
	[...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripTags(m[1]).toLowerCase());

/**
 * Most tables label their columns with <th>, but some panes leave <thead> empty and put the labels
 * in the first <tr> as plain cells — which silently shifted every field by one column.
 */
const headingsOf = (table: string): string[] => {
	const th = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
		stripTags(m[1]).toLowerCase(),
	);
	if (th.length) return th;

	const firstRow = /<tr[^>]*>([\s\S]*?)<\/tr>/i.exec(table);
	if (!firstRow || /\.pdf/i.test(firstRow[1])) return [];
	const labels = cellTexts(firstRow[1]);
	return labels.filter((l) => l in FIELD_BY_HEADING).length >= 2 ? labels : [];
};

/**
 * Each listing page holds every year in collapsed accordion panes. Most rows live in tables whose
 * columns are Asja nr / Kuupäev / Õigusnormid / Adressaat / Teema — but seisukohad omits Adressaat
 * and older vaideotsused add Kommentaar, so columns are resolved from each table's own header row.
 * Panes predating the tables are bare link lists with no metadata at all.
 */
export const parseListing = (html: string, category: Category): Doc[] => {
	const out: Doc[] = [];
	const seen = new Set<string>();

	const add = (url: string, label: string, year: number, meta: Partial<Doc> = {}) => {
		if (seen.has(url)) return;
		seen.add(url);
		out.push({
			id: docId(url),
			category,
			year,
			title: cleanTitle(label) || url.split('/').pop()!,
			url,
			...meta,
		});
	};

	const panes = [...html.matchAll(/id="accordion--[a-z-]+-(\d{4})"/g)];
	panes.forEach((pane, i) => {
		const year = Number(pane[1]);
		const segment = html.slice(pane.index! + pane[0].length, panes[i + 1]?.index ?? html.length);

		for (const table of segment.matchAll(/<table[\s\S]*?<\/table>/gi)) {
			const headings = headingsOf(table[0]);

			for (const row of table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
				const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
				const linkCell = cells.findIndex((c) => /href="[^"]+\.pdf"/i.test(c));
				if (linkCell === -1) continue;

				let meta: Partial<Doc> = {};
				if (headings.length) {
					cells.forEach((cell, col) => {
						const field = FIELD_BY_HEADING[headings[col] ?? ''];
						if (field && col !== linkCell) meta[field] = stripTags(cell) || undefined;
					});
				} else {
					meta = metaByShape(cells.filter((_, col) => col !== linkCell).map(stripTags));
				}

				// Where the link sits in its own Dokument column its label is boilerplate
				// ("Vaata dokumenti"), so the Asja nr cell is the real title.
				const {title, ...rest} = meta;
				for (const link of cells[linkCell].matchAll(
					/<a[^>]+href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi,
				)) {
					add(absolute(link[1]), title ?? link[2], year, rest);
				}
			}
		}

		// Pre-2023 panes list decisions as plain links with no metadata table.
		for (const link of segment.matchAll(/<a[^>]+href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
			add(absolute(link[1]), link[2], year);
		}
	});

	return out;
};

export const crawl = async (): Promise<Doc[]> => {
	const all: Doc[] = [];
	for (const [category, path] of Object.entries(LISTINGS) as [Category, string][]) {
		const res = await fetch(BASE + path);
		if (!res.ok) throw new Error(`${path} returned ${res.status}`);
		all.push(...parseListing(await res.text(), category));
	}
	return all;
};

if (require.main === module) {
	crawl().then((docs) => {
		const byCategory = docs.reduce<Record<string, number>>((acc, d) => {
			acc[d.category] = (acc[d.category] ?? 0) + 1;
			return acc;
		}, {});
		console.log(`${docs.length} decisions`, byCategory);
		console.log(`with metadata: ${docs.filter((d) => d.date).length}`);
	});
}
