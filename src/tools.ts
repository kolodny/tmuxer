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

  // Select the new job and show in choose-tree selector
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
    const format = `"#{window_name}\t#{window_activity}\t#{pane_current_command}\t#{history_size}\t#{cursor_y}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}"`;
    const { stdout } = await tmux(`list-windows ${getSession} -F ${format}`);
    const rows = stdout.trim().split('\n').filter(Boolean);
    const allWindows = rows.map((row) => {
      // prettier-ignore
      const [jobId, activity, currentCommand, history, posY, pidRaw, dead, exitStatus] = row.split('\t');
      const lastActivityMs = Date.now() - +activity * 1000;
      const lines = parseInt(history, 10) + parseInt(posY, 10) + 1;
      const pid = parseInt(pidRaw, 10);
      const running = dead !== '1';
      const base = { jobId, pid, running, currentCommand, lines };
      const exitInfo = !running ? { exitCode: parseInt(exitStatus, 10) } : {};
      return { ...base, lastActivityMs, ...exitInfo };
    });
    return allWindows.filter((job) => job.jobId !== WINDOW); // Hide the persistent main window
  } catch {
    return [];
  }
};

/** Get output from a job's terminal */
export const getJobOutput = async (opts: {
  jobId: string;
  /** Only return the last N lines */
  lastLines?: number;
}) => {
  const { jobId, lastLines: last } = opts;
  const job = `${getSession}:${esc(jobId)}`;

  const jobInfo = (await listJobs()).find((j) => j.jobId === jobId);
  if (!jobInfo) throw new Error(`Job "${jobId}" not found`);
  const { stdout } = await tmux(`capture-pane ${job} -p -S -`);
  let output = stdout;
  if (last && last > 0) output = stdout.split('\n').slice(-last).join('\n');

  return { output, ...jobInfo };
};

/** Send input to a job (use C-c for Ctrl+C) */
export const sendInput = async (opts: {
  jobId: string;
  input: string;
  /** If true, input is sent as-is without escaping, for special keys like C-c */
  noEscape?: boolean;
}) => {
  const { jobId, input, noEscape } = opts;

  // Exit choose-tree or other modes if active (they intercept keys)
  // copy-mode -q quits any active mode without sending keys to the pane
  await tmux(`copy-mode -q ${getSession}:${esc(jobId)}`).catch(() => {});

  const sending = noEscape ? input : `-l ${esc(input)}`;
  await tmux(`send-keys ${getSession}:${esc(jobId)} ${sending}`);
  await tmux(`choose-tree ${getSession} -w`); // Return to choose-tree (list) view

  return { success: true };
};

/** Kill a job and destroy its tmux window */
export const killJob = async (opts: { jobId: string }) => {
  const { jobId } = opts;
  await tmux(`kill-window ${getSession}:${esc(jobId)}`);
  return { success: true };
};
