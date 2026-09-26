/**
 * Local search visualiser: the live index as a 2D map, plus a trace of any query through the real
 * search pipeline (dense + BM25 -> RRF pool -> rerank). Not deployed; reads S3 like the Lambda does.
 *
 *   AWS_PROFILE=hycapital CORPUS=rt npx ts-node viz/server.ts   # rt | aki | guidance
 *
 * The first run per index build projects the vectors with UMAP (python, via uv) and caches them.
 */
import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {createServer} from 'http';
import {join} from 'path';
import {AKI, GUIDANCE, RT, loadIndex, type Corpus} from '../src/lib/store';
import {searchTrace, type FilterableDoc, type SearchFilters} from '../src/lib/search';

const CORPORA: Record<string, Corpus<any>> = {rt: RT, aki: AKI, guidance: GUIDANCE};
const corpus = CORPORA[process.env.CORPUS ?? 'rt'];
if (!corpus) throw new Error(`CORPUS must be one of ${Object.keys(CORPORA).join(', ')}`);
const PORT = Number(process.env.PORT ?? 4747);

/** Where a query lands on the map: the similarity-weighted mean of its nearest chunks. */
const NEIGHBOURS = 10;

const main = async () => {
	console.log(`loading ${corpus.name} index from s3://${corpus.bucket}/${corpus.prefix}index/`);
	const {index, bm25} = await loadIndex<FilterableDoc & Record<string, any>>(corpus);
	const n = index.chunks.length;
	const dim = index.dim;

	const tag = createHash('sha1').update(`${corpus.name}:${index.builtAt}`).digest('hex').slice(0, 10);
	const cache = join(__dirname, 'cache', `${corpus.name}-${tag}`);
	mkdirSync(cache, {recursive: true});
	if (!existsSync(join(cache, 'coords.f32'))) {
		console.log(`projecting ${n} chunks with UMAP (one-off for index built ${index.builtAt})...`);
		writeFileSync(join(cache, 'vectors.i8'), Buffer.from(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength));
		writeFileSync(join(cache, 'scales.f32'), Buffer.from(index.scales.buffer, index.scales.byteOffset, index.scales.byteLength));
		writeFileSync(join(cache, 'dim'), String(dim));
		execFileSync('uv', ['run', '--with', 'umap-learn', 'python', join(__dirname, 'project.py'), cache], {stdio: 'inherit'});
	}
	const buf = readFileSync(join(cache, 'coords.f32'));
	const xy = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);

	const docById = new Map(index.docs.map((d) => [d.id, d]));
	const docIdx = new Map(index.docs.map((d, i) => [d.id, i]));
	const labelOf = (d: any) => d?.nr ?? d?.title ?? d?.id ?? '?';

	const points = JSON.stringify({
		corpus: corpus.name,
		builtAt: index.builtAt,
		x: Array.from({length: n}, (_, i) => +xy[2 * i].toFixed(3)),
		y: Array.from({length: n}, (_, i) => +xy[2 * i + 1].toFixed(3)),
		doc: index.chunks.map((c) => docIdx.get(c.docId) ?? -1),
		section: index.chunks.map((c) => c.section),
		docs: index.docs.map((d: any) => ({
			label: labelOf(d),
			court: d.court,
			year: d.year,
			menetlus: d.menetlus,
			tier: d.tier,
			category: d.category,
			type: d.type,
			url: d.url,
		})),
	});

	const cosine = (i: number, q: number[], qNorm: number) => {
		let dot = 0;
		const base = i * dim;
		for (let d = 0; d < dim; d++) dot += index.vectors[base + d] * q[d];
		return (dot * index.scales[i]) / qNorm;
	};

	const trace = async (q: string, filters: SearchFilters, topK: number) => {
		const t = await searchTrace(corpus, index, bm25, q, filters, topK);
		const qNorm = Math.sqrt(t.queryVec.reduce((s, v) => s + v * v, 0));
		const rank = (list: number[]) => new Map(list.map((c, r) => [c, r + 1]));
		const [dR, lR, pR] = [rank(t.dense), rank(t.lexical), rank(t.pool)];
		const fR = new Map(t.final.map((f, r) => [f.chunk, {rank: r + 1, score: f.score}]));
		const ids = [...new Set([...t.dense, ...t.lexical])];

		let wx = 0;
		let wy = 0;
		let w = 0;
		for (const c of t.dense.slice(0, NEIGHBOURS)) {
			const s = Math.max(cosine(c, t.queryVec, qNorm), 0);
			wx += s * xy[2 * c];
			wy += s * xy[2 * c + 1];
			w += s;
		}

		return {
			query: q,
			at: w ? [wx / w, wy / w] : null,
			candidates: ids.map((c) => ({
				chunk: c,
				doc: labelOf(docById.get(index.chunks[c].docId)),
				section: index.chunks[c].section,
				cosine: +cosine(c, t.queryVec, qNorm).toFixed(4),
				dense: dR.get(c) ?? null,
				lexical: lR.get(c) ?? null,
				pool: pR.get(c) ?? null,
				final: fR.get(c)?.rank ?? null,
				rerank: fR.get(c) ? +fR.get(c)!.score.toFixed(4) : null,
			})),
		};
	};

	createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
			if (url.pathname === '/') {
				res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
				return res.end(readFileSync(join(__dirname, 'index.html'), 'utf8'));
			}
			if (url.pathname === '/points') {
				res.writeHead(200, {'content-type': 'application/json'});
				return res.end(points);
			}
			if (url.pathname === '/chunk') {
				const c = index.chunks[Number(url.searchParams.get('i'))];
				res.writeHead(c ? 200 : 404, {'content-type': 'application/json'});
				return res.end(JSON.stringify(c ? {...c, doc: docById.get(c.docId)} : {}));
			}
			if (url.pathname === '/trace' && req.method === 'POST') {
				const parts: Buffer[] = [];
				for await (const p of req) parts.push(p as Buffer);
				const {q, filters = {}, topK = 10} = JSON.parse(Buffer.concat(parts).toString('utf8'));
				const out = await trace(String(q), filters, Math.min(Number(topK) || 10, 50));
				res.writeHead(200, {'content-type': 'application/json'});
				return res.end(JSON.stringify(out));
			}
			res.writeHead(404).end();
		} catch (err) {
			console.error(err);
			res.writeHead(500, {'content-type': 'text/plain'}).end(String(err));
		}
	}).listen(PORT, '127.0.0.1', () => console.log(`visualiser on http://localhost:${PORT}`));
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
