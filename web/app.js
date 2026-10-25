import { renderCode } from './highlight.js';
import { errorKeys } from './errors.js';
import { DEFAULT_LANG, DICT, LANGS } from './i18n.js';

const LANG_KEY = 'codetrail.lang';
/** Earlier questions sent with a follow-up (the server accepts at most 2; answers are never sent). */
const MAX_PREVIOUS = 2;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text !== undefined) n.textContent = text;
	return n;
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
	file: 'M7 3h7l4 4v14H7Z M14 3v4h4',
	sparkle: 'M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2Z',
	chevronLeft: 'm14 6-6 6 6 6',
	chevronRight: 'm10 6 6 6-6 6',
	close: 'M6 6l12 12M18 6 6 18',
	copy: 'M9 9h10v10H9Z M5 15V5h10',
	branch: 'M7 4v10 M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M7 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M17 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M17 8c0 5-10 3-10 8',
	warn: 'M12 4 2.5 20h19Z M12 10v4 M12 17h.01',
	info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 11v5 M12 8h.01',
	user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4 21c1-4 4.5-6 8-6s7 2 8 6',
	shield: 'M12 3 5 6v5c0 5 3 8.5 7 10 4-1.5 7-5 7-10V6Z',
	clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 7v5l3 2',
	flow: 'M6 4h4v4H6Z M14 16h4v4h-4Z M8 8v4h8v4',
	gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1 7 17 M17 7l2.1-2.1',
};
const EXAMPLE_ICONS = ['shield', 'clock', 'flow', 'gear'];

function icon(name, cls = 'icon') {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('class', cls);
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', ICONS[name]);
	path.setAttribute('fill', 'none');
	svg.append(path);
	return svg;
}

function storedLang() {
	try {
		const v = localStorage.getItem(LANG_KEY);
		return LANGS.includes(v) ? v : DEFAULT_LANG;
	} catch {
		return DEFAULT_LANG;
	}
}

const state = {
	lang: storedLang(),
	project: null,
	ai: { available: false, model: null },
	/** null until known; false after the search service failed, true after it answered. */
	searchOk: null,
	/** The conversation; lives only in this tab's memory (never stored). */
	messages: [],
	nextId: 1,
	busy: false,
	controller: null,
	/** Right panel: {kind:'intro'} | {kind:'how'} | {kind:'source', msgId, list:'cite'|'hits', idx} */
	panel: { kind: 'intro' },
	/** Narrow screens show the panel as a sheet; this is the button that opened it (focus returns there). */
	trigger: null,
	formError: null,
};

function t(key, vars = {}) {
	const value = DICT[state.lang][key] ?? DICT.en[key] ?? key;
	return typeof value === 'string' ? value.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : value;
}

const shortCommit = (commit) => commit.slice(0, 12);
const narrow = () => window.matchMedia('(max-width: 1199px)').matches;

// ---------- static text, language switch ----------

