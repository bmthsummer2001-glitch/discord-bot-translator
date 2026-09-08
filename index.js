import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import cron from 'node-cron';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const LEADERSHIP = process.env.LEADERSHIP_CHANNEL_ID;
const GERMAN = process.env.GERMAN_CHANNEL_ID;
const SLOVAK = process.env.SLOVAK_CHANNEL_ID;
const DAILY_CHANNEL_ID = process.env.DAILY_CHANNEL_ID;
const TBV_ROLE = '<@&1318114945149173825>';
// Announcements channels
const ANN_EN = process.env.ANN_EN_CHANNEL_ID;
const ANN_DE = process.env.ANN_DE_CHANNEL_ID;
const ANN_SK = process.env.ANN_SK_CHANNEL_ID;
const ANN_FR = process.env.ANN_FR_CHANNEL_ID;
const ANN_ES = process.env.ANN_ES_CHANNEL_ID;

// General chat channels
const GEN_EN = process.env.GEN_EN_CHANNEL_ID;
const GEN_DE = process.env.GEN_DE_CHANNEL_ID;
const GEN_SK = process.env.GEN_SK_CHANNEL_ID;
const GEN_FR = process.env.GEN_FR_CHANNEL_ID;
const GEN_ES = process.env.GEN_ES_CHANNEL_ID;

// Dedicated English ↔ German channel pair
const CROSS_EN = process.env.CROSS_EN_CHANNEL_ID;
const CROSS_DE = process.env.CROSS_DE_CHANNEL_ID;

if (!TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN');
  process.exit(1);
}

const MYMEMORY_TRANSLATE_URL = 'https://api.mymemory.translated.net/get';
const TRANSLATION_TIMEOUT_MS = 15000;
const TRANSLATION_ATTEMPTS = 3;

function detectSourceLanguage(text) {
  const lower = text.toLowerCase();
  if (/[äöüß]/.test(lower) || /\b(der|die|das|und|nicht|ich|ist|für)\b/.test(lower)) return 'de';
  if (/[áäčďéíĺľňóôŕšťúýž]/.test(lower) || /\b(je|nie|som|že|pre|ako|na|sa)\b/.test(lower)) return 'sk';
  if (/[àâçéèêëîïôùûüÿœ]/.test(lower) || /\b(le|la|les|des|une|est|pour|avec)\b/.test(lower)) return 'fr';
  if (/[áéíóúüñ¿¡]/.test(lower) || /\b(el|la|los|las|una|es|para|con)\b/.test(lower)) return 'es';
  return 'en';
}

