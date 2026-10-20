/**
 * Profils de site livrés avec ABC : ce qu'on sait déjà du site avant de l'avoir visité (type d'éditeur, routeur,
 * pièges), servi à l'arrivée comme la mémoire de site_api mais maintenu ici, donc de confiance (pas écrit par
 * une page ni par un agent). Court par choix : chaque ligne doit épargner un essai raté.
 * Ajouter un profil = une entrée de BUILTIN_PROFILES ; un site appris en usage va plutôt dans site_api (note).
 */

export interface SiteProfile {
  name: string;
  /** Hôte exact ou suffixe de domaine (« univ-rouen.fr » couvre sogo.univ-rouen.fr). */
  hosts: string[];
  lines: string[];
}

export const BUILTIN_PROFILES: SiteProfile[] = [
  {
    name: "SOGo (webmail)",
    hosts: ["sogo.univ-rouen.fr", "sogo.univ-lille.fr"],
    lines: [
      "Routeur AngularJS à fragment (#!/Mail/…) : un navigate qui ne change que le fragment peut ne rien déclencher, ABC clique alors le lien du menu et le dit.",
      "Corps du message = CKEditor 5 : form_input (value, format text ou markdown) le remplit par son API ; ne jamais coller du multiligne avec computer type.",
      "Destinataire : form_input avec l'adresse, ABC choisit la suggestion et crée la puce. Pièce jointe : file_upload sur le bouton de pièce jointe.",
      "Cibler par target ou par ref, jamais par coordonnées : un clic mal placé ouvre un message et le marque lu.",
    ],
  },
  {
    name: "Gmail",
    hosts: ["mail.google.com"],
    lines: [
      "Connexions longues permanentes : wait_for networkIdle n'aboutit jamais ; file_upload attend lui-même la fin de l'envoi et confirme le nom du fichier.",
      "Rédaction directe par URL : ?view=cm&fs=1&to=…&su=… ; le corps est un éditeur contenteditable (form_input fonctionne).",
      "La page expose beaucoup d'éléments (300 et plus) : lire avec maxItems ou filter='interactive', ou viser par target.",
      "Brouillon abandonné : la suppression ouvre une boîte de confirmation (handle_dialog).",
    ],
  },
  {
    name: "Google Docs / Sheets / Slides",
    hosts: ["docs.google.com"],
    lines: [
      "Contenu dessiné dans un canvas : get_page_text lit l'export du document (dernière version enregistrée), read_page ne voit pas le texte.",
    ],
  },
  {
    name: "Vercel (tableau de bord)",
    hosts: ["vercel.com"],
    lines: [
      "Application à routeur History : navigate sur la même origine suit le routeur sans recharger ; les listes de déploiements se chargent après coup, resonder avant de conclure à « vide ».",
    ],
  },
];

const hostMatches = (host: string, pattern: string): boolean => host === pattern || host.endsWith(`.${pattern}`);

/** Profils applicables à `host`. */
export function profilesFor(host: string, profiles: SiteProfile[] = BUILTIN_PROFILES): SiteProfile[] {
  const h = host.toLowerCase().replace(/^www\./, "");
  return profiles.filter((p) => p.hosts.some((pat) => hostMatches(h, pat)));
}

/** Texte servi en tête de réponse, ou null si aucun profil ne s'applique. */
export function formatProfileBrief(host: string, profiles: SiteProfile[] = BUILTIN_PROFILES): string | null {
  const found = profilesFor(host, profiles);
  if (!found.length) return null;
  return found.map((p) => [`Profil ABC ${p.name} :`, ...p.lines.map((l) => `- ${l}`)].join("\n")).join("\n");
}