function applyStatic() {
	document.documentElement.lang = state.lang;
	for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
	for (const n of document.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
	for (const n of document.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
	for (const b of document.querySelectorAll('.lang-btn')) b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
	if (state.messages.length) $('question').placeholder = t('question.followUp');
	renderChips();
	renderStatus();
	renderDetails();
	renderFormError();
}

function setLang(lang) {
	if (!LANGS.includes(lang) || lang === state.lang) return;
	state.lang = lang;
	try {
		localStorage.setItem(LANG_KEY, lang);
	} catch {
		/* private mode: the choice just isn't remembered */
	}
	applyStatic();
	renderMessages();
	renderPanel();
}

function renderChips() {
	const box = $('chips');
	const titles = t('examples.titles');
	box.replaceChildren(
		...t('examples.items').map((q, i) => {
			// A native button inside a list item: announced as a button, grouped as a list.
			const item = el('li');
			const chip = el('button', 'chip');
			chip.type = 'button';
			const text = el('span', 'chip-text');
			text.append(el('strong', 'chip-title', titles[i] ?? ''), el('span', 'chip-q', q));
			chip.append(icon(EXAMPLE_ICONS[i] ?? 'info', 'icon chip-icon'), text, icon('chevronRight', 'icon chip-go'));
			// Fills the question only — never searches or calls the AI by itself.
			chip.addEventListener('click', () => {
				$('question').value = q;
				autoGrow();
				$('question').focus();
			});
			item.append(chip);
			return item;
		}),
	);
}

function renderStatus() {
	const set = (id, ok, okKey, offKey) => {
		const node = $(id);
		node.classList.toggle('ok', ok);
		node.classList.toggle('off', !ok);
		node.querySelector('.status-text').textContent = t(ok ? okKey : offKey);
	};
	set('search-status', state.searchOk !== false && Boolean(state.project), 'status.searchReady', 'status.searchDown');
	set('ai-status', state.ai.available, 'status.aiOn', 'status.aiOff');
	$('ai-status').classList.toggle('ai', state.ai.available);
	$('ai-off-note').hidden = state.ai.available || !state.project;
	updateButtons();
}

function updateButtons() {
	const ready = Boolean(state.project);
	$('send-btn').disabled = !ready || state.busy;
	$('send-btn').hidden = state.busy;
	$('stop-btn').hidden = !state.busy;
	$('search-btn').disabled = !ready || state.busy;
	// without AI the send button already searches; a second search button would only repeat it
	$('search-btn').hidden = !state.ai.available;
	$('send-btn').setAttribute('aria-label', t(state.ai.available ? 'action.send' : 'action.sendSearch'));
	$('send-btn').title = t(state.ai.available ? 'action.send' : 'action.sendSearch');
}

function renderDetails() {
	const list = $('details-list');
	const p = state.project;
	if (!p) return void list.replaceChildren();
	const row = (label, value) => [el('dt', '', label), el('dd', 'mono', value)];
	list.replaceChildren(
		...row(t('details.snapshot'), p.snapshot_id),
		...row(t('details.commits'), p.sources.map((s) => `${s.source_id}@${shortCommit(s.commit)}`).join('\n')),
		...row(t('details.chunks'), String(p.chunks)),
	);
}

function renderFormError() {
	const box = $('form-error');
	box.hidden = !state.formError;
	box.textContent = state.formError ? t(state.formError) : '';
}

// ---------- message model ----------

/** One inspectable source per distinct citation, shown with its whole chunk when the chunk is in the hits. */
function citationSources(res) {
	const out = [];
	const byLabel = new Map();
	const claimSource = res.claims.map((c) => {
		const cite = c.citation;
		if (byLabel.has(cite.label)) return byLabel.get(cite.label);
		const hit = res.hits.find((h) => h.source_id === cite.source_id && h.path === cite.path && h.start_line <= cite.start_line && h.end_line >= cite.end_line);
		out.push({
			source_id: cite.source_id,
			commit: cite.commit,
			path: cite.path,
			language: cite.language,
			symbol: hit?.symbol ?? null,
			code: hit ? hit.code : cite.code,
			first: hit ? hit.start_line : cite.start_line,
			mark: { start: cite.start_line, end: cite.end_line },
		});
		byLabel.set(cite.label, out.length - 1);
		return out.length - 1;
	});
	return { sources: out, claimSource };
}

function hitSources(res) {
	return res.hits.map((h) => ({ source_id: h.source_id, commit: h.commit, path: h.path, language: h.language, symbol: h.symbol, role: h.role, code: h.code, first: h.start_line, last: h.end_line, mark: null }));
}

function sourceList(msg, list) {
	if (!msg?.res) return [];
	return list === 'cite' ? msg.cite.sources : msg.hitSources;
}

function previousQuestions() {
	return state.messages
		.filter((m) => m.role === 'user')
		.slice(-MAX_PREVIOUS)
		.map((m) => m.text);
}

// ---------- conversation rendering ----------

function notice(kind, title, body) {
	const card = el('div', `notice notice-${kind}`);
	card.setAttribute('role', kind === 'error' ? 'alert' : 'status');
	if (kind === 'loading') card.append(el('span', 'spinner'));
	else card.append(icon(kind === 'warn' || kind === 'error' ? 'warn' : 'info', 'icon notice-icon'));
	const text = el('div');
	text.append(el('strong', '', title));
	for (const b of [].concat(body ?? [])) text.append(el('p', '', b));
	card.append(text);
	return card;
}

function selKey(msgId, list, idx) {
	return `${msgId}:${list}:${idx}`;
}

function hitRow(msg, src, i) {
	const li = el('li');
	const btn = el('button', 'hit-row');
	btn.type = 'button';
	btn.dataset.sel = selKey(msg.id, 'hits', i);
	const body = el('span', 'hit-body');
	const meta = el('span', 'hit-meta');
	const commit = el('span', 'mono');
	commit.append(icon('branch', 'icon icon-sm'), document.createTextNode(` ${src.source_id}@${shortCommit(src.commit)}`));
	meta.append(commit, el('span', 'mono', `L${src.first}–${src.last}`), el('span', `role role-${src.role}`, t(`role.${src.role}`)));
	body.append(el('span', 'hit-title', src.symbol ?? src.path.split('/').pop()), el('span', 'hit-path mono', src.path), meta);
	btn.append(el('span', 'rank', String(i + 1)), icon('file', 'icon hit-file'), body, icon('chevronRight', 'icon hit-go'));
	btn.addEventListener('click', () => openSource(msg.id, 'hits', i, btn));
	li.append(btn);
	return li;
}

function hitList(msg) {
	const ul = el('ul', 'hit-list');
	ul.append(...msg.hitSources.map((src, i) => hitRow(msg, src, i)));
	return ul;
}

/** Text with `backtick` spans shown as inline code (DOM nodes only; never HTML). */
function richText(text) {
	const frag = document.createDocumentFragment();
	text.split('`').forEach((part, i) => {
		if (part) frag.append(i % 2 ? el('code', 'inline-code', part) : document.createTextNode(part));
	});
	return frag;
}

function answerCard(msg) {
	const res = msg.res;
	const card = el('article', 'answer-card');
	if (res.language !== state.lang) card.append(el('p', 'lang-note', t('answer.langNote')));
	// One short answer: each sentence followed by a compact button for its source.
	const body = el('p', 'answer-text');
	res.claims.forEach((c, i) => {
		const idx = msg.cite.claimSource[i];
		const src = msg.cite.sources[idx];
		const loc = `${src.path.split('/').pop()}:L${src.mark.start}–${src.mark.end}`;
		const btn = el('button', 'cite-chip', String(idx + 1));
		btn.type = 'button';
		btn.dataset.sel = selKey(msg.id, 'cite', idx);
		btn.title = loc;
		btn.setAttribute('aria-label', t('answer.sourceLabel', { n: idx + 1, loc }));
		btn.addEventListener('click', () => openSource(msg.id, 'cite', idx, btn));
		const sentence = el('span', 'claim');
		sentence.append(richText(c.text), document.createTextNode(' '), btn);
		body.append(sentence, document.createTextNode(' '));
	});
	card.append(body);
	// A flag from the model; the note is the server's fixed EN/KO text, never model text.
	if (res.partial && res.message) card.append(el('p', 'partial-note', res.message));
	const foot = el('footer', 'answer-foot');
	foot.append(el('span', 'muted', `${t('answer.caveat')} · ${res.model ?? ''}${res.cached ? ` · ${t('answer.cached')}` : ''}`));
	if (msg.hitSources.length) {
		const toggle = el('button', 'link-btn', t(msg.showHits ? 'sources.hide' : 'sources.show', { n: msg.hitSources.length }));
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(Boolean(msg.showHits)));
		toggle.dataset.focus = `toggle-${msg.id}`;
		toggle.addEventListener('click', () => {
			msg.showHits = !msg.showHits;
			updateMessage(msg);
		});
		foot.append(toggle);
	}
	card.append(foot);
	if (msg.showHits) card.append(hitList(msg));
	return card;
}

function resultBody(msg) {
	const res = msg.res;
	const box = el('div', 'result');
	if (res.previous_questions?.length) box.append(el('p', 'context-note', t('chat.followUpNote')));
	if (res.mode === 'answer') {
		box.append(answerCard(msg));
		return box;
	}
	if (res.hits.length === 0 && res.mode !== 'insufficient') box.append(notice('info', t('status.empty.title'), t('status.empty.body')));
	else if (res.mode === 'insufficient') box.append(notice('info', t('status.insufficient.title'), t('status.insufficient.body')));
	else if (res.mode === 'fallback') {
		const reason = t(`reason.${res.reason}`) === `reason.${res.reason}` ? t('reason.unknown') : t(`reason.${res.reason}`);
		box.append(notice('warn', t('status.fallback.title'), [reason, t('status.fallback.body')]));
	}
	if (res.hits.length) {
		const head = el('div', 'section-head');
		const titles = el('div');
		titles.append(el('h3', '', t('search.title')), el('p', 'muted', t('search.subtitle')));
		head.append(titles, el('span', 'muted', t('sources.count', { n: res.hits.length })));
		box.append(head, hitList(msg));
	}
	return box;
}

function renderMessage(msg) {
	const li = el('li', `msg msg-${msg.role}`);
	li.id = `msg-${msg.id}`;
	if (msg.role === 'user') {
		const avatar = el('span', 'avatar');
		avatar.append(icon('user'));
		const body = el('div', 'msg-body');
		body.append(el('span', 'msg-who', t('chat.you')), el('p', 'msg-text', msg.text));
		li.append(avatar, body);
		return li;
	}
	const body = el('div', 'msg-body');
	if (msg.kind === 'loading') body.append(notice('loading', t(msg.explain ? 'status.explaining' : 'status.searching')));
	else if (msg.kind === 'stopped') body.append(el('p', 'stopped', t('stopped')));
	else if (msg.kind === 'error') body.append(notice('error', t(msg.err.titleKey), msg.err.bodyKey ? t(msg.err.bodyKey) : undefined));
	else body.append(resultBody(msg));
	li.append(body);
	return li;
}

/** Re-renders while keeping keyboard focus on the same control. */
function keepFocus(fn) {
	const a = document.activeElement;
	const key = a?.dataset?.sel ? `[data-sel="${a.dataset.sel}"]` : a?.dataset?.focus ? `[data-focus="${a.dataset.focus}"]` : null;
	fn();
	if (key) document.querySelector(key)?.focus();
	markSelected();
}

function renderMessages() {
	const chatting = state.messages.length > 0;
	$('chat').hidden = !chatting;
	$('hero').hidden = chatting;
	$('home-extra').hidden = chatting;
	document.body.classList.toggle('chatting', chatting);
	keepFocus(() => $('messages').replaceChildren(...state.messages.map(renderMessage)));
}

function updateMessage(msg) {
	const old = $(`msg-${msg.id}`);
	if (!old) return renderMessages();
	keepFocus(() => old.replaceWith(renderMessage(msg)));
}

function markSelected() {
	const p = state.panel;
	const current = p.kind === 'source' ? selKey(p.msgId, p.list, p.idx) : null;
	for (const b of document.querySelectorAll('[data-sel]')) {
		const on = b.dataset.sel === current;
		b.classList.toggle('selected', on);
		if (on) b.setAttribute('aria-current', 'true');
		else b.removeAttribute('aria-current');
	}
}

// ---------- right panel ----------

function openSource(msgId, list, idx, trigger) {
	state.panel = { kind: 'source', msgId, list, idx };
	state.trigger = trigger ?? null;
	renderPanel();
	markSelected();
	if (narrow()) openSheet();
}

function showPanel(kind, trigger) {
	state.panel = { kind };
	state.trigger = trigger ?? null;
	renderPanel();
	markSelected();
	if (narrow() && kind !== 'intro') openSheet();
	else releaseSheet();
}

// On narrow screens the inspector is a modal sheet: the page behind it is inert, Tab stays
// inside it and Esc closes it. On wide screens it is an ordinary, non-modal side column.
let sheetKeydown = null;
const sheetBackground = () => [document.querySelector('.sidebar'), $('main')];

function sheetFocusables() {
	return [...$('inspector').querySelectorAll('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')].filter((n) => n.getClientRects().length > 0);
}

function trapTab(e) {
	const items = sheetFocusables();
	const inspector = $('inspector');
	e.preventDefault();
	if (!items.length) return void inspector.focus();
	const i = items.indexOf(document.activeElement);
	if (e.shiftKey) (i <= 0 ? items[items.length - 1] : items[i - 1]).focus();
	else (i < 0 || i === items.length - 1 ? items[0] : items[i + 1]).focus();
}

function openSheet() {
	if (!sheetKeydown) {
		for (const n of sheetBackground()) n.inert = true;
		sheetKeydown = (e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				closePanel();
			} else if (e.key === 'Tab') trapTab(e);
		};
		document.addEventListener('keydown', sheetKeydown);
		$('inspector').setAttribute('role', 'dialog');
		$('inspector').setAttribute('aria-modal', 'true');
	}
	document.body.classList.add('panel-open'); // visible at once; only the slide-in is animated
	$('inspector').focus();
}

