'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
function groupMembers(groupId) {
  const rows = [];
  try {
    const leader = fs.readFileSync(`/proc/${groupId}/stat`, 'utf8');
    const fields = leader.slice(leader.lastIndexOf(')') + 2).split(' ');
    assert.equal(
      Number(fields[2]),
      groupId,
      'Owned supervisor is not isolated in its recorded process group',
    );
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  }
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const text = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) !== groupId || fields[0] === 'Z') continue;
      rows.push({ pid: Number(entry), cwd: fs.realpathSync(`/proc/${entry}/cwd`) });
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  return rows;
}
async function terminateOwnedGroup(lease, options = {}) {
  if (!lease.servePid) return { complete: true, members: [], signals: [] };
  assert.ok(Number.isSafeInteger(lease.servePid) && lease.servePid > 1);
  const members = options.members ?? (() => groupMembers(lease.servePid));
  const signal = options.signal ?? ((name) => process.kill(-lease.servePid, name));
  const pause = options.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 100)));
  const attempts = options.attempts ?? 50;
  const signals = [];
  const inspect = () => {
    const rows = members();
    for (const row of rows)
      assert.equal(
        row.cwd,
        path.join(lease.root, 'fixture'),
        'Process group identity differs from the owned fixture; refusing signal and clean certification',
      );
    return rows;
  };
  for (const name of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
    if (inspect().length === 0) return { complete: true, members: [], signals };
    try {
      signal(name);
      signals.push(name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    for (let i = 0; i < attempts; i++) {
      await pause();
      if (inspect().length === 0) return { complete: true, members: [], signals };
    }
  }
  assert.equal(
    inspect().length,
    0,
    'Owned supervisor/process group remains alive after bounded escalation',
  );
  return { complete: true, members: [], signals };
}
module.exports = { groupMembers, terminateOwnedGroup };
