import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execCb);
const tmux = (c: string) => exec(`tmux ${c}`).then(({ stdout: o }) => o.trim());
const noSession = (n: string) => tmux(`has-session -t ${n}`).catch(() => true);
const esc = (str: string) => `'${str.replace(/'/g, "'\\''")}'`;

const hash = createHash('md5').update(process.cwd()).digest('hex').slice(0, 4);
const session = `tmuxer-${hash}`;
const nextId: Record<string, number> = {};

const ensureSession = async () => {
  if (!(await noSession(session))) return session;
  await tmux(`new-session -d -s ${session} -x 250 -y 80`);
  const afterNewWindow = 'set-option remain-on-exit on'; // Keep dead panes visible for output capture
  await tmux(`set-hook -t ${session} after-new-window '${afterNewWindow}'`);
  return session;
};

/** All top level exported functions are considered MCP tools */
export const hideFromTools = { ensureSession };

/**
 * Create a new job that runs a command in a background tmux window
 * Returns the pid and terminal output emitted during startup (waits up to 5 seconds)
 */
export const createJob = async (opts: {
  command: string;
  /** Prefix for the generated job ID (default: "job") */
  prefix?: string;
  /** Optional environment variables to set for the command */
  env?: Record<string, string>;
}) => {
  const { command, prefix = 'job', env: e = { TMUX: '', ...opts.env } } = opts;
  await ensureSession();
  nextId[prefix] ??= 1;
  const id = `${prefix}${nextId[prefix]++}`;
  const run = esc(`echo && ${command}`); // prefix with echo to offset "dead pane" message
  const env = Object.entries(e).map(([k, v]) => `-e ${k}=${esc(v)}`);
  const joined = env.join(' ');
  await tmux(`new-window -d ${joined} -P -t ${session} -n ${esc(id)} ${run}`);
  const target = `${session}:${esc(id)}`;

  const pid = +(await tmux(`display-message -p -t ${target} "#{pane_pid}"`));
  let output = await tmux(`capture-pane -t ${target} -p`);
  let attempts = 0;
  while (!output.trim() && attempts++ < 50) {
    await new Promise((r) => setTimeout(r, 100));
    output = await tmux(`capture-pane -t ${target} -p`);
  }

  return { jobId: id, pid, output };
};

/** List all active jobs */
export const listJobs = async ({}: {}) => {
  if (await noSession(session)) return [];

  try {
    const format = `"#{window_index}\t#{window_name}\t#{window_activity}\t#{pane_current_command}\t#{history_size}\t#{cursor_y}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}"`;
    const output = await tmux(`list-windows -t ${session} -F ${format}`);
    const rows = output.split('\n').filter(Boolean);
    const jobs = rows.map((row) => {
      // prettier-ignore
      const [index, jobId, activity, currentCommand, history, posY, pidRaw, dead, exitStatus] = row.split('\t');
      if (index === '0') return null; // Skip initial window
      const lastActivityMs = Date.now() - +activity * 1000;
      const lines = parseInt(history, 10) + parseInt(posY, 10) + 1;
      const pid = parseInt(pidRaw, 10);
      const running = dead !== '1';
      const base = { jobId, pid, running, currentCommand, lines };
      const exitInfo = !running ? { exitCode: parseInt(exitStatus, 10) } : {};
      return { ...base, lastActivityMs, ...exitInfo };
    });
    return jobs.filter((job) => !!job);
  } catch {
    return [];
  }
};

/** Get output from a job's terminal, use this when polling or waiting for some output */
export const getJobOutput = async (opts: {
  jobId: string;
  /** Only return the last N lines */
  lastLines?: number;
}) => {
  const { jobId, lastLines: last } = opts;
  const job = `${session}:${esc(jobId)}`;

  const jobInfo = (await listJobs({})).find((j) => j.jobId === jobId);
  if (!jobInfo) throw new Error(`Job "${jobId}" not found`);
  let output = await tmux(`capture-pane -t ${job} -p -S -`);
  if (last && last > 0) output = output.split('\n').slice(-last).join('\n');

  return { output, ...jobInfo };
};

/**
 * Send input to a job (use {C-c} for Ctrl+C).
 * Returns the terminal output after sending the input (after 1 second).
 */
export const sendInput = async (opts: {
  jobId: string;
  /**
   * Input to send to the job. Use {key} syntax for special keys.
   * Examples:
   *   "Hello world{Enter}" - types text then presses Enter
   *   "{Up}{Up}{Enter}" - presses Up, Up, Enter
   *   "{C-c}" - sends Ctrl+C
   */
  input: string;
}) => {
  const { jobId, input } = opts;
  const exists = (await listJobs({})).some((j) => j.jobId === jobId);
  if (!exists) throw new Error(`Job "${jobId}" not found`);

  const paneId = `${session}:${esc(jobId)}`;

  // Parse and send input: split gives [text, key, text, key, ...]
  const parts = input.split(/{(\w[^}]*)}/);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const value = i % 2 ? parts[i] : `-l ${esc(parts[i])}`;
    await tmux(`send-keys -t ${paneId} ${value}`);
  }

  await new Promise((r) => setTimeout(r, 1000));
  const output = await tmux(`capture-pane -t ${paneId} -p`);
  return { output };
};

/** Clean up dead job windows */
export const cleanupJobs = async (opts: { jobIds: string[] }) => {
  const { jobIds } = opts;
  const jobs = await listJobs({});
  const cleaned: string[] = [];

  for (const jobId of jobIds) {
    const job = jobs.find((j) => j.jobId === jobId);
    if (!job) continue;
    if (job.running) continue; // Don't kill running jobs
    await tmux(`kill-window -t ${session}:${esc(jobId)}`).catch(() => {});
    cleaned.push(jobId);
  }

  return { cleaned };
};
