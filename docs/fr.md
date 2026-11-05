# Atrea pour Gladys

Affiche une ventilation double flux **Atrea** à régulation **RD5** (Duplex,
ECV…) dans Gladys, par la **page web** de la centrale sur votre réseau
local, sans cloud ni compte. Intégration non officielle, **sans lien avec
Atrea**. **Jamais testé avec un vrai appareil** : Atrea ne publie aucune
documentation de cette interface web ; l’intégration lit et écrit les pages
et registres qu’utilisent la bibliothèque libre pyatrea et l’intégration
HomeAssistant-Atrea (Home Assistant) ; merci de signaler ce que vous
observez.

## Avant de commencer

- La centrale doit être sur votre réseau et sa page web doit s’ouvrir depuis
  un navigateur (port 80). Donnez-lui une adresse IP fixe dans votre box.
- Notez le **mot de passe de la page web** (laissez le champ vide si la page
  n’en demande pas). La centrale n’accepte que peu d’utilisateurs connectés à
  la fois : Gladys garde une seule session et ne se reconnecte que lorsque la
  centrale le demande.
- La page web est en HTTP simple : la connexion passe sur votre réseau local
  comme celle de votre navigateur. Gardez la centrale sur un réseau de
  confiance.

## Installation

1. Installez l’intégration depuis le store de Gladys.
2. Saisissez l’**adresse IP de la centrale** (port 80 sauf si vous en
   ajoutez un) et le **mot de passe de sa page web** ; enregistrez.
3. Ouvrez l’onglet **Découverte** et ajoutez la centrale.

## Ce que vous obtenez

Un appareil, **Ventilation Atrea**, avec :

| Fonctionnalité                                                                                | Remarques                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Températures extérieure, de soufflage, d’extraction, de rejet, intérieure, extérieure moyenne | °C                                                                                                                                                                                                                                                                   |
| Température demandée                                                                          | °C, lecture seule                                                                                                                                                                                                                                                    |
| Puissance de ventilation demandée                                                             | %, 12 à 100, une commande (voir plus bas)                                                                                                                                                                                                                            |
| Puissance de ventilation actuelle                                                             | %, lecture seule                                                                                                                                                                                                                                                     |
| Mode de ventilation                                                                           | liste : automatique, ventilation, circulation et ventilation, circulation, rafraîchissement nocturne, déséquilibre, surpression                                                                                                                                      |
| Mode en cours                                                                                 | texte : `off`, `automatic`, `ventilation`, `circulation-ventilation`, `circulation`, `night-precooling`, `disbalance`, `overpressure`, `periodic-ventilation`, `startup`, `rundown`, `defrosting`, `external`, `hp-defrosting`, `in1`, `in2`, `d1`, `d2`, `d3`, `d4` |
| Programme de commande                                                                         | texte : `manual` (manuel), `weekly` (hebdomadaire), `temporary` (temporaire)                                                                                                                                                                                         |
| Centrale en marche                                                                            | 1 = en marche ; 0 = arrêtée ou en cours d’arrêt (`rundown`)                                                                                                                                                                                                          |
| Chauffage, rafraîchissement, filtres à changer                                                | lecture seule, 1 = oui                                                                                                                                                                                                                                               |
| Alertes actives, avertissements actifs, codes d’alarme                                        | des nombres ; texte `none` ou les codes de la centrale (`D11180, D11183`)                                                                                                                                                                                            |
| Arrêter la centrale                                                                           | bouton                                                                                                                                                                                                                                                               |

Une valeur hors de sa plage, vide ou qui n’est pas un nombre n’est jamais
publiée : Gladys garde la dernière valeur connue. Les listes d’alertes et
d’avertissements viennent d’une seconde page de la centrale, lue une fois
par heure : si elle échoue, les autres valeurs sont publiées quand même et
les fonctionnalités d’alarme restent inconnues jusqu’à sa lecture. Les
débits d’air (m³/h) et le by-pass ne sont pas publiés.

