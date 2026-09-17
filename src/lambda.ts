import type {APIGatewayProxyEventV2, APIGatewayProxyResultV2} from 'aws-lambda';
import {handle} from './server';

/** API Gateway HTTP API (payload format 2.0) <-> web-standard Request/Response. */
const toRequest = (event: APIGatewayProxyEventV2): Request => {
	const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
	const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;
	const method = event.requestContext.http.method;
	const body =
		method === 'GET' || method === 'HEAD' || event.body === undefined
			? undefined
			: Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');

	return new Request(url, {
		method,
		headers: event.headers as Record<string, string>,
		body,
	});
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = async (event: any): Promise<APIGatewayProxyResultV2> => {
	// Monthly EventBridge tick re-crawls AKI and rebuilds the index in place.
	if (event?.source === 'aws.events') {
		const {runIngest} = await import('./ingest/build');
		await runIngest();
		return {statusCode: 200, body: JSON.stringify({ok: true})};
	}

	const response = await handle(toRequest(event as APIGatewayProxyEventV2));
	return {
		statusCode: response.status,
		headers: Object.fromEntries(response.headers.entries()),
		body: await response.text(),
	};
};
