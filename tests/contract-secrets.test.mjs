// AC-8: no secret is committed, and the README names every value the setup needs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const keys = read('.env.example').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split('=')[0]);

describe('configuration values', () => {
  it('leaves every secret in .env.example empty', () => {
    for (const line of read('.env.example').split('\n').filter((l) => /(SECRET|KEY)=/.test(l))) expect(line).toMatch(/=$/);
  });

  it('names every .env.example value in the README', () => {
    const readme = read('README.md');
    for (const key of keys) expect(readme, key).toContain(`\`${key}\``);
  });

  it('keeps .env out of git', () => {
    expect(execFileSync('git', ['check-ignore', '.env'], { cwd: root }).toString().trim()).toBe('.env');
  });

  it('commits no key-shaped value', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter((f) => f && !f.endsWith('pnpm-lock.yaml'));
    for (const file of files) {
      let text;
      try {
        text = read(file);
      } catch {
        continue;
      }
      expect(text, file).not.toMatch(/sk-ant-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[A-Z_]*(?:SECRET|API_KEY)=[0-9a-f]{16,}/);
    }
  });
});
