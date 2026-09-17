import {GetObjectCommand, PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {gunzipSync, gzipSync} from 'zlib';
import type {Chunk, CourtDoc, Doc, Index} from '../types';
import {EMBED_DIM} from './bedrock';
import {type Bm25, buildBm25, chunkText, courtChunkText} from './search';

const REGION = process.env.AWS_REGION ?? 'eu-central-1';

/**
 * Two corpora, two indexes, one server. They are kept apart deliberately: merging would bury 657
 * AKI decisions under 10x the court text, and they answer different questions — AKI is the
 * regulator's own practice, the courts are how those positions fared on review.
 */
export interface Corpus<D> {
	name: string;
	bucket: string;
	/** Key prefix inside the bucket; '' for the AKI corpus, which predates the convention. */
	prefix: string;
	/** Text fed to BM25 and the embedder. Must match what the ingest pipeline embedded. */
	chunkText: (doc: D | undefined, chunk: Chunk) => string;
}

export const AKI: Corpus<Doc> = {
	name: 'aki',
	bucket: process.env.CORPUS_BUCKET ?? 'hycapital-aki-rag',
	prefix: '',
	chunkText,
};

export const RT: Corpus<CourtDoc> = {
	name: 'rt',
	bucket: process.env.RT_BUCKET ?? 'hycapital-rt-rag',
	prefix: 'rt/',
	chunkText: courtChunkText,
};

/** Kept for the AKI ingest path, which writes to its own bucket. */
export const BUCKET = AKI.bucket;

const s3 = new S3Client({region: REGION});

const getBytes = async (bucket: string, key: string): Promise<Buffer> => {
	const res = await s3.send(new GetObjectCommand({Bucket: bucket, Key: key}));
	return Buffer.from(await res.Body!.transformToByteArray());
};

/**
 * Vectors are stored int8-quantised: a unit vector scaled to +-127 plus one float scale per
 * chunk. Costs ~1% cosine error and cuts the index from 68MB to 17MB, which keeps the cold-start
 * download under a second.
 */
export const quantize = (vec: number[]): {bytes: Int8Array; scale: number} => {
	let max = 0;
	for (const v of vec) max = Math.max(max, Math.abs(v));
	const scale = max / 127 || 1;
	const bytes = new Int8Array(vec.length);
	for (let i = 0; i < vec.length; i++) bytes[i] = Math.round(vec[i] / scale);
	return {bytes, scale};
};

export const writeIndex = async (
	docs: Doc[],
	chunks: Chunk[],
	vectors: number[][],
): Promise<void> => {
	const bytes = new Int8Array(chunks.length * EMBED_DIM);
	const scales = new Float32Array(chunks.length);
	vectors.forEach((vec, i) => {
		const q = quantize(vec);
		bytes.set(q.bytes, i * EMBED_DIM);
		scales[i] = q.scale;
	});

	const meta = gzipSync(
		Buffer.from(JSON.stringify({builtAt: new Date().toISOString(), dim: EMBED_DIM, docs, chunks})),
	);

	await Promise.all([
		s3.send(new PutObjectCommand({Bucket: AKI.bucket, Key: 'index/meta.json.gz', Body: meta})),
		s3.send(
			new PutObjectCommand({
				Bucket: AKI.bucket,
				Key: 'index/vectors.i8',
				Body: Buffer.from(bytes.buffer),
			}),
		),
		s3.send(
			new PutObjectCommand({
				Bucket: AKI.bucket,
				Key: 'index/scales.f32',
				Body: Buffer.from(scales.buffer),
			}),
		),
	]);
};

export interface Loaded<D> {
	index: Index<D>;
	bm25: Bm25;
}

/**
 * One cache entry per corpus, held for the life of the Lambda execution environment. A container
 * that only ever answers AKI questions never pays to download the larger court index.
 */
const cache = new Map<string, Promise<Loaded<unknown>>>();

export const loadIndex = <D extends {id: string}>(corpus: Corpus<D>): Promise<Loaded<D>> => {
	let entry = cache.get(corpus.name) as Promise<Loaded<D>> | undefined;
	if (!entry) {
		entry = (async () => {
			const [metaGz, vecBuf, scaleBuf] = await Promise.all([
				getBytes(corpus.bucket, `${corpus.prefix}index/meta.json.gz`),
				getBytes(corpus.bucket, `${corpus.prefix}index/vectors.i8`),
				getBytes(corpus.bucket, `${corpus.prefix}index/scales.f32`),
			]);
			const meta = JSON.parse(gunzipSync(metaGz).toString('utf8'));
			const index: Index<D> = {
				builtAt: meta.builtAt,
				dim: meta.dim,
				docs: meta.docs,
				chunks: meta.chunks,
				vectors: new Int8Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.length),
				scales: new Float32Array(scaleBuf.buffer, scaleBuf.byteOffset, scaleBuf.length / 4),
			};
			const docById = new Map(index.docs.map((d) => [d.id, d]));
			const bm25 = buildBm25(
				index.chunks.map((c) => corpus.chunkText(docById.get(c.docId), c)),
			);
			return {index, bm25};
		})();
		cache.set(corpus.name, entry as Promise<Loaded<unknown>>);
	}
	return entry;
};

export const getDocText = async <D>(corpus: Corpus<D>, docId: string): Promise<string> => {
	const buf = await getBytes(corpus.bucket, `${corpus.prefix}text/${docId}.txt`);
	return buf.toString('utf8');
};
