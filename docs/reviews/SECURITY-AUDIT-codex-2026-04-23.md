# Security audit codex

## Findings

1. **`docker build` exfiltration footgun: repo ships Docker instructions but no `.dockerignore`.**
   Réf: [Dockerfile](Dockerfile:5), [Dockerfile](Dockerfile:18), [README.md](README.md:97), [README.md](README.md:118).
   Vous invitez explicitement les gens à faire `docker build -t subfit-ai .`, mais repo n'a pas de `.dockerignore`. Conséquence: Docker envoie tout le contexte local au daemon/builder avant même d'appliquer les `COPY`. Dans ce workspace il y a déjà des dotdirs et artefacts locaux (`.claude/`, `.codex`, `.opencode/`, `logs/`, fichiers de review non commités). En local avec buildkit distant, builder cloud, ou CI bricolée, ça devient fuite de données triviale. Sur HN, quelqu'un va tester, builder sur machine sale, puis découvrir que l'outil "offline" a envoyé son contexte perso au build.

2. **DoS mémoire facile: chaque fichier d'entrée est chargé entièrement en RAM.**
   Réf: [subfit-ai.ts](subfit-ai.ts:424), [subfit-ai.ts](subfit-ai.ts:429), [subfit-ai.ts](subfit-ai.ts:526), [subfit-ai.ts](subfit-ai.ts:533), [subfit-ai.ts](subfit-ai.ts:102), [subfit-ai.ts](subfit-ai.ts:261).
   `scanJsonl()` fait `readFileSync(..., "utf-8")` puis `split("\n")`. `scanGeminiSession()` fait pareil sur le JSON complet. `loadConfig()` aussi. Aucun plafond de taille, aucun streaming, aucun timeout, aucune limite de nombre de fichiers. Un dossier malveillant ou juste énorme peut faire exploser mémoire CPU sans effort. Ce n'est pas RCE, mais pour un CLI que des inconnus vont pull après HN, c'est le bug "ça freeze / ça crashe mon laptop" tout trouvé.

3. **Injection terminal/log via `model` non reconnu provenant des fichiers scannés.**
   Réf: [subfit-ai.ts](subfit-ai.ts:442), [subfit-ai.ts](subfit-ai.ts:545), [subfit-ai.ts](subfit-ai.ts:1231), [subfit-ai.ts](subfit-ai.ts:1236).
   Les IDs de modèles inconnus sont repris tels quels depuis JSONL / JSON puis réémis sur `stderr`. Si un fichier crafté contient des retours ligne, séquences ANSI, OSC 8, etc., sortie terminal peut être polluée, maquillée, ou rendre liens/couleurs trompeurs. Impact limité à terminal injection locale, pas exécution de code, mais c'est exactement le genre de demo embarrassante qu'un lecteur HN peut poster en capture.

4. **`--export` autorise overwrite arbitraire de n'importe quel fichier writable.**
   Réf: [subfit-ai.ts](subfit-ai.ts:178), [subfit-ai.ts](subfit-ai.ts:185), [subfit-ai.ts](subfit-ai.ts:1310), [subfit-ai.ts](subfit-ai.ts:1320), [subfit-ai.ts](subfit-ai.ts:1347).
   Techniquement, ce n'est pas une path traversal "exploit" puisqu'utilisateur choisit le chemin. Mais en pratique c'est un clobber sans garde: `--export ~/.bashrc`, `--export package.json`, `--export ../README.md` écrase tout avec simple warning. Si plus tard quelqu'un wrappe ce binaire dans une UI/web wrapper naïve, ça devient primitive d'écriture immédiate.

5. **Parser récursif sans bornes sur `--path` / `--gemini-path`: un répertoire massif ou monté bizarrement peut rendre l'outil inutilisable.**
   Réf: [subfit-ai.ts](subfit-ai.ts:257), [subfit-ai.ts](subfit-ai.ts:264), [subfit-ai.ts](subfit-ai.ts:278), [subfit-ai.ts](subfit-ai.ts:481), [README.md](README.md:131).
   `findJsonlFiles()` et `findGeminiSessions()` marchent sans quotas ni filtres de profondeur. Vous évitez quelques répertoires de bruit au top-level, rien de plus. Sur chemin pointant par erreur vers `$HOME`, mount réseau, dump géant, ou arbre rempli de milliers de fichiers, utilisateur mange scan potentiellement énorme. Pas vulnérabilité serveur, mais mauvais profil de robustesse pour tool grand public.

6. **Message "offline" vrai pour runtime, moins vrai pour supply chain / image build.**
   Réf: [README.md](README.md:31), [CLAUDE.md](CLAUDE.md:54), [Dockerfile](Dockerfile:16).
   Le projet se vend "no network call". Côté exécution du script, oui. Mais Docker fait `npm install -g tsx@4` au build, donc build non reproductible sans pin digest ni verrou, et pas du tout "offline". Même sujet pour `npx tsx` côté usage. Ce n'est pas une faille applicative directe, mais publiquement ça ouvre angle d'attaque "offline sauf quand il télécharge du code". Sur HN, quelqu'un va le pointer.

## Données perso / trucs embarrassants

- Dans les fichiers commités que j'ai lus: pas de clé API, token, secret, email perso, ni dump de session réel. `examples/sample.jsonl` a l'air synthétique.
- `config.json` ne contient que URLs publiques de pricing. Rien de sensible.
- `.git/config` local contient `git@github.com:tamer-ai-dev/planfit.git` et `[email protected]`, mais ce n'est pas versionné. Pas un problème de repo public en soi.
- `.claude/settings.json` existe dans workspace mais lecture bloquée par permissions sandbox. Point important: si ces permissions changent et que vous faites des builds Docker sans `.dockerignore`, ce genre de fichier peut partir dans le contexte build.
- Le repo promet "single-file CLI" et "zero runtime dependencies", mais shipping Docker + build npm + divers docs agent fait vite moins minimal que le pitch. Pas sécurité pure, mais angle moquerie facile.

## Avis brut

Pas de secret obvious dans ce qui va partir sur GitHub. Pas de RCE via `config.json`: c'est du `JSON.parse`, point. Pas de path traversal classique non plus. Le vrai sujet sécurité, c'est robustesse locale et hygiène d'outillage autour: build context Docker qui peut aspirer des fichiers perso, scans non bornés, lecture full-file en mémoire, et quelques sorties terminal non assainies. Pour un post Hacker News, je corrigerais surtout `.dockerignore` + limites de taille/streaming avant publication. Le reste, c'est surtout du "local footgun", mais les footguns font les meilleurs commentaires HN.
