/**
 * Succexhub · Réception des réservations de business.succexhub.com
 *
 * À coller dans le Google Sheet « Succexhub - Réservations (leads) » :
 * Extensions → Apps Script → remplacer le contenu de Code.gs → Enregistrer
 * → Déployer → Nouveau déploiement → Application Web
 *   - Exécuter en tant que : Moi
 *   - Qui a accès : Tout le monde
 * Copier l'URL de l'application Web (…/exec) et la mettre dans index.html (SX_SHEET_URL).
 *
 * La page envoie deux types de messages :
 *   - action "create"   : au clic sur « Continuer » (coordonnées remplies)
 *   - action "whatsapp" : au clic sur « Envoyer ma réservation sur WhatsApp »
 */

// Doit être identique à SX_SHEET_TOKEN dans index.html. Ce n'est pas un secret fort
// (il est visible dans la page) : il filtre seulement les envois automatiques au hasard.
var TOKEN = 'sx_BfKA7RRfO1kKRq2UZ3inWYk';
var TZ = 'Africa/Kinshasa';

var LEADS = 'leads';
var INTERACTIONS = 'interactions';

var LEAD_HEADERS = [
  'lead_id', 'created_at', 'updated_at', 'prenom', 'nom', 'phone_e164',
  'session_date', 'session_label', 'consent_rappel', 'whatsapp_envoye', 'whatsapp_at',
  'statut', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', 'fbp', 'fbc', 'page_url', 'user_agent',
  'responsable', 'prochaine_action', 'notes',
  'envoi_confirmation', 'envoi_veille', 'envoi_matin', 'envoi_suivi'
];

// Actions réservées à n8n (relances WhatsApp). Elles exigent la clé ADMIN_TOKEN,
// rangée dans Paramètres du projet → Propriétés du script (jamais dans le code),
// et transmise par n8n dans l'URL (?key=...).
var ADMIN_ACTIONS = { list: true, find: true, mark: true, qualif: true, qualif_get: true };
var MARKABLE = ['statut', 'session_date', 'session_label',
  'envoi_confirmation', 'envoi_veille', 'envoi_matin', 'envoi_suivi'];
var INTERACTION_HEADERS = ['lead_id', 'date', 'canal', 'message', 'resultat', 'responsable'];

// Onglet tenu par l'agent IA WhatsApp : une ligne par prospect, mise à jour à chaque message.
// L'équipe peut changer « statut » à la main (Présent, CP, Formation, Pas intéressé…) :
// l'agent ne touche plus alors à ce statut.
var QUALIF = 'qualification';
var QUALIF_HEADERS = [
  'numero', 'prenom', 'premier_contact', 'dernier_contact', 'nb_messages', 'etape', 'statut',
  'situation', 'besoin', 'objectif', 'disponibilite', 'objection', 'date_rencontre',
  'passer_la_main', 'raison', 'dernier_message', 'derniere_reponse', 'responsable', 'notes'
];
var QUALIF_FIELDS = ['prenom', 'situation', 'besoin', 'objectif', 'disponibilite', 'objection', 'date_rencontre', 'raison'];
var QUALIF_AUTO_STATUTS = { '': true, 'En conversation': true, 'Rendez-vous pris': true };

// Prospection LinkedIn, tenue par Claude : une ligne par profil (onglet « linkedin »)
// et un journal des actions du jour (onglet « linkedin_journal ») pour respecter les limites.
// Clé dédiée LINKEDIN_TOKEN (Propriétés du script), transmise dans l'URL (?key=...).
var LI_ACTIONS = { li_upsert: true, li_list: true, li_log: true, li_today: true };
var LI = 'linkedin';
var LI_HEADERS = [
  'date_ajout', 'nom', 'titre', 'ville', 'url_profil', 'pourquoi_lui', 'statut',
  'date_invitation', 'date_acceptation', 'dernier_message', 'prochaine_action',
  'telephone', 'notes', 'mis_a_jour'
];
var LI_FIELDS = ['nom', 'titre', 'ville', 'pourquoi_lui', 'statut', 'date_invitation',
  'date_acceptation', 'dernier_message', 'prochaine_action', 'telephone'];
var LI_JOURNAL = 'linkedin_journal';
var LI_JOURNAL_HEADERS = ['date', 'action', 'url_profil', 'detail'];
var LI_JOURNAL_TYPES = { profil: true, recherche: true, invitation: true, message: true };

