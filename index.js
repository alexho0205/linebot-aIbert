"use strict";

const line = require("@line/bot-sdk");
const express = require("express");
const path = require("path");
const fs = require("fs");
const { Configuration, OpenAIApi } = require("openai");
const https = require("https");
const querystring = require("querystring");
const { CLIENT_RENEG_WINDOW } = require("tls");
const { Console } = require("console");
const moment = require("moment");
require('dotenv').config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_TK = process.env.LINE_CHANNEL_TK;
const LINE_SECRET =  process.env.LINE_SECRET;

// logger
const mylogger = new Console({
  stdout: fs.createWriteStream("stdout.txt"),
  stderr: fs.createWriteStream("stderr.txt"),
});

// open ai
const configuration = new Configuration({
  apiKey: OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);
const systemContent = "你是一個... \r\n";

// create LINE SDK config from env variables
const config = {
  channelAccessToken: LINE_CHANNEL_TK,
  channelSecret: LINE_SECRET,
};

// base URL for webhook server
let baseURL = process.env.BASE_URL;

// create LINE SDK client
const client = new line.Client(config);

// create Express app
const app = express();

// register a webhook handler with middleware
// about the middleware, please refer to doc
app.post("/callback", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      mylogger.error(err);
      res.status(500).end();
    });
});

// event handler
function handleEvent(event) {
  switch (event.type) {
    case "message":
      const message = event.message;
      switch (message.type) {
        case "text":
          return handleText(message, event.replyToken, event.source);
        case "image":
        //  return handleImage(message, event.replyToken, event.source);
        case "video":
        // return handleVideo(message, event.replyToken);
        case "audio":
          return handleAudio2(message, event.replyToken, event.source);
        case "location":
        // return handleLocation(message, event.replyToken);
        case "sticker":
        // return handleSticker(message, event.replyToken);
        default:
          throw new Error(`Unknown message: ${JSON.stringify(message)}`);
      }
    case "join":
      return replyText(event.replyToken, `Joined ${event.source.type}`);
  }

  // ignore other event
  return Promise.resolve(null);
}

// 處理語音
// STEP 1 save to local folder
// STEP 2 audio to transcript ( openai api )
// STEP 3 ... ( openai )
function handleAudio2(message, replyToken, source) {
  let getContent;
  if (message.contentProvider.type === "line") {
    // 用戶資料夾位置 {user.id}
    const userPath = path.join(__dirname, `audio_${source.userId}`);
    // 每日資料夾位置 {user.id}/{date}
    const dataPath = path.join(
      __dirname,
      `audio_${source.userId}`,
      moment().format("YYYYMMDD")
    );
    const audioFilePath = path.join(dataPath, `${message.id}.m4a`);

    // const downloadPath = path.join(
    //   __dirname,
    //   "downloaded",
    //   `${message.id}.m4a`
    // );

    // create user folder , 每位用戶有一個專屬資料夾
    createFolderIfNotExist(userPath);
    // create datetime , 每一天有一個專屬資料夾
    createFolderIfNotExist(dataPath);

    // 將音檔下載到本地端
    getContent = downloadContent(message.id, audioFilePath).then(
      (audioFilePath) => {
        // 音檔轉文字, 並回覆用戶
        convertToText(source.userId,audioFilePath);
      }
    );
  } else {
    getContent = Promise.resolve(message.contentProvider);
  }

  return getContent.then(() => {
    return replyText(replyToken, "好的！已收到語言訊息，解析中...");
  });
}

// audio to transcript
async function convertToText(userId,audioFilePath) {
  const openaiResponse = await transcribe(audioFilePath);
  const text = openaiResponse.data.text;
  replyTextByUserId(userId,text);
}

async function transcribe(audioFilePath) {
  const buffer = fs.createReadStream(audioFilePath);
  if(buffer == null){
    const msg_stream_is_null = "file stream is null.";
    mylogger.info(msg_stream_is_null);
    return msg_stream_is_null;
  }

  mylogger.info("audioFilePath = " + audioFilePath);

  const openai = new OpenAIApi(configuration);
  return await openai.createTranscription(buffer, "whisper-1");
}

function createFolderIfNotExist(folderPath) {
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath);
  }
}

function downloadContent(messageId, downloadPath) {
  return client.getMessageContent(messageId).then(
    (stream) =>
      new Promise((resolve, reject) => {
        const writable = fs.createWriteStream(downloadPath);
        stream.pipe(writable);
        stream.on("end", () => resolve(downloadPath));
        stream.on("error", reject);
        console.log('file downloaded!');
        mylogger.log('file downloaded!');
      })
  );
}

const replyText = (token, texts) => {
  texts = Array.isArray(texts) ? texts : [texts];
  return client.replyMessage(
    token,
    texts.map((text) => ({ type: "text", text }))
  );
};

const replyTextByUserId = (userid, retrunMessage) => {
  const message = {
    type: "text",
    text: retrunMessage,
  };
  client
    .pushMessage(userid, message)
    .then(() => {})
    .catch((err) => {});
};

function handleText(message, replyToken, source) {
  if (source.userId) {
    const hello = "Hi 讓您久等了！我是您的助理 Albert，樂於為您效勞！ \r\n ";
    return replyText(replyToken, hello);
  }
}

// listen on port
const port = process.env.PORT || 44360;
app.listen(port, () => {
  mylogger.log(`listening on ${port}`);
  console.log(`server started listening on ${port}`);
});
