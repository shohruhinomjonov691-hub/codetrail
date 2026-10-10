import ts from 'typescript';
import { LineIndex } from './lines.js';
import { fits, splitRange, type BreakPoint } from './split.js';
import { CHUNK_LIMITS, type ChunkKind, type RawChunk } from './types.js';

interface Unit {
	start: number;
	end: number;
	kind: ChunkKind;
	symbol: string | null;
	packable: boolean;
	node: ts.Node;
	isClass: boolean;
}

function scriptKindFor(path: string): ts.ScriptKind {
	if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
	if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
	if (/\.(js|mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

/** Start line including decorators/modifiers and the comments directly above the node. */
function startLineOf(node: ts.Node, sf: ts.SourceFile, idx: LineIndex): number {
	const comments = ts.getLeadingCommentRanges(sf.text, node.pos);
	const first = comments && comments.length > 0 ? (comments[0] as ts.CommentRange).pos : node.getStart(sf);
	return idx.lineOf(first);
}

function endLineOf(node: ts.Node, sf: ts.SourceFile, idx: LineIndex): number {
	return idx.lineOf(Math.max(node.getStart(sf), node.end - 1));
}

function nameText(name: ts.Node | undefined, sf: ts.SourceFile): string | null {
	if (!name) return null;
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
	return name.getText(sf).slice(0, 80);
}

/** Unwraps `memo(() => …)`, `forwardRef(function …)`, `x as T`, parentheses. */
function unwrapInitializer(expr: ts.Expression | undefined): ts.Expression | undefined {
	let current = expr;
	for (let i = 0; i < 5 && current; i++) {
		if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
			current = current.expression;
		} else if (ts.isCallExpression(current)) {
			const fnArg = current.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
			if (!fnArg) return current;
			current = fnArg;
		} else return current;
	}
	return current;
}

function isFunctionLike(expr: ts.Expression | undefined): boolean {
	return !!expr && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr));
}

function describe(node: ts.Statement, sf: ts.SourceFile): { kind: ChunkKind; symbol: string | null; isClass: boolean; alwaysPack: boolean } {
	if (ts.isFunctionDeclaration(node)) return { kind: 'function', symbol: nameText(node.name, sf) ?? 'default', isClass: false, alwaysPack: false };
	if (ts.isClassDeclaration(node)) return { kind: 'class', symbol: nameText(node.name, sf) ?? 'default', isClass: true, alwaysPack: false };
	if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return { kind: 'type', symbol: node.name.text, isClass: false, alwaysPack: false };
	if (ts.isEnumDeclaration(node)) return { kind: 'enum', symbol: node.name.text, isClass: false, alwaysPack: false };
	if (ts.isModuleDeclaration(node)) return { kind: 'namespace', symbol: nameText(node.name, sf), isClass: false, alwaysPack: false };
	if (ts.isVariableStatement(node)) {
		const decls = node.declarationList.declarations;
		const names = decls.map((d) => nameText(d.name, sf)).filter((n): n is string => !!n);
		const first = unwrapInitializer(decls[0]?.initializer);
		if (decls.length === 1 && first && ts.isClassExpression(first)) return { kind: 'class', symbol: names[0] ?? null, isClass: true, alwaysPack: false };
		const kind: ChunkKind = decls.length === 1 && isFunctionLike(first) ? 'function' : 'variable';
		return { kind, symbol: names.join(', ') || null, isClass: false, alwaysPack: false };
	}
	if (ts.isExportAssignment(node)) {
		const inner = unwrapInitializer(node.expression);
		if (inner && ts.isClassExpression(inner)) return { kind: 'class', symbol: 'default', isClass: true, alwaysPack: false };
		if (isFunctionLike(inner)) return { kind: 'function', symbol: 'default', isClass: false, alwaysPack: false };
		return { kind: 'module', symbol: null, isClass: false, alwaysPack: true };
	}
	if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
		// e.g. describe('AuthGuard', …), app.use(…), bootstrap()
		const callee = node.expression.expression.getText(sf).replace(/\s+/g, '').slice(0, 60);
		const first = node.expression.arguments[0];
		const label = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? `(${JSON.stringify(first.text.slice(0, 60))})` : '()';
		return { kind: 'module', symbol: `${callee}${label}`, isClass: false, alwaysPack: true };
	}
	return { kind: 'module', symbol: null, isClass: false, alwaysPack: true };
}

