import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {AKI, RT, getDocText, loadIndex} from './lib/store';
import {excerptDocument} from './lib/excerpt';
import {matchesFilters, search} from './lib/search';
import type {Category, CourtDoc, Doc} from './types';

const CATEGORY_ENUM = z.enum(['ettekirjutused', 'vaideotsused', 'seisukohad']);

const CATEGORY_LABELS: Record<Category, string> = {
	ettekirjutused: 'Ettekirjutus (binding order / precept)',
	vaideotsused: 'Vaideotsus (challenge decision)',
	seisukohad: 'Seisukoht (opinion / position)',
};

const MENETLUS_ENUM = z.enum(['tsiviil', 'kriminaal', 'haldus', 'vaarteo', 'pohiseadus', 'muu']);
const TIER_ENUM = z.enum(['maakohus', 'ringkonnakohus', 'riigikohus']);

const MENETLUS_LABELS: Record<string, string> = {
	tsiviil: 'Tsiviilasi (civil)',
	kriminaal: 'Kriminaalasi (criminal)',
	haldus: 'Haldusasi (administrative)',
	vaarteo: 'Väärteoasi (misdemeanour)',
	pohiseadus: 'Põhiseaduslikkuse järelevalve (constitutional review)',
	muu: 'Muu',
};

const truncate = (text: string, max: number): string =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

const describeDoc = (doc: Doc): string =>
	[
		`[${doc.id}] ${doc.title}`,
		`  ${CATEGORY_LABELS[doc.category]} · ${doc.date ?? doc.year}${doc.ocr ? ' · OCR' : ''}`,
		doc.norms ? `  Õigusnormid: ${doc.norms}` : '',
		doc.addressee ? `  Adressaat: ${doc.addressee}` : '',
		doc.topic ? `  Teema: ${doc.topic}` : '',
		`  ${doc.url}`,
	]
		.filter(Boolean)
		.join('\n');

const describeCourtDoc = (doc: CourtDoc): string =>
	[
		`[${doc.id}] ${doc.nr}`,
		`  ${doc.court} · ${MENETLUS_LABELS[doc.menetlus] ?? doc.menetlus} · ${doc.date}`,
		doc.norms ? `  Õigusnormid: ${truncate(doc.norms, 180)}` : '',
		doc.categories.length ? `  Kategooria: ${truncate(doc.categories.join('; '), 160)}` : '',
		`  Teema: ${doc.summary}`,
		`  ${doc.url}`,
	]
		.filter(Boolean)
		.join('\n');

/**
 * One line per decision. Long listings rendered six lines deep overflowed the client's buffer and
 * got silently truncated mid-entry — which produced confidently wrong summaries, not an error — so
 * anything past a couple of dozen results comes back compact.
 */
const summariseDoc = (doc: Doc): string =>
	[
		`[${doc.id}]`,
		doc.date ?? String(doc.year),
		truncate(doc.addressee ?? doc.title, 60),
		doc.norms ? `(${truncate(doc.norms, 50)})` : '',
	]
		.filter(Boolean)
		.join(' · ');

const summariseCourtDoc = (doc: CourtDoc): string =>
	[`[${doc.id}]`, doc.date, doc.nr, truncate(doc.court, 34), truncate(doc.summary, 52)]
		.filter(Boolean)
		.join(' · ');

/** Past this many results the verbose form is too long to survive intact. */
const COMPACT_THRESHOLD = 20;

/**
 * What the index actually holds right now, stated from the index itself rather than written into
 * the tool description — the court corpus is built in batches, so any hardcoded figure is wrong by
 * the next run. Without this the model reads "no results" as "no such case law exists", when the
 * honest reading is often "not ingested yet".
 */
const coverage = (docs: {date?: string; year: number}[]): string => {
	if (docs.length === 0) return 'Index is empty.';
	const years = docs.map((d) => d.year).filter((y) => y > 0);
	const from = Math.min(...years);
	const to = Math.max(...years);
	return `Corpus: ${docs.length} decisions, ${from}-${to}.`;
};

