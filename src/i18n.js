// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and mode names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Atrea ventilation', 'Ventilation Atrea');

export const FEATURE_NAMES = {
  [FEATURES.MODE]: both('Ventilation mode', 'Mode de ventilation'),
  [FEATURES.CURRENT_MODE]: both('Current mode', 'Mode en cours'),
  [FEATURES.PROGRAM]: both('Control program', 'Programme de commande'),
  [FEATURES.RUNNING]: both('Unit running', 'Centrale en marche'),
  [FEATURES.POWER]: both('Fan power asked', 'Puissance de ventilation demandée'),
  [FEATURES.POWER_CURRENT]: both('Current fan power', 'Puissance de ventilation actuelle'),
  [FEATURES.TEMP_OUTDOOR]: both('Outdoor air temperature', 'Température de l’air extérieur'),
  [FEATURES.TEMP_SUPPLY]: both('Supply air temperature', 'Température de l’air soufflé'),
  [FEATURES.TEMP_EXTRACT]: both('Extract air temperature', 'Température de l’air extrait'),
  [FEATURES.TEMP_EXHAUST]: both('Exhaust air temperature', 'Température de l’air rejeté'),
  [FEATURES.TEMP_INDOOR]: both('Indoor air temperature', 'Température intérieure'),
  [FEATURES.TEMP_OUTDOOR_AVERAGE]: both(
    'Average outdoor temperature',
    'Température extérieure moyenne',
  ),
  [FEATURES.TEMP_REQUESTED]: both('Temperature asked', 'Température demandée'),
  [FEATURES.HEATING]: both('Heating', 'Chauffage'),
  [FEATURES.COOLING]: both('Cooling', 'Rafraîchissement'),
  [FEATURES.FILTER]: both('Filters to change', 'Filtres à changer'),
  [FEATURES.ALERT_COUNT]: both('Active alerts', 'Alertes actives'),
  [FEATURES.WARNING_COUNT]: both('Active warnings', 'Avertissements actifs'),
  [FEATURES.ALARM_CODES]: both('Alarm codes', 'Codes d’alarme'),
  [FEATURES.STOP]: both('Stop the unit', 'Arrêter la centrale'),
};

/** The modes (H10705). */
export const MODE_NAMES = {
  off: both('Off', 'Arrêt'),
  automatic: both('Automatic', 'Automatique'),
  ventilation: both('Ventilation', 'Ventilation'),
  'circulation-ventilation': both('Circulation and ventilation', 'Circulation et ventilation'),
  circulation: both('Circulation', 'Circulation'),
  'night-precooling': both('Night precooling', 'Rafraîchissement nocturne'),
  disbalance: both('Disbalance', 'Déséquilibre'),
  overpressure: both('Overpressure', 'Surpression'),
  'periodic-ventilation': both('Periodic ventilation', 'Ventilation périodique'),
  startup: both('Startup', 'Démarrage'),
  rundown: both('Rundown', 'Arrêt en cours'),
  defrosting: both('Defrosting', 'Dégivrage'),
  external: both('External', 'Externe'),
  'hp-defrosting': both('Heat pump defrosting', 'Dégivrage de la pompe à chaleur'),
  in1: both('IN1', 'IN1'),
  in2: both('IN2', 'IN2'),
  d1: both('D1', 'D1'),
  d2: both('D2', 'D2'),
  d3: both('D3', 'D3'),
  d4: both('D4', 'D4'),
};

