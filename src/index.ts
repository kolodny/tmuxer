import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execCb);
const tmux = (c: string) => exec(`tmux ${c}`).then(({ stdout: o }) => o.trim());
const noSession = (n: string) => tmux(`has-session -t ${n}`).catch(() => true);
const esc = (str: string) => `'${str.replace(/'/g, "'\\''")}'`;

let sid = `tmuxer-${createHash('md5').update(process.cwd()).digest('hex').slice(0, 4)}`;
let defaultKeepAlive = false;

const ensureSession = async (session = sid, keepAlive = defaultKeepAlive) => {
  sid = session;
  defaultKeepAlive = keepAlive;
  if (!(await noSession(sid))) return sid;
  await tmux(`new-session -d -s ${sid} -x 250 -y 80`);
  const afterNewWindow = 'set-option remain-on-exit on'; // Keep dead panes visible for output capture
  await tmux(`set-hook -t ${sid} after-new-window '${afterNewWindow}'`);
  return sid;
};

/** All top level exported functions are considered MCP tools */
export const hideFromTools = { ensureSession };

// prettier-ignore
const canFail = (fn: Function) => { try { return fn(); } catch {} };
const kill: number[] = [];
process.on('exit', () => kill.forEach((p) => canFail(() => process.kill(-p))));
process.on('SIGINT', () => process.exit()).on('SIGTERM', () => process.exit());

/**
 * Create a new job that runs a command in a background tmux window
 * Returns the pid and terminal output emitted during startup (waits up to 5 seconds)
 */
export const createJob = async (opts: {
  command: string;
  /** Prefix for the generated job ID (default: "job") */
  prefix?: string;
  /** Keep the job alive after the main process exits (default: false) */
  keepAlive?: boolean;
}) => {
  const { command, prefix = 'job', keepAlive = defaultKeepAlive } = opts;
  await ensureSession(sid, keepAlive);
  const jobs = (await listJobs({})).map(({ jobId }) => jobId);
  const ids = jobs.map((j) => j.startsWith(prefix) && j.slice(prefix.length));
  const maxId = ids.length ? Math.max(...ids.map(Number)) : 0;
  const id = `${prefix}${maxId + 1}`;
  const run = esc(`echo && ${command}`); // prefix with echo to offset "dead pane" message
  await tmux(`new-window -d -e TMUX='' -P -t ${sid} -n ${esc(id)} ${run}`);
  const target = `${sid}:${esc(id)}`;

  const pid = +(await tmux(`display-message -p -t ${target} "#{pane_pid}"`));
  if (isNaN(pid)) throw new Error(`Failed to get PID for job "${id}"`);
  if (!keepAlive) kill.push(pid);

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
  if (await noSession(sid)) return [];

  const format = `"#{window_index}\t#{window_name}\t#{window_activity}\t#{pane_current_command}\t#{history_size}\t#{cursor_y}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}"`;
  const output = await tmux(`list-windows -t ${sid} -F ${format}`);
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
};

/** Get output from a job's terminal, use this when polling or waiting for some output */
export const getJobOutput = async (opts: {
  jobId: string;
  /** Only return the last N lines */
  lastLines?: number;
}) => {
  const { jobId, lastLines: last } = opts;
  const job = `${sid}:${esc(jobId)}`;

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
  const exists = (await listJobs({})).some((j) => j.jobId === opts.jobId);
  if (!exists) throw new Error(`Job "${opts.jobId}" not found`);

  const paneId = `${sid}:${esc(opts.jobId)}`;

  const parts = opts.input.split(/{(\w[^}]*)}/); // [text, key, text, key, ...]
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
export const cleanupJobs = async ({ jobIds }: { jobIds: string[] }) => {
  const jobs = await listJobs({});
  const killPromises = jobIds.map(async (jobId) => {
    const job = jobs.find((j) => j.jobId === jobId);
    if (!job || job.running) return;
    await tmux(`kill-window -t ${sid}:${esc(jobId)}`).catch(() => {});
    return jobId;
  });
  const cleaned = (await Promise.all(killPromises)).filter((id) => !!id);
  return { cleaned };
};
