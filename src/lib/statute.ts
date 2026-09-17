/**
 * Consolidated Estonian legislation from Riigi Teataja, so a statutory claim can be checked the
 * same way `pattern` made a claim about a decision checkable.
 *
 * This exists because of a specific failure. Asked about "AvTS § 214", the model correctly reported
 * zero corpus hits — a real tool call — and then explained it by saying the act ends at § 58. The
 * conclusion was right (there is no § 214) but the reason was wrong: AvTS runs to § 69, with
 * §§ 59-68 struck from the consolidated text. Nothing could catch that, because no tool could see a
 * statute. The corpus-backed half of an answer was verifiable and the statutory half was not.
 *
 *   GET /akt/lyhendid              abbreviation -> current act id
 *   GET /akt/{id}                  carries grupiId, the identity of the act across all its wordings
 *   GET /akt/{id}/blob-html        the consolidated text
 *   GET /akt/ajalugu/{grupiId}     per-paragraph amendment history with validity ranges
 *
 * The last one is what lets the tool answer the question that actually matters when reading old
 * case law: not "what does the law say" but "did it say something else when this was decided".
 */
const BASE = 'https://www.riigiteataja.ee/public-api/api/v1';
const UA = 'hy-capital-mcp/1.0 (legal research)';

const get = async (path: string): Promise<Response> => {
	const res = await fetch(`${BASE}${path}`, {
		headers: {'user-agent': UA},
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`riigiteataja ${path}: HTTP ${res.status}`);
	return res;
};

interface Abbrev {
	id: number;
	lyhend: string;
	pealkiri: string;
}

/** ~390 acts, a few KB. Held for the life of the Lambda container. */
let abbrevs: Promise<Abbrev[]> | null = null;
const loadAbbrevs = (): Promise<Abbrev[]> => {
	if (!abbrevs) abbrevs = get('/akt/lyhendid').then((r) => r.json() as Promise<Abbrev[]>);
	return abbrevs;
};

export const resolveAct = async (
	abbrev: string,
): Promise<{id: number; title: string; abbrev: string} | null> => {
	const wanted = abbrev.trim().toLowerCase();
	const all = await loadAbbrevs();
	const hit =
		all.find((a) => a.lyhend.toLowerCase() === wanted) ??
		all.find((a) => a.pealkiri.toLowerCase() === wanted);
	return hit ? {id: hit.id, title: hit.pealkiri, abbrev: hit.lyhend} : null;
};

/** Abbreviations that look close to what was asked, for a helpful failure. */
export const suggestActs = async (abbrev: string): Promise<string[]> => {
	const w = abbrev.trim().toLowerCase().slice(0, 3);
	const all = await loadAbbrevs();
	return all
		.filter((a) => a.lyhend.toLowerCase().startsWith(w))
		.slice(0, 8)
		.map((a) => `${a.lyhend} (${a.pealkiri})`);
};

const stripHtml = (html: string): string =>
	html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		// The consolidated HTML interleaves UI affordances with the text; they are not law.
		.replace(/\b(balance|history|link)\b/g, ' ')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

const actText = async (id: number): Promise<string> =>
	stripHtml(await (await get(`/akt/${id}/blob-html`)).text());

/**
 * Paragraph numbers actually *defined* by the act, so "does § N exist" is answered from the text.
 *
 * Matching a bare `§ N` would count cross-references and footnotes as provisions — on AvTS that
 * produced a range of "§ 1-107" when the act ends at § 69, which is the very kind of confidently
 * wrong statutory detail this module exists to prevent. A definition is a paragraph mark, a number,
 * and then a full stop introducing its title.
 */
export const paragraphNumbers = (text: string): number[] =>
	[...new Set([...text.matchAll(/§\s*(\d{1,3})[¹²³]?\s*\./g)].map((m) => Number(m[1])))].sort(
		(a, b) => a - b,
	);

/**
 * One paragraph, from its own heading to the next. Estonian statutes number superscripted
 * paragraphs (§ 408¹), which the consolidated text renders as a separate digit, so `§ 408 1` and
 * `§ 4081` are the same provision seen through different extractions.
 */
export const sliceParagraph = (text: string, paragraph: string): string | null => {
	const n = paragraph.trim().replace(/[^0-9]/g, '');
	if (!n) return null;
	const re = new RegExp(`§\\s*${n}(?![0-9])`, 'g');
	const starts = [...text.matchAll(re)].map((m) => m.index ?? 0);
	if (starts.length === 0) return null;
	// The definition is the occurrence followed by a period and a title, not a cross-reference.
	const start = starts.find((i) => /^§\s*\d+[¹²³0-9]*\s*\./.test(text.slice(i, i + 20))) ?? starts[0];
	const next = text.slice(start + 1).search(/§\s*\d{1,3}\s*\./);
	return (next < 0 ? text.slice(start) : text.slice(start, start + 1 + next)).trim();
};

const SUPERSCRIPTS: Record<string, string> = {
	'1': '\u00b9',
	'2': '\u00b2',
	'3': '\u00b3',
	'4': '\u2074',
	'5': '\u2075',
	'6': '\u2076',
	'7': '\u2077',
	'8': '\u2078',
	'9': '\u2079',
};

const superscript = (digits: string): string =>
	[...digits].map((d) => SUPERSCRIPTS[d] ?? d).join('');

interface HistoryEntry {
	nummerdus: {element: string; number: string; ylaIndeks: string | null}[];
	kirjed: {aktId: number; kehtivuseAlgus: string; kehtivuseLopp: string | null}[];
}

export interface Amendment {
	/** e.g. "§ 35 lg 1 p 8" */
	provision: string;
	inForceFrom: string;
}

/**
 * Amendments to `paragraph` that took effect after `since`.
 *
 * This is the check that matters when reading a judgment: a 2021 decision was decided under the
 * wording then in force, and quoting today's text at it is a substantive error, not a formatting
 * one. Returns the provisions whose current wording postdates the date given.
 */
export const amendmentsSince = async (
	actId: number,
	paragraph: string | undefined,
	since: string,
): Promise<Amendment[]> => {
	const detail = (await (await get(`/akt/${actId}`)).json()) as {grupiId?: number};
	if (!detail.grupiId) return [];

	const history = (await (await get(`/akt/ajalugu/${detail.grupiId}`)).json()) as HistoryEntry[];
	const wanted = paragraph?.trim().replace(/[^0-9]/g, '');
	const out: Amendment[] = [];

	for (const entry of history) {
		const para = entry.nummerdus.find((p) => p.element === 'PARAGRAHV');
		if (!para) continue;
		if (wanted && para.number !== wanted) continue;

		const label = entry.nummerdus
			.map((p) => {
				// Estonian statutes number inserted provisions with a superscript: § 32 and § 32-1 are
				// different sections. Concatenating the digits renders § 32-1 as "§ 321", which names a
				// provision that does not exist — the exact confusion this tool exists to prevent.
				const num = `${p.number}${p.ylaIndeks ? superscript(p.ylaIndeks) : ''}`;
				if (p.element === 'PARAGRAHV') return `§ ${num}`;
				if (p.element === 'LOIGE') return p.number === '-1' ? '' : `lg ${num}`;
				if (p.element === 'ALAMPUNKT' || p.element === 'PUNKT') return `p ${num}`;
				return `${p.element.toLowerCase()} ${num}`;
			})
			.filter(Boolean)
			.join(' ');

		for (const k of entry.kirjed) {
			// Still-current wordings only: a range that has already ended was superseded, and saying
			// "this changed" about a wording that is itself historical would mislead in both directions.
			if (k.kehtivuseLopp) continue;
			const from = (k.kehtivuseAlgus ?? '').slice(0, 10);
			if (from && from > since.slice(0, 10)) out.push({provision: label, inForceFrom: from});
		}
	}

	// One line per provision, newest first; a paragraph amended repeatedly would otherwise repeat.
	const seen = new Map<string, Amendment>();
	for (const a of out.sort((x, y) => y.inForceFrom.localeCompare(x.inForceFrom))) {
		if (!seen.has(a.provision)) seen.set(a.provision, a);
	}
	return [...seen.values()];
};

export interface StatuteResult {
	header: string;
	body: string;
	warning?: string;
}

export const getStatute = async (opts: {
	abbrev: string;
	paragraph?: string;
	changedSince?: string;
}): Promise<StatuteResult> => {
	const act = await resolveAct(opts.abbrev);
	if (!act) {
		const near = await suggestActs(opts.abbrev);
		return {
			header: `No Estonian act with the abbreviation "${opts.abbrev}".`,
			body: near.length ? `Did you mean: ${near.join(', ')}` : '',
		};
	}

	const text = await actText(act.id);
	const nums = paragraphNumbers(text);
	const range = nums.length ? `§ ${nums[0]}-${nums[nums.length - 1]}` : 'no paragraphs found';
	const header = `${act.abbrev} — ${act.title} (current consolidated text, ${range})`;

	if (!opts.paragraph) {
		return {header, body: text.slice(0, 20_000)};
	}

	const slice = sliceParagraph(text, opts.paragraph);
	if (!slice) {
		// The answer that stops an invented citation: the provision is not in the act.
		return {
			header,
			body: '',
			warning:
				`${act.abbrev} has no § ${opts.paragraph}. It runs ${range}. ` +
				`Do not cite it — check whether another act was meant.`,
		};
	}

	let warning: string | undefined;
	if (opts.changedSince) {
		const changes = await amendmentsSince(act.id, opts.paragraph, opts.changedSince).catch(
			() => [],
		);
		if (changes.length) {
			warning =
				`CHANGED SINCE ${opts.changedSince.slice(0, 10)} — the text below is the wording in ` +
				`force today, not the one applied then. Amended: ` +
				changes.map((c) => `${c.provision} (from ${c.inForceFrom})`).join(', ') +
				`. Say so if you rely on this against a decision from that date.`;
		} else {
			warning = `Unchanged since ${opts.changedSince.slice(0, 10)}.`;
		}
	}

	return {header, body: slice.slice(0, 20_000), warning};
};
