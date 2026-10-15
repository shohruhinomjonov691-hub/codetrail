import { renderCode } from './highlight.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text !== undefined) n.textContent = text;
	return n;
};

const REASONS = {
	not_configured: 'Server’da OpenAI API kaliti sozlanmagan.',
	auth: 'OpenAI API kaliti rad etildi.',
	quota: 'OpenAI krediti yoki kvotasi tugagan.',
	rate_limit: 'OpenAI so‘rov limitiga yetildi.',
	timeout: 'OpenAI javobi kechikdi (timeout).',
	refused: 'Model javob berishdan bosh tortdi.',
	provider: 'OpenAI xizmatida xato yuz berdi.',
	unverified: 'AI javobi citation tekshiruvidan o‘tmadi, shuning uchun ko‘rsatilmaydi.',
	incomplete: 'AI javobi to‘liq emas (output limiti), shuning uchun ko‘rsatilmaydi.',
	client_rate_limit: 'Daqiqalik AI limiti — birozdan keyin qayta urinib ko‘ring.',
	daily_limit: 'Bugungi AI limiti tugadi.',
};

let project = null;
let busy = false;

function setStatus(kind, title, detail) {
	const box = $('status');
	box.replaceChildren();
	if (!kind) return;
	const card = el('div', `notice notice-${kind}`);
	if (kind === 'loading') card.append(el('span', 'spinner'));
	const body = el('div');
	body.append(el('strong', '', title));
	if (detail) body.append(el('p', '', detail));
	card.append(body);
	box.append(card);
}

function setBusy(on) {
	busy = on;
	for (const id of ['search-btn', 'explain-btn', 'question']) $(id).disabled = on;
}

function shortCommit(commit) {
	return commit.slice(0, 12);
}

function sourceCard(hit) {
	const card = el('article', 'card');
	card.id = `src-${hit.rank}`;
	const head = el('header', 'card-head');
	const title = el('div', 'card-title');
	title.append(el('span', 'rank', `#${hit.rank}`), el('span', 'path', hit.path), el('span', 'lines', `L${hit.start_line}–${hit.end_line}`));
	const meta = el('div', 'card-meta');
	meta.append(el('span', `role role-${hit.role}`, hit.role), el('span', 'commit', `${hit.source_id}@${shortCommit(hit.commit)}`));
	if (hit.symbol) meta.append(el('span', 'symbol', hit.symbol));
	head.append(title, meta);
	const code = renderCode(hit.code, hit.language, hit.start_line);
	const lines = hit.end_line - hit.start_line + 1;
	card.append(head, code);
	if (lines > 24) {
		code.classList.add('collapsed');
		const more = el('button', 'link', `Hammasini ko‘rsatish (${lines} qator)`);
		more.type = 'button';
		more.addEventListener('click', () => {
			const collapsed = code.classList.toggle('collapsed');
			more.textContent = collapsed ? `Hammasini ko‘rsatish (${lines} qator)` : 'Qisqartirish';
		});
		card.append(more);
	}
	return card;
}

function renderSources(hits) {
	const list = $('source-list');
	list.replaceChildren(...hits.map(sourceCard));
	$('sources').hidden = hits.length === 0;
}

function renderAnswer(res) {
	const box = $('answer');
	box.replaceChildren();
	box.hidden = true;
	if (res.mode === 'answer') {
		box.hidden = false;
		const head = el('div', 'answer-head');
		head.append(el('h2', 'section-title', 'AI tushuntirish'));
		head.append(el('span', 'answer-meta', `${res.model ?? ''}${res.cached ? ' · keshdan' : ''}`));
		box.append(head);
		box.append(el('p', 'caveat', 'Har bir da’vo ostida server snapshot’dan olingan aniq kod ko‘rsatilgan. Citation borligi da’voning to‘g‘riligini kafolatlamaydi — kodni o‘zingiz tekshiring.'));
		const list = el('ol', 'claims');
		for (const c of res.claims) {
			const item = el('li', 'claim');
			item.append(el('p', 'claim-text', c.text));
			const cite = el('div', 'cite');
			cite.append(el('span', 'cite-label', c.citation.label));
			item.append(cite, renderCode(c.citation.code, c.citation.language, c.citation.start_line));
			list.append(item);
		}
		box.append(list);
		setStatus(null);
	} else if (res.mode === 'insufficient') {
		setStatus('info', res.message, 'Quyida loyihadan topilgan eng yaqin kod manbalari ko‘rsatilgan.');
	} else if (res.mode === 'fallback') {
		setStatus('warn', res.message, REASONS[res.reason] ?? 'AI tushuntirish hozir mavjud emas.');
	}
}

