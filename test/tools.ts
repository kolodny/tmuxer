import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as tools from '../src/tools';

const createdJobs: string[] = [];

// Cleanup all jobs created during tests
after(async () => {
  for (const jobId of createdJobs) {
    await tools.killJob({ jobId }).catch(() => {}); // Job may already be dead
  }
});

describe('createJob', () => {
  test('creates a job and returns job id', async () => {
    const result = await tools.createJob({ command: 'echo hello' });
    assert.ok(result.jobId, 'should return a jobId');
    createdJobs.push(result.jobId);
  });

  test('accepts a custom job name', async () => {
    const name = `test-job-${Date.now()}`;
    const result = await tools.createJob({ command: 'sleep 10', jobId: name });
    assert.equal(result.jobId, name);
    createdJobs.push(result.jobId);
  });
});

describe('listJobs', () => {
  test('lists created jobs', async () => {
    const name = `list-test-${Date.now()}`;
    await tools.createJob({ command: 'sleep 30', jobId: name });
    createdJobs.push(name);

    const jobs = await tools.listJobs();
    const found = jobs.find((j) => j.jobId === name);
    assert.ok(found, 'should find the created job');
  });
});

describe('getJobStatus', () => {
  test('returns running for active job', async () => {
    const name = `status-test-${Date.now()}`;
    await tools.createJob({ command: 'sleep 30', jobId: name });
    createdJobs.push(name);

    const status = await tools.getJobStatus({ jobId: name });
    assert.equal(status.running, true);
  });

  test('returns exit code for completed job', async () => {
    const name = `exit-test-${Date.now()}`;
    await tools.createJob({ command: 'exit 0', jobId: name });
    createdJobs.push(name);

    // Wait for command to complete
    await new Promise((r) => setTimeout(r, 500));

    const status = await tools.getJobStatus({ jobId: name });
    assert.equal(status.running, false);
  });
});

describe('getJobOutput', () => {
  test('captures output from a job', async () => {
    const name = `output-test-${Date.now()}`;
    await tools.createJob({ command: 'echo "hello world"', jobId: name });
    createdJobs.push(name);

    // Wait for output
    await new Promise((r) => setTimeout(r, 500));

    const { output } = await tools.getJobOutput({ jobId: name });
    assert.ok(output.includes('hello world'), 'should capture echo output');
  });

  test('supports last N lines', async () => {
    const name = `lines-test-${Date.now()}`;
    const command = 'printf "line1\\nline2\\nline3\\n"';
    await tools.createJob({ command, jobId: name });
    createdJobs.push(name);

    await new Promise((r) => setTimeout(r, 500));

    const { output } = await tools.getJobOutput({ jobId: name, lastLines: 2 });
    const lines = output.trim().split('\n').filter(Boolean);
    assert.ok(lines.length <= 2, 'should return at most 2 lines');
  });
});

describe('sendInput', () => {
  test('sends keystrokes to a job', async () => {
    const name = `input-test-${Date.now()}`;
    await tools.createJob({ command: 'cat', jobId: name }); // cat waits for input
    createdJobs.push(name);

    await new Promise((r) => setTimeout(r, 200));
    await tools.sendInput({ jobId: name, input: '\rhello' });
    await new Promise((r) => setTimeout(r, 200));

    const { output } = await tools.getJobOutput({ jobId: name });
    assert.ok(output.includes('hello'), 'should see the sent input');
  });
});

describe('killJob', () => {
  test('terminates a running job', async () => {
    const name = `kill-test-${Date.now()}`;
    await tools.createJob({ command: 'sleep 300', jobId: name });

    await tools.killJob({ jobId: name });

    const jobs = await tools.listJobs();
    const found = jobs.find((j) => j.jobId === name);
    assert.ok(!found, 'job should be gone after kill');
  });
});
