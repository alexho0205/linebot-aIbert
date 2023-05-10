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
const Airetable = require("airtable");
require("dotenv").config();
const nodemailer = require("nodemailer");
const e = require("express");
const pdfdocument = require("pdfkit");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_TK = process.env.LINE_CHANNEL_TK;
const LINE_SECRET = process.env.LINE_SECRET;
const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
const openai_role_system =
  "你扮演一個業務助理,請將記錄分類為 '#記事' 與 '#待辦' ,先給#記事再給#待辦,不記錄日期,每項開頭不要使用數字,如果沒有待辦就回答'沒有資料',如果安排會議請加入'解決什麼問題'例如安排會議討論客訴問題,人名需要保留.\r\n";
const openai_sys_msg = {
  role: "system",
  content: openai_role_system,
};

const openai_sys_convert_to_log = {
  role: "system",
  content: "將我給你的文字使用新聞稿方式重新排版",
};

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

    // create user folder , 每位用戶有一個專屬資料夾
    createFolderIfNotExist(userPath);
    // create datetime , 每一天有一個專屬資料夾
    createFolderIfNotExist(dataPath);

    // 將音檔下載到本地端
    getContent = downloadContent(message.id, audioFilePath).then(
      (audioFilePath) => {
        // 音檔轉文字, 並回覆用戶
        convertToText(source.userId, audioFilePath);
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
async function convertToText(userId, audioFilePath) {
  // audio to transcript
  const openaiResponse = await transcribe(audioFilePath);
  const transcriptText = openaiResponse.data.text;

  // transcriptText to TODO or NOTE
  const todoOrNote = await translate(transcriptText);

  // save to airtable
  await saveData(userId, todoOrNote);

  replyTextByUserId(userId, todoOrNote + "\r\n\r\n☁️已存入您的雲端空間.");
}

// save data to airtable
async function saveData(userId, todoOrNote) {
  let [memo, todo] = todoOrNote.split(/\n(?=#)/).map((str) => str.trim());
  if (memo != undefined) {
    memo = memo
      .replace("#記事", "")
      .replace(/^\s*$\n/gm, "")
      .trim();
  }
  if (todo != undefined) {
    todo = todo
      .replace("#待辦", "")
      .replace(/^\s*$\n/gm, "")
      .trim();
  }

  return new Promise((resolve, reject) => {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const options = {
      host: process.env.AIRTABLE_API_URL,
      path: `/v0/${baseId}/${userId}`,
      port: 443,
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TK}`,
        "Content-Type": "application/json",
      },
    };

    const DATA = JSON.stringify({
      records: [
        {
          fields: {
            用戶名稱: userId,
            用戶編號: userId,
            記錄時間: moment().format("YYYYMMDD"),
            待辦: todo,
            記事: memo,
          },
        },
      ],
    });

    const request = https.request(options, (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        try {
          const result = JSON.parse(data);
          console.log(result);
          if (result.error) {
            console.log(
              `airtable : insert data Error  \r\n type:${result.error.type}  \r\n msg:${result.error.message}`
            );
          } else {
            console.log(`airtable : insert data success`);
          }
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", (error) => {
      console.log(`airtable: insert data Error , msg: ${result}`);
      reject(error);
    });
    request.write(DATA);
    request.end();
  });
}

// translate with chatgpt
async function translate(transcriptText) {
  const openai = new OpenAIApi(configuration);
  const rs = await openai.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: [
      openai_sys_msg,
      {
        role: "user",
        content: "記錄:\r\n" + transcriptText,
      },
    ],
    temperature: 0.7,
  });
  console.log("gpt responsed!");
  mylogger.info("gpt responsed!");

  return rs.data.choices[0].message.content;
}

// convert text to log , 文字內容轉為日誌化.
async function translateToLog(transcriptText) {
  console.log(transcriptText);
  const openai = new OpenAIApi(configuration);
  const rs = await openai.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: [
      openai_sys_convert_to_log,
      {
        role: "user",
        content: "文字:\r\n" + transcriptText,
      },
    ],
    temperature: 0.7,
  });
  console.log("gpt responsed! -- to log");
  mylogger.info("gpt responsed! -- to log");

  return rs.data.choices[0].message.content;
}

// openai audio to text
async function transcribe(audioFilePath) {
  const buffer = fs.createReadStream(audioFilePath);
  if (buffer == null) {
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
        console.log("file downloaded!");
        mylogger.log("file downloaded!");
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

async function handleText(message, replyToken, source) {
  // save user email
  if (source.userId && message.text.startsWith("#set_mail=")) {
    let saveReusltMsg = "";
    const email = message.text.split("=")[1];
    if (isEmail.test(email)) {
      await saveAirtableUserMail(source.userId, email);
      saveReusltMsg = `好的,已將您的email設定為 ${email}\r\n請問您需要什麼服務呢?`;
    } else {
      saveReusltMsg = "好的,您還需要什麼服務呢?";
    }
    return replyText(replyToken, saveReusltMsg);
  }

  // 如果是 email 格式. 提示用戶是否更新email位置.
  if (isEmail.test(message.text)) {
    return client.replyMessage(replyToken, {
      type: "template",
      altText: "Confirm alt text",
      template: {
        type: "confirm",
        text: `將您的email位置改為 ${message.text} ?`,
        actions: [
          { label: "Yes", type: "message", text: `#set_mail=${message.text}` },
          { label: "No", type: "message", text: `#set_mail=PASS` },
        ],
      },
    });
  }

  // 整理成日誌並寄發email.
  if (source.userId && message.text.startsWith("#tofile")) {
    // get user email.
    let userEmail = "";
    const result = await getAirtableUserMail(source.userId);
    if (result.records.length > 0) {
      userEmail = result.records[0].fields.email;
    }

    if (userEmail === "") {
      return replyText(
        replyToken,
        "哇!,我還沒有您的Email位置\r\n請輸入您的email"
      );
    }

    const date = message.text.slice(7);
    const rows = await getAirtableData(source.userId, date);
    let msg = "";
    rows.records.forEach((r) => {
      if (
        r.fields["記事"] != undefined &&
        !r.fields["記事"].includes("沒有資料")
      ) {
        msg += "- " + r.fields["記事"] + "\r\n";
      }
    });

    // conver format by openai
    translateToLog(msg).then((logContent) =>
      sendMail( date, userEmail, source.userId, `日誌 ${date}`, logContent)
    );

    return replyText(replyToken, "好的!處理中~ 完成後您將收到mail.");
  }

  // 整理記事
  if (source.userId && message.text.startsWith("#memo")) {
    const date = message.text.slice(5);
    const rows = await getAirtableData(source.userId, date);
    let msg = "";
    rows.records.forEach((r) => {
      if (
        r.fields["記事"] != undefined &&
        !r.fields["記事"].includes("沒有資料")
      ) {
        msg += "- " + r.fields["記事"] + "\r\n";
      }
    });
    return replyText(replyToken, msg);
  }

  // 整理記事
  if (source.userId && message.text.startsWith("#todo")) {
    const date = message.text.slice(5);
    const rows = await getAirtableData(source.userId, date);
    let msg = "";
    rows.records.forEach((r) => {
      if (
        r.fields["待辦"] != undefined &&
        !r.fields["待辦"].includes("沒有資料")
      ) {
        msg += "- " + r.fields["待辦"] + "\r\n";
      }
    });
    return replyText(replyToken, msg);
  }

  if (source.userId) {
    const botName = process.env.BOT_NAME;
    const hello = `Hi 讓您久等了！ 我是 ${botName} ，樂於為您效勞！請輸入語音🎤\r\n\r\n`;
    const tips = `⭐如果需要查看歷史記錄, 可輸入關鍵字 \r\n #memo20230502 \r\n #todo20230502\r\n⭐如果需要轉化為日報型式請輸入\r\n#tofile20230503 `;

    // check user table-space is exist ( on airtable )
    const airbase = await getAirtablesByBaseId();
    let airtableId = "";
    airbase.tables.forEach((table) => {
      if (table.name === source.userId) {
        airtableId = table.id;
      }
    });
    // if table-space not exist , create it !
    if (airtableId === "") {
      // create table-space on airtable
      console.log(
        ` try create table-space on airtable ... tableId=${source.userId}`
      );
      createAirtablesSpace(source.userId);
    } else {
      console.log(`table-space already exist , tableId=${airtableId}`);
    }

    const yestoday = moment().add(-1,'d').format("YYYYMMDD");
    const today = moment().format("YYYYMMDD");

    return client.replyMessage(replyToken, {
      type: "text",
      text: hello + tips,
      quickReply: {
        items: [
          {
            type: "action", 
            action: {
              type: "message",
              label: "昨日總結",
              text: `#memo${yestoday}`,
            },
          },
          {
            type: "action",
            action: {
              type: "message",
              label: "今日總結",
              text: `#memo${today}`,
            },
          },
          {
            type: "action",
            action: {
              type: "message",
              label: "寄給我昨天總結",
              text: `#tofile${yestoday}`,
            },
          },
        ],
      },
    });
  }
}

// 取得用戶 email 記錄
async function getAirtableUserMail(userId) {
  const searchQuery = encodeURIComponent(`{userid}='${userId}'`);

  return new Promise((resolve, reject) => {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const options = {
      host: process.env.AIRTABLE_API_URL,
      path: `/v0/${baseId}/UserInfos?filterByFormula=${searchQuery}`,
      port: 443,
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TK}`,
        "Content-Type": "application/json",
      },
    };
    const request = https.request(options, (response) => {
      let data = "";
      let email = "";
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        try {
          const result = JSON.parse(data);
          // if (result.records.length > 0) {
          //   email = result.records[0].email;
          // }

          if (result.error) {
            console.log(
              `airtable : query email Error  \r\n type:${result.error.type}  \r\n msg:${result.error.message}`
            );
          } else {
            console.log(`airtable : query email success`);
          }
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", () => {
        console.log(`airtable : response error`);
      });
    });

    request.on("error", (error) => {
      console.log(`airtable: query email Error , msg: ${error.message}`);
      reject(error);
    });
    request.end();
  });
}

// 取得用戶 email 記錄
async function saveAirtableUserMail(userId, newEmail) {
  const result = await getAirtableUserMail(userId);
  let mail = "";
  if (result.records.length > 0) {
    mail = result.records[0].fields.email;
  }
  if (mail === "") {
    // insert
    console.log("insert mail...");
    return new Promise((resolve, reject) => {
      const baseId = process.env.AIRTABLE_BASE_ID;
      const options = {
        host: process.env.AIRTABLE_API_URL,
        path: `/v0/${baseId}/UserInfos`,
        port: 443,
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_API_TK}`,
          "Content-Type": "application/json",
        },
      };

      const DATA = JSON.stringify({
        records: [
          {
            fields: {
              userid: userId,
              email: newEmail,
            },
          },
        ],
      });

      const request = https.request(options, (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            const result = JSON.parse(data);
            console.log(result);
            if (result.error) {
              console.log(
                `airtable : insert data Error  \r\n type:${result.error.type}  \r\n msg:${result.error.message}`
              );
            } else {
              console.log(`airtable : insert data success`);
            }
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      });

      request.on("error", (error) => {
        console.log(`airtable: insert data Error , msg: ${result}`);
        reject(error);
      });
      request.write(DATA);
      request.end();
    });
  } else {
    // update
    console.log("update mail...");
    return new Promise((resolve, reject) => {
      const baseId = process.env.AIRTABLE_BASE_ID;
      const options = {
        host: process.env.AIRTABLE_API_URL,
        path: `/v0/${baseId}/UserInfos/${result.records[0].id}`,
        port: 443,
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_API_TK}`,
          "Content-Type": "application/json",
        },
      };

      const DATA = JSON.stringify({
        fields: {
          userid: userId,
          email: newEmail,
        },
      });

      const request = https.request(options, (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            const result = JSON.parse(data);
            console.log(result);
            if (result.error) {
              console.log(
                `airtable : insert data Error  \r\n type:${result.error.type}  \r\n msg:${result.error.message}`
              );
            } else {
              console.log(`airtable : insert data success`);
            }
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      });

      request.on("error", (error) => {
        console.log(`airtable: insert data Error , msg: ${result}`);
        reject(error);
      });
      request.write(DATA);
      request.end();
    });
  }
}

// 取得用戶記錄
async function getAirtableData(userId, date) {
  const searchQuery = encodeURIComponent(`{記錄時間}='${date}'`);
  return new Promise((resolve, reject) => {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const options = {
      host: process.env.AIRTABLE_API_URL,
      path: `/v0/${baseId}/${userId}?filterByFormula=${searchQuery}`,
      port: 443,
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TK}`,
        "Content-Type": "application/json",
      },
    };
    const request = https.request(options, (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            console.log(
              `airtable : query table Error  \r\n type:${result.error.type}  \r\n msg:${result.error.message}`
            );
          } else {
            if (result.records.length > 0) {
              data = result.records[0].email;
            }
            console.log(`airtable : query table success`);
          }
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", () => {
        console.log(`airtable : response error`);
      });
    });

    request.on("error", (error) => {
      console.log(`airtable: query table Error , msg: ${error.message}`);
      reject(error);
    });
    request.end();
  });
}

