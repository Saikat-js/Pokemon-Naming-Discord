const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Load config from config.json
const config = require('./config.json');

const {
  botId,
  token,
  commonScale,
  datasetFolderPath,
  backgroundImagePath,
  smallImagePath,
  pingsFilePath,
  specialServerIds
} = config;

// Load dataset image files into memory
const dataset = fs.readdirSync(datasetFolderPath)
  .filter(file => file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg'))
  .map(file => ({
    name: path.basename(file, path.extname(file)),
    filePath: path.join(datasetFolderPath, file)
  }));

// In-memory dataset image buffers
const datasetBuffers = {};

// Load or initialize the pings file
let pings = {};
if (fs.existsSync(pingsFilePath)) {
  pings = JSON.parse(fs.readFileSync(pingsFilePath));
} else {
  fs.writeFileSync(pingsFilePath, JSON.stringify({}));
}

// Helper function to split an array into chunks
function splitIntoChunks(array, chunkSize) {
  const result = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize));
  }
  return result;
}

async function loadDatasetImages() {
  console.log('Loading dataset images into memory...');
  for (const data of dataset) {
    datasetBuffers[data.name] = await processImage(data.filePath);
  }
  console.log('Dataset images loaded.');
}

async function processImage(filePathOrUrl) {
  try {
    let imageBuffer;

    if (filePathOrUrl.startsWith('http')) {
      const response = await axios({
        url: filePathOrUrl,
        responseType: 'arraybuffer',
        timeout: 10000 // 10 seconds timeout
      });
      imageBuffer = response.data;
    } else {
      imageBuffer = fs.readFileSync(filePathOrUrl);
    }

    const resizedImage = await sharp(imageBuffer)
      .resize(commonScale.width, commonScale.height)
      .toBuffer();

    return resizedImage;
  } catch (error) {
    console.error(`Error processing image from ${filePathOrUrl}:`, error);
    return null;
  }
}

async function compareImages(buffer1, buffer2) {
  const image1 = await sharp(buffer1).raw().toBuffer();
  const image2 = await sharp(buffer2).raw().toBuffer();

  if (image1.length !== image2.length) return Infinity;

  let diff = 0;
  for (let i = 0; i < image1.length; i++) {
    diff += Math.abs(image1[i] - image2[i]);
  }
  return diff;
}

async function findPokemonByImage(imageBuffer) {
  let bestMatch = { name: null, diff: Infinity };

  for (const [name, datasetBuffer] of Object.entries(datasetBuffers)) {
    if (datasetBuffer) {
      const diff = await compareImages(imageBuffer, datasetBuffer);
      if (diff < bestMatch.diff) {
        bestMatch = { name, diff };
      }
    }
  }

  return bestMatch;
}

async function createImageWithText(text) {
  const textWidth = 400;
  const textHeight = 80;

  const backgroundImage = await sharp(backgroundImagePath)
    .resize(textWidth, textHeight)
    .toBuffer();

  const smallImageBuffer = await sharp(smallImagePath)
    .resize(50, 50)
    .toBuffer();

  const svg = `
    <svg width="${textWidth}" height="${textHeight}" xmlns="http://www.w3.org/2000/svg">
      <style>
        .text {
          font-family: 'Georgia', serif;
          font-weight: bold;
          font-size: 35px;
          fill: #0645AD;
        }
      </style>
      <rect width="100%" height="100%" fill="transparent"/>
      <text x="15%" y="60%" class="text" text-anchor="start" dominant-baseline="middle">${text}</text>
    </svg>
  `;

  return sharp(backgroundImage)
    .composite([
      { input: Buffer.from(svg), top: 0, left: 5 }
    ])
    .png()
    .toBuffer();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

client.on('messageCreate', async message => {
  if (message.content.startsWith('<@1201198231539941437> cl list')) {
    const userId = message.author.id;

    if (pings[userId] && pings[userId].pokemonList && pings[userId].pokemonList.length > 0) {
      const pokemonNames = pings[userId].pokemonList;
      const chunkSize = 50;
      const chunks = splitIntoChunks(pokemonNames, chunkSize);

      const introMessage = `**Your Pokémon List:**\n${chunks[0].map((name, index) => `${index + 1}. ${name}`).join('\n')}`;
      await message.reply(introMessage);

      for (let i = 1; i < chunks.length; i++) {
        const chunkMessage = chunks[i].map((name, index) => `${index + 1 + i * chunkSize}. ${name}`).join('\n');
        await message.reply(chunkMessage);
      }
    } else {
      await message.reply('You have no Pokémon added to your list.');
    }
  }

  if (message.content.startsWith('<@1201198231539941437> cl add')) {
    const args = message.content.split(' ').slice(3);
    const pokemonNames = args.join(' ').split(',').map(name => name.trim()).filter(name => name.length > 0);

    if (pokemonNames.length === 0) {
      return message.reply('Please specify at least one Pokémon name.');
    }

    const userId = message.author.id;

    if (!pings[userId]) {
      pings[userId] = { pokemonList: [], afk: false };
    }

    const addedPokemons = [];
    const alreadyInList = [];

    for (const pokemonName of pokemonNames) {
      if (!pings[userId].pokemonList.includes(pokemonName)) {
        pings[userId].pokemonList.push(pokemonName);
        addedPokemons.push(pokemonName);
      } else {
        alreadyInList.push(pokemonName);
      }
    }

    fs.writeFileSync(pingsFilePath, JSON.stringify(pings, null, 2));

    let response = '';

    if (addedPokemons.length > 0) {
      response += `Added ${addedPokemons.join(', ')} to your ping list.`;
    }

    if (alreadyInList.length > 0) {
      response += `\n${alreadyInList.join(', ')} are already in your ping list.`;
    }

    return message.reply(response);
  }

  if (message.author.id === botId && message.embeds.length > 0) {
    const embed = message.embeds[0];
    if (embed.title && embed.title.startsWith('A wild Pokémon')) {
      const channelImageUrl = embed.image?.url;
      if (channelImageUrl) {
        const channelImageBuffer = await processImage(channelImageUrl);
        if (channelImageBuffer) {
          const bestMatch = await findPokemonByImage(channelImageBuffer);

          if (bestMatch.name) {
            const guildId = message.guild.id;

            if (specialServerIds.includes(guildId)) {
              const sentMessage = await message.reply(bestMatch.name);
              setTimeout(() => {
                sentMessage.delete().catch(console.error);
              }, 4000);
            } else {
              const textImageBuffer = await createImageWithText(bestMatch.name);
              const attachment = new AttachmentBuilder(textImageBuffer, { name: 'pokemon-name.png' });
              const sentMessage = await message.reply({ files: [attachment] });
              setTimeout(() => {
                sentMessage.delete().catch(console.error);
              }, 4000);
            }
          }
        }
      }
    }
  }
});

client.once('ready', async () => {
  await loadDatasetImages();
  console.log('Bot is ready.');
});

client.login(token);
