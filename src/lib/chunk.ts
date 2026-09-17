/**
 * AKI decisions follow a fixed skeleton of ALL-CAPS section headings, so we split on
 * those first and only then window the text. Keeps the legal reasoning
 * (ANDMEKAITSE INSPEKTSIOONI PÕHJENDUSED) in coherent pieces instead of cutting across it.
 */
const HEADINGS = [
	'RESOLUTSIOON',
	'VAIDLUSTAMISVIIDE',
	'SUNNIRAHA HOIATUS',
	'VÄÄRTEOKARISTUSE HOIATUS',
	'FAKTILISED ASJAOLUD',
	'ASJAOLUD JA MENETLUSKÄIK',
	'MENETLUSKÄIK',
	'VAIDE ESITAJA NÕUE JA PÕHJENDUSED',
	'TEABEVALDAJA PÕHJENDUSED',
	'TEABEVALDAJA SELETUS',
	'ISIKUANDMETE TÖÖTLEJA SELETUS',
	'ISIKUANDMETE TÖÖTLEJA PÕHJENDUSED',
	'ANDMEKAITSE INSPEKTSIOONI PÕHJENDUSED',
	'INSPEKTSIOONI PÕHJENDUSED',
	'PÕHJENDUSED',
	'KOKKUVÕTE',
];

const HEADING_RE = new RegExp(`\\n\\s*(${HEADINGS.join('|')})[:\\s]*\\n`, 'g');

const MAX_CHARS = 1400;
const OVERLAP_CHARS = 200;

export const cleanPdfText = (raw: string): string =>
	raw
		.replace(/\r/g, '')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

/** Split into (section, body) pairs, then window each body on sentence boundaries. */
export const chunkDocument = (text: string): {section: string; text: string}[] => {
	const clean = cleanPdfText(text);
	const parts = clean.split(HEADING_RE);
	const sections: [string, string][] = [['PREAMBUL', parts[0] ?? '']];
	for (let i = 1; i < parts.length - 1; i += 2) {
		sections.push([parts[i].trim(), parts[i + 1] ?? '']);
	}

	const out: {section: string; text: string}[] = [];
	for (const [section, body] of sections) {
		const trimmed = body.trim();
		if (trimmed.length < 80) continue;

		const sentences = trimmed.split(/(?<=[.;:])\s+/);
		let current = '';
		for (const sentence of sentences) {
			if (current.length + sentence.length > MAX_CHARS && current) {
				out.push({section, text: current.trim()});
				current = `${current.slice(-OVERLAP_CHARS)} `;
			}
			current += `${sentence} `;
		}
		if (current.trim()) out.push({section, text: current.trim()});
	}
	return out;
};