// 建立 table-space on airtable.
async function createAirtablesSpace(tableId) {
  return new Promise((resolve, reject) => {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const options = {
      host: process.env.AIRTABLE_API_URL,
      path: `/v0/meta/bases/${baseId}/tables`,
      port: 443,
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TK}`,
        "Content-Type": "application/json",
      },
    };

    const AIRTABLE_SCHEMA = JSON.stringify({
      description: "記事與待辦事項",
      fields: [
        {
          name: "用戶名稱",
          type: "singleLineText",
        },
        {
          name: "用戶編號",
          type: "singleLineText",
        },
        {
          name: "記錄時間",
          type: "singleLineText",
        },
        {
          name: "待辦",
          type: "singleLineText",
        },
        {
          name: "記事",
          type: "singleLineText",
        },
      ],
      name: tableId,
    });

    const request = https.request(options, (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            console.log(
              `airtable : create table Error  \r\n type:${result.error.type}  \r\n msg:${result.error.message}`
            );
          } else {
            console.log(`airtable : create table success`);
          }
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", (error) => {
      console.log(`airtable: create table Error , msg: ${result}`);
      reject(error);
    });
    request.write(AIRTABLE_SCHEMA);
    request.end();
  });
}

// 取得 airtable by base id.
async function getAirtablesByBaseId() {
  return new Promise((resolve, reject) => {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const options = {
      host: process.env.AIRTABLE_API_URL,
      path: `/v0/meta/bases/${baseId}/tables`,
      port: 443,
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TK}`,
      },
    };

    const request = https.request(options, (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", (error) => {
      reject(error);
    });
    request.end();
  });
}