// Liste des FBO de l'équipe (onglet « fbo ») : une ligne par matricule.
// Même clé que la prospection LinkedIn (LINKEDIN_TOKEN).
var FBO_ACTIONS = { fbo_upsert: true, fbo_list: true };
var FBO = 'fbo';
var FBO_HEADERS = ['matricule', 'nom', 'telephone', 'statut', 'parrain', 'notes', 'mis_a_jour'];
var FBO_FIELDS = ['nom', 'telephone', 'statut', 'parrain'];
var FBO_STATUTS = ['Client privilégié', 'Animateur Adjoint', 'Animateur', 'Manager adjoint', 'Manager'];

// Prospection directe de la base (onglet « Succexhub - Contacts »).
// Colonnes ajoutées au bout de l'onglet si elles manquent : pros_statut (Envoyé, Répondu, STOP, Échec),
// pros_envoi (date du 1er message), pros_version (1, 2 ou 3), pros_reponse (date et début de la 1re réponse).
var PROS_ACTIONS = { pros_next: true, pros_mark: true, pros_find: true };
var CONTACTS = 'Succexhub - Contacts';
var PROS_COLS = ['pros_statut', 'pros_envoi', 'pros_version', 'pros_reponse'];

// Statuts posés automatiquement par le site. Les statuts suivants
// (Confirmé, Présent, Absent, Inscrit, Pas intéressé, STOP) sont mis à la main.
var STATUT_COORDONNEES = 'Coordonnées remplies';
var STATUT_WHATSAPP = 'WhatsApp envoyé';

