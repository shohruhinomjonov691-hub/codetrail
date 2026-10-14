import ts from 'typescript';
import type { ChunkRecord } from '../snapshot.js';

/**
 * Identifier tokenization shared by the reference-scan and the fixture
 * validator. It uses the TypeScript parser, so an occurrence is an `Identifier`
 * AST node whose text equals the name exactly:
 * - `START_X`, `START_X$` and `$START_X` are different identifiers;
 * - comments, string/template literal text and JSX text are not identifiers,
 *   but expressions inside template `${…}` and JSX `{…}` are scanned;
 * - every occurrence is reported separately, with its line and column.
 *
 * This is a syntactic token match: it is NOT binding-aware (a shadowing local
 * with the same name also counts) and says nothing about runtime usage.
 */
export interface IdentifierOccurrence {
	path: string;
	line: number;
	column: number;
	/** True when this token is the name being declared (variable, function, class, …). */
	isDeclarationName: boolean;
}

const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

export function isCodeFile(path: string): boolean {
	return CODE_FILE.test(path);
}

/** True when `name` scans as exactly one Identifier token (keywords and partial matches are rejected). */
export function isValidIdentifier(name: string): boolean {
	if (!name) return false;
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, name);
	return scanner.scan() === ts.SyntaxKind.Identifier && scanner.getTokenEnd() === name.length && scanner.scan() === ts.SyntaxKind.EndOfFileToken;
}

function scriptKind(path: string): ts.ScriptKind {
	if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
	if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
	if (/\.(js|mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

/**
 * Rebuilds a file's text from its snapshot chunks. Lines no chunk covers are left
 * blank; by the chunker's coverage invariant they hold only whitespace or closing
 * punctuation, which never contains an identifier.
 */
export function fileTextFromChunks(chunks: readonly ChunkRecord[]): string {
	const lines: string[] = [];
	for (const c of chunks) c.text.split('\n').forEach((text, i) => (lines[c.start_line - 1 + i] = text));
	return Array.from(lines, (l) => l ?? '').join('\n');
}

function isDeclarationName(node: ts.Identifier): boolean {
	const p = node.parent;
	if (!p) return false;
	if (
		(ts.isVariableDeclaration(p) ||
			ts.isFunctionDeclaration(p) ||
			ts.isClassDeclaration(p) ||
			ts.isInterfaceDeclaration(p) ||
			ts.isTypeAliasDeclaration(p) ||
			ts.isEnumDeclaration(p) ||
			ts.isEnumMember(p) ||
			ts.isParameter(p) ||
			ts.isBindingElement(p) ||
			ts.isFunctionExpression(p) ||
			ts.isClassExpression(p) ||
			ts.isMethodDeclaration(p) ||
			ts.isPropertyDeclaration(p) ||
			ts.isImportSpecifier(p) ||
			ts.isImportClause(p) ||
			ts.isNamespaceImport(p)) &&
		p.name === node
	) {
		return true;
	}
	return false;
}

/** All occurrences of `name` as an identifier token in one code file. */
export function identifierOccurrences(path: string, text: string, name: string): IdentifierOccurrence[] {
	if (!isCodeFile(path) || !text.includes(name)) return [];
	const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
	const out: IdentifierOccurrence[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === name) {
			const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
			out.push({ path, line: line + 1, column: character + 1, isDeclarationName: isDeclarationName(node) });
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Occurrences of `name` across every code file of one source in the snapshot. */
export function occurrencesInSource(chunks: readonly ChunkRecord[], sourceId: string, name: string): IdentifierOccurrence[] {
	const byPath = new Map<string, ChunkRecord[]>();
	for (const c of chunks) {
		if (c.source_id !== sourceId || !isCodeFile(c.path)) continue;
		const list = byPath.get(c.path) ?? [];
		list.push(c);
		byPath.set(c.path, list);
	}
	const out: IdentifierOccurrence[] = [];
	for (const [path, list] of [...byPath.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		out.push(...identifierOccurrences(path, fileTextFromChunks(list), name));
	}
	return out;
}
