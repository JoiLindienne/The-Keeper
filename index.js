

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
    // Le rôle In The Circle sert actuellement de validation CORE.
    return member.roles?.cache?.some(
        role => role.name === 'In The Circle'
    ) ?? false;
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

async function ensureCircleIdsForGuild(guild) {
    // Seuls les membres ayant In The Circle ou Outside The Circle
    // peuvent recevoir un Circle ID.

    const eligibleMembers = guild.members.cache.filter(
        member =>
            !member.user.bot &&
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
    // Attribue In/Outside The Circle selon le tag CORE (jamais destructif si tag non détectable)
    const inRoleName = "In The Circle";
    const outRoleName = "Outside The Circle";
    let inRole = member.guild.roles.cache.find(r => r.name === inRoleName);
    let outRole = member.guild.roles.cache.find(r => r.name === outRoleName);
    if (!inRole) try { inRole = await member.guild.roles.create({ name: inRoleName, color: 0x43b581 }); } catch {}
    if (!outRole) try { outRole = await member.guild.roles.create({ name: outRoleName, color: 0x747f8d }); } catch {}
    const hasCore = hasCoreTag(member);
    try {
        if (hasCore) {
            if (inRole && !member.roles.cache.has(inRole.id)) await member.roles.add(inRole).catch(()=>{});
            if (outRole && member.roles.cache.has(outRole.id)) await member.roles.remove(outRole).catch(()=>{});
        } else {
            const hasIn = inRole && member.roles.cache.has(inRole.id);
            const hasOut = outRole && member.roles.cache.has(outRole.id);
            if (!hasIn && !hasOut && outRole) await member.roles.add(outRole).catch(()=>{});
        }
    } catch {}
}

async function welcomeGate(member, circle_id) {
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
    // Format demandé dans le formulaire : JJ HH, exemple : 06 16
    // Le bot met automatiquement le mois et l'année actuels.
    // Si la date est déjà passée ce mois-ci, il prend le mois suivant.
    const match = str.trim().match(/^(\d{1,2})\s+(\d{1,2})$/);
    if (!match) return null;

    const day = Number(match[1]);
    const hour = Number(match[2]);
    const minute = 0;

    if (day < 1 || day > 31 || hour < 0 || hour > 23) return null;

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
    if (!drop) return;
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
            `Le Drop est maintenant **LIVE** !\n\n**Lot :** ${drop.prize}\n**Nombre de gagnants :** ${drop.winner_count}\n` +
            (drop.conditions ? `**Conditions :** ${drop.conditions}\n` : '') +
            (drop.tag_req ? `**Tag requis :** ${drop.tag_req}\n` : '') +
            `\nAppuyez sur le bouton ci-dessous pour participer.`
        )
        .setColor(0x43b581)
        .setTimestamp();
    const btn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`drop_participate_${drop.drop_id}`).setLabel('Participer').setStyle(ButtonStyle.Success)
    );
    await msg.edit({ embeds: [embed], components: [btn] });
    await scheduleDrop({ ...drop, status: 'LIVE' });
}

async function closeDrop(drop_id) {
    const drop = db.prepare('SELECT * FROM drops WHERE drop_id = ?').get(drop_id);
    if (!drop) return;
    db.prepare('UPDATE drops SET status = ? WHERE drop_id = ?').run('CLOSED', drop_id);
    const participants = db.prepare('SELECT user_id FROM drop_participants WHERE drop_id = ?').all(drop_id).map(r => r.user_id);
    let eligible = participants;
    if (drop.tag_req && drop.tag_req.trim() !== '') {
        eligible = eligible.filter(uid => {
            const m = client.guilds.cache.get(GUILD_ID).members.cache.get(uid);
            if (!m) return false;
            return hasCoreTag(m);
        });
    }
    let winners = [];
    let pool = [...eligible];
    for (let i = 0; i < Math.min(drop.winner_count, pool.length); ++i) {
        const idx = Math.floor(Math.random() * pool.length);
        winners.push(pool[idx]);
        pool.splice(idx, 1);
    }
    for (const uid of winners) {
        db.prepare('UPDATE members SET drop_wins = drop_wins + 1 WHERE user_id = ?').run(uid);
    }
    db.prepare('UPDATE drops SET winner_ids = ? WHERE drop_id = ?').run(JSON.stringify(winners), drop_id);
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    const channel = guild.channels.cache.get(drop.channel_id);
    if (!channel) return;
    let msg;
    try { msg = await channel.messages.fetch(drop.message_id); } catch { return; }
    const embed = EmbedBuilder.from(msg.embeds[0])
        .setTitle(`🌑 CIRCLE DROP #${padId(drop.number)} — CLOSED`)
        .setColor(0x747f8d)
        .setDescription(
            `Le Drop est **clôturé**.\n\n**Lot :** ${drop.prize}\n**Nombre de gagnants :** ${drop.winner_count}\n` +
            (drop.conditions ? `**Conditions :** ${drop.conditions}\n` : '') +
            (winners.length > 0
                ? `\n**Gagnant${winners.length > 1 ? 's' : ''} :**\n${winners.map(id => `<@${id}>`).join('\n')}`
                : '\nAucun gagnant éligible.')
        );
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
            { name: 'Drop wins', value: `${row.drop_wins}`, inline: true },
            { name: 'Chosen One', value: `${row.chosen_one_count}`, inline: true }
        );
    await interaction.reply({ embeds: [embed], ephemeral: false });
}