/** Ends the modal state (inert, key listener, dialog role); focus is left to the caller. */
function releaseSheet() {
	document.body.classList.remove('panel-open');
	if (!sheetKeydown) return;
	document.removeEventListener('keydown', sheetKeydown);
	sheetKeydown = null;
	for (const n of sheetBackground()) n.inert = false;
	$('inspector').removeAttribute('role');
	$('inspector').removeAttribute('aria-modal');
}

function closePanel() {
	releaseSheet();
	const p = state.panel;
	const back = state.trigger;
	state.trigger = null;
	// the button that opened the sheet; if a re-render replaced it, the same source's new button; else the composer
	const same = p.kind === 'source' ? document.querySelector(`[data-sel="${selKey(p.msgId, p.list, p.idx)}"]`) : null;
	(back?.isConnected ? back : same ?? $('question')).focus();
}

function panelHead(titleNode, extra = []) {
	const head = el('header', 'panel-head');
	head.append(titleNode, ...extra);
	const close = el('button', 'icon-btn panel-close');
	close.type = 'button';
	close.setAttribute('aria-label', t('inspector.close'));
	close.append(icon('close'));
	close.addEventListener('click', closePanel);
	head.append(close);
	return head;
}

function skeleton() {
	const box = el('div', 'skeleton');
	box.setAttribute('aria-hidden', 'true');
	for (const w of ['w40', 'w90', 'w60', 'w80', 'w50', 'w70', 'w90', 'w40', 'w60']) box.append(el('span', `sk-line ${w}`));
	return box;
}