function doGet() {
  return json({ ok: true, service: 'succexhub-leads' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (ADMIN_ACTIONS[d.action]) {
      var why = adminProblem(e);
      if (why) return json({ ok: false, error: why });
      if (d.action === 'qualif') return json(upsertQualif(d));
      if (d.action === 'qualif_get') return json(getQualif(d));
      var s = leadsSheet();
      if (d.action === 'list') return json(listLeads(s, d));
      if (d.action === 'find') return json(findByPhone(s, d));
      return json(markLead(s, d));
    }
    if (LI_ACTIONS[d.action]) {
      var liWhy = keyProblem(e, 'LINKEDIN_TOKEN');
      if (liWhy) return json({ ok: false, error: liWhy });
      if (d.action === 'li_upsert') return json(liUpsert(d));
      if (d.action === 'li_list') return json(liList(d));
      if (d.action === 'li_log') return json(liLog(d));
      return json(liToday());
    }
    if (FBO_ACTIONS[d.action] || PROS_ACTIONS[d.action]) {
      // Accessible à n8n (ADMIN_TOKEN) comme à Claude (LINKEDIN_TOKEN).
      var fboWhy = keyProblem(e, 'LINKEDIN_TOKEN');
      if (fboWhy && keyProblem(e, 'ADMIN_TOKEN')) return json({ ok: false, error: fboWhy });
      if (d.action === 'fbo_upsert') return json(fboUpsert(d));
      if (d.action === 'fbo_list') return json(fboList(d));
      if (d.action === 'pros_next') return json(prosNext(d));
      if (d.action === 'pros_mark') return json(prosMark(d));
      return json(prosFind(d));
    }
    if (d.token !== TOKEN) return json({ ok: false, error: 'token' });
    if (d.action === 'conf') return json(confCreate(d));
    var sheet = leadsSheet();
    if (d.action === 'create') return json(createOrUpdate(sheet, d));
    if (d.action === 'whatsapp') return json(markWhatsapp(sheet, d));
    return json({ ok: false, error: 'action' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function createOrUpdate(sheet, d) {
  var leadId = clean(d.lead_id, 40);
  var phone = clean(d.phone_e164, 16);
  var sessionDate = clean(d.session_date, 10);
  if (!/^SX-[A-Za-z0-9-]{6,36}$/.test(leadId)) return { ok: false, error: 'lead_id' };
  if (!/^\+243\d{9}$/.test(phone)) return { ok: false, error: 'phone' };
  if (!clean(d.prenom, 60)) return { ok: false, error: 'prenom' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) return { ok: false, error: 'session_date' };

  var now = stamp();
  // Même personne, même date : on met à jour la ligne existante au lieu d'en créer une nouvelle.
  var row = findRow(sheet, 'lead_id', leadId) || findRow(sheet, 'phone_e164', phone, 'session_date', sessionDate);
  var values = {
    updated_at: now,
    prenom: safe(clean(d.prenom, 60)),
    nom: safe(clean(d.nom, 60)),
    phone_e164: safe(phone),
    session_date: sessionDate,
    session_label: safe(clean(d.session_label, 60)),
    consent_rappel: d.consent_rappel ? 'oui' : 'non',
    utm_source: safe(clean(d.utm_source, 100)),
    utm_medium: safe(clean(d.utm_medium, 100)),
    utm_campaign: safe(clean(d.utm_campaign, 150)),
    utm_content: safe(clean(d.utm_content, 150)),
    utm_term: safe(clean(d.utm_term, 150)),
    fbclid: safe(clean(d.fbclid, 300)),
    fbp: safe(clean(d.fbp, 100)),
    fbc: safe(clean(d.fbc, 400)),
    page_url: safe(clean(d.page_url, 300)),
    user_agent: safe(clean(d.user_agent, 300))
  };

  if (row) {
    var current = readRow(sheet, row);
    // Ne jamais faire reculer un statut déjà avancé à la main.
    if (!current.statut) values.statut = STATUT_COORDONNEES;
    writeRow(sheet, row, values);
    return { ok: true, updated: true, row: row };
  }

  values.lead_id = leadId;
  values.created_at = now;
  values.whatsapp_envoye = 'non';
  values.statut = STATUT_COORDONNEES;
  var line = LEAD_HEADERS.map(function (h) { return values[h] !== undefined ? values[h] : ''; });
  sheet.appendRow(line);
  return { ok: true, created: true };
}

function markWhatsapp(sheet, d) {
  var leadId = clean(d.lead_id, 40);
  var row = findRow(sheet, 'lead_id', leadId);
  if (!row) return { ok: false, error: 'not_found' };
  var current = readRow(sheet, row);
  var values = { whatsapp_envoye: 'oui', whatsapp_at: stamp(), updated_at: stamp() };
  if (!current.statut || current.statut === STATUT_COORDONNEES) values.statut = STATUT_WHATSAPP;
  writeRow(sheet, row, values);
  return { ok: true };
}

/* ---------- Actions n8n ---------- */

// Renvoie '' si la clé est bonne, sinon la raison du refus (sans jamais révéler la clé).
function adminProblem(e) { return keyProblem(e, 'ADMIN_TOKEN'); }

function keyProblem(e, prop) {
  var expected = String(PropertiesService.getScriptProperties().getProperty(prop) || '').trim();
  var given = String((e && e.parameter && e.parameter.key) || '').trim();
  if (!expected) return 'admin: propriété ' + prop + ' absente du script';
  if (expected.length < 24) return 'admin: ' + prop + ' trop court (' + expected.length + ' caractères)';
  if (!given) return 'admin: aucune clé reçue (paramètre key)';
  if (given !== expected) return 'admin: clé différente (reçue ' + given.length + ' caractères, attendue ' + expected.length + ')';
  return '';
}

/* ---------- Prospection LinkedIn ---------- */

function liSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  ensureHeaders(sheet, headers);
  return sheet;
}

function liUrl(v) {
  var m = String(v || '').match(/linkedin\.com\/in\/([^\/?#\s]+)/i);
  return m ? 'https://www.linkedin.com/in/' + decodeURIComponent(m[1]).toLowerCase() + '/' : '';
}

// Crée ou met à jour une fiche, repérée par l'URL du profil. Un champ vide n'efface rien.
function liUpsert(d) {
  var url = liUrl(d.url_profil);
  if (!url) return { ok: false, error: 'url_profil' };
  var sheet = liSheet(LI, LI_HEADERS);
  var c = LI_HEADERS.indexOf('url_profil');
  var row = 0;
  var last = sheet.getLastRow();
  if (last >= 2) {
    var urls = sheet.getRange(2, c + 1, last - 1, 1).getDisplayValues();
    for (var i = 0; i < urls.length; i++) if (urls[i][0] === url) { row = i + 2; break; }
  }
  var now = stamp();
  var v = { mis_a_jour: now };
  LI_FIELDS.forEach(function (h) {
    var x = clean(d[h], h === 'dernier_message' ? 500 : 200);
    if (x) v[h] = safe(x);
  });
  if (d.note) {
    var old = row ? sheet.getRange(row, LI_HEADERS.indexOf('notes') + 1).getDisplayValue() : '';
    v.notes = safe(((old ? old + ' | ' : '') + now.slice(0, 16) + ' ' + clean(d.note, 300)).slice(-1500));
  }
  if (!row) {
    v.date_ajout = now.slice(0, 10);
    v.url_profil = url;
    if (!v.statut) v.statut = 'À inviter';
    sheet.appendRow(LI_HEADERS.map(function (h) { return v[h] !== undefined ? v[h] : ''; }));
    return { ok: true, created: true, row: sheet.getLastRow() };
  }
  Object.keys(v).forEach(function (h) { sheet.getRange(row, LI_HEADERS.indexOf(h) + 1).setValue(v[h]); });
  return { ok: true, updated: true, row: row };
}

// Liste les fiches, éventuellement filtrées par statut.
function liList(d) {
  var sheet = liSheet(LI, LI_HEADERS);
  var last = sheet.getLastRow();
  if (last < 2) return { ok: true, fiches: [] };
  var data = sheet.getRange(2, 1, last - 1, LI_HEADERS.length).getDisplayValues();
  var fiches = data.map(function (r, i) {
    var o = { row: i + 2 };
    LI_HEADERS.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
  if (d.statut) fiches = fiches.filter(function (o) { return o.statut === d.statut; });
  return { ok: true, fiches: fiches };
}

// Note une action LinkedIn (profil consulté, recherche, invitation, message) dans le journal.
function liLog(d) {
  if (!LI_JOURNAL_TYPES[d.type]) return { ok: false, error: 'type' };
  var n = Math.min(Math.max(parseInt(d.nombre, 10) || 1, 1), 50);
  var sheet = liSheet(LI_JOURNAL, LI_JOURNAL_HEADERS);
  var now = stamp();
  var url = liUrl(d.url_profil);
  for (var i = 0; i < n; i++) sheet.appendRow([now, d.type, url, safe(clean(d.detail, 200))]);
  return liToday();
}

// Compte les actions du jour et des 7 derniers jours.
function liToday() {
  var sheet = liSheet(LI_JOURNAL, LI_JOURNAL_HEADERS);
  var today = stamp().slice(0, 10);
  var weekAgo = Utilities.formatDate(new Date(Date.now() - 6 * 86400000), TZ, 'yyyy-MM-dd');
  var jour = { profil: 0, recherche: 0, invitation: 0, message: 0 };
  var semaine = { profil: 0, recherche: 0, invitation: 0, message: 0 };
  var last = sheet.getLastRow();
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 2).getDisplayValues().forEach(function (r) {
      var day = String(r[0]).slice(0, 10);
      if (!(r[1] in jour)) return;
      if (day === today) jour[r[1]]++;
      if (day >= weekAgo) semaine[r[1]]++;
    });
  }
  return { ok: true, date: today, jour: jour, semaine_7j: semaine };
}

/* ---------- Liste des FBO ---------- */

// Crée ou met à jour un FBO, repéré par son matricule (12 chiffres) ou, à défaut, par son téléphone.
// Le matricule peut être ajouté plus tard : la ligne est alors retrouvée par le téléphone. Un champ vide n'efface rien.
function fboUpsert(d) {
  var mat = String(d.matricule || '').replace(/\D/g, '');
  if (mat && !/^\d{12}$/.test(mat)) return { ok: false, error: 'matricule' };
  var tel = String(d.telephone || '').replace(/\D/g, '');
  if (tel && !/^\d{9,15}$/.test(tel)) return { ok: false, error: 'telephone' };
  if (!mat && !tel) return { ok: false, error: 'matricule ou telephone requis' };
  if (tel) d.telephone = '+' + tel;
  if (d.statut && FBO_STATUTS.indexOf(d.statut) < 0) return { ok: false, error: 'statut', valeurs: FBO_STATUTS };
  var sheet = liSheet(FBO, FBO_HEADERS);
  sheet.getRange('A:A').setNumberFormat('@'); // garde le matricule en texte (pas de 2,43E+11)
  // Liste déroulante des statuts sur la colonne « statut ».
  sheet.getRange(2, FBO_HEADERS.indexOf('statut') + 1, sheet.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(FBO_STATUTS, true).setAllowInvalid(false).build());
  var row = 0;
  var last = sheet.getLastRow();
  if (last >= 2) {
    var cols = sheet.getRange(2, 1, last - 1, 3).getDisplayValues(); // matricule, nom, telephone
    for (var i = 0; i < cols.length && !row; i++) {
      if (mat && String(cols[i][0]).replace(/\D/g, '') === mat) row = i + 2;
    }
    for (var k = 0; k < cols.length && !row; k++) {
      if (tel && String(cols[k][2]).replace(/\D/g, '') === tel) row = k + 2;
    }
  }
  var now = stamp();
  var v = { mis_a_jour: now };
  if (mat) v.matricule = mat;
  FBO_FIELDS.forEach(function (h) {
    var x = clean(d[h], 200);
    if (x) v[h] = safe(x);
  });
  if (d.note) {
    var old = row ? sheet.getRange(row, FBO_HEADERS.indexOf('notes') + 1).getDisplayValue() : '';
    v.notes = safe(((old ? old + ' | ' : '') + now.slice(0, 16) + ' ' + clean(d.note, 300)).slice(-1500));
  }
  if (!row) {
    if (!v.statut) v.statut = FBO_STATUTS[0];
    sheet.appendRow(FBO_HEADERS.map(function (h) { return v[h] !== undefined ? v[h] : ''; }));
    return { ok: true, created: true, row: sheet.getLastRow() };
  }
  Object.keys(v).forEach(function (h) { sheet.getRange(row, FBO_HEADERS.indexOf(h) + 1).setValue(v[h]); });
  return { ok: true, updated: true, row: row };
}

function fboList(d) {
  var sheet = liSheet(FBO, FBO_HEADERS);
  var last = sheet.getLastRow();
  if (last < 2) return { ok: true, fbo: [] };
  var data = sheet.getRange(2, 1, last - 1, FBO_HEADERS.length).getDisplayValues();
  var out = data.map(function (r, i) {
    var o = { row: i + 2 };
    FBO_HEADERS.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
  if (d.statut) out = out.filter(function (o) { return o.statut === d.statut; });
  return { ok: true, fbo: out };
}

/* ---------- Prospection directe de la base ---------- */

function prosSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONTACTS);
  if (!sheet) throw new Error('onglet « ' + CONTACTS + ' » introuvable');
  var head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  PROS_COLS.forEach(function (c) {
    if (head.indexOf(c) < 0) {
      sheet.getRange(1, head.length + 1).setValue(c).setFontWeight('bold');
      head.push(c);
    }
  });
  return { sheet: sheet, head: head };
}

function prosRows(p) {
  var last = p.sheet.getLastRow();
  if (last < 2) return [];
  return p.sheet.getRange(2, 1, last - 1, p.head.length).getDisplayValues().map(function (r, i) {
    var o = { row: i + 2 };
    p.head.forEach(function (h, j) { o[h] = r[j]; });
    o.digits = String(o.numero || '').replace(/\D/g, '');
    return o;
  });
}

// Priorité : anciens CP et qualifiés, puis maturité élevée, moyenne, puis inscrits du site, puis le reste.
function prosRank(o) {
  var st = String(o.ancien_statut || '').toLowerCase();
  var mat = String(o.ancien_maturite || '').toLowerCase();
  if (/client privil|qualifi/.test(st)) return 0;
  if (mat === 'élevée') return 1;
  if (mat === 'moyenne') return 2;
  if (o.site_nb_inscriptions) return 3;
  return 4;
}

// Renvoie les prochains contacts à écrire et les compteurs du jour (pour le plafond et l'arrêt automatique).
function prosNext(d) {
  var p = prosSheet();
  var rows = prosRows(p);
  var today = stamp().slice(0, 10);
  var fbo = {};
  var fs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FBO);
  if (fs && fs.getLastRow() >= 2) {
    fs.getRange(2, 3, fs.getLastRow() - 1, 1).getDisplayValues().forEach(function (r) { fbo[String(r[0]).replace(/\D/g, '')] = true; });
  }
  var c = { envoyes: 0, echecs: 0, stops: 0, reponses: 0 };
  rows.forEach(function (o) {
    if (String(o.pros_envoi).slice(0, 10) === today) {
      if (o.pros_statut === 'Échec') c.echecs++; else c.envoyes++;
    }
    if (o.pros_statut === 'STOP' && String(o.pros_reponse).slice(0, 10) === today) c.stops++;
    if (String(o.pros_reponse).slice(0, 10) === today) c.reponses++;
  });
  var todo = rows.filter(function (o) {
    return /^243\d{9}$/.test(o.digits) && String(o.numero_valide).toLowerCase() !== 'non'
      && !o.pros_statut && !o.pros_envoi && !fbo[o.digits];
  });
  todo.sort(function (a, b) { return prosRank(a) - prosRank(b) || a.row - b.row; });
  var n = Math.min(Math.max(parseInt(d.nombre, 10) || 1, 1), 20);
  return {
    ok: true, date: today, aujourdhui: c, restants: todo.length,
    contacts: todo.slice(0, n).map(function (o) {
      return { row: o.row, numero: o.digits, nom: o.nom, rang: prosRank(o), ancien_besoin: o.ancien_besoin, ancien_dernier_message: o.ancien_dernier_message };
    })
  };
}

// Met à jour la prospection d'un contact (repéré par son numéro). "NOW" = date et heure de Kinshasa.
function prosMark(d) {
  var digits = String(d.numero || '').replace(/\D/g, '');
  if (!/^\d{9,15}$/.test(digits)) return { ok: false, error: 'numero' };
  var p = prosSheet();
  var rows = prosRows(p);
  var o = null;
  for (var i = 0; i < rows.length; i++) if (rows[i].digits === digits) { o = rows[i]; break; }
  if (!o) return { ok: true, found: false };
  var set = d.set || {};
  PROS_COLS.forEach(function (h) {
    if (set[h] === undefined) return;
    // Une réponse déjà notée n'est jamais écrasée (on garde la première).
    if (h === 'pros_reponse' && o.pros_reponse) return;
    var v = set[h] === 'NOW' ? stamp() : safe(clean(set[h], 200));
    p.sheet.getRange(o.row, p.head.indexOf(h) + 1).setValue(v);
  });
  return { ok: true, found: true, row: o.row };
}

// Retrouve un contact de la base par son numéro.
function prosFind(d) {
  var digits = String(d.numero || '').replace(/\D/g, '');
  var p = prosSheet();
  var rows = prosRows(p);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].digits === digits) {
      var o = rows[i];
      return { ok: true, contact: { row: o.row, numero: o.digits, nom: o.nom, pros_statut: o.pros_statut, pros_envoi: o.pros_envoi,
        ancien_statut: o.ancien_statut, ancien_besoin: o.ancien_besoin, ancien_objectif: o.ancien_objectif, ancien_dernier_message: o.ancien_dernier_message } };
    }
  }
  return { ok: true, contact: null };
}

function allLeads(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var range = sheet.getRange(2, 1, last - 1, LEAD_HEADERS.length);
  var shown = range.getDisplayValues();
  var raw = range.getValues();
  var dc = col('session_date') - 1;
  return shown.map(function (r, i) {
    var o = { row: i + 2 };
    LEAD_HEADERS.forEach(function (h, j) { o[h] = r[j]; });
    // Sheets peut convertir la date en objet Date : on la remet au format AAAA-MM-JJ.
    var sd = raw[i][dc];
    if (sd instanceof Date) o.session_date = Utilities.formatDate(sd, TZ, 'yyyy-MM-dd');
    return o;
  });
}

function pick(o) {
  return {
    lead_id: o.lead_id, created_at: o.created_at, prenom: o.prenom, phone_e164: o.phone_e164,
    session_date: o.session_date, consent_rappel: o.consent_rappel, statut: o.statut,
    envoi_confirmation: o.envoi_confirmation, envoi_veille: o.envoi_veille,
    envoi_matin: o.envoi_matin, envoi_suivi: o.envoi_suivi
  };
}

// Inscrits dont la session est aujourd'hui ou plus tard (plus la veille, pour le suivi).
function listLeads(sheet, d) {
  var since = /^\d{4}-\d{2}-\d{2}$/.test(d.since || '') ? d.since
    : Utilities.formatDate(new Date(Date.now() - 86400000), TZ, 'yyyy-MM-dd');
  var leads = allLeads(sheet).filter(function (o) {
    return /^SX-/.test(o.lead_id) && o.session_date >= since;
  }).map(pick);
  return { ok: true, today: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), leads: leads };
}

// Retrouve l'inscrit qui répond sur WhatsApp : la prochaine session à venir, sinon la plus récente.
function findByPhone(sheet, d) {
  var digits = String(d.phone || '').replace(/\D/g, '');
  if (!/^243\d{9}$/.test(digits)) return { ok: true, lead: null };
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var mine = allLeads(sheet).filter(function (o) { return o.phone_e164 === '+' + digits; });
  if (!mine.length) return { ok: true, lead: null };
  var upcoming = mine.filter(function (o) { return o.session_date >= today; })
    .sort(function (a, b) { return a.session_date < b.session_date ? -1 : 1; });
  var lead = upcoming[0] || mine[mine.length - 1];
  return { ok: true, today: today, lead: pick(lead) };
}

// Met à jour un inscrit : colonnes autorisées, note et historique des échanges.
// La valeur "NOW" est remplacée par la date et l'heure de Kinshasa.
function markLead(sheet, d) {
  var row = findRow(sheet, 'lead_id', clean(d.lead_id, 40));
  if (!row) return { ok: false, error: 'not_found' };
  var set = d.set || {};
  var values = { updated_at: stamp() };
  MARKABLE.forEach(function (h) {
    if (set[h] === undefined) return;
    var v = set[h] === 'NOW' ? stamp() : safe(clean(set[h], 100));
    if (h === 'session_date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    values[h] = v;
  });
  if (d.note) {
    var current = readRow(sheet, row).notes;
    values.notes = safe(((current ? current + ' | ' : '') + stamp().slice(0, 16) + ' ' + clean(d.note, 300)).slice(-1500));
  }
  writeRow(sheet, row, values);
  if (d.interaction) {
    var inter = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(INTERACTIONS);
    inter.appendRow([clean(d.lead_id, 40), stamp(), clean(d.interaction.canal, 30),
      safe(clean(d.interaction.message, 500)), safe(clean(d.interaction.resultat, 100)), 'n8n']);
  }
  return { ok: true };
}

// Lit la fiche d'un prospect. Sert à n8n pour savoir si l'agent doit se taire :
// quand « passer_la_main » vaut « oui », c'est l'équipe qui répond. Remettre « non » rend la main à l'agent.
function getQualif(d) {
  var digits = String(d.numero || '').replace(/\D/g, '');
  if (!/^243\d{9}$/.test(digits)) return { ok: false, error: 'numero' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(QUALIF);
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, fiche: null };
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, QUALIF_HEADERS.length).getDisplayValues();
  for (var i = data.length - 1; i >= 0; i--) {
    if (String(data[i][0]).replace(/^'/, '') === '+' + digits) {
      var fiche = {};
      QUALIF_HEADERS.forEach(function (h, j) { fiche[h] = data[i][j]; });
      fiche.agent_en_pause = String(fiche.passer_la_main).trim().toLowerCase() === 'oui';
      return { ok: true, fiche: fiche };
    }
  }
  return { ok: true, fiche: null };
}

// Crée ou met à jour la fiche d'un prospect dans l'onglet « qualification ».
// Une information vide ou « inconnu » n'efface jamais ce qui est déjà noté,
// et l'étape ne recule jamais.
function upsertQualif(d) {
  var digits = String(d.numero || '').replace(/\D/g, '');
  if (!/^243\d{9}$/.test(digits)) return { ok: false, error: 'numero' };
  var numero = '+' + digits;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(QUALIF) || ss.insertSheet(QUALIF);
  ensureHeaders(sheet, QUALIF_HEADERS);

  var row = 0;
  var cur = {};
  var last = sheet.getLastRow();
  if (last >= 2) {
    var data = sheet.getRange(2, 1, last - 1, QUALIF_HEADERS.length).getDisplayValues();
    for (var i = data.length - 1; i >= 0; i--) {
      if (String(data[i][0]).replace(/^'/, '') === numero) {
        row = i + 2;
        QUALIF_HEADERS.forEach(function (h, j) { cur[h] = data[i][j]; });
        break;
      }
    }
  }

  var now = stamp();
  var v = { numero: safe(numero), dernier_contact: now, nb_messages: (parseInt(cur.nb_messages, 10) || 0) + 1 };
  QUALIF_FIELDS.forEach(function (h) {
    var x = clean(d[h], 200);
    if (x && !/^(inconnu|inconnue|aucun|aucune|vide|unknown|non précisé)$/i.test(x)) v[h] = safe(x);
  });
  var etape = parseInt(d.etape, 10);
  if (etape >= 1 && etape <= 7 && etape >= (parseInt(cur.etape, 10) || 0)) v.etape = etape;
  v.passer_la_main = d.passer_la_main === true ? 'oui' : (cur.passer_la_main || 'non');
  if (QUALIF_AUTO_STATUTS[cur.statut || '']) {
    v.statut = (v.date_rencontre || cur.date_rencontre) ? 'Rendez-vous pris' : 'En conversation';
  }
  v.dernier_message = safe(clean(d.dernier_message, 500));
  v.derniere_reponse = safe(clean(d.derniere_reponse, 1000));

  if (!row) {
    v.premier_contact = now;
    sheet.appendRow(QUALIF_HEADERS.map(function (h) { return v[h] !== undefined ? v[h] : ''; }));
    return { ok: true, created: true };
  }
  Object.keys(v).forEach(function (h) {
    var c = QUALIF_HEADERS.indexOf(h) + 1;
    if (c > 0) sheet.getRange(row, c).setValue(v[h]);
  });
  return { ok: true, updated: true };
}

/* ---------- Conférences payantes (page /conference) ---------- */

// Une ligne par inscription, dans l'onglet « conference ». Aucun message WhatsApp :
// l'équipe appelle chaque inscrit la veille pour confirmer (colonnes appel_* et statut à la main).
var CONF = 'conference';
var CONF_HEADERS = [
  'inscription_id', 'created_at', 'updated_at', 'evenement', 'date_evenement',
  'prenom', 'nom', 'telephone', 'email', 'profession', 'places',
  'statut', 'appel_date', 'appel_resultat', 'present', 'paye',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'page_url', 'user_agent', 'responsable', 'notes'
];

function confCreate(d) {
  var id = clean(d.inscription_id, 40);
  var phone = clean(d.telephone, 16);
  var email = clean(d.email, 120).toLowerCase();
  var places = parseInt(d.places, 10);
  if (!/^CF-[A-Za-z0-9-]{6,36}$/.test(id)) return { ok: false, error: 'inscription_id' };
  if (!/^\+243\d{9}$/.test(phone)) return { ok: false, error: 'telephone' };
  if (!clean(d.prenom, 60)) return { ok: false, error: 'prenom' };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'email' };
  if (!(places >= 1 && places <= 4)) places = 1;

  var sheet = liSheet(CONF, CONF_HEADERS);
  var evt = safe(clean(d.evenement, 80));
  var now = stamp();
  var v = {
    updated_at: now, evenement: evt, date_evenement: clean(d.date_evenement, 10),
    prenom: safe(clean(d.prenom, 60)), nom: safe(clean(d.nom, 60)), telephone: safe(phone),
    email: safe(email), profession: safe(clean(d.profession, 120)), places: places,
    utm_source: safe(clean(d.utm_source, 100)), utm_medium: safe(clean(d.utm_medium, 100)),
    utm_campaign: safe(clean(d.utm_campaign, 150)), utm_content: safe(clean(d.utm_content, 150)),
    utm_term: safe(clean(d.utm_term, 150)), page_url: safe(clean(d.page_url, 300)),
    user_agent: safe(clean(d.user_agent, 300))
  };

  // Même numéro pour le même événement : on met à jour au lieu de créer un doublon.
  var row = 0, last = sheet.getLastRow();
  if (last > 1) {
    var data = sheet.getRange(2, 1, last - 1, CONF_HEADERS.length).getDisplayValues();
    var ci = CONF_HEADERS.indexOf('inscription_id'), ct = CONF_HEADERS.indexOf('telephone'), ce = CONF_HEADERS.indexOf('evenement');
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i][ci] === id || (data[i][ct] === phone && data[i][ce] === evt)) { row = i + 2; break; }
    }
  }
  if (row) {
    Object.keys(v).forEach(function (h) { sheet.getRange(row, CONF_HEADERS.indexOf(h) + 1).setValue(v[h]); });
    return { ok: true, updated: true };
  }
  v.inscription_id = id;
  v.created_at = now;
  v.statut = 'Inscrit';
  sheet.appendRow(CONF_HEADERS.map(function (h) { return v[h] !== undefined ? v[h] : ''; }));
  return { ok: true, created: true };
}

