// Minimal, dependency-free syntax highlighting for TS/JS-like code (other languages render plain).
// Produces DOM nodes only (textContent) — repository code is never inserted as HTML.
const KEYWORDS = new Set(
	('abstract as async await break case catch class const constructor continue debugger declare default delete do else enum export extends ' +
		'false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return ' +
		'satisfies set static super switch this throw true try type typeof undefined var void while with yield').split(' '),
);
const CODE_LANGS = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'graphql']);

const STRING = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/.source;
const REST = /|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/.source;
// JS/TS: `#` starts a private name, not a comment. GraphQL: `#` starts a comment.
const TOKEN_JS = new RegExp(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|/.source + STRING + REST, 'g');
const TOKEN_GQL = new RegExp(/(#[^\n]*)|/.source + STRING + REST, 'g');

/** Splits code into [{text, cls}] tokens. */
export function tokenize(code, language) {
	if (!CODE_LANGS.has(language)) return [{ text: code, cls: '' }];
	const re = language === 'graphql' ? TOKEN_GQL : TOKEN_JS;
	const out = [];
	let last = 0;
	for (const m of code.matchAll(re)) {
		if (m.index > last) out.push({ text: code.slice(last, m.index), cls: '' });
		const [text, comment, string, number, word] = m;
		if (comment) out.push({ text, cls: 'tok-comment' });
		else if (string) out.push({ text, cls: 'tok-string' });
		else if (number) out.push({ text, cls: 'tok-number' });
		else if (word && KEYWORDS.has(word)) out.push({ text, cls: 'tok-keyword' });
		else if (word && /^[A-Z]/.test(word)) out.push({ text, cls: 'tok-type' });
		else out.push({ text, cls: '' });
		last = m.index + text.length;
	}
	if (last < code.length) out.push({ text: code.slice(last), cls: '' });
	return out;
}

/**
 * A <div class="code"> with one row per line: line number + highlighted text.
 * Rows inside `mark` ({start, end}, inclusive line numbers) get the class "hl".
 */
export function renderCode(code, language, firstLine, mark = null) {
	const root = document.createElement('div');
	root.className = 'code';
	let n = firstLine;
	const newRow = () => {
		const row = document.createElement('div');
		row.className = mark && n >= mark.start && n <= mark.end ? 'row hl' : 'row';
		const ln = document.createElement('span');
		ln.className = 'ln';
		ln.textContent = String(n++);
		const text = document.createElement('span');
		text.className = 'src';
		row.append(ln, text);
		root.append(row);
		return text;
	};
	let target = newRow();
	for (const tok of tokenize(code, language)) {
		tok.text.split('\n').forEach((part, i) => {
			if (i > 0) target = newRow();
			if (!part) return;
			const span = document.createElement('span');
			if (tok.cls) span.className = tok.cls;
			span.textContent = part;
			target.append(span);
		});
	}
	return root;
}
