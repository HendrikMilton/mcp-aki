import {BedrockRuntimeClient, InvokeModelCommand} from '@aws-sdk/client-bedrock-runtime';
import {BedrockAgentRuntimeClient, RerankCommand} from '@aws-sdk/client-bedrock-agent-runtime';

const REGION = process.env.AWS_REGION ?? 'eu-central-1';

// Embed v4 is only served through an inference profile — the bare model id rejects on-demand calls.
const EMBED_MODEL = process.env.EMBED_MODEL_ID ?? 'eu.cohere.embed-v4:0';
const RERANK_MODEL_ARN =
	process.env.RERANK_MODEL_ARN ?? `arn:aws:bedrock:${REGION}::foundation-model/cohere.rerank-v3-5:0`;

export const EMBED_DIM = 1536;
export const EMBED_BATCH = 32;
/** Rerank scores sources independently, so trimming long chunks costs little and bounds the payload. */
const RERANK_MAX_CHARS = 3500;

/** Embed v4 is throttled on tokens per minute, so a bulk ingest will hit it; adaptive mode backs
 *  off on the client side instead of failing the run. */
const RETRY = {maxAttempts: 8, retryMode: 'adaptive' as const};

const runtime = new BedrockRuntimeClient({region: REGION, ...RETRY});
const agentRuntime = new BedrockAgentRuntimeClient({region: REGION, ...RETRY});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The SDK's own retries cover brief spikes; a sustained ingest needs longer, wider spacing. */
const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const name = (err as {name?: string}).name ?? '';
			if (attempt >= 6 || !/Throttling|TooManyRequests|ServiceUnavailable/i.test(name)) throw err;
			await sleep(Math.min(2 ** attempt * 1000, 30_000) * (0.5 + Math.random()));
		}
	}
};

export type InputType = 'search_document' | 'search_query';

/** One InvokeModel call. `texts` must be at most EMBED_BATCH long. */
export const embedBatch = async (texts: string[], inputType: InputType): Promise<number[][]> => {
	const body = {
		texts,
		input_type: inputType,
		embedding_types: ['float'],
		output_dimension: EMBED_DIM,
		truncate: 'END',
	};
	const res = await withRetry(() =>
		runtime.send(
			new InvokeModelCommand({
				modelId: EMBED_MODEL,
				contentType: 'application/json',
				body: JSON.stringify(body),
			}),
		),
	);
	return JSON.parse(Buffer.from(res.body).toString('utf8')).embeddings.float;
};

/** Cohere embed v4. Asymmetric: documents and queries must use different input types. */
export const embed = async (texts: string[], inputType: InputType): Promise<number[][]> => {
	const out: number[][] = [];
	for (let i = 0; i < texts.length; i += EMBED_BATCH) {
		out.push(...(await embedBatch(texts.slice(i, i + EMBED_BATCH), inputType)));
	}
	return out;
};

/** Cohere rerank 3.5. Returns candidate indices reordered by relevance, best first. */
export const rerank = async (
	query: string,
	documents: string[],
	topN: number,
): Promise<{index: number; score: number}[]> => {
	if (documents.length === 0) return [];
	const res = await withRetry(() =>
		agentRuntime.send(
			new RerankCommand({
				queries: [{type: 'TEXT', textQuery: {text: query}}],
				sources: documents.map((text) => ({
					type: 'INLINE',
					inlineDocumentSource: {
						type: 'TEXT',
						textDocument: {text: text.slice(0, RERANK_MAX_CHARS)},
					},
				})),
				rerankingConfiguration: {
					type: 'BEDROCK_RERANKING_MODEL',
					bedrockRerankingConfiguration: {
						numberOfResults: Math.min(topN, documents.length),
						modelConfiguration: {modelArn: RERANK_MODEL_ARN},
					},
				},
			}),
		),
	);
	return (res.results ?? []).map((r) => ({index: r.index ?? 0, score: r.relevanceScore ?? 0}));
};
