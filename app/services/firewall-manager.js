const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Regras permanentes, mas estritamente limitadas às portas usadas pelo modo
// self-hosted. A elevação só é solicitada após o usuário clicar em hospedar
// pela internet; o UAC do Windows continua sendo a confirmação final.
const FIREWALL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$rules = @(
  @{ Name = 'ScreenShare - TCP 7880'; Protocol = 'TCP'; Port = 7880 },
  @{ Name = 'ScreenShare - TCP 7881'; Protocol = 'TCP'; Port = 7881 },
  @{ Name = 'ScreenShare - UDP 7882'; Protocol = 'UDP'; Port = 7882 },
  @{ Name = 'ScreenShare - TCP 7883'; Protocol = 'TCP'; Port = 7883 }
)
foreach ($rule in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
  if (-not $existing) {
    New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow -Protocol $rule.Protocol -LocalPort $rule.Port -Profile Any | Out-Null
  }
}
`;

async function ensureWindowsFirewallRules() {
  if (process.platform !== 'win32') return;
  const encodedScript = Buffer.from(FIREWALL_SCRIPT, 'utf16le').toString('base64');
  const launcher = `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encodedScript}' -Verb RunAs -Wait -PassThru; if ($process.ExitCode -ne 0) { exit $process.ExitCode }`;
  // Não ocultamos o processo que chama RunAs: em algumas instalações do
  // Windows isso suprime a janela UAC e faz a elevação falhar sem o usuário
  // ter oportunidade de confirmar. O PowerShell elevado fecha ao terminar.
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', launcher], {
    windowsHide: false,
    timeout: 60_000,
  });
}

module.exports = { ensureWindowsFirewallRules };
