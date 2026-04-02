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
Starts at: 00:30 CT

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

async function postZombieRaidReminder() {
  if (!DAILY_CHANNEL_ID) {
    console.log('No DAILY_CHANNEL_ID set, skipping zombie raid reminder');
    return;
  }
  try {
    const reminder = TBV_ROLE + `
⚔️ ZOMBIE RAID REMINDER – TODAY!

Back-to-Back Zombie Raids:
• 1st Raid: 18:00 GT
• 2nd Raid: 20:00 GT

Save stamina and prep squads in advance!`;
    const ch = await client.channels.fetch(DAILY_CHANNEL_ID);
    await ch.send(reminder);
    console.log('Zombie raid reminder posted');
  } catch (err) {
    console.error('Failed to post zombie raid reminder:', err.message);
  }
}

async function postSecondZombieRaidReminder() {
  if (!DAILY_CHANNEL_ID) {
    console.log('No DAILY_CHANNEL_ID set, skipping second zombie raid reminder');
    return;
  }
  try {
    const reminder = TBV_ROLE + `
⚔️ Second Zombie Raid starts in 30 minutes!
20:00 GT`;
    const ch = await client.channels.fetch(DAILY_CHANNEL_ID);
    await ch.send(reminder);
    console.log('Second zombie raid reminder posted');
  } catch (err) {
    console.error('Failed to post second zombie raid reminder:', err.message);
  }
}

async function postLevel11Bauxite() {
  if (!DAILY_CHANNEL_ID) {
    console.log('No DAILY_CHANNEL_ID set, skipping level 11 bauxite reminder');
    return;
  }
  try {
    const reminder = `⛏️ You can now start pre-gathering a level 11 bauxite mine`;
    const ch = await client.channels.fetch(DAILY_CHANNEL_ID);
    await ch.send(reminder);
    console.log('Level 11 bauxite reminder posted');
  } catch (err) {
    console.error('Failed to post level 11 bauxite reminder:', err.message);
  }
}

async function postLevel10Bauxite() {
  if (!DAILY_CHANNEL_ID) {
    console.log('No DAILY_CHANNEL_ID set, skipping level 10 bauxite reminder');
    return;
  }
  try {
    const reminder = `⛏️ You can now start pre-gathering a level 10 bauxite mine`;
    const ch = await client.channels.fetch(DAILY_CHANNEL_ID);
    await ch.send(reminder);
    console.log('Level 10 bauxite reminder posted');
  } catch (err) {
    console.error('Failed to post level 10 bauxite reminder:', err.message);
  }
}

async function postLevel9Bauxite() {
  if (!DAILY_CHANNEL_ID) {
    console.log('No DAILY_CHANNEL_ID set, skipping level 9 bauxite reminder');
    return;
  }
  try {
    const reminder = `⛏️ You can now start pre-gathering a level 9 bauxite mine`;
    const ch = await client.channels.fetch(DAILY_CHANNEL_ID);
    await ch.send(reminder);
    console.log('Level 9 bauxite reminder posted');
  } catch (err) {
    console.error('Failed to post level 9 bauxite reminder:', err.message);
  }
}


client.once('ready', async (c) => {