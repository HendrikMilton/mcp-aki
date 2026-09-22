import type {Chunk, CourtDoc, Doc, GuidanceDoc, Index} from '../types';
import {EMBED_DIM, embed, rerank} from './bedrock';

/**
 * Estonian is heavily inflected and has no stemmer in any stock tokeniser, so we conflate
 * tokens by truncating to a prefix. On a 24-query eval this lifted BM25 MRR from 0.76 to 0.91
 * on keyword-style queries; 5-8 chars all behave about the same, 6 is the middle.
 */
const STEM_PREFIX = Number(process.env.STEM_PREFIX ?? 6);
const TOKEN_RE = /[a-zäöüõšž0-9]+/gi;

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Reciprocal-rank-fusion damping. 60 is the value from the original RRF paper. */
const RRF_K = 60;

/** Each leg contributes this many candidates before fusion. */
export const LEG_DEPTH = 150;
/** Candidates handed to the reranker. Pool recall hit 1.00 at 80 in eval; 40 and 20 lost ground. */
export const RERANK_POOL = 80;

export const tokenize = (text: string): string[] => {
	const words = text.toLowerCase().match(TOKEN_RE) ?? [];
	return words.map((w) => (STEM_PREFIX && w.length > STEM_PREFIX ? w.slice(0, STEM_PREFIX) : w));
};

// ---------------------------------------------------------------------------
// BM25
// ---------------------------------------------------------------------------

export interface Bm25 {
	postings: Map<string, [number, number][]>; // term -> [chunkIdx, termFreq]
	df: Map<string, number>;
	lengths: Float32Array;
	avgLength: number;
	n: number;
}

export const buildBm25 = (docs: string[]): Bm25 => {
	const postings = new Map<string, [number, number][]>();
	const df = new Map<string, number>();
	const lengths = new Float32Array(docs.length);

	docs.forEach((doc, i) => {
		const terms = tokenize(doc);
		lengths[i] = terms.length;
		const tf = new Map<string, number>();
		for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
		for (const [term, freq] of tf) {
			let list = postings.get(term);
			if (!list) postings.set(term, (list = []));
			list.push([i, freq]);
			df.set(term, (df.get(term) ?? 0) + 1);
		}
	});

	const total = lengths.reduce((a, b) => a + b, 0);
	return {postings, df, lengths, avgLength: total / (docs.length || 1), n: docs.length};
};

export const bm25Search = (idx: Bm25, query: string, limit: number): number[] => {
	const scores = new Map<number, number>();
	for (const term of new Set(tokenize(query))) {
		const list = idx.postings.get(term);
		if (!list) continue;
		const df = idx.df.get(term) ?? 0;
		const idf = Math.log(1 + (idx.n - df + 0.5) / (df + 0.5));
		for (const [i, freq] of list) {
			const norm = 1 - BM25_B + (BM25_B * idx.lengths[i]) / idx.avgLength;
			scores.set(i, (scores.get(i) ?? 0) + (idf * freq * (BM25_K1 + 1)) / (freq + BM25_K1 * norm));
		}
	}
	return topK(scores, limit);
};

// ---------------------------------------------------------------------------
// Dense
// ---------------------------------------------------------------------------

/**
 * Exhaustive cosine over every chunk. At ~11k chunks that is ~17M MACs — around 10ms —
 * so an ANN index would only trade recall for nothing.
 */
export const denseSearch = (index: Index<unknown>, queryVec: number[], limit: number): number[] => {
	const {vectors, scales} = index;
	const count = scales.length;

	let qNorm = 0;
	for (const v of queryVec) qNorm += v * v;
	qNorm = Math.sqrt(qNorm) || 1;

	const scores = new Map<number, number>();
	for (let i = 0; i < count; i++) {
		const base = i * EMBED_DIM;
		let dot = 0;
		for (let d = 0; d < EMBED_DIM; d++) dot += vectors[base + d] * queryVec[d];
		scores.set(i, (dot * scales[i]) / qNorm);
	}
	return topK(scores, limit);
};

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

const topK = (scores: Map<number, number>, limit: number): number[] =>
	[...scores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([i]) => i);

/** Reciprocal rank fusion. Rank-based, so the two legs' incomparable score scales don't matter. */
export const rrf = (lists: number[][], limit: number, weights?: number[]): number[] => {
	const scores = new Map<number, number>();
	lists.forEach((list, li) => {
		const w = weights?.[li] ?? 1;
		list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + w / (RRF_K + rank + 1)));
	});
	return topK(scores, limit);
};

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface SearchFilters {
	category?: string;
	yearFrom?: number;
	yearTo?: number;
	norm?: string;
	/** Court corpus only: procedure type and court tier. */
	menetlus?: string;
	tier?: string;
	/** Guidance corpus only: juhend | kkk | news | muu. */
	type?: string;
}

