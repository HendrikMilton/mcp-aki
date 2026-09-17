import {PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import pdfParse from 'pdf-parse';
import type {Chunk, Doc} from '../types';
import {EMBED_BATCH, embedBatch} from '../lib/bedrock';
import {chunkDocument} from '../lib/chunk';
import {ocrFromS3} from '../lib/ocr';
import {mapPool} from '../lib/pool';
import {chunkText} from '../lib/search';
import {AKI, BUCKET, loadIndex, writeIndex} from '../lib/store';
import {crawl} from './crawl';

const REGION = process.env.AWS_REGION ?? 'eu-central-1';
const s3 = new S3Client({region: REGION});

/**
 * aki.ee returns 429 under concurrent fetches — an 8-way pull lost 98 of 657 files.
 * Serial with a pause gets everything.
 */
const FETCH_DELAY_MS = 1200;
const MAX_ATTEMPTS = 5;
/** Enough to keep a cold rebuild inside the Lambda timeout without leaning on retry backoff. */
const EMBED_CONCURRENCY = 3;
const S3_CONCURRENCY = 8;

/** Optional local mirror (LOCAL_PDF_DIR=<dir>/<category>/<year>/<id>.pdf) so a rebuild can skip
 *  the slow, rate-limited crawl. Unset in Lambda. */
const LOCAL_PDF_DIR = process.env.LOCAL_PDF_DIR;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const localPdf = (doc: Doc): Buffer | null => {
	if (!LOCAL_PDF_DIR) return null;
	const path = join(LOCAL_PDF_DIR, doc.category, String(doc.year), `${doc.id}.pdf`);
	return existsSync(path) ? readFileSync(path) : null;
};

const fetchPdf = async (url: string): Promise<Buffer | null> => {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const res = await fetch(url).catch(() => null);
		if (res?.ok) {
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length > 1000) return buf;
		}
		await sleep(FETCH_DELAY_MS * (attempt + 1) * 2);
	}
	return null;
};

const put = (key: string, body: Buffer | string, contentType: string) =>
	s3.send(new PutObjectCommand({Bucket: BUCKET, Key: key, Body: body, ContentType: contentType}));

interface Prepared {
	doc: Doc;
	chunks: Chunk[];
	pdf: Buffer;
	text: string;
}

/** Fetch, parse and chunk one decision. Returns null for anything we cannot read. */
const prepare = async (doc: Doc): Promise<Prepared | null> => {
	const cached = localPdf(doc);
	const pdf = cached ?? (await fetchPdf(doc.url));
	if (!cached) await sleep(FETCH_DELAY_MS);
	if (!pdf) {
		console.warn(`skip (unreachable): ${doc.url}`);
		return null;
	}

	const parsed = await pdfParse(pdf).catch(() => null);
	let text = parsed?.text ?? '';
	let ocr = false;

	if (text.trim().length < 400) {
		// A scan. Textract needs the file in S3, so upload it before the text pass rather than after.
		const rawKey = `raw/${doc.category}/${doc.year}/${doc.id}.pdf`;
		await put(rawKey, pdf, 'application/pdf');
		text = await ocrFromS3(rawKey).catch((err) => {
			console.warn(`OCR failed for ${doc.url}: ${err}`);
			return '';
		});
		ocr = true;
		if (text.trim().length < 400) {
			console.warn(`skip (no text after OCR): ${doc.url}`);
			return null;
		}
		console.log(`OCR'd ${doc.id} (${text.length} chars)`);
	}

	const pieces = chunkDocument(text);
	if (pieces.length === 0) return null;

	const stored: Doc = {...doc, pages: parsed?.numpages, ocr: ocr || undefined};
	return {
		doc: stored,
		chunks: pieces.map((p) => ({docId: doc.id, section: p.section, text: p.text})),
		pdf,
		text,
	};
};

/** Pull the float vectors for chunk `i` back out of the quantised store. */
const dequantize = (
	vectors: Int8Array,
	scales: Float32Array,
	dim: number,
	i: number,
): number[] => {
	const out = new Array<number>(dim);
	const base = i * dim;
	for (let d = 0; d < dim; d++) out[d] = vectors[base + d] * scales[i];
	return out;
};

/**
 * Rebuilds the searchable index. Incremental: decisions already present keep their stored text and
 * vectors, so the monthly run only pays for whatever AKI published since.
 */
