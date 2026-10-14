import ts from 'typescript';
import type { SourceFileText } from '../snapshot.js';

/**
 * Identifier tokenization shared by the reference-scan and the fixture
 * validator. It uses the TypeScript parser, so an occurrence is an `Identifier`
 * AST node whose text equals the name exactly:
 * - `START_X`, `START_X$` and `$START_X` are different identifiers;
 * - comments, string/template literal text and JSX text are not identifiers,
 *   but expressions inside template `${…}` and JSX `{…}` are scanned;
 * - every occurrence is reported separately, with its line and column;
 * - escaped spellings (`\u0053TART_X`) are the identifier TypeScript resolves them to.
 * The parser always gets the exact, checksum-verified file text stored in the
 * snapshot (never a reconstruction from chunks).
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

/** Declarations whose `name` is the declared identifier. */
const NAMED_DECLARATION = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.VariableDeclaration,
	ts.SyntaxKind.FunctionDeclaration,
	ts.SyntaxKind.FunctionExpression,
	ts.SyntaxKind.ClassDeclaration,
	ts.SyntaxKind.ClassExpression,
	ts.SyntaxKind.InterfaceDeclaration,
	ts.SyntaxKind.TypeAliasDeclaration,
	ts.SyntaxKind.EnumDeclaration,
	ts.SyntaxKind.EnumMember,
	ts.SyntaxKind.ModuleDeclaration, // namespace X {}, module X {}, declare module X {}
	ts.SyntaxKind.TypeParameter,
	ts.SyntaxKind.Parameter,
	ts.SyntaxKind.BindingElement, // `{ a: X }` / `{ X }` in a binding pattern declares X
	ts.SyntaxKind.MethodDeclaration,
	ts.SyntaxKind.MethodSignature,
	ts.SyntaxKind.PropertyDeclaration,
	ts.SyntaxKind.PropertySignature,
	ts.SyntaxKind.PropertyAssignment, // `{ X: 1 }` (the shorthand `{ X }` reads X and is NOT a declaration)
	ts.SyntaxKind.GetAccessor,
	ts.SyntaxKind.SetAccessor,
	ts.SyntaxKind.ImportEqualsDeclaration, // import X = require('m') / import X = A.B
	ts.SyntaxKind.ImportClause, // import X from 'm'
	ts.SyntaxKind.NamespaceImport, // import * as X from 'm'
	ts.SyntaxKind.ImportSpecifier, // import { a as X } — `name`, not `propertyName`
	ts.SyntaxKind.NamespaceExport, // export * as X from 'm'
]);

/**
 * True when this identifier is the name being declared. Only the declaration's own
 * `name` slot counts: calls, property accesses, shorthand properties, export lists,
 * type references and initializers are occurrences, not declarations.
 */
export function isDeclarationName(node: ts.Identifier): boolean {
	const p = node.parent;
	return p !== undefined && NAMED_DECLARATION.has(p.kind) && (p as ts.NamedDeclaration).name === node;
}

/** All occurrences of `name` as an identifier token in one code file. */
export function identifierOccurrences(path: string, text: string, name: string): IdentifierOccurrence[] {
	// No textual pre-filter: an escaped spelling does not contain `name` literally.
	if (!isCodeFile(path)) return [];
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

/** Occurrences of `name` across the given code files (full, verified texts of one source). */
export function occurrencesInFiles(files: readonly SourceFileText[], name: string): IdentifierOccurrence[] {
	const out: IdentifierOccurrence[] = [];
	for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) out.push(...identifierOccurrences(f.path, f.text, name));
	return out;
}
