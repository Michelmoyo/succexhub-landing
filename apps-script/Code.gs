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
  'responsable', 'prochaine_action', 'notes'
];
var INTERACTION_HEADERS = ['lead_id', 'date', 'canal', 'message', 'resultat', 'responsable'];

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
    if (d.token !== TOKEN) return json({ ok: false, error: 'token' });
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
