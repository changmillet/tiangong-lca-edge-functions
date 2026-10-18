'use strict';
const assert = require('node:assert/strict');
const { assertOwner } = require('./contracts.cjs');
function collectFailureDiagnostics({ owner, project, execute, sanitize, write }) {
  assertOwner(owner);
  assert.equal(project, owner.replaceAll('-', ''));
  const summary = [];
  const bounded = (value) => sanitize(String(value ?? '')).slice(0, 65536);
  for (const [role, name, label, value] of [
    ['native-runtime', `supabase_edge_runtime_${project}`, 'com.supabase.cli.project', project],
    ['native-kong', `supabase_kong_${project}`, 'com.supabase.cli.project', project],
    ['pair-runtime', `${owner}-runtime`, 'edge496.owner', owner],
    ['pair-kong', `${owner}-kong`, 'edge496.owner', owner],
  ]) {
    let inspectedId;
    try {
      const result = execute(['container', 'inspect', name]);
      if (result.status !== 0) {
        summary.push({
          role,
          inspectionSucceeded: false,
          present: null,
          exit: result.status,
          errorCode: result.error?.code,
          error: bounded(result.stderr),
        });
        continue;
      }
      const info = JSON.parse(result.stdout)[0];
      assert.equal(info.Name, '/' + name);
      assert.match(info.Id, /^[a-f0-9]{64}$/u);
      assert.equal(info.Config.Labels[label], value);
      inspectedId = info.Id;
      write(`failure-${role}-state.json`, {
        id: info.Id,
        name: info.Name,
        image: info.Image,
        state: {
          Status: info.State.Status,
          Running: info.State.Running,
          OOMKilled: info.State.OOMKilled,
          ExitCode: info.State.ExitCode,
          Error: bounded(info.State.Error),
          StartedAt: info.State.StartedAt,
          FinishedAt: info.State.FinishedAt,
          Health:
            info.State.Health === undefined
              ? undefined
              : {
                  Status: info.State.Health.Status,
                  FailingStreak: info.State.Health.FailingStreak,
                  Log: info.State.Health.Log.slice(-5).map((entry) => ({
                    Start: entry.Start,
                    End: entry.End,
                    ExitCode: entry.ExitCode,
                    Output: bounded(entry.Output).slice(0, 4096),
                  })),
                },
        },
        networks: info.NetworkSettings.Networks,
        requestedPortBindings: info.HostConfig.PortBindings,
        actualPortBindings: info.NetworkSettings.Ports,
      });
      const logs = execute(['logs', '--tail', '100', info.Id]);
      write(`failure-${role}-logs.json`, {
        exit: logs.status,
        error: logs.error?.code,
        stdout: bounded(logs.stdout),
        stderr: bounded(logs.stderr),
      });
      summary.push({
        role,
        inspectionSucceeded: true,
        present: true,
        id: info.Id,
        logsExit: logs.status,
      });
    } catch (error) {
      summary.push({
        role,
        inspectionSucceeded: inspectedId !== undefined,
        present: inspectedId === undefined ? null : true,
        id: inspectedId,
        error: bounded(error.message),
      });
    }
  }
  write('failure-diagnostics.json', summary);
  return summary;
}
module.exports = { collectFailureDiagnostics };