// --------- Ready ---------
client.once('ready', async () => {
    console.log(`[BOT] Connecté en tant que ${client.user.tag}`);
    await registerCommands();
    const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
    await ensureCircleIdsForGuild(guild);
    for (const member of guild.members.cache.values()) {
        if (member.user.bot) continue;
        await ensureCircleMember(member);
        await checkAndAssignCircleStatusRoles(member);
    }
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
        for (const member of guild.members.cache.values()) {
            if (member.user.bot) continue;
            await checkAndAssignCircleStatusRoles(member);
        }
    }, 60 * 60 * 1000);
});

client.on('guildMemberAdd', async member => {
    if (member.user.bot) return;
    await ensureCircleMember(member);
    await checkAndAssignCircleStatusRoles(member);
    await welcomeGate(member, db.prepare('SELECT circle_id FROM members WHERE user_id = ?').get(member.id).circle_id);
});

client.on('guildMemberUpdate', async (oldM, newM) => {
    if (newM.user.bot) return;
    await checkAndAssignCircleStatusRoles(newM);
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            if (['drop', 'signal', 'chosen-one'].includes(interaction.commandName)) {
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
                            new TextInputBuilder().setCustomId('start_time').setLabel('Début (JJ HH)').setStyle(TextInputStyle.Short).setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('end_time').setLabel('Fin (JJ HH)').setStyle(TextInputStyle.Short).setRequired(true)
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
                const modal = new ModalBuilder()
                    .setCustomId(`chosen_one_modal_${member.id}`)
                    .setTitle('Désigner un Chosen One')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('reason').setLabel('Raison').setStyle(TextInputStyle.Paragraph).setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder().setCustomId('duration').setLabel('Durée (minutes)').setStyle(TextInputStyle.Short).setRequired(true)
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
                    return await interaction.reply({ content: "Entrées invalides. Format attendu : `JJ HH`, exemple `06 16`.", ephemeral: true });
                }
                const max = db.prepare('SELECT MAX(number) as m FROM drops').get();
                const number = (max && max.m) ? max.m + 1 : 1;
                const channel = interaction.channel;
                if (!channel) return await interaction.reply({ content: "Canal introuvable.", ephemeral: true });
                const embed = new EmbedBuilder()
                    .setTitle(`🌕 CIRCLE DROP #${padId(number)}`)
                    .setDescription(
                        `Un Drop arrive bientôt !\n\n**Début :** ${toDiscordTimestamp(start_time)}\n**Fin :** ${toDiscordTimestamp(end_time)}\n` +
                        `**Lot :** ||Surprise||\n**Nombre de gagnants :** ${winner_count}\n` +
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
                        const expires_at = now() + duration * 60;
                        db.prepare('INSERT OR REPLACE INTO chosen_one_expirations (user_id, role_id, expires_at) VALUES (?, ?, ?)').run(memberId, role.id, expires_at);
                        setTimeout(async () => {
                            try { await member.roles.remove(role); } catch {}
                            db.prepare('DELETE FROM chosen_one_expirations WHERE user_id = ?').run(memberId);
                        }, Math.min(duration * 60 * 1000, 2 ** 31 - 1));
                    }
                }
                const embed = new EmbedBuilder()
                    .setTitle('👑 THE CHOSEN ONE')
                    .setDescription(
                        `<@${memberId}> a été désigné comme **Chosen One** pour ${duration} minutes !` +
                        (!hide_reason ? `\n\n**Raison :** ${reason}` : '')
                    )
                    .setImage(member.user.displayAvatarURL({ size: 512 }))
                    .setColor(0xff0000)
                    .setTimestamp();
                await interaction.reply({ embeds: [embed] });
            }
        } else if (interaction.isButton()) {
            // Participation Drop
            if (interaction.customId.startsWith('drop_participate_')) {
                const drop_id = parseInt(interaction.customId.split('_').pop());
                const drop = db.prepare('SELECT * FROM drops WHERE drop_id = ?').get(drop_id);
                if (!drop || drop.status !== 'LIVE') return await interaction.reply({ content: "Drop non disponible.", ephemeral: true });
                const already = db.prepare('SELECT 1 FROM drop_participants WHERE drop_id = ? AND user_id = ?').get(drop_id, interaction.user.id);
                if (already) return await interaction.reply({ content: "Vous participez déjà.", ephemeral: true });
                if (drop.tag_req && drop.tag_req.trim() !== '') {
                    const member = interaction.guild.members.cache.get(interaction.user.id);
                    if (!member) return await interaction.reply({ content: "Impossible de vérifier vos tags.", ephemeral: true });
                    if (!hasCoreTag(member)) {
                        return await interaction.reply({ content: "Vous n'avez pas le tag requis. Le rôle `In The Circle` sert de validation CORE.", ephemeral: true });
                    }
                }
                db.prepare('INSERT INTO drop_participants (drop_id, user_id) VALUES (?, ?)').run(drop_id, interaction.user.id);
                await interaction.reply({ content: "Participation enregistrée !", ephemeral: true });
            }
            // Participation Signal
            else if (interaction.customId === 'signal_participate') {
                const signal = db.prepare('SELECT * FROM signals WHERE message_id = ?').get(interaction.message.id);
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