

// --------- Dépendances et validation ---------
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes, EmbedBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, SlashCommandBuilder, InteractionType } = require('discord.js');
const Database = require('better-sqlite3');

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID || !process.env.GUILD_ID) {
    console.error("[ENV] Veuillez définir DISCORD_TOKEN, CLIENT_ID et GUILD_ID dans .env");
    process.exit(1);
}
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// --------- Client Discord ---------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
});

client.on('error', (error) => {
    console.error('[CLIENT ERROR]', error?.message || error);
});

process.on('unhandledRejection', (error) => {
    console.error('[UNHANDLED REJECTION]', error?.message || error);
});

// --------- Base de données et migrations ---------
const db = new Database('circle.sqlite3');
db.pragma('journal_mode = WAL');
db.prepare(`
    CREATE TABLE IF NOT EXISTS members (
        user_id TEXT PRIMARY KEY,
        circle_id INTEGER UNIQUE,
        join_date INTEGER,
        drop_wins INTEGER DEFAULT 0,
        chosen_one_count INTEGER DEFAULT 0
    )
`).run();
db.prepare(`
    CREATE TABLE IF NOT EXISTS drops (
        drop_id INTEGER PRIMARY KEY AUTOINCREMENT,
        number INTEGER,
        prize TEXT,
        winner_count INTEGER,
        start_time INTEGER,
        end_time INTEGER,
        tag_req TEXT,
        conditions TEXT,
        status TEXT,
        winner_ids TEXT,
        channel_id TEXT,
        message_id TEXT
    )
`).run();
db.prepare(`
    CREATE TABLE IF NOT EXISTS drop_participants (
        drop_id INTEGER,
        user_id TEXT,
        PRIMARY KEY (drop_id, user_id)
    )
`).run();
db.prepare(`
    CREATE TABLE IF NOT EXISTS signals (
        signal_id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT,
        message_id TEXT,
        end_time INTEGER,
        places INTEGER,
        reward TEXT,
        tag_req TEXT,
        participants TEXT,
        status TEXT
    )
`).run();
db.prepare(`
    CREATE TABLE IF NOT EXISTS signal_participants (
        signal_id INTEGER,
        user_id TEXT,
        PRIMARY KEY (signal_id, user_id)
    )
`).run();
db.prepare(`
    CREATE TABLE IF NOT EXISTS chosen_one_expirations (
        user_id TEXT PRIMARY KEY,
        role_id TEXT,
        expires_at INTEGER
    )
`).run();

// --------- Variables en mémoire ---------
const dropTimers = new Map();
const dropLiveTimers = new Map();
const signalTimers = new Map();
let lastFullMemberFetch = 0;

