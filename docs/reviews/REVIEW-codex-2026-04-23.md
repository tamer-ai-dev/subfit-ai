# Review codex

## Findings

1. **`assistantLines` sert de base au verdict abonnement alors que code prétend raisonner sur messages avec usage.**
   Réf: [subfit-ai.ts](subfit-ai.ts:430), [subfit-ai.ts](subfit-ai.ts:433), [subfit-ai.ts](subfit-ai.ts:1214), [README.md](README.md:69).
   `scanJsonl()` et `scanGeminiSession()` incrémentent `assistantLines` avant validation du bloc `usage` / `tokens`, puis `main()` passe `ctx.assistantLines` à `computeSubscriptionStats()`. Donc verdict 5h peut être gonflé par des tours assistant sans métriques, alors que README dit explicitement "keeps only lines ... with a `message.usage` block". Test Gemini encode même ce comportement comme normal: [tests/gemini.test.ts](tests/gemini.test.ts:121). Pour un outil de pricing, c'est cœur du résultat qui part faux.

2. **Support Gemini casse sémantique des colonnes "Claude $" / "What you actually paid to Anthropic".**
   Réf: [README.md](README.md:74), [subfit-ai.ts](subfit-ai.ts:618), [subfit-ai.ts](subfit-ai.ts:651), [config.json](config.json:10).
   Depuis ajout des buckets `gemini-*`, `computeRows()` prend `pricing[model]` sans distinguer fournisseur puis affiche ça dans colonne `Claude $`. Pour lignes Gemini, vous affichez donc un coût Gemini API sous label "Claude $", et ratio "Codex / Claude" devient faux. Même problème dans export Markdown. README continue à promettre "What you actually paid to Anthropic". Non. Rapport mélange coûts multi-provider avec vocabulaire Claude-only.

3. **`--demo` n'est pas isolé: il continue à scanner `~/.gemini` si dossier existe.**
   Réf: [subfit-ai.ts](subfit-ai.ts:1155), [subfit-ai.ts](subfit-ai.ts:1161), [subfit-ai.ts](subfit-ai.ts:1174), [README.md](README.md:98), [README.md](README.md:110).
   `--demo` remplace seulement `args.path`. `args.geminiPath` reste réel. Sur machine ayant Gemini CLI, démo "synthetic fixture" est polluée par vraies sessions Gemini. Donc zéro reproductibilité, zéro "zero setup", et sortie de démo dépend machine locale.

4. **Export Markdown ment sur scan quand Gemini participe, ou pire quand repo est Gemini-only.**
   Réf: [subfit-ai.ts](subfit-ai.ts:1042), [subfit-ai.ts](subfit-ai.ts:1254), [subfit-ai.ts](subfit-ai.ts:1287).
   `renderMarkdown()` reçoit seulement `scanPath` et `filesScanned` côté Claude. Si user scanne uniquement Gemini, rapport exporté peut afficher `0 JSONL file(s) under ~/.claude` alors que analyse réelle vient de `~/.gemini`. Export n'est plus représentation fidèle de l'exécution.

5. **Warning modèles inconnus est faux dès qu'un modèle Gemini inconnu apparaît.**
   Réf: [subfit-ai.ts](subfit-ai.ts:507), [subfit-ai.ts](subfit-ai.ts:1206).
   `normalizeGeminiModel()` fallback vers `gemini-pro`, mais warning global dit toujours "bucketed as Claude Opus" et conseille uniquement `normalizeModel()`. Message opératoire faux. En debug pricing, ça envoie user au mauvais endroit.

6. **README dérive déjà de config réelle.**
   Réf: [README.md](README.md:219), [config.json](config.json:5).
   Exemple config documente `Claude Opus 4` à `15 / 75 / 1.5 / 18.75`; config réelle embarquée est `5 / 25 / 0.5 / 6.25`. Ce n'est pas un détail cosmétique: repo vend du pricing, README montre autres chiffres. Même drift pour Haiku (`0.80 / 4.0 / 0.08 / 1.0` vs `1.0 / 5.0 / 0.10 / 1.25`).

## Ce qui manque

- Tests end-to-end pour cas mixtes Claude+Gemini sur rendu terminal/Markdown/JSON.
- Test `--demo` garantissant absence de lecture provider réel.
- Test protégeant invariants docs/config ou génération README depuis config unique. Là, drift déjà visible.
- Clarification conceptuelle: outil compare quoi exactement quand source = Gemini ? "coût réel provider d'origine" ? "coût Claude équivalent" ? "coût Codex équivalent" ? Aujourd'hui texte et colonnes disent plusieurs choses incompatibles.

## Avis brut

Base utilitaire, code lisible, tests unitaires propres. Mais produit raconte une histoire plus nette que réalité. Ajout Gemini a traversé couches de calcul sans refonte vocabulaire ni sorties. Résultat: chiffres potentiellement faux sur verdict abonnement, labels faux sur coûts, README déjà désynchronisé. Avant nouvelle feature, je verrouillerais définition métier et j'écrirais 2-3 tests d'intégration qui snapshot sortie mixte.
