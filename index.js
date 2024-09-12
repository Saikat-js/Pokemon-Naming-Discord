const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Load configuration from config.json
const config = JSON.parse(fs.readFileSync('./config.json'));

const { botId, token, datasetFolderPath, backgroundImagePath, smallImagePath, pingsFilePath, commonScale } = config;

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

// Function to create an image with text using sharp and SVG
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
          fill: #0645AD; /* Admiral Blue color */
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
  if (message.author.id === botId && message.embeds.length > 0) {
    const embed = message.embeds[0];
    if (embed.title && embed.title.startsWith('A wild Pokémon')) {
      const channelImageUrl = embed.image?.url;
      if (channelImageUrl) {
        const channelImageBuffer = await processImage(channelImageUrl);
        if (channelImageBuffer) {
          const bestMatch = await findPokemonByImage(channelImageBuffer);

          if (bestMatch.name) {
            const textImageBuffer = await createImageWithText(bestMatch.name);

            // Send the image as an attachment
            const attachment = new AttachmentBuilder(textImageBuffer, { name: 'pokemon-name.png' });
            const sentMessage = await message.reply({ files: [attachment] });

            // Ping users who want to be notified for this Pokémon
            const usersToPing = Object.entries(pings)
              .filter(([userId, userData]) => userData?.pokemonList?.includes(bestMatch.name))
              .map(([userId]) => `<@${userId}>`);

            if (usersToPing.length > 0) {
              const pingMessage = `${usersToPing.join(', ')}, a ${bestMatch.name} has appeared!`;
              await message.reply(pingMessage);
            }
          } else {
            console.error('Failed to identify the Pokémon.');
          }
        } else {
          console.error('Failed to process the image.');
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