/* ---------- Outils ---------- */

function leadsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LEADS);
  if (!sheet) {
    sheet = ss.getSheets()[0];
    if (sheet.getLastRow() > 1) sheet = ss.insertSheet(LEADS);
    else sheet.setName(LEADS);
  }
  ensureHeaders(sheet, LEAD_HEADERS);
  var inter = ss.getSheetByName(INTERACTIONS) || ss.insertSheet(INTERACTIONS);
  ensureHeaders(inter, INTERACTION_HEADERS);
  return sheet;
}

function ensureHeaders(sheet, headers) {
  var first = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (first.join('|') !== headers.join('|')) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
}

function col(name) { return LEAD_HEADERS.indexOf(name) + 1; }

function findRow(sheet, name, value, name2, value2) {
  var last = sheet.getLastRow();
  if (last < 2 || !value) return 0;
  var data = sheet.getRange(2, 1, last - 1, LEAD_HEADERS.length).getDisplayValues();
  var a = col(name) - 1, b = name2 ? col(name2) - 1 : -1;
  for (var i = data.length - 1; i >= 0; i--) {
    if (String(data[i][a]) === String(value) && (b < 0 || String(data[i][b]) === String(value2))) return i + 2;
  }
  return 0;
}

function readRow(sheet, row) {
  var vals = sheet.getRange(row, 1, 1, LEAD_HEADERS.length).getDisplayValues()[0];
  var o = {};
  LEAD_HEADERS.forEach(function (h, i) { o[h] = vals[i]; });
  return o;
}

function writeRow(sheet, row, values) {
  Object.keys(values).forEach(function (h) {
    var c = col(h);
    if (c > 0) sheet.getRange(row, c).setValue(values[h]);
  });
}

function clean(v, max) { return String(v === undefined || v === null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max); }

// Empêche une valeur d'être interprétée comme une formule (et garde le + des numéros).
function safe(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; }

function stamp() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
