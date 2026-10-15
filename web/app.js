import { renderCode } from './highlight.js';
import { DEFAULT_LANG, DICT, LANGS } from './i18n.js';

const LANG_KEY = 'codetrail.lang';
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text !== undefined) n.textContent = text;
	return n;
};

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
	busy: false,
	/** What the results area shows; re-rendered on language change. */
	view: { kind: 'idle' },
};

function t(key, vars = {}) {
	const value = DICT[state.lang][key] ?? DICT.en[key] ?? key;
	return typeof value === 'string' ? value.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : value;
}

function shortCommit(commit) {
	return commit.slice(0, 12);
}

// ---------- static text, language switch ----------

function applyStatic() {
	document.documentElement.lang = state.lang;
	for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
	for (const n of document.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
	for (const n of document.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
	for (const b of document.querySelectorAll('.lang-btn')) b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
	renderChips();
	renderAi();
	renderDetails();
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
	renderView();
}

function renderChips() {
	const box = $('chips');
	box.replaceChildren(
		...t('examples.items').map((q) => {
			const chip = el('button', 'chip', q);
			chip.type = 'button';
			chip.setAttribute('role', 'listitem');
			// Fills the question only — never searches or calls the AI by itself.
			chip.addEventListener('click', () => {
				$('question').value = q;
				$('question').focus();
			});
			return chip;
		}),
	);
}

function renderAi() {
	const pill = $('ai-pill');
	pill.hidden = false;
	pill.textContent = state.ai.available ? t('ai.on', { model: state.ai.model }) : t('ai.off');
	pill.classList.toggle('off', !state.ai.available);
	$('ai-off-note').hidden = state.ai.available || !state.project;
	updateButtons();
}

function updateButtons() {
	const ready = Boolean(state.project) && !state.busy;
	$('search-btn').disabled = !ready;
	$('explain-btn').disabled = !ready || !state.ai.available;
	$('question').disabled = state.busy || !state.project;
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

// ---------- results ----------

function notice(kind, title, body) {
	const card = el('div', `notice notice-${kind}`);
	card.setAttribute('role', kind === 'error' ? 'alert' : 'status');
	if (kind === 'loading') card.append(el('span', 'spinner'));
	const text = el('div');
	text.append(el('strong', '', title));
	if (body) text.append(el('p', '', body));
	card.append(text);
	return card;
}

function sourceCard(hit) {
	const card = el('article', 'card');
	const head = el('header', 'card-head');
	const title = el('div', 'card-title');
	title.append(el('span', 'rank', `#${hit.rank}`), el('span', 'path', hit.path), el('span', 'lines', `L${hit.start_line}–${hit.end_line}`));
	const meta = el('div', 'card-meta');
	meta.append(el('span', `role role-${hit.role}`, t(`role.${hit.role}`)), el('span', 'mono', `${hit.source_id}@${shortCommit(hit.commit)}`));
	if (hit.symbol) meta.append(el('span', 'mono symbol', hit.symbol));
	head.append(title, meta);
	const code = renderCode(hit.code, hit.language, hit.start_line);
	card.append(head, code);
	const lines = hit.end_line - hit.start_line + 1;
	if (lines > 24) {
		code.classList.add('collapsed');
		const more = el('button', 'link-btn', t('card.showAll', { n: lines }));
		more.type = 'button';
		more.setAttribute('aria-expanded', 'false');
		more.addEventListener('click', () => {
			const collapsed = code.classList.toggle('collapsed');
			more.textContent = collapsed ? t('card.showAll', { n: lines }) : t('card.collapse');
			more.setAttribute('aria-expanded', String(!collapsed));
		});
		card.append(more);
	}
	return card;
}

function renderAnswer(res) {
	const box = $('answer');
	box.replaceChildren();
	box.hidden = res?.mode !== 'answer';
	if (box.hidden) return;
	const head = el('div', 'section-head');
	head.append(el('h2', '', t('answer.title')), el('span', 'muted mono', `${res.model ?? ''}${res.cached ? ` · ${t('answer.cached')}` : ''}`));
	box.append(head, el('p', 'caveat', t('answer.caveat')));
	const list = el('ol', 'claims');
	for (const c of res.claims) {
		const item = el('li', 'claim');
		item.append(el('p', 'claim-text', c.text), el('p', 'cite mono', c.citation.label), renderCode(c.citation.code, c.citation.language, c.citation.start_line));
		list.append(item);
	}
	box.append(list);
}

function renderView() {
	const v = state.view;
	const status = $('status');
	status.replaceChildren();
	document.body.classList.toggle('has-results', v.kind !== 'idle');
	const res = v.res;
	if (v.kind === 'loading') status.append(notice('loading', t(v.explain ? 'status.explaining' : 'status.searching')));
	else if (v.kind === 'error') status.append(notice('error', t(v.titleKey), v.bodyKey ? t(v.bodyKey) : v.body));
	else if (v.kind === 'result') {
		if (res.hits.length === 0 && res.mode !== 'insufficient') status.append(notice('info', t('status.empty.title'), t('status.empty.body')));
		else if (res.mode === 'insufficient') status.append(notice('info', t('status.insufficient.title'), t('status.insufficient.body')));
		else if (res.mode === 'fallback') status.append(notice('warn', t('status.fallback.title'), t(`reason.${res.reason}`) === `reason.${res.reason}` ? t('reason.unknown') : t(`reason.${res.reason}`)));
	}
	renderAnswer(v.kind === 'result' ? res : null);
	const hits = v.kind === 'result' ? res.hits : [];
	$('source-list').replaceChildren(...hits.map(sourceCard));
	$('sources-count').textContent = hits.length ? t('sources.count', { n: hits.length }) : '';
	$('sources').hidden = hits.length === 0;
}

// ---------- requests ----------

async function call(path, body) {
	let res;
	try {
		res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	} catch {
		throw Object.assign(new Error('network'), { code: 'NETWORK' });
	}
	let data = null;
	try {
		data = await res.json();
	} catch {
		data = null;
	}
	if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { code: data?.error?.code ?? `HTTP_${res.status}` });
	return data;
}

async function run(kind) {
	if (state.busy || !state.project) return;
	if (kind === 'explain' && !state.ai.available) return;
	const question = $('question').value.trim();
	if (!question) {
		state.view = { kind: 'error', titleKey: 'error.emptyQuestion' };
		renderView();
		$('question').focus();
		return;
	}
	state.busy = true;
	updateButtons();
	state.view = { kind: 'loading', explain: kind === 'explain' };
	renderView();
	try {
		// The server is pinned to one project/snapshot; the page sends only the question and the answer language.
		const res = await call(kind === 'explain' ? '/api/explain' : '/api/search', { question, language: state.lang });
		state.view = { kind: 'result', res };
	} catch (err) {
		state.view =
			err.code === 'SEARCH_UNAVAILABLE'
				? { kind: 'error', titleKey: 'error.search.title', bodyKey: 'error.search.body' }
				: err.code === 'NETWORK'
					? { kind: 'error', titleKey: 'error.request.title', bodyKey: 'error.network' }
					: { kind: 'error', titleKey: 'error.request.title', body: err.message };
	} finally {
		state.busy = false;
		updateButtons();
		renderView();
	}
}

async function init() {
	for (const b of document.querySelectorAll('.lang-btn')) b.addEventListener('click', () => setLang(b.dataset.lang));
	$('ask').addEventListener('submit', (e) => {
		e.preventDefault();
		void run('search');
	});
	$('explain-btn').addEventListener('click', () => void run('explain'));
	$('question').addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void run('search');
		}
	});
	applyStatic();
	state.view = { kind: 'loading-project' };
	$('status').replaceChildren(notice('loading', t('status.loading')));
	try {
		const res = await fetch('/api/projects');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		state.project = data.projects.length === 1 ? data.projects[0] : null;
		state.ai = data.ai;
		if (state.project) $('project-name').textContent = state.project.name;
		state.view = state.project ? { kind: 'idle' } : { kind: 'error', titleKey: 'error.request.title', bodyKey: 'error.noProject' };
	} catch {
		state.view = { kind: 'error', titleKey: 'error.request.title', bodyKey: 'error.network' };
	}
	applyStatic();
	renderView();
}

void init();
