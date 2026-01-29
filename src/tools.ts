import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const exec = promisify(execCb);
const tmux = (cmd: string) => exec(`tmux ${cmd}`);

const SESSION = 'tmuxer';
const WINDOW = 'main';
const getSession = `-t ${SESSION}`;
const mainWindow = `${SESSION}:${WINDOW}`;
const getMainWindow = `-t ${mainWindow}`;

const esc = (str: string) => `'${str.replace(/'/g, "'\\''")}'`;

export const ensureSession = async () => {
  let sessionExists = false;
  const noExit = `remain-on-exit on`;
  try {
    await tmux(`has-session ${getSession}`);
    sessionExists = true;
  } catch {
    // Session doesn't exist, create it with a dead "main" window
    await tmux(`new-session -d -s ${SESSION} -n ${WINDOW} -x 250 -y 80`);
    await tmux(`set-option ${getMainWindow} ${noExit}`);
    await tmux(`respawn-pane -k ${getMainWindow} 'exit 0'`);
  }

  if (sessionExists) {
    // Session exists but may have been created externally - ensure main window exists
    try {
      await tmux(`select-window ${getMainWindow}`);
    } catch {
      // Main window doesn't exist - create dead "main" window, switch user away, then kill window 0
      await tmux(`new-window -d ${getSession} -n ${WINDOW}`);
      await tmux(`set-option ${getMainWindow} ${noExit}`);
      await tmux(`respawn-pane -k ${getMainWindow} 'exit 0'`);
      await tmux(`select-window ${getMainWindow}`);
      await tmux(`kill-window ${getSession}:0`);
    }
  }

  await tmux(`set-hook ${getSession} after-new-window 'set-option ${noExit}'`);
  await tmux(`set-hook ${getSession} client-attached 'choose-tree -w'`);
  const statusRight = "Press 'Ctrl+b then d' to disconnect";
  await tmux(`set-option ${getSession} status-right ${esc(statusRight)}`);
  // Switch to choose-tree view (for already-attached clients)
  await tmux(`choose-tree ${getSession} -w`);
};

/** Create a new job that runs a command in a background tmux window */
export const createJob = async (opts: {
  command: string;
  /** Auto-generated if omitted */
  jobId?: string;
}) => {
  const { command, jobId } = opts;
  const id = jobId ?? `job-${randomUUID().slice(0, 8)}`;

  await ensureSession();

  const format = `"#{window_name}"`;
  const { stdout } = await tmux(`list-windows ${getSession} -F ${format}`);
  const existingJobs = stdout.trim().split('\n');
  if (existingJobs.includes(id)) throw new Error(`Job "${id}" already exists`);

  // `-e TMUX=` for nested tmux support
  const bash = esc(`bash -c ${esc(`echo; ${command}`)}`);
  await tmux(`new-window -d -e TMUX= -P ${getSession} -n ${esc(id)} ${bash}`);

  // Select the new job in choose-tree view
  await tmux(`select-window ${getSession}:${esc(id)}`);
  await tmux(`choose-tree ${getSession} -w`);

  return { jobId: id };
};

/** List all active jobs */
export const listJobs = async () => {
  try {
    await tmux(`has-session ${getSession}`);
  } catch {
    return []; // Session doesn't exist, no jobs
  }

  try {
    const format = `"#{window_name}\t#{window_activity}\t#{pane_current_command}\t#{history_size}\t#{cursor_y}"`;
    const { stdout } = await tmux(`list-windows ${getSession} -F ${format}`);
    const rows = stdout.trim().split('\n').filter(Boolean);
    const allWindows = rows.map((row) => {
      const [jobId, activity, currentCommand, history, posY] = row.split('\t');
      const lastActivityMs = Date.now() - +activity * 1000;
      const lines = parseInt(history, 10) + parseInt(posY, 10) + 1;
      return { jobId, lastActivityMs, currentCommand, lines };
    });
    return allWindows.filter((job) => job.jobId !== WINDOW); // Hide the persistent main window
  } catch {
    return [];
  }
};

/** Check if a job is still running */
export const getJobStatus = async (opts: { jobId: string }) => {
  const { jobId } = opts;
  try {
    const job = `${getSession}:${esc(jobId)}`;
    const format = `-F "#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}"`;
    const { stdout } = await tmux(`list-panes ${job} ${format}`);
    const [pid, dead, exitStatus] = stdout.trim().split('\t');
    const isDead = dead === '1';
    return {
      jobId,
      running: !isDead,
      pid: parseInt(pid, 10),
      ...(isDead && { exitCode: parseInt(exitStatus, 10) }),
    };
  } catch {
    return { jobId, running: false, error: 'Job not found' };
  }
};

/** Get output from a job's terminal */
export const getJobOutput = async (opts: {
  jobId: string;
  /** Only return the last N lines */
  lastLines?: number;
}) => {
  const { jobId, lastLines } = opts;
  const job = `${getSession}:${esc(jobId)}`;
  const { stdout } = await tmux(`capture-pane ${job} -p -S -`);
  if (lastLines && lastLines > 0) {
    const lines = stdout.split('\n');
    return { output: lines.slice(-lastLines).join('\n') };
  }
  return { output: stdout };
};

/** Send input to a job (use C-c for Ctrl+C) */
export const sendInput = async (opts: { jobId: string; input: string }) => {
  const { jobId, input } = opts;
  await tmux(`send-keys ${getSession}:${esc(jobId)} ${esc(input)}`);
  return { success: true };
};

/** Kill a job and destroy its tmux window */
export const killJob = async (opts: { jobId: string }) => {
  const { jobId } = opts;
  await tmux(`kill-window ${getSession}:${esc(jobId)}`);
  return { success: true };
};