export const runIngest = async (): Promise<{added: number; total: number}> => {
	const crawled = await crawl();
	console.log(`crawled ${crawled.length} decisions`);

	const existing = await loadIndex(AKI).catch(() => null);
	const knownChunks = new Map<string, Chunk[]>();
	const knownVectors = new Map<string, number[][]>();
	const knownDocs = new Map<string, Doc>();
	if (existing) {
		const {index} = existing;
		index.docs.forEach((d) => knownDocs.set(d.id, d));
		index.chunks.forEach((chunk, i) => {
			if (!knownChunks.has(chunk.docId)) {
				knownChunks.set(chunk.docId, []);
				knownVectors.set(chunk.docId, []);
			}
			knownChunks.get(chunk.docId)!.push(chunk);
			knownVectors.get(chunk.docId)!.push(dequantize(index.vectors, index.scales, index.dim, i));
		});
		console.log(`reusing ${knownChunks.size} already-indexed decisions`);
	}

	// Fetching must stay serial to avoid aki.ee's rate limit; reading a local mirror need not.
	const fresh = crawled.filter((d) => !knownChunks.has(d.id));
	const prepared = (await mapPool(fresh, LOCAL_PDF_DIR ? 4 : 1, prepare)).filter(
		(p): p is Prepared => p !== null,
	);

	// The title is embedded alongside every chunk, so a corrected one invalidates that document's
	// vectors even though its text is untouched. Re-embed from the stored chunks, no refetch.
	const restale = crawled
		.filter((d) => knownChunks.has(d.id) && knownDocs.get(d.id)?.title !== d.title)
		.map((doc) => ({doc, chunks: knownChunks.get(doc.id)!, pdf: null, text: null}) as const);

	const toEmbed = [...prepared, ...restale];
	console.log(`prepared ${prepared.length} new decisions, re-embedding ${restale.length} retitled`);

	// Embed every affected chunk in one flat pass so batches stay full regardless of document length.
	const flat = toEmbed.flatMap((p) => p.chunks.map((c) => chunkText(p.doc, c)));
	const batches: string[][] = [];
	for (let i = 0; i < flat.length; i += EMBED_BATCH) batches.push(flat.slice(i, i + EMBED_BATCH));

	let done = 0;
	const embedded = (
		await mapPool(batches, EMBED_CONCURRENCY, async (batch) => {
			const vecs = await embedBatch(batch, 'search_document');
			done += batch.length;
			if (done % 800 < EMBED_BATCH) console.log(`embedded ${done}/${flat.length} chunks`);
			return vecs;
		})
	).flat();

	await mapPool(prepared, S3_CONCURRENCY, async (p) => {
		await Promise.all([
			put(`raw/${p.doc.category}/${p.doc.year}/${p.doc.id}.pdf`, p.pdf, 'application/pdf'),
			put(`text/${p.doc.id}.txt`, p.text, 'text/plain; charset=utf-8'),
		]);
	});

	// Reassemble in crawl order so old and new decisions interleave the way the listing does.
	const docs: Doc[] = [];
	const chunks: Chunk[] = [];
	const vectors: number[][] = [];
	const embeddedById = new Map(toEmbed.map((p) => [p.doc.id, p]));
	let cursor = 0;
	const offsets = new Map<string, number>();
	for (const p of toEmbed) {
		offsets.set(p.doc.id, cursor);
		cursor += p.chunks.length;
	}

	for (const doc of crawled) {
		const p = embeddedById.get(doc.id);
		if (p) {
			const offset = offsets.get(doc.id)!;
			docs.push({...p.doc, pages: p.doc.pages ?? knownDocs.get(doc.id)?.pages});
			chunks.push(...p.chunks);
			vectors.push(...embedded.slice(offset, offset + p.chunks.length));
		} else if (knownChunks.has(doc.id)) {
			// The crawl is authoritative for listing metadata, so a correction there takes effect on
			// the next run; only what we derived from the PDF itself is carried over.
			docs.push({...doc, pages: knownDocs.get(doc.id)?.pages});
			chunks.push(...knownChunks.get(doc.id)!);
			vectors.push(...knownVectors.get(doc.id)!);
		}
	}

	await writeIndex(docs, chunks, vectors);
	console.log(
		`index written: ${docs.length} decisions, ${chunks.length} chunks, ${prepared.length} new`,
	);
	return {added: prepared.length, total: docs.length};
};

if (require.main === module) {
	runIngest().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
