'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const monitoring = read('.github/dependabot.yml');

function listBelow(source, key, indent) {
  const prefix = ' '.repeat(indent);
  const match = source.match(new RegExp(`^${prefix}${key}:\\n((?:${prefix}  - .+\\n)+)`, 'mu'));
  assert.ok(match, `missing ${key} list`);
  return match[1]
    .trim()
    .split('\n')
    .map((line) =>
      line
        .trim()
        .slice(2)
        .replace(/^['"]|['"]$/gu, ''),
    );
}

function assertReadOnlyCandidate(source) {
  assert.match(source, /^  contents: read$/mu);
  assert.doesNotMatch(source, /pull_request_target|workflow_run|secrets\.|\bwrite(?:-all)?\b/u);
  assert.doesNotMatch(source, /(?:deploy:|\bdeploy\b|\bpublish\b|supabase (?:link|db push))/u);
  assert.match(source, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u);
  assert.match(source, /persist-credentials: false/u);
  assert.match(
    source,
    /group: edge-dependency-ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/u,
  );
  assert.match(source, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u);
  assert.match(source, /run: pnpm install --frozen-lockfile/u);
  assert.match(source, /run: pnpm lint/u);
  assert.match(source, /run: pnpm check/u);
}

function matchesPr(source, branch, paths) {
  if (!listBelow(source, 'branches', 4).includes(branch)) return false;
  const patterns = listBelow(source, 'paths', 4);
  return paths.some((changed) =>
    patterns.some((pattern) =>
      new RegExp(
        '^' +
          pattern
            .split('**')
            .map((part) =>
              part
                .split('*')
                .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
                .join('[^/]*'),
            )
            .join('.*') +
          '$',
        'u',
      ).test(changed),
    ),
  );
}

test('dependency PRs use the canonical secretless exact-head gate', () => {
  assertReadOnlyCandidate(workflow);
  assert.match(workflow, /^  workflow_dispatch:$/mu);
  assert.doesNotMatch(workflow, /^  push:$/mu);
  assert.deepEqual(
    [...workflow.split(/^jobs:\n/mu)[1].matchAll(/^  ([\w-]+):$/gmu)].map((match) => match[1]),
    ['validate'],
  );
});

test('every selected stack input triggers the same canonical job and removal loses that coverage', () => {
  const selected = [
    ['scripts/qualify-local-stack.cjs', 'scripts/qualify-local-stack.cjs'],
    ['scripts/stack-qualification/**', 'scripts/stack-qualification/startup.cjs'],
    ['scripts/stack-*.test.cjs', 'scripts/stack-startup.test.cjs'],
    ['test/fixtures/stack-qualification/**', 'test/fixtures/stack-qualification/portal.ts'],
    [
      'test/fixtures/supabase-cli-*-functions-transport.json',
      'test/fixtures/supabase-cli-v2.121.0-functions-transport.json',
    ],
    [
      'test/fixtures/supabase-edge-runtime-*-deno.json',
      'test/fixtures/supabase-edge-runtime-v1.77.4-deno.json',
    ],
    ['supabase/functions/_shared/portal_hmac.ts', 'supabase/functions/_shared/portal_hmac.ts'],
    [
      'supabase/functions/_shared/portal_public_transport.ts',
      'supabase/functions/_shared/portal_public_transport.ts',
    ],
  ];
  for (const branch of ['dev', 'main'])
    for (const [pattern, input] of selected) {
      assert.ok(workflow.includes(`      - ${pattern}\n`));
      assert.equal(matchesPr(workflow, branch, [input]), true, input);
      assert.equal(
        matchesPr(workflow.replace(`      - ${pattern}\n`, ''), branch, [input]),
        false,
        `missing ${pattern}`,
      );
    }
  const inputs = [
    ...fs
      .readdirSync(path.join(root, 'scripts'))
      .filter((name) => /^stack-.*\.test\.cjs$/u.test(name))
      .map((name) => 'scripts/' + name),
    ...fs
      .readdirSync(path.join(root, 'scripts/stack-qualification'))
      .map((name) => 'scripts/stack-qualification/' + name),
    ...fs
      .readdirSync(path.join(root, 'test/fixtures/stack-qualification'))
      .map((name) => 'test/fixtures/stack-qualification/' + name),
    ...fs
      .readdirSync(path.join(root, 'test/fixtures'))
      .filter((name) =>
        /^supabase-(?:cli-.*-functions-transport|edge-runtime-.*-deno)\.json$/u.test(name),
      )
      .map((name) => 'test/fixtures/' + name),
  ];
  for (const input of inputs)
    for (const branch of ['dev', 'main'])
      assert.equal(matchesPr(workflow, branch, [input]), true, input);
});

test('privilege, credential and candidate substitutions are rejected', () => {
  for (const [before, after] of [
    ['contents: read', 'contents: write'],
    ['persist-credentials: false', 'persist-credentials: true'],
    [
      'github.event.pull_request.head.sha || github.sha',
      'github.event.pull_request.merge_commit_sha',
    ],
    ['  pull_request:', '  pull_request_target:'],
    ['run: pnpm check', 'run: pnpm deploy:main all'],
    ['run: pnpm check', 'run: echo ${{ secrets.SUPABASE_ACCESS_TOKEN }}'],
  ]) {
    assert.ok(workflow.includes(before), `fixture did not replace ${before}`);
    assert.throws(() => assertReadOnlyCandidate(workflow.replace(before, after)));
  }
});

test('all declared dependency graphs and Actions proposals trigger on dev and main', () => {
  for (const branch of ['dev', 'main']) {
    for (const changed of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'deno.json',
      'supabase/functions/deno.json',
      '.nvmrc',
      '.tool-versions',
      '.github/dependabot.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/ai-doc-lint.yml',
      'scripts/dependency-ci-contract.test.cjs',
    ]) {
      assert.equal(matchesPr(workflow, branch, [changed]), true, `${branch}: ${changed}`);
    }
  }
});

test('unrelated runtime, test and documentation changes add no automatic gate', () => {
  for (const changed of [
    'supabase/functions/app_dataset_create/index.ts',
    'supabase/config.toml',
    'scripts/deploy-function.cjs',
    'test/auth_test.ts',
    'README.md',
    'docs/agents/repo-validation.md',
    'scripts/deeper/stack-startup.test.cjs',
    'scripts/stack-startup.test.cjs.bak',
    'scripts/stack-qualification-other/startup.cjs',
    'test/fixtures/other.json',
    'test/fixtures/supabase-cli-v2.121.0-functions-transport.json.bak',
    'supabase/functions/_shared/portal_other.ts',
  ]) {
    assert.equal(matchesPr(workflow, 'dev', [changed]), false, changed);
  }
  assert.equal(matchesPr(workflow, 'feature/other', ['package.json']), false);
  assert.equal(matchesPr(workflow, 'dev', ['README.md', 'pnpm-lock.yaml']), true);
});

test('monitoring selects each real graph once without following the root extends twice', () => {
  const entries = monitoring.split(/^  - package-ecosystem: /mu).slice(1);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.split('\n')[0]),
    ['npm', 'deno', 'github-actions'],
  );
  const denoEntry = entries.find((entry) => entry.startsWith('deno\n'));
  assert.match(denoEntry, /^    directory: \/supabase\/functions$/mu);
  const inherited = JSON.parse(read('deno.json'));
  assert.equal(inherited.extends, './supabase/functions/deno.json');
  assert.equal(inherited.imports, undefined);
  assert.ok(Object.keys(JSON.parse(read('supabase/functions/deno.json')).imports).length > 0);
  assert.match(entries[0], /dependency-type: development/u);
});

