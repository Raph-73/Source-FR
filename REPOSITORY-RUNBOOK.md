# Runbook — index de dépôt Synthetiq qui s'importe

Dernière validation : 28 octobre 2026, app Synthetiq 8.x, dépôt `ney73/Ney-source`.
Les deux modules (Franime et Nova Stream) s'importent et fonctionnent avec cette structure.

URL à importer :

```
https://raw.githubusercontent.com/ney73/Ney-source/main/repository.json
```

Avant tout push, lancer :

```
node verify-repository.cjs
```

Le script vérifie le schéma, l'unicité des identités, les SHA-256, les ZIP plats,
la cohérence manifeste/index et le contenu du bundle. Il ne teste pas la lecture.

---

## 1. Structure qui marche

`repository.json` à la racine du dépôt :

```json
{
  "schemaVersion": 1,
  "repositoryId": "ney-source",
  "name": "Ney Source",
  "enabled": true,
  "publishedAtMs": 1793209318446,
  "bundle": {
    "version": 2,
    "minAppVersion": "8.0.0",
    "packageUrl": "https://raw.githubusercontent.com/ney73/Ney-source/main/bundles/Ney-Source-Bundle-2.zip",
    "packagePath": "/ney73/Ney-source/main/bundles/Ney-Source-Bundle-2.zip",
    "sha256": "<sha256 du bundle>",
    "signature": ""
  },
  "modules": [
    {
      "moduleId": "franime-v1",
      "moduleFamilyId": "franime_v1",
      "moduleIdentity": "SP-VID-9001-FRANIME",
      "moduleIdentityNumber": 9001,
      "contentType": "video",
      "version": "1.0.0-beta.5",
      "minAppVersion": "8.0.0",
      "packageUrl": "https://raw.githubusercontent.com/ney73/Ney-source/main/Synthetiq-Module-Making-Kit/Franime/dist/Franime-1.0.0-beta.5.zip",
      "packagePath": "/ney73/Ney-source/main/Synthetiq-Module-Making-Kit/Franime/dist/Franime-1.0.0-beta.5.zip",
      "sha256": "<sha256 du zip>",
      "publishedAtMs": 1793209318446,
      "changelog": ["..."],
      "presentation": { "...": "..." },
      "signature": ""
    }
  ],
  "signature": ""
}
```

Points non négociables :

- `bundle` et `modules` doivent être présents, même vides.
- Chaque `packageUrl` doit être une URL HTTPS brute et `packagePath` son chemin
  absolu `/<owner>/<repo>/<branch>/<fichier>`.
- `sha256` doit correspondre au fichier réellement publié.
- `signature` peut rester `""` : c'est le cas de tous les dépôts tiers qui
  s'importent (vérifié sur `Giaxina/testing-modules-1234` et
  `kas021/Testing-Modules-1-2-3-4`).
- **Ne jamais ajouter `defaultModules` / `defaultModulesSignature`** sur un dépôt
  non officiel. Voir erreur 3.

`catalogue.json` est un fichier source local, pas lu par l'app. Il doit rester
cohérent avec l'index (mêmes modules, mêmes versions, mêmes hash) et ne doit pas
contenir `defaultModules` si l'index n'en contient pas.

---

## 2. Les trois erreurs rencontrées, dans l'ordre

### Erreur 1 — `type 'Null' is not a subtype of type 'Map<dynamic, dynamic>'`

Cause : le bloc `bundle` était absent. L'app le caste en `Map` sans vérifier `null`.

Correctif : ajouter `bundle` avec `version`, `minAppVersion`, `packageUrl`,
`packagePath`, `sha256`, `signature`.

### Erreur 2 — `FormatException: Repository contains duplicate module identities.`

Cause : les deux manifestes portaient le placeholder
`PENDING-OWNER-ALLOCATION` / `0`. L'app refuse deux modules avec la même identité.

Correctif : allouer une identité et un numéro uniques par module, y compris pour
un dépôt privé, puis reconstruire les ZIP avec le packager fourni. Ici :

| Module | Identité | Numéro |
|---|---|---|
| Franime | `SP-VID-9001-FRANIME` | `9001` |
| Nova Stream | `SP-VID-9002-NOVA-STREAM` | `9002` |

