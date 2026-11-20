// Short Asia/Seoul time for the Monitor table. Korea has no daylight saving (fixed UTC+9), so the
// offset is applied directly. Today's results show only "01:43 KST"; older ones add the date.
const KST_OFFSET_MS = 9 * 3_600_000;

export function kstShort(iso, now = Date.now(), locale = 'en-GB') {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return '—';
	const stamp = new Date(ms + KST_OFFSET_MS).toISOString(); // yyyy-mm-ddThh:mm:ss.sssZ, shifted to Seoul
	const clock = `${stamp.slice(11, 16)} KST`;
	if (stamp.slice(0, 10) === new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10)) return clock;
	let day;
	try {
		day = new Date(ms).toLocaleDateString(locale, { timeZone: 'Asia/Seoul', day: 'numeric', month: 'short' });
	} catch {
		day = stamp.slice(5, 10);
	}
	return `${day}, ${clock}`;
}
