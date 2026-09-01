# Carte Laundry — carte-laundry.js

Carte Lovelace personnalisée pour Home Assistant, pour suivre un lave-linge ou un sèche-linge branché sur une prise connectée (Zigbee2MQTT ou équivalent) exposant **puissance**, **courant** et **énergie cumulée**.

Aucune entité Home Assistant à créer : la carte utilise directement vos capteurs natifs et calcule elle-même tout le reste (détection de cycle, coût, historique).

---

## Fonctionnalités

- Détection automatique "en fonctionnement" / "à l'arrêt", basée sur un seuil de puissance configurable.
- Pendant un cycle : consommation cumulée du cycle en cours (kWh), courant, durée, coût estimé en direct.
- À l'arrêt : date, durée et coût du **dernier cycle terminé**.
- Statistiques sur les **7 derniers jours** et les **30 derniers jours** : nombre de cycles + coût total.
- Popup d'historique détaillé (clic sur les statistiques) : liste de tous les cycles détectés, triés du plus récent au plus ancien, avec date, durée, énergie consommée et coût.
- Design différencié lave-linge / sèche-linge (icône, couleur d'accent, animation du hublot).
- Configuration **entièrement graphique** (éditeur de carte Home Assistant) — aucun YAML requis.

---

## Installation

1. Copiez `carte-laundry.js` dans `/config/www/carte-laundry.js`.
2. **Paramètres → Tableaux de bord → ⋮ → Ressources → Ajouter une ressource**
   - URL : `/local/carte-laundry.js`
   - Type : *Module JavaScript*
3. Ajoutez la carte à un tableau de bord : **Modifier le tableau de bord → Ajouter une carte → "Carte Laundry"**.
4. Renseignez vos entités et réglages dans le formulaire qui s'ouvre.

### Mettre à jour la carte
Après avoir remplacé le fichier, changez l'URL de la ressource (ex. `/local/carte-laundry.js?v=15`) pour forcer Home Assistant et votre navigateur à recharger le fichier — sinon l'ancienne version reste en cache.

---

## Configuration

Tout se règle via le formulaire de l'éditeur graphique.

| Champ | Description | Défaut |
|---|---|---|
| Type d'appareil | Lave-linge ou sèche-linge (change icône, couleur, animation, libellés) | Lave-linge |
| Nom / Sous-titre | Affichage libre | Nom du type / vide |
| Capteur de puissance (W) | **Obligatoire** — entité `sensor` en watts | — |
| Capteur de courant (A) | Optionnel — affiché pendant le cycle | — |
| Capteur d'énergie cumulée (kWh) | Optionnel mais nécessaire pour tout calcul de coût | — |
| Échelle du hublot (W) | Puissance correspondant à un hublot "plein" (visuel uniquement) | 2200 |
| Seuil de démarrage (W) | Puissance au-delà de laquelle on considère que ça tourne | 8 |
| Délai avant arrêt détecté (min) | Durée sous le seuil avant de déclarer l'arrêt (anti-pause de cycle) | 4 |
| Durée minimale d'un cycle (min) | En dessous, un "démarrage" n'est pas compté comme un vrai cycle | 5 |
| Ignorer les pics isolés plus courts que (s) | Immunité au bruit : un pic isolé et bref au-dessus du seuil n'interrompt pas le décompte d'arrêt | 45 |
| Prix du kWh (€) | Utilisé pour tous les calculs de coût (jamais affiché tel quel sur la carte) | 0,2516 |
| Historique — profondeur (jours) | Fenêtre de recherche de la popup d'historique | 60 |

---

## Comment ça marche

### Détection de cycle
La carte lit en direct `entity_power`. Si la puissance dépasse `power_threshold`, l'appareil est considéré "en marche". Elle repasse "à l'arrêt" après `stop_delay_minutes` passées **continûment** sous le seuil (pour ignorer les pauses normales d'un cycle — essorage/rinçage). Une remontée isolée et brève (< `noise_ignore_seconds`) pendant ce décompte est ignorée (bruit), mais une remontée durable clôt l'ancien cycle et en démarre un nouveau.

### Coût
- **Cycle en cours** : énergie au démarrage du cycle (récupérée dans l'historique récent) soustraite à l'énergie actuelle, multipliée par le prix du kWh.
- **Dernier cycle / historique / 7 et 30 jours** : même principe, appliqué à chaque cycle détecté dans l'historique brut de la puissance et de l'énergie.

### Historique et statistiques
Tous les calculs (dernier cycle, 7 jours, 30 jours, popup) sont basés sur l'**historique brut** de Home Assistant (pas les statistiques long terme — voir ci-dessous pourquoi), et reposent donc tous sur la même logique de détection. Un cycle visible dans la popup correspond toujours exactement aux chiffres affichés sur la carte.

---

## Limite connue : rétention de l'historique

Home Assistant purge l'historique brut après `purge_keep_days` jours (**10 par défaut**). Au-delà de cette fenêtre, les cycles ne sont plus visibles nulle part dans la carte (popup, "30 derniers jours").

- Les **7 derniers jours** sont toujours dans la fenêtre par défaut : fiables sans aucun réglage.
- Les **30 derniers jours** et la **popup** dépendent de votre rétention réelle.

Pour voir plus loin dans le temps, ajoutez dans `configuration.yaml` :

```yaml
recorder:
  purge_keep_days: 35   # ou plus, selon vos besoins
```

puis redémarrez Home Assistant. Ce réglage augmente la taille de la base de données du recorder en proportion — à choisir selon l'espace disque disponible.

**Pourquoi pas les statistiques long terme (conservées indéfiniment) ?** Plusieurs tentatives ont été faites pour s'en servir et s'affranchir de cette limite, mais elles ont produit des résultats faux à répétition (comptages et coûts incohérents) sans qu'une cause fiable ait pu être isolée avec certitude. La méthode actuelle (historique brut) est moins étendue dans le temps mais **garantie cohérente** entre tous les affichages de la carte.

---

## Historique des correctifs notables

- **Cycles fusionnés sur plusieurs heures** : un capteur qui ne remonte une valeur que sur changement peut rester silencieux pendant des heures une fois à 0 W. Si la lecture suivante après une pause était haute (nouveau cycle), l'algorithme d'origine ne vérifiait jamais si le délai d'arrêt avait eu le temps de s'écouler entre les deux, et fusionnait à tort deux cycles distincts. Corrigé en comparant les horodatages directement, indépendamment de la présence d'une ligne intermédiaire.
- **Coupures réseau comptées comme de la conso** : un état `unavailable`/`unknown` (Zigbee hors ligne) était ignoré au lieu d'être traité comme "pas de consommation", ce qui pouvait aussi fusionner des cycles séparés par une coupure.
- **Prix affiché retiré de la carte** : le prix du kWh est un paramètre de calcul interne, plus un champ visible/éditable sur la carte elle-même.

---

## Fichiers du projet

- `carte-laundry.js` — la carte (composant + éditeur graphique), à placer dans `/config/www/`.
- `lovelace-exemple.yaml` — exemple de configuration YAML (optionnel, la configuration graphique est recommandée).
