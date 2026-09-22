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

export const AKI_HEADING_RE = new RegExp(`\\n\\s*(${HEADINGS.join('|')})[:\\s]*\\n`, 'g');

/**
 * Guidance documents have none of the AKI skeleton — the üldjuhend is a numbered manual whose
 * headings look like "3.2. Teabenõude täitmise tähtaeg". Against the whitelist above it matches
 * nothing, the whole 1.5MB lands in PREAMBUL, and every chunk comes back with no idea which rule it
 * belongs to. Same windowing, different splitter.
 *
 * Required to start its own line, to stay under 90 chars, and not to end in sentence punctuation.
 * Without that last condition the üldjuhend's numbered *paragraphs* all match and every paragraph
 * becomes its own section, which is not wrong so much as useless — the label just repeats the body.
 */
export const NUMBERED_HEADING_RE =
	/\n[ \t]*((?:\d{1,2}\.){1,3}\d*[ \t]+(?!.*\.{3})[^\n]{3,90}[^.!?:;, \t])[ \t]*\n/g;

const MAX_CHARS = 1400;
const OVERLAP_CHARS = 200;

export const cleanPdfText = (raw: string): string =>
	raw
		.replace(/\r/g, '')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

/**
 * A heading arrives with pdftotext's line breaks still in it ("2.\n\npeatükk. …") and sometimes a
 * table-of-contents leader. Collapse it to one line so the label is usable as a citation and as the
 * `section` argument of get_guidance.
 */
const label = (raw: string): string =>
	raw
		.replace(/\s+/g, ' ')
		.replace(/\s*\.{3,}\s*\d*$/, '')
		.trim();

/**
 * Split into (section, body) pairs, then window each body on sentence boundaries.
 *
 * The heading pattern is a parameter because the corpora do not share a skeleton; everything after
 * the split — the windowing, the overlap, the section label carried on each chunk — is identical.
 */
export const chunkDocument = (
	text: string,
	headingRe: RegExp = AKI_HEADING_RE,
): {section: string; text: string}[] => {
	const clean = cleanPdfText(text);
	// split() advances lastIndex on a /g regex, so a module-level constant must be reset or the
	// second document silently starts matching from wherever the first one stopped.
	headingRe.lastIndex = 0;
	const parts = clean.split(headingRe);
	const sections: [string, string][] = [['PREAMBUL', parts[0] ?? '']];
	for (let i = 1; i < parts.length - 1; i += 2) {
		sections.push([label(parts[i]), parts[i + 1] ?? '']);
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
