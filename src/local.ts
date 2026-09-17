import {createServer} from 'http';
import {handle} from './server';

const port = Number(process.env.PORT ?? 3000);

createServer(async (req, res) => {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const body = Buffer.concat(chunks);

	const request = new Request(`http://localhost:${port}${req.url}`, {
		method: req.method,
		headers: req.headers as Record<string, string>,
		body: body.length ? body : undefined,
	});

	const response = await handle(request);
	res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
	res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`mcp-aki on http://localhost:${port}`));
