export type Category = 'ettekirjutused' | 'vaideotsused' | 'seisukohad';

/** One decision PDF published by AKI. */
export interface Doc {
	id: string; // sha1(url).slice(0,10)
	category: Category;
	year: number;
	title: string;
	url: string;
	date?: string; // dd.mm.yyyy as published
	norms?: string; // Õigusnormid
	addressee?: string; // Adressaat
	topic?: string; // Teema
	pages?: number;
	/** Text came from Textract because the PDF is a scan with no text layer. */
	ocr?: boolean;
}

export type Menetlus = 'tsiviil' | 'kriminaal' | 'haldus' | 'vaarteo' | 'pohiseadus' | 'muu';
export type Tier = 'maakohus' | 'ringkonnakohus' | 'riigikohus';

/**
 * One court decision from Riigi Teataja, built by mcp-rt. Only decisions the classifier accepted as
 * substantively about data protection reach this index — see mcp-rt/README.md for why the corpus is
 * a filtered ~10% of a 22k candidate pool rather than the whole 725k published set.
 */
export interface CourtDoc {
	id: string; // objektId
	nr: string; // case number, e.g. "3-26-1048/10"
	court: string;
	tier: Tier;
	menetlus: Menetlus;
	date: string; // ISO
	year: number;
	categories: string[];
	norms?: string; // statute citations extracted from the text
	confidence: number; // classifier confidence this is a data-protection decision
	summary: string; // the classifier's one-line Estonian reason
	pages?: number;
	url: string;
}

export type GuidanceType = 'juhend' | 'kkk' | 'news' | 'muu';

/**
 * One page or attached document from aki.ee — the regulator's own guidance rather than its
 * decisions. Normative material, so it lives in its own index with its own tools: merged into the
 * decision corpus, a paragraph of the üldjuhend would be cited as though it were binding.
 */
export interface GuidanceDoc {
	id: string; // sha1(url).slice(0,10)
	url: string;
	type: GuidanceType;
	format: 'html' | 'pdf';
	title: string;
	chars: number;
	/** From the /YYYY-MM/ upload path or the page's "Last updated"; 0 when the site publishes none. */
	year: number;
	/** For an attachment, the page it was linked from — PDFs are not in the sitemap. */
	parentUrl?: string;
	date?: string; // ISO, where the page publishes one
	pages?: number;
}

export interface Chunk {
	docId: string;
	section: string;
	text: string;
}

/** A searchable corpus, built by an ingest pipeline and loaded into Lambda memory. */
export interface Index<D = Doc> {
	builtAt: string;
	dim: number;
	docs: D[];
	chunks: Chunk[];
	/** int8-quantised unit vectors, chunk-major, length chunks.length * dim. */
	vectors: Int8Array;
	/** Per-vector dequantisation scale. */
	scales: Float32Array;
}
