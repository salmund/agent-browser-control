# ask_human : protocole de vérification manuelle (2 minutes)

Le chemin heureux exige un humain : le test e2e (`test/e2e-ask-human.ts`) ne couvre
que les validations et le timeout. Vérifier une fois par release :

1. Lancer : `node test/call.ts ask_human '{"tabId": <onglet agent>, "question": "Cliquez sur le premier lien.", "context": "Test manuel", "timeout": 120}'`
2. Constater : l'onglet passe devant, une notification système s'affiche, le panneau
   latéral s'ouvre avec la carte « Action requise » (question, contexte, titre, URL).
3. Agir dans l'onglet (cliquer un lien), saisir une note (« lien cliqué »),
   cliquer « C'est fait ».
4. Constater : l'outil répond « Utilisateur : fait. », avec l'effet constaté
   (changement d'URL) et la note. L'onglet reste devant. La carte a disparu
   du panneau, la notification est fermée.
5. Relancer et cliquer « Annuler » : l'outil échoue avec « annulé ».
6. STOP pendant une demande : l'outil échoue avec « Arrêt d'urgence ».
