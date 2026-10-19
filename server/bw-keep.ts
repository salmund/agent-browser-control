/**
 * Coffre Bitwarden / Vaultwarden gardé déverrouillé entre deux démarrages du démon (réglage du panneau).
 *
 * La clé de session est écrite dans le dossier de configuration :
 * - Windows : chiffrée par DPAPI pour le compte Windows courant (illisible copiée sur une autre machine
 *   ou par un autre compte) ; la valeur passe par l'environnement de PowerShell, jamais en argv ;
 * - ailleurs : fichier lisible par l'utilisateur seul (0600), comme les données du CLI `bw` lui-même.
 * Modèle de menace : celui du CLI. Un programme lancé sous le compte de l'utilisateur peut déjà lire
 * son coffre une fois déverrouillé ; le réglage évite seulement de retaper le mot de passe maître.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WINDOWS = process.platform === "win32";

const PROTECT =
  "Add-Type -AssemblyName System.Security; " +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect(" +
  "[Text.Encoding]::UTF8.GetBytes($env:ABC_BW_KEEP), $null, 'CurrentUser'))";
const UNPROTECT =
  "Add-Type -AssemblyName System.Security; " +
  "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect(" +
  "[Convert]::FromBase64String($env:ABC_BW_KEEP), $null, 'CurrentUser'))";

function powershell(script: string, value: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...process.env, ABC_BW_KEEP: value }, timeout: 15_000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())),
    );
  });
}

export function createBwKeep(configDir: string) {
  const flagFile = join(configDir, "bitwarden-keep.json");
  const sessionFile = join(configDir, "bitwarden-session");

  const enabled = (): boolean => {
    try {
      return JSON.parse(readFileSync(flagFile, "utf8"))?.keep === true;
    } catch {
      return false;
    }
  };

  return {
    enabled,
    setEnabled(on: boolean): void {
      if (on) writeFileSync(flagFile, JSON.stringify({ keep: true }));
      else {
        rmSync(flagFile, { force: true });
        rmSync(sessionFile, { force: true });
      }
    },
    /** Enregistre (ou efface, si null) la clé de session, seulement si le réglage est actif. */
    async store(sessionKey: string | null): Promise<void> {
      if (!sessionKey || !enabled()) {
        rmSync(sessionFile, { force: true });
        return;
      }
      const data = WINDOWS ? await powershell(PROTECT, sessionKey) : sessionKey;
      writeFileSync(sessionFile, data, { mode: 0o600 });
      if (!WINDOWS) chmodSync(sessionFile, 0o600);
    },
    /** Clé gardée au démarrage précédent, ou null (réglage inactif, rien de gardé, illisible). */
    async load(): Promise<string | null> {
      if (!enabled() || !existsSync(sessionFile)) return null;
      try {
        const data = readFileSync(sessionFile, "utf8").trim();
        const key = WINDOWS ? await powershell(UNPROTECT, data) : data;
        return key && !/\s/.test(key) ? key : null;
      } catch {
        rmSync(sessionFile, { force: true });
        return null;
      }
    },
  };
}
