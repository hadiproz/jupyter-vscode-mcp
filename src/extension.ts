import * as vscode from 'vscode';
import { PortOwnershipError, type OwnershipMode } from './clusterControl';
import { JupyterApi } from './jupyterApi';
import { McpServerManager } from './mcpServer';

let mcpManager: McpServerManager | undefined;
let statusItem: vscode.StatusBarItem | undefined;
const CONFIG_SECTION = 'jupyter-vscode-mcp';

function getSettings() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    port: config.get<number>('mcpPort', 9123),
    ownershipMode: config.get<OwnershipMode>('ownershipMode', 'handover'),
    autoStart: config.get<boolean>('autoStart', true),
  };
}

function updateStatus() {
  if (!statusItem || !mcpManager) return;
  statusItem.command = `${CONFIG_SECTION}.toggleMcp`;
  if (mcpManager.running) {
    statusItem.text = `$(radio-tower) Jupyter MCP :${mcpManager.listeningPort}`;
    statusItem.tooltip = 'Jupyter VS Code MCP server is running. Click to stop.';
    statusItem.backgroundColor = undefined;
  } else if (mcpManager.yielded) {
    statusItem.text = '$(circle-slash) Jupyter MCP (yielded)';
    statusItem.tooltip = 'Another VS Code window took over the MCP port. Click to reclaim it.';
    statusItem.command = `${CONFIG_SECTION}.reclaimPort`;
    statusItem.backgroundColor = undefined;
  } else {
    statusItem.text = '$(circle-slash) Jupyter MCP off';
    statusItem.tooltip = 'Jupyter VS Code MCP server is stopped. Click to start.';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

function showStartError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PortOwnershipError || getSettings().ownershipMode === 'hub') {
    void vscode.window.showErrorMessage(message, 'Open Settings').then((choice) => {
      if (choice === 'Open Settings') {
        const setting = error instanceof PortOwnershipError ? 'mcpPort' : 'ownershipMode';
        return vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.${setting}`);
      }
    });
  } else {
    void vscode.window.showErrorMessage(`Failed to start Jupyter VS Code MCP: ${message}`);
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
  const { port, ownershipMode, autoStart } = getSettings();
  const manager = new McpServerManager(jupyterApi, port, extVersion, {
    ownershipMode,
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    onYield: updateStatus,
  });
  mcpManager = manager;

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  context.subscriptions.push(statusItem);
  updateStatus();
  statusItem.show();

  async function doStart(silent = false, mode?: OwnershipMode): Promise<void> {
    try {
      await manager.start(mode);
      if (!silent) void vscode.window.showInformationMessage(`Jupyter VS Code MCP started at ${manager.endpoint}`);
    } catch (error) {
      showStartError(error);
    } finally {
      updateStatus();
    }
  }

  async function doStop(): Promise<void> {
    await manager.stop();
    updateStatus();
    void vscode.window.showInformationMessage('Jupyter VS Code MCP stopped');
  }

  context.subscriptions.push(
    { dispose: () => jupyterApi.clearAllState() },
    vscode.commands.registerCommand(`${CONFIG_SECTION}.startMcp`, () => doStart()),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.stopMcp`, () => doStop()),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.reclaimPort`, () => doStart(false, 'handover')),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.showConfig`, () => showConfig(manager.listeningPort)),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.toggleMcp`, () => manager.running ? doStop() : doStart()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      jupyterApi.clearStaleWorkspaceState();
      updateStatus();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(`${CONFIG_SECTION}.mcpPort`) && !e.affectsConfiguration(`${CONFIG_SECTION}.ownershipMode`)) return;
      const settings = getSettings();
      void manager.configure(settings.port, settings.ownershipMode).catch(showStartError).finally(updateStatus);
    })
  );

  if (autoStart) await doStart(true);
}

export async function deactivate() {
  await mcpManager?.stop();
}
