import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import cron from 'node-cron';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const LEADERSHIP = process.env.LEADERSHIP_CHANNEL_ID;
const GERMAN = process.env.GERMAN_CHANNEL_ID;
const SLOVAK = process.env.SLOVAK_CHANNEL_ID;
const DAILY_CHANNEL_ID = process.env.DAILY_CHANNEL_ID;
const TBV_ROLE = '<@&1318114945149173825>';

if (!TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN');
  process.exit(1);
}

async function translate(text, lang) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + lang + '&dt=t&q=' + encodeURIComponent(text);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await res.json();
  return data[0].map(c => c[0]).filter(Boolean).join('');
}

const DAILY_MESSAGES = {
  0: `🔷 SUNDAY – Pregathering day (CRITICAL)

Early gathering
• EU players start at 06:00 GT
• Use OLD mines first — Prevents RSS from disappearing unused

Fresh Mines
• New RSS mines spawn ~12 hours before reset (12:30 GT)

Bauxite mines ⏲️
• Level 9: 18:30 GT
• Level 10: 12:30 GT
• Level 11: 06:30 GT`,
  1: `🔷 MONDAY – Gathering day
Starts at 00:30 GT

• Make sure not to recall trucks before 00:30 GT
• Gathering all day`,
  2: `🔷 TUESDAY – Base Upgrades
Starts at: 00:30 GT

Primary Focus:
• Base building upgrades
• Upgrade vehicle parts
• Upgrade statues

⚔️ ZOMBIE RAID DAY – Back-to-Back Zombie Raids:
• 1st Raid: 18:00 GT
• 2nd Raid: 20:00 GT

Save stamina and prep squads in advance.`,
  3: `🔷 WEDNESDAY – Research day
Starts at 00:30 GT

Primary Focus ~ Research new technologies in the Tech Center:
• Produce truck parts (used for vehicle upgrades, troop transport, and power boosts)
• Craft/upgrade ultimate weapons
• Fuse or mutate modules

⏱️ Timing Tips:
• Start long builds before reset
• Finish research after reset for Ad Duel points`,
  4: `🔷 THURSDAY – Recruitment day
Starts at: 00:30 GT

• Hero recruitment`,
  5: `🔷 FRIDAY – Training day
Starts at 00:30 GT

Primary Focus:
• Mass troop training
• Complete long training queues
• Kill zombies if you cannot train troops

⏱️ Timing Tips:
• Start long training queues before reset
• Use speedups after reset for Ad Duel points
• Stack training buffs if available`,
  6: `🔷 SATURDAY – Enemy Elimination Day (EE)
Starts at Reset: 00:30 GT

Primary Focus:
• PvP combat against enemy players
• Killing enemy troops (highest scoring action)
• Strategic base attacks & rallies
• Alliance coordination and timing

🛡️ Defense & Survival Strategy:
• Shield when offline
• Hide troops in shelters or rallies if not fighting
• Reinforce alliance members under attack`
};

let botUserId = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check bot status').toJSON(),
  new SlashCommandBuilder().setName('help').setDescription('Show commands').toJSON(),
  new SlashCommandBuilder().setName('today').setDescription('Show todays game schedule').toJSON(),
  new SlashCommandBuilder()
    .setName('translate')
    .setDescription('Translate text to German and Slovak')
    .addStringOption(o => o.setName('text').setDescription('Text to translate').setRequired(true))
    .toJSON()
];

async function postDailySchedule() {
  if (!DAILY_CHANNEL_ID) {
    console.log('No DAILY_CHANNEL_ID set, skipping daily post');
    return;
  }
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const currentDay = now.getDay();
    const nextDay = (currentDay + 1) % 7;
    const message = DAILY_MESSAGES[nextDay];
    const ch = await client.channels.fetch(DAILY_CHANNEL_ID);
    await ch.send(TBV_ROLE + '\n' + message);
    console.log('Daily schedule posted for game day', nextDay);
  } catch (err) {
    console.error('Failed to post daily schedule:', err.message);
  }
}

client.once('ready', async (c) => {
  botUserId = c.user.id;
  console.log('Bot online:', c.user.tag);
  const rest = new REST().setToken(TOKEN);
  await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
  console.log('Slash commands registered');

  cron.schedule('0 22 * * *', () => {
    console.log('Posting daily schedule...');
    postDailySchedule();
  }, { timezone: 'America/New_York' });

  console.log('Daily schedule cron job set for 10:00 PM ET');
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || msg.author.id === botUserId) return;

  // Leadership → German & Slovak
  if (msg.channelId === LEADERSHIP) {
    console.log('Translating Leadership message from', msg.author.username);
    const author = msg.member?.displayName || msg.author.username;
    const header = '📢 **' + author + '** (Leadership):';

    try {
      const [de, sk] = await Promise.all([
        GERMAN ? translate(msg.content, 'de') : Promise.resolve(''),
        SLOVAK ? translate(msg.content, 'sk') : Promise.resolve('')
      ]);

      if (GERMAN) {
        const ch = await client.channels.fetch(GERMAN);
        const m = await ch.send(header + '\n' + de);
        await m.react('🇩🇪');
      }
      if (SLOVAK) {
        const ch = await client.channels.fetch(SLOVAK);
        const m = await ch.send(header + '\n' + sk);
        await m.react('🇸🇰');
      }

      console.log('Translations posted with reactions');
    } catch (err) {
      console.error('Translation error:', err.message);
    }
  }

  // German → English back to Leadership
  if (msg.channelId === GERMAN) {
    console.log('Translating German message from', msg.author.username);
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇩🇪 **' + author + '** (German):';

    try {
      const en = await translate(msg.content, 'en');
      const ch = await client.channels.fetch(LEADERSHIP);
      const m = await ch.send(header + '\n' + en);
      await m.react('🇬🇧');
      console.log('German → English translation posted with reaction');
    } catch (err) {
      console.error('Translation error:', err.message);
    }
  }

  // Slovak → English back to Leadership
  if (msg.channelId === SLOVAK) {
    console.log('Translating Slovak message from', msg.author.username);
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇸🇰 **' + author + '** (Slovak):';

    try {
      const en = await translate(msg.content, 'en');
      const ch = await client.channels.fetch(LEADERSHIP);
      const m = await ch.send(header + '\n' + en);
      await m.react('🇬🇧');
      console.log('Slovak → English translation posted with reaction');
    } catch (err) {
      console.error('Translation error:', err.message);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply('Pong! Bot is online and running.');
  } else if (interaction.commandName === 'help') {
    await interaction.reply('Commands:\n/ping - Check status\n/today - Show todays game schedule\n/translate <text> - Translate to German and Slovak\n/help - Show this message');
  } else if (interaction.commandName === 'today') {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const currentDay = now.getDay();
    const nextDay = (currentDay + 1) % 7;
    const message = DAILY_MESSAGES[nextDay];
    await interaction.reply('**Current game day schedule:**\n\n' + message);
  } else if (interaction.commandName === 'translate') {
    await interaction.deferReply();
    const text = interaction.options.getString('text', true);
    try {
      const [de, sk] = await Promise.all([translate(text, 'de'), translate(text, 'sk')]);
      await interaction.editReply('**Original:** ' + text + '\n🇩🇪 **German:** ' + de + '\n🇸🇰 **Slovak:** ' + sk);
    } catch (err) {
      await interaction.editReply('Translation failed. Please try again.');
    }
  }
});

client.login(TOKEN);