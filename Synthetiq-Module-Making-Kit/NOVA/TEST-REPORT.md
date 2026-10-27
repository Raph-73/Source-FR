# Rapport de test — Nova Stream

- **Module** : Nova Stream (`nova-streaming`)
- **Version** : `1.0.0-beta.2`
- **Contrat** : `4` (`discovery_v1: true`)
- **Identité** : `PENDING-OWNER-ALLOCATION` / `0`
- **ZIP** : `NOVA/dist/NovaStream-1.0.0-beta.2.zip`
- **SHA-256** : `bc7a250fa47ca3e70e623a760fbf4e142dcd23d48dff5c81ab5714f039174601`
- **Date des tests** : 2026-10-27, 13:50–13:54 (Europe/Paris, UTC+1)
- **Hôte** : Windows, Node.js `v24.21.0`, harnais local du kit
- **Application / appareil** : non testés ; S2 et Flutter absents de cet environnement
- **Source** : `https://watchnova.win`, pages publiques `https://uqload.vc/<id>.html`
- **Publication** : aucune. Build bêta local uniquement.

> Ce rapport distingue la vérification structurelle locale de la lecture réelle.
> Une playlist HLS valide et des octets MPEG-TS ne prouvent ni le décodage, ni le son,
> ni la langue audio, ni la lecture sur appareil.

## Autorisation de la source

Le demandeur a déclaré le 2026-10-27 disposer de toutes les permissions nécessaires
pour ce module et cette source. Cette déclaration sert de base d'autorisation au projet.
Aucun document externe n'est joint à ce dossier local.

Pour mémoire, `https://watchnova.win/robots.txt` contient :

```text
Disallow: /api/
Disallow: /title
```

Le module interroge `/api/catalog` et `/api/titles/{id}/episodes`. Le ZIP n'a pas été
publié ; une éventuelle publication reste une décision séparée du propriétaire du
catalogue. Aucun contournement de compte, paywall, DRM, CAPTCHA ou bêta fermée n'est
effectué. HeiwaStream et les hébergeurs non-uqload sont refusés.

## Résultat des suites

Les nombres ci-dessous sont des exécutions, pas des cas uniques.

| Suite | Tentés | Réussis | Échecs | Bloqués |
| --- | ---: | ---: | ---: | ---: |
| Tests hors ligne du kit (`tests/kit.test.cjs`) | 17 | 17 | 0 | 0 |
| Tests unitaires du module (`NOVA/tests/unit-check.cjs`) | 26 | 26 | 0 | 0 |
| `tools/run_checks.cjs` en direct | 5 | 4 | 0 | 1 |
| Comportement live étendu (`NOVA/tests/live-smoke.cjs`) | 31 | 31 | 0 | 0 |
| Sonde structurelle étendue du cas bloqué | 1 | 1 | 0 | 0 |
| **Somme des exécutions** | **80** | **79** | **0** | **1** |

Le seul « bloqué » est un plafond du checker local, pas un échec du module : voir
« Boîte noire » ci-dessous.

## Couverture vérifiée

| Titre / année | Épisode | Audio annoncé | Route observée | Résultat | Preuve |
| --- | --- | --- | --- | --- | --- |
| Un p'tit truc en plus / 2024 | film | dub | HLS `360p` | PASS | `run_checks` local + sonde MPEG-TS |
| Irréductible / 2022 | film | dub | HLS `360p` | PASS | `run_checks` local + sonde MPEG-TS |
| Boîte noire / 2021 | film | dub | HLS `720p` | PASS structurel | Sonde étendue ; `run_checks` bloqué par son plafond |
| Vikings / 2013 | S01E01 | dub | HLS `360p` | PASS | `run_checks` local + sonde MPEG-TS |
| Mentalist / 2008 | S01E01 | dub | HLS `352p` | PASS | `run_checks` local + sonde MPEG-TS |
| Découverte | accueil | — | 12 sections, 292 cartes uniques | PASS | `discoveryHome` |
| Découverte | feed `films` p.1/p.2 | — | 30 + 30 cartes, aucune répétition | PASS | `discoveryFeed` |
| Recherche | vide / inconnue | — | `[]` | PASS | `searchResults` |
| Recherche | deux appels identiques | — | résultats identiques | PASS | `searchResults` |
| Entrées URL complètes | détails / épisodes / flux | — | normalisation correcte | PASS | URLs `watchnova.win/title/...` |

### Preuves structurelles

- `Un p'tit truc en plus` : HLS, un variant, prélèvement MPEG-TS de 262 144 octets.
- `Irréductible` : HLS, un variant, prélèvement MPEG-TS de 262 144 octets.
- `Vikings` S01E01 : HLS, un variant, prélèvement MPEG-TS de 78 584 octets.
- `Mentalist` S01E01 : HLS, un variant, prélèvement MPEG-TS de 262 144 octets.
- `Boîte noire` : playlist complète de 274 618 octets, 1 557 segments, `#EXT-X-ENDLIST`,
  aucune clé, aucun `EXT-X-MAP`, aucun byte-range. Premier et dernier segments :
  HTTP 206, signature MPEG-TS (octet `0x47` aux offsets 0 et 188).