function introPanel() {
	const box = el('div', 'panel-intro');
	const h = el('h2', 'panel-title');
	h.append(el('span', '', t('inspector.intro.title.lead')), el('br'), el('span', 'accent', t('inspector.intro.title.accent')));
	const preview = el('div', 'preview-card');
	const pHead = el('div', 'preview-head');
	pHead.append(el('span', 'code-glyph', '</>'), el('span', '', t('inspector.label')));
	preview.append(pHead, skeleton(), el('p', 'muted preview-empty', t('inspector.intro.empty')));
	box.append(panelHead(h), el('p', 'panel-lead', t('inspector.intro.body')), preview);
	return box;
}

function howPanel() {
	const box = el('div', 'panel-how');
	const ol = el('ol', 'how-list');
	for (const item of t('how.items')) ol.append(el('li', '', item));
	box.append(panelHead(el('h2', 'panel-title', t('how.title'))), ol, el('p', 'muted', t('note.privacy')));
	return box;
}

function sourcePanel(p) {
	const msg = state.messages.find((m) => m.id === p.msgId);
	const list = sourceList(msg, p.list);
	const src = list[p.idx];
	if (!src) return introPanel();
	const box = el('div', 'panel-source');
	const title = el('h2', 'panel-title panel-title-sm');
	title.append(icon('file'), document.createTextNode(` ${t('inspector.position', { i: p.idx + 1, n: list.length })}`));
	const nav = (dir, key, iconName) => {
		const b = el('button', 'icon-btn');
		b.type = 'button';
		b.setAttribute('aria-label', t(key));
		b.disabled = p.idx + dir < 0 || p.idx + dir >= list.length;
		b.dataset.focus = key;
		b.append(icon(iconName));
		b.addEventListener('click', () => {
			state.panel = { ...p, idx: p.idx + dir };
			renderPanel();
			markSelected();
			// keep focus on the same arrow; at either end move it to the other one
			const same = $('inspector').querySelector(`[data-focus="${key}"]`);
			(same && !same.disabled ? same : $('inspector').querySelector('.panel-head [data-focus]:not(:disabled)'))?.focus();
		});
		return b;
	};
	box.append(panelHead(title, [nav(-1, 'inspector.prev', 'chevronLeft'), nav(1, 'inspector.next', 'chevronRight')]));

	const dl = el('dl', 'src-meta');
	const commitDd = el('dd', 'commit-dd');
	commitDd.append(el('span', 'mono', `${src.source_id}@${shortCommit(src.commit)}`));
	const copy = el('button', 'icon-btn icon-btn-sm');
	copy.type = 'button';
	copy.setAttribute('aria-label', t('inspector.copy'));
	copy.title = t('inspector.copy');
	copy.append(icon('copy'));
	copy.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(src.commit);
			copy.title = t('inspector.copied');
			copy.setAttribute('aria-label', t('inspector.copied'));
		} catch {
			/* clipboard blocked: the commit stays visible */
		}
	});
	commitDd.append(copy);
	dl.append(el('dt', '', t('inspector.file')), el('dd', 'mono path-dd', src.path), el('dt', '', t('inspector.commit')), commitDd);
	if (src.symbol) dl.append(el('dt', '', t('inspector.symbol')), el('dd', 'mono', src.symbol));
	box.append(dl);

	const ranges = el('div', 'range-row');
	ranges.setAttribute('aria-label', t('inspector.lines'));
	ranges.setAttribute('role', 'group');
	const lastLine = src.first + src.code.split('\n').length - 1;
	if (src.mark) ranges.append(el('span', 'range-chip active', `L${src.mark.start}–${src.mark.end}`));
	ranges.append(el('span', 'range-chip', `L${src.first}–${src.last ?? lastLine}`));
	box.append(ranges);

	const note = el('p', 'snapshot-note');
	note.append(icon('info', 'icon icon-sm'), document.createTextNode(` ${t('inspector.snapshot', { id: msg.res.snapshot_id.slice(0, 12) })}${src.mark ? ` ${t('inspector.cited')}` : ''}`));
	box.append(note);
	const code = renderCode(src.code, src.language, src.first, src.mark);
	code.classList.add('inspector-code');
	box.append(code);
	return box;
}

