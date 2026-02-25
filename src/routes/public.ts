import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess, ensureMoltbotGateway } from '../gateway';

/**
 * Public routes - NO Cloudflare Access authentication required
 * 
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    // Always list all processes for diagnostics
    let allProcesses: Array<{ id: string; command: string; status: string }> = [];
    try {
      const procs = await sandbox.listProcesses();
      allProcesses = procs.map(p => ({ id: p.id, command: p.command, status: p.status }));
      console.log('[DIAG] All processes:', JSON.stringify(allProcesses));
    } catch (e) {
      console.log('[DIAG] listProcesses error:', e);
    }

    const process = await findExistingMoltbotProcess(sandbox);
    console.log('[DIAG] findExistingMoltbotProcess result:', process ? `${process.id} (${process.status})` : 'null');

    if (!process) {
      // No running gateway — trigger ensureMoltbotGateway in background to start one
      console.log('[DIAG] No running gateway, triggering ensureMoltbotGateway in background');
      c.executionCtx.waitUntil(
        ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
          console.error('[DIAG] Background gateway start failed:', err.message);
        })
      );

      // If there are failed processes, get their logs for diagnostics
      const failedProcs = allProcesses.filter(p => p.status === 'failed');
      let failedLogs = '';
      if (failedProcs.length > 0) {
        try {
          const procs = await sandbox.listProcesses();
          const failedProc = procs.find(p => p.status === 'failed' || p.status === 'completed');
          if (failedProc) {
            const logs = await failedProc.getLogs();
            failedLogs = `stdout: ${(logs.stdout || '').slice(0, 1500)}\nstderr: ${(logs.stderr || '').slice(0, 1500)}`;
            console.log('[DIAG] Failed process stdout:', (logs.stdout || '').slice(0, 2000));
            console.log('[DIAG] Failed process stderr:', (logs.stderr || '').slice(0, 2000));
          }
        } catch (e) {
          console.log('[DIAG] Failed to get logs from failed process:', e);
        }
      }
      return c.json({ ok: false, status: 'not_running', processes: allProcesses, failedLogs });
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });

      // TCP port is open — do an HTTP health check to verify gateway is actually usable
      // (catches cases where gateway requires token auth but we now run tokenless)
      try {
        const healthReq = new Request('http://localhost:18789/');
        const healthResp = await sandbox.containerFetch(healthReq, 18789);
        const healthBody = await healthResp.text();
        console.log('[DIAG] Gateway HTTP health check status:', healthResp.status, 'body:', healthBody.slice(0, 300));

        // If gateway returns token-related errors, kill and restart without token
        if (healthBody.includes('gateway token') || healthBody.includes('unauthorized')) {
          console.log('[DIAG] Gateway has token auth enabled but we need tokenless. Killing and restarting...');
          await process.kill();

          c.executionCtx.waitUntil(
            ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
              console.error('[DIAG] Tokenless gateway restart failed:', err.message);
            })
          );

          return c.json({ ok: false, status: 'restarting', reason: 'token_auth_mismatch', processes: allProcesses });
        }
      } catch (healthErr) {
        console.log('[DIAG] HTTP health check error (non-fatal):', healthErr);
      }

      return c.json({ ok: true, status: 'running', processId: process.id, processes: allProcesses });
    } catch {
      // Always include process logs when not responding
      let logs = { stdout: '', stderr: '' };
      try {
        logs = await process.getLogs();
        console.log('[DIAG] Gateway stdout:', (logs.stdout || '').slice(0, 2000));
        console.log('[DIAG] Gateway stderr:', (logs.stderr || '').slice(0, 2000));
      } catch (e) {
        console.log('[DIAG] getLogs error:', e);
      }
      return c.json({
        ok: false,
        status: 'not_responding',
        processId: process.id,
        processes: allProcesses,
        stdout: (logs.stdout || '').slice(0, 500),
        stderr: (logs.stderr || '').slice(0, 500)
      });
    }
  } catch (err) {
    return c.json({ ok: false, status: 'error', error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// GET /api/restart - Kill existing gateway and start fresh (temporary debug endpoint)
publicRoutes.get('/api/restart', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const procs = await sandbox.listProcesses();
    let killed = 0;
    for (const proc of procs) {
      if (proc.command.includes('start-moltbot.sh') || proc.command.includes('openclaw gateway')) {
        if (proc.status === 'running' || proc.status === 'starting') {
          console.log('[RESTART] Killing process:', proc.id, proc.command);
          await proc.kill();
          killed++;
        }
      }
    }

    console.log('[RESTART] Killed', killed, 'processes. Starting fresh gateway...');

    // Start fresh gateway in background
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
        console.error('[RESTART] Fresh gateway start failed:', err.message);
      })
    );

    return c.json({ ok: true, killed, message: 'Gateway restart triggered' });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

export { publicRoutes };
