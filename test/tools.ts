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

describe('listJobs (status)', () => {
  test('returns running for active job', async () => {
    const name = `status-test-${Date.now()}`;
    await tools.createJob({ command: 'sleep 30', jobId: name });
    createdJobs.push(name);

    const jobs = await tools.listJobs();
    const job = jobs.find((j) => j.jobId === name);
    assert.ok(job, 'should find the job');
    assert.equal(job.running, true);
    assert.ok(job.pid, 'should have a pid');
  });

  test('returns exit code for completed job', async () => {
    const name = `exit-test-${Date.now()}`;
    await tools.createJob({ command: 'exit 0', jobId: name });
    createdJobs.push(name);

    // Wait for command to complete
    await new Promise((r) => setTimeout(r, 200));

    const jobs = await tools.listJobs();
    const job = jobs.find((j) => j.jobId === name);
    assert.ok(job, 'should find the job');
    assert.equal(job.running, false);
    assert.equal(job.exitCode, 0);
  });
});

describe('getJobOutput', () => {
  test('captures output from a job', async () => {
    const name = `output-test-${Date.now()}`;
    await tools.createJob({ command: 'echo "hello world"', jobId: name });
    createdJobs.push(name);

    // Wait for output
    await new Promise((r) => setTimeout(r, 200));

    const { output } = await tools.getJobOutput({ jobId: name });
    assert.ok(output.includes('hello world'), 'should capture echo output');
  });

  test('supports last N lines', async () => {
    const name = `lines-test-${Date.now()}`;
    const command = 'printf "line1\\nline2\\nline3\\n"';
    await tools.createJob({ command, jobId: name });
    createdJobs.push(name);

    await new Promise((r) => setTimeout(r, 200));

    const { output } = await tools.getJobOutput({ jobId: name, lastLines: 2 });
    const lines = output.trim().split('\n').filter(Boolean);
    assert.ok(lines.length <= 2, 'should return at most 2 lines');
  });
});

describe('sendInput', () => {
  test('handles interactive prompts', async () => {
    const name = `input-test-${Date.now()}`;
    // Interactive bash script that prompts for name and responds
    const script = `read -p "Enter name: " name && echo "Hello, $name!"`;
    await tools.createJob({ command: script, jobId: name });
    createdJobs.push(name);

    // Send response to the prompt
    await tools.sendInput({ jobId: name, input: 'Claude' });
    await tools.sendInput({ jobId: name, input: 'Enter', noEscape: true });

    await new Promise((r) => setTimeout(r, 200));

    const { output } = await tools.getJobOutput({ jobId: name });
    assert.ok(output.includes('Enter name:'), 'should see the prompt');
    assert.ok(output.includes('Hello, Claude!'), 'should see the response');
  });

  test('handles arrow keys in inquirer menu', async () => {
    const name = `arrow-test-${Date.now()}`;
    const script = `node -e "
      const { select } = require('@inquirer/prompts');
      const message = 'Select a fruit';
      const choices = ['Apple', 'Banana', 'Cherry'];
      select({ message, choices }).then(a => console.log('Selected: ' + a));
    "`;
    await tools.createJob({ command: script, jobId: name });
    createdJobs.push(name);

    await new Promise((r) => setTimeout(r, 300));

    let { output, running } = await tools.getJobOutput({ jobId: name });
    assert.ok(output.includes('Apple'), 'should see first option');

    await tools.sendInput({ jobId: name, input: 'Down Down', noEscape: true });
    ({ output, running } = await tools.getJobOutput({ jobId: name }));
    assert.ok(output.includes('\u276F Cherry'));

    await tools.sendInput({ jobId: name, input: 'Enter', noEscape: true });
    ({ output, running } = await tools.getJobOutput({ jobId: name }));
    assert.ok(output.includes('Selected: Cherry'));
    assert.equal(running, false, 'script should have exited');
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