La centrale est lue toutes les 60 s (30 s à 1 h). Le bouton de test, une
recherche dans Découverte, une reconnexion de Gladys ou un redémarrage de
l’intégration ne la lisent jamais avant l’intervalle. Lectures hors
intervalle :

- chaque commande relit la centrale juste avant d’écrire, puis relit le
  résultat ;
- « Arrêter la centrale » et ses renvois ;
- 5 s puis 20 s après une commande ou un arrêt non confirmé, ou après un
  arrêt qui suit une commande non confirmée ;
- une nouvelle adresse enregistrée est lue tout de suite.

## Le mot de passe

Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché,
envoyé seulement à la centrale. Il n’est jamais écrit dans les journaux ni
dans les fichiers de l’intégration. Quand la centrale répond « denied »
(mauvais mot de passe, ou trop d’utilisateurs connectés à la centrale), la
lecture suivante essaie une fois de plus ; un second refus de suite arrête
toute connexion : le statut le dit, jusqu’à ce que vous enregistriez la
configuration (le même mot de passe compte : un essai de plus) ou appuyiez sur **Tester la connexion** (un essai
par appui). Après un redémarrage, l’intégration se souvient que ce mot de
passe a été refusé (sous forme d’une courte empreinte qui ne permet pas de
le retrouver) et ne le réessaie pas seule.

## Commandes

Le mode et la puissance de ventilation sont refusés tant que **Autoriser
les commandes** est désactivé (par défaut). Aucun interrupteur : le « tout
éteindre » d’un assistant vocal n’atteint jamais la ventilation.

- Chaque commande relit la centrale juste avant d’écrire (mode, programme,
  puissance, modes que la centrale permet de choisir, identifiant), n’écrit
  rien si la valeur est déjà la bonne, et n’est confirmée que si la
  centrale relit la valeur demandée. Une relecture qui montre encore l’état
  d’avant répond « pas encore appliquée » ; une commande qui a pu atteindre
  la centrale sans confirmation répond « envoyée, sans confirmation » :
  vérifiez la centrale quelques secondes plus tard. Une commande qui ne peut
  pas partir dans les 3,5 s est refusée et rien n’est envoyé.
- Sous le **programme hebdomadaire**, un changement passe le programme en
  **temporaire**, comme le fait la page web de la centrale.
- Refusée : un mode que la centrale ne permet pas de choisir (sa liste des
  modes modifiables, relue à chaque fois), quand l’**identifiant** lu
  diffère de celui appris ou est illisible (voir plus bas), quand **/data**
  ne peut pas être lu ou écrit, quand l’état de la centrale n’a pas pu être
  relu juste avant, quand aucune session ne peut être ouverte (pas de mot de
  passe, ou refusé).
- **Un mode démarre une centrale arrêtée** : avec l’option activée, choisir
  un mode est la façon de redémarrer la centrale depuis Gladys. Il lève un
  arrêt envoyé depuis Gladys (voir plus bas).
- La **puissance** est un nombre entier de 12 à 100 % ; elle est refusée
  sur une centrale **arrêtée ou en cours d’arrêt**, et tant qu’un **arrêt
  envoyé depuis Gladys est gardé** : choisissez d’abord un mode.

### Arrêter la centrale

« Arrêter la centrale » passe en programme manuel et en mode arrêt (le
programme hebdomadaire relancerait la centrale). Il ne dépend **pas** de
l’option, d’une autre commande (une commande pas encore écrite est
annulée), d’une lecture en cours ou bloquée (elle est interrompue), d’une
lecture en échec ou d’une attente entre deux essais, de l’identifiant, de
/data, ni d’une configuration pas encore relue depuis Gladys ou devenue
invalide (il va alors à l’adresse de l’arrêt gardé, sinon à la dernière
adresse valide gardée dans /data). Il est réessayé pendant 3,5 s après
l’appui ; une réponse à l’arrêt qui cesse d’arriver pendant 1 s est coupée
et l’arrêt renvoyé. Si la session a expiré, il se reconnecte une fois par
appui (la connexion peut prendre les 3,5 s : chaque connexion prend une
place sur la centrale). Il est confirmé quand la centrale relit le mode
arrêt (ou en cours d’arrêt) et le programme manuel ; une centrale lue
arrêtée mais encore dans un autre programme n’est jamais tenue pour arrêtée :
l’arrêt est renvoyé (trois envois au plus).