// --------- Utilitaires ---------
function now() { return Math.floor(Date.now() / 1000); }
function toDiscordTimestamp(ts, style='R') { return `<t:${ts}:${style}>`; }
function padId(n) { return n.toString().padStart(3, '0'); }
function randomFromArray(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function getSeniority(joinTs) {
    const diff = now() - joinTs;
    const years = Math.floor(diff / (365.25 * 24 * 60 * 60));
    const months = Math.floor((diff % (365.25 * 24 * 60 * 60)) / (30.44 * 24 * 60 * 60));
    const days = Math.floor((diff % (30.44 * 24 * 60 * 60)) / (24 * 60 * 60));
    let parts = [];
    if (years > 0) parts.push(`${years} an${years > 1 ? 's' : ''}`);
    if (months > 0) parts.push(`${months} mois`);
    if (days > 0) parts.push(`${days} jour${days > 1 ? 's' : ''}`);
    if (parts.length === 0) return "moins d'un jour";
    return parts.join(', ');
}

const WELCOME_PHRASES = [
    "Le Cercle t'observe. Bienvenue dans l'ombre.",
    "Un nouveau visage traverse le voile du Cercle.",
    "Le silence s'épaissit. Un membre de plus rejoint le Cercle.",
    "Le mystère grandit. Bienvenue parmi les initiés.",
    "Les secrets du Cercle t'attendent. Entre.",
    "La lumière de la Lune éclaire ton arrivée.",
    "Bienvenue. Ici, tout peut arriver, mais rien n'est certain.",
    "Le Cercle s'ouvre, mais jamais totalement.",
    "Un pas de plus dans l'inconnu. Bienvenue.",
    "Le jeu commence, et tu en fais partie désormais."
];

// --------- Circle ID et rôles ---------

function hasCoreTag(member) {
    // Vérifie le vrai tag serveur affiché sur le profil Discord.
    // Selon la version de discord.js, il peut être exposé via primaryGuild.
    const primaryGuild = member?.user?.primaryGuild;
    if (!primaryGuild) return false;

    const tag = primaryGuild.tag || primaryGuild.identity_tag || primaryGuild.badge;
    return typeof tag === 'string' && tag.toUpperCase() === 'CORE';
}

function normalizeTagRequirement(tagReq) {
    return String(tagReq || '').trim().toUpperCase();
}

function memberMatchesDropTag(member, tagReq) {
    const requiredTag = normalizeTagRequirement(tagReq);
    if (!requiredTag) return true;

    // Pour l’instant le système Circle Drop utilise le tag serveur CORE.
    // Si un autre tag est écrit par erreur, on le refuse au lieu de valider tout le monde.
    if (requiredTag !== 'CORE') return false;

    return hasCoreTag(member);
}

async function fetchFreshGuildMember(guild, userId) {
    const cachedMember = guild.members.cache.get(userId);

    try {
        const member = cachedMember || await guild.members.fetch(userId);
        await member.user.fetch(true).catch(() => {});
        return member;
    } catch {
        return cachedMember || null;
    }
}

function hasCircleStatusRole(member) {
    return member.roles?.cache?.some(
        role =>
            role.name === 'In The Circle' ||
            role.name === 'Outside The Circle'
    ) ?? false;
}

function getCircleIdFromRole(member) {
    const idRole = member.roles?.cache?.find(role => /^CIRCLE ID — #\d+$/.test(role.name));
    if (!idRole) return null;

    const match = idRole.name.match(/^CIRCLE ID — #(\d+)$/);
    if (!match) return null;

    return Number(match[1]);
}

function isServerBooster(member) {
    return member.roles?.cache?.some(role => role.tags?.premiumSubscriberRole === true) ?? false;
}

async function ensureCircleIdsForGuild(guild) {
    // Seuls les membres ayant In The Circle ou Outside The Circle
    // peuvent recevoir un Circle ID.

    const eligibleMembers = guild.members.cache.filter(
        member =>
            !member.user.bot &&
            !isServerBooster(member) &&
            hasCircleStatusRole(member)
    );

    const dbMembers = db
        .prepare('SELECT user_id FROM members')
        .all()
        .map(row => row.user_id);

    const missingMembers = eligibleMembers.filter(
        member => !dbMembers.includes(member.id)
    );

    if (missingMembers.size === 0) return;

    // Les membres sont classés selon leur date réelle
    // d'arrivée sur le serveur.

    const sortedMembers = missingMembers.sort(
        (a, b) =>
            (a.joinedTimestamp || Date.now()) -
            (b.joinedTimestamp || Date.now())
    );

    const maxIdRow = db
        .prepare('SELECT MAX(circle_id) AS max_id FROM members')
        .get();

    let nextCircleId =
        maxIdRow && maxIdRow.max_id
            ? maxIdRow.max_id + 1
            : 1;

    for (const member of sortedMembers.values()) {

        const joinDate = member.joinedTimestamp
            ? Math.floor(member.joinedTimestamp / 1000)
            : now();

        db.prepare(`
            INSERT OR IGNORE INTO members
            (user_id, circle_id, join_date)
            VALUES (?, ?, ?)
        `).run(
            member.id,
            nextCircleId,
            joinDate
        );

        nextCircleId++;
    }
}

async function ensureCircleMember(member) {
    if (!member || isServerBooster(member)) return null;

    // Aucun Circle ID ni ancienneté si le membre
    // n'a aucun des deux rôles The Circle.

    if (!member || !hasCircleStatusRole(member)) {
        return null;
    }

    const roleCircleId = getCircleIdFromRole(member);

    let row = db
        .prepare(`
            SELECT circle_id, join_date
            FROM members
            WHERE user_id = ?
        `)
        .get(member.id);

    if (!row) {
        const maxIdRow = db
            .prepare(`
                SELECT MAX(circle_id) AS max_id
                FROM members
            `)
            .get();

        const dbCircleId =
            maxIdRow && maxIdRow.max_id
                ? maxIdRow.max_id + 1
                : 1;

        const joinDate = member.joinedTimestamp
            ? Math.floor(member.joinedTimestamp / 1000)
            : now();

        db.prepare(`
            INSERT INTO members
            (user_id, circle_id, join_date)
            VALUES (?, ?, ?)
        `).run(
            member.id,
            dbCircleId,
            joinDate
        );

        row = {
            circle_id: dbCircleId,
            join_date: joinDate
        };
    }

    // Si un rôle CIRCLE ID existe déjà sur le membre, il est la source d'affichage.
    // On ne crée pas d'autre rôle et on ne modifie pas la DB avec cet ID pour éviter les doublons SQLite.
    if (roleCircleId) {
        return roleCircleId;
    }

    // Création du rôle Circle ID.

    const roleName =
        `CIRCLE ID — #${padId(row.circle_id)}`;

    let role = member.guild.roles.cache.find(
        role => role.name === roleName
    );

    if (!role) {
        try {
            role = await member.guild.roles.create({
                name: roleName,
                color: 0x5865F2,
                mentionable: false,
                reason: 'Création du rôle Circle ID'
            });
        } catch (error) {
            console.error(
                `[CIRCLE ID] Impossible de créer ${roleName}:`,
                error
            );

            role = null;
        }
    }

    if (role) {

        try {

            if (!member.roles.cache.has(role.id)) {
                await member.roles.add(role);
            }

            // Retire un éventuel ancien Circle ID.

            const oldRoles = member.roles.cache.filter(
                currentRole =>
                    /^CIRCLE ID — #\d+$/.test(currentRole.name) &&
                    currentRole.id !== role.id
            );

            for (const oldRole of oldRoles.values()) {
                await member.roles.remove(oldRole).catch(() => {});
            }

        } catch (error) {

            console.error(
                `[CIRCLE ID] Impossible d'attribuer le rôle à ${member.user.tag}:`,
                error
            );
        }
    }

    return row.circle_id;
}

async function checkAndAssignCircleStatusRoles(member) {
    if (!member || isServerBooster(member)) return;

    const inRoleName = 'In The Circle';
    const outRoleName = 'Outside The Circle';

    let inRole = member.guild.roles.cache.find(role => role.name === inRoleName);
    let outRole = member.guild.roles.cache.find(role => role.name === outRoleName);

    if (!inRole) {
        try {
            inRole = await member.guild.roles.create({ name: inRoleName, color: 0x43b581 });
        } catch {}
    }

    if (!outRole) {
        try {
            outRole = await member.guild.roles.create({ name: outRoleName, color: 0x747f8d });
        } catch {}
    }

    const hasCore = hasCoreTag(member);

    try {
        if (hasCore) {
            if (inRole && !member.roles.cache.has(inRole.id)) {
                await member.roles.add(inRole);
            }
            if (outRole && member.roles.cache.has(outRole.id)) {
                await member.roles.remove(outRole);
            }
        } else {
            if (outRole && !member.roles.cache.has(outRole.id)) {
                await member.roles.add(outRole);
            }
            if (inRole && member.roles.cache.has(inRole.id)) {
                await member.roles.remove(inRole);
            }
        }
    } catch (error) {
        console.error(`[TAG CORE] Impossible de synchroniser ${member.user.tag}:`, error?.message || error);
    }
}

async function welcomeGate(member, circle_id) {
    if (!member || isServerBooster(member)) return;
    const gate = member.guild.channels.cache.find(c => c.name === 'gate' && c.type === ChannelType.GuildText);
    if (!gate) return;
    const phrase = randomFromArray(WELCOME_PHRASES);
    const embed = new EmbedBuilder()
        .setTitle(phrase)
        .setDescription(`Bienvenue <@${member.id}> dans le Cercle !\n\n**Circle ID :** #${padId(circle_id)}`)
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .setColor(0x5865F2)
        .setTimestamp();
    try { await gate.send({ embeds: [embed] }); } catch {}
}

// --------- Slash Commands ---------
const commands = [
    new SlashCommandBuilder()
        .setName('drop')
        .setDescription('Créer un Drop')
        .addSubcommand(sc => sc.setName('create').setDescription('Créer un nouveau Drop'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder()
        .setName('signal')
        .setDescription('Lancer un Signal')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder()
        .setName('chosen-one')
        .setDescription('Désigner un Chosen One')
        .addUserOption(opt => opt.setName('membre').setDescription('Membre à choisir').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Afficher le profil Cercle')
        .addUserOption(opt => opt.setName('membre').setDescription('Membre à afficher'))
        .setDefaultMemberPermissions(null),
    new SlashCommandBuilder()
        .setName('sync-circle')
        .setDescription('Forcer la synchronisation des systèmes The Circle')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder()
        .setName('list')
        .setDescription('Afficher toutes les informations des membres')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder()
        .setName('pmodif')
        .setDescription('Modifier le profil Cercle d\'un membre')
        .addUserOption(opt => opt.setName('membre').setDescription('Membre à modifier').setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder()
        .setName('ajuste')
        .setDescription('Supprimer définitivement un Circle ID et décaler les suivants')
        .addIntegerOption(opt => opt.setName('id').setDescription('Circle ID à supprimer').setRequired(true).setMinValue(1))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder()
        .setName('idmodif')
        .setDescription("Modifier l'ID database d'un membre")
        .addUserOption(opt => opt.setName('membre').setDescription('Membre à modifier').setRequired(true))
        .addIntegerOption(opt => opt.setName('id').setDescription('Nouvel ID database').setRequired(true).setMinValue(0))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
].map(cmd => cmd.toJSON());

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );
        console.log('[CMD] Commandes enregistrées.');
    } catch (e) {
        console.error('[CMD]', e);
    }
}

// --------- Gestion des Drops ---------
function parseDateTimeBrussels(str) {
    // Format : JJ HH:MM, exemple : 06 16:30
    // Le bot met automatiquement le mois et l'année actuels.
    // Si la date est déjà passée ce mois-ci, il prend le mois suivant.
    const match = str.trim().match(/^(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (!match) return null;

    const day = Number(match[1]);
    const hour = Number(match[2]);
    const minute = Number(match[3]);

    if (day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    const currentDate = new Date();
    let year = currentDate.getFullYear();
    let month = currentDate.getMonth() + 1;

    let timestamp = brusselsLocalToUnix(year, month, day, hour, minute);

    if (!timestamp || timestamp <= now()) {
        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
        timestamp = brusselsLocalToUnix(year, month, day, hour, minute);
    }

    return timestamp;
}

function brusselsLocalToUnix(year, month, day, hour, minute) {
    try {
        const daysInMonth = new Date(year, month, 0).getDate();
        if (day > daysInMonth) return null;

        const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Brussels',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });

        const parts = formatter.formatToParts(new Date(utcGuess));
        const brusselsAsUtc = Date.UTC(
            Number(parts.find(part => part.type === 'year').value),
            Number(parts.find(part => part.type === 'month').value) - 1,
            Number(parts.find(part => part.type === 'day').value),
            Number(parts.find(part => part.type === 'hour').value),
            Number(parts.find(part => part.type === 'minute').value),
            Number(parts.find(part => part.type === 'second').value)
        );

        const offset = brusselsAsUtc - utcGuess;
        return Math.floor((Date.UTC(year, month - 1, day, hour, minute, 0) - offset) / 1000);
    } catch {
        return null;
    }
}

async function scheduleDrop(drop) {
    // Planifie transitions LIVE/CLOSED (ne dépasse jamais les timeouts Node)
    const tsNow = now();
    if (drop.status === 'PENDING' && drop.start_time > tsNow) {
        let delay = Math.min((drop.start_time - tsNow) * 1000, 2 ** 31 - 1);
        dropTimers.set(drop.drop_id, setTimeout(() => scheduleDrop(drop), delay));
    } else if (drop.status === 'PENDING' && drop.start_time <= tsNow) {
        await goLiveDrop(drop.drop_id);
    } else if (drop.status === 'LIVE' && drop.end_time > tsNow) {
        let delay = Math.min((drop.end_time - tsNow) * 1000, 2 ** 31 - 1);
        dropLiveTimers.set(drop.drop_id, setTimeout(() => scheduleDrop(drop), delay));
    } else if (drop.status === 'LIVE' && drop.end_time <= tsNow) {
        await closeDrop(drop.drop_id);
    }
}

async function goLiveDrop(drop_id) {
    const drop = db.prepare('SELECT * FROM drops WHERE drop_id = ?').get(drop_id);
    if (!drop || drop.status !== 'PENDING') return;

    db.prepare('UPDATE drops SET status = ? WHERE drop_id = ?').run('LIVE', drop_id);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;

    const channel = guild.channels.cache.get(drop.channel_id);
    if (!channel) return;

    let msg;
    try { msg = await channel.messages.fetch(drop.message_id); } catch { return; }

    const embed = EmbedBuilder.from(msg.embeds[0])
        .setTitle(`🌕 CIRCLE DROP #${padId(drop.number)} — LIVE`)
        .setDescription(
            `Le Drop est maintenant **LIVE** !\n\n` +
            `**Récompense :** ${drop.prize}\n` +
            `**Fin :** ${toDiscordTimestamp(drop.end_time)}\n` +
            `**Nombre de gagnants :** ${drop.winner_count}\n` +
            (drop.conditions ? `**Conditions :** ${drop.conditions}\n` : '') +
            (drop.tag_req ? `**Tag requis :** ${drop.tag_req}\n` : '') +
            `\nAppuyez sur le bouton ci-dessous pour rejoindre le Drop.`
        )
        .setColor(0x43b581)
        .setTimestamp();

    const btn = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`drop_participate_${drop.drop_id}`)
            .setLabel('Rejoindre')
            .setStyle(ButtonStyle.Success)
    );

    await msg.edit({ embeds: [embed], components: [btn] });
    await scheduleDrop({ ...drop, status: 'LIVE' });
}

async function closeDrop(drop_id) {
    const drop = db.prepare('SELECT * FROM drops WHERE drop_id = ?').get(drop_id);
    if (!drop || drop.status === 'CLOSED') return;

    db.prepare('UPDATE drops SET status = ? WHERE drop_id = ?').run('CLOSED', drop_id);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;

    const channel = guild.channels.cache.get(drop.channel_id);
    if (!channel) return;

    let msg;
    try { msg = await channel.messages.fetch(drop.message_id); } catch { return; }

    // On ferme tout de suite le bouton pour empêcher toute participation après l’heure de fin.
    await msg.edit({ components: [] }).catch(() => {});

    const participantRows = db
        .prepare('SELECT user_id FROM drop_participants WHERE drop_id = ?')
        .all(drop_id);

    const participantIds = participantRows.map(row => row.user_id);
    const eligible = [];

    for (const uid of participantIds) {
        const member = await fetchFreshGuildMember(guild, uid);
        if (!member || member.user.bot || isServerBooster(member)) continue;
        if (!memberMatchesDropTag(member, drop.tag_req)) continue;
        eligible.push(uid);
    }

    let winners = [];
    const pool = [...eligible];

    for (let i = 0; i < Math.min(drop.winner_count, pool.length); ++i) {
        const idx = Math.floor(Math.random() * pool.length);
        winners.push(pool[idx]);
        pool.splice(idx, 1);
    }

    for (const uid of winners) {
        const member = await fetchFreshGuildMember(guild, uid);
        if (member && !isServerBooster(member) && hasCircleStatusRole(member)) {
            if (!db.prepare('SELECT 1 FROM members WHERE user_id = ?').get(uid)) await ensureCircleMember(member);
            db.prepare('UPDATE members SET drop_wins = drop_wins + 1 WHERE user_id = ?').run(uid);
        }
    }

    db.prepare('UPDATE drops SET winner_ids = ? WHERE drop_id = ?').run(JSON.stringify(winners), drop_id);

    const embed = EmbedBuilder.from(msg.embeds[0])
        .setTitle(`🌑 CIRCLE DROP #${padId(drop.number)} — CLOSED`)
        .setColor(0x747f8d)
        .setDescription(
            `Le Drop est **clôturé**. Les participations sont fermées.\n\n` +
            `**Récompense :** ${drop.prize}\n` +
            `**Participants enregistrés :** ${participantIds.length}\n` +
            `**Participants éligibles :** ${eligible.length}\n` +
            `**Nombre de gagnants :** ${drop.winner_count}\n` +
            (drop.conditions ? `**Conditions :** ${drop.conditions}\n` : '') +
            (drop.tag_req ? `**Tag requis :** ${drop.tag_req}\n` : '') +
            (winners.length > 0
                ? `\n**Gagnant${winners.length > 1 ? 's' : ''} :**\n${winners.map(id => `<@${id}>`).join('\n')}`
                : '\nAucun gagnant éligible.')
        )
        .setTimestamp();

    await msg.edit({ embeds: [embed], components: [] });
}

// --------- Gestion des Signals ---------
async function scheduleSignal(signal) {
    const delay = Math.min((signal.end_time - now()) * 1000, 2 ** 31 - 1);
    if (delay > 0)
        signalTimers.set(signal.signal_id, setTimeout(() => scheduleSignal(signal), delay));
    else
        await closeSignal(signal.signal_id);
}

async function closeSignal(signal_id) {
    const signal = db.prepare('SELECT * FROM signals WHERE signal_id = ?').get(signal_id);
    if (!signal) return;
    db.prepare('UPDATE signals SET status = ? WHERE signal_id = ?').run('CLOSED', signal_id);
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    const channel = guild.channels.cache.get(signal.channel_id);
    if (!channel) return;
    let msg;
    try { msg = await channel.messages.fetch(signal.message_id); } catch { return; }
    const participants = JSON.parse(signal.participants || '[]');
    const embed = EmbedBuilder.from(msg.embeds[0])
        .setTitle('🌑 THE SIGNAL — CLOSED')
        .setColor(0x747f8d)
        .setDescription(
            `Le Signal est **fermé**.\n\n${signal.reward ? `**Récompense :** ${signal.reward}\n` : ''}` +
            `**Places :** ${signal.places}\n${signal.tag_req ? `**Tag requis :** ${signal.tag_req}\n` : ''}` +
            (participants.length > 0
                ? `\n**Participants :**\n${participants.map(id => `<@${id}>`).join('\n')}`
                : '\nAucun participant.')
        );
    await msg.edit({ embeds: [embed], components: [] });
}

// --------- Gestion Chosen One ---------
async function scheduleChosenOneExpirations() {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    const rows = db.prepare('SELECT * FROM chosen_one_expirations').all();
    for (const row of rows) {
        const member = guild.members.cache.get(row.user_id);
        const role = guild.roles.cache.get(row.role_id);
        if (member && isServerBooster(member)) {
            db.prepare('DELETE FROM chosen_one_expirations WHERE user_id = ?').run(row.user_id);
            continue;
        }
        if (!member || !role) {
            db.prepare('DELETE FROM chosen_one_expirations WHERE user_id = ?').run(row.user_id);
            continue;
        }
        const delay = Math.max(0, row.expires_at - now());
        if (delay <= 0) {
            try { await member.roles.remove(role); } catch {}
            db.prepare('DELETE FROM chosen_one_expirations WHERE user_id = ?').run(row.user_id);
        } else {
            setTimeout(async () => {
                try { await member.roles.remove(role); } catch {}
                db.prepare('DELETE FROM chosen_one_expirations WHERE user_id = ?').run(row.user_id);
            }, Math.min(delay * 1000, 2 ** 31 - 1));
        }
    }
}

// --------- Gestion Profile ---------
async function handleProfile(interaction) {
    const user = interaction.options.getUser('membre') || interaction.user;
    const member = interaction.guild.members.cache.get(user.id);
    if (!member) {
        return await interaction.reply({ content: "Ce membre n'est pas encore disponible pour le bot. Réessaie après qu'il ait parlé ou rejoint un salon.", ephemeral: true });
    }
    if (isServerBooster(member)) {
        return await interaction.reply({ content: "Ce membre est Server Booster, le bot l'ignore volontairement.", ephemeral: true });
    }
    let row = db.prepare('SELECT * FROM members WHERE user_id = ?').get(user.id);
    if (!row) {
        const createdId = await ensureCircleMember(member);
        if (!createdId) {
            return await interaction.reply({ content: "Ce membre n'a pas encore de profil The Circle.", ephemeral: true });
        }
        row = db.prepare('SELECT * FROM members WHERE user_id = ?').get(user.id);
    }
    const roleCircleId = getCircleIdFromRole(member);
    const circle_id = roleCircleId || row.circle_id;
    // Statut In/Outside
    const inRole = interaction.guild.roles.cache.find(r => r.name === 'In The Circle');
    const outRole = interaction.guild.roles.cache.find(r => r.name === 'Outside The Circle');
    let status = 'Inconnu';
    if (inRole && member.roles.cache.has(inRole.id)) status = 'In The Circle';
    else if (outRole && member.roles.cache.has(outRole.id)) status = 'Outside The Circle';
    const embed = new EmbedBuilder()
        .setTitle(`Profil Cercle de ${user.username}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .setColor(0x5865F2)
        .addFields(
            { name: 'Circle ID', value: `#${padId(circle_id)}${roleCircleId ? ' *(rôle)*' : ''}`, inline: true },
            { name: 'Statut', value: status, inline: true },
            { name: 'Date d\'entrée', value: toDiscordTimestamp(row.join_date, 'D'), inline: false },
            { name: 'Ancienneté', value: getSeniority(row.join_date), inline: true },
            { name: 'Drops / Signals gagnés', value: `${row.drop_wins}`, inline: true },
            { name: 'Chosen One', value: `${row.chosen_one_count}`, inline: true }
        );
    await interaction.reply({ embeds: [embed], ephemeral: false });
}

// --------- Helper Functions for Admin Commands ---------

function getMemberCircleData(member) {
    const row = db.prepare('SELECT * FROM members WHERE user_id = ?').get(member.id);
    const roleCircleId = getCircleIdFromRole(member);
    const circleId = roleCircleId || row?.circle_id || null;
    const status = member.roles.cache.some(r => r.name === 'In The Circle')
        ? 'In The Circle'
        : member.roles.cache.some(r => r.name === 'Outside The Circle')
            ? 'Outside The Circle'
            : 'Aucun';
    const dropParticipations = db.prepare('SELECT COUNT(*) AS count FROM drop_participants WHERE user_id = ?').get(member.id)?.count || 0;
    const signalParticipations = db.prepare('SELECT COUNT(*) AS count FROM signal_participants WHERE user_id = ?').get(member.id)?.count || 0;

    return {
        row,
        circleId,
        status,
        hasCore: hasCoreTag(member),
        dropParticipations,
        signalParticipations
    };
}

async function handleList(interaction) {
    await interaction.deferReply({ ephemeral: true });
    await fetchAllMembersSafely(interaction.guild, true);

    const members = [...interaction.guild.members.cache.values()]
        .filter(member => !member.user.bot && !isServerBooster(member))
        .map(member => ({ member, data: getMemberCircleData(member) }))
        .filter(entry => entry.data.row || entry.data.circleId || entry.data.status !== 'Aucun')
        .sort((a, b) => (a.data.circleId || Number.MAX_SAFE_INTEGER) - (b.data.circleId || Number.MAX_SAFE_INTEGER));

    if (members.length === 0) {
        return await interaction.editReply({ content: 'Aucun membre The Circle enregistré.' });
    }

    const pages = [];
    for (let i = 0; i < members.length; i += 5) {
        const chunk = members.slice(i, i + 5);
        const embed = new EmbedBuilder()
            .setTitle('📋 THE CIRCLE — MEMBER LIST')
            .setColor(0x5865F2)
            .setDescription(chunk.map(({ member, data }) => {
                const id = data.circleId ? `#${padId(data.circleId)}` : 'Aucun';
                const joinDate = data.row?.join_date ? toDiscordTimestamp(data.row.join_date, 'D') : 'Non enregistrée';
                const seniority = data.row?.join_date ? getSeniority(data.row.join_date) : 'Non enregistrée';
                return `**${member.user.username}** — <@${member.id}>\n🪪 ID : ${id} | 🌕 Statut : ${data.status} | 🏷️ CORE : ${data.hasCore ? 'Oui' : 'Non'}\n📅 Entrée : ${joinDate} | ⏳ Ancienneté : ${seniority}\n🎁 Drops/Signals participés : ${data.dropParticipations + data.signalParticipations} | 🏆 Drops/Signals gagnés : ${data.row?.drop_wins || 0}\n📡 Signals participés : ${data.signalParticipations} | 👑 Chosen One : ${data.row?.chosen_one_count || 0}`;
            }).join('\n\n'))
            .setFooter({ text: `Page ${Math.floor(i / 5) + 1}/${Math.ceil(members.length / 5)} — ${members.length} membres` });
        pages.push(embed);
    }

    await interaction.editReply({ embeds: [pages[0]] });
    for (let i = 1; i < pages.length; i++) {
        await interaction.followUp({ embeds: [pages[i]], ephemeral: true });
    }
}

async function handleProfileModifyCommand(interaction) {
    const member = interaction.options.getMember('membre');
    if (!member) return await interaction.reply({ content: 'Membre introuvable.', ephemeral: true });
    if (isServerBooster(member)) return await interaction.reply({ content: 'Ce membre est Server Booster, le bot l\'ignore volontairement.', ephemeral: true });

    let row = db.prepare('SELECT * FROM members WHERE user_id = ?').get(member.id);
    if (!row) {
        await ensureCircleMember(member);
        row = db.prepare('SELECT * FROM members WHERE user_id = ?').get(member.id);
    }
    if (!row) return await interaction.reply({ content: 'Ce membre ne possède pas de profil The Circle.', ephemeral: true });

    const modal = new ModalBuilder()
        .setCustomId(`pmodif_modal_${member.id}`)
        .setTitle(`Modifier ${member.user.username}`)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('join_date').setLabel('Date entrée Unix (laisser vide = inchangé)').setStyle(TextInputStyle.Short).setRequired(false)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('drop_wins').setLabel('Drops gagnés').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(row.drop_wins || 0))
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('chosen_count').setLabel('Nombre de Chosen One').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(row.chosen_one_count || 0))
            )
        );

    await interaction.showModal(modal);
}

async function handleAdjustCircleId(interaction) {
    const circleId = interaction.options.getInteger('id');
    const target = db.prepare('SELECT * FROM members WHERE circle_id = ?').get(circleId);
    if (!target) return await interaction.reply({ content: `Le Circle ID #${padId(circleId)} n'existe pas dans la base de données.`, ephemeral: true });

    await interaction.deferReply({ ephemeral: true });
    await fetchAllMembersSafely(interaction.guild, true);

    const targetMember = interaction.guild.members.cache.get(target.user_id);
    if (targetMember) {
        const targetRoles = targetMember.roles.cache.filter(role => /^CIRCLE ID — #\d+$/.test(role.name));
        for (const role of targetRoles.values()) await targetMember.roles.remove(role).catch(() => {});
    }

    const rowsToShift = db.prepare('SELECT user_id, circle_id FROM members WHERE circle_id > ? ORDER BY circle_id ASC').all(circleId);

    const transaction = db.transaction(() => {
        for (const row of rowsToShift) {
            db.prepare('UPDATE members SET circle_id = ? WHERE user_id = ?').run(-row.circle_id, row.user_id);
        }
        db.prepare('DELETE FROM members WHERE user_id = ?').run(target.user_id);
        for (const row of rowsToShift) {
            db.prepare('UPDATE members SET circle_id = ? WHERE user_id = ?').run(row.circle_id - 1, row.user_id);
        }
    });
    transaction();

    for (const row of rowsToShift) {
        const member = interaction.guild.members.cache.get(row.user_id);
        if (!member || isServerBooster(member)) continue;
        const oldRoleName = `CIRCLE ID — #${padId(row.circle_id)}`;
        const newRoleName = `CIRCLE ID — #${padId(row.circle_id - 1)}`;
        const oldRole = interaction.guild.roles.cache.find(role => role.name === oldRoleName);
        let newRole = interaction.guild.roles.cache.find(role => role.name === newRoleName);
        if (!newRole) {
            newRole = await interaction.guild.roles.create({ name: newRoleName, color: 0x5865F2, mentionable: false, reason: 'Ajustement des Circle ID' }).catch(() => null);
        }
        if (newRole && !member.roles.cache.has(newRole.id)) await member.roles.add(newRole).catch(() => {});
        if (oldRole && member.roles.cache.has(oldRole.id)) await member.roles.remove(oldRole).catch(() => {});
    }

    const unusedRoles = interaction.guild.roles.cache.filter(role => {
        const match = role.name.match(/^CIRCLE ID — #(\d+)$/);
        return match && Number(match[1]) > rowsToShift.length + circleId - 1;
    });
    for (const role of unusedRoles.values()) {
        if (role.members.size === 0) await role.delete('Suppression d’un ancien rôle Circle ID inutilisé').catch(() => {});
    }

    await interaction.editReply({ content: `Circle ID #${padId(circleId)} supprimé définitivement. Les ID suivants ont été décalés.` });
}

async function handleIdModify(interaction) {
    const member = interaction.options.getMember('membre');
    const newId = interaction.options.getInteger('id');

    if (!member) {
        return await interaction.reply({ content: 'Membre introuvable.', ephemeral: true });
    }

    if (isServerBooster(member)) {
        return await interaction.reply({ content: "Ce membre est Server Booster, le bot l'ignore volontairement.", ephemeral: true });
    }

    if (!hasCircleStatusRole(member)) {
        return await interaction.reply({ content: "Ce membre n'a pas encore de rôle The Circle (`In The Circle` ou `Outside The Circle`).", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    await fetchAllMembersSafely(interaction.guild, true);

    let row = db.prepare('SELECT * FROM members WHERE user_id = ?').get(member.id);
    if (!row) {
        await ensureCircleMember(member);
        row = db.prepare('SELECT * FROM members WHERE user_id = ?').get(member.id);
    }

    if (!row) {
        return await interaction.editReply({ content: "Impossible de créer ou trouver le profil The Circle de ce membre." });
    }

    const currentId = row.circle_id;
    const conflict = db.prepare('SELECT user_id, circle_id FROM members WHERE circle_id = ? AND user_id != ?').get(newId, member.id);

    if (conflict) {
        const otherMember = interaction.guild.members.cache.get(conflict.user_id);

        const transaction = db.transaction(() => {
            db.prepare('UPDATE members SET circle_id = ? WHERE user_id = ?').run(-999999, member.id);
            db.prepare('UPDATE members SET circle_id = ? WHERE user_id = ?').run(currentId, conflict.user_id);
            db.prepare('UPDATE members SET circle_id = ? WHERE user_id = ?').run(newId, member.id);
        });
        transaction();

        await applyCircleIdRole(member, newId, interaction.guild, 'Switch manuel du Circle ID');
        if (otherMember) {
            await applyCircleIdRole(otherMember, currentId, interaction.guild, 'Switch manuel du Circle ID');
        }

        return await interaction.editReply({
            content: `Switch effectué : <@${member.id}> a maintenant **#${padId(newId)}** et <@${conflict.user_id}> a maintenant **#${padId(currentId)}**.`
        });
    }

    db.prepare('UPDATE members SET circle_id = ? WHERE user_id = ?').run(newId, member.id);
    await applyCircleIdRole(member, newId, interaction.guild, 'Modification manuelle du Circle ID database');

    await interaction.editReply({ content: `L'ID database de <@${member.id}> est maintenant **#${padId(newId)}**.` });
}

async function applyCircleIdRole(member, circleId, guild, reason = 'Modification du Circle ID') {
    const oldIdRoles = member.roles.cache.filter(role => /^CIRCLE ID — #\d+$/.test(role.name));
    for (const role of oldIdRoles.values()) {
        await member.roles.remove(role).catch(() => {});
    }

    const roleName = `CIRCLE ID — #${padId(circleId)}`;
    let newRole = guild.roles.cache.find(role => role.name === roleName);
    if (!newRole) {
        newRole = await guild.roles.create({
            name: roleName,
            color: 0x5865F2,
            mentionable: false,
            reason
        }).catch(() => null);
    }

    if (newRole) {
        await member.roles.add(newRole).catch(() => {});
    }
}

// --------- Synchronisation Circle (Admin) ---------
async function fetchAllMembersSafely(guild, force = false) {
    const cooldownMs = 10 * 60 * 1000;
    const nowMs = Date.now();

    if (!force && nowMs - lastFullMemberFetch < cooldownMs) {
        return false;
    }

    try {
        await guild.members.fetch();
        lastFullMemberFetch = Date.now();
        return true;
    } catch (error) {
        console.error('[SYNC] Impossible de récupérer tous les membres :', error?.message || error);
        return false;
    }
}

/**
 * Synchronise les rôles The Circle pour tous les membres (admin/manuel ou background).
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<{checked: number, circle: number}>}
 */
async function syncCircleSystems(guild, forceFullFetch = false) {
    await fetchAllMembersSafely(guild, forceFullFetch);

    let checked = 0;
    let circle = 0;

    for (const member of guild.members.cache.values()) {
        if (member.user.bot || isServerBooster(member)) continue;
        await member.user.fetch(true).catch(() => {});
        await checkAndAssignCircleStatusRoles(member);
        checked++;
    }

    for (const member of guild.members.cache.values()) {
        if (member.user.bot || isServerBooster(member)) continue;
        if (hasCircleStatusRole(member)) {
            await ensureCircleMember(member);
            circle++;
        }
    }

    return { checked, circle };
}

// --------- Ready ---------
client.once('ready', async () => {
    console.log(`[BOT] Connecté en tant que ${client.user.tag}`);
    await registerCommands();
    const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
    await ensureCircleIdsForGuild(guild);
    await syncCircleSystems(guild, true);
    // Drops
    const drops = db.prepare("SELECT * FROM drops WHERE status IN ('PENDING', 'LIVE')").all();
    for (const drop of drops) await scheduleDrop(drop);
    // Signals
    const signals = db.prepare("SELECT * FROM signals WHERE status IS NULL OR status != 'CLOSED'").all();
    for (const signal of signals) await scheduleSignal(signal);
    // Chosen One expirations
    await scheduleChosenOneExpirations();
    // Vérification statuts toute heure
    setInterval(async () => {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return;
        await syncCircleSystems(guild, true);
    }, 60 * 60 * 1000);
});

client.on('guildMemberAdd', async member => {
    if (member.user.bot) return;
    if (isServerBooster(member)) return;
    await checkAndAssignCircleStatusRoles(member);
    const circleId = await ensureCircleMember(member);
    if (circleId) await welcomeGate(member, circleId);
});

client.on('guildMemberUpdate', async (oldM, newM) => {
    if (newM.user.bot) return;
    if (isServerBooster(newM)) return;
    await newM.user.fetch(true).catch(() => {});
    await checkAndAssignCircleStatusRoles(newM);
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            if (['drop', 'signal', 'chosen-one', 'sync-circle', 'list', 'pmodif', 'ajuste', 'idmodif'].includes(interaction.commandName)) {
                if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
                    return await interaction.reply({ content: "Seuls les administrateurs peuvent utiliser cette commande.", ephemeral: true });
                }
            }
            if (interaction.commandName === 'drop' && interaction.options.getSubcommand() === 'create') {
                // Modal Drop
                const modal = new ModalBuilder()
                    .setCustomId('drop_create_modal')
                    .setTitle('Créer un Drop')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('prize').setLabel('Lot à gagner').setStyle(TextInputStyle.Short).setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('winner_count').setLabel('Nombre de gagnants').setStyle(TextInputStyle.Short).setRequired(true).setValue('1')
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('start_time').setLabel('Début (JJ HH:MM)').setStyle(TextInputStyle.Short).setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('end_time').setLabel('Fin (JJ HH:MM)').setStyle(TextInputStyle.Short).setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('requirements').setLabel('TAG=CORE | CONDITIONS=... (format)').setStyle(TextInputStyle.Paragraph).setRequired(false)
                        ),
                    );
                await interaction.showModal(modal);
            } else if (interaction.commandName === 'signal') {
                // Modal Signal
                const modal = new ModalBuilder()
                    .setCustomId('signal_create_modal')
                    .setTitle('Lancer un Signal')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('duration').setLabel('Durée (minutes)').setStyle(TextInputStyle.Short).setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('places').setLabel('Nombre de places').setStyle(TextInputStyle.Short).setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('reward').setLabel('Récompense (optionnel)').setStyle(TextInputStyle.Short).setRequired(false)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('tag_req').setLabel('Tag requis ("CORE" ou vide)').setStyle(TextInputStyle.Short).setRequired(false)
                        ),
                    );
                await interaction.showModal(modal);
            } else if (interaction.commandName === 'chosen-one') {
                // Modal Chosen One
                const member = interaction.options.getMember('membre');
                if (!member) return await interaction.reply({ content: "Membre introuvable.", ephemeral: true });
                if (isServerBooster(member)) return await interaction.reply({ content: "Ce membre est Server Booster, le bot l'ignore volontairement.", ephemeral: true });
                const modal = new ModalBuilder()
                    .setCustomId(`chosen_one_modal_${member.id}`)
                    .setTitle('Désigner un Chosen One')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('reason').setLabel('Raison').setStyle(TextInputStyle.Paragraph).setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('duration').setLabel('Durée (jours)').setStyle(TextInputStyle.Short).setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('temp_role').setLabel('Créer un rôle temporaire ? (oui/non)').setStyle(TextInputStyle.Short).setRequired(true).setValue('oui')
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('hide_reason').setLabel('Cacher la raison ? (oui/non)').setStyle(TextInputStyle.Short).setRequired(true).setValue('non')
                        ),
                    );
                await interaction.showModal(modal);
            } else if (interaction.commandName === 'profile') {
                await handleProfile(interaction);
            } else if (interaction.commandName === 'sync-circle') {
                await interaction.deferReply({ ephemeral: true });
                const { checked, circle } = await syncCircleSystems(interaction.guild, true);
                await interaction.editReply({
                    content: `Synchronisation terminée. Membres vérifiés : ${checked}. Membres The Circle synchronisés : ${circle}.`
                });
            } else if (interaction.commandName === 'list') {
                await handleList(interaction);
            } else if (interaction.commandName === 'pmodif') {
                await handleProfileModifyCommand(interaction);
            } else if (interaction.commandName === 'ajuste') {
                await handleAdjustCircleId(interaction);
            } else if (interaction.commandName === 'idmodif') {
                await handleIdModify(interaction);
            }
        } else if (interaction.type === InteractionType.ModalSubmit) {
            // Drop create
            if (interaction.customId === 'drop_create_modal') {
                const prize = interaction.fields.getTextInputValue('prize').trim();
                const winner_count = parseInt(interaction.fields.getTextInputValue('winner_count'));
                const start_time = parseDateTimeBrussels(interaction.fields.getTextInputValue('start_time'));
                const end_time = parseDateTimeBrussels(interaction.fields.getTextInputValue('end_time'));
                let tag_req = '';
                let conditions = '';
                const reqField = (interaction.fields.getTextInputValue('requirements') || '').trim();
                if (reqField) {
                    const tagMatch = reqField.match(/TAG\s*=\s*([^\|]+)/i);
                    if (tagMatch) tag_req = tagMatch[1].trim();
                    const condMatch = reqField.match(/CONDITIONS\s*=\s*(.+)$/i);
                    if (condMatch) conditions = condMatch[1].trim();
                }
                if (!prize || !Number.isInteger(winner_count) || winner_count < 1 || !start_time || !end_time || end_time <= start_time) {
                    return await interaction.reply({ content: "Entrées invalides. Format attendu : `JJ HH:MM`, exemple `06 16:30`.", ephemeral: true });
                }
                const max = db.prepare('SELECT MAX(number) as m FROM drops').get();
                const number = (max && max.m) ? max.m + 1 : 1;
                const channel = interaction.channel;
                if (!channel) return await interaction.reply({ content: "Canal introuvable.", ephemeral: true });
                const embed = new EmbedBuilder()
                    .setTitle(`🌕 CIRCLE DROP #${padId(number)}`)
                    .setDescription(
                        `Un Drop arrive bientôt **${toDiscordTimestamp(start_time)}**.\n\n` +
                        `**Récompense :** ||Surprise||\n` +
                        `**Début :** ${toDiscordTimestamp(start_time, 'F')}\n` +
                        `**Fin :** ${toDiscordTimestamp(end_time, 'F')}\n` +
                        `**Nombre de gagnants :** ${winner_count}\n` +
                        (conditions ? `**Conditions :** ${conditions}\n` : '') +
                        (tag_req ? `**Tag requis :** ${tag_req}\n` : '')
                    )
                    .setColor(0xfee75c)
                    .setTimestamp()
                    .setFooter({ text: `Drop #${padId(number)}` });
                await interaction.reply({ content: "Drop créé !", ephemeral: true });
                const msg = await channel.send({ embeds: [embed] });
                const drop_id = db.prepare(
                    'INSERT INTO drops (number, prize, winner_count, start_time, end_time, tag_req, conditions, status, channel_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                ).run(number, prize, winner_count, start_time, end_time, tag_req, conditions, 'PENDING', channel.id, msg.id).lastInsertRowid;
                await scheduleDrop({ drop_id, status: 'PENDING', start_time, end_time, number });
            }
            // Signal create
            else if (interaction.customId === 'signal_create_modal') {
                const duration = parseInt(interaction.fields.getTextInputValue('duration'));
                const places = parseInt(interaction.fields.getTextInputValue('places'));
                const reward = interaction.fields.getTextInputValue('reward') || '';
                const tag_req = interaction.fields.getTextInputValue('tag_req') || '';
                if (!Number.isInteger(duration) || duration < 1 || !Number.isInteger(places) || places < 1) return await interaction.reply({ content: "Entrées invalides.", ephemeral: true });
                const end_time = now() + duration * 60;
                const embed = new EmbedBuilder()
                    .setTitle('🌑 THE SIGNAL')
                    .setDescription(
                        `Un Signal est lancé !\n\n**Durée :** ${duration}min (${toDiscordTimestamp(end_time)})\n` +
                        `**Places :** ${places}\n` +
                        (reward ? `**Récompense :** ${reward}\n` : '') +
                        (tag_req ? `**Tag requis :** ${tag_req}\n` : '') +
                        `\nAppuyez sur le bouton pour participer.`
                    )
                    .setColor(0xfee75c)
                    .setTimestamp();
                const btn = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('signal_participate').setLabel('Participer').setStyle(ButtonStyle.Primary)
                );
                const msg = await interaction.channel.send({ embeds: [embed], components: [btn] });
                const signal_id = db.prepare(
                    'INSERT INTO signals (channel_id, message_id, end_time, places, reward, tag_req, participants, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                ).run(msg.channel.id, msg.id, end_time, places, reward, tag_req, JSON.stringify([]), 'OPEN').lastInsertRowid;
                await scheduleSignal({ signal_id, end_time });
                await interaction.reply({ content: "Signal lancé !", ephemeral: true });
            }
            // Chosen One modal
            else if (interaction.customId.startsWith('chosen_one_modal_')) {
                const memberId = interaction.customId.split('_').pop();
                const member = interaction.guild.members.cache.get(memberId);
                if (!member) return await interaction.reply({ content: "Membre introuvable.", ephemeral: true });
                if (isServerBooster(member)) return await interaction.reply({ content: "Ce membre est Server Booster, le bot l'ignore volontairement.", ephemeral: true });
                const reason = interaction.fields.getTextInputValue('reason');
                const duration = parseInt(interaction.fields.getTextInputValue('duration'));
                const temp_role = interaction.fields.getTextInputValue('temp_role').toLowerCase() === 'oui';
                const hide_reason = interaction.fields.getTextInputValue('hide_reason').toLowerCase() === 'oui';
                if (!reason || !Number.isInteger(duration) || duration < 1) return await interaction.reply({ content: "Entrées invalides.", ephemeral: true });
                let row = db.prepare('SELECT * FROM members WHERE user_id = ?').get(memberId);
                if (!row) await ensureCircleMember(member);
                db.prepare('UPDATE members SET chosen_one_count = chosen_one_count + 1 WHERE user_id = ?').run(memberId);
                let role;
                if (temp_role) {
                    role = interaction.guild.roles.cache.find(r => r.name === 'THE CHOSEN ONE');
                    if (!role) try { role = await interaction.guild.roles.create({ name: 'THE CHOSEN ONE', color: 0xff0000, hoist: true }); } catch {}
                    try { if (role && !member.roles.cache.has(role.id)) await member.roles.add(role); } catch {}
                    if (role) {
                        const expires_at = now() + duration * 24 * 60 * 60;
                        db.prepare('INSERT OR REPLACE INTO chosen_one_expirations (user_id, role_id, expires_at) VALUES (?, ?, ?)').run(memberId, role.id, expires_at);
                        setTimeout(async () => {
                            try { await member.roles.remove(role); } catch {}
                            db.prepare('DELETE FROM chosen_one_expirations WHERE user_id = ?').run(memberId);
                        }, Math.min(duration * 24 * 60 * 60 * 1000, 2 ** 31 - 1));
                    }
                }
                const embed = new EmbedBuilder()
                    .setTitle('👑 THE CHOSEN ONE')
                    .setDescription(
                        `<@${memberId}> a été désigné comme **Chosen One** pour ${duration} jour${duration > 1 ? 's' : ''} !` +
                        (!hide_reason ? `\n\n**Raison :** ${reason}` : '')
                    )
                    .setImage(member.user.displayAvatarURL({ size: 512 }))
                    .setColor(0xff0000)
                    .setTimestamp();
                await interaction.reply({ embeds: [embed] });
            }
            else if (interaction.customId.startsWith('pmodif_modal_')) {
                const memberId = interaction.customId.replace('pmodif_modal_', '');
                const member = interaction.guild.members.cache.get(memberId);
                if (!member) return await interaction.reply({ content: 'Membre introuvable.', ephemeral: true });
                if (isServerBooster(member)) return await interaction.reply({ content: 'Ce membre est Server Booster, le bot l\'ignore volontairement.', ephemeral: true });

                const joinDateRaw = interaction.fields.getTextInputValue('join_date').trim();
                const dropWins = Number(interaction.fields.getTextInputValue('drop_wins'));
                const chosenCount = Number(interaction.fields.getTextInputValue('chosen_count'));
                const joinDate = joinDateRaw === '' ? null : Number(joinDateRaw);

                if (!Number.isInteger(dropWins) || dropWins < 0 || !Number.isInteger(chosenCount) || chosenCount < 0 || (joinDate !== null && (!Number.isInteger(joinDate) || joinDate < 1))) {
                    return await interaction.reply({ content: 'Valeurs invalides.', ephemeral: true });
                }

                if (joinDate === null) {
                    db.prepare('UPDATE members SET drop_wins = ?, chosen_one_count = ? WHERE user_id = ?').run(dropWins, chosenCount, memberId);
                } else {
                    db.prepare('UPDATE members SET join_date = ?, drop_wins = ?, chosen_one_count = ? WHERE user_id = ?').run(joinDate, dropWins, chosenCount, memberId);
                }

                await interaction.reply({ content: `Profil de <@${memberId}> modifié avec succès.`, ephemeral: true });
            }
        } else if (interaction.isButton()) {
            // Participation Drop
            if (interaction.customId.startsWith('drop_participate_')) {
                const drop_id = parseInt(interaction.customId.split('_').pop());
                const drop = db.prepare('SELECT * FROM drops WHERE drop_id = ?').get(drop_id);

                if (!drop || drop.status !== 'LIVE' || now() >= drop.end_time) {
                    if (drop && drop.status !== 'CLOSED') await closeDrop(drop.drop_id).catch(() => {});
                    return await interaction.reply({ content: "Drop terminé ou non disponible.", ephemeral: true });
                }

                const participantMember = await fetchFreshGuildMember(interaction.guild, interaction.user.id);

                if (!participantMember) {
                    return await interaction.reply({ content: "Impossible de vérifier votre profil Discord.", ephemeral: true });
                }

                if (isServerBooster(participantMember)) {
                    return await interaction.reply({ content: "Les Server Boosters sont ignorés par le bot.", ephemeral: true });
                }

                if (!memberMatchesDropTag(participantMember, drop.tag_req)) {
                    return await interaction.reply({ content: "Vous n'avez pas le tag requis pour ce Drop.", ephemeral: true });
                }

                const already = db.prepare('SELECT 1 FROM drop_participants WHERE drop_id = ? AND user_id = ?').get(drop_id, interaction.user.id);
                if (already) return await interaction.reply({ content: "Vous participez déjà.", ephemeral: true });

                db.prepare('INSERT INTO drop_participants (drop_id, user_id) VALUES (?, ?)').run(drop_id, interaction.user.id);
                await interaction.reply({ content: "Participation enregistrée !", ephemeral: true });
            }
            // Participation Signal
            else if (interaction.customId === 'signal_participate') {
                const signal = db.prepare('SELECT * FROM signals WHERE message_id = ?').get(interaction.message.id);
                const participantMember = interaction.guild.members.cache.get(interaction.user.id);
                if (participantMember && isServerBooster(participantMember)) {
                    return await interaction.reply({ content: "Les Server Boosters sont ignorés par le bot.", ephemeral: true });
                }
                if (!signal || signal.status === 'CLOSED') return await interaction.reply({ content: "Signal non actif.", ephemeral: true });
                let participants = JSON.parse(signal.participants || '[]');
                if (participants.includes(interaction.user.id)) return await interaction.reply({ content: "Vous participez déjà.", ephemeral: true });
                if (participants.length >= signal.places) return await interaction.reply({ content: "Toutes les places sont prises.", ephemeral: true });
                if (signal.tag_req && signal.tag_req.trim() !== '') {
                    const member = interaction.guild.members.cache.get(interaction.user.id);
                    if (!member) return await interaction.reply({ content: "Impossible de vérifier vos tags.", ephemeral: true });
                    if (!hasCoreTag(member)) {
                        return await interaction.reply({ content: "Vous n'avez pas le tag requis. Le rôle `In The Circle` sert de validation CORE.", ephemeral: true });
                    }
                }
                participants.push(interaction.user.id);
                db.prepare('INSERT OR IGNORE INTO signal_participants (signal_id, user_id) VALUES (?, ?)').run(signal.signal_id, interaction.user.id);

                const memberRow = db.prepare('SELECT 1 FROM members WHERE user_id = ?').get(interaction.user.id);
                if (memberRow) {
                    db.prepare('UPDATE members SET drop_wins = drop_wins + 1 WHERE user_id = ?').run(interaction.user.id);
                }

                db.prepare('UPDATE signals SET participants = ? WHERE signal_id = ?').run(JSON.stringify(participants), signal.signal_id);
                let embed = EmbedBuilder.from(interaction.message.embeds[0]);
                let desc = embed.data.description ?? '';
                desc = desc.replace(/\n+\*\*Participants :\*\*[\s\S]*?(?=(\n\n|$))/, '');
                desc = desc.replace(/\n\n\*\*Signal complet !\*\*/g, '');
                desc += `\n\n**Participants :**\n${participants.map(id => `<@${id}>`).join('\n')}`;
                if (participants.length >= signal.places) desc += '\n\n**Signal complet !**';
                embed.setDescription(desc);
                await interaction.message.edit({ embeds: [embed], components: participants.length >= signal.places ? [] : interaction.message.components });
                await interaction.reply({ content: "Participation enregistrée !", ephemeral: true });
                if (participants.length >= signal.places) {
                    await closeSignal(signal.signal_id);
                }
            }
        }
    } catch (e) {
        console.error('[Interaction]', e);
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: "Erreur : " + (e.message || e), ephemeral: true });
            } else {
                await interaction.reply({ content: "Erreur : " + (e.message || e), ephemeral: true });
            }
        } catch {}
    }
});

client.login(TOKEN);