/** Candidate segment starts inside a node: statements, members, properties, JSX children, case clauses. */
function collectBreaks(root: ts.Node, sf: ts.SourceFile, idx: LineIndex): BreakPoint[] {
	const out: BreakPoint[] = [];
	const visit = (node: ts.Node, depth: number): void => {
		node.forEachChild((child) => {
			const boundary =
				ts.isStatement(child) ||
				ts.isClassElement(child) ||
				ts.isObjectLiteralElement(child) ||
				ts.isJsxElement(child) ||
				ts.isJsxSelfClosingElement(child) ||
				ts.isJsxFragment(child) ||
				ts.isCaseClause(child) ||
				ts.isDefaultClause(child) ||
				ts.isTypeElement(child) ||
				ts.isEnumMember(child);
			if (boundary) {
				out.push({ line: startLineOf(child, sf, idx), depth });
				out.push({ line: endLineOf(child, sf, idx) + 1, depth: depth + 0.5 });
			}
			visit(child, boundary ? depth + 1 : depth);
		});
	};
	visit(root, 0);
	return out;
}

class Emitter {
	readonly chunks: RawChunk[] = [];
	private lastEnd = 0;
	private group: { start: number; end: number; symbols: string[]; kind: ChunkKind } | null = null;

	constructor(
		private readonly idx: LineIndex,
		private readonly sf: ts.SourceFile,
	) {}

	/** Clamp a unit so ranges never overlap (e.g. two statements on one line). */
	private clamp(unit: Unit): Unit | null {
		const start = Math.max(unit.start, this.lastEnd + 1, this.group ? this.group.end + 1 : 0);
		if (start > unit.end) {
			if (this.group) this.group.end = Math.max(this.group.end, unit.end);
			return null;
		}
		return { ...unit, start };
	}

	add(unit: Unit, groupKind: ChunkKind = 'module'): void {
		const u = this.clamp(unit);
		if (!u) return;
		if (u.packable && fits(this.idx, u.start, u.end)) {
			if (this.group && fits(this.idx, this.group.start, u.end)) {
				this.group.end = u.end;
				if (u.symbol && this.group.symbols.length < 4) this.group.symbols.push(u.symbol);
				return;
			}
			this.flush();
			this.group = { start: u.start, end: u.end, symbols: u.symbol ? [u.symbol] : [], kind: groupKind };
			return;
		}
		this.flush();
		this.emitStandalone(u);
	}

	/** Last line already assigned to a chunk or the open group. */
	coveredUntil(): number {
		return Math.max(this.lastEnd, this.group?.end ?? 0);
	}

	flush(): void {
		if (!this.group) return;
		const { start, end, symbols, kind } = this.group;
		this.group = null;
		if (this.idx.slice(start, end).trim().length === 0) return;
		// A tiny leftover (e.g. `export default Page;`) joins the chunk right before it.
		const prev = this.chunks.at(-1);
		if (prev && !prev.part && end - start + 1 < CHUNK_LIMITS.minStandaloneLines && fits(this.idx, prev.startLine, end)) {
			prev.endLine = end;
			this.lastEnd = Math.max(this.lastEnd, end);
			return;
		}
		this.push(splitRange(this.idx, start, end, [], kind, symbols.length ? symbols.join(', ') : null));
	}

	private push(chunks: RawChunk[]): void {
		for (const c of chunks) {
			this.chunks.push(c);
			this.lastEnd = Math.max(this.lastEnd, c.endLine);
		}
	}

	private emitStandalone(u: Unit): void {
		if (fits(this.idx, u.start, u.end)) {
			this.push([{ kind: u.kind, symbol: u.symbol, startLine: u.start, endLine: u.end, part: null }]);
			return;
		}
		const classNode = u.isClass ? findClassLike(u.node) : null;
		if (classNode) {
			this.emitClassMembers(u, classNode);
			return;
		}
		this.push(splitRange(this.idx, u.start, u.end, collectBreaks(u.node, this.sf, this.idx), u.kind, u.symbol));
	}