async function call(path, body) {
	const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	let data = null;
	try {
		data = await res.json();
	} catch {
		data = null;
	}
	if (!res.ok) {
		const err = new Error(data?.error?.message ?? `HTTP ${res.status}`);
		err.code = data?.error?.code ?? `HTTP_${res.status}`;
		throw err;
	}
	return data;
}

async function run(kind) {
	if (busy) return;
	const question = $('question').value.trim();
	if (!project) return setStatus('error', 'Loyiha hozir mavjud emas.');
	if (!question) return setStatus('error', 'Savol bo‘sh.', 'Savol yozing va qayta urinib ko‘ring.');
	setBusy(true);
	$('answer').hidden = true;
	setStatus('loading', kind === 'explain' ? 'Kod manbalari qidirilmoqda va AI tushuntirish tayyorlanmoqda…' : 'Kod manbalari qidirilmoqda…');
	try {
		// The server is pinned to one project and snapshot; the page does not choose.
		const res = await call(kind === 'explain' ? '/api/explain' : '/api/search', { question });
		renderSources(res.hits);
		if (kind === 'explain') renderAnswer(res);
		else if (res.hits.length === 0) setStatus('info', 'Natija topilmadi.', 'Boshqa so‘zlar bilan qayta urinib ko‘ring.');
		else setStatus(null);
	} catch (err) {
		renderSources([]);
		if (err.code === 'SEARCH_UNAVAILABLE') setStatus('error', 'Lokal qidiruv hozir ishlamayapti.', 'Embedding server yoki indeks mavjud emas. Bu AI xatosi emas — administrator serverni tekshirishi kerak.');
		else setStatus('error', 'So‘rov bajarilmadi.', err.message);
	} finally {
		setBusy(false);
	}
}

function showProject() {
	$('project-name').textContent = project ? project.name : '—';
	$('project-meta').textContent = project ? `Snapshot ${project.snapshot_id.slice(0, 8)} · ${project.sources.map((s) => `${s.source_id}@${shortCommit(s.commit)}`).join(', ')} · ${project.chunks} chunk` : '';
}

async function init() {
	$('ask').addEventListener('submit', (e) => {
		e.preventDefault();
		void run('search');
	});
	$('explain-btn').addEventListener('click', () => void run('explain'));
	setStatus('loading', 'Loyihalar yuklanmoqda…');
	try {
		const res = await fetch('/api/projects');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		project = data.projects.length === 1 ? data.projects[0] : null;
		const badge = $('ai-badge');
		badge.hidden = false;
		badge.textContent = data.ai.available ? `AI: ${data.ai.model}` : 'AI: o‘chirilgan';
		badge.classList.toggle('off', !data.ai.available);
		showProject();
		if (!project) {
			setStatus('warn', 'Loyiha hozir mavjud emas.', 'Server sozlamasini administrator tekshirishi kerak.');
			setBusy(true);
		} else setStatus('empty', 'Savol bering', `${project.name} kodi bo‘yicha savol yozing. “Qidirish” faqat lokal manbalarni qaytaradi.`);
	} catch {
		setStatus('error', 'Server bilan bog‘lanib bo‘lmadi.', 'Sahifani yangilab ko‘ring.');
		setBusy(true);
	}
}

void init();
