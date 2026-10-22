import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import cron from 'node-cron';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const LEADERSHIP = process.env.LEADERSHIP_CHANNEL_ID;
const GERMAN = process.env.GERMAN_CHANNEL_ID;
const SLOVAK = process.env.SLOVAK_CHANNEL_ID;
const LEADERSHIP_SK = process.env.LEADERSHIP_SK_CHANNEL_ID;
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

// Dedicated 4-way channel group (EN / DE / ES / SK)
const CROSS_EN = process.env.CROSS_EN_CHANNEL_ID;
const CROSS_DE = process.env.CROSS_DE_CHANNEL_ID;
const CROSS_ES = process.env.CROSS_ES_CHANNEL_ID;
const CROSS_SK = process.env.CROSS_SK_CHANNEL_ID;

if (!TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN');
  process.exit(1);
}

const MYMEMORY_TRANSLATE_URL = 'https://api.mymemory.translated.net/get';
const TRANSLATION_TIMEOUT_MS = 15000;
const TRANSLATION_MAX_ATTEMPTS = 4;
const TRANSLATION_BASE_DELAY_MS = 1000;
const TRANSLATION_MAX_BACKOFF_MS = 30000;
const TRANSLATION_MAX_RETRY_AFTER_MS = 60000;
const TRANSLATION_GAP_MS = 500; // pause between consecutive provider requests
const UNAVAILABLE_NOTE = '_(translation unavailable)_';

