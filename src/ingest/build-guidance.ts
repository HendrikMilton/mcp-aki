/**
 * Build the guidance index from what `guidance.ts` cached on disk.
 *
 * Deliberately simpler than build.ts: that pipeline is incremental because refetching 657 PDFs from
 * a rate-limited server is expensive, whereas everything here is already local. A full rebuild
 * re-embeds from cache and costs about a dollar, so incrementality would buy complexity and little
 * else — the crawl is the slow half, and it resumes on its own.
 */
import {PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import type {Chunk, GuidanceDoc} from '../types';
import {EMBED_BATCH, embedBatch} from '../lib/bedrock';
import {NUMBERED_HEADING_RE, chunkDocument} from '../lib/chunk';
import {mapPool} from '../lib/pool';
import {guidanceChunkText} from '../lib/search';
import {GUIDANCE, writeCorpusIndex} from '../lib/store';

const REGION = process.env.AWS_REGION ?? 'eu-central-1';
const s3 = new S3Client({region: REGION});

const EMBED_CONCURRENCY = 3;
const S3_CONCURRENCY = 8;

const DATA = process.env.GUIDANCE_DATA ?? join(__dirname, '../../data/guidance');

/**
 * A guidance document can be 150k chars where an AKI decision is 10k, so without a cap one manual
 * would contribute a tenth of the index. Chosen round-robin across sections, like mcp-rt does, so a
 * capped document keeps coverage of its whole structure rather than only its opening chapters.
 */
const MAX_CHUNKS_PER_DOC = 80;

const capChunks = (pieces: {section: string; text: string}[]): {section: string; text: string}[] => {
	if (pieces.length <= MAX_CHUNKS_PER_DOC) return pieces;
	const bySection = new Map<string, {section: string; text: string}[]>();
	for (const p of pieces) bySection.set(p.section, [...(bySection.get(p.section) ?? []), p]);

	const queues = [...bySection.values()];
	const out: {section: string; text: string}[] = [];
	for (let round = 0; out.length < MAX_CHUNKS_PER_DOC; round++) {
		let placed = false;
		for (const q of queues) {
			if (round >= q.length) continue;
			out.push(q[round]);
			placed = true;
			if (out.length >= MAX_CHUNKS_PER_DOC) break;
		}
		if (!placed) break;
	}
	return out;
};

const put = (key: string, body: string | Buffer, contentType: string) =>
	s3.send(
		new PutObjectCommand({
			Bucket: GUIDANCE.bucket,
			Key: `${GUIDANCE.prefix}${key}`,
			Body: body,
			ContentType: contentType,
		}),
	);

export const buildGuidance = async (): Promise<void> => {
	const docs: GuidanceDoc[] = JSON.parse(readFileSync(join(DATA, 'docs.json'), 'utf8'));
	console.log(`${docs.length} guidance docs`);

	const kept: GuidanceDoc[] = [];
	const chunks: Chunk[] = [];
	const texts = new Map<string, string>();

	for (const doc of docs) {
		const path = join(DATA, 'text', `${doc.id}.txt`);
		if (!existsSync(path)) continue;
		const text = readFileSync(path, 'utf8');

		const pieces = capChunks(chunkDocument(text, NUMBERED_HEADING_RE));
		if (!pieces.length) continue;

		kept.push(doc);
		texts.set(doc.id, text);
		for (const p of pieces) chunks.push({docId: doc.id, section: p.section, text: p.text});
	}

	console.log(`${kept.length} docs -> ${chunks.length} chunks`);

	const docById = new Map(kept.map((d) => [d.id, d]));
	const flat = chunks.map((c) => guidanceChunkText(docById.get(c.docId), c));
	const batches: string[][] = [];
	for (let i = 0; i < flat.length; i += EMBED_BATCH) batches.push(flat.slice(i, i + EMBED_BATCH));

	let done = 0;
	const vectors = (
		await mapPool(batches, EMBED_CONCURRENCY, async (batch) => {
			const vecs = await embedBatch(batch, 'search_document');
			done += batch.length;
			if (done % 800 < EMBED_BATCH) console.log(`  embedded ${done}/${flat.length}`);
			return vecs;
		})
	).flat();

	// Full text in S3 so get_guidance can return a section without the Lambda holding 19MB of prose
	// in the index it downloads on every cold start.
	await mapPool([...texts.entries()], S3_CONCURRENCY, async ([id, text]) =>
		put(`text/${id}.txt`, text, 'text/plain; charset=utf-8'),
	);

	await writeCorpusIndex(GUIDANCE, kept, chunks, vectors);
	console.log(`wrote ${GUIDANCE.bucket}/${GUIDANCE.prefix}index/ — ${chunks.length} chunks`);
};

if (require.main === module) {
	buildGuidance().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