	/** Oversized class: header/properties packed, each method its own chunk. */
	private emitClassMembers(u: Unit, cls: ts.ClassLikeDeclaration): void {
		const className = u.symbol ?? 'class';
		const members = [...cls.members];
		const firstMemberStart = members.length > 0 ? startLineOf(members[0] as ts.ClassElement, this.sf, this.idx) : u.end;
		const header: Unit = { ...u, end: Math.max(u.start, firstMemberStart - 1), packable: true, kind: 'class', symbol: className, isClass: false };
		this.add(header, 'class');
		for (const member of members) {
			const memberName = nameText((member as { name?: ts.Node }).name, this.sf);
			const isMethod =
				ts.isMethodDeclaration(member) ||
				ts.isConstructorDeclaration(member) ||
				ts.isGetAccessorDeclaration(member) ||
				ts.isSetAccessorDeclaration(member) ||
				(ts.isPropertyDeclaration(member) && isFunctionLike(unwrapInitializer(member.initializer)));
			const symbol = `${className}.${ts.isConstructorDeclaration(member) ? 'constructor' : (memberName ?? 'member')}`;
			const start = startLineOf(member, this.sf, this.idx);
			const end = endLineOf(member, this.sf, this.idx);
			if (isMethod && end - start + 1 >= CHUNK_LIMITS.minStandaloneLines) {
				this.add({ start, end, kind: 'method', symbol, packable: false, node: member, isClass: false });
			} else {
				this.add({ start, end, kind: 'class', symbol, packable: true, node: member, isClass: false }, 'class');
			}
		}
		// Tail between the last member and the closing brace (trailing comments etc.).
		const lastMember = members.at(-1);
		const tailStart = lastMember ? endLineOf(lastMember, this.sf, this.idx) + 1 : firstMemberStart;
		if (tailStart <= u.end && hasSubstance(this.idx.slice(tailStart, u.end))) {
			this.add({ start: tailStart, end: u.end, kind: 'class', symbol: className, packable: true, node: cls, isClass: false }, 'class');
		}
		this.flush(); // a closing brace line that stands alone is left out
	}
}

/** True when text has something besides whitespace and closing punctuation. */
export function hasSubstance(text: string): boolean {
	return text.split('\n').some((line) => line.trim().length > 0 && !/^[\s})\];,]*$/.test(line));
}

function findClassLike(node: ts.Node): ts.ClassLikeDeclaration | null {
	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return node;
	let found: ts.ClassLikeDeclaration | null = null;
	node.forEachChild((child) => {
		if (!found) found = findClassLike(child);
	});
	return found;
}

/** AST chunking for TS/TSX/JS/JSX. Never throws on syntax errors (the parser is tolerant). */
export function chunkTypeScript(path: string, text: string): RawChunk[] {
	const idx = new LineIndex(text);
	const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path));
	const emitter = new Emitter(idx, sf);
	for (const statement of sf.statements) {
		const info = describe(statement, sf);
		const start = startLineOf(statement, sf, idx);
		const end = endLineOf(statement, sf, idx);
		const short = end - start + 1 < CHUNK_LIMITS.minStandaloneLines;
		emitter.add({
			start,
			end,
			kind: info.kind,
			symbol: info.symbol,
			packable: info.alwaysPack || (short && info.kind !== 'function' && info.kind !== 'class'),
			node: statement,
			isClass: info.isClass,
		});
	}
	// Comments after the last statement (e.g. commented-out code at end of file).
	const tailStart = emitter.coveredUntil() + 1;
	let tailEnd = idx.count;
	while (tailEnd >= tailStart && idx.isBlank(tailEnd)) tailEnd--;
	if (tailEnd >= tailStart) {
		emitter.add({ start: tailStart, end: tailEnd, kind: 'module', symbol: null, packable: true, node: sf.endOfFileToken, isClass: false });
	}
	emitter.flush();
	return emitter.chunks;
}
