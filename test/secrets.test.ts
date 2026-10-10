import { describe, expect, it } from 'vitest';
import { scanText } from '../src/secrets.js';
import { CANARY } from './helpers.js';

const detectors = (text: string): string[] => scanText(text).map((f) => `${f.detector}:${f.confidence}`);

describe('secret scanner', () => {
	it('flags high-confidence credential formats', () => {
		expect(detectors(`const k = "${CANARY.awsKey}";`)).toEqual(['aws-access-key-id:high']);
		expect(detectors(`token: ${CANARY.githubToken}`)).toEqual(['github-token:high']);
		expect(detectors(`${CANARY.privateKeyHeader}\nMIIE...\n`)).toEqual(['private-key:high']);
		const url = ['mongodb+srv://', 'appuser', ':', 'R3alPassw0rd9', '@cluster0.example.net/db'].join('');
		expect(detectors(`const uri = '${url}';`)).toEqual(['credential-url:high']);
		const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
		expect(detectors(`Authorization: Bearer ${jwt}`)).toEqual(['jwt:high']);
	});

	it('flags high-entropy secret assignments as medium', () => {
		expect(detectors(`const apiKey = "${CANARY.genericValue}";`)).toEqual(['generic-secret-assignment:medium']);
		expect(detectors(`  "client_secret": "${CANARY.genericValue}"`)).toEqual(['generic-secret-assignment:medium']);
	});

	it('ignores placeholders, env lookups and ordinary code', () => {
		const clean = [
			"const password = process.env.DB_PASSWORD;",
			"const apiKey = 'your-api-key-here';",
			"const token = '${TOKEN}';",
			"memberPassword: string;",
			"const url = 'mongodb://localhost:27017/gotrip';",
			"const url = 'mongodb://user:<password>@host/db';",
			"const secret = 'your-secret-here';",
			"if (!process.env.SECRET_TOKEN) missing.push('SECRET_TOKEN');",
			"const TOKEN_NOT_EXIST = 'Token does not exist';",
			"accessToken = await this.authService.createToken(response);",
		].join('\n');
		expect(scanText(clean)).toEqual([]);
	});

	it('never includes the matched value in findings', () => {
		const text = `${CANARY.awsKey}\n${CANARY.githubToken}\nconst apiKey = "${CANARY.genericValue}";`;
		const serialized = JSON.stringify(scanText(text));
		for (const value of [CANARY.awsKey, CANARY.githubToken, CANARY.genericValue]) expect(serialized).not.toContain(value);
		expect(scanText(text).map((f) => f.count)).toEqual([1, 1, 1]);
	});
});
