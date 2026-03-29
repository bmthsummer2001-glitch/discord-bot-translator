import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const LEADERSHIP = process.env.LEADERSHIP_CHANNEL_ID;
const GERMAN = process.env.GERMAN_CHANNEL_ID;
const SLOVAK = process.env.SLOVAK_CHANNEL_ID;

if (!TOKEN) { console.error('Missing DISCORD_BOT_TOKEN'); process.exit(1); }

async function translate(text, lang) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + lang + '&dt=t&q=' + encodeURIComponent(text);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await res.json();
  return data[0].map(c => c[0]).filter(Boolean).join('');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check bot status').toJSON(),
  new SlashCommandBuilder().setName('help').setDescription('Show commands').toJSON(),
  new SlashCommandBuilder().setName('translate').setDescription('Translate text').addStringOption(o => o.setName('text').setDescription('Text to translate').setRequired(true)).toJSON()
];

client.once('ready', async (c) => {
  console.log('Bot online:', c.user.tag);
  const rest = new REST().setToken(TOKEN);
  await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
  console.log('Commands registered');
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || msg.channelId !== LEADERSHIP) return;
  console.log('Translating message from', msg.author.username);
  const author = msg.member?.displayName || msg.author.username;
  const header = '📢 **' + author + '** (Leadership):';
  try {
    const [de, sk] = await Promise.all([
      GERMAN ? translate(msg.content, 'de') : Promise.resolve(''),
      SLOVAK ? translate(msg.content, 'sk') : Promise.resolve('')
    ]);
    if (GERMAN) { const ch = await client.channels.fetch(GERMAN); await ch.send(header + '
' + de); }
    if (SLOVAK) { const ch = await client.channels.fetch(SLOVAK); await ch.send(header + '
' + sk); }
    console.log('Translations posted');
  } catch(err) { console.error('Translation error:', err.message); }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'ping') await interaction.reply('Pong! Bot is online.');
  else if (interaction.commandName === 'help') await interaction.reply('Commands: /ping, /translate <text>, /help');
  else if (interaction.commandName === 'translate') {
    await interaction.deferReply();
    const text = interaction.options.getString('text', true);
    const [de, sk] = await Promise.all([translate(text, 'de'), translate(text, 'sk')]);
    await interaction.editReply('**Original:** ' + text + '
🇩🇪 **German:** ' + de + '
🇸🇰 **Slovak:** ' + sk);
  }
});

client.login(TOKEN);
