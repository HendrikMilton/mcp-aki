import {
	GetDocumentTextDetectionCommand,
	StartDocumentTextDetectionCommand,
	TextractClient,
} from '@aws-sdk/client-textract';
import {BUCKET} from './store';

const REGION = process.env.AWS_REGION ?? 'eu-central-1';
const POLL_MS = 5000;
const MAX_POLLS = 60;

const textract = new TextractClient({region: REGION});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * OCR a scanned decision that has no text layer (~0.5% of the corpus). Textract does not list
 * Estonian among its supported languages, but detection is character-level and in practice returns
 * correct diacritics and section headings; results are cached as text/{id}.txt so each scan is
 * only ever paid for once.
 *
 * Multi-page PDFs require the async API, which reads the object from S3 rather than from bytes.
 */
export const ocrFromS3 = async (key: string): Promise<string> => {
	const started = await textract.send(
		new StartDocumentTextDetectionCommand({
			DocumentLocation: {S3Object: {Bucket: BUCKET, Name: key}},
		}),
	);
	const jobId = started.JobId!;

	for (let poll = 0; poll < MAX_POLLS; poll++) {
		await sleep(POLL_MS);
		const res = await textract.send(new GetDocumentTextDetectionCommand({JobId: jobId}));
		if (res.JobStatus === 'IN_PROGRESS') continue;
		if (res.JobStatus !== 'SUCCEEDED') {
			throw new Error(`Textract job ${jobId} ${res.JobStatus}: ${res.StatusMessage ?? ''}`);
		}

		const lines: string[] = [];
		let page: typeof res | undefined = res;
		let token = res.NextToken;
		for (;;) {
			lines.push(...(page!.Blocks ?? []).filter((b) => b.BlockType === 'LINE').map((b) => b.Text ?? ''));
			if (!token) break;
			page = await textract.send(
				new GetDocumentTextDetectionCommand({JobId: jobId, NextToken: token}),
			);
			token = page.NextToken;
		}
		return lines.join('\n');
	}

	throw new Error(`Textract job ${jobId} did not finish in ${(POLL_MS * MAX_POLLS) / 1000}s`);
};