Il ne peut échouer que dans ces cas, et la réponse le dit :

- aucune adresse connue (jamais d’adresse valide configurée) : « non
  envoyé » ;
- la centrale demande une session et aucun mot de passe ne peut être
  essayé (aucun enregistré, refusé deux fois, ou l’arrêt va à une autre
  adresse que celle configurée) : « non envoyé », gardé, et envoyé en
  premier dès qu’un mot de passe est enregistré ou que le bouton de test
  réussit ;
- la session a expiré et la connexion de l’appui a échoué (pas de réponse
  à temps, connexion fermée, réponse illisible ; une connexion qui n’a même
  pas pu joindre la centrale est retentée dans les 3,5 s ; une connexion
  partie n’est jamais envoyée deux fois dans un appui : elle prend une place
  sur la centrale) : « non envoyé », gardé, envoyé en premier à la lecture
  suivante ;
- la centrale refuse le mot de passe : « non envoyé », gardé, envoyé en
  premier à la lecture suivante ;
- la centrale ne peut pas être jointe dans les 3,5 s : « non envoyé » (ou
  « pas encore envoyé » tant qu’il essaie encore), gardé, envoyé en premier
  à la lecture suivante ;
- pas de réponse, une réponse d’erreur, ou la centrale relue encore en
  marche : « envoyé, sans confirmation ».

L’arrêt est ensuite **gardé** (dans /data, avec l’adresse). Un arrêt qui
n’a jamais atteint la centrale n’est jamais abandonné : il part en premier
à chaque lecture jusqu’à son envoi (tant qu’aucun mot de passe ne peut être
essayé, il attend un nouveau mot de passe ou un test réussi) ; seul un envoi effectivement parti
compte comme essai. L’arrêt gardé n’est jamais levé par le temps, seulement
par un mode choisi depuis Gladys (avec l’option), ou quand la centrale est
lue en marche **deux fois de suite** après avoir été vue arrêtée (relancée
depuis son panneau). Tant qu’il est gardé, une lecture qui
trouve la centrale en marche avant de l’avoir vue arrêtée (ou après une
commande qui pourrait encore arriver) renvoie l’arrêt, trois envois au
plus ; le statut le dit. Un arrêt qui n’a peut-être pas abouti quand
l’intégration s’est arrêtée est renvoyé à son redémarrage, avant la
relecture de la configuration quand la centrale ne demande pas de mot de
passe, sinon juste après.

## Identité de la centrale

L’appareil est lié à l’**identifiant** que donne la centrale (registres
H12300 à H12309), appris à la première lecture ; l’identifiant est lu
jusqu’au premier registre vide, espaces de fin retirés (les espaces au
milieu sont gardés, écrits « - » dans l’identifiant de l’appareil) ; une
centrale qui n’en donne pas (registres absents ou vides) est l’appareil
« unit ». Quand un autre identifiant est lu à l’adresse,
une autre centrale répond peut-être : ses valeurs ne sont pas écrites dans
l’ancien appareil, et le mode et la puissance sont refusés jusqu’à ce que
**Tester la connexion** l’accepte ; elle devient alors un nouvel appareil
dans Découverte (l’arrêt n’en dépend jamais). Un identifiant illisible
n’est jamais pris pour une autre centrale, mais les commandes sont
refusées.

## Ce que l’intégration ne fait pas

Elle ne met jamais à jour le micrologiciel, ne change ni les réglages (sauf le
programme : voir l’arrêt et le programme hebdomadaire plus haut), ni
les programmes horaires, ni la température demandée, n’acquitte jamais les
alarmes ni les filtres, ne lit pas les traductions de la page web.