function sendMail( contentDate , userEmail ,userid, subject, content) {
  //  text to pdf
  const pdfFile = `pdf_file/${userid}.pdf`;
  const doc = new pdfdocument();
  doc.pipe(fs.createWriteStream(pdfFile));
  doc.font("font/msyh.ttf", 27).text("我的日誌", 100, 30);
  doc.moveTo(0, 80).lineTo(doc.page.width, 80).stroke();
  doc
    .font("font/msyh.ttf", 20)
    .text(contentDate, 100, 100)
    .font("font/msyh.ttf", 13)
    .moveDown()
    .text(content, {
      width: 412,
      align: "justify",
      indent: 30,
      columns: 1,
      height: 300,
      ellipsis: true,
    });
  doc.end();

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMPT_AUTH_USER,
      pass: process.env.SMPT_AUTH_PWD,
    },
  });

  const mailOptions = {
    from: "cymkolor@cymmetrik.com",
    to: userEmail,
    subject: subject,
    text: "請參考附件",
    attachments: [
      {
        filename: "日誌.pdf",
        path: pdfFile,
        contentType: "application/pdf",
      },
    ],
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error(error);
    } else {
      console.log("Email sent: " + info.response);
      replyTextByUserId(userid, "哈囉😊\r\n日誌已發送到您的信箱.");
    }
  });
}

// listen on port
const port = process.env.PORT || 44360;
app.listen(port, () => {
  mylogger.log(`listening on ${port}`);
  console.log(`server started listening on ${port}`);
});