Rappel : ces numéros sont des allocations **privées**. Une publication publique
exige une identité attribuée par le mainteneur ; ne jamais présenter `9001/9002`
comme officiels.

### Erreur 3 — `FormatException: Repository defaults are not signed.`

Cause : `defaultModules` était présent avec `defaultModulesSignature: ""`.
L'app exige une signature valide pour les modules par défaut, et seule la clé
privée du dépôt officiel permet de la produire. Un dépôt tiers ne peut donc pas
déclarer de valeurs par défaut.

Correctif : **supprimer complètement** `defaultModules` et
`defaultModulesSignature`. Ne pas tenter de signer avec une autre clé : la
vérification échouerait, et une fausse signature est pire qu'une absence.
L'utilisateur choisit alors lui-même son module dans l'app.

---

## 3. Procédure de mise à jour d'un module

1. Modifier `Synthetiq-Module-Making-Kit/<Module>/index.js` et/ou `module.json`.
2. Incrémenter `moduleVersion` (et `version` si présent) dans le manifeste.
   **Ne pas changer** `moduleIdentity` ni `moduleIdentityNumber`.
3. Reconstruire le ZIP avec le packager fourni :

   ```
   node Synthetiq-Module-Making-Kit/templates/package.cjs \
     --dir Synthetiq-Module-Making-Kit/<Module> \
     --version <nouvelle-version> \
     --identity <identité existante> \
     --number <numéro existant>
   ```

4. Reconstruire le bundle avec les nouveaux ZIP (même nom de bundle, version
   incrémentée si le contenu change) :

   ```
   Compress-Archive -Path <dossier-temporaire>/* -DestinationPath bundles/<Bundle>.zip -CompressionLevel Optimal
   ```

5. Mettre à jour `repository.json` **et** `catalogue.json` : `version`,
   `packageUrl`, `packagePath`, `sha256`, `publishedAtMs`, `bundle.version`,
   `bundle.packageUrl`, `bundle.packagePath`, `bundle.sha256`, changelog.
6. Archiver l'ancien ZIP dans `retiredPackages` du catalogue (ne pas le supprimer).
7. Lancer `node verify-repository.cjs` : tout doit être `PASS`.
8. Commit + push.
9. Attendre la propagation du cache raw GitHub (compter 1 à 3 minutes), puis
   vérifier l'URL raw et les hash téléchargés.
10. Dans l'app : supprimer l'ancienne entrée du dépôt puis réimporter l'URL si
    l'ancien index reste en cache.

---

## 4. Pièges à éviter

- Ne pas mettre les ZIP dans un sous-dossier du ZIP : le paquet doit être plat
  (`module.json` + `index.js` à la racine).
- Ne pas réutiliser une identité ou un numéro pour un autre module.
- Ne pas oublier de mettre à jour le hash après le moindre rebuild : un ZIP
  reconstruit change de SHA-256 même à contenu identique.
- Ne pas déclarer un `minAppVersion` différent entre le bundle et les modules.
- Ne pas mettre d'URL `github.com/.../blob/...` : utiliser `raw.githubusercontent.com`.
- Ne pas promettre que la lecture fonctionne : `verify-repository.cjs` ne teste
  que l'index et les paquets. La lecture réelle reste à confirmer dans l'app.
- Ne pas modifier l'app, le dépôt officiel ou les services de production.

---

## 5. Preuves de la dernière validation

- `repository.json` : HTTP 200 via raw et via l'API GitHub, sans `defaultModules`.
- Identités, IDs et numéros uniques.
- SHA-256 des deux ZIP et du bundle identiques aux valeurs déclarées.
- ZIP plats, `node --check index.js` OK sur les deux modules.
- Bundle contenant exactement `Franime-1.0.0-beta.5.zip` et
  `NovaStream-1.0.0-beta.3.zip`.
- `contractVersion` 4, `runtime.mode` local, caps dans les bornes.
- Import et fonctionnement confirmés par l'utilisateur dans l'app.

Non couvert par ces preuves : lecture sur un autre appareil, téléchargement
hors ligne, sous-titres, et comportement des sources dans le temps.
