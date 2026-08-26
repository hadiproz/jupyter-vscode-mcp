import * as vscode from 'vscode';
import { JupyterApi } from './jupyterApi';
import { McpServerManager } from './mcpServer';

let mcpManager: McpServerManager | undefined;
let statusItem: vscode.StatusBarItem | undefined;
const CONFIG_SECTION = 'jupyter-vscode-mcp';

function getPort(): number {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('mcpPort', 9123);
}

function updateStatus(running: boolean) {
  if (!statusItem || !mcpManager) return;
  if (running) {
    statusItem.text = `$(radio-tower) Jupyter MCP :${getPort()}`;
    statusItem.tooltip = 'Jupyter VS Code MCP server is running. Click to stop.';
    statusItem.backgroundColor = undefined;
  } else {
    statusItem.text = '$(circle-slash) Jupyter MCP off';
    statusItem.tooltip = 'Jupyter VS Code MCP server is stopped. Click to start.';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

async function showConfig(port: number) {
  const url = `http://localhost:${port}/mcp`;

  const claudeCursorSnippet = JSON.stringify(
    {
      mcpServers: {
        'jupyter-vscode-mcp': {
          url,
        },
      },
    },
    null,
    2
  );

  const opencodeSnippet = JSON.stringify(
    {
      mcp: {
        'jupyter-vscode-mcp': {
          type: 'remote',
          url,
          enabled: true,
        },
      },
    },
    null,
    2
  );

  const items: vscode.QuickPickItem[] = [
    {
      label: '$(copy) Claude Code / Cursor / Windsurf / Cline',
      description: 'mcpServers · url',
      detail: 'Paste into the agent MCP config — no absolute paths needed',
    },
    {
      label: '$(copy) OpenCode / Kilo Code',
      description: 'mcp · type: remote · url',
      detail: 'Paste into opencode.json or kilo.jsonc',
    },
    {
      label: '$(list-unordered) Show all',
      description: 'Display every format in the output panel',
      detail: 'No clipboard action — reference only',
    },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Jupyter VS Code MCP — Copy MCP Config (portable URL)',
    placeHolder: 'Select a config format to copy to clipboard',
  });

  if (!pick) return;

  const channel = vscode.window.createOutputChannel('Jupyter VS Code MCP Config');

  if (pick.label.includes('Claude')) {
    await vscode.env.clipboard.writeText(claudeCursorSnippet);
    channel.appendLine('// Claude Code / Cursor / Windsurf / Cline (mcpServers.url) — copied to clipboard');
    channel.appendLine(claudeCursorSnippet);
    channel.show();
    vscode.window.showInformationMessage('MCP URL config copied to clipboard.');
  } else if (pick.label.includes('OpenCode')) {
    await vscode.env.clipboard.writeText(opencodeSnippet);
    channel.appendLine('// OpenCode / Kilo (mcp.type=remote) — copied to clipboard');
    channel.appendLine(opencodeSnippet);
    channel.show();
    vscode.window.showInformationMessage('MCP URL config copied to clipboard.');
  } else {
    channel.appendLine(`// Endpoint: ${url}   (also accepts legacy /sse; probe GET /health)`);
    channel.appendLine('');
    channel.appendLine('// ── Claude Code / Cursor / Windsurf / Cline (mcpServers.url) ──');
    channel.appendLine(claudeCursorSnippet);
    channel.appendLine('');
    channel.appendLine('// ── OpenCode / Kilo (mcp.type=remote) ─────────────────────────');
    channel.appendLine(opencodeSnippet);
    channel.show();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const jupyterApi = new JupyterApi(context);
  const extVersion = String(context.extension?.packageJSON?.version ?? '0.0.0');

  mcpManager = new McpServerManager(jupyterApi, getPort(), extVersion);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  context.subscriptions.push(statusItem);
  updateStatus(false);

  async function doStart(silent = false): Promise<void> {
    try {
      await mcpManager?.start();
      updateStatus(true);
      if (!silent) vscode.window.showInformationMessage(`Jupyter VS Code MCP started at ${mcpManager?.endpoint}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to start Jupyter VS Code MCP: ${msg}`);
      throw err;
    }
  }

  async function doStop(silent = false): Promise<void> {
    await mcpManager?.stop();
    updateStatus(false);
    if (!silent) vscode.window.showInformationMessage('Jupyter VS Code MCP stopped');
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('jupyter-vscode-mcp.startMcp', () => doStart()),
    vscode.commands.registerCommand('jupyter-vscode-mcp.stopMcp', () => doStop()),
    vscode.commands.registerCommand('jupyter-vscode-mcp.showConfig', () => showConfig(getPort())),
    vscode.commands.registerCommand('jupyter-vscode-mcp.toggleMcp', async () => {
      if (mcpManager?.running) {
        vscode.window.showInformationMessage('Jupyter VS Code MCP stopped');
        await doStop(true);
      } else {
        await doStart();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(`${CONFIG_SECTION}.mcpPort`) || !mcpManager) return;
      const wasRunning = !!mcpManager.running;
      void (async () => {
        await mcpManager!.stop();
        mcpManager = new McpServerManager(jupyterApi, getPort(), extVersion);
        if (wasRunning) await doStart(true);
      })();
    })
  );

  statusItem.command = 'jupyter-vscode-mcp.toggleMcp';

  const autoStart = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('autoStart', true);
  if (autoStart) {
    try {
      await mcpManager.start();
      updateStatus(true);
    } catch (err) {
      vscode.window.showErrorMessage(`Jupyter VS Code MCP auto-start failed: ${err}`);
    }
  }
}

export async function deactivate() {
  await mcpManager?.stop();
}