- Tous les flux retournés portent les en-têtes `Referer: https://uqload.vc/` et
  `Origin: https://uqload.vc`.

### Blocages vérifiés

| Cas | Identifiant | Résultat observé |
| --- | --- | --- |
| Premium actif | `movie-1483325` | refusé : « réservé à NOVA Premium » |
| Épisode premium | `tv-283297-s1e1` | refusé ; `extractEpisodes` retourne `[]` |
| Source = autre épisode | `movie-381284` | refusé : source `Vikings S01E06` pour un film |
| Mauvaise année | `movie-4327` | refusé : année de source incompatible |
| Mauvais titre | `movie-1243078` | refusé : titre de source incompatible |
| Mauvais titre/année | `movie-33740` | refusé : année de source incompatible |
| Bêta fermée HeiwaStream | `movie-335787` | refusé : hôte non pris en charge |
| Hébergeur vidzy | `movie-1504358` | refusé : uqload uniquement |
| VOSTFR demandé | `movie-1152014`, `lang=vostfr` | refusé : VF uniquement |
| Source VOSTFR | `movie-1744462` | refusé : source VOSTFR détectée |

### Découverte

- 12 sections, toutes avec un identifiant unique et un `viewAll` de type feed.
- 292 cartes uniques après déduplication, avec `href`, `title` et `image` non vides.
- Les titres premium et Heiwa sont absents de l'accueil et des feeds testés.
- 3 films du catalogue sans visuel (`movie-1217122`, `movie-1052388`, `movie-684428`)
  sont exclus de la découverte pour ne pas produire de carte vide. Une recherche
  directe peut encore les retourner avec une image vide.

## Flaky / conditionnel

1. **Plafond du checker local.** `node tools/run_checks.cjs NOVA --query "Boîte noire"`
   échoue avec `Playlist exceeds bounded check`. La playlist réelle fait 274 618 octets,
   au-dessus de la limite de 262 144 octets de `tools/media_probe.cjs`. Une sonde
   étendue a vérifié la playlist complète et les premier/dernier segments. Ce n'est pas
   un défaut du module, mais le résultat officiel du checker reste « bloqué ».
2. **URL uqload signées et temporaires.** Les liens du catalogue sont périmés ; le module
   résout une page publique fraîche à chaque lecture. Un succès dépend de la disponibilité
   de cette page et de la source au moment du test.
3. **Qualités multiples.** Le chemin de parsing/étiquetage multi-qualités est couvert par
   test unitaire synthétique (360p/720p/1040p triés, labels `dub <hauteur>p`). Aucun flux
   live multi-qualités n'a été observé pendant cette campagne : seuls des variants uniques
   ont été validés en direct.
4. **Correspondance de titre.** La vérification est heuristique (tokens normalisés,
   tolérance d'année). Les cas connus sont testés, mais les 398 entrées n'ont pas été
   comparées une par une à leur source.

## Non vérifié

- Lecture réelle dans l'application Flutter et sur appareil physique.
- Décodage vidéo, avancement, pause, seek et changement de qualité.
- Audio réellement audible, langue VF, synchronisation et pistes audio.
- Sous-titres (aucun sous-titre n'est exposé par ce module).
- Téléchargement et lecture hors ligne.
- S2 du mainteneur.
- Autorisation/redistribution de la source.
- Couverture des 398 entrées du catalogue et de tous les épisodes.

## Verdict

- **Vérifications locales** : PASS (79/80 exécutions ; 1 bloqueur de checker expliqué).
- **S2** : NON EXÉCUTÉ.
- **Appareil physique** : NON EXÉCUTÉ.
- **Téléchargement/hors ligne** : NON EXÉCUTÉ.
- **Publication** : NON EFFECTUÉE. L'autorisation a été déclarée par le demandeur ;
  l'identité reste à allouer. S2 et test appareil restent obligatoires avant diffusion.

## Reproductibilité

```text
node --check NOVA/index.js
node --test tests/kit.test.cjs
node NOVA/tests/unit-check.cjs
node NOVA/tests/live-smoke.cjs
node tools/run_checks.cjs NOVA --query "Un p'tit truc en plus" --result 1 --ep 1 --lang dub
node tools/run_checks.cjs NOVA --query "Irréductible" --result 1 --ep 1 --lang dub
node tools/run_checks.cjs NOVA --query "Vikings" --result 1 --ep 1 --lang dub
node tools/run_checks.cjs NOVA --query "Mentalist" --result 1 --ep 1 --lang dub
node templates/package.cjs --dir NOVA --version 1.0.0-beta.2
```

Le ZIP a été décompressé dans un dossier temporaire : il contient exactement
`module.json` et `index.js` à sa racine. Le hash de l'`index.js` extrait correspond à
celui du fichier de travail (`8c697561c1128a799a0e5cb5777ef84df1998fe84a5df8bd6cef38f148fa1c54`).
