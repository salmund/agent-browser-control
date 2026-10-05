/**
 * Rejouement du code de l'outil `javascript` refusé par Runtime.evaluate.
 * Module pur (service worker + tests Node), sans dépendance chrome.
 *
 * - "has already been declared" (const/let d'un appel précédent) : isole le code dans un bloc,
 *   dont la valeur de complétion reste celle de la dernière expression.
 * - "Illegal return statement" (return de premier niveau, ex. code généré par un agent) :
 *   enveloppe dans une fonction async aussitôt appelée. Le return devient légal, le await de
 *   premier niveau reste possible, et le périmètre de fonction absorbe aussi les const/let
 *   redéclarés (le 2e essai du service worker couvre un code qui combine les deux erreurs).
 *
 * Renvoie l'expression à rejouer, ou null si l'erreur n'est pas récupérable.
 */
function jsRetry(expression, description) {
  const desc = String(description ?? "");
  if (/Illegal return statement/.test(desc)) return `(async () => {\n${expression}\n})()`;
  if (/has already been declared/.test(desc)) return `{\n${expression}\n}`;
  return null;
}

/**
 * Identifiant en clair d'un slot (non secret). Le secret, lui, reste déchiffré
 * côté service worker et ne transite jamais ici. Erreur claire si absent.
 */
function credentialLogin(slot) {
  const login = slot ? slot.login : undefined;
  if (login) return String(login);
  const id = slot && slot.id ? slot.id : "?";
  throw new Error('Slot "' + id + '" : aucun identifiant enregistré (ajoutez-le dans le panneau, champ Identifiant).');
}

globalThis.AbcJsEval = { jsRetry, credentialLogin };
