import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { mountR2Storage } from './r2';

/**
 * Find an existing Moltbot gateway process
 * 
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Only match the gateway process, not CLI commands like "openclaw devices list"
      const isGatewayProcess =
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('openclaw gateway');
      const isCliCommand =
        proc.command.includes('openclaw devices') ||
        proc.command.includes('openclaw --version');
      
      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the Moltbot gateway is running
 * 
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  // Mount R2 storage for persistent data (non-blocking if not configured)
  // R2 is used as a backup - the startup script will restore from it on boot
  await mountR2Storage(sandbox, env);

  // Check if Moltbot is already running or starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log('Found existing Moltbot process:', existingProcess.id, 'status:', existingProcess.status);

    // Always use full startup timeout - a process can be "running" but not ready yet
    // (e.g., just started by another concurrent request). Using a shorter timeout
    // causes race conditions where we kill processes that are still initializing.
    try {
      console.log('Waiting for Moltbot gateway on port', MOLTBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('Moltbot gateway port is open, verifying connectivity via sandbox network...');

      // waitForPort TCP check can succeed on loopback, but containerFetch/wsConnect
      // connect via 10.0.0.1 (the container's LAN interface). If the gateway is bound
      // to loopback only, the port check passes but actual connections fail.
      // The sandbox returns 500 "not listening on 10.0.0.1" when unreachable.
      try {
        const healthReq = new Request(`http://localhost:${MOLTBOT_PORT}/`);
        const healthResp = await sandbox.containerFetch(healthReq, MOLTBOT_PORT);
        console.log('Gateway containerFetch status:', healthResp.status);
        if (healthResp.status === 500) {
          const body = await healthResp.text().catch(() => '');
          console.log('Gateway returned 500, body:', body.slice(0, 200));
          throw new Error('Gateway unreachable via sandbox network (500)');
        }
        console.log('Gateway connectivity verified');
        return existingProcess;
      } catch (fetchErr) {
        console.log('Gateway port open but unreachable via sandbox network (likely bound to loopback). Killing...');
        try {
          await existingProcess.kill();
        } catch (killError) {
          console.log('Failed to kill loopback-bound process:', killError);
        }
        // Fall through to start a new gateway
      }
    } catch (e) {
      // Timeout waiting for port - process is likely dead or stuck, kill and restart
      console.log('Existing process not reachable after full timeout, killing and restarting...');
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('Failed to kill process:', killError);
      }
    }
  }

  // Start a new Moltbot gateway
  console.log('Starting new Moltbot gateway...');

  // Kill any stale gateway processes from previous deploys
  // (they may have been started with different bind modes or token configs)
  try {
    const allProcs = await sandbox.listProcesses();
    for (const proc of allProcs) {
      if ((proc.command.includes('start-moltbot.sh') || proc.command.includes('openclaw gateway')) &&
          (proc.status === 'running' || proc.status === 'starting')) {
        console.log('[Gateway] Killing stale process:', proc.id, proc.command.slice(0, 60));
        await proc.kill();
      }
    }
  } catch (e) {
    console.log('[Gateway] Stale process cleanup failed (non-fatal):', e);
  }

  const envVars = buildEnvVars(env);
  const command = '/usr/local/bin/start-moltbot.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log('[Gateway] Waiting for Moltbot gateway to be ready on port', MOLTBOT_PORT);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[Gateway] Moltbot gateway is ready!');

    const logs = await process.getLogs();
    if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
    if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);
    try {
      const logs = await process.getLogs();
      console.error('[Gateway] startup failed. Stderr:', logs.stderr);
      console.error('[Gateway] startup failed. Stdout:', logs.stdout);
      throw new Error(`Moltbot gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`);
    } catch (logErr) {
      console.error('[Gateway] Failed to get logs:', logErr);
      throw e;
    }
  }

  // Verify gateway is actually reachable via the sandbox network (not just loopback)
  console.log('[Gateway] Verifying gateway connectivity via sandbox network...');
  try {
    const healthReq = new Request(`http://localhost:${MOLTBOT_PORT}/`);
    const healthResp = await sandbox.containerFetch(healthReq, MOLTBOT_PORT);
    console.log('[Gateway] containerFetch status:', healthResp.status);
    if (healthResp.status === 500) {
      const body = await healthResp.text().catch(() => '');
      console.error('[Gateway] New gateway returned 500:', body.slice(0, 200));
      throw new Error('Gateway started but not reachable via sandbox network (500)');
    }
    console.log('[Gateway] Connectivity verified');
  } catch (fetchErr) {
    console.error('[Gateway] Gateway started but unreachable via sandbox network:', fetchErr);
    throw new Error('Gateway started but not reachable via sandbox network (may be bound to loopback)');
  }

  return process;
}
