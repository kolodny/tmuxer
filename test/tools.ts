import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as tools from '../src/';

let session: string;
before(async () => (session = await tools.hideFromTools.ensureSession()));
after(() => execSync(`tmux kill-session -t ${session} 2>/dev/null || true`));

describe('createJob', () => {
  test('creates a job and returns job id, pid, and output', async () => {
    const result = await tools.createJob({
      command: 'echo "startup complete"',
    });
    assert.ok(result.jobId, 'should return a jobId');
    assert.match(result.jobId, /^job\d+$/);
    assert.ok(result.pid, 'should return a pid');
    assert.ok(result.output.includes('startup complete'));
  });

  test('accepts a custom prefix', async () => {
    const result = await tools.createJob({
      command: 'sleep 10',
      prefix: 'custom',
    });
    assert.match(result.jobId, /^custom\d+$/);
  });

  test('increments job number for same prefix', async () => {
    const first = await tools.createJob({
      command: 'sleep 10',
      prefix: 'multi',
    });
    const second = await tools.createJob({
      command: 'sleep 10',
      prefix: 'multi',
    });
    assert.match(first.jobId, /^multi\d+$/);
    assert.match(second.jobId, /^multi\d+$/);
    assert.notEqual(first.jobId, second.jobId, 'should have different job IDs');
    const num1 = parseInt(first.jobId.replace('multi', ''));
    const num2 = parseInt(second.jobId.replace('multi', ''));
    assert.equal(num2, num1 + 1, 'second job should be one higher');
  });

  test('accepts environment variables', async () => {
    const { jobId } = await tools.createJob({
      command: 'TEST_VAR=hello_env node -e "console.log(process.env.TEST_VAR)"',
      prefix: 'env',
    });

    // Wait for output
    await new Promise((r) => setTimeout(r, 200));

    const { output } = await tools.getJobOutput({ jobId });
    assert.ok(
      output.includes('hello_env'),
      'should see the environment variable in output',
    );
  });
});

describe('listJobs', () => {
  test('lists created jobs', async () => {
    const { jobId } = await tools.createJob({
      command: 'sleep 30',
      prefix: 'list',
    });

    const jobs = await tools.listJobs({});
    const found = jobs.find((j) => j.jobId === jobId);
    assert.ok(found, 'should find the created job');
  });
});

describe('listJobs (status)', () => {
  test('returns running for active job', async () => {
    const { jobId } = await tools.createJob({
      command: 'sleep 30',
      prefix: 'status',
    });

    const jobs = await tools.listJobs({});
    const job = jobs.find((j) => j.jobId === jobId);
    assert.ok(job, 'should find the job');
    assert.equal(job.running, true);
    assert.ok(job.pid, 'should have a pid');
  });

  test('returns exit code for completed job', async () => {
    const { jobId } = await tools.createJob({
      command: 'exit 0',
      prefix: 'exit',
    });

    // Wait for command to complete
    await new Promise((r) => setTimeout(r, 200));

    const jobs = await tools.listJobs({});
    const job = jobs.find((j) => j.jobId === jobId);
    assert.ok(job, 'should find the job');
    assert.equal(job.running, false);
    assert.equal(job.exitCode, 0);
  });
});

describe('getJobOutput', () => {
  test('captures output from a job', async () => {
    const { jobId } = await tools.createJob({
      command: 'echo "hello world"',
      prefix: 'output',
    });

    // Wait for output
    await new Promise((r) => setTimeout(r, 200));

    const { output } = await tools.getJobOutput({ jobId });
    assert.ok(output.includes('hello world'), 'should capture echo output');
  });

  test('supports last N lines', async () => {
    const command = 'printf "line1\\nline2\\nline3\\n"';
    const { jobId } = await tools.createJob({ command, prefix: 'lines' });

    await new Promise((r) => setTimeout(r, 200));

    const { output } = await tools.getJobOutput({ jobId, lastLines: 2 });
    const lines = output.trim().split('\n').filter(Boolean);
    assert.ok(lines.length <= 2, 'should return at most 2 lines');
  });
});

describe('sendInput', () => {
  test('handles interactive prompts', async () => {
    // Interactive bash script that prompts for name and responds
    const script = `bash -c 'read -p "Enter name: " name && echo "Hello, $name!"'`;
    const { jobId } = await tools.createJob({
      command: script,
      prefix: 'input',
    });

    // Send response to the prompt
    await tools.sendInput({ jobId, input: 'Claude{Enter}' });

    await new Promise((r) => setTimeout(r, 200));

    const { output } = await tools.getJobOutput({ jobId });
    assert.ok(output.includes('Enter name:'), 'should see the prompt');
    assert.ok(output.includes('Hello, Claude!'), 'should see the response');
  });

  test('handles arrow keys in inquirer menu', async () => {
    const script = `node -e "
      const { select } = require('@inquirer/prompts');
      const message = 'Select a fruit';
      const choices = ['Apple', 'Banana', 'Cherry'];
      select({ message, choices }).then(a => console.log('Selected: ' + a));
    "`;
    const { jobId } = await tools.createJob({
      command: script,
      prefix: 'arrow',
    });

    await new Promise((r) => setTimeout(r, 300));

    let { output, running } = await tools.getJobOutput({ jobId });
    assert.ok(output.includes('Apple'), 'should see first option');

    await tools.sendInput({ jobId, input: '{Down}{Down}' });
    ({ output, running } = await tools.getJobOutput({ jobId }));
    assert.ok(output.includes('\u276F Cherry'));

    await tools.sendInput({ jobId, input: '{Enter}' });
    ({ output, running } = await tools.getJobOutput({ jobId }));
    assert.ok(output.includes('Selected: Cherry'));
    assert.equal(running, false, 'script should have exited');
  });
});

describe('cleanupJobs', () => {
  test('removes dead jobs', async () => {
    const { jobId } = await tools.createJob({
      command: 'echo done',
      prefix: 'cleanup',
    });

    // Wait for job to complete
    await new Promise((r) => setTimeout(r, 200));

    let jobs = await tools.listJobs({});
    assert.ok(
      jobs.find((j) => j.jobId === jobId),
      'job should exist before cleanup',
    );

    const { cleaned } = await tools.cleanupJobs({ jobIds: [jobId] });
    assert.ok(cleaned.includes(jobId), 'should report job as cleaned');

    jobs = await tools.listJobs({});
    assert.ok(
      !jobs.find((j) => j.jobId === jobId),
      'job should be gone after cleanup',
    );
  });

  test('skips running jobs', async () => {
    const { jobId } = await tools.createJob({
      command: 'sleep 30',
      prefix: 'running',
    });

    const { cleaned } = await tools.cleanupJobs({ jobIds: [jobId] });
    assert.ok(!cleaned.includes(jobId), 'should not clean running job');

    const jobs = await tools.listJobs({});
    assert.ok(
      jobs.find((j) => j.jobId === jobId),
      'running job should still exist',
    );
  });
});
