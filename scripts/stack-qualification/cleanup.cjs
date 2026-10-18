#!/usr/bin/env node
'use strict';
// Independent finally-step recovery after timeout/cancellation of the qualification process.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { terminateOwnedGroup } = require('./process.cjs');
const { requireHostedLinux, assertOwner, ownedEnvironment } = require('./contracts.cjs');
requireHostedLinux();
const parent = process.env.EDGE_STACK_QUALIFICATION_ROOT;
assert.ok(parent && path.isAbsolute(parent));
if (!fs.existsSync(parent)) process.exit(0);
let failed = false;
async function cleanupAll() {
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(baseline|candidate)-/u.test(entry.name)) continue;
    const root = path.join(parent, entry.name);
    const file = path.join(root, 'lease.json');
    if (!fs.existsSync(file)) continue;
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertOwner(lease.owner);
    assert.equal(lease.root, root);
    assert.equal(lease.project, lease.owner.replaceAll('-', ''));
    const ownedEnv = ownedEnvironment(path.join(root, 'state'));
    const run = (args) =>
      execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, env: ownedEnv }).trim();
    const errors = [];
    let processCleanup;
    let lifecycleCleanup;
    try {
      processCleanup = await terminateOwnedGroup(lease);
      lifecycleCleanup = await terminateOwnedGroup({ root, servePid: lease.lifecyclePid });
    } catch (error) {
      errors.push(error.message);
    }
    for (const [kind, label] of [
      ['container', `com.supabase.cli.project=${lease.project}`],
      ['container', `edge496.owner=${lease.owner}`],
      ['volume', `com.supabase.cli.project=${lease.project}`],
      ['network', `edge496.owner=${lease.owner}`],
    ]) {
      try {
        const ids = run([
          kind,
          'ls',
          ...(kind === 'container' ? ['-a'] : []),
          '-q',
          '--filter',
          `label=${label}`,
        ])
          .split(/\s+/u)
          .filter(Boolean);
        for (const id of ids) run([kind, 'rm', ...(kind === 'container' ? ['-f'] : []), id]);
        assert.equal(
          run([
            kind,
            'ls',
            ...(kind === 'container' ? ['-a'] : []),
            '-q',
            '--filter',
            `label=${label}`,
          ]),
          '',
        );
      } catch (error) {
        errors.push(error.message);
      }
    }
    fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'evidence/external-cleanup.json'),
      JSON.stringify(
        {
          owner: lease.owner,
          complete: errors.length === 0,
          processCleanup,
          lifecycleCleanup,
          errors,
        },
        null,
        2,
      ) + '\n',
    );
    if (errors.length) failed = true;
  }
  if (failed) process.exitCode = 1;
}
cleanupAll().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
