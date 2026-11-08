// "Start Craftie when I log in", using each OS's own startup mechanism:
//   Linux:   ~/.config/autostart/craftie.desktop (GNOME, KDE, Hyprland via uwsm, ...)
//   macOS:   ~/Library/LaunchAgents/com.craftie.plist
//   Windows: Startup folder script that runs Craftie with no window
// Output goes to ~/.craftie/craftie.log. Craftie then waits quietly for your game.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const node = process.execPath;
const logFile = join(homedir(), '.craftie', 'craftie.log');

function target(): string {
  const os = platform();
  if (os === 'win32') return join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Craftie.vbs');
  if (os === 'darwin') return join(homedir(), 'Library', 'LaunchAgents', 'com.craftie.plist');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'craftie.desktop');
}

export const autostartEnabled = () => existsSync(target());

export function setAutostart(on: boolean) {
  const file = target();
  if (!on) { rmSync(file, { force: true }); return; }
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });
  const app = join(root, 'src', 'app.ts');
  const os = platform();
  if (os === 'win32') {
    // A .vbs runs the command with no console window.
    const cmd = `cmd /c cd /d "${root}" && "${node}" "${app}" >> "${logFile}" 2>&1`;
    writeFileSync(file, `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`);
  } else if (os === 'darwin') {
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.craftie</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${app}</string></array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict></plist>
`);
  } else {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    writeFileSync(file, `[Desktop Entry]
Type=Application
Name=Craftie
Comment=AI helper for Minecraft (waits for your game in the background)
Exec=sh -c ${q(`cd ${q(root)} && exec ${q(node)} ${q(app)} >> ${q(logFile)} 2>&1`)}
Terminal=false
X-GNOME-Autostart-enabled=true
NoDisplay=true
`);
  }
}