export interface Hit<D> {
	doc: D;
	chunk: Chunk;
	score: number;
}

/** Text fed to both BM25 and the embedder; the title and section carry real signal. */
export const chunkText = (doc: Doc | undefined, chunk: Chunk): string =>
	`${doc?.title ?? ''} | ${chunk.section}\n${chunk.text}`;

/**
 * The court corpus has no titles — a decision is identified by its case number and the court that
 * issued it, and both are what a lawyer searches by.
 *
 * MUST stay byte-identical to `chunkText` in mcp-rt/src/lib/chunk.ts, which built these vectors.
 * Embedding one string and querying with another silently loses recall rather than failing.
 */
export const courtChunkText = (doc: CourtDoc | undefined, chunk: Chunk): string =>
	`${doc ? `${doc.nr} \u00b7 ${doc.court}` : ''} | ${chunk.section}\n${chunk.text}`;

/**
 * Guidance is retrieved by what it is about, and the document title carries that ("Juhend kaamerate
 * kasutamise kohta"). The section label is the heading path inside the document, so a hit stays
 * attributable to a numbered chapter rather than to a 150k-char PDF as a whole.
 */
export const guidanceChunkText = (doc: GuidanceDoc | undefined, chunk: Chunk): string =>
	`${doc?.title ?? ''} | ${chunk.section}\n${chunk.text}`;

/**
 * BM25 + dense in parallel, fused with RRF, then reranked. Neither leg alone is robust:
 * on the eval BM25 won keyword-phrased queries (MRR 0.91 vs 0.66) and lost paraphrased ones
 * (0.53 vs 0.66). Fused and reranked, both styles land at MRR ~0.87-0.89.
 */
export const search = async <D extends FilterableDoc>(
	corpus: {chunkText: (doc: D | undefined, chunk: Chunk) => string},
	index: Index<D>,
	bm25: Bm25,
	query: string,
	filters: SearchFilters,
	topK_: number,
): Promise<Hit<D>[]> => {
	const docById = new Map(index.docs.map((d) => [d.id, d]));
	const allowed = buildFilterMask(index, filters);

	const [queryVec] = await embed([query], 'search_query');

	const lexical = bm25Search(bm25, query, LEG_DEPTH).filter((i) => allowed(i));
	const dense = denseSearch(index, queryVec, LEG_DEPTH).filter((i) => allowed(i));

	const pool = rrf([dense, lexical], RERANK_POOL);
	if (pool.length === 0) return [];

	const ranked = await rerank(
		query,
		pool.map((i) => corpus.chunkText(docById.get(index.chunks[i].docId), index.chunks[i])),
		topK_,
	);

	return ranked.map(({index: p, score}) => {
		const chunk = index.chunks[pool[p]];
		return {doc: docById.get(chunk.docId)!, chunk, score};
	});
};

/** The fields the filters read. Both corpora carry them; `category` is AKI-only. */
export interface FilterableDoc {
	id: string;
	year: number;
	norms?: string;
	category?: string;
	menetlus?: string;
	tier?: string;
	/** Guidance only: juhend | kkk | news | muu. */
	type?: string;
}

export const matchesFilters = (doc: FilterableDoc, filters: SearchFilters): boolean => {
	const {category, yearFrom, yearTo, norm, menetlus, tier, type} = filters;
	if (category && doc.category !== category) return false;
	if (type && doc.type !== type) return false;
	if (yearFrom && doc.year < yearFrom) return false;
	if (yearTo && doc.year > yearTo) return false;
	if (menetlus && doc.menetlus !== menetlus) return false;
	if (tier && doc.tier !== tier) return false;
	if (norm && !(doc.norms ?? '').toLowerCase().includes(norm.toLowerCase())) return false;
	return true;
};

const buildFilterMask = <D extends FilterableDoc>(
	index: Index<D>,
	filters: SearchFilters,
): ((chunkIdx: number) => boolean) => {
	if (!Object.values(filters).some((v) => v !== undefined && v !== '')) return () => true;

	const ok = new Set<string>();
	for (const doc of index.docs) if (matchesFilters(doc, filters)) ok.add(doc.id);
	return (chunkIdx: number) => ok.has(index.chunks[chunkIdx].docId);
};
