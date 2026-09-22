/**
 * Serving a stored decision back to the model.
 *
 * Whole-document fetch is the right default — the median decision is ~20k chars — but the court
 * corpus has a long tail (p99 190k chars, max 2.3M) that would swamp a context window. `pattern`
 * and `section` exist so the model can check a specific claim against the source without paying
 * for the whole document, which is the move that turns "cites a plausible statute" into "cites the
 * statute that is actually there".
 */

/** Characters of context kept either side of a pattern match. */
const MATCH_CONTEXT = 700;
/** Matches returned before the rest are counted rather than shown. */
const MAX_MATCHES = 12;
/** Above this a whole-document fetch is refused, since it would not survive the context anyway. */
export const FULL_TEXT_LIMIT = 120_000;

export interface ExcerptOptions {
	pattern?: string;
	section?: string;
	/**
	 * Heading pattern for section slicing. Defaults to the ALL-CAPS decision skeleton; the guidance
	 * corpus passes NUMBERED_HEADING_RE, whose documents have no ALL-CAPS headings at all — without
	 * this, get_guidance's `section` argument could never match anything.
	 */
	headingRe?: RegExp;
}

export interface Excerpted {
	text: string;
	note?: string;
}

/** ALL-CAPS heading lines, the same skeleton the chunker splits on. */
const SECTION_RE = /^[ \t]*([A-ZÄÖÜÕŠŽ][A-ZÄÖÜÕŠŽ \-,]{4,})[ \t]*$/gm;

const sliceSection = (text: string, wanted: string, headingRe = SECTION_RE): string | null => {
	const want = wanted.trim().toUpperCase();
	headingRe.lastIndex = 0;
	const heads = [...text.matchAll(headingRe)];
	const at = heads.findIndex((h) => h[1].trim().toUpperCase().includes(want));
	if (at < 0) return null;
	const start = heads[at].index ?? 0;
	const end = heads[at + 1]?.index ?? text.length;
	return text.slice(start, end).trim();
};

/**
 * Case-insensitive literal search, not a regex: the model passes things like "KrMS § 64" and a
 * stray `§` or `(` in a user-supplied pattern must not become syntax. Whitespace in the pattern
 * matches any run of whitespace, because PDF extraction leaves ragged spacing inside citations.
 */
const findMatches = (text: string, pattern: string): {start: number; end: number}[] => {
	const escaped = pattern
		.trim()
		.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		.replace(/\s+/g, '\\s+');
	const re = new RegExp(escaped, 'gi');
	const out: {start: number; end: number}[] = [];
	for (const m of text.matchAll(re)) {
		const start = Math.max(0, (m.index ?? 0) - MATCH_CONTEXT);
		const end = Math.min(text.length, (m.index ?? 0) + m[0].length + MATCH_CONTEXT);
		// Merge into the previous window when they touch, so one dense passage is one excerpt.
		const prev = out[out.length - 1];
		if (prev && start <= prev.end) prev.end = end;
		else out.push({start, end});
	}
	return out;
};

export const excerptDocument = (text: string, opts: ExcerptOptions): Excerpted => {
	let body = text;
	let scope = '';

	if (opts.section) {
		const found = sliceSection(text, opts.section, opts.headingRe);
		if (!found) {
			const available = [...text.matchAll(opts.headingRe ?? SECTION_RE)].map((m) => m[1].trim());
			return {
				text: '',
				note:
					`No section matching "${opts.section}". Sections present: ` +
					`${[...new Set(available)].join(', ') || 'none — this document has no headings'}.`,
			};
		}
		body = found;
		scope = ` · section ${opts.section.toUpperCase()}`;
	}

	if (opts.pattern) {
		const windows = findMatches(body, opts.pattern);
		if (windows.length === 0) {
			// The useful answer, and the one that stops a fabricated citation: it is not in there.
			return {
				text: '',
				note:
					`"${opts.pattern}" does not appear in this document${scope}. ` +
					`Do not cite it — search the text for what it does say instead.`,
			};
		}
		const shown = windows.slice(0, MAX_MATCHES);
		const text_ = shown
			.map((w, i) => `--- match ${i + 1} of ${windows.length} ---\n…${body.slice(w.start, w.end).trim()}…`)
			.join('\n\n');
		return {
			text: text_,
			note:
				`${windows.length} passage(s) contain "${opts.pattern}"${scope}` +
				(windows.length > shown.length ? `; showing the first ${shown.length}` : '') + '.',
		};
	}

	if (body.length > FULL_TEXT_LIMIT) {
		return {
			text: body.slice(0, FULL_TEXT_LIMIT),
			note:
				`This decision is ${body.length.toLocaleString()} characters; showing the first ` +
				`${FULL_TEXT_LIMIT.toLocaleString()}. Re-fetch with a pattern to check a specific ` +
				`citation, or with a section to read one part in full.`,
		};
	}

	return {text: body, note: scope ? `Section ${opts.section?.toUpperCase()}.` : undefined};
};