export const buildMcpServer = (): McpServer => {
	const server = new McpServer({name: 'eesti-andmekaitse', version: '2.0.0'});

	// -------------------------------------------------------------------------
	// AKI — the regulator's own decisions
	// -------------------------------------------------------------------------

	server.registerTool(
		'search_decisions',
		{
			title: 'Search AKI decisions',
			description:
				'Search Estonian Data Protection Inspectorate (Andmekaitse Inspektsioon) decisions — ' +
				'ettekirjutused, vaideotsused and seisukohad from 2021 onwards. Hybrid keyword + semantic ' +
				'search with reranking. Queries work in Estonian; legal citations such as "IKÜM art 15" or ' +
				'"AvTS § 35" match well. Returns passages with the decision they came from. For how courts ' +
				'ruled on these questions, use search_court_decisions instead.',
			inputSchema: {
				query: z.string().describe('Search query, preferably in Estonian.'),
				category: CATEGORY_ENUM.optional().describe('Restrict to one decision type.'),
				year_from: z.number().int().optional().describe('Earliest year, inclusive.'),
				year_to: z.number().int().optional().describe('Latest year, inclusive.'),
				norm: z
					.string()
					.optional()
					.describe('Substring match on the cited legal norms, e.g. "IKÜM art 15" or "AvTS".'),
				top_k: z.number().int().min(1).max(25).optional().describe('Passages to return (default 8).'),
			},
		},
		async ({query, category, year_from, year_to, norm, top_k}) => {
			const {index, bm25} = await loadIndex(AKI);
			const hits = await search(
				AKI,
				index,
				bm25,
				query,
				{category, yearFrom: year_from, yearTo: year_to, norm},
				top_k ?? 8,
			);

			if (hits.length === 0) {
				return {content: [{type: 'text' as const, text: 'No matching decisions.'}]};
			}

			const text = hits
				.map(
					(hit, i) =>
						`--- result ${i + 1} (relevance ${hit.score.toFixed(3)}) ---\n` +
						`${describeDoc(hit.doc)}\n` +
						`  Section: ${hit.chunk.section}\n\n${hit.chunk.text}`,
				)
				.join('\n\n');

			return {
				content: [
					{
						type: 'text' as const,
						text:
							`${hits.length} passages — excerpts only, not the whole decision. Before citing any ` +
							`paragraph number or statute section, confirm it with get_decision ` +
							`(pass a pattern to check one citation).\n${coverage(index.docs)}\n\n${text}`,
					},
				],
			};
		},
	);

	server.registerTool(
		'get_decision',
		{
			title: 'Get full AKI decision text',
			description:
				'Fetch one AKI decision by the id returned from search_decisions. Returns the full text ' +
				'by default. **Call this before citing a paragraph number or a statute section** — ' +
				'search returns passages, not the whole decision. Pass `pattern` to verify one ' +
				'citation, or `section` to read one part.',
			inputSchema: {
				id: z.string().describe('Decision id, e.g. "a1b2c3d4e5".'),
				pattern: z
					.string()
					.optional()
					.describe(
						'Return only passages containing this literal text, with surrounding context. ' +
							'Use it to verify a citation before repeating it, e.g. "KrMS § 64" — if the ' +
							'pattern is absent the tool says so, which means the decision does not say it.',
					),
				section: z
					.string()
					.optional()
					.describe(
						'Return only one section, matched on its ALL-CAPS heading, e.g. ' +
							'"RINGKONNAKOHTU SEISUKOHT" or "RESOLUTSIOON".',
					),
			},
		},
		async ({id, pattern, section}) => {
			const {index} = await loadIndex(AKI);
			const doc = index.docs.find((d) => d.id === id);
			if (!doc) {
				return {
					content: [{type: 'text' as const, text: `Unknown decision id: ${id}`}],
					isError: true,
				};
			}
			const {text, note} = excerptDocument(await getDocText(AKI, id), {pattern, section});
			return {
				content: [
					{
						type: 'text' as const,
						text: [describeDoc(doc), note, text].filter(Boolean).join('\n\n'),
					},
				],
			};
		},
	);

	server.registerTool(
		'list_decisions',
		{
			title: 'Browse AKI decisions',
			description:
				'Browse AKI decisions by metadata without a search query — useful for "what did AKI decide ' +
				'in 2025" or for counting decisions citing a given norm.',
			inputSchema: {
				category: CATEGORY_ENUM.optional(),
				year_from: z.number().int().optional(),
				year_to: z.number().int().optional(),
				norm: z.string().optional().describe('Substring match on cited legal norms.'),
				limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
			},
		},
		async ({category, year_from, year_to, norm, limit}) => {
			const {index} = await loadIndex(AKI);
			const matches = index.docs.filter((d) =>
				matchesFilters(d, {category, yearFrom: year_from, yearTo: year_to, norm}),
			);
			const shown = matches.slice(0, limit ?? 50);
			const compact = shown.length > COMPACT_THRESHOLD;
			const body = compact
				? shown.map(summariseDoc).join('\n')
				: shown.map(describeDoc).join('\n\n');
			const topics = [...new Set(matches.map((d) => d.topic).filter(Boolean))];
			const header = [
				`${matches.length} decisions match; showing ${shown.length}.`,
				topics.length === 1 ? `All share the topic "${topics[0]}".` : '',
				compact ? 'Compact listing — use get_decision with an [id] for the full record.' : '',
			]
				.filter(Boolean)
				.join(' ');

			return {content: [{type: 'text' as const, text: `${header}\n\n${body}`}]};
		},
	);

	// -------------------------------------------------------------------------
	// Riigi Teataja — court decisions, separate index
	// -------------------------------------------------------------------------

	server.registerTool(
		'search_court_decisions',
		{
			title: 'Search Estonian court decisions on data protection',
			description:
				'Search Estonian court decisions (Riigi Teataja) that substantively concern data ' +
				'protection, privacy or the lawfulness of data processing — maakohus, ringkonnakohus and ' +
				'Riigikohus. Hybrid keyword + semantic search with reranking; queries work in Estonian and ' +
				'citations such as "IKÜM art 15", "AvTS § 35" or "KrMS § 214" match well. This is a ' +
				'topic-filtered corpus, not all Estonian case law: every decision was classified as ' +
				'substantively about data protection before being indexed. Use search_decisions for the ' +
				"regulator's own practice.",
			inputSchema: {
				query: z.string().describe('Search query, preferably in Estonian.'),
				menetlus: MENETLUS_ENUM.optional().describe('Restrict to one procedure type.'),
				tier: TIER_ENUM.optional().describe('Restrict to one court level.'),
				year_from: z.number().int().optional().describe('Earliest year, inclusive.'),
				year_to: z.number().int().optional().describe('Latest year, inclusive.'),
				norm: z
					.string()
					.optional()
					.describe('Substring match on statute citations found in the decision, e.g. "KrMS § 214".'),
				top_k: z.number().int().min(1).max(25).optional().describe('Passages to return (default 8).'),
			},
		},
		async ({query, menetlus, tier, year_from, year_to, norm, top_k}) => {
			const {index, bm25} = await loadIndex(RT);
			const hits = await search(
				RT,
				index,
				bm25,
				query,
				{menetlus, tier, yearFrom: year_from, yearTo: year_to, norm},
				top_k ?? 8,
			);

			if (hits.length === 0) {
				return {
					content: [
						{
							type: 'text' as const,
							text:
								`No matching court decisions. ${coverage(index.docs)} Ingest is still in ` +
								`progress and runs newest-first, so this does not mean no such case law ` +
								`exists — try different wording, then say the corpus did not cover it.`,
						},
					],
				};
			}

			const text = hits
				.map(
					(hit, i) =>
						`--- result ${i + 1} (relevance ${hit.score.toFixed(3)}) ---\n` +
						`${describeCourtDoc(hit.doc)}\n` +
						`  Section: ${hit.chunk.section}\n\n${hit.chunk.text}`,
				)
				.join('\n\n');

			return {
				content: [
					{
						type: 'text' as const,
						text:
							`${hits.length} passages — excerpts only, not the whole decision. Before citing any ` +
							`paragraph number or statute section, confirm it with get_court_decision ` +
							`(pass a pattern to check one citation).\n` +
							`${coverage(index.docs)} Ingest is still in progress and runs newest-first, so ` +
							`absence here is not evidence that no such case law exists — say that rather ` +
							`than concluding the courts have not ruled on it.\n\n${text}`,
					},
				],
			};
		},
	);

	server.registerTool(
		'get_court_decision',
		{
			title: 'Get full court decision text',
			description:
				'Fetch one court decision by the id returned from search_court_decisions. Returns the ' +
				'full text by default. **Call this before citing a paragraph number or a statute ' +
				'section**: search returns passages, not the whole decision, and a provision that ' +
				'looks like it belongs may not be in the text at all. Pass `pattern` to check one ' +
				'citation cheaply, or `section` to read just the reasoning.',
			inputSchema: {
				id: z.string().describe('Decision id, as returned in [brackets].'),
				pattern: z
					.string()
					.optional()
					.describe(
						'Return only passages containing this literal text, with surrounding context. ' +
							'Use it to verify a citation before repeating it, e.g. "KrMS § 64" — if the ' +
							'pattern is absent the tool says so, which means the decision does not say it.',
					),
				section: z
					.string()
					.optional()
					.describe(
						'Return only one section, matched on its ALL-CAPS heading, e.g. ' +
							'"RINGKONNAKOHTU SEISUKOHT" or "RESOLUTSIOON".',
					),
			},
		},
		async ({id, pattern, section}) => {
			const {index} = await loadIndex(RT);
			const doc = index.docs.find((d) => d.id === id);
			if (!doc) {
				return {
					content: [{type: 'text' as const, text: `Unknown court decision id: ${id}`}],
					isError: true,
				};
			}
			const {text, note} = excerptDocument(await getDocText(RT, id), {pattern, section});
			return {
				content: [
					{
						type: 'text' as const,
						text: [describeCourtDoc(doc), note, text].filter(Boolean).join('\n\n'),
					},
				],
			};
		},
	);

	server.registerTool(
		'list_court_decisions',
		{
			title: 'Browse court decisions',
			description:
				'Browse the data-protection court corpus by metadata without a search query — useful for ' +
				'"which Riigikohus decisions cite KrMS § 214" or for counting decisions by year.',
			inputSchema: {
				menetlus: MENETLUS_ENUM.optional(),
				tier: TIER_ENUM.optional(),
				year_from: z.number().int().optional(),
				year_to: z.number().int().optional(),
				norm: z.string().optional().describe('Substring match on statute citations.'),
				limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
			},
		},
		async ({menetlus, tier, year_from, year_to, norm, limit}) => {
			const {index} = await loadIndex(RT);
			const matches = index.docs.filter((d) =>
				matchesFilters(d, {menetlus, tier, yearFrom: year_from, yearTo: year_to, norm}),
			);
			const shown = matches.slice(0, limit ?? 50);
			const compact = shown.length > COMPACT_THRESHOLD;
			const body = compact
				? shown.map(summariseCourtDoc).join('\n')
				: shown.map(describeCourtDoc).join('\n\n');

			// A count by tier costs nothing here and is usually the actual question behind a browse.
			const byTier = matches.reduce<Record<string, number>>((acc, d) => {
				acc[d.tier] = (acc[d.tier] ?? 0) + 1;
				return acc;
			}, {});
			const header = [
				`${matches.length} decisions match; showing ${shown.length}.`,
				Object.keys(byTier).length
					? `By court: ${Object.entries(byTier)
							.map(([t, n]) => `${t} ${n}`)
							.join(', ')}.`
					: '',
				compact ? 'Compact listing — use get_court_decision with an [id] for the full record.' : '',
			]
				.filter(Boolean)
				.join(' ');

			return {content: [{type: 'text' as const, text: `${header}\n\n${body}`}]};
		},
	);

	return server;
};