async function translateOnce(text, lang, sourceLang = detectSourceLanguage(text)) {
  if (sourceLang === lang) return text;

  const params = new URLSearchParams({
    q: text,
    langpair: sourceLang + '|' + lang,
    mt: '1'
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(MYMEMORY_TRANSLATE_URL + '?' + params.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'DiscordTranslationBot/1.0'
      }
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error('Translation request failed: ' + res.status + ' ' + res.statusText);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const body = await res.text();
    throw new Error(
      'Translation provider returned non-JSON response: ' +
      res.status +
      ' ' +
      body.slice(0, 120).replace(/\s+/g, ' ')
    );
  }

  const data = await res.json();
  const translated = data?.responseData?.translatedText?.trim();
  if (data?.quotaFinished) throw new Error('Translation provider quota is exhausted');
  if (data?.responseStatus !== 200 || !translated) {
    throw new Error('Empty or invalid translation response');
  }
  return translated;
}

async function translate(text, lang, sourceLang = detectSourceLanguage(text)) {
  let lastError;

  for (let attempt = 1; attempt <= TRANSLATION_ATTEMPTS; attempt++) {
    try {
      return await translateOnce(text, lang, sourceLang);
    } catch (err) {
      lastError = err;
      if (attempt === TRANSLATION_ATTEMPTS) break;
      const delayMs = attempt * 1500;
      console.warn('Translation attempt ' + attempt + ' failed for ' + lang + '; retrying in ' + delayMs + 'ms');
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Translation failed after retries');
}

async function translateTargets(text, sourceLang, targetLangs) {
  return Promise.all(targetLangs.map(async (targetLang) => {
    if (!targetLang) return '';

    try {
      return await translate(text, targetLang, sourceLang);
    } catch (err) {
      console.error(
        'Translation failed for ' + sourceLang + '→' + targetLang + ':',
        err instanceof Error ? err.message : err
      );
      return '';
    }
  }));
}

async function sendToChannel(channelId, content, label) {
  if (!channelId || !content) return false;

  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(content);
    return true;
  } catch (err) {
    console.error(
      'Failed to send ' + label + ' translation:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
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
• Produce truck parts (used for vehicle upgrades, troop transport, and power boosts)`,
  3: `🔷 WEDNESDAY – Research day
Starts at 00:30 GT

Primary Focus ~ Research new technologies in the Tech Center:
• Craft/upgrade ultimate weapons
• Fuse or mutate modules
• Open/craft gear

⏱️ Timing Tips:
• Start long builds before reset
• Finish research after reset for Ad Duel points`,
  4: `🔷 THURSDAY – Recruitment day
Starts at: 00:30 GT

• Hero recruitment

⚔️ ZOMBIE RAID DAY – Back-to-Back Zombie Raids:
• 1st Raid: 18:00 GT
• 2nd Raid: 21:00 GT

Save stamina and prep squads in advance.`,
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
  new SlashCommandBuilder().setName('city-capture').setDescription('Announce City Capture is starting now').toJSON(),
  new SlashCommandBuilder().setName('zombie-raid').setDescription('Announce Zombie Raid has started').toJSON(),
  new SlashCommandBuilder()
    .setName('translate')
    .setDescription('Translate text to German and Slovak')
    .addStringOption(o => o.setName('text').setDescription('Text to translate').setRequired(true))
    .toJSON()
];

async function postDailySchedule() {
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const nextDay = (now.getDay() + 1) % 7;
    const message = DAILY_MESSAGES[nextDay];
    const enMsg = TBV_ROLE + '\n' + message;
    if (DAILY_CHANNEL_ID) { const ch = await client.channels.fetch(DAILY_CHANNEL_ID); await ch.send(enMsg); }
    const langs = await translateTargets(message, 'en', [
      ANN_DE ? 'de' : null,
      ANN_SK ? 'sk' : null,
      ANN_FR ? 'fr' : null,
      ANN_ES ? 'es' : null
    ]);
    if (ANN_DE) { const ch2 = await client.channels.fetch(ANN_DE); await ch2.send(langs[0]); }
    if (ANN_SK) { const ch2 = await client.channels.fetch(ANN_SK); await ch2.send(langs[1]); }
    if (ANN_FR) { const ch2 = await client.channels.fetch(ANN_FR); await ch2.send(langs[2]); }
    if (ANN_ES) { const ch2 = await client.channels.fetch(ANN_ES); await ch2.send(langs[3]); }
    console.log('Daily schedule posted to all language channels');
  } catch (err) {
    console.error('Failed to post daily schedule:', err.message);
  }
}

async function postZombieRaidReminder() {
  try {
    const text = '\u2694\uFE0F ZOMBIE RAID REMINDER \u2013 TODAY!\n\nBack-to-Back Zombie Raids:\n\u2022 1st Raid: 18:00 GT\n\u2022 2nd Raid: 21:00 GT\n\nSave stamina and prep squads in advance!\n~ Please keep at least one strong truck home all day';
    if (DAILY_CHANNEL_ID) { const ch = await client.channels.fetch(DAILY_CHANNEL_ID); await ch.send(TBV_ROLE + '\n' + text); }
    const langs = await translateTargets(text, 'en', [
      ANN_DE ? 'de' : null,
      ANN_SK ? 'sk' : null,
      ANN_FR ? 'fr' : null,
      ANN_ES ? 'es' : null
    ]);
    if (ANN_DE) { const ch2 = await client.channels.fetch(ANN_DE); await ch2.send(langs[0]); }
    if (ANN_SK) { const ch2 = await client.channels.fetch(ANN_SK); await ch2.send(langs[1]); }
    if (ANN_FR) { const ch2 = await client.channels.fetch(ANN_FR); await ch2.send(langs[2]); }
    if (ANN_ES) { const ch2 = await client.channels.fetch(ANN_ES); await ch2.send(langs[3]); }
    console.log('Zombie raid reminder posted to all language channels');
  } catch (err) {
    console.error('Failed to post zombie raid reminder:', err.message);
  }
}

async function postSecondZombieRaidReminder() {
  try {
    const text = '\u2694\uFE0F Second Zombie Raid starts in 30 minutes!\n21:00 GT';
    if (DAILY_CHANNEL_ID) { const ch = await client.channels.fetch(DAILY_CHANNEL_ID); await ch.send(TBV_ROLE + '\n' + text); }
    const langs = await translateTargets(text, 'en', [
      ANN_DE ? 'de' : null,
      ANN_SK ? 'sk' : null,
      ANN_FR ? 'fr' : null,
      ANN_ES ? 'es' : null
    ]);
    if (ANN_DE) { const ch2 = await client.channels.fetch(ANN_DE); await ch2.send(langs[0]); }
    if (ANN_SK) { const ch2 = await client.channels.fetch(ANN_SK); await ch2.send(langs[1]); }
    if (ANN_FR) { const ch2 = await client.channels.fetch(ANN_FR); await ch2.send(langs[2]); }
    if (ANN_ES) { const ch2 = await client.channels.fetch(ANN_ES); await ch2.send(langs[3]); }
    console.log('Second zombie raid reminder posted to all language channels');
  } catch (err) {
    console.error('Failed to post second zombie raid reminder:', err.message);
  }
}

async function postLevel11Bauxite() {
  try {
    const text = '\u26CF\uFE0F You can now start pre-gathering a level 11 bauxite mine';
    if (DAILY_CHANNEL_ID) { const ch = await client.channels.fetch(DAILY_CHANNEL_ID); await ch.send(text); }
    const langs = await translateTargets(text, 'en', [
      ANN_DE ? 'de' : null,
      ANN_SK ? 'sk' : null,
      ANN_FR ? 'fr' : null,
      ANN_ES ? 'es' : null
    ]);
    if (ANN_DE) { const ch2 = await client.channels.fetch(ANN_DE); await ch2.send(langs[0]); }
    if (ANN_SK) { const ch2 = await client.channels.fetch(ANN_SK); await ch2.send(langs[1]); }
    if (ANN_FR) { const ch2 = await client.channels.fetch(ANN_FR); await ch2.send(langs[2]); }
    if (ANN_ES) { const ch2 = await client.channels.fetch(ANN_ES); await ch2.send(langs[3]); }
    console.log('Level 11 bauxite posted to all language channels');
  } catch (err) {
    console.error('Failed to post level 11 bauxite reminder:', err.message);
  }
}

async function postLevel10Bauxite() {
  try {
    const text = '\u26CF\uFE0F You can now start pre-gathering a level 10 bauxite mine';
    if (DAILY_CHANNEL_ID) { const ch = await client.channels.fetch(DAILY_CHANNEL_ID); await ch.send(text); }
    const langs = await translateTargets(text, 'en', [
      ANN_DE ? 'de' : null,
      ANN_SK ? 'sk' : null,
      ANN_FR ? 'fr' : null,
      ANN_ES ? 'es' : null
    ]);
    if (ANN_DE) { const ch2 = await client.channels.fetch(ANN_DE); await ch2.send(langs[0]); }
    if (ANN_SK) { const ch2 = await client.channels.fetch(ANN_SK); await ch2.send(langs[1]); }
    if (ANN_FR) { const ch2 = await client.channels.fetch(ANN_FR); await ch2.send(langs[2]); }
    if (ANN_ES) { const ch2 = await client.channels.fetch(ANN_ES); await ch2.send(langs[3]); }
    console.log('Level 10 bauxite posted to all language channels');
  } catch (err) {
    console.error('Failed to post level 10 bauxite reminder:', err.message);
  }
}

async function postLevel9Bauxite() {
  try {
    const text = '\u26CF\uFE0F You can now start pre-gathering a level 9 bauxite mine';
    if (DAILY_CHANNEL_ID) { const ch = await client.channels.fetch(DAILY_CHANNEL_ID); await ch.send(text); }
    const langs = await translateTargets(text, 'en', [
      ANN_DE ? 'de' : null,
      ANN_SK ? 'sk' : null,
      ANN_FR ? 'fr' : null,
      ANN_ES ? 'es' : null
    ]);
    if (ANN_DE) { const ch2 = await client.channels.fetch(ANN_DE); await ch2.send(langs[0]); }
    if (ANN_SK) { const ch2 = await client.channels.fetch(ANN_SK); await ch2.send(langs[1]); }
    if (ANN_FR) { const ch2 = await client.channels.fetch(ANN_FR); await ch2.send(langs[2]); }
    if (ANN_ES) { const ch2 = await client.channels.fetch(ANN_ES); await ch2.send(langs[3]); }
    console.log('Level 9 bauxite posted to all language channels');
  } catch (err) {
    console.error('Failed to post level 9 bauxite reminder:', err.message);
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

  cron.schedule('0 12 * * 4', () => {
    console.log('Posting zombie raid reminder...');
    postZombieRaidReminder();
  }, { timezone: 'America/New_York' });
  console.log('Zombie raid reminder cron job set for 12:00 PM ET on Tuesdays');

  cron.schedule('30 18 * * 4', () => {
    console.log('Posting second zombie raid reminder...');
    postSecondZombieRaidReminder();
  }, { timezone: 'America/New_York' });
  console.log('Second zombie raid reminder cron job set for 6:30 PM ET on Thursdays');

  cron.schedule('30 4 * * 0', () => {
    console.log('Posting level 11 bauxite reminder...');
    postLevel11Bauxite();
  }, { timezone: 'America/New_York' });
  console.log('Level 11 bauxite reminder cron job set for 4:30 AM ET on Sundays');

  cron.schedule('30 10 * * 0', () => {
    console.log('Posting level 10 bauxite reminder...');
    postLevel10Bauxite();
  }, { timezone: 'America/New_York' });
  console.log('Level 10 bauxite reminder cron job set for 10:30 AM ET on Sundays');

  cron.schedule('30 16 * * 0', () => {
    console.log('Posting level 9 bauxite reminder...');
    postLevel9Bauxite();
  }, { timezone: 'America/New_York' });
  console.log('Level 9 bauxite reminder cron job set for 4:30 PM ET on Sundays');
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || msg.author.id === botUserId) return;

  // Dedicated English ↔ German pair
  if (CROSS_EN && msg.channelId === CROSS_EN) {
    const author = msg.member?.displayName || msg.author.username;
    try {
      const translated = await translate(msg.content, 'de', 'en');
      await sendToChannel(
        CROSS_DE,
        '🇬🇧 **' + author + '** (English → German):\n' + translated,
        'dedicated EN→DE'
      );
      console.log('Dedicated English message translated to German');
    } catch (err) {
      console.error('Dedicated EN→DE translation error:', err.message);
    }
  }

  if (CROSS_DE && msg.channelId === CROSS_DE) {
    const author = msg.member?.displayName || msg.author.username;
    try {
      const translated = await translate(msg.content, 'en', 'de');
      await sendToChannel(
        CROSS_EN,
        '🇩🇪 **' + author + '** (German → English):\n' + translated,
        'dedicated DE→EN'
      );
      console.log('Dedicated German message translated to English');
    } catch (err) {
      console.error('Dedicated DE→EN translation error:', err.message);
    }
  }

  // Leadership → German & Slovak
  if (msg.channelId === LEADERSHIP) {
    console.log('Translating Leadership message from', msg.author.username);
    const author = msg.member?.displayName || msg.author.username;
    const header = '📢 **' + author + '** (Leadership):';

    try {
      const [de, sk] = await translateTargets(msg.content, 'en', [
        GERMAN ? 'de' : null,
        SLOVAK ? 'sk' : null
      ]);

      await sendToChannel(GERMAN, header + '\n' + de, 'Leadership→German');
      await sendToChannel(SLOVAK, header + '\n' + sk, 'Leadership→Slovak');

      console.log('Translations posted successfully');
    } catch (err) {
      console.error('Translation error:', err.message);
    }
  }

  // German → English to Leadership + Slovak translation
  if (msg.channelId === GERMAN) {
    console.log('Translating German message from', msg.author.username);
    const author = msg.member?.displayName || msg.author.username;
    const headerEn = '🇩🇪 **' + author + '** (German):';
    const headerSk = '🇩🇪 **' + author + '** (German → Slovak):';

    try {
      const [en, sk] = await translateTargets(msg.content, 'de', [
        'en',
        SLOVAK ? 'sk' : null
      ]);

      await sendToChannel(LEADERSHIP, headerEn + '\n' + en, 'German→Leadership');
      await sendToChannel(SLOVAK, headerSk + '\n' + sk, 'German→Slovak');

      console.log('German message posted to Leadership and Slovak');
    } catch (err) {
      console.error('Translation error:', err.message);
    }
  }

  // Slovak → English to Leadership + German translation
  if (msg.channelId === SLOVAK) {
    console.log('Translating Slovak message from', msg.author.username);
    const author = msg.member?.displayName || msg.author.username;
    const headerEn = '🇸🇰 **' + author + '** (Slovak):';
    const headerDe = '🇸🇰 **' + author + '** (Slovak → German):';

    try {
      const [en, de] = await translateTargets(msg.content, 'sk', [
        'en',
        GERMAN ? 'de' : null
      ]);

      await sendToChannel(LEADERSHIP, headerEn + '\n' + en, 'Slovak→Leadership');
      await sendToChannel(GERMAN, headerDe + '\n' + de, 'Slovak→German');

      console.log('Slovak message posted to Leadership and German');
    } catch (err) {
      console.error('Translation error:', err.message);
    }
  }

  // === ANNOUNCEMENTS GROUP ===
  // ANN_EN -> DE, SK, FR
  if (msg.channelId === ANN_EN) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '📢 **' + author + '** (EN):';
    try {
      const results = await translateTargets(msg.content, 'en', [
        ANN_DE ? 'de' : null,
        ANN_SK ? 'sk' : null,
        ANN_FR ? 'fr' : null,
        ANN_ES ? 'es' : null
      ]);
      await sendToChannel(ANN_DE, header + '\n' + results[0], 'ANN_EN→German');
      await sendToChannel(ANN_SK, header + '\n' + results[1], 'ANN_EN→Slovak');
      await sendToChannel(ANN_FR, header + '\n' + results[2], 'ANN_EN→French');
      await sendToChannel(ANN_ES, header + '\n' + results[3], 'ANN_EN→Spanish');
      console.log('ANN_EN translated');
    } catch (err) { console.error('ANN_EN error:', err.message); }
  }

  // ANN_DE -> EN, SK, FR
  if (msg.channelId === ANN_DE) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇩🇪 **' + author + '** (DE):';
    try {
      const results = await translateTargets(msg.content, 'de', [
        'en',
        ANN_SK ? 'sk' : null,
        ANN_FR ? 'fr' : null,
        ANN_ES ? 'es' : null
      ]);
      await sendToChannel(ANN_EN, header + '\n' + results[0], 'ANN_DE→English');
      await sendToChannel(ANN_SK, header + '\n' + results[1], 'ANN_DE→Slovak');
      await sendToChannel(ANN_FR, header + '\n' + results[2], 'ANN_DE→French');
      await sendToChannel(ANN_ES, header + '\n' + results[3], 'ANN_DE→Spanish');
      console.log('ANN_DE translated');
    } catch (err) { console.error('ANN_DE error:', err.message); }
  }

  // ANN_SK -> EN, DE, FR
  if (msg.channelId === ANN_SK) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇸🇰 **' + author + '** (SK):';
    try {
      const results = await translateTargets(msg.content, 'sk', [
        'en',
        ANN_DE ? 'de' : null,
        ANN_FR ? 'fr' : null,
        ANN_ES ? 'es' : null
      ]);
      await sendToChannel(ANN_EN, header + '\n' + results[0], 'ANN_SK→English');
      await sendToChannel(ANN_DE, header + '\n' + results[1], 'ANN_SK→German');
      await sendToChannel(ANN_FR, header + '\n' + results[2], 'ANN_SK→French');
      await sendToChannel(ANN_ES, header + '\n' + results[3], 'ANN_SK→Spanish');
      console.log('ANN_SK translated');
    } catch (err) { console.error('ANN_SK error:', err.message); }
  }

  // ANN_FR -> EN, DE, SK
  if (msg.channelId === ANN_FR) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇫🇷 **' + author + '** (FR):';
    try {
      const results = await translateTargets(msg.content, 'fr', [
        'en',
        ANN_DE ? 'de' : null,
        ANN_SK ? 'sk' : null,
        ANN_ES ? 'es' : null
      ]);
      await sendToChannel(ANN_EN, header + '\n' + results[0], 'ANN_FR→English');
      await sendToChannel(ANN_DE, header + '\n' + results[1], 'ANN_FR→German');
      await sendToChannel(ANN_SK, header + '\n' + results[2], 'ANN_FR→Slovak');
      await sendToChannel(ANN_ES, header + '\n' + results[3], 'ANN_FR→Spanish');
      console.log('ANN_FR translated');
    } catch (err) { console.error('ANN_FR error:', err.message); }
  }

  // === GENERAL CHAT GROUP ===
  // GEN_EN -> DE, SK, FR
  if (msg.channelId === GEN_EN) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '📢 **' + author + '** (EN):';
    try {
      const results = await translateTargets(msg.content, 'en', [
        GEN_DE ? 'de' : null,
        GEN_SK ? 'sk' : null,
        GEN_FR ? 'fr' : null,
        GEN_ES ? 'es' : null
      ]);
      await sendToChannel(GEN_DE, header + '\n' + results[0], 'GEN_EN→German');
      await sendToChannel(GEN_SK, header + '\n' + results[1], 'GEN_EN→Slovak');
      await sendToChannel(GEN_FR, header + '\n' + results[2], 'GEN_EN→French');
      await sendToChannel(GEN_ES, header + '\n' + results[3], 'GEN_EN→Spanish');
      console.log('GEN_EN translated');
    } catch (err) { console.error('GEN_EN error:', err.message); }
  }

  // GEN_DE -> EN, SK, FR
  if (msg.channelId === GEN_DE) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇩🇪 **' + author + '** (DE):';
    try {
      const results = await translateTargets(msg.content, 'de', [
        'en',
        GEN_SK ? 'sk' : null,
        GEN_FR ? 'fr' : null,
        GEN_ES ? 'es' : null
      ]);
      await sendToChannel(GEN_EN, header + '\n' + results[0], 'GEN_DE→English');
      await sendToChannel(GEN_SK, header + '\n' + results[1], 'GEN_DE→Slovak');
      await sendToChannel(GEN_FR, header + '\n' + results[2], 'GEN_DE→French');
      await sendToChannel(GEN_ES, header + '\n' + results[3], 'GEN_DE→Spanish');
      console.log('GEN_DE translated');
    } catch (err) { console.error('GEN_DE error:', err.message); }
  }

  // GEN_SK -> EN, DE, FR
  if (msg.channelId === GEN_SK) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇸🇰 **' + author + '** (SK):';
    try {
      const results = await translateTargets(msg.content, 'sk', [
        'en',
        GEN_DE ? 'de' : null,
        GEN_FR ? 'fr' : null,
        GEN_ES ? 'es' : null
      ]);
      await sendToChannel(GEN_EN, header + '\n' + results[0], 'GEN_SK→English');
      await sendToChannel(GEN_DE, header + '\n' + results[1], 'GEN_SK→German');
      await sendToChannel(GEN_FR, header + '\n' + results[2], 'GEN_SK→French');
      await sendToChannel(GEN_ES, header + '\n' + results[3], 'GEN_SK→Spanish');
      console.log('GEN_SK translated');
    } catch (err) { console.error('GEN_SK error:', err.message); }
  }

  // GEN_FR -> EN, DE, SK
  if (msg.channelId === GEN_FR) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇫🇷 **' + author + '** (FR):';
    try {
      const results = await translateTargets(msg.content, 'fr', [
        'en',
        GEN_DE ? 'de' : null,
        GEN_SK ? 'sk' : null,
        GEN_ES ? 'es' : null
      ]);
      await sendToChannel(GEN_EN, header + '\n' + results[0], 'GEN_FR→English');
      await sendToChannel(GEN_DE, header + '\n' + results[1], 'GEN_FR→German');
      await sendToChannel(GEN_SK, header + '\n' + results[2], 'GEN_FR→Slovak');
      await sendToChannel(GEN_ES, header + '\n' + results[3], 'GEN_FR→Spanish');
      console.log('GEN_FR translated');
    } catch (err) { console.error('GEN_FR error:', err.message); }
  }

  // ANN_ES -> EN, DE, SK, FR
  if (msg.channelId === ANN_ES) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇪🇸 **' + author + '** (ES):';
    try {
      const results = await translateTargets(msg.content, 'es', [
        'en',
        ANN_DE ? 'de' : null,
        ANN_SK ? 'sk' : null,
        ANN_FR ? 'fr' : null
      ]);
      await sendToChannel(ANN_EN, header + '\n' + results[0], 'ANN_ES→English');
      await sendToChannel(ANN_DE, header + '\n' + results[1], 'ANN_ES→German');
      await sendToChannel(ANN_SK, header + '\n' + results[2], 'ANN_ES→Slovak');
      await sendToChannel(ANN_FR, header + '\n' + results[3], 'ANN_ES→French');
      console.log('ANN_ES translated');
    } catch (err) { console.error('ANN_ES error:', err.message); }
  }

  // GEN_ES -> EN, DE, SK, FR
  if (msg.channelId === GEN_ES) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇪🇸 **' + author + '** (ES):';
    try {
      const results = await translateTargets(msg.content, 'es', [
        'en',
        GEN_DE ? 'de' : null,
        GEN_SK ? 'sk' : null,
        GEN_FR ? 'fr' : null
      ]);
      await sendToChannel(GEN_EN, header + '\n' + results[0], 'GEN_ES→English');
      await sendToChannel(GEN_DE, header + '\n' + results[1], 'GEN_ES→German');
      await sendToChannel(GEN_SK, header + '\n' + results[2], 'GEN_ES→Slovak');
      await sendToChannel(GEN_FR, header + '\n' + results[3], 'GEN_ES→French');
      console.log('GEN_ES translated');
    } catch (err) { console.error('GEN_ES error:', err.message); }
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
  } else if (interaction.commandName === 'city-capture') {
    const ALLOWED_ROLES = ['1313804715460657252', '1273398746872283348', '1228912852899987488'];
    const hasRole = interaction.member && ALLOWED_ROLES.some(id => interaction.member.roles.cache.has(id));
    if (!hasRole) { await interaction.reply({ content: 'You need the R4 role or above to use this command.', ephemeral: true }); return; }
    await interaction.deferReply();
    const msg = 'City Capture is starting now \uD83E\uDD18\uD83C\uDFFB';
    try {
      const [de, sk, fr, es] = await translateTargets(msg, 'en', ['de', 'sk', 'fr', 'es']);
      if (ANN_EN) { const ch = await client.channels.fetch(ANN_EN); await ch.send(msg); }
      if (ANN_DE) { const ch = await client.channels.fetch(ANN_DE); await ch.send(de); }
      if (ANN_SK) { const ch = await client.channels.fetch(ANN_SK); await ch.send(sk); }
      if (ANN_FR) { const ch = await client.channels.fetch(ANN_FR); await ch.send(fr); }
      if (ANN_ES) { const ch = await client.channels.fetch(ANN_ES); await ch.send(es); }
      await interaction.editReply('City Capture announcement sent to all channels!');
    } catch (err) {
      await interaction.editReply('Failed to send announcement: ' + err.message);
    }
  } else if (interaction.commandName === 'zombie-raid') {
    const ALLOWED_ROLES = ['1313804715460657252', '1273398746872283348', '1228912852899987488'];
    const hasRole = interaction.member && ALLOWED_ROLES.some(id => interaction.member.roles.cache.has(id));
    if (!hasRole) { await interaction.reply({ content: 'You need the R4 role or above to use this command.', ephemeral: true }); return; }
    await interaction.deferReply();
    const msg = 'Zombie raid has started \uD83E\uDDDF';
    try {
      const [de, sk, fr, es] = await translateTargets(msg, 'en', ['de', 'sk', 'fr', 'es']);
      if (ANN_EN) { const ch = await client.channels.fetch(ANN_EN); await ch.send(msg); }
      if (ANN_DE) { const ch = await client.channels.fetch(ANN_DE); await ch.send(de); }
      if (ANN_SK) { const ch = await client.channels.fetch(ANN_SK); await ch.send(sk); }
      if (ANN_FR) { const ch = await client.channels.fetch(ANN_FR); await ch.send(fr); }
      if (ANN_ES) { const ch = await client.channels.fetch(ANN_ES); await ch.send(es); }
      await interaction.editReply('Zombie Raid announcement sent to all channels!');
    } catch (err) {
      await interaction.editReply('Failed to send announcement: ' + err.message);
    }
  } else if (interaction.commandName === 'translate') {
    await interaction.deferReply();
    const text = interaction.options.getString('text', true);
    try {
      const [de, sk] = await translateTargets(text, 'en', ['de', 'sk']);
      await interaction.editReply('**Original:** ' + text + '\n\uD83C\uDDE9\uD83C\uDDEA **German:** ' + de + '\n\uD83C\uDDF8\uD83C\uDDF0 **Slovak:** ' + sk);
    } catch (err) {
      await interaction.editReply('Translation failed. Please try again.');
    }
  }
});

client.login(TOKEN);