/** The integration status and the answers of the button. */
export const T = {
  noHost: both(
    'Enter the IP address of your Atrea unit (its web page), then save.',
    'Saisissez l’adresse IP de votre centrale Atrea (sa page web), puis enregistrez.',
  ),
  invalid: (length) =>
    both(
      `Invalid address (${length} characters): an IPv4 address or a host name, optionally with a port.`,
      `Adresse invalide (${length} caractères) : une adresse IPv4 ou un nom d’hôte, avec un port si besoin.`,
    ),
  badPassword: both(
    'Invalid password (more than 64 bytes or a control character): no sign-in is tried.',
    'Mot de passe invalide (plus de 64 octets ou un caractère de contrôle) : aucune connexion n’est tentée.',
  ),
  needPassword: both(
    'The unit asks for its password: enter the password of its web page, then save.',
    'La centrale demande son mot de passe : saisissez celui de sa page web, puis enregistrez.',
  ),
  refused: both(
    'The unit refused the password twice in a row (wrong password, or too many users signed in to it). Nothing is tried again on its own: save the password again or press "Test the connection".',
    'La centrale a refusé le mot de passe deux fois de suite (mauvais mot de passe, ou trop d’utilisateurs connectés à la centrale). Plus rien n’est tenté seul : enregistrez de nouveau le mot de passe ou appuyez sur « Tester la connexion ».',
  ),
  deniedOnce: (wait) =>
    both(
      `The unit refused the password (wrong password, or too many users signed in); one more try in ${wait.en}.`,
      `La centrale a refusé le mot de passe (mauvais mot de passe, ou trop d’utilisateurs connectés) ; un autre essai dans ${wait.fr}.`,
    ),
  otherUnit: (kept, seen) =>
    both(
      `Connected, but the unit ID changed (${kept} → ${seen}): another unit may answer at this address. The mode and power commands are refused; if it is your unit, press "Test the connection" to accept it (a new device then appears in Discovery).`,
      `Connecté, mais l’identifiant de la centrale a changé (${kept} → ${seen}) : une autre centrale répond peut-être à cette adresse. Le mode et la puissance sont refusés ; si c’est bien votre centrale, appuyez sur « Tester la connexion » pour l’accepter (un nouvel appareil apparaît alors dans Découverte).`,
    ),
  accepted: (seen) =>
    both(
      `Unit accepted with the ID ${seen}: add it again from the Discovery tab.`,
      `Centrale acceptée avec l’identifiant ${seen} : ajoutez-la de nouveau depuis l’onglet Découverte.`,
    ),
  noId: both(
    ' The unit ID cannot be read: the mode and power commands are refused.',
    ' L’identifiant de la centrale est illisible : le mode et la puissance sont refusés.',
  ),
  notRd5: both(
    ' The unit does not show the RD5 registers (mode H10705): it may not be an RD5 regulation; values may be missing.',
    ' La centrale n’expose pas les registres RD5 (mode H10705) : ce n’est peut-être pas une régulation RD5 ; des valeurs peuvent manquer.',
  ),
  configUnread: (wait) =>
    both(
      `The configuration could not be read from Gladys; next try in ${wait.en}.`,
      `La configuration n’a pas pu être lue depuis Gladys ; nouvel essai dans ${wait.fr}.`,
    ),
  dataUnreadable: both(
    ' /data cannot be read: the mode and power commands are refused until a restart reads it.',
    ' /data illisible : le mode et la puissance sont refusés jusqu’à un redémarrage qui le relise.',
  ),
  stopKept: both(
    ' A stop sent from Gladys is kept: the unit read running again is stopped again (three sends at most) until a mode is chosen from Gladys or the unit is read running twice in a row after being seen off.',
    ' Un arrêt envoyé depuis Gladys est gardé : la centrale relue en marche est arrêtée de nouveau (trois envois au plus) jusqu’au choix d’un mode depuis Gladys ou deux lectures de suite en marche après l’avoir vue arrêtée.',
  ),
  stopWaiting: both(
    ' A stop pressed in Gladys has not reached the unit yet: it leaves first as soon as the unit can be reached with a valid session.',
    ' Un arrêt demandé dans Gladys n’a pas encore atteint la centrale : il part en premier dès que la centrale est joignable avec une session valide.',
  ),
  stopNotApplied: both(
    ' WARNING: the stop sent from Gladys does not show on the unit after three sends; stop it on its panel.',
    ' ATTENTION : l’arrêt envoyé depuis Gladys n’apparaît pas sur la centrale après trois envois ; arrêtez-la depuis son panneau.',
  ),
  connecting: both('Reading the unit…', 'Lecture de la centrale…'),
  waiting: (wait) =>
    both(
      `Next read of the unit in ${wait.en} (never sooner than the refresh interval).`,
      `Prochaine lecture de la centrale dans ${wait.fr} (jamais avant l’intervalle de rafraîchissement).`,
    ),
  lastRead: (ago) => both(`Last read ${ago.en} ago.`, `Dernière lecture il y a ${ago.fr}.`),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (address, wait) =>
    both(
      `No answer from ${address} (next try in ${wait.en}). Check the address and that the web page of the unit opens.`,
      `Pas de réponse de ${address} (nouvel essai dans ${wait.fr}). Vérifiez l’adresse et que la page web de la centrale s’ouvre.`,
    ),
  failing: (reason, wait) =>
    both(
      `The unit answered badly (${reason}); next try in ${wait.en}.`,
      `La centrale a mal répondu (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  summary: (values) => {
    const name = values.id ? `Atrea ${values.id}` : 'Atrea';
    if (values.running === false) {
      return both(`${name}: unit off.`, `${name} : centrale arrêtée.`);
    }
    const mode = MODE_NAMES[values.mode] ?? both('unknown mode', 'mode inconnu');
    const power = Number.isInteger(values.power) ? ` ${values.power} %` : '';
    return both(
      `${name}: ${mode.en.toLowerCase()}${power}.`,
      `${name} : ${mode.fr.toLowerCase()}${power}.`,
    );
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both('Unknown value: not sent.', 'Valeur inconnue : non envoyée.'),
  badPower: both(
    'The fan power is a whole number from 12 to 100 %: not sent.',
    'La puissance de ventilation est un nombre entier de 12 à 100 % : non envoyée.',
  ),
  badButton: both('A button only takes 1: not sent.', 'Un bouton ne prend que 1 : non envoyé.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    'Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l’intégration.',
  ),
  noHost: both(
    'No valid address in the configuration: not sent.',
    'Aucune adresse valide dans la configuration : non envoyée.',
  ),
  unitOff: both(
    'The unit is off or stopping: the fan power could start it. Choose a mode first. Not sent.',
    'La centrale est arrêtée ou en cours d’arrêt : la puissance pourrait la relancer. Choisissez d’abord un mode. Non envoyée.',
  ),
  stopKept: both(
    'A stop sent from Gladys is kept: choose a mode first. Not sent.',
    'Un arrêt envoyé depuis Gladys est gardé : choisissez d’abord un mode. Non envoyée.',
  ),
  modeNotWritable: both(
    'The unit does not let this mode be chosen (its list of writable modes): not sent.',
    'La centrale ne permet pas de choisir ce mode (sa liste des modes modifiables) : non envoyée.',
  ),
  modesUnknown: both(
    'The list of the modes the unit lets be chosen could not be read: not sent.',
    'La liste des modes que la centrale permet de choisir n’a pas pu être lue : non envoyée.',
  ),
  otherUnit: both(
    'The unit ID changed: another unit may answer at this address. Press "Test the connection" to accept it. Not sent.',
    'L’identifiant de la centrale a changé : une autre centrale répond peut-être à cette adresse. Appuyez sur « Tester la connexion » pour l’accepter. Non envoyée.',
  ),
  noIdentity: both(
    'The unit ID could not be read just before: not sent.',
    'L’identifiant de la centrale n’a pas pu être relu juste avant : non envoyée.',
  ),
  dataUnreadable: both(
    '/data cannot be read or written: not sent (a stop is never held back by this).',
    '/data ne peut pas être lu ou écrit : non envoyée (un arrêt n’est jamais bloqué par cela).',
  ),
  unknownMode: both(
    'The mode of the unit could not be read just before: command not sent.',
    'Le mode de la centrale n’a pas pu être relu juste avant : commande non envoyée.',
  ),
  noLogin: both(
    'The unit asks for a session and no password can be tried (none saved, or refused twice): not sent.',
    'La centrale demande une session et aucun mot de passe ne peut être essayé (aucun enregistré, ou refusé deux fois) : non envoyée.',
  ),
  denied: both(
    'The unit refused the password: not sent.',
    'La centrale a refusé le mot de passe : non envoyée.',
  ),
  stopHeld: both(
    'Stop not sent: the unit asks for a session and no password can be tried (none saved, or refused twice). It is kept and leaves first as soon as a password is saved or "Test the connection" succeeds.',
    'Arrêt non envoyé : la centrale demande une session et aucun mot de passe ne peut être essayé (aucun enregistré, ou refusé deux fois). Il est gardé et part en premier dès qu’un mot de passe est enregistré ou que « Tester la connexion » réussit.',
  ),
  stopDenied: both(
    'Stop not sent: the unit refused the password. It is kept and leaves first at the next read, or as soon as a password is saved or "Test the connection" succeeds.',
    'Arrêt non envoyé : la centrale a refusé le mot de passe. Il est gardé et part en premier à la prochaine lecture, ou dès qu’un mot de passe est enregistré ou que « Tester la connexion » réussit.',
  ),
  stopPending: both(
    'Stop not sent yet, still trying to reach the unit: it is kept and leaves first at the next read; check the unit in a few seconds.',
    'Arrêt pas encore envoyé, la centrale est encore en cours de connexion : il est gardé et part en premier à la prochaine lecture ; vérifiez la centrale dans quelques secondes.',
  ),
  stopNotSent: (reason) =>
    both(
      `Stop not sent (${reason}): it is kept and leaves first at the next read.`,
      `Arrêt non envoyé (${reason}) : il est gardé et part en premier à la prochaine lecture.`,
    ),
  configChanged: both(
    'The configuration changed meanwhile: not sent.',
    'La configuration a changé entre-temps : non envoyée.',
  ),
  busy: both(
    'Another command to the unit is still running: not sent.',
    'Une autre commande vers la centrale est encore en cours : non envoyée.',
  ),
  protectMeanwhile: both(
    'The unit was stopped meanwhile: not sent.',
    'La centrale a été arrêtée entre-temps : non envoyée.',
  ),
  tooSlow: both(
    'The unit answered too slowly to send the command in time: not sent.',
    'La centrale a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the unit could not be read just before (${reason}): command not sent.`,
      `L’état de la centrale n’a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  unreadable: both('unreadable', 'illisible'),
  refused: (reason) =>
    both(
      `The unit refused the command (${reason}): not applied.`,
      `La centrale a refusé la commande (${reason}) : non appliquée.`,
    ),
  notSent: (reason) =>
    both(
      `The unit could not be reached (${reason}): command not sent.`,
      `La centrale n’a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the unit in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l’état de la centrale dans quelques secondes.`,
    ),
  notYetApplied: both(
    'Command sent, the unit still reads the state from before: not applied yet, check in a few seconds.',
    'Commande envoyée, la centrale relit encore l’état d’avant : pas encore appliquée, vérifiez dans quelques secondes.',
  ),
};