test('version traffic is bounded and majors remain visible without enabling merge', () => {
  const entries = monitoring.split(/^  - package-ecosystem: /mu).slice(1);
  assert.equal(new Set(entries.map((entry) => entry.match(/time: ['"]([^'"]+)/u)[1])).size, 3);
  for (const entry of entries) {
    assert.match(entry, /^    target-branch: dev$/mu);
    assert.match(entry, /interval: weekly/u);
    assert.match(entry, /default-days: 7/u);
    assert.match(entry, /open-pull-requests-limit: [12]/u);
    assert.match(entry, /applies-to: version-updates/u);
    assert.deepEqual(listBelow(entry, 'update-types', 8), ['minor', 'patch']);
  }
  assert.doesNotMatch(
    monitoring,
    /gitsubmodule|auto.?merge|insecure-external-code-execution|ignore:/iu,
  );
  for (const excluded of listBelow(monitoring, 'exclude-paths', 4)) {
    assert.equal(excluded.startsWith('/'), false);
    assert.equal(excluded.includes('..'), false);
  }
});

test('retained parser gaps have explicit owner disposition instead of silent coverage claims', () => {
  const imports = JSON.parse(read('supabase/functions/deno.json')).imports;
  const guidance = read('docs/agents/repo-validation.md');
  for (const specifier of [
    'npm:/zod@4.6.7',
    'https://esm.sh/@upstash/redis@1.38.3',
    'https://deno.land/x/postgresjs@v3.4.8/mod.js',
  ]) {
    assert.ok(Object.values(imports).includes(specifier));
    assert.ok(guidance.includes(specifier), `${specifier} needs a monitoring disposition`);
  }
  assert.match(guidance, /does not match/u);
  assert.match(guidance, /three pins remain under explicit/u);
});