class TranslationError extends Error {
  constructor(message, { retryable, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'TranslationError';
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Retry-After is either delta-seconds or an HTTP-date.
function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

// Exponential backoff with full jitter. Retry-After, when present, is a floor.
function retryDelayMs(attempt, retryAfterMs) {
  const exp = Math.min(TRANSLATION_MAX_BACKOFF_MS, TRANSLATION_BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round((retryAfterMs ?? 0) + Math.random() * exp);
}

function detectSourceLanguage(text) {
  const lower = text.toLowerCase();
  if (/[äöüß]/.test(lower) || /\b(der|die|das|und|nicht|ich|ist|für)\b/.test(lower)) return 'de';
  if (/[áäčďéíĺľňóôŕšťúýž]/.test(lower) || /\b(je|nie|som|že|pre|ako|na|sa)\b/.test(lower)) return 'sk';
  if (/[àâçéèêëîïôùûüÿœ]/.test(lower) || /\b(le|la|les|des|une|est|pour|avec)\b/.test(lower)) return 'fr';
  if (/[áéíóúüñ¿¡]/.test(lower) || /\b(el|la|los|las|una|es|para|con)\b/.test(lower)) return 'es';
  return 'en';
}

async function translateOnce(text, lang, sourceLang) {
  const params = new URLSearchParams({
    q: text,
    langpair: sourceLang + '|' + lang,
    mt: '1'
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

  try {
    const res = await fetch(MYMEMORY_TRANSLATE_URL + '?' + params.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'DiscordTranslationBot/1.0'
      }
    });

    if (!res.ok) {
      throw new TranslationError('Translation request failed: ' + res.status + ' ' + res.statusText, {
        retryable: res.status === 429 || res.status >= 500,
        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after'))
      });
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const body = await res.text();
      throw new TranslationError(
        'Translation provider returned non-JSON response: ' +
        res.status + ' ' + body.slice(0, 120).replace(/\s+/g, ' '),
        { retryable: true }
      );
    }

    const data = await res.json();
    if (data?.quotaFinished) {
      throw new TranslationError('Translation provider quota is exhausted', { retryable: false });
    }
    if (Number(data?.responseStatus) === 429) {
      throw new TranslationError('Translation provider rate limited (responseStatus 429)', { retryable: true });
    }
    const translated = typeof data?.responseData?.translatedText === 'string'
      ? data.responseData.translatedText.trim()
      : '';
    if (Number(data?.responseStatus) !== 200 || !translated) {
      throw new TranslationError('Empty or invalid translation response', { retryable: true });
    }
    return translated;
  } catch (err) {
    if (err instanceof TranslationError) throw err;
    const reason = err?.name === 'AbortError' ? 'timed out' : (err?.message || String(err));
    throw new TranslationError('Translation request error: ' + reason, { retryable: true });
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Emoji preservation -------------------------------------------------
// One Unicode emoji (keycaps, flags, skin tones, ZWJ sequences, tag sequences)
// or one Discord custom emoji (<:name:id>, <a:name:id>).
const EMOJI_TOKEN_RE = new RegExp(
  '<a?:\\w{2,32}:\\d{17,20}>' +
  '|\\p{Regional_Indicator}{2}' +
  '|(?:[0-9#*]\\uFE0F?\\u20E3|\\p{Extended_Pictographic})(?:\\uFE0F|\\p{Emoji_Modifier}|[\\u{E0020}-\\u{E007F}])*' +
  '(?:\\u200D(?:\\p{Extended_Pictographic}|[0-9#*]\\uFE0F?\\u20E3)(?:\\uFE0F|\\p{Emoji_Modifier}|[\\u{E0020}-\\u{E007F}])*)*',
  'gu'
);
const EMOJI_PLACEHOLDER = (i) => 'ZXQ' + i;

// Splits a message into: prefix (leading emoji/whitespace, kept verbatim),
// core (text sent to the provider, inline emoji replaced by placeholders),
// suffix (trailing emoji/whitespace, kept verbatim), and inline (the emoji list).
function protectEmoji(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(EMOJI_TOKEN_RE)) {
    if (m.index > last) parts.push({ emoji: false, value: text.slice(last, m.index) });
    parts.push({ emoji: true, value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ emoji: false, value: text.slice(last) });

  const isText = (p) => !p.emoji && p.value.trim() !== '';
  const first = parts.findIndex(isText);
  if (first === -1) return { emojiOnly: true };
  let end = parts.length - 1;
  while (!isText(parts[end])) end--;

  const join = (ps) => ps.map(p => p.value).join('');
  let prefix = join(parts.slice(0, first));
  let suffix = join(parts.slice(end + 1));

  const core = parts.slice(first, end + 1).map(p => ({ ...p }));
  const lead = core[0].value.match(/^\s*/)[0];
  core[0].value = core[0].value.slice(lead.length);
  prefix += lead;
  const tail = core[core.length - 1].value.match(/\s*$/)[0];
  core[core.length - 1].value = core[core.length - 1].value.slice(0, core[core.length - 1].value.length - tail.length);
  suffix = tail + suffix;

  const inline = [];
  let coreText = '';
  for (const p of core) {
    if (p.emoji) {
      coreText += ' ' + EMOJI_PLACEHOLDER(inline.length) + ' ';
      inline.push(p.value);
    } else {
      coreText += p.value;
    }
  }
  if (inline.length) coreText = coreText.replace(/ {2,}/g, ' ');

  return { emojiOnly: false, prefix, suffix, core: coreText, inline };
}

// Puts emoji back where their placeholders are. Placeholders must all be present,
// once each, and in their original order. Otherwise the emoji are kept by prefixing them.
function restoreEmoji(translated, inline) {
  const ids = [...translated.matchAll(/ZXQ(\d+)/g)].map(m => Number(m[1]));
  const intact = ids.length === inline.length && ids.every((id, i) => id === i);
  if (intact) {
    return {
      ok: true,
      text: translated.replace(/ZXQ(\d+)/g, (_, n) => inline[Number(n)])
    };
  }
  const stripped = translated.replace(/ZXQ\d+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return { ok: false, text: inline.join('') + ' ' + stripped };
}

async function translateWithRetry(text, lang, sourceLang) {
  let lastError;
  for (let attempt = 1; attempt <= TRANSLATION_MAX_ATTEMPTS; attempt++) {
    try {
      return await translateOnce(text, lang, sourceLang);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof TranslationError && err.retryable;
      if (!retryable || attempt === TRANSLATION_MAX_ATTEMPTS) break;
      if (err.retryAfterMs > TRANSLATION_MAX_RETRY_AFTER_MS) break;
      const delayMs = retryDelayMs(attempt, err.retryAfterMs);
      console.warn(
        'Translation attempt ' + attempt + ' failed for ' + sourceLang + '→' + lang +
        ' (' + err.message + '); retrying in ' + delayMs + 'ms'
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function translate(text, lang, sourceLang = detectSourceLanguage(text)) {
  if (sourceLang === lang) return text;

  const p = protectEmoji(text);
  if (p.emojiOnly) return text; // only emoji: nothing to translate, provider not called

  const translatedCore = await translateWithRetry(p.core, lang, sourceLang);
  let middle = translatedCore;
  if (p.inline.length) {
    const r = restoreEmoji(translatedCore, p.inline);
    if (!r.ok) {
      console.warn('Emoji placeholders altered for ' + sourceLang + '→' + lang + '; inline emoji moved to the start');
    }
    middle = r.text;
  }
  return p.prefix + middle + p.suffix;
}


// Global FIFO: every translation request in the bot runs one at a time.
let translationQueue = Promise.resolve();
function enqueueTranslation(job) {
  const run = translationQueue.then(job);
  translationQueue = run.catch(() => {});
  return run;
}

// Returns one entry per target language: the translated text, or null if unavailable.
function translateTargets(text, sourceLang, targetLangs) {
  return enqueueTranslation(async () => {
    const hasText = typeof text === 'string' && text.trim() !== '';
    const results = [];
    for (const targetLang of targetLangs) {
      if (!targetLang || !hasText) {
        results.push(null);
        continue;
      }
      try {
        results.push(await translate(text, targetLang, sourceLang));
      } catch (err) {
        console.error(
          'Translation unavailable for ' + sourceLang + '→' + targetLang + ': ' +
          (err instanceof Error ? err.message : err)
        );
        results.push(null);
      }
      await sleep(TRANSLATION_GAP_MS);
    }
    return results;
  });
}

// Header plus translation; a missing translation becomes a short note, never an empty body.
function withBody(header, body) {
  return header + '\n' + (body || UNAVAILABLE_NOTE);
}

async function sendToChannel(channelId, content, label) {
  if (!channelId) return false;
  if (!content || !content.trim()) {
    console.error('Not posting empty ' + label + ' message');
    return false;
  }
  const missing = content.includes(UNAVAILABLE_NOTE);

  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(content);
    console.log('Posted ' + label + (missing ? ' (translation unavailable)' : ''));
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
    .setDescription('Translate text to German and Spanish')
    .addStringOption(o => o.setName('text').setDescription('Text to translate').setRequired(true))
    .toJSON()
];

async function postDailySchedule() {
  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const nextDay = (now.getDay() + 1) % 7;
    const message = DAILY_MESSAGES[nextDay];
    const enMsg = TBV_ROLE + '\n' + message;
    await sendToChannel(DAILY_CHANNEL_ID, enMsg || UNAVAILABLE_NOTE, 'DAILY_CHANNEL_ID');
    const langs = await translateTargets(message, 'en', [
      ANN_DE ? 'de' : null,
      ANN_SK ? 'sk' : null,
      ANN_FR ? 'fr' : null,
      ANN_ES ? 'es' : null
    ]);
    await sendToChannel(ANN_DE, langs[0] || UNAVAILABLE_NOTE, 'ANN_DE');
    await sendToChannel(ANN_SK, langs[1] || UNAVAILABLE_NOTE, 'ANN_SK');
    await sendToChannel(ANN_FR, langs[2] || UNAVAILABLE_NOTE, 'ANN_FR');
    await sendToChannel(ANN_ES, langs[3] || UNAVAILABLE_NOTE, 'ANN_ES');
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
    await sendToChannel(ANN_DE, langs[0] || UNAVAILABLE_NOTE, 'ANN_DE');
    await sendToChannel(ANN_SK, langs[1] || UNAVAILABLE_NOTE, 'ANN_SK');
    await sendToChannel(ANN_FR, langs[2] || UNAVAILABLE_NOTE, 'ANN_FR');
    await sendToChannel(ANN_ES, langs[3] || UNAVAILABLE_NOTE, 'ANN_ES');
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
    await sendToChannel(ANN_DE, langs[0] || UNAVAILABLE_NOTE, 'ANN_DE');
    await sendToChannel(ANN_SK, langs[1] || UNAVAILABLE_NOTE, 'ANN_SK');
    await sendToChannel(ANN_FR, langs[2] || UNAVAILABLE_NOTE, 'ANN_FR');
    await sendToChannel(ANN_ES, langs[3] || UNAVAILABLE_NOTE, 'ANN_ES');
  } catch (err) {
    console.error('Failed to post second zombie raid reminder:', err.message);
  }
}

async function postLevel11Bauxite() {
  try {
    const text = '\u26CF\uFE0F You can now start pre-gathering a level 11 bauxite mine';
    await sendToChannel(DAILY_CHANNEL_ID, text || UNAVAILABLE_NOTE, 'DAILY_CHANNEL_ID');
    const langs = await translateTargets(text, 'en', [
      ANN_DE ? 'de' : null,
      ANN_SK ? 'sk' : null,
      ANN_FR ? 'fr' : null,
      ANN_ES ? 'es' : null
    ]);
    await sendToChannel(ANN_DE, langs[0] || UNAVAILABLE_NOTE, 'ANN_DE');
    await sendToChannel(ANN_SK, langs[1] || UNAVAILABLE_NOTE, 'ANN_SK');
    await sendToChannel(ANN_FR, langs[2] || UNAVAILABLE_NOTE, 'ANN_FR');
    await sendToChannel(ANN_ES, langs[3] || UNAVAILABLE_NOTE, 'ANN_ES');
  } catch (err) {
    console.error('Failed to post level 11 bauxite reminder:', err.message);
  }
}

async function postLevel10Bauxite() {
  try {
    const text = '\u26CF\uFE0F You can now start pre-gathering a level 10 bauxite mine';
    await sendToChannel(DAILY_CHANNEL_ID, text || UNAVAILABLE_NOTE, 'DAILY_CHANNEL_ID');
    const langs = await translateTargets(text, 'en', [
      ANN_DE ? 'de' : null,
      ANN_SK ? 'sk' : null,
      ANN_FR ? 'fr' : null,
      ANN_ES ? 'es' : null
    ]);
    await sendToChannel(ANN_DE, langs[0] || UNAVAILABLE_NOTE, 'ANN_DE');
    await sendToChannel(ANN_SK, langs[1] || UNAVAILABLE_NOTE, 'ANN_SK');
    await sendToChannel(ANN_FR, langs[2] || UNAVAILABLE_NOTE, 'ANN_FR');
    await sendToChannel(ANN_ES, langs[3] || UNAVAILABLE_NOTE, 'ANN_ES');
  } catch (err) {
    console.error('Failed to post level 10 bauxite reminder:', err.message);
  }
}

async function postLevel9Bauxite() {
  try {
    const text = '\u26CF\uFE0F You can now start pre-gathering a level 9 bauxite mine';
    await sendToChannel(DAILY_CHANNEL_ID, text || UNAVAILABLE_NOTE, 'DAILY_CHANNEL_ID');
    const langs = await translateTargets(text, 'en', [
      ANN_DE ? 'de' : null,
      ANN_SK ? 'sk' : null,
      ANN_FR ? 'fr' : null,
      ANN_ES ? 'es' : null
    ]);
    await sendToChannel(ANN_DE, langs[0] || UNAVAILABLE_NOTE, 'ANN_DE');
    await sendToChannel(ANN_SK, langs[1] || UNAVAILABLE_NOTE, 'ANN_SK');
    await sendToChannel(ANN_FR, langs[2] || UNAVAILABLE_NOTE, 'ANN_FR');
    await sendToChannel(ANN_ES, langs[3] || UNAVAILABLE_NOTE, 'ANN_ES');
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

  // Dedicated 4-way group: EN → DE, ES, SK
  if (CROSS_EN && msg.channelId === CROSS_EN) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇬🇧 **' + author + '** (English):';
    try {
      const [de, es, sk] = await translateTargets(msg.content, 'en', [
        CROSS_DE ? 'de' : null,
        CROSS_ES ? 'es' : null,
        CROSS_SK ? 'sk' : null
      ]);
      await sendToChannel(CROSS_DE, withBody(header, de), 'CROSS English→German');
      await sendToChannel(CROSS_ES, withBody(header, es), 'CROSS English→Spanish');
      await sendToChannel(CROSS_SK, withBody(header, sk), 'CROSS English→Slovak');
    } catch (err) { console.error('CROSS English error:', err.message); }
  }

  // Dedicated 4-way group: DE → EN, ES, SK
  if (CROSS_DE && msg.channelId === CROSS_DE) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇩🇪 **' + author + '** (German):';
    try {
      const [en, es, sk] = await translateTargets(msg.content, 'de', [
        CROSS_EN ? 'en' : null,
        CROSS_ES ? 'es' : null,
        CROSS_SK ? 'sk' : null
      ]);
      await sendToChannel(CROSS_EN, withBody(header, en), 'CROSS German→English');
      await sendToChannel(CROSS_ES, withBody(header, es), 'CROSS German→Spanish');
      await sendToChannel(CROSS_SK, withBody(header, sk), 'CROSS German→Slovak');
    } catch (err) { console.error('CROSS German error:', err.message); }
  }

  // Dedicated 4-way group: ES → EN, DE, SK
  if (CROSS_ES && msg.channelId === CROSS_ES) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇪🇸 **' + author + '** (Spanish):';
    try {
      const [en, de, sk] = await translateTargets(msg.content, 'es', [
        CROSS_EN ? 'en' : null,
        CROSS_DE ? 'de' : null,
        CROSS_SK ? 'sk' : null
      ]);
      await sendToChannel(CROSS_EN, withBody(header, en), 'CROSS Spanish→English');
      await sendToChannel(CROSS_DE, withBody(header, de), 'CROSS Spanish→German');
      await sendToChannel(CROSS_SK, withBody(header, sk), 'CROSS Spanish→Slovak');
    } catch (err) { console.error('CROSS Spanish error:', err.message); }
  }

  // Dedicated 4-way group: SK → EN, DE, ES
  if (CROSS_SK && msg.channelId === CROSS_SK) {
    const author = msg.member?.displayName || msg.author.username;
    const header = '🇸🇰 **' + author + '** (Slovak):';
    try {
      const [en, de, es] = await translateTargets(msg.content, 'sk', [
        CROSS_EN ? 'en' : null,
        CROSS_DE ? 'de' : null,
        CROSS_ES ? 'es' : null
      ]);
      await sendToChannel(CROSS_EN, withBody(header, en), 'CROSS Slovak→English');
      await sendToChannel(CROSS_DE, withBody(header, de), 'CROSS Slovak→German');
      await sendToChannel(CROSS_ES, withBody(header, es), 'CROSS Slovak→Spanish');
    } catch (err) { console.error('CROSS Slovak error:', err.message); }
  }

  // Leadership → German, Spanish & Slovak
  if (msg.channelId === LEADERSHIP) {
    console.log('Translating Leadership message from', msg.author.username);
    const author = msg.member?.displayName || msg.author.username;
    const header = '📢 **' + author + '** (Leadership):';

    try {
      const [de, es, sk] = await translateTargets(msg.content, 'en', [
        GERMAN ? 'de' : null,
        SLOVAK ? 'es' : null,
        LEADERSHIP_SK ? 'sk' : null
      ]);

      await sendToChannel(GERMAN, withBody(header, de), 'Leadership→German');
      await sendToChannel(SLOVAK, withBody(header, es), 'Leadership→Spanish');
      await sendToChannel(LEADERSHIP_SK, withBody(header, sk), 'Leadership→Slovak');

    } catch (err) {
      console.error('Translation error:', err.message);
    }
  }

  // German → English to Leadership + Spanish translation
  if (msg.channelId === GERMAN) {
    console.log('Translating German message from', msg.author.username);
    const author = msg.member?.displayName || msg.author.username;
    const headerEn = '🇩🇪 **' + author + '** (German):';
    const headerEs = '🇩🇪 **' + author + '** (German → Spanish):';
    const headerSk = '🇩🇪 **' + author + '** (German → Slovak):';

    try {
      const [en, es, sk] = await translateTargets(msg.content, 'de', [
        'en',
        SLOVAK ? 'es' : null,
        LEADERSHIP_SK ? 'sk' : null
      ]);

      await sendToChannel(LEADERSHIP, withBody(headerEn, en), 'German→Leadership');
      await sendToChannel(SLOVAK, withBody(headerEs, es), 'German→Spanish');
      await sendToChannel(LEADERSHIP_SK, withBody(headerSk, sk), 'German→Slovak');

    } catch (err) {
      console.error('Translation error:', err.message);
    }
  }

  // Spanish → English to Leadership + German translation
  if (msg.channelId === SLOVAK) {
    console.log('Translating Spanish message from', msg.author.username);
    const author = msg.member?.displayName || msg.author.username;
    const headerEn = '🇪🇸 **' + author + '** (Spanish):';
    const headerDe = '🇪🇸 **' + author + '** (Spanish → German):';
    const headerSk = '🇪🇸 **' + author + '** (Spanish → Slovak):';

    try {
      const [en, de, sk] = await translateTargets(msg.content, 'es', [
        'en',
        GERMAN ? 'de' : null,
        LEADERSHIP_SK ? 'sk' : null
      ]);

      await sendToChannel(LEADERSHIP, withBody(headerEn, en), 'Spanish→Leadership');
      await sendToChannel(GERMAN, withBody(headerDe, de), 'Spanish→German');
      await sendToChannel(LEADERSHIP_SK, withBody(headerSk, sk), 'Spanish→Slovak');

    } catch (err) {
      console.error('Translation error:', err.message);
    }
  }

  // Leadership Slovak leg → English, German & Spanish
  if (LEADERSHIP_SK && msg.channelId === LEADERSHIP_SK) {
    console.log('Translating Leadership Slovak message from', msg.author.username);
    const author = msg.member?.displayName || msg.author.username;
    const headerEn = '🇸🇰 **' + author + '** (Slovak):';
    const headerDe = '🇸🇰 **' + author + '** (Slovak → German):';
    const headerEs = '🇸🇰 **' + author + '** (Slovak → Spanish):';

    try {
      const [en, de, es] = await translateTargets(msg.content, 'sk', [
        'en',
        GERMAN ? 'de' : null,
        SLOVAK ? 'es' : null
      ]);

      await sendToChannel(LEADERSHIP, withBody(headerEn, en), 'LeadershipSK→Leadership');
      await sendToChannel(GERMAN, withBody(headerDe, de), 'LeadershipSK→German');
      await sendToChannel(SLOVAK, withBody(headerEs, es), 'LeadershipSK→Spanish');

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
      await sendToChannel(ANN_DE, withBody(header, results[0]), 'ANN_EN→German');
      await sendToChannel(ANN_SK, withBody(header, results[1]), 'ANN_EN→Slovak');
      await sendToChannel(ANN_FR, withBody(header, results[2]), 'ANN_EN→French');
      await sendToChannel(ANN_ES, withBody(header, results[3]), 'ANN_EN→Spanish');
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
      await sendToChannel(ANN_EN, withBody(header, results[0]), 'ANN_DE→English');
      await sendToChannel(ANN_SK, withBody(header, results[1]), 'ANN_DE→Slovak');
      await sendToChannel(ANN_FR, withBody(header, results[2]), 'ANN_DE→French');
      await sendToChannel(ANN_ES, withBody(header, results[3]), 'ANN_DE→Spanish');
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
      await sendToChannel(ANN_EN, withBody(header, results[0]), 'ANN_SK→English');
      await sendToChannel(ANN_DE, withBody(header, results[1]), 'ANN_SK→German');
      await sendToChannel(ANN_FR, withBody(header, results[2]), 'ANN_SK→French');
      await sendToChannel(ANN_ES, withBody(header, results[3]), 'ANN_SK→Spanish');
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
      await sendToChannel(ANN_EN, withBody(header, results[0]), 'ANN_FR→English');
      await sendToChannel(ANN_DE, withBody(header, results[1]), 'ANN_FR→German');
      await sendToChannel(ANN_SK, withBody(header, results[2]), 'ANN_FR→Slovak');
      await sendToChannel(ANN_ES, withBody(header, results[3]), 'ANN_FR→Spanish');
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
      await sendToChannel(GEN_DE, withBody(header, results[0]), 'GEN_EN→German');
      await sendToChannel(GEN_SK, withBody(header, results[1]), 'GEN_EN→Slovak');
      await sendToChannel(GEN_FR, withBody(header, results[2]), 'GEN_EN→French');
      await sendToChannel(GEN_ES, withBody(header, results[3]), 'GEN_EN→Spanish');
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
      await sendToChannel(GEN_EN, withBody(header, results[0]), 'GEN_DE→English');
      await sendToChannel(GEN_SK, withBody(header, results[1]), 'GEN_DE→Slovak');
      await sendToChannel(GEN_FR, withBody(header, results[2]), 'GEN_DE→French');
      await sendToChannel(GEN_ES, withBody(header, results[3]), 'GEN_DE→Spanish');
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
      await sendToChannel(GEN_EN, withBody(header, results[0]), 'GEN_SK→English');
      await sendToChannel(GEN_DE, withBody(header, results[1]), 'GEN_SK→German');
      await sendToChannel(GEN_FR, withBody(header, results[2]), 'GEN_SK→French');
      await sendToChannel(GEN_ES, withBody(header, results[3]), 'GEN_SK→Spanish');
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
      await sendToChannel(GEN_EN, withBody(header, results[0]), 'GEN_FR→English');
      await sendToChannel(GEN_DE, withBody(header, results[1]), 'GEN_FR→German');
      await sendToChannel(GEN_SK, withBody(header, results[2]), 'GEN_FR→Slovak');
      await sendToChannel(GEN_ES, withBody(header, results[3]), 'GEN_FR→Spanish');
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
      await sendToChannel(ANN_EN, withBody(header, results[0]), 'ANN_ES→English');
      await sendToChannel(ANN_DE, withBody(header, results[1]), 'ANN_ES→German');
      await sendToChannel(ANN_SK, withBody(header, results[2]), 'ANN_ES→Slovak');
      await sendToChannel(ANN_FR, withBody(header, results[3]), 'ANN_ES→French');
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
      await sendToChannel(GEN_EN, withBody(header, results[0]), 'GEN_ES→English');
      await sendToChannel(GEN_DE, withBody(header, results[1]), 'GEN_ES→German');
      await sendToChannel(GEN_SK, withBody(header, results[2]), 'GEN_ES→Slovak');
      await sendToChannel(GEN_FR, withBody(header, results[3]), 'GEN_ES→French');
    } catch (err) { console.error('GEN_ES error:', err.message); }
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply('Pong! Bot is online and running.');
  } else if (interaction.commandName === 'help') {
    await interaction.reply('Commands:\n/ping - Check status\n/today - Show todays game schedule\n/translate <text> - Translate to German and Spanish\n/help - Show this message');
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
      await sendToChannel(ANN_EN, msg || UNAVAILABLE_NOTE, 'ANN_EN');
      await sendToChannel(ANN_DE, de || UNAVAILABLE_NOTE, 'ANN_DE');
      await sendToChannel(ANN_SK, sk || UNAVAILABLE_NOTE, 'ANN_SK');
      await sendToChannel(ANN_FR, fr || UNAVAILABLE_NOTE, 'ANN_FR');
      await sendToChannel(ANN_ES, es || UNAVAILABLE_NOTE, 'ANN_ES');
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
      await sendToChannel(ANN_EN, msg || UNAVAILABLE_NOTE, 'ANN_EN');
      await sendToChannel(ANN_DE, de || UNAVAILABLE_NOTE, 'ANN_DE');
      await sendToChannel(ANN_SK, sk || UNAVAILABLE_NOTE, 'ANN_SK');
      await sendToChannel(ANN_FR, fr || UNAVAILABLE_NOTE, 'ANN_FR');
      await sendToChannel(ANN_ES, es || UNAVAILABLE_NOTE, 'ANN_ES');
      await interaction.editReply('Zombie Raid announcement sent to all channels!');
    } catch (err) {
      await interaction.editReply('Failed to send announcement: ' + err.message);
    }
  } else if (interaction.commandName === 'translate') {
    await interaction.deferReply();
    const text = interaction.options.getString('text', true);
    try {
      const [de, es] = await translateTargets(text, 'en', ['de', 'es']);
      await interaction.editReply('**Original:** ' + text + '\n\uD83C\uDDE9\uD83C\uDDEA **German:** ' + (de || UNAVAILABLE_NOTE) + '\n\uD83C\uDDEA\uD83C\uDDF8 **Spanish:** ' + (es || UNAVAILABLE_NOTE));
    } catch (err) {
      await interaction.editReply('Translation failed. Please try again.');
    }
  }
});

client.login(TOKEN);