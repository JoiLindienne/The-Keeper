require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { createCanvas, loadImage, registerFont } = require("canvas");

const FONT_FAMILY = "Nunito";
const FONT_FALLBACK = "Nunito, Arial, sans-serif";

function registerFontIfExists(relativePath, options) {
  const fontPath = path.join(__dirname, relativePath);

  if (!fs.existsSync(fontPath)) return false;

  registerFont(fontPath, options);
  return true;
}

try {
  const boldLoaded =
    registerFontIfExists(path.join("fonts", "Nunito-Bold.ttf"), {
      family: FONT_FAMILY,
      weight: "700",
    }) ||
    registerFontIfExists(path.join("fonts", "Nunito-VariableFont_wght.ttf"), {
      family: FONT_FAMILY,
      weight: "700",
    }) ||
    registerFontIfExists(path.join("fonts:", "Nunito-VariableFont_wght.ttf"), {
      family: FONT_FAMILY,
      weight: "700",
    });

  const extraBoldLoaded =
    registerFontIfExists(path.join("fonts", "Nunito-ExtraBold.ttf"), {
      family: FONT_FAMILY,
      weight: "800",
    }) ||
    registerFontIfExists(path.join("fonts", "Nunito-VariableFont_wght.ttf"), {
      family: FONT_FAMILY,
      weight: "800",
    }) ||
    registerFontIfExists(path.join("fonts:", "Nunito-VariableFont_wght.ttf"), {
      family: FONT_FAMILY,
      weight: "800",
    });

  if (boldLoaded && extraBoldLoaded) {
    console.log("✅ Police Nunito chargée.");
  } else {
    console.warn("⚠️ Police Nunito introuvable ou incomplète. Police système utilisée à la place.");
  }
} catch (err) {
  console.warn("⚠️ Impossible de charger Nunito. Police système utilisée à la place.");
}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const OWNER_IDS = String(process.env.OWNER_ID || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);