function renderPanel() {
	const p = state.panel;
	const body = $('inspector-body');
	body.replaceChildren(p.kind === 'source' ? sourcePanel(p) : p.kind === 'how' ? howPanel() : introPanel());
	$('nav-how').setAttribute('aria-current', String(p.kind === 'how'));
	// scroll the code box (not the page) so the cited lines are in view
	const code = body.querySelector('.inspector-code');
	const hl = body.querySelector('.row.hl');
	if (code && hl) code.scrollTop = Math.max(0, hl.offsetTop - 40);
}

// ---------- requests ----------

async function call(path, body, signal) {
	let res;
	try {
		res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
	} catch (err) {
		if (signal.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
		throw Object.assign(new Error('network'), { code: 'NETWORK' });
	}
	let data = null;
	try {
		data = await res.json();
	} catch {
		if (signal.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
		data = null;
	}
	// Only the error code is kept; the server's text is never shown (it is not translated).
	if (!res.ok) throw Object.assign(new Error('request failed'), { code: data?.error?.code ?? `HTTP_${res.status}` });
	return data;
}

async function run(kind) {
	if (state.busy || !state.project) return;
	const explain = kind === 'explain' && state.ai.available;
	const question = $('question').value.trim();
	if (!question) {
		state.formError = 'error.emptyQuestion';
		renderFormError();
		$('question').focus();
		return;
	}
	state.formError = null;
	renderFormError();
	// Only earlier questions from this tab go along — earlier AI answers are never sent back.
	const previous_questions = previousQuestions();
	const user = { id: state.nextId++, role: 'user', text: question };
	const reply = { id: state.nextId++, role: 'assistant', kind: 'loading', explain };
	state.messages.push(user, reply);
	$('question').value = '';
	autoGrow();
	$('question').placeholder = t('question.followUp');
	state.busy = true;
	state.controller = new AbortController();
	updateButtons();
	renderMessages();
	$(`msg-${user.id}`)?.scrollIntoView({ block: 'start' });
	try {
		// The server is pinned to one project/snapshot; the page sends the question, the answer
		// language and up to two earlier questions — never a project id or an earlier answer.
		const res = await call(explain ? '/api/explain' : '/api/search', { question, language: state.lang, previous_questions }, state.controller.signal);
		Object.assign(reply, { kind: 'result', res, cite: res.mode === 'answer' ? citationSources(res) : { sources: [], claimSource: [] }, hitSources: hitSources(res) });
		state.searchOk = true;
	} catch (err) {
		if (err.code === 'ABORTED') reply.kind = 'stopped';
		else {
			Object.assign(reply, { kind: 'error', err: errorKeys(err.code) });
			if (err.code === 'SEARCH_UNAVAILABLE') state.searchOk = false;
		}
	} finally {
		state.busy = false;
		state.controller = null;
		renderStatus();
		updateMessage(reply);
		$(`msg-${user.id}`)?.scrollIntoView({ block: 'start' });
	}
}

function stop() {
	state.controller?.abort();
	$('question').focus();
}

function newChat() {
	state.controller?.abort();
	state.messages = [];
	state.panel = { kind: 'intro' };
	state.formError = null;
	releaseSheet();
	$('question').placeholder = t('question.placeholder');
	renderMessages();
	renderPanel();
	renderFormError();
	$('question').focus();
}

function autoGrow() {
	const q = $('question');
	q.style.height = 'auto';
	q.style.height = `${Math.min(q.scrollHeight, 200)}px`;
}

async function init() {
	for (const b of document.querySelectorAll('.lang-btn')) b.addEventListener('click', () => setLang(b.dataset.lang));
	$('ask').addEventListener('submit', (e) => {
		e.preventDefault();
		void run('explain');
	});
	$('search-btn').addEventListener('click', () => void run('search'));
	$('stop-btn').addEventListener('click', stop);
	$('new-chat').addEventListener('click', newChat);
	$('nav-ask').addEventListener('click', () => {
		if (state.panel.kind === 'how') showPanel('intro');
		$('question').focus();
	});
	$('nav-how').addEventListener('click', (e) => showPanel('how', e.currentTarget));
	$('question').addEventListener('input', autoGrow);
	$('question').addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			$('ask').requestSubmit();
		}
	});
	// widening the window turns the sheet back into the side column: drop the modal state
	window.matchMedia('(max-width: 1199px)').addEventListener('change', (e) => {
		if (!e.matches) releaseSheet();
	});
	applyStatic();
	renderPanel();
	$('page-status').replaceChildren(notice('loading', t('status.loading')));
	try {
		const res = await fetch('/api/projects');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		state.project = data.projects.length === 1 ? data.projects[0] : null;
		state.ai = data.ai;
		$('page-status').replaceChildren(...(state.project ? [] : [notice('error', t('error.request.title'), t('error.noProject'))]));
	} catch {
		$('page-status').replaceChildren(notice('error', t('error.request.title'), t('error.network')));
	}
	applyStatic();
}

void init();
