import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {buildMcpServer} from './mcp';
import {AKI, RT, loadIndex} from './lib/store';

/** Shared secret in the URL path — the corpus is public, this only keeps the Bedrock bill ours. */
const PATH_TOKEN = process.env.MCP_PATH_TOKEN ?? '';
const MCP_PATH = PATH_TOKEN ? `/mcp/${PATH_TOKEN}` : '/mcp';

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {'content-type': 'application/json'},
	});

/**
 * One router over web-standard Request/Response, which both the Lambda entrypoint and the local
 * dev server adapt to. Going straight to the SDK's web transport avoids express and
 * serverless-http: serverless-http's mock request has no `rawHeaders`, and the Node transport's
 * Hono bridge reads exactly that, so headers arrived empty and every call 415'd.
 */
export const handle = async (request: Request): Promise<Response> => {
	const {pathname} = new URL(request.url);

	if (pathname === '/health') {
		// Reports both corpora, and reports one being unavailable rather than failing the check —
		// a court index that has not been built yet must not take the AKI tools down with it.
		const [aki, rt] = await Promise.all([
			loadIndex(AKI).then(
				({index}) => ({docs: index.docs.length, chunks: index.chunks.length, builtAt: index.builtAt}),
				(err) => ({error: String(err).slice(0, 120)}),
			),
			loadIndex(RT).then(
				({index}) => ({docs: index.docs.length, chunks: index.chunks.length, builtAt: index.builtAt}),
				(err) => ({error: String(err).slice(0, 120)}),
			),
		]);
		return json(200, {ok: true, aki, rt});
	}

	if (pathname === MCP_PATH) {
		// Stateless: consecutive requests land on different Lambda containers, so a session id
		// minted here could never be honoured later.
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		const server = buildMcpServer();
		await server.connect(transport);
		return transport.handleRequest(request);
	}

	return json(404, {error: 'not found'});
};
