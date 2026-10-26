# Migrations

Un changement dans le dossier de réglages d'un appareil (`~/.agent-browser-control` : fichier renommé, format
changé, dossier déplacé) se fait ici, et nulle part ailleurs. `npm run update` les applique dans l'ordre, une
seule fois par appareil (liste des faites : `~/.agent-browser-control/maj/migrations.json`), après un instantané
des réglages qui est restauré si la mise à jour échoue.

Un fichier par migration, `NNNN-nom.ts` (quatre chiffres, puis des minuscules et des tirets) :

```ts
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export const description = "site-api.json devient sites.json";

export function migrer(ctx: { configDir: string; depot: string; plateforme: NodeJS.Platform; log: (m: string) => void }): void {
  const avant = join(ctx.configDir, "site-api.json");
  const apres = join(ctx.configDir, "sites.json");
  if (existsSync(avant) && !existsSync(apres)) renameSync(avant, apres); // idempotente : rejouée sans dommage
}
```

Règles :

- **Idempotente** : une migration interrompue est rejouée à la mise à jour suivante.
- **Jamais modifiée une fois publiée** : un appareil l'a peut-être déjà appliquée. Pour corriger, en ajouter une autre.
- **Sans réseau ni interaction** : elle tourne sur un serveur sans écran, démon arrêté ou en cours de relance.
- **Le nouveau code lit encore l'ancien format** quand c'est possible, le temps d'une version (élargir, puis resserrer).