if (!TOKEN || !CLIENT_ID || !GUILD_ID || OWNER_IDS.length === 0) {
  console.error("❌ Variables .env manquantes. Vérifie DISCORD_TOKEN, CLIENT_ID, GUILD_ID et OWNER_ID.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.on("error", (err) => console.error("Client error:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

const DATA_FILE = path.join(__dirname, "data", "family.json");
const REQUESTS_FILE = path.join(__dirname, "data", "pending_requests.json");
const OUTPUT_FILE = path.join(__dirname, "output", "tree.png");
const BACKUP_DIR = path.join(__dirname, "data", "backups");
const BLACKLIST_FILE = path.join(__dirname, "blacklist.txt");
const WHITELIST_FILE = path.join(__dirname, "whitelist.txt");
const LIER_COOLDOWN = 10 * 60 * 1000; // 10 minutes
const MAX_BACKUPS = 30;
const lierCooldowns = new Map();

if (!fs.existsSync(path.join(__dirname, "data"))) fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
if (!fs.existsSync(path.join(__dirname, "output"))) fs.mkdirSync(path.join(__dirname, "output"), { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function writeJsonIfMissing(file, initialData) {
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, JSON.stringify(initialData, null, 2));
}

writeJsonIfMissing(DATA_FILE, { nodes: {} });
writeJsonIfMissing(REQUESTS_FILE, { requests: {} });
if (!fs.existsSync(BLACKLIST_FILE)) fs.writeFileSync(BLACKLIST_FILE, "PERSONNES_BLACKLIST=");
if (!fs.existsSync(WHITELIST_FILE)) fs.writeFileSync(WHITELIST_FILE, "PERSONNES_WHITELIST=");

const commands = [
  new SlashCommandBuilder()
    .setName("lier")
    .setDescription("Demander ou créer un lien dans l’arbre")
    .addUserOption(o =>
      o.setName("qui")
        .setDescription("La personne à lier")
        .setRequired(true)
    )
    .addUserOption(o =>
      o.setName("avec")
        .setDescription("La personne de référence")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("lien")
        .setDescription("Lien de QUI par rapport à AVEC")
        .setRequired(true)
        .addChoices(
          { name: "Enfant", value: "enfant" },
          { name: "Parent", value: "parent" },
          { name: "Frère / Sœur", value: "frere_soeur" },
          { name: "Cousin / Cousine", value: "cousin_cousine" },
          { name: "Mari / Fiancée", value: "mari_fiancee" },
        )
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("arbre")
    .setDescription("Afficher l’arbre")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("backup")
    .setDescription("Restaurer une ancienne version de l’arbre")
    .addIntegerOption(o =>
      o.setName("retour")
        .setDescription("Nombre de changements à annuler")
        .setRequired(true)
        .addChoices(
          { name: "3 changements", value: 3 },
          { name: "5 changements", value: 5 },
          { name: "10 changements", value: 10 },
        )
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("Ajouter ou retirer quelqu’un de la blacklist")
    .addUserOption(o =>
      o.setName("membre")
        .setDescription("Le membre concerné")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("action")
        .setDescription("Action à effectuer")
        .setRequired(true)
        .addChoices(
          { name: "Ajouter", value: "add" },
          { name: "Retirer", value: "remove" },
        )
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("whitelist")
    .setDescription("Ajouter ou retirer quelqu’un de la whitelist cooldown")
    .addUserOption(o =>
      o.setName("membre")
        .setDescription("Le membre concerné")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("action")
        .setDescription("Action à effectuer")
        .setRequired(true)
        .addChoices(
          { name: "Ajouter", value: "add" },
          { name: "Retirer", value: "remove" },
        )
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Réinitialiser complètement l’arbre")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("supprimer")
    .setDescription("Supprimer quelqu’un ou nettoyer les places libres seules")
    .addStringOption(o =>
      o.setName("mode")
        .setDescription("Ce que tu veux supprimer")
        .setRequired(true)
        .addChoices(
          { name: "Une personne", value: "personne" },
          { name: "Places libres seules", value: "libres_seules" },
        )
    )
    .addUserOption(o =>
      o.setName("qui")
        .setDescription("La personne à supprimer")
        .setRequired(false)
    )
    .toJSON(),
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmpFile = `${file}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, file);
}

function getBackupFiles() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  return fs.readdirSync(BACKUP_DIR)
    .filter(file => file.endsWith(".json"))
    .sort((a, b) => b.localeCompare(a));
}

function createFamilyBackup(reason = "change") {
  if (!fs.existsSync(DATA_FILE)) return false;

  const currentData = readJson(DATA_FILE, null);
  const nodeCount = currentData?.nodes && typeof currentData.nodes === "object"
    ? Object.keys(currentData.nodes).length
    : 0;

  // Sécurité : on ne sauvegarde jamais un arbre vide ou cassé,
  // sinon une mauvaise sauvegarde pourrait écraser les vraies backups.
  if (!currentData || !currentData.nodes || nodeCount === 0) return false;

  const safeReason = String(reason)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .slice(0, 40) || "change";

  const backupFile = path.join(BACKUP_DIR, `${Date.now()}_${safeReason}.json`);
  fs.copyFileSync(DATA_FILE, backupFile);

  const backups = getBackupFiles();
  for (const oldBackup of backups.slice(MAX_BACKUPS)) {
    fs.unlinkSync(path.join(BACKUP_DIR, oldBackup));
  }

  return true;
}

function restoreFamilyBackup(stepsBack) {
  const backups = getBackupFiles();

  if (backups.length < stepsBack) {
    throw new Error(`Backup impossible : seulement ${backups.length} sauvegarde(s) disponible(s).`);
  }

  createFamilyBackup("before_restore");

  const backupToRestore = path.join(BACKUP_DIR, backups[stepsBack - 1]);
  const restoredData = readJson(backupToRestore, { nodes: {} });
  cleanupFamily(restoredData);
  writeJson(DATA_FILE, restoredData);

  return restoredData;
}

function restoreLatestBackupIfFamilyIsEmpty() {
  const currentData = readJson(DATA_FILE, { nodes: {} });
  const currentNodeCount = currentData?.nodes && typeof currentData.nodes === "object"
    ? Object.keys(currentData.nodes).length
    : 0;

  if (currentNodeCount > 0) return false;

  const backups = getBackupFiles();
  if (backups.length === 0) return false;

  for (const backup of backups) {
    const backupPath = path.join(BACKUP_DIR, backup);
    const backupData = readJson(backupPath, null);
    const backupNodeCount = backupData?.nodes && typeof backupData.nodes === "object"
      ? Object.keys(backupData.nodes).length
      : 0;

    if (backupData && backupData.nodes && backupNodeCount > 0) {
      cleanupFamily(backupData);
      writeJson(DATA_FILE, backupData);
      console.warn(`🛡️ Arbre restauré automatiquement depuis la backup : ${backup}`);
      return true;
    }
  }

  return false;
}

function loadFamily() {
  restoreLatestBackupIfFamilyIsEmpty();

  const data = readJson(DATA_FILE, { nodes: {} });
  cleanupFamily(data);
  return data;
}

function saveFamily(data) {
  cleanupFamily(data);
  writeJson(DATA_FILE, data);
}

function loadRequests() {
  return readJson(REQUESTS_FILE, { requests: {} });
}

function saveRequests(data) {
  writeJson(REQUESTS_FILE, data);
}

function removeLonelyLibreNodes(data) {
  let removed = 0;
  let changed = true;

  while (changed) {
    changed = false;

    for (const [id, node] of Object.entries(data.nodes)) {
      if (!isLibre(id)) continue;

      const hasChildren = Object.values(data.nodes).some(otherNode => otherNode.parent === id);
      const hasSpouse = Boolean(node.spouse && data.nodes[node.spouse]);

      if (!hasChildren && !hasSpouse) {
        delete data.nodes[id];
        removed++;
        changed = true;
      }
    }
  }

  cleanupFamily(data);
  return removed;
}

function isOwner(id) {
  return OWNER_IDS.includes(String(id));
}

function readIdList(file, key) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${key}=`);

  const txt = fs.readFileSync(file, "utf8");
  const line = txt.split("\n").find(l => l.startsWith(`${key}=`)) || "";

  return line
    .replace(`${key}=`, "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function writeIdList(file, key, ids) {
  const uniqueIds = Array.from(new Set(ids.map(id => String(id).trim()).filter(Boolean)));
  fs.writeFileSync(file, `${key}=${uniqueIds.join(",")}`);
}

function updateIdList(file, key, id, action) {
  const ids = readIdList(file, key);
  const cleanId = String(id).trim();

  if (action === "add" && !ids.includes(cleanId)) ids.push(cleanId);
  if (action === "remove") {
    const index = ids.indexOf(cleanId);
    if (index !== -1) ids.splice(index, 1);
  }

  writeIdList(file, key, ids);
  return ids.includes(cleanId);
}

function getBlacklist() {
  return readIdList(BLACKLIST_FILE, "PERSONNES_BLACKLIST");
}

function getWhitelist() {
  return readIdList(WHITELIST_FILE, "PERSONNES_WHITELIST");
}

function isBlacklisted(id) {
  return getBlacklist().includes(String(id));
}

function isWhitelisted(id) {
  return getWhitelist().includes(String(id));
}

function isLibre(id) {
  return String(id).startsWith("libre_");
}

function cleanupFamily(data) {
  if (!data.nodes || typeof data.nodes !== "object") {
    data.nodes = {};
  }

  for (const id of Object.keys(data.nodes)) {
    ensureUser(data, id);
  }

  for (const [id, node] of Object.entries(data.nodes)) {
    if (node.parent && (!data.nodes[node.parent] || node.parent === id)) {
      node.parent = null;
    }

    if (node.spouse && (!data.nodes[node.spouse] || node.spouse === id)) {
      node.spouse = null;
    }
  }

  for (const [id, node] of Object.entries(data.nodes)) {
    if (!node.spouse || !data.nodes[node.spouse]) continue;

    const spouseNode = data.nodes[node.spouse];

    if (!spouseNode.spouse) {
      spouseNode.spouse = id;
    } else if (spouseNode.spouse !== id) {
      node.spouse = null;
    }
  }
}

function ensureUser(data, id) {
  if (!data.nodes[id]) {
    data.nodes[id] = {
      id,
      type: isLibre(id) ? "libre" : "user",
      parent: null,
      spouse: null,
      generation: null,
    };
  }

  if (data.nodes[id].parent === undefined) data.nodes[id].parent = null;
  if (data.nodes[id].spouse === undefined) data.nodes[id].spouse = null;
  if (data.nodes[id].generation === undefined) data.nodes[id].generation = null;
}

function createLibre(data, generation = null) {
  const id = `libre_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  data.nodes[id] = {
    id,
    type: "libre",
    label: "LIBRE",
    parent: null,
    spouse: null,
    generation,
  };

  return id;
}

function replaceLibreWithUser(data, libreId, userId) {
  if (!data.nodes[libreId] || !isLibre(libreId)) return false;

  const libre = data.nodes[libreId];
  ensureUser(data, userId);

  data.nodes[userId].parent = libre.parent;
  data.nodes[userId].spouse = libre.spouse;
  data.nodes[userId].generation = libre.generation;

  for (const node of Object.values(data.nodes)) {
    if (node.parent === libreId) node.parent = userId;
    if (node.spouse === libreId) node.spouse = userId;
  }

  delete data.nodes[libreId];
  return true;
}

function findLibre(data, { generation, parent = undefined }) {
  return Object.values(data.nodes).find(node => {
    if (!isLibre(node.id)) return false;
    if (node.generation !== generation) return false;
    if (parent !== undefined && node.parent !== parent) return false;
    return true;
  })?.id || null;
}

function shiftSubtreeGenerations(data, rootId, delta) {
  const stack = [rootId];

  while (stack.length > 0) {
    const currentId = stack.pop();
    const node = data.nodes[currentId];
    if (!node) continue;

    if (node.generation !== null && node.generation !== undefined) {
      node.generation += delta;
    }

    for (const [id, child] of Object.entries(data.nodes)) {
      if (child.parent === currentId) stack.push(id);
    }
  }
}

function setGeneration(data, id, generation) {
  ensureUser(data, id);

  const node = data.nodes[id];

  if (node.generation === null || node.generation === undefined) {
    node.generation = generation;
    return;
  }

  if (node.generation !== generation) {
    const delta = generation - node.generation;
    shiftSubtreeGenerations(data, id, delta);
  }
}
function getGeneration(data, id) {
  ensureUser(data, id);

  if (data.nodes[id].generation === null || data.nodes[id].generation === undefined) {
    return null;
  }

  return data.nodes[id].generation;
}

function wouldCreateLoop(data, childId, parentId) {
  let current = parentId;

  while (current) {
    if (current === childId) return true;
    current = data.nodes[current]?.parent;
  }

  return false;
}

function setParent(data, childId, parentId) {
  ensureUser(data, childId);
  ensureUser(data, parentId);

  if (childId === parentId) throw new Error("Impossible de se lier à soi-même.");

  if (wouldCreateLoop(data, childId, parentId)) {
    throw new Error("Lien impossible : cela créerait une boucle dans l’arbre.");
  }

  data.nodes[childId].parent = parentId;
}

function areSpouses(data, a, b) {
  return data.nodes[a]?.spouse === b || data.nodes[b]?.spouse === a;
}

function areSiblings(data, a, b) {
  return data.nodes[a]?.parent && data.nodes[a]?.parent === data.nodes[b]?.parent;
}

function getParentIds(data, personId) {
  const parentId = data.nodes[personId]?.parent;
  if (!parentId || !data.nodes[parentId]) return [];

  const parents = [parentId];
  const spouseId = data.nodes[parentId]?.spouse;

  if (spouseId && data.nodes[spouseId]) {
    parents.push(spouseId);
  }

  return Array.from(new Set(parents));
}

function getParentCount(data, personId) {
  return getParentIds(data, personId).filter(id => !isLibre(id)).length;
}

function hasRealSpouse(data, id) {
  const spouseId = data.nodes[id]?.spouse;
  return Boolean(spouseId && data.nodes[spouseId] && !isLibre(spouseId));
}

function isAncestor(data, ancestorId, personId) {
  let current = data.nodes[personId]?.parent;

  while (current) {
    if (current === ancestorId) return true;
    current = data.nodes[current]?.parent;
  }

  return false;
}

function validateRelation(data, quiId, avecId, lien) {
  ensureUser(data, quiId);
  ensureUser(data, avecId);

  if (quiId === avecId) {
    throw new Error("Impossible de lier une personne avec elle-même.");
  }

  if (lien === "mari_fiancee") {
    if (hasRealSpouse(data, quiId) && data.nodes[quiId].spouse !== avecId) {
      throw new Error("Lien impossible : cette personne a déjà un mari/fiancé.");
    }

    if (hasRealSpouse(data, avecId) && data.nodes[avecId].spouse !== quiId) {
      throw new Error("Lien impossible : cette personne a déjà un mari/fiancé.");
    }

    if (areSiblings(data, quiId, avecId)) {
      throw new Error("Lien impossible : frères/sœurs ne peuvent pas être mariés/fiancés.");
    }

    if (isAncestor(data, quiId, avecId) || isAncestor(data, avecId, quiId)) {
      throw new Error("Lien impossible : parent/enfant ou ancêtre/descendant ne peuvent pas être mariés/fiancés.");
    }
  }

  if (lien === "frere_soeur") {
    if (areSpouses(data, quiId, avecId)) {
      throw new Error("Lien impossible : deux personnes mariées/fiancées ne peuvent pas être frères/sœurs.");
    }

    if (isAncestor(data, quiId, avecId) || isAncestor(data, avecId, quiId)) {
      throw new Error("Lien impossible : un parent/enfant ne peut pas aussi être frère/sœur.");
    }
  }

  if (lien === "cousin_cousine") {
    if (areSpouses(data, quiId, avecId)) {
      throw new Error("Lien impossible : deux personnes mariées/fiancées ne peuvent pas être cousins.");
    }

    if (areSiblings(data, quiId, avecId)) {
      throw new Error("Lien impossible : deux frères/sœurs ne peuvent pas être cousins.");
    }

    if (isAncestor(data, quiId, avecId) || isAncestor(data, avecId, quiId)) {
      throw new Error("Lien impossible : un ancêtre/descendant ne peut pas être cousin.");
    }
  }

  if (lien === "enfant" || lien === "parent") {
    if (areSpouses(data, quiId, avecId)) {
      throw new Error("Lien impossible : deux personnes mariées/fiancées ne peuvent pas être parent/enfant.");
    }

    if (areSiblings(data, quiId, avecId)) {
      throw new Error("Lien impossible : deux frères/sœurs ne peuvent pas être parent/enfant.");
    }

    const childId = lien === "enfant" ? quiId : avecId;
    const newParentId = lien === "enfant" ? avecId : quiId;
    const parentIds = getParentIds(data, childId);
    const realParentIds = parentIds.filter(id => !isLibre(id));

    if (realParentIds.includes(newParentId)) {
      return;
    }

    if (realParentIds.length >= 2) {
      throw new Error("Limite atteinte : une personne ne peut pas avoir plus de 2 parents.");
    }

    if (realParentIds.length === 1) {
      const existingParentId = realParentIds[0];
      const existingParentSpouse = data.nodes[existingParentId]?.spouse;
      const newParentSpouse = data.nodes[newParentId]?.spouse;

      if (existingParentSpouse && existingParentSpouse !== newParentId) {
        throw new Error("Limite atteinte : cette personne a déjà 2 parents.");
      }

      if (newParentSpouse && newParentSpouse !== existingParentId) {
        throw new Error("Lien impossible : ce parent a déjà un mari/fiancé.");
      }
    }
  }
}

function applyRelation(data, quiId, avecId, lien) {
  ensureUser(data, quiId);
  ensureUser(data, avecId);

  validateRelation(data, quiId, avecId, lien);

  let avecGen = getGeneration(data, avecId);

  if (avecGen === null) {
    data.nodes[avecId].generation = 0;
    avecGen = 0;
  }

  if (lien === "parent") {
    const wantedGen = avecGen - 1;
    const existingParent = data.nodes[avecId].parent;

    if (existingParent && isLibre(existingParent)) {
      replaceLibreWithUser(data, existingParent, quiId);
      setGeneration(data, quiId, wantedGen);
      return;
    }

    if (existingParent && !isLibre(existingParent)) {
      if (existingParent === quiId) {
        setGeneration(data, quiId, wantedGen);
        return;
      }

      const existingParentSpouse = data.nodes[existingParent]?.spouse;

      if (existingParentSpouse && existingParentSpouse !== quiId) {
        throw new Error("Limite atteinte : cette personne a déjà 2 parents.");
      }

      setGeneration(data, quiId, wantedGen);
      data.nodes[quiId].spouse = existingParent;
      data.nodes[existingParent].spouse = quiId;
      return;
    }

    setGeneration(data, quiId, wantedGen);
    setParent(data, avecId, quiId);
  }

  if (lien === "enfant") {
    const wantedGen = avecGen + 1;
    const existingParent = data.nodes[quiId].parent;
    const libre = findLibre(data, { generation: wantedGen, parent: avecId });

    if (libre) replaceLibreWithUser(data, libre, quiId);

    if (existingParent && !isLibre(existingParent) && existingParent !== avecId) {
      const existingParentSpouse = data.nodes[existingParent]?.spouse;

      if (existingParentSpouse && existingParentSpouse !== avecId) {
        throw new Error("Limite atteinte : cette personne a déjà 2 parents.");
      }

      setGeneration(data, quiId, wantedGen);
      data.nodes[existingParent].spouse = avecId;
      data.nodes[avecId].spouse = existingParent;
      return;
    }

    setGeneration(data, quiId, wantedGen);
    setParent(data, quiId, avecId);
  }

  if (lien === "frere_soeur") {
    const wantedGen = avecGen;
    const avecParent = data.nodes[avecId].parent;
    const libre = findLibre(data, { generation: wantedGen, parent: avecParent || undefined });

    if (libre) replaceLibreWithUser(data, libre, quiId);

    setGeneration(data, quiId, wantedGen);

    const quiParent = data.nodes[quiId].parent;
    const newAvecParent = data.nodes[avecId].parent;

    if (quiParent && !newAvecParent) {
      setParent(data, avecId, quiParent);
    } else if (!quiParent && newAvecParent) {
      setParent(data, quiId, newAvecParent);
    } else if (!quiParent && !newAvecParent) {
      const parent = createLibre(data, wantedGen - 1);
      setParent(data, quiId, parent);
      setParent(data, avecId, parent);
    } else if (quiParent !== newAvecParent) {
      throw new Error("Ces deux personnes ont déjà des parents différents.");
    }
  }

  if (lien === "cousin_cousine") {
    const wantedGen = avecGen;

    if (areSpouses(data, quiId, avecId)) {
      throw new Error("Lien impossible : deux personnes mariées/fiancées ne peuvent pas être cousins.");
    }

    let avecParent = data.nodes[avecId].parent;

    if (!avecParent) {
      const spouseId = data.nodes[avecId].spouse;
      const spouseParent = spouseId ? data.nodes[spouseId]?.parent : null;
      const spouseGrandParent = spouseParent ? data.nodes[spouseParent]?.parent : null;

      avecParent = createLibre(data, avecGen - 1);
      setParent(data, avecId, avecParent);

      if (spouseGrandParent) {
        setParent(data, avecParent, spouseGrandParent);
      }
    }

    setGeneration(data, avecParent, avecGen - 1);

    if (!data.nodes[avecParent].parent) {
      const grandParent = createLibre(data, avecGen - 2);
      setParent(data, avecParent, grandParent);
    }

    const grandParent = data.nodes[avecParent].parent;
    setGeneration(data, grandParent, avecGen - 2);

    setGeneration(data, quiId, wantedGen);

    if (!data.nodes[quiId].parent) {
      const existingLibreParent = Object.values(data.nodes).find(node => {
        return isLibre(node.id) &&
          node.generation === avecGen - 1 &&
          node.parent === grandParent &&
          node.id !== avecParent;
      })?.id;

      const quiParent = existingLibreParent || createLibre(data, avecGen - 1);
      setParent(data, quiId, quiParent);
    }

    const quiParent = data.nodes[quiId].parent;
    setGeneration(data, quiParent, avecGen - 1);
    setParent(data, quiParent, grandParent);
  }

  if (lien === "mari_fiancee") {
    setGeneration(data, quiId, avecGen);
    data.nodes[quiId].spouse = avecId;
    data.nodes[avecId].spouse = quiId;
  }
}

function relationLabel(lien) {
  return {
    enfant: "Enfant",
    parent: "Parent",
    frere_soeur: "Frère / Sœur",
    cousin_cousine: "Cousin / Cousine",
    mari_fiancee: "Mari / Fiancée",
  }[lien] || lien;
}

async function getUserName(id) {
  if (isLibre(id)) return "LIBRE";

  try {
    const user = await client.users.fetch(id);
    return (user.globalName || user.username || "MEMBRE").toUpperCase();
  } catch {
    return "MEMBRE";
  }
}

async function getUserAvatar(id) {
  if (isLibre(id)) return null;

  try {
    const user = await client.users.fetch(id);
    const url = user.displayAvatarURL({ extension: "png", size: 256, forceStatic: true });
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());
    return await loadImage(buffer);
  } catch {
    return null;
  }
}

async function getRoleColor(guild, id) {
  if (!guild || isLibre(id)) return "#171717";

  try {
    const member = await guild.members.fetch(id);
    const role = member.roles.cache
      .filter(r => r.color !== 0 && r.name !== "@everyone")
      .sort((a, b) => b.position - a.position)
      .first();

    return role ? role.hexColor : "#171717";
  } catch {
    return "#171717";
  }
}

async function getRoleHierarchyGeneration(guild, id) {
  if (!guild || isLibre(id)) return 0;

  try {
    const member = await guild.members.fetch(id);
    const roles = member.roles.cache
      .filter(role => role.name !== "@everyone")
      .sort((a, b) => b.position - a.position);

    const topRole = roles.first();
    if (!topRole) return 0;

    const serverRoles = guild.roles.cache
      .filter(role => role.name !== "@everyone")
      .sort((a, b) => b.position - a.position);

    const highestPosition = serverRoles.first()?.position || 0;
    if (highestPosition <= 0) return 0;

    const ratio = topRole.position / highestPosition;

    // Plus la personne a un rôle haut dans la hiérarchie Discord,
    // plus elle est placée haut dans l'arbre quand elle n'a pas encore de génération.
    if (ratio >= 0.85) return -2;
    if (ratio >= 0.60) return -1;
    return 0;
  } catch {
    return 0;
  }
}

async function prepareRoleBasedGenerations(data, guild, quiId, avecId, lien) {
  ensureUser(data, quiId);
  ensureUser(data, avecId);

  const quiHasGeneration = data.nodes[quiId].generation !== null && data.nodes[quiId].generation !== undefined;
  const avecHasGeneration = data.nodes[avecId].generation !== null && data.nodes[avecId].generation !== undefined;

  // On utilise la hiérarchie des rôles uniquement pour les nouvelles branches.
  // Dès qu'une personne est déjà liée dans l'arbre, ses générations familiales restent prioritaires.
  if (!quiHasGeneration && !avecHasGeneration) {
    const quiBaseGen = await getRoleHierarchyGeneration(guild, quiId);
    const avecBaseGen = await getRoleHierarchyGeneration(guild, avecId);

    if (lien === "mari_fiancee" || lien === "frere_soeur" || lien === "cousin_cousine") {
      const sharedGeneration = Math.min(quiBaseGen, avecBaseGen);
      data.nodes[quiId].generation = sharedGeneration;
      data.nodes[avecId].generation = sharedGeneration;
      return;
    }

    if (lien === "enfant") {
      data.nodes[avecId].generation = avecBaseGen;
      data.nodes[quiId].generation = avecBaseGen + 1;
      return;
    }

    if (lien === "parent") {
      data.nodes[avecId].generation = avecBaseGen;
      data.nodes[quiId].generation = avecBaseGen - 1;
      return;
    }
  }

  if (!avecHasGeneration && quiHasGeneration) {
    const quiGen = data.nodes[quiId].generation;

    if (lien === "enfant") data.nodes[avecId].generation = quiGen - 1;
    if (lien === "parent") data.nodes[avecId].generation = quiGen + 1;
    if (lien === "mari_fiancee" || lien === "frere_soeur" || lien === "cousin_cousine") data.nodes[avecId].generation = quiGen;
  }

  if (!quiHasGeneration && avecHasGeneration) {
    const avecGen = data.nodes[avecId].generation;

    if (lien === "enfant") data.nodes[quiId].generation = avecGen + 1;
    if (lien === "parent") data.nodes[quiId].generation = avecGen - 1;
    if (lien === "mari_fiancee" || lien === "frere_soeur" || lien === "cousin_cousine") data.nodes[quiId].generation = avecGen;
  }
}

function buildLayout(data) {
  const members = Object.keys(data.nodes);

  for (const id of members) {
    ensureUser(data, id);
    if (data.nodes[id].generation === null || data.nodes[id].generation === undefined) {
      data.nodes[id].generation = 0;
    }
  }

  const childrenMap = {};
  for (const id of members) childrenMap[id] = [];

  for (const id of members) {
    const parent = data.nodes[id].parent;
    if (parent && data.nodes[parent]) {
      if (!childrenMap[parent]) childrenMap[parent] = [];
      childrenMap[parent].push(id);
    }
  }

  function nodeSort(a, b) {
    const ag = data.nodes[a]?.generation ?? 0;
    const bg = data.nodes[b]?.generation ?? 0;
    if (ag !== bg) return ag - bg;

    const ap = data.nodes[a]?.parent || "";
    const bp = data.nodes[b]?.parent || "";
    if (ap !== bp) return ap.localeCompare(bp);

    return a.localeCompare(b);
  }

  for (const id of Object.keys(childrenMap)) {
    childrenMap[id].sort(nodeSort);
  }

  const roots = members
    .filter(id => !data.nodes[id].parent || !data.nodes[data.nodes[id].parent])
    .sort(nodeSort);

  const NODE_W = 260;
  const SIBLING_GAP = 90;
  const ROOT_GAP = 170;
  const LEVEL_GAP_Y = 260;
  const TOP_Y = 350;
  const MARGIN_X = 190;

  const widthCache = {};

  function subtreeWidth(id) {
    if (widthCache[id]) return widthCache[id];

    const spouse = data.nodes[id]?.spouse;
    const hasSpouseBeside = spouse && data.nodes[spouse] && data.nodes[spouse].generation === data.nodes[id].generation;
    const spouseChildren = hasSpouseBeside ? (childrenMap[spouse] || []) : [];
    const children = Array.from(new Set([...(childrenMap[id] || []), ...spouseChildren]));
    const ownWidth = hasSpouseBeside ? NODE_W * 2 : NODE_W;

    if (children.length === 0) {
      widthCache[id] = ownWidth;
      return widthCache[id];
    }

    const childrenWidth = children.reduce((sum, childId) => sum + subtreeWidth(childId), 0) +
      SIBLING_GAP * Math.max(0, children.length - 1);

    widthCache[id] = Math.max(ownWidth, childrenWidth);
    return widthCache[id];
  }

  const genValues = members.map(id => data.nodes[id].generation ?? 0);
  const minGen = genValues.length ? Math.min(...genValues) : 0;
  const maxGen = genValues.length ? Math.max(...genValues) : 0;

  const positions = {};
  const placed = new Set();

  function placeSubtree(id, left) {
    if (placed.has(id)) return;

    const width = subtreeWidth(id);
    const gen = data.nodes[id].generation ?? 0;
    const spouse = data.nodes[id]?.spouse;
    const hasSpouseBeside = spouse && data.nodes[spouse] && data.nodes[spouse].generation === gen;
    const spouseChildren = hasSpouseBeside ? (childrenMap[spouse] || []) : [];
    const children = Array.from(new Set([...(childrenMap[id] || []), ...spouseChildren]));

    let centerX;

    if (children.length === 0) {
      centerX = left + width / 2;
    } else {
      let childLeft = left;
      const childCenters = [];

      for (const childId of children) {
        const childWidth = subtreeWidth(childId);
        placeSubtree(childId, childLeft);
        if (positions[childId]) childCenters.push(positions[childId].x);
        childLeft += childWidth + SIBLING_GAP;
      }

      if (childCenters.length > 0) {
        centerX = (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
      } else {
        centerX = left + width / 2;
      }
    }

    positions[id] = {
      x: centerX,
      y: TOP_Y + (gen - minGen) * LEVEL_GAP_Y,
    };
    placed.add(id);

    if (hasSpouseBeside && !placed.has(spouse)) {
      positions[id].x = centerX - NODE_W / 2;
      positions[spouse] = {
        x: centerX + NODE_W / 2,
        y: TOP_Y + (gen - minGen) * LEVEL_GAP_Y,
      };
      placed.add(spouse);
    }
  }

  let currentLeft = MARGIN_X;

  for (const root of roots) {
    if (placed.has(root)) continue;
    const width = subtreeWidth(root);
    placeSubtree(root, currentLeft);
    currentLeft += width + ROOT_GAP;
  }

  for (const id of members.sort(nodeSort)) {
    if (placed.has(id)) continue;
    const width = subtreeWidth(id);
    placeSubtree(id, currentLeft);
    currentLeft += width + ROOT_GAP;
  }

  let minX = Infinity;
  let maxX = -Infinity;

  for (const pos of Object.values(positions)) {
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x);
  }

  const canvasWidth = Math.max(1700, (maxX - minX) + MARGIN_X * 2 || 1700);
  const shiftX = canvasWidth / 2 - ((minX + maxX) / 2 || canvasWidth / 2);

  for (const pos of Object.values(positions)) {
    pos.x += shiftX;
  }

  const canvasHeight = Math.max(1000, TOP_Y + (maxGen - minGen + 2) * LEVEL_GAP_Y);

  return { positions, childrenMap, width: canvasWidth, height: canvasHeight };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function drawFamilyConnections(ctx, parentPos, childPositions) {
  if (!parentPos || !childPositions.length) return;

  const hasCoupleStart = parentPos.startY !== undefined && parentPos.startY !== null;
  const startY = hasCoupleStart ? parentPos.startY : (parentPos.bottomY ? parentPos.bottomY + 18 : parentPos.y + 118);
  const safeStartY = hasCoupleStart ? (parentPos.bottomY ? parentPos.bottomY + 20 : parentPos.y + 125) : startY;
  const childTopY = Math.min(...childPositions.map(pos => pos.y - 76));
  const midY = safeStartY + Math.max(35, (childTopY - safeStartY) / 2);

  ctx.beginPath();
  ctx.moveTo(parentPos.x, startY);
  ctx.lineTo(parentPos.x, midY);
  ctx.stroke();

  if (childPositions.length === 1) {
    const child = childPositions[0];
    ctx.beginPath();
    ctx.moveTo(parentPos.x, midY);
    ctx.lineTo(child.x, midY);
    ctx.lineTo(child.x, child.y - 76);
    ctx.stroke();
    return;
  }

  const firstX = Math.min(...childPositions.map(pos => pos.x));
  const lastX = Math.max(...childPositions.map(pos => pos.x));

  ctx.beginPath();
  ctx.moveTo(firstX, midY);
  ctx.lineTo(lastX, midY);
  ctx.stroke();

  for (const child of childPositions) {
    ctx.beginPath();
    ctx.moveTo(child.x, midY);
    ctx.lineTo(child.x, child.y - 76);
    ctx.stroke();
  }
}

function drawSpouseLine(ctx, a, b) {
  const left = a.x <= b.x ? a : b;
  const right = a.x <= b.x ? b : a;

  const lineY = Math.min(left.y, right.y);
  const startX = left.x + 78;
  const endX = right.x - 78;

  // Si les conjoints sont anormalement éloignés à cause d'une ancienne sauvegarde,
  // on évite de tracer une immense ligne qui traverse tout l'arbre.
  if (Math.abs(endX - startX) > 520) return;

  ctx.beginPath();
  ctx.moveTo(startX, lineY);
  ctx.lineTo(endX, lineY);
  ctx.stroke();
}

function wrapText(ctx, text, maxWidth) {
  const cleanText = String(text)
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanText) return [""];

  const words = cleanText.split(" ");
  const lines = [];
  let line = "";

  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;

    if (ctx.measureText(testLine).width <= maxWidth) {
      line = testLine;
      continue;
    }

    if (line) {
      lines.push(line);
      line = "";
    }

    if (ctx.measureText(word).width <= maxWidth) {
      line = word;
      continue;
    }

    let chunk = "";
    for (const char of word) {
      const testChunk = chunk + char;

      if (ctx.measureText(testChunk).width > maxWidth && chunk) {
        lines.push(chunk);
        chunk = char;
      } else {
        chunk = testChunk;
      }
    }

    line = chunk;
  }

  if (line) lines.push(line);

  return lines.slice(0, 4);
}


async function drawNode(ctx, guild, id, pos) {
  const avatar = await getUserAvatar(id);
  const name = await getUserName(id);
  const borderColor = await getRoleColor(guild, id);

  ctx.save();

  ctx.shadowColor = "rgba(0,0,0,0.15)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;

  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 63, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  ctx.shadowColor = "transparent";

  ctx.lineWidth = 6;
  ctx.strokeStyle = borderColor;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 52, 0, Math.PI * 2);
  ctx.clip();

  if (avatar) {
    ctx.drawImage(avatar, pos.x - 52, pos.y - 52, 104, 104);
  } else {
    ctx.fillStyle = "#e8ead4";
    ctx.fillRect(pos.x - 52, pos.y - 52, 104, 104);

    ctx.fillStyle = "#a6c96a";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y - 12, 25, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#7dae43";
    ctx.beginPath();
    ctx.arc(pos.x - 22, pos.y + 14, 21, 0, Math.PI * 2);
    ctx.arc(pos.x + 22, pos.y + 14, 21, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  ctx.fillStyle = "#111111";
  ctx.font = `700 18px ${FONT_FALLBACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const label = name.toUpperCase();
  const lines = wrapText(ctx, label, 145);
  const startY = pos.y + 82;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], pos.x, startY + i * 21);
  }

  pos.bottomY = startY + Math.max(1, lines.length) * 21;
}

async function drawTree(data, guild) {
  cleanupFamily(data);
  const { positions, childrenMap, width, height } = buildLayout(data);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#f7f6df";
  roundRect(ctx, 0, 0, width, height, 36);

  ctx.fillStyle = "#050505";
  roundRect(ctx, width / 2 - 390, 65, 780, 130, 24);

  ctx.fillStyle = "#ffffff";
  ctx.font = `800 68px ${FONT_FALLBACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("EMPIRE TREE", width / 2, 130);

  ctx.strokeStyle = "#222222";
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const id of Object.keys(positions)) {
    const name = await getUserName(id);
    ctx.font = `700 18px ${FONT_FALLBACK}`;
    const lines = wrapText(ctx, name.toUpperCase(), 145);
    positions[id].bottomY = positions[id].y + 82 + Math.max(1, lines.length) * 21;
  }

  const drawnFamilyLinks = new Set();

  for (const [parentId, childIds] of Object.entries(childrenMap)) {
    const parentPos = positions[parentId];
    if (!parentPos) continue;

    const spouseId = data.nodes[parentId]?.spouse;
    const spousePos = spouseId ? positions[spouseId] : null;

    let familyKey = parentId;
    let anchorPos = parentPos;
    let mergedChildIds = [...childIds];

    if (spouseId && spousePos && data.nodes[spouseId]) {
      familyKey = [parentId, spouseId].sort().join(":");
      if (drawnFamilyLinks.has(familyKey)) continue;

      mergedChildIds = Array.from(new Set([
        ...(childrenMap[parentId] || []),
        ...(childrenMap[spouseId] || []),
      ]));

      const coupleY = Math.min(parentPos.y, spousePos.y);

      anchorPos = {
        x: (parentPos.x + spousePos.x) / 2,
        y: coupleY,
        startY: coupleY,
        bottomY: Math.max(parentPos.bottomY || parentPos.y + 118, spousePos.bottomY || spousePos.y + 118),
      };
    }

    drawnFamilyLinks.add(familyKey);

    const childPositions = mergedChildIds
      .map(childId => positions[childId])
      .filter(Boolean);

    drawFamilyConnections(ctx, anchorPos, childPositions);
  }

  for (const [id, node] of Object.entries(data.nodes)) {
    if (!node.spouse) continue;
    if (!positions[id] || !positions[node.spouse]) continue;
    if (id > node.spouse) continue;

    drawSpouseLine(ctx, positions[id], positions[node.spouse]);
  }

  for (const id of Object.keys(positions)) {
    await drawNode(ctx, guild, id, positions[id]);
  }

  fs.writeFileSync(OUTPUT_FILE, canvas.toBuffer("image/png"));
  return OUTPUT_FILE;
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("✅ Commandes enregistrées.");
}

client.once("ready", () => {
  console.log(`✅ Connecté : ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isButton()) {
      const [action, requestId] = interaction.customId.split(":");

      if (!["accept", "reject"].includes(action)) return;

      const requestsData = loadRequests();
      const request = requestsData.requests[requestId];

      if (!request) {
        return interaction.reply({
          content: "❌ Cette demande n’existe plus ou a déjà été traitée.",
          ephemeral: true,
        });
      }

      if (interaction.user.id !== request.targetId && !isOwner(interaction.user.id)) {
        return interaction.reply({
          content: "⛔ Seule la personne concernée peut répondre à cette demande.",
          ephemeral: true,
        });
      }

      const requester = await client.users.fetch(request.requesterId).catch(() => null);
      const target = await client.users.fetch(request.targetId).catch(() => null);

      if (action === "reject") {
        delete requestsData.requests[requestId];
        saveRequests(requestsData);

        return interaction.update({
          content: `❌ Demande refusée : <@${request.requesterId}> → <@${request.targetId}>.`,
          components: [],
        });
      }

      if (action === "accept") {
        await interaction.deferUpdate();

        const data = loadFamily();

        if (isBlacklisted(request.requesterId)) {
          delete requestsData.requests[requestId];
          saveRequests(requestsData);

          return interaction.message.edit({
            content: "⛔ Cette personne est blacklistée. Demande annulée.",
            components: [],
          });
        }

        await prepareRoleBasedGenerations(data, interaction.guild, request.requesterId, request.targetId, request.lien);
        createFamilyBackup("accept_lier");
        applyRelation(data, request.requesterId, request.targetId, request.lien);
        saveFamily(data);

        const file = await drawTree(data, interaction.guild);

        delete requestsData.requests[requestId];
        saveRequests(requestsData);

        await interaction.message.edit({
          content: `✅ Demande acceptée : ${requester?.username || "membre"} → ${target?.username || "membre"} (${relationLabel(request.lien)}).`,
          components: [],
        });

        return interaction.followUp({
          files: [new AttachmentBuilder(file)],
        });
      }
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "blacklist") {
      if (!isOwner(interaction.user.id)) {
        return interaction.reply({
          content: "⛔ Seule l’admin peut utiliser cette commande.",
          ephemeral: true,
        });
      }

      const membre = interaction.options.getUser("membre");
      const action = interaction.options.getString("action");
      const isNowBlacklisted = updateIdList(BLACKLIST_FILE, "PERSONNES_BLACKLIST", membre.id, action);

      if (action === "add") {
        lierCooldowns.delete(membre.id);
      }

      return interaction.reply({
        content: isNowBlacklisted
          ? `⛔ ${membre.username} est maintenant blacklist.`
          : `✅ ${membre.username} n’est plus blacklist.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "whitelist") {
      if (!isOwner(interaction.user.id)) {
        return interaction.reply({
          content: "⛔ Seule l’admin peut utiliser cette commande.",
          ephemeral: true,
        });
      }

      const membre = interaction.options.getUser("membre");
      const action = interaction.options.getString("action");
      const isNowWhitelisted = updateIdList(WHITELIST_FILE, "PERSONNES_WHITELIST", membre.id, action);

      if (action === "add") {
        lierCooldowns.delete(membre.id);
      }

      return interaction.reply({
        content: isNowWhitelisted
          ? `✅ ${membre.username} est maintenant whitelist et passe le cooldown.`
          : `✅ ${membre.username} n’est plus whitelist.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "lier") {
      const qui = interaction.options.getUser("qui");
      const avec = interaction.options.getUser("avec");
      const lien = interaction.options.getString("lien");

      if (!isOwner(interaction.user.id) && !isWhitelisted(interaction.user.id)) {
        const lastUse = lierCooldowns.get(interaction.user.id);
        const now = Date.now();

        if (lastUse && now - lastUse < LIER_COOLDOWN) {
          const remaining = LIER_COOLDOWN - (now - lastUse);
          const minutes = Math.floor(remaining / 60000);
          const seconds = Math.ceil((remaining % 60000) / 1000);

          return interaction.reply({
            content: `⏳ Tu dois attendre encore **${minutes} min ${seconds} s** avant de pouvoir réutiliser \`/lier\`.`,
            ephemeral: true,
          });
        }
      }

      if (isBlacklisted(qui.id)) {
        return interaction.reply({
          content: "⛔ Cette personne est blacklistée.",
          ephemeral: true,
        });
      }

      const data = loadFamily();

      // Admin = peut lier n’importe qui avec n’importe qui directement.
      if (isOwner(interaction.user.id)) {
        await interaction.deferReply();

        await prepareRoleBasedGenerations(data, interaction.guild, qui.id, avec.id, lien);
        createFamilyBackup("admin_lier");
        applyRelation(data, qui.id, avec.id, lien);
        saveFamily(data);

        const file = await drawTree(data, interaction.guild);

        return interaction.editReply({
          content: `✅ Admin : lien ajouté directement : ${qui.username} → ${avec.username} (${relationLabel(lien)}).`,
          files: [new AttachmentBuilder(file)],
        });
      }

      // Membre normal = doit uniquement se lier lui-même.
      if (qui.id !== interaction.user.id) {
        return interaction.reply({
          content: "⛔ Tu ne peux faire une demande que pour toi-même.",
          ephemeral: true,
        });
      }

      if (qui.id === avec.id) {
        return interaction.reply({
          content: "❌ Tu ne peux pas te lier à toi-même.",
          ephemeral: true,
        });
      }

      // On vérifie déjà si le lien est possible avant d’envoyer la demande.
      await prepareRoleBasedGenerations(data, interaction.guild, qui.id, avec.id, lien);
      validateRelation(data, qui.id, avec.id, lien);

      const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const requestsData = loadRequests();

      requestsData.requests[requestId] = {
        requestId,
        requesterId: qui.id,
        targetId: avec.id,
        lien,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        createdAt: Date.now(),
      };

      saveRequests(requestsData);

      if (!isOwner(interaction.user.id) && !isWhitelisted(interaction.user.id)) {
        lierCooldowns.set(interaction.user.id, Date.now());
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`accept:${requestId}`)
          .setLabel("Accepter")
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId(`reject:${requestId}`)
          .setLabel("Refuser")
          .setStyle(ButtonStyle.Danger),
      );

      return interaction.reply({
        content:
`🌳 **Demande de lien Empire Tree**

👤 Demandeur : <@${qui.id}>
🎯 Personne concernée : <@${avec.id}>
🔗 Lien demandé : **${relationLabel(lien)}**

<@${avec.id}>, tu peux accepter ou refuser cette demande.`,
        components: [row],
      });
    }

    if (interaction.commandName === "arbre") {
      await interaction.deferReply();

      const data = loadFamily();
      const file = await drawTree(data, interaction.guild);

      return interaction.editReply({
        files: [new AttachmentBuilder(file)],
      });
    }

    if (interaction.commandName === "backup") {
      if (!isOwner(interaction.user.id)) {
        return interaction.reply({
          content: "⛔ Seule l’admin peut restaurer une backup.",
          ephemeral: true,
        });
      }

      const stepsBack = interaction.options.getInteger("retour");
      await interaction.deferReply({ ephemeral: true });

      const restoredData = restoreFamilyBackup(stepsBack);
      const file = await drawTree(restoredData, interaction.guild);

      return interaction.editReply({
        content: `✅ Backup restaurée : retour de **${stepsBack} changement(s)**.`,
        files: [new AttachmentBuilder(file)],
      });
    }

    if (interaction.commandName === "reset") {
      if (!isOwner(interaction.user.id)) {
        return interaction.reply({
          content: "⛔ Seule l’admin peut réinitialiser l’arbre.",
          ephemeral: true,
        });
      }

      createFamilyBackup("reset");
      saveFamily({ nodes: {} });
      saveRequests({ requests: {} });

      try {
        if (fs.existsSync(OUTPUT_FILE)) fs.unlinkSync(OUTPUT_FILE);
      } catch (err) {
        console.error("Impossible de supprimer l’image générée:", err);
      }

      return interaction.reply({
        content: "🌳 L’arbre a été complètement réinitialisé.",
        ephemeral: true,
      });
    }

    if (interaction.commandName === "supprimer") {
      const mode = interaction.options.getString("mode");
      const qui = interaction.options.getUser("qui");
      const data = loadFamily();

      if (mode === "libres_seules") {
        if (!isOwner(interaction.user.id)) {
          return interaction.reply({
            content: "⛔ Seule l’admin peut supprimer les places libres seules.",
            ephemeral: true,
          });
        }

        await interaction.deferReply();

        createFamilyBackup("supprimer_libres_seules");
        const removed = removeLonelyLibreNodes(data);
        saveFamily(data);

        const file = await drawTree(data, interaction.guild);

        return interaction.editReply({
          content: removed > 0
            ? `✅ ${removed} place(s) libre(s) seule(s) supprimée(s).`
            : "✅ Aucune place libre seule à supprimer.",
          files: [new AttachmentBuilder(file)],
        });
      }

      if (!qui) {
        return interaction.reply({
          content: "❌ Tu dois choisir une personne à supprimer.",
          ephemeral: true,
        });
      }

      if (!isOwner(interaction.user.id) && qui.id !== interaction.user.id) {
        return interaction.reply({
          content: "⛔ Tu ne peux supprimer que toi-même.",
          ephemeral: true,
        });
      }

      if (!data.nodes[qui.id]) {
        return interaction.reply({
          content: "❌ Cette personne n’est pas dans l’arbre.",
          ephemeral: true,
        });
      }

      delete data.nodes[qui.id];

      for (const node of Object.values(data.nodes)) {
        if (node.parent === qui.id) node.parent = null;
        if (node.spouse === qui.id) node.spouse = null;
      }

      await interaction.deferReply();

      createFamilyBackup("supprimer");
      saveFamily(data);

      const file = await drawTree(data, interaction.guild);

      return interaction.editReply({
        content: `✅ ${qui.username} a été supprimé de l’arbre.`,
        files: [new AttachmentBuilder(file)],
      });
    }
  } catch (err) {
    console.error(err);

    try {
      if (interaction.replied || interaction.deferred) {
        return interaction.followUp({
          content: `❌ ${err.message || "Une erreur est survenue."}`,
          ephemeral: true,
        });
      }

      return interaction.reply({
        content: `❌ ${err.message || "Une erreur est survenue."}`,
        ephemeral: true,
      });
    } catch (replyErr) {
      console.error("Impossible de répondre à l’interaction:", replyErr);
    }
  }
});

(async () => {
  try {
    restoreLatestBackupIfFamilyIsEmpty();

    if (createFamilyBackup("startup")) {
      console.log("🛡️ Backup de sécurité créée au démarrage.");
    } else {
      console.warn("⚠️ Pas de backup de démarrage créée : arbre vide ou fichier invalide.");
    }

    console.log("⏳ Enregistrement des commandes...");
    await registerCommands();

    console.log("⏳ Connexion du bot...");
    await client.login(TOKEN);
  } catch (err) {
    console.error("❌ Impossible de démarrer le bot:", err);
    process.exit(1);
  }
})();